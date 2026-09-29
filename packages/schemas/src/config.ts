import { z } from 'zod';
import { LanguageCode } from './common.js';
import { AssistantVoiceProfile } from './voice.js';

/**
 * Environment contract. Parsed once at boot so a missing key fails immediately
 * with a readable message, rather than as a 401 twenty minutes into a session.
 */
/**
 * An unset key in a `.env` file arrives as `''`, not as absent. Without this
 * an empty `SARVAM_API_KEY=` line fails `.min(10)` instead of being treated
 * as "not configured", which is what the user meant.
 */
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(10).optional(),
);

export const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  BRAIN_PORT: z.coerce.number().int().min(1024).max(65535).default(4317),

  /** Sarvam subscription key. Optional so the app still boots fully offline. */
  SARVAM_API_KEY: optionalSecret,

  /**
   * Which speech recogniser to use.
   *
   * `auto` prefers on-device whisper when its model is present, because that
   * keeps audio on the machine and needs no key, and falls back to Sarvam.
   */
  STT_PROVIDER: z.enum(['auto', 'local', 'sarvam']).default('auto'),
  /**
   * whisper.cpp model. Measured 2026-09-03 on "message Tilak on WhatsApp":
   * large-v3-turbo 3.63 s, `small` 0.96 s, `base` 0.45 s — and `small` heard
   * the name identically to large while `base` produced "Tilluck", which
   * matches no contact. On Hindi the two are close (0.84 s against 2.71 s).
   * `small` is therefore the default: 3.8x faster for no accuracy that
   * mattered. large-v3-turbo was dropped from `models/` on 2026-09-21.
   */
  WHISPER_MODEL_PATH: z.string().default('./models/ggml-small.bin'),
  WHISPER_BINARY: z.string().default('whisper-cli'),
  /**
   * A resident whisper-server. Measured 2026-09-06: whisper-cli median
   * 789 ms against the server's 626 ms for the same clip and model, so ~165 ms
   * a turn in steady state. It also absorbs the Metal shader compile at
   * start-up instead of paying ~2 s on the first utterance after a cold cache.
   * WHISPER_SERVER_ENABLED=false falls back to the CLI.
   */
  WHISPER_SERVER_URL: z.string().default('http://127.0.0.1:4319'),
  WHISPER_SERVER_ENABLED: z.stringbool().default(true),
  /**
   * Small model used only for live partial transcripts.
   *
   * Partials are throwaway visual feedback that are replaced the instant the
   * utterance ends, so they trade accuracy for speed. The large model still
   * produces the transcript that actually becomes a command.
   */
  WHISPER_FAST_MODEL_PATH: z.string().default('./models/ggml-base.bin'),
  SARVAM_BASE_URL: z.url().default('https://api.sarvam.ai'),

  /**
   * Voice conversion, applied to Sarvam's output so Assistant speaks in the
   * trained voice instead of a pitch-shifted one.
   *
   * Off by default. It needs `voice-training/rvc_server.py` running, and when
   * it is on it *replaces* the rubberband shift rather than stacking on it —
   * converting an already formant-shifted cartoon voice gives a poor result.
   * If the server is unreachable at boot the pitch shift is used instead, so
   * turning this on can never leave Assistant mute.
   */
  /**
   * Pre-synthesise the sentences Assistant says most often, in the background,
   * once the server is already accepting connections.
   *
   * On by default because the cost is bounded and one-off: the phrases are
   * written to the same disk cache a real turn would have filled, so a warmed
   * boot only ever does work a later turn would have done anyway — and does it
   * when nobody is waiting. Warming pauses whenever a turn is in flight, so it
   * cannot take the converter's slot from someone being answered.
   *
   * Turn it off to keep a boot completely quiet, or when working offline with
   * no Sarvam key, where every phrase would simply fail.
   */
  PHRASE_CACHE_WARM: z.stringbool().default(true),
  RVC_ENABLED: z.stringbool().default(false),
  RVC_BASE_URL: z.url().default('http://127.0.0.1:4318'),
  /** How hard the faiss index pulls toward the training voice, 0 to 1. */
  RVC_INDEX_RATE: z.coerce.number().min(0).max(1).default(0.5),
  /**
   * Which trained checkpoint to speak with. Unset means the newest on disk,
   * which is only a sensible default before one has been chosen by ear — more
   * epochs is not the same as a better voice.
   */
  RVC_MODEL: z.string().optional(),

  /**
   * Ask the model for a plan before acting on multi-step requests.
   *
   * Off by default, and not because it is unfinished. A planning pass is a
   * whole extra generation, and at the measured 31 tok/s that is seconds
   * before anything happens. It becomes worth paying once the model is fast
   * enough; the path is built and tested either way.
   */
  PLANNER_ENABLED: z.stringbool().default(false),

  /**
   * Model used for semantic recall over stored memories.
   *
   * `nomic-embed-text` produces 768 dimensions, which is exactly what the
   * memories table declares — a different model will be rejected rather than
   * silently storing vectors Postgres cannot accept. Recall falls back to
   * keyword matching when it is not pulled, so this is optional.
   */
  EMBEDDING_MODEL: z.string().default('nomic-embed-text'),

  /**
   * Slack Web API token. Unlike Mail, Slack has no AppleScript route, so
   * there is no token-free option. `chat:write` and `channels:read` cover
   * posting; searching additionally needs a user token with `search:read`.
   */
  SLACK_TOKEN: optionalSecret,

  /**
   * Whether Assistant may interrupt with a notification without being asked.
   *
   * Off by default. An assistant that can interrupt you unprompted is a
   * different product from one that answers when asked, and that should be a
   * choice rather than a default.
   */
  PROACTIVE_NOTIFICATIONS: z.stringbool().default(false),

  /**
   * How Assistant talks. Kept as configuration because personality is taste, and
   * the default is what suits a voice assistant: replies that are heard once,
   * not read.
   */
  ASSISTANT_PERSONALITY: z
    .string()
    .max(600)
    .default(
      'Warm and direct. Answer in one or two spoken sentences unless more is genuinely needed. ' +
        'Never narrate what you are about to do — do it. No filler, no restating the question.',
    ),

  OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('qwen3.6:27b-q4_K_M'),
  /**
   * How long Ollama keeps the model resident: a Go duration, or -1 for forever.
   *
   * This is a straight trade of memory for latency. The model occupies ~19 GB
   * while loaded, which on a 32 GB machine is most of the headroom, so `-1`
   * would make the rest of the Mac feel slow all day to save 10 seconds on the
   * first question. 30 minutes keeps it warm through an actual working session
   * and hands the memory back when you walk away.
   */
  OLLAMA_KEEP_ALIVE: z.string().default('30m'),

  DATABASE_URL: z.string().default('postgres://localhost:5432/assistant'),

  /**
   * Serper provides web search (Google results, including the answer box).
   * Without it, search falls back to scraping DuckDuckGo, which throttles
   * automated requests heavily and is unreliable.
   */
  SERPER_API_KEY: optionalSecret,
  /**
   * Cloud fallback for turns the fast path cannot route. Off unless
   * `CLOUD_FALLBACK` is true *and* a key is present: the PRD's first line is
   * local-first, so someone else's servers are an explicit choice.
   */
  GEMINI_API_KEY: z.string().min(10).optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash-lite'),
  CLOUD_FALLBACK: z.stringbool().default(false),
  /** Region and language for Serper results; `in` gives Indian results. */
  SEARCH_REGION: z.string().length(2).default('in'),
  SEARCH_LANGUAGE: z.string().length(2).default('en'),
});
export type Env = z.infer<typeof Env>;

