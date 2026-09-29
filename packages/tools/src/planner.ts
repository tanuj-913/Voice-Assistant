import type { Plan, PlanOutcome, PlanStep, PlanStepId, ToolResult } from '@assistant/schemas';

/**
 * Runs a plan.
 *
 * The model writes the plan; this decides what actually happens. Ordering,
 * dependency satisfaction, whether a failure stops dependents, what counts as
 * done — all of it is code, for the same reason the policy engine is: the
 * component that proposes an action must not be the one that permits it.
 *
 * Deliberately not a graph library. Twenty steps at most, dependencies by id,
 * repeated passes until nothing more can run. Legible beats clever when the
 * failure mode is "Assistant did half a thing and said it was finished".
 */

export interface StepExecution {
  /** Runs one step. Never throws — a rejected tool comes back as a ToolResult. */
  run: (step: PlanStep) => Promise<ToolResult>;
  /** Called as each step starts, for progress updates the PRD asks for. */
  onStep?: (step: PlanStep) => void;
  /** Cancels between steps; a plan must not keep working after an interruption. */
  signal?: AbortSignal;
  /** Attempts allowed for steps marked retryable. */
  maxAttempts?: number;
}

export interface PlanRun {
  outcome: PlanOutcome;
  steps: PlanStep[];
  /** Human-readable, honest about anything not finished. */
  summary: string;
}

/** A step is ready when every dependency finished successfully. */
function ready(step: PlanStep, byId: Map<string, PlanStep>): boolean {
  if (step.status !== 'pending') return false;
  return step.dependsOn.every((id) => byId.get(id)?.status === 'done');
}

/** Unrunnable because something it needed did not happen. */
function doomed(step: PlanStep, byId: Map<string, PlanStep>): boolean {
  return step.dependsOn.some((id) => {
    const dep = byId.get(id);
    // A missing dependency is as fatal as a failed one, and more suspicious:
    // the model referred to a step it never wrote.
    return dep === undefined || dep.status === 'failed' || dep.status === 'skipped';
  });
}

function describe(steps: PlanStep[]): string {
  const done = steps.filter((s) => s.status === 'done');
  const failed = steps.filter((s) => s.status === 'failed');
  const skipped = steps.filter((s) => s.status === 'skipped');
  const unconfirmed = done.filter((s) => s.verification === 'contradicted');

  const parts: string[] = [];
  if (done.length > 0) parts.push(`${String(done.length)} done`);
  if (failed.length > 0) parts.push(`${String(failed.length)} failed`);
  if (skipped.length > 0) parts.push(`${String(skipped.length)} skipped`);
  // Surfaced separately: a step that ran but did not take effect is not done,
  // whatever the tool returned.
  if (unconfirmed.length > 0) parts.push(`${String(unconfirmed.length)} did not take effect`);
  return parts.join(', ') || 'nothing to do';
}

export async function runPlan(plan: Plan, exec: StepExecution): Promise<PlanRun> {
  const maxAttempts = exec.maxAttempts ?? 2;
  const steps: PlanStep[] = plan.steps.map((s) => ({ ...s }));
  const byId = new Map<string, PlanStep>(steps.map((s) => [s.id, s]));

  for (;;) {
    if (exec.signal?.aborted) break;

    // Mark everything downstream of a failure before looking for work, so a
    // doomed step is never started just because its turn came up first.
    for (const step of steps) {
      if (step.status === 'pending' && doomed(step, byId)) step.status = 'skipped';
    }

    const next = steps.find((s) => ready(s, byId));
    if (!next) break;

    next.status = 'running';
    exec.onStep?.(next);

    let result: ToolResult | null = null;
    while (next.attempts < maxAttempts) {
      next.attempts += 1;
      result = await exec.run(next);
      if (result.status === 'ok') break;
      // Only retry what the plan declared safe to repeat, and never a refusal
      // — the user said no, and asking again by looping is not a retry.
      if (!next.retryable || result.status === 'denied') break;
    }

    if (result?.status === 'ok') {
      next.status = 'done';
      next.result = result.result;
      next.verification = result.verification;
    } else {
      next.status = 'failed';
      if (result?.status === 'error') next.error = result.error;
    }
  }

  // Anything still pending when the loop ends had a dependency that never
  // completed, or the run was cancelled.
  for (const step of steps) {
    if (step.status === 'pending' || step.status === 'running') step.status = 'skipped';
  }

  const failed = steps.filter((s) => s.status === 'failed').length;
  const done = steps.filter((s) => s.status === 'done').length;
  const outcome: PlanOutcome =
    failed === 0 && done === steps.length ? 'completed' : done === 0 ? 'failed' : 'partial';

  return { outcome, steps, summary: describe(steps) };
}

/**
 * Structural checks a plan must pass before anything runs.
 *
 * A model can produce a plan that refers to a step it never wrote, or two
 * steps that wait on each other. Both would otherwise surface as a silent
 * no-op, which reads to the user as Assistant ignoring them.
 */
export function validatePlan(
  plan: Plan,
  knownTool: (name: string) => boolean,
): { ok: true } | { ok: false; problem: string } {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) return { ok: false, problem: `duplicate step id "${step.id}"` };
    ids.add(step.id);
  }

  for (const step of plan.steps) {
    if (!knownTool(step.tool)) {
      return { ok: false, problem: `step "${step.id}" uses unknown tool "${step.tool}"` };
    }
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        return { ok: false, problem: `step "${step.id}" depends on missing step "${dep}"` };
      }
    }
  }

  // Cycle detection: repeatedly remove steps whose dependencies are satisfied.
  const remaining = new Map<string, PlanStepId[]>(plan.steps.map((s) => [s.id, [...s.dependsOn]]));
  let removed = true;
  while (removed && remaining.size > 0) {
    removed = false;
    for (const [id, deps] of remaining) {
      if (deps.every((d) => !remaining.has(d))) {
        remaining.delete(id);
        removed = true;
      }
    }
  }
  if (remaining.size > 0) {
    return {
      ok: false,
      problem: `steps depend on each other: ${[...remaining.keys()].join(', ')}`,
    };
  }

  return { ok: true };
}
