import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  appError,
  errAsync,
  fromPromise,
  okAsync,
  TypedEmitter,
  type AppResultAsync,
  type TraceSpan,
} from '@assistant/core';
import {
  ProviderStatus,
  SynthesisResult,
  UserSettings,
  type ServerEvent,
  type SynthesisRequest,
} from '@assistant/schemas';
import { defineTool, ToolRegistry, type Authenticator, type TaskStore } from '@assistant/tools';
import type { TextToSpeechProvider } from '@assistant/voice';
import type { AssistantDb } from '@assistant/db';
import { Orchestrator } from './orchestrator.js';
import { SpeechStore, type VoiceStack } from './voice.js';
import type { OllamaClient, OllamaMessage } from './llm/ollama.js';

/**
 * The orchestrator's collaborators are all injected, so the turn loop can be
 * driven end to end without Ollama, Sarvam, Postgres or a microphone. That
 * matters more than usual here: every fix in this file from 2026-08-31 —
 * streaming speech, the busy gate, `think: false` on follow-ups — shipped
 * without ever being executed, because starting the brain needs a 21 GB model
 * resident.
 */

// --- fakes ------------------------------------------------------------------

/** Drizzle's builder is chainable and thenable; the orchestrator never reads back. */
function fakeDb(): { db: AssistantDb; writes: number } {
  const state = { writes: 0 };
  const db = {
    insert: () => ({
      values: () => {
        state.writes += 1;
        return Object.assign(Promise.resolve([]), {
          onConflictDoNothing: () => Promise.resolve([]),
        });
      },
    }),
  };
  return {
    db: db as unknown as AssistantDb,
    get writes() {
      return state.writes;
    },
  };
}

interface ScriptedTurn {
  /** Streamed to `onDelta` before the completion resolves. */
  deltas?: string[];
  content: string;
  toolCalls?: { function: { name: string; arguments: unknown } }[];
  /** Makes the model call fail, for testing how a turn ends when it goes wrong. */
  fail?: boolean;
}

function fakeLlm(script: ScriptedTurn[]) {
  const requests: { think?: boolean; messages: { role: string; content: string }[] }[] = [];
  let call = 0;
  const client = {
    chat(request: unknown, handlers: { onDelta?: (d: string) => void } = {}) {
      requests.push(request as (typeof requests)[number]);
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (step?.fail) {
        return errAsync(
          appError('ollama_chat_failed', 'the model refused'),
        ) as AppResultAsync<OllamaMessage>;
      }
      for (const delta of step?.deltas ?? []) handlers.onDelta?.(delta);
      const message: OllamaMessage = {
        role: 'assistant',
        content: step?.content ?? '',
        ...(step?.toolCalls ? { tool_calls: step.toolCalls } : {}),
      };
      return okAsync(message) as AppResultAsync<OllamaMessage>;
    },
  };
  return { llm: client as unknown as OllamaClient, requests };
}

/**
 * `delays` lets a test make a short sentence synthesise faster than the long
 * one before it — the exact condition under which completion order stops
 * matching reading order.
 */
function fakeTts(delays: Record<string, number> = {}) {
  const started: string[] = [];
  const finished: string[] = [];
  const tts: TextToSpeechProvider = {
    name: 'sarvam',
    requiresNetwork: true,
    synthesize(request: SynthesisRequest): AppResultAsync<SynthesisResult> {
      started.push(request.text);
      return fromPromise(
        (async () => {
          await new Promise((r) => setTimeout(r, delays[request.text] ?? 0));
          finished.push(request.text);
          return SynthesisResult.parse({
            audio: {
              data: Buffer.from(request.text).toString('base64'),
              sampleRate: 22050,
              channels: 1,
              encoding: 'wav',
            },
            provider: 'sarvam',
            durationMs: 1,
          });
        })(),
        'tts_failed',
      );
    },
    health: () =>
      okAsync(
        ProviderStatus.parse({
          name: 'sarvam',
          available: true,
          lastCheckedAt: new Date().toISOString(),
        }),
      ),
  };
  return { tts, started, finished };
}

function harness(
  script: ScriptedTurn[],
  opts: {
    ttsDelays?: Record<string, number>;
    tools?: Parameters<ToolRegistry['register']>;
    planner?: boolean;
    settings?: Partial<UserSettings>;
    authenticate?: Authenticator;
    tasks?: TaskStore | null;
    settleMs?: number;
  } = {},
) {
  const events = new TypedEmitter<ServerEvent>();
  const seen: ServerEvent[] = [];
  events.on((event) => seen.push(event));

  const { llm, requests } = fakeLlm(script);
  const { tts, started, finished } = fakeTts(opts.ttsDelays);
  const { db } = fakeDb();
  const traces: Record<string, TraceSpan>[] = [];
  const registry = new ToolRegistry();
  if (opts.tools) registry.register(...opts.tools);

  const voice: VoiceStack = {
    partialStt: null,
    stt: null,
    tts,
    speech: new SpeechStore(),
    configured: true,
    ttsProvider: 'sarvam',
    sttProvider: null,
  };

  const orchestrator = new Orchestrator({
    llm,
    db,
    registry,
    events,
    model: 'test-model',
    plannerEnabled: opts.planner ?? false,
    settings: () => UserSettings.parse(opts.settings ?? {}),
    ...(opts.authenticate ? { authenticate: opts.authenticate } : {}),
    ...(opts.tasks ? { tasks: opts.tasks } : {}),
    ...(opts.settleMs === undefined ? {} : { settleMs: opts.settleMs }),
    voice,
    isOnline: () => true,
    onTrace: (summary) => traces.push(summary.stages),
  });

  const of = <T extends ServerEvent['type']>(type: T) =>
    seen.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);

  return {
    orchestrator,
    events: seen,
    eventsEmitter: events,
    of,
    requests,
    started,
    finished,
    traces,
  };
}

