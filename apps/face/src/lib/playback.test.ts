import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Clip playback, which streaming speech made load-bearing.
 *
 * The brain now emits one clip per sentence while the model is still writing,
 * so the browser is responsible for playing several clips as one continuous
 * reply — back to back, in order, with no overlap — and for abandoning them
 * the moment the user asks something else. None of that had ever been run.
 *
 * `Audio` is stubbed rather than mocked away: each instance records what it
 * was asked to do and lets the test decide when it "ends", which is the only
 * way to observe whether two clips were ever playing at once.
 */

class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly listeners = new Map<string, (() => void)[]>();
  error: { code: number } | null = null;
  playing = false;
  paused = false;
  playRejection: Error | null = null;

  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, handler: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  play(): Promise<void> {
    if (this.playRejection) return Promise.reject(this.playRejection);
    this.playing = true;
    return Promise.resolve();
  }

  pause(): void {
    this.playing = false;
    this.paused = true;
  }

  fire(type: string): void {
    // A real element stops on either, so the fake must too or the overlap
    // check counts a dead clip as still audible.
    if (type === 'ended' || type === 'error') this.playing = false;
    for (const handler of this.listeners.get(type) ?? []) handler();
  }
}

const nowPlaying = () => FakeAudio.instances.filter((a) => a.playing);

async function loadApi() {
  vi.resetModules();
  FakeAudio.instances = [];
  // `new Audio(...)` and the MediaError constants are browser globals; the
  // suite runs in node.
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('MediaError', { MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  return await import('./api.js');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('streaming clip playback', () => {
  it('plays clips one at a time, in order, with no overlap', async () => {
    const { playSpeech } = await loadApi();

    // Three sentences of one reply, arriving faster than they can be played.
    playSpeech('/speech/one', 'turn-1', 'said');
    playSpeech('/speech/two', 'turn-1', 'said');
    playSpeech('/speech/three', 'turn-1', 'said');

    // The overlap check: queueing three must not start three.
    expect(FakeAudio.instances).toHaveLength(1);
    expect(nowPlaying()).toHaveLength(1);
    expect(FakeAudio.instances[0]?.src).toContain('/speech/one');

    FakeAudio.instances[0]?.fire('ended');
    expect(nowPlaying()).toHaveLength(1);
    expect(FakeAudio.instances[1]?.src).toContain('/speech/two');

    FakeAudio.instances[1]?.fire('ended');
    expect(FakeAudio.instances[2]?.src).toContain('/speech/three');

    FakeAudio.instances[2]?.fire('ended');
    expect(nowPlaying()).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(3);
  });

  it('cuts the old reply off when a new turn starts speaking', async () => {
    const { playSpeech } = await loadApi();

    playSpeech('/speech/old-1', 'turn-1', 'said');
    playSpeech('/speech/old-2', 'turn-1', 'said');
    const first = FakeAudio.instances[0];

    // The user asks something else and the new turn's first clip arrives.
    playSpeech('/speech/new-1', 'turn-2', 'said');

    expect(first?.paused).toBe(true);
    // Two answers must never be audible together.
    expect(nowPlaying()).toHaveLength(1);
    expect(nowPlaying()[0]?.src).toContain('/speech/new-1');

    // The superseded reply's second clip must be gone, not merely deferred.
    nowPlaying()[0]?.fire('ended');
    expect(nowPlaying()).toHaveLength(0);
    expect(FakeAudio.instances.map((a) => a.src).some((s) => s.includes('old-2'))).toBe(false);
  });

  it('keeps going when one clip fails to load', async () => {
    const { playSpeech } = await loadApi();
    const problems: string[] = [];

    playSpeech('/speech/bad', 'turn-1', 'said', (m) => problems.push(m));
    playSpeech('/speech/good', 'turn-1', 'said', (m) => problems.push(m));

    const bad = FakeAudio.instances[0];
    if (bad) bad.error = { code: 4 };
    bad?.fire('error');

    // One bad clip must not silence the rest of the reply.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/decode/i);
    expect(nowPlaying()[0]?.src).toContain('/speech/good');
  });

  it('explains an autoplay block instead of failing silently', async () => {
    const { playSpeech } = await loadApi();
    const problems: string[] = [];

    FakeAudio.prototype.play = function play(this: FakeAudio) {
      const error = new DOMException('blocked', 'NotAllowedError');
      return Promise.reject(error);
    };

    playSpeech('/speech/one', 'turn-1', 'said', (m) => problems.push(m));
    await Promise.resolve();
    await Promise.resolve();

    expect(problems[0]).toMatch(/autoplay/i);

    // Restore for the remaining tests in this file.
    FakeAudio.prototype.play = function play(this: FakeAudio) {
      this.playing = true;
      return Promise.resolve();
    };
  });

  it('stopSpeech drops the queue and silences the current clip', async () => {
    const { playSpeech, stopSpeech } = await loadApi();

    playSpeech('/speech/one', 'turn-1', 'said');
    playSpeech('/speech/two', 'turn-1', 'said');
    const first = FakeAudio.instances[0];

    stopSpeech();

    expect(first?.paused).toBe(true);
    expect(nowPlaying()).toHaveLength(0);
    // Nothing queued may start afterwards.
    first?.fire('ended');
    expect(FakeAudio.instances).toHaveLength(1);
  });
});

/**
 * Words appear when they are spoken.
 *
 * The model finishes writing about three seconds before the voice finishes
 * saying it, so streaming tokens into the transcript meant reading the whole
 * answer and then hearing it repeated. Reported by the user on 2026-09-03:
 * "the replies are coming before the audio".
 */
describe('revealing text in step with the audio', () => {
  it('announces a clip when it starts playing, not when it is queued', async () => {
    const { playSpeech, onSpeechEvents } = await loadApi();
    const spoken: string[] = [];
    onSpeechEvents({ spoken: (t) => spoken.push(t), lost: () => undefined });

    playSpeech('/speech/one', 'turn-1', 'It is twenty past four.');
    playSpeech('/speech/two', 'turn-1', 'Shall I set a reminder?');

    // Queued but not yet playing: nothing is revealed by arrival alone.
    expect(spoken).toEqual([]);

    // `play()` resolving is the browser confirming audio has started.
    await Promise.resolve();
    await Promise.resolve();
    expect(spoken).toEqual(['It is twenty past four.']);

    // The second sentence waits its turn, exactly as the audio does.
    FakeAudio.instances[0]?.fire('ended');
    await Promise.resolve();
    await Promise.resolve();
    expect(spoken).toEqual(['It is twenty past four.', 'Shall I set a reminder?']);
  });

  /** Silent is one failure. Silent and blank is two. */
  it('shows the words anyway when the clip will not play', async () => {
    const { playSpeech, onSpeechEvents } = await loadApi();
    const spoken: string[] = [];
    let lost = 0;
    onSpeechEvents({
      spoken: (t) => spoken.push(t),
      lost: () => {
        lost += 1;
      },
    });

    // The instance field shadows anything set on the prototype, so the method
    // itself is replaced — the same approach the autoplay test above uses.
    FakeAudio.prototype.play = () =>
      Promise.reject(new DOMException('blocked', 'NotAllowedError'));

    playSpeech('/speech/blocked', 'turn-1', 'Autoplay was blocked.', () => undefined);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(spoken).toEqual(['Autoplay was blocked.']);
    expect(lost).toBe(1);

    // Restored the same way the autoplay test above does it.
    FakeAudio.prototype.play = function play(this: FakeAudio) {
      this.playing = true;
      return Promise.resolve();
    };
  });
});