/** User-facing settings, persisted to the DB rather than the environment. */
export const UserSettings = z.object({
  preferredLanguage: z.union([z.literal('auto'), LanguageCode]).default('auto'),
  /** Prefer local models even when the network is available. */
  offlineFirst: z.boolean().default(false),
  wakeWordEnabled: z.boolean().default(true),
  /** Global hotkey, Tauri accelerator syntax. */
  hotkey: z.string().default('Cmd+Shift+Space'),
  voice: AssistantVoiceProfile.prefault({}),
  /** Tools the user has permanently approved, bypassing the confirm prompt. */
  autoApprovedTools: z.array(z.string()).default([]),
  /** Never auto-approve these regardless — destructive tools are pinned here. */
  alwaysConfirmTools: z.array(z.string()).default([]),
  /**
   * Tools that additionally require Touch ID or the login password.
   *
   * `critical` tools always do. This list exists so the user can demand the
   * same of anything else they consider theirs alone — the shell, say —
   * without waiting for someone to reclassify a risk level for everybody.
   */
  strongAuthTools: z.array(z.string()).default([]),
});
export type UserSettings = z.infer<typeof UserSettings>;

/**
 * Parses an environment record, throwing a formatted error that lists every
 * problem at once rather than only the first.
 *
 * Takes the source explicitly rather than reading `process.env`, so this
 * package stays platform-neutral and is importable from the browser bundle.
 */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const parsed = Env.safeParse(source);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}
