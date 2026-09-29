import { ServerEvent, type ClientCommand } from '@assistant/schemas';

/** Every `type` in the ServerEvent union, taken from the schema itself. */
const SERVER_EVENT_TYPES: string[] = ServerEvent.options.map((option) => option.shape.type.value);

const env = import.meta.env as { VITE_BRAIN_URL?: string };
const BASE = env.VITE_BRAIN_URL ?? 'http://127.0.0.1:4317';

/**
 * Subscribes to the brain's event stream.
 *
 * Every frame is Zod-parsed before it reaches the store: the UI's state
 * machine should never be advanced by a payload it does not understand.
 */
export function connectEvents(
  onEvent: (event: ServerEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`${BASE}/events`);

  source.onopen = () => {
    onStatus(true);
  };
  source.onerror = () => {
    onStatus(false);
  };

  const handle = (raw: MessageEvent<string>) => {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.data);
    } catch {
      return;
    }
    const parsed = ServerEvent.safeParse(payload);
    if (parsed.success) onEvent(parsed.data);
  };

  // Derived from the schema rather than hand-listed.
  //
  // Server-sent events are delivered by name, so a type missing from this list
  // is received by the browser and silently dropped. `speech.ready` was
  // missing, which meant every spoken reply arrived and was discarded — no
  // audio, and no error either, because no handler ever ran.
  //
  // Reading the names off the discriminated union makes that class of bug
  // impossible: adding an event to the schema subscribes to it here.
  for (const type of SERVER_EVENT_TYPES) {
    source.addEventListener(type, handle as EventListener);
  }

  return () => {
    source.close();
    onStatus(false);
  };
}

/**
 * Uploads a recorded utterance; the brain transcribes it and starts a turn.
 *
 * `speculationId` claims a transcription this same utterance already started
 * during the silence hold. Passed only when nothing was said after that clip
 * was taken — the microphone decides that, not this function.
 */
export async function sendUtterance(
  wav: Blob,
  speculationId?: string | null,
): Promise<{ ok: boolean; message?: string }> {
  const form = new FormData();
  form.append('audio', wav, 'utterance.wav');
  if (speculationId) form.append('speculationId', speculationId);

  const response = await fetch(`${BASE}/voice/utterance`, { method: 'POST', body: form });
  if (response.ok) return { ok: true };

  const detail = (await response.json().catch(() => null)) as { message?: string } | null;
  return { ok: false, ...(detail?.message ? { message: detail.message } : {}) };
}

/**
 * Starts transcribing an utterance that may not be finished.
 *
 * Returns the id to claim the result with, or null when the brain declined —
 * it only speculates for on-device transcription, because a request already
 * sent to Sarvam cannot be taken back.
 *
 * Failures are swallowed: without a speculation the turn simply transcribes
 * normally, which is exactly what used to happen every time.
 */
