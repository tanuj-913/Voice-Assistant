import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhisperSttProvider } from './whisper.js';

/**
 * The resident-server path, added 2026-09-06.
 *
 * Worth ~165 ms a turn (whisper-cli median 789 ms, server 626 ms), plus it
 * absorbs the Metal shader compile at start-up instead of paying ~2 s on the
 * first utterance after a cold cache. These tests cover the parts that are
 * easy to get silently wrong: the language field is named differently by the
 * server, and the fallback must never turn a slow reply into no reply.
 */

const WAV = Buffer.from('not really audio').toString('base64');

const request = {
  audio: { data: WAV, sampleRate: 16_000, channels: 1, encoding: 'wav' },
  language: 'auto',
  translateToEnglish: false,
} as const;

function provider() {
  return new WhisperSttProvider({
    modelPath: '/nonexistent/model.bin',
    // Deliberately unrunnable: if a test reaches the CLI it must fail loudly
    // rather than quietly shelling out on the developer's machine.
    binary: '/nonexistent/whisper-cli',
    serverUrl: 'http://127.0.0.1:4319',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('whisper via a resident server', () => {
  it('transcribes and maps the language name the server reports', async () => {
    // The CLI says "en"; the server says "english". Getting this wrong would
    // answer an English question in the default voice with no language set.
    stubFetch({ text: '  Hey Assistant, what time is it?  ', language: 'english' });

    const result = await provider().transcribe(request);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.text).toBe('Hey Assistant, what time is it?');
    expect(result.value.detectedLanguage).toBe('en-IN');
  });

  it('maps every Indian language the app supports', async () => {
    for (const [name, code] of [
      ['hindi', 'hi-IN'],
      ['tamil', 'ta-IN'],
      ['telugu', 'te-IN'],
      ['bengali', 'bn-IN'],
      ['marathi', 'mr-IN'],
      ['punjabi', 'pa-IN'],
    ] as const) {
      stubFetch({ text: 'x', language: name });
      const result = await provider().transcribe(request);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value.detectedLanguage).toBe(code);
    }
  });

  it('asks for verbose_json, because plain json omits the language', async () => {
    const fetchMock = stubFetch({ text: 'hello', language: 'english' });
    await provider().transcribe(request);

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: FormData }];
    expect(init.body.get('response_format')).toBe('verbose_json');
    expect(url).toContain('/inference');
  });

  it('reports an unknown language as null rather than guessing', async () => {
    stubFetch({ text: 'hello', language: 'klingon' });
    const result = await provider().transcribe(request);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.detectedLanguage).toBeNull();
  });

  it('falls back to the CLI when the server answers with an error', async () => {
    // The CLI binary does not exist, so falling back must surface as a failed
    // result — proving the fallback ran rather than the server result standing.
    stubFetch({}, false);
    const result = await provider().transcribe(request);
    expect(result.isErr()).toBe(true);
  });

  it('falls back to the CLI when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await provider().transcribe(request);
    expect(result.isErr()).toBe(true);
  });

  it('stops retrying the server once it has failed', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const stt = provider();
    await stt.transcribe(request);
    await stt.transcribe(request);
    await stt.transcribe(request);

    // Probing a dead server on every utterance would add back the latency the
    // server exists to remove.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call the server at all when no URL is configured', async () => {
    const fetchMock = stubFetch({ text: 'hello', language: 'english' });
    const stt = new WhisperSttProvider({
      modelPath: '/nonexistent/model.bin',
      binary: '/nonexistent/whisper-cli',
    });
    await stt.transcribe(request);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Abandoning a transcription, for speculative runs.
 *
 * A clip transcribed on the guess that the user had stopped is worthless the
 * moment they carry on — and worse than worthless if it is still holding the
 * queue's only slot when the real utterance arrives.
 */
describe('abandoning a transcription', () => {
  it('never starts a run aborted before its slot opened', async () => {
    const fetchMock = stubFetch({ text: 'should never be requested', language: 'english' });
    const controller = new AbortController();
    controller.abort();

    const result = await provider().transcribe(request, { signal: controller.signal });

    expect(result.isErr()).toBe(true);
    // The point: no work was done at all, so the utterance behind it waits for
    // nothing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the signal to the server so a started run can be stopped', async () => {
    const fetchMock = stubFetch({ text: 'hello', language: 'english' });

    await provider().transcribe(request, { signal: new AbortController().signal });

    const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * An abort is the caller changing its mind, not the server failing. Marking
   * the server down here would demote every later turn in the session to the
   * slower CLI because someone once carried on talking mid-sentence.
   */
  it('does not treat an abort as the server being down', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    vi.stubGlobal('fetch', fetchMock);
    const stt = provider();

    const first = await stt.transcribe(request, { signal: new AbortController().signal });
    expect(first.isErr()).toBe(true);

    // Second call must still try the server rather than falling through to the
    // CLI for the rest of the session.
    stubFetch({ text: 'still here', language: 'english' });
    const second = await stt.transcribe(request);
    expect(second.isOk()).toBe(true);
    if (second.isOk()) expect(second.value.text).toBe('still here');
  });

  it('leaves an ordinary transcription untouched', async () => {
    stubFetch({ text: 'no signal given', language: 'english' });

    const result = await provider().transcribe(request);

    expect(result.isOk()).toBe(true);
  });
});
