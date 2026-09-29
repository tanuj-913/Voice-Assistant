import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { Plan, PlanStep, ToolCallId, type ToolResult } from '@assistant/schemas';
import { runPlan, validatePlan } from './planner.js';

/**
 * The failure this whole file guards against is "Assistant did half a thing and
 * said it was finished". Every test here is about the plan being honest —
 * about what ran, what did not, and what ran without taking effect.
 */

let counter = 0;
const id = () => ToolCallId.parse(`00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`);

const ok = (
  result: unknown = {},
  verification: 'confirmed' | 'contradicted' | 'unverified' = 'unverified',
): ToolResult => ({ status: 'ok', id: id(), name: 't', result, durationMs: 1, verification });

const fail = (): ToolResult => ({
  status: 'error',
  id: id(),
  name: 't',
  error: { code: 'boom', message: 'it broke', retryable: true },
  durationMs: 1,
});

const denied = (): ToolResult => ({
  status: 'denied',
  id: id(),
  name: 't',
  reason: 'user_declined',
});

const step = (over: Partial<z.input<typeof PlanStep>> & { id: string }) =>
  PlanStep.parse({ description: 'a step', tool: 'set_volume', ...over });

const plan = (...steps: ReturnType<typeof step>[]) => Plan.parse({ goal: 'do the thing', steps });

describe('ordering and dependencies', () => {
  it('runs steps in dependency order, not declaration order', async () => {
    const order: string[] = [];
    const p = plan(step({ id: 'second', dependsOn: ['first'] }), step({ id: 'first' }));

    const run = await runPlan(p, {
      run: (s) => {
        order.push(s.id);
        return Promise.resolve(ok());
      },
    });

    expect(order).toEqual(['first', 'second']);
    expect(run.outcome).toBe('completed');
  });

  /**
   * The important one. Acting on a result that does not exist is worse than
   * doing nothing, so a dependent of a failed step must never be attempted.
   */
  it('skips a step whose dependency failed, rather than running it anyway', async () => {
    const attempted: string[] = [];
    const p = plan(step({ id: 'lookup' }), step({ id: 'send', dependsOn: ['lookup'] }));

    const run = await runPlan(p, {
      run: (s) => {
        attempted.push(s.id);
        return Promise.resolve(s.id === 'lookup' ? fail() : ok());
      },
    });

    expect(attempted).toEqual(['lookup']);
    expect(run.steps.find((s) => s.id === 'send')?.status).toBe('skipped');
    expect(run.outcome).toBe('failed');
    expect(run.summary).toContain('skipped');
  });

  it('reports partial rather than complete when some steps did not run', async () => {
    const p = plan(step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c', dependsOn: ['b'] }));
    const run = await runPlan(p, {
      run: (s) => Promise.resolve(s.id === 'b' ? fail() : ok()),
    });

    expect(run.outcome).toBe('partial');
    expect(run.summary).toBe('1 done, 1 failed, 1 skipped');
  });
});

describe('retries', () => {
  it('retries a step the plan marked safe to repeat', async () => {
    let attempts = 0;
    const p = plan(step({ id: 'flaky', retryable: true }));
    const run = await runPlan(p, {
      run: () => {
        attempts += 1;
        return Promise.resolve(attempts === 1 ? fail() : ok());
      },
    });

    expect(attempts).toBe(2);
    expect(run.outcome).toBe('completed');
  });

  /**
   * Retrying "send the message" because the first attempt timed out can send
   * it twice, so retryable is opt-in and defaults to false.
   */
  it('does not retry by default', async () => {
    let attempts = 0;
    const run = await runPlan(plan(step({ id: 'send' })), {
      run: () => {
        attempts += 1;
        return Promise.resolve(fail());
      },
    });

    expect(attempts).toBe(1);
    expect(run.outcome).toBe('failed');
  });

  it('never retries something the user declined', async () => {
    let attempts = 0;
    const run = await runPlan(plan(step({ id: 'send', retryable: true })), {
      run: () => {
        attempts += 1;
        return Promise.resolve(denied());
      },
    });

    // Asking again by looping is not a retry.
    expect(attempts).toBe(1);
    expect(run.outcome).toBe('failed');
  });
});

describe('honesty about the result', () => {
  it('surfaces a step that ran but did not take effect', async () => {
    const run = await runPlan(plan(step({ id: 'volume' })), {
      run: () => Promise.resolve(ok({ level: 40 }, 'contradicted')),
    });

    // The tool succeeded, so the step is done — but the summary must not let
    // that pass as "it worked".
    expect(run.steps[0]?.status).toBe('done');
    expect(run.summary).toContain('did not take effect');
  });

  it('carries verification through from the tool result', async () => {
    const run = await runPlan(plan(step({ id: 'volume' })), {
      run: () => Promise.resolve(ok({}, 'confirmed')),
    });
    expect(run.steps[0]?.verification).toBe('confirmed');
  });

  it('reports progress as each step starts', async () => {
    const onStep = vi.fn();
    await runPlan(plan(step({ id: 'a' }), step({ id: 'b', dependsOn: ['a'] })), {
      run: () => Promise.resolve(ok()),
      onStep,
    });
    expect(onStep).toHaveBeenCalledTimes(2);
  });

  it('stops between steps when cancelled', async () => {
    const controller = new AbortController();
    let ran = 0;
    const run = await runPlan(plan(step({ id: 'a' }), step({ id: 'b', dependsOn: ['a'] })), {
      run: () => {
        ran += 1;
        controller.abort();
        return Promise.resolve(ok());
      },
      signal: controller.signal,
    });

    expect(ran).toBe(1);
    expect(run.steps.find((s) => s.id === 'b')?.status).toBe('skipped');
  });
});

describe('validatePlan', () => {
  const known = (name: string) => ['set_volume', 'send_message'].includes(name);

  it('accepts a well-formed plan', () => {
    const p = plan(step({ id: 'a' }), step({ id: 'b', dependsOn: ['a'] }));
    expect(validatePlan(p, known)).toEqual({ ok: true });
  });

  it('rejects a step referring to a tool that does not exist', () => {
    const p = plan(step({ id: 'a', tool: 'teleport' }));
    const result = validatePlan(p, known);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem).toContain('teleport');
  });

  /**
   * A model can refer to a step it never wrote. Left alone this is a silent
   * no-op, which reads as Assistant ignoring the request.
   */
  it('rejects a dependency on a step that was never written', () => {
    const p = plan(step({ id: 'b', dependsOn: ['ghost'] }));
    const result = validatePlan(p, known);
    expect(!result.ok && result.problem).toContain('ghost');
  });

  it('rejects steps that wait on each other', () => {
    const p = plan(step({ id: 'a', dependsOn: ['b'] }), step({ id: 'b', dependsOn: ['a'] }));
    const result = validatePlan(p, known);
    expect(!result.ok && result.problem).toContain('depend on each other');
  });

  it('rejects duplicate step ids', () => {
    const p = plan(step({ id: 'a' }), step({ id: 'a' }));
    const result = validatePlan(p, known);
    expect(!result.ok && result.problem).toContain('duplicate');
  });
});
