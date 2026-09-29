import { z } from 'zod';
import { AppError } from './common.js';

/**
 * Multi-step task representation.
 *
 * A plan is data, not a conversation. The model proposes one; everything after
 * that — ordering, dependency checks, whether a step may run, what counts as
 * done — is decided by code that cannot be talked out of its rules. That
 * separation is the same reason the policy engine exists: proposing and
 * permitting must not be the same act.
 */

export const PlanStepId = z.string().min(1).max(64).brand<'PlanStepId'>();
export type PlanStepId = z.infer<typeof PlanStepId>;

export const PlanStepStatus = z.enum([
  /** Not started; may be waiting on a dependency. */
  'pending',
  /** Waiting on the user — either a confirmation or an answer. */
  'blocked',
  'running',
  'done',
  'failed',
  /** Never attempted, because something it depended on failed. */
  'skipped',
]);
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;

export const PlanStep = z.object({
  id: PlanStepId,
  /** What this step is for, in the user's terms — shown in progress updates. */
  description: z.string().min(1).max(300),
  tool: z.string().min(1),
  arguments: z.unknown().default({}),
  /**
   * Steps that must be `done` first. A step whose dependency failed is
   * `skipped`, never attempted — the alternative is acting on a result that
   * does not exist.
   */
  dependsOn: z.array(PlanStepId).default([]),
  status: PlanStepStatus.default('pending'),
  result: z.unknown().optional(),
  error: AppError.optional(),
  /**
   * Whether the action was independently confirmed. Mirrors `ToolResult` so a
   * finished plan can be reported honestly rather than optimistically.
   */
  verification: z.enum(['confirmed', 'contradicted', 'unverified']).default('unverified'),
  /** Attempts so far. Only steps declared retryable are ever retried. */
  attempts: z.number().int().nonnegative().default(0),
  /**
   * Safe to run again after a transient failure. False by default: retrying
   * "send the message" because the first attempt timed out can send it twice.
   */
  retryable: z.boolean().default(false),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  /** The request this plan serves, kept so clarifications do not lose it. */
  goal: z.string().min(1).max(1000),
  steps: z.array(PlanStep).min(1).max(20),
});
export type Plan = z.infer<typeof Plan>;

/**
 * A question Assistant must ask before it can continue.
 *
 * The PRD asks for "only the minimum required question" with context
 * preserved, so this carries the step it blocks rather than restarting the
 * task from the beginning.
 */
export const Clarification = z.object({
  question: z.string().min(1).max(300),
  /** The step that cannot proceed until this is answered. */
  blocking: PlanStepId,
  /** Offered answers, when the choice is closed — e.g. which Rahul. */
  options: z.array(z.string().min(1).max(120)).max(6).default([]),
});
export type Clarification = z.infer<typeof Clarification>;

export const PlanOutcome = z.enum([
  'completed',
  /** Some steps done, some skipped or failed. Reported as such, never as done. */
  'partial',
  'failed',
  'awaiting_user',
]);
export type PlanOutcome = z.infer<typeof PlanOutcome>;