// --- tests ------------------------------------------------------------------

describe('streaming speech', () => {
  it('emits clips in reading order even when a later one synthesises first', async () => {
    // Each sentence must clear MIN_SPEAKABLE_CHARS (12) or SentenceStream
    // holds it back rather than speaking a stub on its own breath.
    const slow = 'This first sentence is deliberately long.';
    const quick = 'This one is shorter.';
    const last = 'And this one ends it.';
    // The first clip takes far longer to synthesise than the two after it,
    // which is exactly when completion order stops matching reading order.
    const h = harness(
      [{ deltas: [`${slow} `, `${quick} `, `${last} `], content: `${slow} ${quick} ${last}` }],
      { ttsDelays: { [slow]: 40 } },
    );

    await h.orchestrator.handleTurn('say three things');

    expect(h.of('speech.ready').map((e) => e.index)).toEqual([0, 1, 2]);
    expect(h.finished).toEqual([slow, quick, last]);
  });

  it('marks only the last clip final', async () => {
    const h = harness([{ deltas: ['First. ', 'Second.'], content: 'First. Second.' }]);
    await h.orchestrator.handleTurn('two sentences');

    const finals = h.of('speech.ready').map((e) => e.final);
    expect(finals.slice(0, -1).every((f) => !f)).toBe(true);
    expect(finals.at(-1)).toBe(true);
  });

  it('ends the turn without speaking when the reply is empty', async () => {
    const h = harness([{ content: '' }]);
    await h.orchestrator.handleTurn('nothing to say');

    expect(h.of('speech.ready')).toHaveLength(0);
    // The turn ends on a terminal state rather than snapping to idle: the
    // point of `success` is that a person sees the turn finished. Idle
    // follows a moment later — see the settling tests.
    expect(h.of('state.changed').at(-1)?.state).toBe('success');
  });
});

