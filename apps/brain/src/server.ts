import { serve } from '@hono/node-server';
import { childLogger, type TypedEmitter } from '@assistant/core';
import { randomUUID } from 'node:crypto';
import { ClientCommand, MemoryEdit, TurnId, type ServerEvent } from '@assistant/schemas';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Orchestrator } from './orchestrator.js';
import type { SettingsStore } from './settings-store.js';
import type { MemoryStore, ToolRegistry } from '@assistant/tools';
import {
  detectHallucination,
  detectWakeWord,
  matchSpokenDecision,
  FOLLOW_UP_WINDOW_MS,
} from '@assistant/voice';
import type { VoiceStack } from './voice.js';
import { SpeculationStore } from './speculation.js';

const log = childLogger('server');

export interface ServerDeps {
  events: TypedEmitter<ServerEvent>;
  orchestrator: Orchestrator;
  voice: VoiceStack;
  /** Backs the settings routes; the same instance the orchestrator reads. */
  settings: SettingsStore;
  /** Backs `/tools`, the audit view of what Assistant can do and on what terms. */
  registry: ToolRegistry;
  /** Long-term memory, for the routes that let the user see and edit it. */
  memory: MemoryStore | null;
  port: number;
}

/** Duration of a 16-bit mono PCM WAV, from its byte length. */
function wavDurationMs(wav: Buffer): number {
  const HEADER_BYTES = 44;
  const BYTES_PER_SAMPLE = 2;
  const SAMPLE_RATE = 16_000;
  const samples = Math.max(0, wav.length - HEADER_BYTES) / BYTES_PER_SAMPLE;
  return (samples / SAMPLE_RATE) * 1000;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();

  /**
   * When Assistant last answered. Within the follow-up window the wake word is
   * not required, so a conversation does not become "Hey Assistant, the weather"
   * / "Hey Assistant, and tomorrow?".
   */
  let awakeUntil = 0;

  /**
   * Transcriptions started before the silence hold expired. See
   * `speculation.ts` for why this is safe and what it costs when the guess is
   * wrong.
   */
  const speculations = new SpeculationStore();

  // The UI is served from a Tauri webview on a different origin.
  app.use(
    '*',
    cors({
      origin: (origin) =>
        /^(tauri:\/\/|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$)/.test(origin) ? origin : null,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
    }),
  );

  app.get('/health', (c) => c.json({ ok: true, speech: deps.voice.configured }));

  /**
   * Accepts a recorded utterance, transcribes it, and starts a turn.
   *
   * The transcript is broadcast before the turn begins so the UI can show what
   * was heard immediately, rather than after the model has finished thinking.
   */
  app.post('/voice/utterance', async (c) => {
    const stt = deps.voice.stt;
    if (!stt) {
      return c.json({ error: 'speech_not_configured', message: 'SARVAM_API_KEY is not set' }, 503);
    }

    const form = await c.req.formData().catch(() => null);
    const file = form?.get('audio');
    if (!(file instanceof File)) {
      return c.json({ error: 'missing_audio', message: 'Expected an "audio" file field' }, 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const turnId = TurnId.parse(randomUUID());

    /**
     * Returns the UI to rest, but only when nothing else is running.
     *
     * The microphone is always on, so this endpoint fires constantly on
     * whatever the room happens to produce. Emitting a global `idle` for a
     * discarded noise burst would wipe the "thinking" state off a turn that
     * is still working, and the reply would appear to come from nowhere.
     */
    const settle = () => {
      if (!deps.orchestrator.busy) {
        deps.events.emit({ type: 'state.changed', state: 'idle', turnId: null });
      }
    };

    if (!deps.orchestrator.busy) {
      deps.events.emit({ type: 'state.changed', state: 'transcribing', turnId });
    }

    /**
     * Transcription is timed because it was the one stage outside the trace,
     * and on 2026-09-03 it became the prime suspect: whisper `large-v3-turbo`
     * allocates 1.6 GB per utterance, and on a Mac already deep in swap that
     * pages the language model out — the same model call measured 1.65 s when
     * typed and 12.2 s when spoken.
     */
    const sttStartedAt = performance.now();

    /**
     * A transcription this utterance already started, during the silence hold.
     *
     * Claimed rather than re-run: the clip it was given is this same recording
     * minus its trailing silence, and the client only sends an id when no
     * speech arrived after the speculation was fired. When it is already
     * finished — the common case, since it had the hold to work in — this
     * costs nothing at all.
     */
    const speculationId = form?.get('speculationId');
    const claimed = typeof speculationId === 'string' ? speculations.claim(speculationId) : null;
    const speculated = claimed === null ? null : await claimed.result;

    const transcription = speculated
      ? { isErr: () => false as const, value: speculated }
      : await stt.transcribe({
          audio: {
            data: bytes.toString('base64'),
            sampleRate: 16000,
            channels: 1,
            encoding: 'wav',
          },
          language: 'auto',
          translateToEnglish: false,
        });

    if (transcription.isErr()) {
      const error = transcription.error;
      deps.events.emit({ type: 'error', error, turnId });
      settle();
      return c.json({ error: error.code, message: error.message }, 502);
    }

    const { text, detectedLanguage } = transcription.value;
    log.info(
      {
        ms: Math.round(performance.now() - sttStartedAt),
        audioMs: Math.round(wavDurationMs(bytes)),
        chars: text.length,
        language: detectedLanguage,
        // The number that says whether any of this was worth building.
        speculated: speculated !== null,
      },
      'transcribed',
    );

    // Whisper answers silence with a confident stock phrase rather than an
    // empty string, so an emptiness check alone lets "Thank you." and
    // "Gracias." through — each of which becomes a full LLM turn and a spoken
    // reply to something nobody said.
    const verdict = detectHallucination(text, { durationMs: wavDurationMs(bytes) });
    if (verdict.isHallucination) {
      log.debug({ text, reason: verdict.reason }, 'discarded non-speech transcript');
      settle();
      return c.json({ transcript: '', skipped: true, reason: verdict.reason });
    }

    /**
     * A pending consent card is answerable out loud.
     *
     * Checked before the wake word, because Assistant has just asked a question
     * and requiring "Hey Assistant, yes" to answer it is absurd. Only a plain
     * yes or no counts — "no, message Rahul instead" is a new request, and
     * the card stays up.
     *
     * This is a fixed vocabulary, never the model: the PRD is absolute that
     * the model cannot grant itself permission, and a spoken approval is
     * exactly the moment that rule matters.
     */
    const pendingCall = deps.orchestrator.awaitingDecision;
    if (pendingCall !== null) {
      const decision = matchSpokenDecision(text);
      if (decision !== null) {
        deps.orchestrator.resolveDecision(pendingCall, decision === 'approve');
        log.info({ decision, text }, 'consent answered by voice');
        return c.json({ transcript: text, decision });
      }
    }

    // The microphone is always on, so most of what it hears is not addressed
    // to Assistant. The wake word is what separates a command from the room.
    const wake = detectWakeWord(text);
    const stillAwake = Date.now() < awakeUntil;
    // Turning the wake word off means every utterance is addressed to Assistant.
    // It is a real preference — push-to-talk users do not want to say a name
    // to their own machine — and until settings persisted it could not be
    // expressed.
    const wakeWordRequired = deps.settings.current.wakeWordEnabled;

    if (wakeWordRequired && !wake.detected && !stillAwake) {
      settle();
      return c.json({ transcript: text, ignored: true, reason: 'no wake word' });
    }

    // While a turn is running, only an explicit wake word may interrupt it.
    //
    // `handleTurn` cancels whatever is in flight, and the follow-up window
    // stays open for 15s while a turn takes far longer than that. Without
    // this check, any sound the microphone picks up while Assistant is thinking
    // — including Assistant's own reply coming back through the speakers —
    // counts as a follow-up, cancels the answer, and the turn dies with
    // "This operation was aborted". The user sees no reply at all and no
    // reason for it. Saying the wake word again is still an interruption,
    // because that is unambiguously deliberate.
    if (deps.orchestrator.busy && wakeWordRequired && !wake.detected) {
      log.debug({ text }, 'ignored follow-up while a turn was already running');
      return c.json({ transcript: text, ignored: true, reason: 'busy' });
    }

    const command = wake.detected ? wake.command : text;

    // Wake word with nothing after it: acknowledge and wait for the request
    // rather than sending an empty turn to the model.
    if (command.trim().length === 0) {
      awakeUntil = Date.now() + FOLLOW_UP_WINDOW_MS;
      deps.events.emit({ type: 'state.changed', state: 'listening', turnId: null });
      return c.json({ transcript: text, awaitingCommand: true });
    }

    awakeUntil = Date.now() + FOLLOW_UP_WINDOW_MS;
    deps.events.emit({
      type: 'transcript.final',
      turnId,
      text: command,
      language: detectedLanguage,
    });
    deps.orchestrator.setLanguage(detectedLanguage);
    void deps.orchestrator.handleTurn(command);

    return c.json({ transcript: command, language: detectedLanguage });
  });

  /**
   * Starts transcribing an utterance that may not be over yet.
   *
   * Returns as soon as the run is queued, not when it finishes: the caller is
   * the microphone, and it has 650 ms of silence hold left to wait through
   * before it knows whether it wants the answer. `/voice/utterance` claims the
   * result later by id.
   *
   * Only offered for on-device transcription. Sarvam cannot recall a request
   * already sent, so a speculation there would be a round trip billed and
   * spent on a guess, with no way to take it back.
   */
  app.post('/voice/speculate', async (c) => {
    const stt = deps.voice.stt;
    if (stt?.name !== 'whisper-local') {
      return c.json({ speculating: false, reason: 'not_local' });
    }

    const form = await c.req.formData().catch(() => null);
    const file = form?.get('audio');
    if (!(file instanceof File)) {
      return c.json({ error: 'missing_audio', message: 'Expected an "audio" file field' }, 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const id = randomUUID();
    const controller = new AbortController();
    const startedAt = performance.now();

    /**
     * Started here and deliberately not awaited. The whole point is that the
     * work happens during the hold rather than after it.
     *
     * Errors are swallowed into `null`: a speculation that fails must leave
     * `/voice/utterance` to transcribe the clip itself, exactly as it would
     * have without any of this.
     */
    const result = stt
      .transcribe(
        {
          audio: {
            data: bytes.toString('base64'),
            sampleRate: 16000,
            channels: 1,
            encoding: 'wav',
          },
          language: 'auto',
          translateToEnglish: false,
        },
        { signal: controller.signal },
      )
      .match(
        (value) => value,
        () => null,
      );

    speculations.put(id, {
      result,
      abort: () => {
        controller.abort();
      },
      startedAt: Date.now(),
    });

    log.debug({ id, audioMs: Math.round(wavDurationMs(bytes)) }, 'speculating on an utterance');
    // `startedAt` is returned so the client can log what the overlap bought.
    return c.json({ speculating: true, id, queuedMs: Math.round(performance.now() - startedAt) });
  });

  /**
   * The user carried on talking, so the guess was wrong.
   *
   * This is the call that makes speculation safe rather than merely fast: an
   * abandoned run is dropped before it reaches the whisper queue, so the
   * utterance the user is actually waiting on never queues behind it.
   */
  app.post('/voice/speculate/:id/cancel', (c) => {
    const cancelled = speculations.cancel(c.req.param('id'));
    return c.json({ cancelled });
  });

  /**
   * Transcribes a snapshot of speech still in progress.
   *
   * Deliberately separate from `/voice/utterance`: this never starts a turn,
   * never touches conversation history, and uses a small fast model. Its only
   * job is to put words on screen while the user is still talking, and every
   * result is superseded moments later.
   */
  app.post('/voice/partial', async (c) => {
    const stt = deps.voice.partialStt;
    if (!stt) return c.json({ text: '' });

    const form = await c.req.formData().catch(() => null);
    const file = form?.get('audio');
    if (!(file instanceof File)) return c.json({ text: '' });

    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await stt.transcribe({
      audio: { data: bytes.toString('base64'), sampleRate: 16000, channels: 1, encoding: 'wav' },
      language: 'auto',
      translateToEnglish: false,
    });

    if (result.isErr()) return c.json({ text: '' });

    // Hallucination filtering still applies: a partial that invents "Thank
    // you." is more jarring than showing nothing, because the user watches it
    // appear under their own words.
    const text = result.value.text;
    const verdict = detectHallucination(text, { durationMs: wavDurationMs(bytes) });

    return c.json({ text: verdict.isHallucination ? '' : text });
  });

  /** Serves a synthesised clip until it expires. */
  app.get('/speech/:id', (c) => {
    const wav = deps.voice.speech.get(c.req.param('id'));
    if (!wav) return c.json({ error: 'not_found' }, 404);

    return c.body(
      wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
      200,
      {
        'content-type': 'audio/wav',
        'cache-control': 'no-store',
      },
    );
  });

  /**
   * Server-sent events rather than WebSockets: the stream is one-directional
   * and high frequency (audio levels, token deltas), and SSE reconnects on
   * its own. Commands travel back over plain POSTs.
   */
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      // An AbortSignal rather than a boolean: TypeScript narrows a `let`
      // initialised to `true` down to the literal type and then treats every
      // later read as constant, so the loop below looks infinite to the
      // type-aware lint rules. `signal.aborted` is an honest boolean getter.
      const connection = new AbortController();
      stream.onAbort(() => {
        connection.abort();
      });

      const unsubscribe = deps.events.on((event) => {
        if (connection.signal.aborted) return;
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });

      try {
        // Hold the connection open; the emitter drives all writes. The ping
        // keeps intermediaries from reaping an idle stream.
        while (!connection.signal.aborted) {
          await stream.sleep(15_000);
          // Re-checked after the await: the client may have disconnected
          // during those 15 seconds. The rule cannot model state changing
          // across an await, so it reads this as constant.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (!connection.signal.aborted) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
          }
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  /**
   * The settings the user can actually change.
   *
   * Read and write in one place, validated by the same schema the policy
   * engine reads, so a preference the UI can express is one the engine
   * honours. Voice fields are accepted but take effect on the next start —
   * the speech stack is built once, at boot.
   */
  app.get('/settings', (c) => c.json({ settings: deps.settings.current }));

  app.patch('/settings', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const outcome = await deps.settings.update(body);
    if (!outcome.ok) {
      return c.json({ error: 'invalid_settings', issues: outcome.issues }, 400);
    }
    return c.json({ settings: outcome.settings });
  });

  /**
   * Every tool's full declaration — connector, risk, scopes, timeout, retry
   * budget, whether it verifies itself and whether it can be undone.
   *
   * This is the PRD's tool registry made visible. A capability list that only
   * exists inside the process is not something a user can audit.
   */
  app.get('/tools', (c) =>
    c.json({ tools: deps.registry.describeAll({ settings: deps.settings.current, online: true }) }),
  );

  /**
   * Memory, seen and edited directly.
   *
   * The PRD asks for controls to view, edit and delete what Assistant has stored.
   * The `list_memories` and `forget` tools do this by voice, but asking an
   * assistant to read out everything it knows about you is not the same as
   * looking at the list — and correcting a fact by speaking to the thing that
   * misheard you the first time is worse.
   */
  app.get('/memories', async (c) => {
    if (!deps.memory) return c.json({ memories: [], configured: false });
    const limit = Number(c.req.query('limit') ?? '50');
    const memories = await deps.memory.list(Number.isFinite(limit) ? Math.min(limit, 200) : 50);
    return c.json({ memories, configured: true });
  });

  app.patch('/memories/:id', async (c) => {
    if (!deps.memory) return c.json({ error: 'memory_unavailable' }, 503);
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = MemoryEdit.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_memory',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const updated = await deps.memory.edit(c.req.param('id'), parsed.data.fact, parsed.data.tags);
    // 404 rather than a cheerful 200: an edit that matched nothing changed
    // nothing, and the UI must not show the new text as saved.
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ memory: updated });
  });

  app.delete('/memories/:id', async (c) => {
    if (!deps.memory) return c.json({ error: 'memory_unavailable' }, 503);
    const forgotten = await deps.memory.forget(c.req.param('id'));
    if (!forgotten) return c.json({ error: 'not_found' }, 404);
    return c.json({ forgotten: true });
  });

  app.post('/command', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ClientCommand.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_command',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        400,
      );
    }

    const command = parsed.data;
    switch (command.type) {
      case 'text.submit':
        // Fire and forget: the turn's progress is reported over SSE.
        void deps.orchestrator.handleTurn(command.text);
        return c.json({ accepted: true });

      case 'tool.decision': {
        const resolved = deps.orchestrator.resolveDecision(command.callId, command.approved);
        return c.json({ accepted: resolved });
      }

      case 'speak.cancel':
        deps.orchestrator.cancel();
        return c.json({ accepted: true });

      case 'listen.start':
      case 'listen.stop':
        // Capture lives in the shell process, which owns the microphone.
        return c.json({ accepted: true });
    }
  });

  return {
    app,
    start() {
      const server = serve({ fetch: app.fetch, port: deps.port, hostname: '127.0.0.1' });

      /**
       * A port already in use is the commonest way a start goes wrong — a
       * previous brain that outlived its supervisor, or two `pnpm start`s at
       * once. Left alone it surfaces as an unhandled 'error' event: a stack
       * trace ending in `emitErrorNT`, which says nothing about the cause, and
       * then a restart loop as the supervisor tries again into the same wall.
       *
       * Caught, it becomes one line naming the fix, and a clean exit rather
       * than three more identical failures.
       */
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          log.error(
            { port: deps.port },
            `port ${String(deps.port)} is already in use — another Assistant is probably running. Stop it with: pnpm run stop`,
          );
        } else {
          log.error({ error }, 'the brain could not start');
        }
        process.exit(1);
      });

      log.info({ port: deps.port }, 'brain listening');
      return server;
    },
  };
}
