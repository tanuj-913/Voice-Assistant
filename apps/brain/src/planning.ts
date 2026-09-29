import { Plan, type PlanStep } from '@assistant/schemas';

/**
 * Asking the model for a plan, and reading one back safely.
 *
 * The model is good at deciding *what* should happen and unreliable at
 * carrying it out in order. So it is asked for a structure, and the structure
 * is executed by `runPlan`, which cannot be argued with. Everything here is
 * about the boundary between those two: a prompt that describes the shape, and
 * a parser that refuses anything not matching it.
 */

/**
 * Plans are only worth their cost when the work has parts that depend on each
 * other. A single lookup should never take this path — it would pay a long
 * generation to describe one step.
 */
export function buildPlannerPrompt(opts: { toolNames: readonly string[]; goal: string }): string {
  return [
    'You are planning a multi-step task. Reply with JSON only — no prose, no code fence.',
    '',
    'Shape:',
    '{"goal":"<restate the request>","steps":[{"id":"<short_id>","description":"<what this achieves, in the user\'s terms>","tool":"<tool name>","arguments":{},"dependsOn":["<id>"],"retryable":false}]}',
    '',
    'Rules:',
    `- Use only these tools: ${opts.toolNames.join(', ')}.`,
    '- Every id in dependsOn must be the id of another step in this plan.',
    '- Steps with no dependsOn may run in any order, so only add a dependency where one step genuinely needs another’s result.',
    '- Set retryable true only when running the step twice is harmless. Sending a message twice is not harmless.',
    '- Describe each step for the user, not for yourself: "find Rahul\'s number", not "call the contacts tool".',
    '- At most 20 steps. Prefer the fewest that actually do the job.',
    '',
    `Request: ${opts.goal}`,
  ].join('\n');
}

/**
 * Extracts the first JSON object in the text and validates it as a `Plan`.
 *
 * Models wrap JSON in fences and preambles despite being asked not to, so the
 * object is located rather than assumed to be the whole reply. Anything that
 * does not validate is rejected outright — a half-understood plan is more
 * dangerous than none, because it would run.
 */
export function parsePlan(text: string): { ok: true; plan: Plan } | { ok: false; problem: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, problem: 'no JSON object in the reply' };

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, problem: 'the JSON did not parse' };
  }

  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: parsed.error.issues[0]?.message ?? 'plan did not match the schema',
    };
  }
  return { ok: true, plan: parsed.data };
}

/**
 * A sentence describing what is about to happen, for the progress update the
 * PRD asks for. Deliberately the plan's own descriptions rather than tool
 * names — the user asked for an outcome, not a call stack.
 */
export function describePlan(steps: readonly PlanStep[]): string {
  if (steps.length === 0) return 'Nothing to do.';
  if (steps.length === 1) return `${steps[0]?.description ?? 'One step'}.`;
  return `${String(steps.length)} steps: ${steps.map((s) => s.description).join(', then ')}.`;
}
