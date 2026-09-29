import { logger, TypedEmitter } from '@assistant/core';
import { assertDatabaseReady, createDb } from '@assistant/db';
import type { ServerEvent } from '@assistant/schemas';
import { buildToolRegistry } from '@assistant/tools';
import { warmPhraseCache } from '@assistant/voice';
import { createDbMemoryStore } from './memory-store.js';
import { createDbTaskStore } from './task-store.js';
import { SettingsStore } from './settings-store.js';
import { ProactiveWatcher } from './proactive.js';
import { createOllamaEmbedder } from './embedding.js';
import { env } from './env.js';
import { modelMissingError, OllamaClient } from './llm/ollama.js';
import { GeminiClient } from './llm/gemini.js';
import { createLlmRouter } from './llm/router.js';
import { Orchestrator } from './orchestrator.js';
import { createServer } from './server.js';
import { buildVoiceStack } from './voice.js';
import { warmablePhrases } from './warm-phrases.js';

async function main(): Promise<void> {
  const config = env();

  const db = createDb({ connectionString: config.DATABASE_URL });
  await assertDatabaseReady(db);
  logger.info('database ready');

  const llm = new OllamaClient(config.OLLAMA_BASE_URL, config.OLLAMA_KEEP_ALIVE);

  // Fail at boot rather than on the user's first sentence.
  const models = await llm.listModels();
  if (models.isErr()) {
    logger.error({ error: models.error }, 'cannot reach Ollama — is it running?');
    process.exitCode = 1;
    return;
  }
  if (!models.value.some((name) => name === config.OLLAMA_MODEL)) {
    logger.error(modelMissingError(config.OLLAMA_MODEL, models.value), 'model not available');
    process.exitCode = 1;
    return;
  }

  const memory = createDbMemoryStore({
    db,
    embed: createOllamaEmbedder({
      baseUrl: config.OLLAMA_BASE_URL,
      model: config.EMBEDDING_MODEL,
    }),
  });

  const tasks = createDbTaskStore(db);

  const registry = buildToolRegistry({
    serperApiKey: config.SERPER_API_KEY,
    region: config.SEARCH_REGION,
    language: config.SEARCH_LANGUAGE,
    // Recall is keyword-only until an embedding model is wired up; the store
    // logs that once rather than leaving it a mystery.
    memory,
    tasks,
    slackToken: config.SLACK_TOKEN,
    proactiveNotifications: config.PROACTIVE_NOTIFICATIONS,
  });
  const events = new TypedEmitter<ServerEvent>();

  // Read from the database rather than assumed: everything the user has ever
  // changed lives in one row, and it must survive a restart.
  const settingsStore = await SettingsStore.load(db);
  const settings = settingsStore.current;
  const voice = await buildVoiceStack(config, settings.voice);
  logger.info(
    { voiceInput: voice.sttProvider ?? 'none', voiceOutput: voice.ttsProvider },
    voice.configured ? 'voice ready' : 'voice output only — no speech recognition available',
  );

  /**
   * The cloud fallback, if the user asked for one.
   *
   * Validated at boot rather than on their first sentence: a wrong model id or
   * a dead key should be a log line now, not a failed turn later. The check is
   * best-effort — a network blip must not stop a local-first assistant from
   * starting.
   */
  let cloud: GeminiClient | null = null;
  if (config.CLOUD_FALLBACK && config.GEMINI_API_KEY) {
    const candidate = new GeminiClient({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
    });
    const available = await candidate.listModels();
    if (available.isErr()) {
      logger.warn(
        { error: available.error },
        'could not reach Gemini — staying local for this session',
      );
    } else if (!available.value.includes(config.GEMINI_MODEL)) {
      logger.error(
        { model: config.GEMINI_MODEL, available: available.value.slice(0, 12) },
        'GEMINI_MODEL is not available to this key — staying local. Set it to one of the models listed.',
      );
    } else {
      cloud = candidate;
      logger.warn(
        { model: config.GEMINI_MODEL },
        'cloud fallback is ON — turns the fast path cannot route will leave this Mac',
      );
    }
  } else if (config.CLOUD_FALLBACK) {
    logger.warn('CLOUD_FALLBACK is set but GEMINI_API_KEY is not — staying local');
  }

  const llmRouter = createLlmRouter({
    local: llm,
    cloud,
    // Read per turn, so the setting takes effect without a restart.
    offlineFirst: () => settingsStore.current.offlineFirst,
    isOnline: () => true,
  });

  const orchestrator = new Orchestrator({
    llm: llmRouter,
    db,
    registry,
    events,
    model: config.OLLAMA_MODEL,
    plannerEnabled: config.PLANNER_ENABLED,
    personality: config.ASSISTANT_PERSONALITY,
    // Given to the model directly rather than left behind a `recall` call:
    // making Assistant ask itself what it knows costs a round trip, and it will
    // often simply forget to.
    recallMemories: async (query) => {
      const found = await memory.recall(query, 3);
      return found.map((m) => m.fact);
    },
    tasks,
    settings: () => settingsStore.current,
    voice,
    // Cheap liveness signal; the tool layer surfaces the real failure if wrong.
    isOnline: () => true,
  });

  createServer({
    events,
    orchestrator,
    voice,
    registry,
    memory,
    settings: settingsStore,
    port: config.BRAIN_PORT,
  }).start();

  // The one thing that speaks first. Off unless the user turned it on.
  new ProactiveWatcher({ enabled: config.PROACTIVE_NOTIFICATIONS }).start();

  // Preload the model rather than making the first question wait for it.
  // Deliberately not awaited: the server should accept connections
  // immediately, and a warm-up that blocked startup would just move the delay.
  void llm.warm(config.OLLAMA_MODEL).then((ok) => {
    logger[ok ? 'info' : 'warn'](
      { component: 'llm', model: config.OLLAMA_MODEL },
      ok ? 'model preloaded' : 'model preload failed; first turn will be slow',
    );
  });

  /**
   * The same idea for speech: the fast path's own sentences cost a ~950 ms
   * Sarvam round trip plus a conversion the first time each is spoken, and
   * "Paused." has no business being slow on a fresh cache.
   *
   * Not awaited, for the reason above. `isBusy` is what keeps it honest — the
   * converter is a single local server, so a warm clip in flight while someone
   * is waiting for an answer would be a background job stealing the
   * foreground's slot.
   *
   * Skipped entirely without Sarvam: the keyless `say` path is not cached, so
   * warming it would fork forty processes at boot and store nothing.
   */
  if (config.PHRASE_CACHE_WARM && voice.ttsProvider === 'sarvam') {
    const phrases = warmablePhrases();
    void warmPhraseCache(voice.tts, {
      phrases,
      isBusy: () => orchestrator.busy,
    }).then((result) => {
      logger.info(
        { component: 'voice', ...result, total: phrases.length },
        result.synthesised > 0
          ? 'phrase cache warmed'
          : 'phrase cache already warm, nothing synthesised',
      );
    });
  }
}

main().catch((error: unknown) => {
  logger.error({ error }, 'brain failed to start');
  process.exit(1);
});