export async function startSpeculation(wav: Blob): Promise<string | null> {
  const form = new FormData();
  form.append('audio', wav, 'speculation.wav');

  try {
    const response = await fetch(`${BASE}/voice/speculate`, { method: 'POST', body: form });
    if (!response.ok) return null;
    const data = (await response.json()) as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Abandons a speculative transcription because the user carried on talking.
 *
 * This is the call that makes speculating safe rather than merely fast. Left
 * uncancelled, a run nobody will read still holds whisper's single slot, and
 * the utterance the user is actually waiting on queues behind it.
 */
export async function cancelSpeculation(id: string): Promise<void> {
  try {
    await fetch(`${BASE}/voice/speculate/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  } catch {
    // The brain expires unclaimed speculations on its own, so a failed cancel
    // degrades to a slightly later cleanup rather than a stuck queue.
  }
}

/**
 * Plays a synthesised clip.
 */
let unlocked = false;

/**
 * Grants the page permission to play audio.
 *
 * Chrome refuses `HTMLAudioElement.play()` until the page has seen a genuine
 * user gesture. An assistant that answers by speaking hits this on its very
 * first reply, and the rejection is indistinguishable from having no voice at
 * all. Playing a silent clip inside the first real gesture spends that
 * activation on unlocking playback, so every later reply is allowed.
 *
 * Registered as a one-shot listener: once granted, the permission persists for
 * the page's lifetime.
 */
export function unlockAudioPlayback(): void {
  if (unlocked) return;

  const prime = () => {
    unlocked = true;
    // 1x1 silent WAV. Its only job is to be played during a user gesture.
    const silence = new Audio(
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=',
    );
    silence.volume = 0;
    void silence.play().catch(() => {
      // If even silence is refused there is nothing more to try here; the
      // caller surfaces the failure when a real clip is attempted.
    });
  };

  for (const event of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(event, prime, { once: true, capture: true });
  }
}

/**
 * Transcribes speech still in progress, for live feedback.
 *
 * Failures are swallowed on purpose here — unlike playback, a missed partial
 * costs nothing. A newer snapshot is already on its way, and an error message
 * about interim text the user never asked for would be pure noise.
 */
export async function sendPartial(wav: Blob): Promise<string> {
  const form = new FormData();
  form.append('audio', wav, 'partial.wav');

  try {
    const response = await fetch(`${BASE}/voice/partial`, { method: 'POST', body: form });
    if (!response.ok) return '';
    const data = (await response.json()) as { text?: string };
    return data.text ?? '';
  } catch {
    return '';
  }
}

/**
 * Plays a synthesised clip, reporting why it did not play.
 *
 * The previous version swallowed every rejection with a comment saying the
 * text was on screen anyway. That made a silent assistant indistinguishable
 * from a working one: a blocked autoplay, a 404 and a decode failure all
 * looked identical, which is to say invisible.
 *
 * Chrome refuses `play()` until the page has seen a real user gesture, so the
 * very first reply after a page load can be blocked even when everything else
 * is correct. That case needs saying out loud, not hiding.
 */
/**
 * Plays the reply's clips back to back.
 *
 * A reply is now synthesised sentence by sentence as the model writes it, so
 * several clips arrive per turn. The previous implementation paused whatever
 * was playing and started the new clip, which with streaming would cut every
 * sentence off a fraction of a second in.
 *
 * Played in arrival order rather than by index. The brain emits clips through
 * a serial queue, so arrival order is already reading order, and a FIFO cannot
 * stall — waiting for a specific index would hang the whole reply if one
 * sentence failed to synthesise.
 */
interface Clip {
  path: string;
  /** The words this clip says, revealed when it starts playing. */
  text: string;
}

const queue: Clip[] = [];
let playing: HTMLAudioElement | null = null;
let speakingTurn: string | null = null;
/** Called with a clip's words the moment that clip begins. */
let onSpoken: ((text: string) => void) | null = null;
/** Called when speech gives up, so the words are shown rather than lost. */
let onSpeechLost: (() => void) | null = null;

function pump(onProblem?: (message: string) => void): void {
  if (playing !== null) return;
  const next = queue.shift();
  if (next === undefined) return;

  const audio = new Audio(`${BASE}${next.path}`);
  playing = audio;

  const advance = () => {
    if (playing === audio) playing = null;
    pump(onProblem);
  };

  audio.addEventListener('ended', advance);
  audio.addEventListener('error', () => {
    const code = audio.error?.code;
    onProblem?.(
      code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? 'Could not decode the audio Assistant produced.'
        : 'Could not load the audio clip.',
    );
    // Silent is one failure; silent *and* blank is two. Show the words.
    onSpoken?.(next.text);
    // Keep going: one bad clip should not silence the rest of the reply.
    advance();
  });

  /**
   * Revealed when `play()` resolves rather than on the `playing` event: the
   * promise is the browser's own confirmation that audio has started, and it
   * cannot be missed by a listener attached a tick too late.
   */
  void audio.play().then(
    () => {
      onSpoken?.(next.text);
    },
    (error: unknown) => {
      const name = error instanceof DOMException ? error.name : '';
      onProblem?.(
        name === 'NotAllowedError'
          ? 'Your browser blocked autoplay. Click anywhere on the page once and Assistant will speak from then on.'
          : `Playback failed${name ? ` (${name})` : ''}.`,
      );
      // Blocked autoplay must not also mean a blank transcript.
      onSpoken?.(next.text);
      onSpeechLost?.();
      advance();
    },
  );
}

/** Drops anything queued and stops the current clip. */
export function stopSpeech(): void {
  queue.length = 0;
  playing?.pause();
  playing = null;
  speakingTurn = null;
}

/** Registers where spoken words and speech failures should be reported. */
export function onSpeechEvents(handlers: {
  spoken: (text: string) => void;
  lost: () => void;
}): void {
  onSpoken = handlers.spoken;
  onSpeechLost = handlers.lost;
}

export function playSpeech(
  path: string,
  turnId: string,
  text: string,
  onProblem?: (message: string) => void,
): void {
  // A clip from a different turn means the old reply has been superseded —
  // by a follow-up question, or by a turn that was cancelled. Drop the rest
  // of it rather than letting two answers overlap.
  if (speakingTurn !== null && speakingTurn !== turnId) stopSpeech();
  speakingTurn = turnId;

  queue.push({ path, text });
  pump(onProblem);
}

export async function sendCommand(command: ClientCommand): Promise<void> {
  await fetch(`${BASE}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
}

/**
 * The control surface: settings, stored memories, and what Assistant can do.
 *
 * These are plain fetches rather than part of the event stream. Nothing here
 * changes while you watch it, and a panel that opens with one request is
 * simpler to reason about than one fed by a subscription.
 */

export interface RemoteSettings {
  preferredLanguage: string;
  offlineFirst: boolean;
  wakeWordEnabled: boolean;
  hotkey: string;
  autoApprovedTools: string[];
  alwaysConfirmTools: string[];
}

export interface RemoteMemory {
  id: string;
  fact: string;
  tags: string[];
  createdAt?: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  connector: string;
  risk: string;
  confirmation: string;
  scopes: string[];
  macPermissions: string[];
  timeoutMs: number;
  verification: string;
  rollback: string;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      issues?: { path: string; message: string }[];
      error?: string;
    } | null;
    // The field that was rejected, when the server named one — "invalid" alone
    // gives the user nothing to correct.
    const named = detail?.issues?.map((i) => `${i.path}: ${i.message}`).join(', ');
    throw new Error(named ?? detail?.error ?? `Request failed (${String(response.status)})`);
  }
  return (await response.json()) as T;
}

export async function fetchSettings(): Promise<RemoteSettings> {
  const body = await readJson<{ settings: RemoteSettings }>(await fetch(`${BASE}/settings`));
  return body.settings;
}

/** Sends only the fields that changed; the brain merges them. */
export async function patchSettings(patch: Partial<RemoteSettings>): Promise<RemoteSettings> {
  const body = await readJson<{ settings: RemoteSettings }>(
    await fetch(`${BASE}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
  return body.settings;
}

export async function fetchMemories(): Promise<{ memories: RemoteMemory[]; configured: boolean }> {
  return readJson<{ memories: RemoteMemory[]; configured: boolean }>(
    await fetch(`${BASE}/memories`),
  );
}

export async function editMemory(id: string, fact: string, tags: string[]): Promise<RemoteMemory> {
  const body = await readJson<{ memory: RemoteMemory }>(
    await fetch(`${BASE}/memories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fact, tags }),
    }),
  );
  return body.memory;
}

export async function deleteMemory(id: string): Promise<void> {
  await readJson<{ forgotten: boolean }>(
    await fetch(`${BASE}/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  );
}

export async function fetchTools(): Promise<ToolDeclaration[]> {
  const body = await readJson<{ tools: ToolDeclaration[] }>(await fetch(`${BASE}/tools`));
  return body.tools;
}