describe('reasoning budget', () => {
  it('reasons on every pass, because disabling it leaks the monologue', async () => {
    const clock = defineTool({
      metadata: {
        name: 'clock',
        description: 'Current time',
        category: 'system',
        risk: 'read',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({}),
      execute: () => okAsync({ time: '09:25 PM IST' }),
    });

    const h = harness(
      [
        { content: '', toolCalls: [{ function: { name: 'clock', arguments: {} } }] },
        { deltas: ["It's twenty-five past nine."], content: "It's twenty-five past nine." },
      ],
      { tools: [clock] },
    );

    await h.orchestrator.handleTurn('what time is it');

    expect(h.requests).toHaveLength(2);
    // Both passes reason. `think: false` does not suppress qwen3's chain of
    // thought, it merges it into `content` untagged, where nothing downstream
    // can strip it and Assistant reads it aloud. Verified against the live model
    // on 2026-09-01. The round trip is saved by `#speakableAnswer` instead.
    expect(h.requests.every((r) => r.think === true)).toBe(true);
  });

  it('feeds the tool outcome back to the model', async () => {
    const clock = defineTool({
      metadata: {
        name: 'clock',
        description: 'Current time',
        category: 'system',
        risk: 'read',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({}),
      execute: () => okAsync({ time: '09:25 PM IST' }),
    });

    const h = harness(
      [
        { content: '', toolCalls: [{ function: { name: 'clock', arguments: {} } }] },
        { content: 'Done.' },
      ],
      { tools: [clock] },
    );

    await h.orchestrator.handleTurn('what time is it');

    const second = h.requests[1]?.messages ?? [];
    expect(second.some((m) => m.role === 'tool')).toBe(true);
    expect(h.of('tool.completed')).toHaveLength(1);
  });
});

describe('tool answers without a second model call', () => {
  const volume = defineTool({
    metadata: {
      name: 'set_volume',
      description: 'Set output volume',
      category: 'system',
      risk: 'read',
      connector: 'internal',
      requiresNetwork: false,
    },
    input: z.object({ level: z.number() }),
    execute: (args) => okAsync({ level: args.level }),
    speak: (result) => `Volume set to ${String((result as { level: number }).level)} percent.`,
  });

  const call = [{ function: { name: 'set_volume', arguments: { level: 40 } } }];

  it('speaks the tool sentence and never calls the model again', async () => {
    const h = harness([{ content: '', toolCalls: call }, { content: 'unused' }], {
      tools: [volume],
    });

    // Deliberately phrased so the deterministic fast path does *not* match:
    // this test is about the model choosing a tool and the turn ending without
    // a second generation. "set the volume to forty" now routes without any
    // model call at all, which would test something else entirely.
    await h.orchestrator.handleTurn('set the audio level to forty');

    // One request only: the follow-up that would have phrased `{level: 40}`
    // is exactly the round trip this removes.
    expect(h.requests).toHaveLength(1);
    expect(h.finished).toEqual(['Volume set to 40 percent.']);
    expect(h.of('response.done').at(-1)?.message.content).toBe('Volume set to 40 percent.');
  });

  it('falls back to the model when the tool failed', async () => {
    const failing = defineTool({
      metadata: {
        name: 'set_volume',
        description: 'Set output volume',
        category: 'system',
        risk: 'read',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({ level: z.number() }),
      execute: () => errAsync(appError('volume_failed', 'no output device')),
      speak: () => 'Volume set.',
    });

    const h = harness(
      [{ content: '', toolCalls: call }, { content: 'I could not change the volume.' }],
      { tools: [failing] },
    );

    await h.orchestrator.handleTurn('set the volume to forty');

    // A failure needs explaining, and the renderer only knows the happy path.
    expect(h.requests).toHaveLength(2);
  });

  it('falls back to the model when two tools ran', async () => {
    const other = defineTool({
      metadata: {
        name: 'open_app',
        description: 'Open an app',
        category: 'system',
        risk: 'read',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({}),
      execute: () => okAsync({ opened: 'Safari' }),
      speak: () => 'Opened Safari.',
    });

    const h = harness(
      [
        {
          content: '',
          toolCalls: [
            { function: { name: 'set_volume', arguments: { level: 40 } } },
            { function: { name: 'open_app', arguments: {} } },
          ],
        },
        { content: 'Both done.' },
      ],
      { tools: [volume, other] },
    );

    await h.orchestrator.handleTurn('do two things');

    // Composing two results is what the model is for.
    expect(h.requests).toHaveLength(2);
  });

  it('falls back to the model when the reply is owed in another language', async () => {
    const h = harness([{ content: '', toolCalls: call }, { content: 'आवाज़ सेट कर दी।' }], {
      tools: [volume],
    });

    h.orchestrator.setLanguage('hi-IN');
    await h.orchestrator.handleTurn('आवाज़ चालीस कर दो');

    // The renderers are English. Answering Hindi in English would be worse
    // than the extra round trip.
    expect(h.requests).toHaveLength(2);
  });
});

describe('busy gate', () => {
  it('is not busy before or after a turn', async () => {
    const h = harness([{ content: 'Hello.' }]);
    expect(h.orchestrator.busy).toBe(false);
    await h.orchestrator.handleTurn('hi');
    expect(h.orchestrator.busy).toBe(false);
  });

  it('reports busy while a turn is in flight', async () => {
    const h = harness(
      [{ deltas: ['Still thinking about it.'], content: 'Still thinking about it.' }],
      {
        ttsDelays: { 'Still thinking about it.': 30 },
      },
    );
    const turn = h.orchestrator.handleTurn('hi');
    // NOTE: `busy` is false for the first microtask after handleTurn returns.
    // `handleTurn` cancels the previous turn (clearing #abort) and queues
    // #runTurn behind #inFlight, and only #runTurn sets the new controller.
    // Callers gate on this from a later event-loop turn, so the window does
    // not bite in practice — but it is a window, not a guarantee.
    await Promise.resolve();
    expect(h.orchestrator.busy).toBe(true);
    await turn;
    expect(h.orchestrator.busy).toBe(false);
  });

  it('serialises a follow-up behind the turn it interrupts', async () => {
    const h = harness(
      [
        { deltas: ['First answer.'], content: 'First answer.' },
        { deltas: ['Second answer.'], content: 'Second answer.' },
      ],
      { ttsDelays: { 'First answer.': 25 } },
    );

    const first = h.orchestrator.handleTurn('question one');
    const second = h.orchestrator.handleTurn('question two');
    await Promise.all([first, second]);

    // History must not interleave: each turn's user message precedes its own
    // model call rather than both landing before either completion.
    const asked = h.requests.map((r) => r.messages.filter((m) => m.role === 'user').length);
    expect(asked).toEqual([1, 2]);
    expect(h.orchestrator.busy).toBe(false);
  });
});

describe('interruption', () => {
  const three = (a: string, b: string, c: string) => ({
    deltas: [`${a} `, `${b} `, `${c} `],
    content: `${a} ${b} ${c}`,
  });

  const A = 'This is the first thing I have to say.';
  const B = 'This is the second thing I have to say.';
  const C = 'This is the third thing I have to say.';

  it('stops speaking the old reply when a follow-up arrives', async () => {
    const h = harness([three(A, B, C), { content: 'The follow-up answer, at last.' }], {
      // Slow enough that the reply is still being spoken when the user
      // interrupts, which is the only interesting case.
      ttsDelays: { [A]: 30, [B]: 30, [C]: 30 },
    });

    const first = h.orchestrator.handleTurn('question one');
    // Let the turn get under way and start on its first clip.
    await new Promise((r) => setTimeout(r, 10));
    const second = h.orchestrator.handleTurn('question two');
    await Promise.all([first, second]);

    // Whatever was already in flight may land, but the queue must not keep
    // working through a reply the user has moved on from.
    expect(h.finished).not.toContain(C);
  });

  it('cancel() alone halts the remaining clips', async () => {
    const h = harness([three(A, B, C)], { ttsDelays: { [A]: 30, [B]: 30, [C]: 30 } });

    const turn = h.orchestrator.handleTurn('question one');
    await new Promise((r) => setTimeout(r, 10));
    h.orchestrator.cancel();
    await turn;

    expect(h.finished).not.toContain(C);
    expect(h.orchestrator.busy).toBe(false);
  });
});

describe('fast path', () => {
  const clock = defineTool({
    metadata: {
      name: 'system_info',
      description: 'Read a system metric',
      category: 'system',
      risk: 'read',
      connector: 'internal',
      requiresNetwork: false,
    },
    input: z.object({ metric: z.string() }),
    execute: () => okAsync({ metric: 'time', raw: 'Tuesday 01 September 2026, 05:37 PM IST' }),
    speak: (result) => {
      const raw = (result as { raw: string }).raw;
      const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(raw);
      return m ? `It's ${String(Number(m[1]))}:${m[2] ?? ''} ${(m[3] ?? '').toUpperCase()}.` : null;
    },
  });

  it('answers without calling the model at all', async () => {
    const h = harness([{ content: 'the model should never be asked' }], { tools: [clock] });

    await h.orchestrator.handleTurn('what time is it');

    // The whole point: 22 seconds of deliberation, skipped entirely.
    expect(h.requests).toHaveLength(0);
    expect(h.finished).toEqual(["It's 5:37 PM."]);
    expect(h.of('tool.completed')).toHaveLength(1);
    expect(h.of('response.done').at(-1)?.message.content).toBe("It's 5:37 PM.");
  });

  it('leaves anything it cannot route to the model', async () => {
    const h = harness([{ content: 'It is just past five in Tokyo.' }], { tools: [clock] });

    await h.orchestrator.handleTurn('what time is it in Tokyo');

    expect(h.requests).toHaveLength(1);
  });

  /**
   * When the tool ran but cannot phrase the outcome, the model must be handed
   * the result rather than left to call the tool again — `next track` run
   * twice skips two songs.
   */
  it('does not re-run a tool it already executed', async () => {
    let executions = 0;
    const failing = defineTool({
      metadata: {
        name: 'system_info',
        description: 'Read a system metric',
        category: 'system',
        risk: 'read',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({ metric: z.string() }),
      execute: () => {
        executions += 1;
        return errAsync(appError('clock_unavailable', 'no clock'));
      },
      speak: () => 'It is five thirty-seven.',
    });

    const h = harness([{ content: "I couldn't read the clock." }], { tools: [failing] });
    await h.orchestrator.handleTurn('what time is it');

    expect(executions).toBe(1);
    expect(h.requests).toHaveLength(1);
    const messages = h.requests[0]?.messages ?? [];
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
  });
});

describe('execution verification', () => {
  const volumeWith = (verify: (() => AppResultAsync<boolean>) | null) =>
    defineTool({
      metadata: {
        name: 'set_volume',
        description: 'Set the output volume',
        category: 'system',
        risk: 'reversible',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({ level: z.number() }),
      execute: (args) => okAsync({ level: args.level }),
      ...(verify ? { verify: () => verify() } : {}),
    });

  it('marks a result confirmed when the state agrees', async () => {
    const h = harness([{ content: 'unused' }], { tools: [volumeWith(() => okAsync(true))] });
    await h.orchestrator.handleTurn('set volume to 40');

    const result = h.of('tool.completed').at(-1)?.result;
    expect(result?.status).toBe('ok');
    expect(result?.status === 'ok' && result.verification).toBe('confirmed');
  });

  /**
   * The case the PRD is really about: the tool returned success and the world
   * disagrees. Assistant must not report that as done.
   */
  it('marks a result contradicted when the state disagrees', async () => {
    const h = harness([{ content: 'unused' }], { tools: [volumeWith(() => okAsync(false))] });
    await h.orchestrator.handleTurn('set volume to 40');

    const result = h.of('tool.completed').at(-1)?.result;
    expect(result?.status === 'ok' && result.verification).toBe('contradicted');
  });

  it('stays unverified when a tool cannot check itself', async () => {
    const h = harness([{ content: 'unused' }], { tools: [volumeWith(null)] });
    await h.orchestrator.handleTurn('set volume to 40');

    // Honest, rather than absent or falsely confirmed.
    const result = h.of('tool.completed').at(-1)?.result;
    expect(result?.status === 'ok' && result.verification).toBe('unverified');
  });

  it('does not turn a failed check into a failed action', async () => {
    const flaky = volumeWith(null);
    const h = harness([{ content: 'unused' }], {
      tools: [
        defineTool({
          metadata: flaky.metadata,
          input: z.object({ level: z.number() }),
          execute: (args) => okAsync({ level: args.level }),
          verify: () => errAsync(appError('check_failed', 'could not read it back')),
        }),
      ],
    });
    await h.orchestrator.handleTurn('set volume to 40');

    const result = h.of('tool.completed').at(-1)?.result;
    expect(result?.status).toBe('ok');
    expect(result?.status === 'ok' && result.verification).toBe('unverified');
  });
});

describe('multi-step execution', () => {
  const tool = (name: string, execute: () => AppResultAsync<unknown>) =>
    defineTool({
      metadata: {
        name,
        description: `The ${name} tool used in planning tests.`,
        category: 'system',
        risk: 'read',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({}),
      execute,
    });

  const twoCalls = [
    { function: { name: 'first_tool', arguments: {} } },
    { function: { name: 'second_tool', arguments: {} } },
  ];

  it('runs every call the model asked for, in order', async () => {
    const ran: string[] = [];
    const h = harness([{ content: '', toolCalls: twoCalls }, { content: 'Both done.' }], {
      tools: [
        tool('first_tool', () => {
          ran.push('first');
          return okAsync({ ok: true });
        }),
        tool('second_tool', () => {
          ran.push('second');
          return okAsync({ ok: true });
        }),
      ],
    });

    await h.orchestrator.handleTurn('do two things');

    expect(ran).toEqual(['first', 'second']);
    expect(h.of('tool.completed')).toHaveLength(2);
  });

  /**
   * Each result must line up with the message naming its tool. Reordering here
   * would tell the model the wrong tool produced the wrong outcome, which is a
   * quietly terrible bug.
   */
  it('reports each result against the tool that produced it', async () => {
    const h = harness([{ content: '', toolCalls: twoCalls }, { content: 'Done.' }], {
      tools: [
        tool('first_tool', () => okAsync({ which: 'first' })),
        tool('second_tool', () => okAsync({ which: 'second' })),
      ],
    });

    await h.orchestrator.handleTurn('do two things');

    const toolMessages = (h.requests[1]?.messages ?? []).filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain('first');
    expect(toolMessages[1]?.content).toContain('second');
  });

  it('keeps going when one of several calls fails', async () => {
    const h = harness([{ content: '', toolCalls: twoCalls }, { content: 'One worked.' }], {
      tools: [
        tool('first_tool', () => errAsync(appError('broke', 'it broke'))),
        tool('second_tool', () => okAsync({ which: 'second' })),
      ],
    });

    await h.orchestrator.handleTurn('do two things');

    // Independent steps: one failing must not skip the other.
    expect(h.of('tool.completed')).toHaveLength(2);
    expect(h.of('tool.completed').map((e) => e.result.status)).toEqual(['error', 'ok']);
  });

  it('falls back to running in order when a call names an unknown tool', async () => {
    const h = harness(
      [
        {
          content: '',
          toolCalls: [
            { function: { name: 'first_tool', arguments: {} } },
            { function: { name: 'no_such_tool', arguments: {} } },
          ],
        },
        { content: 'Handled.' },
      ],
      { tools: [tool('first_tool', () => okAsync({ ok: true }))] },
    );

    await h.orchestrator.handleTurn('do two things');

    // The known tool still runs; the unknown one comes back as an error the
    // model can explain, rather than the whole turn refusing to act.
    expect(h.of('tool.completed')).toHaveLength(2);
  });
});

describe('clarification', () => {
  const ambiguous = (result: unknown) =>
    defineTool({
      metadata: {
        name: 'now_playing',
        description: 'Report what is playing right now.',
        category: 'media',
        risk: 'read',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({}),
      execute: () => okAsync(result),
      clarify: (r) => {
        const candidates = (r as { candidates?: string[] }).candidates;
        return candidates ? { question: 'Which one did you mean?', options: candidates } : null;
      },
      speak: () => 'Playing something.',
    });

  it('asks instead of guessing, and offers the options', async () => {
    const h = harness([{ content: 'unused' }], {
      tools: [ambiguous({ candidates: ['Rahul Sharma', 'Rahul Verma'] })],
    });

    await h.orchestrator.handleTurn("what's playing");

    // The model is never consulted: the tool already knows what is ambiguous.
    expect(h.requests).toHaveLength(0);
    expect(h.finished).toEqual(['Which one did you mean? Rahul Sharma, or Rahul Verma?']);
  });

  /**
   * The point of the round-trip: the answer must rejoin the original request,
   * not arrive as a fresh one. Re-asking "what did you want again?" is exactly
   * what the PRD's minimum-question rule forbids.
   */
  it('folds the answer back into the request it belongs to', async () => {
    const h = harness([{ content: 'unused' }, { content: 'Done.' }], {
      tools: [ambiguous({ candidates: ['Rahul Sharma', 'Rahul Verma'] })],
    });

    await h.orchestrator.handleTurn("what's playing");
    await h.orchestrator.handleTurn('the second one');

    const followUp = h.requests[0]?.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    expect(followUp).toContain("what's playing");
    expect(followUp).toContain('the second one');
    expect(followUp).toContain('Which one did you mean?');
  });

  it('does not ask again once the question is answered', async () => {
    const h = harness([{ content: 'unused' }, { content: 'Done.' }], {
      tools: [ambiguous({ candidates: ['a', 'b'] })],
    });

    await h.orchestrator.handleTurn("what's playing");
    await h.orchestrator.handleTurn('the first one');
    await h.orchestrator.handleTurn('thanks');

    // The third turn is an ordinary request again.
    const last =
      h.requests
        .at(-1)
        ?.messages.filter((m) => m.role === 'user')
        .at(-1)?.content ?? '';
    expect(last).toBe('thanks');
  });

  it('stays quiet when the result is unambiguous', async () => {
    const h = harness([{ content: 'unused' }], { tools: [ambiguous({ track: 'Yellow' })] });
    await h.orchestrator.handleTurn("what's playing");

    expect(h.finished).toEqual(['Playing something.']);
  });
});

describe('planning pass', () => {
  const step = (id: string, tool: string, dependsOn: string[] = []) => ({
    id,
    description: `do ${id}`,
    tool,
    arguments: {},
    dependsOn,
  });

  const planReply = (steps: unknown[]) =>
    `Here you go:\n\`\`\`json\n${JSON.stringify({ goal: 'two things', steps })}\n\`\`\``;

  const tool = (name: string, execute: () => AppResultAsync<unknown>) =>
    defineTool({
      metadata: {
        name,
        description: `The ${name} tool used in planning tests.`,
        category: 'system',
        risk: 'read',
        connector: 'internal',
        requiresNetwork: false,
      },
      input: z.object({}),
      execute,
    });

  const multiStep = 'open Safari and then set the volume to forty';

  it('does not plan when the planner is off', async () => {
    const h = harness([{ content: 'Done.' }], { tools: [tool('open_app', () => okAsync({}))] });
    await h.orchestrator.handleTurn(multiStep);

    // One ordinary model call, not a planning pass plus a call.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.messages.some((m) => m.content.includes('Reply with JSON only'))).toBe(
      false,
    );
  });

  it('runs the steps a plan describes, in order', async () => {
    const ran: string[] = [];
    const h = harness(
      [{ content: planReply([step('a', 'open_app'), step('b', 'set_volume', ['a'])]) }],
      {
        planner: true,
        tools: [
          tool('open_app', () => {
            ran.push('a');
            return okAsync({});
          }),
          tool('set_volume', () => {
            ran.push('b');
            return okAsync({});
          }),
        ],
      },
    );

    await h.orchestrator.handleTurn(multiStep);

    expect(ran).toEqual(['a', 'b']);
    expect(h.of('response.done').at(-1)?.message.content).toBe('Done.');
  });

  it('says what it is about to do before doing it', async () => {
    const h = harness([{ content: planReply([step('a', 'open_app')]) }], {
      planner: true,
      tools: [tool('open_app', () => okAsync({}))],
    });

    await h.orchestrator.handleTurn(multiStep);

    // Progressive updates, not silence followed by a verdict.
    expect(
      h
        .of('response.delta')
        .map((e) => e.delta)
        .join(' '),
    ).toContain('do a');
  });

  /**
   * The failure the whole planner exists to prevent: half a task reported as
   * a whole one.
   */
  it('never reports a partly-done task as done', async () => {
    const h = harness([{ content: planReply([step('a', 'open_app'), step('b', 'set_volume')]) }], {
      planner: true,
      tools: [
        tool('open_app', () => okAsync({})),
        tool('set_volume', () => errAsync(appError('broke', 'it broke'))),
      ],
    });

    await h.orchestrator.handleTurn(multiStep);

    const said = h.of('response.done').at(-1)?.message.content ?? '';
    expect(said).toContain('part of the way');
    expect(said).not.toBe('Done.');
  });

  it('falls back to the ordinary loop when the plan will not parse', async () => {
    const h = harness([{ content: 'I would rather just chat about it' }, { content: 'Fine.' }], {
      planner: true,
      tools: [tool('open_app', () => okAsync({}))],
    });

    await h.orchestrator.handleTurn(multiStep);

    // Planning pass, then the normal path — the request is not abandoned.
    expect(h.requests.length).toBeGreaterThanOrEqual(2);
    expect(h.of('response.done')).toHaveLength(1);
  });
});

/**
 * Platform authentication.
 *
 * The approval card is drawn by the process asking for permission, which is
 * exactly why the PRD's `critical` tier asks for something else on top. These
 * tests pin the part that matters: approving is not enough on its own, and a
 * Mac that cannot ask is a refusal rather than a free pass.
 */
describe('strong confirmation', () => {
  const guarded = defineTool({
    metadata: {
      name: 'guarded_tool',
      description: 'A tool the user has pinned behind Touch ID, for testing.',
      category: 'system',
      risk: 'reversible',
      connector: 'internal',
    },
    input: z.object({}),
    execute: () => okAsync({ ran: true }),
  });

  const call = {
    content: '',
    toolCalls: [{ function: { name: 'guarded_tool', arguments: {} } }],
  };

  const approveEverything = (h: ReturnType<typeof harness>) => {
    h.eventsEmitter.on((event) => {
      if (event.type === 'tool.proposed' && event.needsConfirmation) {
        setTimeout(() => h.orchestrator.resolveDecision(event.callId, true), 0);
      }
    });
  };

  it('asks the operating system as well, and runs when it agrees', async () => {
    const asked: string[] = [];
    const authenticate: Authenticator = (reason) => {
      asked.push(reason);
      return Promise.resolve({ status: 'authorised' as const });
    };
    const h = harness([call, { deltas: ['Done.'], content: 'Done.' }], {
      tools: [guarded],
      settings: { strongAuthTools: ['guarded_tool'] },
      authenticate,
    });
    approveEverything(h);

    await h.orchestrator.handleTurn('do the guarded thing');

    expect(asked).toHaveLength(1);
    expect(h.of('tool.proposed')[0]?.strength).toBe('strong');
    expect(h.of('tool.completed')[0]?.result.status).toBe('ok');
  });

  it('does not run it when the fingerprint is refused', async () => {
    const h = harness([call, { deltas: ['Not done.'], content: 'Not done.' }], {
      tools: [guarded],
      settings: { strongAuthTools: ['guarded_tool'] },
      authenticate: () => Promise.resolve({ status: 'denied' as const, message: 'cancelled' }),
    });
    approveEverything(h);

    await h.orchestrator.handleTurn('do the guarded thing');

    const result = h.of('tool.completed')[0]?.result;
    expect(result?.status).toBe('denied');
    if (result?.status === 'denied') expect(result.reason).toBe('authentication_failed');
  });

  /**
   * A Mac with no Touch ID and no password policy cannot answer the question.
   * Treating that as "well, they clicked yes" would quietly remove the
   * guarantee the tier exists for.
   */
  it('refuses when the Mac cannot ask at all', async () => {
    const h = harness([call, { deltas: ['Not done.'], content: 'Not done.' }], {
      tools: [guarded],
      settings: { strongAuthTools: ['guarded_tool'] },
      authenticate: () =>
        Promise.resolve({ status: 'unavailable' as const, message: 'no biometrics' }),
    });
    approveEverything(h);

    await h.orchestrator.handleTurn('do the guarded thing');

    const result = h.of('tool.completed')[0]?.result;
    expect(result?.status).toBe('denied');
  });

  it('never asks for a fingerprint for an ordinary action', async () => {
    let asked = 0;
    const h = harness([call, { deltas: ['Done.'], content: 'Done.' }], {
      tools: [guarded],
      authenticate: () => {
        asked += 1;
        return Promise.resolve({ status: 'authorised' as const });
      },
    });

    await h.orchestrator.handleTurn('do the ordinary thing');

    expect(asked).toBe(0);
    expect(h.of('tool.proposed')[0]?.strength).toBe('normal');
  });
});

/**
 * Task continuation.
 *
 * A plan that dies with the process is exactly the one worth remembering, so
 * the row is written before the plan runs rather than after it. These tests
 * pin that ordering and the rule that bookkeeping never costs the turn.
 */
describe('remembering a multi-step task', () => {
  const step = (name: string) => ({ function: { name, arguments: {} } });

  const twoTools = [
    defineTool({
      metadata: {
        name: 'first_step',
        description: 'The first step of a plan, for testing task recording.',
        category: 'system',
        risk: 'read',
        connector: 'internal',
      },
      input: z.object({}),
      execute: () => okAsync({ done: true }),
    }),
    defineTool({
      metadata: {
        name: 'second_step',
        description: 'The second step of a plan, for testing task recording.',
        category: 'system',
        risk: 'read',
        connector: 'internal',
      },
      input: z.object({}),
      execute: () => okAsync({ done: true }),
    }),
  ] as const;

  function taskHarness(store: TaskStore | null) {
    return harness(
      [
        { content: '', toolCalls: [step('first_step'), step('second_step')] },
        { deltas: ['Done.'], content: 'Done.' },
      ],
      { tools: [...twoTools], tasks: store },
    );
  }

  it('records the goal before running, and how it ended after', async () => {
    const events: string[] = [];
    const store: TaskStore = {
      start: (goal) => {
        events.push(`start:${goal}`);
        return Promise.resolve('t-1');
      },
      finish: (_id, status) => {
        events.push(`finish:${status}`);
        return Promise.resolve();
      },
      unfinished: () => Promise.resolve([]),
      close: () => Promise.resolve(true),
    };

    await taskHarness(store).orchestrator.handleTurn('do both things');

    expect(events[0]).toMatch(/^start:/);
    expect(events.at(-1)).toBe('finish:completed');
  });

  /**
   * The store is an enhancement. A database that will not answer must cost the
   * user their task history, never their task.
   */
  it('still runs the plan when the store is broken', async () => {
    const broken: TaskStore = {
      start: () => Promise.reject(new Error('no database')),
      finish: () => Promise.reject(new Error('no database')),
      unfinished: () => Promise.reject(new Error('no database')),
      close: () => Promise.reject(new Error('no database')),
    };

    const h = taskHarness(broken);
    await h.orchestrator.handleTurn('do both things');

    expect(h.of('tool.completed')).toHaveLength(2);
  });

  it('tells the model about an unfinished task without telling it to resume', async () => {
    const store: TaskStore = {
      start: () => Promise.resolve('t-1'),
      finish: () => Promise.resolve(),
      unfinished: () =>
        Promise.resolve([
          { id: 't-0', goal: 'move the holiday photos', status: 'partial', summary: null },
        ]),
      close: () => Promise.resolve(true),
    };

    const h = harness([{ deltas: ['Sure.'], content: 'Sure.' }], { tasks: store });
    await h.orchestrator.handleTurn('hello');

    const sent = h.requests[0]?.messages ?? [];
    const system = sent[0]?.content ?? '';
    // The first user message, not the last entry: the orchestrator keeps
    // appending to this array as the turn goes on.
    const user = sent.find((m) => m.role === 'user')?.content ?? '';

    // On the user's message, not in the system prompt: anything that varies
    // per turn inside that block invalidates Ollama's prefix cache, which was
    // measured at 12s of re-read on this machine.
    expect(user).toContain('move the holiday photos');
    expect(system).not.toContain('move the holiday photos');
    // Context, not an instruction: an unfinished task is not permission to
    // pick it up again unasked.
    expect(user).toMatch(/Do NOT start any of these again/i);
  });
});

/**
 * The states the PRD asks the interface to distinguish.
 *
 * Two of them used to be invisible: a turn waiting on a consent card looked
 * exactly like a turn doing work, and a finished turn went straight back to
 * idle with no sign anything had happened.
 */
describe('what the interface is told', () => {
  const gated = defineTool({
    metadata: {
      name: 'gated_tool',
      description: 'A tool that always asks, for testing the waiting state.',
      category: 'system',
      risk: 'destructive',
      connector: 'internal',
    },
    input: z.object({}),
    execute: () => okAsync({ done: true }),
  });

  it('says it is waiting on the user, not working', async () => {
    const h = harness(
      [
        { content: '', toolCalls: [{ function: { name: 'gated_tool', arguments: {} } }] },
        { deltas: ['Done.'], content: 'Done.' },
      ],
      { tools: [gated] },
    );
    h.eventsEmitter.on((event) => {
      if (event.type === 'tool.proposed' && event.needsConfirmation) {
        setTimeout(() => h.orchestrator.resolveDecision(event.callId, true), 0);
      }
    });

    await h.orchestrator.handleTurn('do the gated thing');

    const states = h.of('state.changed').map((e) => e.state);
    expect(states).toContain('awaiting_approval');
    // And it goes back to working once the person has answered, rather than
    // leaving the card's state on screen for the rest of the turn.
    expect(states.indexOf('awaiting_approval')).toBeLessThan(states.lastIndexOf('acting'));
  });

  it('ends a good turn on success and a bad one on failure', async () => {
    const good = harness([{ deltas: ['Hello.'], content: 'Hello.' }]);
    await good.orchestrator.handleTurn('hello');
    expect(good.of('state.changed').at(-1)?.state).toBe('success');

    const bad = harness([{ content: '', fail: true }]);
    await bad.orchestrator.handleTurn('hello');
    expect(bad.of('state.changed').at(-1)?.state).toBe('failure');
  });

  /**
   * The decay lives in the brain rather than the UI, so the interface stays a
   * projection of what the brain says is happening. This is the test that
   * stops it becoming a state the UI is left stuck in.
   */
  it('returns to idle a moment later', async () => {
    // The real delay is 1.8s, which is a long time to make a test suite wait
    // for one assertion; the value is injected rather than the clock faked,
    // because the turn itself schedules real timers to synthesise speech.
    const h = harness([{ deltas: ['Hello.'], content: 'Hello.' }], { settleMs: 10 });
    await h.orchestrator.handleTurn('hello');
    expect(h.of('state.changed').at(-1)?.state).toBe('success');

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.of('state.changed').at(-1)?.state).toBe('idle');
  });
});

/**
 * The bug that only showed up out loud.
 *
 * "Open Spotify and play the last song" called `open_app`, whose renderer says
 * "Opened Spotify." — and the turn ended there. The second half of the request
 * was dropped, and the user was told something that sounded like success.
 * Found on 2026-09-03 by speaking to it, not by any test.
 */
describe('a request with two parts in it', () => {
  const opener = defineTool({
    metadata: {
      name: 'open_app',
      description: 'Open an application, for testing the speakable short-circuit.',
      category: 'system',
      risk: 'reversible',
      connector: 'internal',
    },
    input: z.object({ appName: z.string() }),
    execute: (args) => okAsync({ opened: args.appName }),
    speak: (result) => `Opened ${(result as { opened: string }).opened}.`,
  });

  const call = [{ function: { name: 'open_app', arguments: { appName: 'Spotify' } } }];

  it('does not let a tool renderer end a turn half-done', async () => {
    const h = harness(
      [
        { content: '', toolCalls: call },
        { deltas: ['Playing it now.'], content: 'Playing it now.' },
      ],
      { tools: [opener] },
    );

    await h.orchestrator.handleTurn('open spotify and play the last song');

    // The model must be asked again, so it can do the second half.
    expect(h.requests).toHaveLength(2);
    expect(h.of('response.done').at(-1)?.message.content).toBe('Playing it now.');
  });

  /** The optimisation still applies to everything it was built for. */
  it('still ends a single-part request without a second call', async () => {
    const h = harness([{ content: '', toolCalls: call }, { content: 'unused' }], {
      tools: [opener],
    });

    // Phrased so the deterministic fast path does not match it — "open
    // spotify" now routes with no model call at all, which would prove
    // something else.
    await h.orchestrator.handleTurn('open spotify for me');

    expect(h.requests).toHaveLength(1);
    expect(h.of('response.done').at(-1)?.message.content).toBe('Opened Spotify.');
  });
});

/**
 * Reading the names back when there is more than one match.
 *
 * The clarification hook ran only on the fast path, so "message Tilak" — which
 * the model routes, not the matcher — found two contacts called Tilak and
 * threw the structured question away. The model then improvised, usually
 * asking for a phone number it had no way to want. Reported on 2026-09-03:
 * the names are right there.
 */
describe('when more than one contact matches', () => {
  const messenger = defineTool({
    metadata: {
      name: 'whatsapp_message',
      description: 'Message someone, for testing the clarification path.',
      category: 'communication',
      risk: 'read',
      connector: 'internal',
    },
    input: z.object({ contactName: z.string(), message: z.string() }),
    execute: () =>
      okAsync({ opened: false, reason: 'ambiguous', candidates: ["Tilak's Dad", 'Tilak CSM'] }),
    clarify: (result) => {
      const r = result as { reason?: string; candidates?: string[] };
      return r.reason === 'ambiguous'
        ? { question: 'Which one did you mean?', options: r.candidates ?? [] }
        : null;
    },
  });

  const call = [
    { function: { name: 'whatsapp_message', arguments: { contactName: 'Tilak', message: 'hi' } } },
  ];

  it('reads the names out instead of asking for a phone number', async () => {
    const h = harness([{ content: '', toolCalls: call }, { content: 'unused' }], {
      tools: [messenger],
    });

    await h.orchestrator.handleTurn('message tilak on whatsapp saying come to me once');

    const said = h.of('response.done').at(-1)?.message.content ?? '';
    expect(said).toContain("Tilak's Dad");
    expect(said).toContain('Tilak CSM');
    expect(said).toMatch(/which one/i);
    // And it does not go back to the model to improvise something else.
    expect(h.requests).toHaveLength(1);
  });

  /**
   * The answer folds back into the original request, so saying "the second
   * one" does not start a new turn about nothing.
   */
  it('treats the next thing said as the answer to that question', async () => {
    const h = harness(
      [
        { content: '', toolCalls: call },
        { deltas: ['Sent.'], content: 'Sent.' },
      ],
      { tools: [messenger] },
    );

    await h.orchestrator.handleTurn('message tilak on whatsapp saying come to me once');
    await h.orchestrator.handleTurn('Tilak CSM');

    const followUp =
      h.requests
        .at(-1)
        ?.messages.map((m) => m.content)
        .join(' ') ?? '';
    expect(followUp).toContain('come to me once');
    expect(followUp).toContain('Tilak CSM');
  });
});

/**
 * The speech path used to be a single `first_audio` mark sitting a second or
 * more after the model finished, with nothing in between. Measured directly,
 * the services accounted for 2,728 ms; the turn logged 3,726 ms for the same
 * reply, and the missing second could have been the queue, the network, the
 * voice conversion or the base64 round trip — the trace could not say which.
 * These assert the stages exist and are ordered, so the gap is attributable
 * before anyone optimises against it.
 */
describe('speech tracing', () => {
  it('attributes every stage between queueing a clip and publishing it', async () => {
    const h = harness([
      { deltas: ['This is a whole sentence.'], content: 'This is a whole sentence.' },
    ]);

    await h.orchestrator.handleTurn('say something');

    const stages = h.traces.at(-1) ?? {};
    for (const name of [
      'speech_queued',
      'speech_dequeued',
      'tts_start',
      'tts_end',
      'speech_stored',
      'first_audio',
    ]) {
      expect(Object.keys(stages)).toContain(name);
    }
    // Monotonic, because a stage that appears to finish before it started
    // makes every number in the line untrustworthy.
    const order = [
      'speech_queued',
      'speech_dequeued',
      'tts_start',
      'tts_end',
      'speech_stored',
      'first_audio',
    ];
    const times = order.map((n) => stages[n]?.at ?? -1);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  /**
   * The wait behind another clip is the one cost no other mark could show, and
   * from outside it looks exactly like a slow Sarvam call.
   */
  it('shows time spent waiting behind an earlier clip', async () => {
    const first = 'This first sentence is deliberately long.';
    const second = 'This one comes after it.';
    const h = harness([{ deltas: [`${first} `, `${second} `], content: `${first} ${second}` }], {
      ttsDelays: { [first]: 40 },
    });

    await h.orchestrator.handleTurn('say two things');

    const stages = h.traces.at(-1) ?? {};
    // Clip 0 never waits, so its own queue gap is ~0 — the point is that the
    // gap is now recorded at all, for the turns where it is not.
    expect(stages.speech_dequeued).toBeDefined();
    expect(stages.speech_dequeued?.delta).toBeGreaterThanOrEqual(0);
  });

  /**
   * Only the clip the user is waiting on is traced. Tracing the rest would add
   * `tts_start_2`, `tts_start_3` and so on to a line that is meant to answer
   * one question — how long until they heard something.
   */
  it('traces only the first clip', async () => {
    const first = 'This first sentence is deliberately long.';
    const second = 'This one comes after it.';
    const h = harness([{ deltas: [`${first} `, `${second} `], content: `${first} ${second}` }]);

    await h.orchestrator.handleTurn('say two things');

    const stages = h.traces.at(-1) ?? {};
    expect(Object.keys(stages).filter((k) => k.startsWith('tts_start'))).toEqual(['tts_start']);
  });
});
