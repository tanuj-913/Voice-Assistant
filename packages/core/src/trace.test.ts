import { describe, expect, it } from 'vitest';
import { Trace } from './trace.js';

/**
 * The PRD asks for every stage instrumented: audio end, transcript, route,
 * plan, tool start, tool finish, first audio. These tests pin the shape that
 * makes such a log readable — deltas between stages, cumulative time to each,
 * and repeated stages kept rather than overwritten.
 */
describe('Trace', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('reports each stage with its own elapsed time', async () => {
    const trace = new Trace('turn-1');
    await wait(20);
    trace.mark('transcribed');
    await wait(20);
    trace.mark('first_audio');

    const spans = trace.spans();
    expect(Object.keys(spans)).toEqual(['transcribed', 'first_audio']);
    const transcribed = spans.transcribed;
    const firstAudio = spans.first_audio;
    expect(transcribed).toBeDefined();
    expect(firstAudio).toBeDefined();
    // Cumulative time grows; the per-stage delta does not.
    expect(firstAudio?.at).toBeGreaterThan(transcribed?.at ?? 0);
    expect(firstAudio?.delta).toBeLessThan(firstAudio?.at ?? 0);
  });

  it('keeps both passes when a stage repeats', () => {
    const trace = new Trace('turn-2');
    trace.mark('model_call');
    trace.mark('tool_finish');
    trace.mark('model_call');

    // A tool-using turn calls the model twice; overwriting would hide half
    // the latency, which is the exact thing this is for.
    expect(Object.keys(trace.spans())).toEqual(['model_call', 'tool_finish', 'model_call_2']);
  });

  it('answers when a specific stage happened', async () => {
    const trace = new Trace('turn-3');
    await wait(15);
    trace.mark('first_audio');

    expect(trace.at('first_audio')).toBeGreaterThanOrEqual(10);
    expect(trace.at('never_happened')).toBeNull();
  });

  it('summarises a turn in one loggable object', () => {
    const trace = new Trace('turn-4');
    trace.mark('routed');
    const summary = trace.summary();

    expect(summary.turn).toBe('turn-4');
    expect(summary.totalMs).toBeGreaterThanOrEqual(0);
    expect(summary.stages).toHaveProperty('routed');
  });

  it('is empty rather than broken when nothing was marked', () => {
    expect(new Trace('turn-5').spans()).toEqual({});
  });
});
