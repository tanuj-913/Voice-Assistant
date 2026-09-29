import {
  appError,
  err,
  errAsync,
  parseWith,
  ResultAsync,
  type AppResult,
  type AppResultAsync,
} from '@assistant/core';
import { ToolMetadata, UserSettings, type RetryPolicy } from '@assistant/schemas';
import {
  decide,
  requiresConfirmation as policyRequiresConfirmation,
  type PolicyContext,
} from './policy.js';

/** Settings the registry assumes when a caller supplies only an allow-list. */
const DEFAULT_SETTINGS = UserSettings.parse({});
import { z } from 'zod';

/**
 * A tool the model may call.
 *
 * The input schema does double duty: it is converted to JSON Schema and given
 * to the model as the contract, and it is the gate every call must pass before
 * an executor runs. Because both come from one declaration they cannot drift.
 */
export interface Tool<S extends z.ZodType = z.ZodType> {
  readonly metadata: ToolMetadata;
  readonly input: S;
  execute(args: z.output<S>, ctx: ToolContext): AppResultAsync<unknown>;
  /**
   * Renders a successful result as a finished sentence.
   *
   * When a tool can say it itself, the brain skips the follow-up model call
   * that would only have turned `{ level: 40 }` into "Volume set to forty
   * percent" — a round trip the user waits through for a sentence a formatter
   * already knows. Return null to decline and let the model phrase it.
   *
   * English only by contract. The caller is responsible for not using this
   * when the reply is owed in another language; see `#speakableAnswer` in the
   * orchestrator.
   */
  speak?(result: unknown): string | null;
  /**
   * Independently checks that the action actually took effect.
   *
   * Executing without error only means the command was accepted. Reading the
   * state back is what turns "I set the volume to 40" from a claim into a
   * fact, and the PRD requires Assistant never report success without evidence.
   *
   * Resolves true when confirmed, false when contradicted. Errors are treated
   * as "could not check", never as failure — a flaky verifier must not turn a
   * successful action into a reported one.
   */
  verify?(result: unknown, ctx: ToolContext): AppResultAsync<boolean>;
  /**
   * Turns an ambiguous-but-successful result into the question that resolves
   * it, or null when the result is unambiguous.
   *
   * "Which Rahul?" is a better answer than picking one. The PRD asks for the
   * minimum question with context preserved, so this returns only the
   * question and its options — the turn keeps everything else.
   */
  clarify?(result: unknown): { question: string; options: string[] } | null;
  /**
   * Undoes a completed call.
   *
   * The PRD requires every tool to declare its rollback capability, and the
   * honest way to declare it is to either implement it or not have it — a
   * boolean saying "rollbackable: true" next to no implementation is worse
   * than nothing. Only tools that can genuinely put the world back carry one:
   * a moved file can be moved home, a sent message cannot be unsent.
   */
  rollback?(result: unknown, ctx: ToolContext): AppResultAsync<unknown>;
}

export interface ValidatedCall {
  readonly tool: Tool;
  readonly args: unknown;
}

export interface ToolContext {
  readonly online: boolean;
  readonly signal: AbortSignal;
}

export function defineTool<S extends z.ZodType>(spec: {
  metadata: z.input<typeof ToolMetadata>;
  input: S;
  execute: (args: z.output<S>, ctx: ToolContext) => AppResultAsync<unknown>;
  speak?: (result: unknown) => string | null;
  verify?: (result: unknown, ctx: ToolContext) => AppResultAsync<boolean>;
  clarify?: (result: unknown) => { question: string; options: string[] } | null;
  rollback?: (result: unknown, ctx: ToolContext) => AppResultAsync<unknown>;
}): Tool<S> {
  return {
    metadata: ToolMetadata.parse(spec.metadata),
    input: spec.input,
    execute: spec.execute,
    ...(spec.speak ? { speak: spec.speak } : {}),
    ...(spec.verify ? { verify: spec.verify } : {}),
    ...(spec.clarify ? { clarify: spec.clarify } : {}),
    ...(spec.rollback ? { rollback: spec.rollback } : {}),
  };
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(...tools: Tool[]): this {
    for (const tool of tools) {
      const { name } = tool.metadata;
      if (this.#tools.has(name)) {
        throw new Error(`Duplicate tool registration: ${name}`);
      }
      this.#tools.set(name, tool);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()];
  }

  /**
   * Validates a raw model-emitted call against the tool's schema.
   *
   * Returns a Result rather than throwing so the brain can feed the validation
   * message back to the model as a tool error and let it retry with a
   * corrected shape — which is usually all a malformed call needs.
   */
  validateCall(name: string, rawArgs: unknown): AppResult<ValidatedCall> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return err(unknownToolError(name, [...this.#tools.keys()]));
    }

    const first = parseWith(tool.input, rawArgs, 'tool_arguments_invalid');
    if (first.isOk()) return first.map((args) => ({ tool, args }));

    // One repair attempt for enum spelling, then the original error stands.
    const repaired = repairEnums(tool.input, rawArgs);
    if (repaired === null) return first.map((args) => ({ tool, args }));

    return parseWith(tool.input, repaired, 'tool_arguments_invalid')
      .map((args) => ({ tool, args }))
      // The *first* error is returned on failure, not the second: it describes
      // what the model actually sent, which is what it needs to see.
      .mapErr(() => (first.isErr() ? first.error : unknownToolError(name, [])));
  }

  /**
   * The tool list in the shape model APIs expect, derived from the Zod schemas.
   * `io: 'input'` emits the pre-defaults shape, which is what the model should
   * see — defaults are ours to apply, not something to ask the model for.
   */
  toModelTools(opts: { online: boolean } = { online: true }) {
    return this.list()
      .filter((tool) => opts.online || !tool.metadata.requiresNetwork)
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.metadata.name,
          description: tool.metadata.description,
          parameters: z.toJSONSchema(tool.input, { io: 'input', target: 'draft-7' }),
        },
      }));
  }

  /** Tools whose risk tier means a human must approve each call. */
  requiresConfirmation(name: string, autoApproved: readonly string[]): boolean {
    const tool = this.#tools.get(name);
    // Unknown tools prompt: failing closed is the only safe default.
    if (!tool) return true;

    // Delegated to the policy engine so there is exactly one place that
    // decides, and it is deterministic.
    return policyRequiresConfirmation(tool.metadata, {
      settings: { ...DEFAULT_SETTINGS, autoApprovedTools: [...autoApproved] },
      online: true,
    });
  }

  /**
   * Runs a validated call, refusing to execute anything destructive that has
   * not been explicitly approved.
   *
   * This duplicates the orchestrator's check on purpose. The orchestrator
   * decides *when* to prompt; this decides whether the action may run at all.
   * A refactor that loses the prompt should fail closed here rather than
   * quietly gaining the ability to empty someone's Trash unprompted.
   */
  executeCall(
    call: ValidatedCall,
    ctx: ToolContext,
    consent: { approved: boolean; authenticated?: boolean },
  ): AppResultAsync<unknown> {
    const { tool, args } = call;

    // Fail closed. The orchestrator decides *when* to prompt; this decides
    // whether the action may run at all, and it asks the policy engine rather
    // than re-implementing the rules.
    const verdict = decide(tool.metadata, {
      settings: { ...DEFAULT_SETTINGS, autoApprovedTools: [] },
      online: ctx.online,
    });
    if (verdict.action === 'deny') {
      return errAsync(appError('policy_denied', verdict.reason));
    }
    if (verdict.action === 'confirm' && verdict.strength === 'strong' && !consent.authenticated) {
      // A `critical` tool needs the operating system to have agreed, not just
      // this process. Checked here as well as in the orchestrator so losing
      // the prompt upstream fails closed rather than downgrading the gate.
      return errAsync(
        appError(
          'authentication_required',
          `"${tool.metadata.name}" requires Touch ID or the login password, which was not given.`,
        ),
      );
    }
    if (verdict.action === 'confirm' && !consent.approved) {
      return errAsync(
        appError(
          'consent_required',
          `"${tool.metadata.name}" requires confirmation and was not approved by the user. ${verdict.reason}`,
        ),
      );
    }

    return withRetry(tool, args, ctx);
  }

  /**
   * The full declaration the PRD's tool-registry section asks for, in one
   * place, for one tool.
   *
   * Three of those fields are *derived* rather than stored — confirmation
   * comes from the policy engine, verification and rollback from whether the
   * tool implements the hook. That is deliberate. A tool declaring
   * `confirmation: 'required'` next to a risk level that says otherwise is a
   * contradiction waiting to be believed by the wrong reader; deriving it
   * means the description and the behaviour cannot disagree.
   */
  describe(name: string, ctx?: PolicyContext) {
    const tool = this.#tools.get(name);
    if (!tool) return null;
    const m = tool.metadata;
    const decision = decide(m, ctx ?? { settings: DEFAULT_SETTINGS, online: true });
    return {
      name: m.name,
      description: m.description,
      inputSchema: z.toJSONSchema(tool.input, { io: 'input', target: 'draft-7' }),
      connector: m.connector,
      risk: m.risk,
      confirmation: decision.action === 'confirm' ? decision.strength : decision.action,
      scopes: m.scopes,
      macPermissions: m.requiredPermissions,
      timeoutMs: m.timeoutMs,
      retry: retryBudget(m),
      verification: tool.verify ? 'automatic' : 'none',
      /** Every attempt lands in the `tool_calls` table, including refusals. */
      audit: 'tool_calls',
      rollback: tool.rollback ? 'supported' : 'none',
    } as const;
  }

  /** Every tool's declaration, for the audit surface and for documentation. */
  describeAll(ctx?: PolicyContext) {
    return this.list()
      .map((tool) => this.describe(tool.metadata.name, ctx))
      .filter((d) => d !== null);
  }
}

/**
 * The retry budget a tool is actually allowed, as opposed to the one it asked
 * for.
 *
 * A tool may declare `maxAttempts: 3`, but anything at `external` or above is
 * pinned to one attempt regardless of what it declared. The tool layer cannot
 * tell "the send failed" from "the reply to the send went missing", so a
 * second attempt at anything that leaves the machine risks doing it twice.
 * Deciding this here rather than trusting the declaration means a new tool
 * cannot opt itself into double-sending.
 */
export function retryBudget(metadata: ToolMetadata): RetryPolicy {
  const safeToRepeat = metadata.risk === 'read' || metadata.risk === 'reversible';
  return safeToRepeat ? metadata.retry : { maxAttempts: 1, backoffMs: 0 };
}

/**
 * Runs the call, repeating it only when the tool is safe to repeat and the
 * error said so.
 *
 * `retryable` is set by the layer that produced the failure — a timeout or a
 * 5xx is retryable, a rejected argument is not — so this never retries its way
 * through a mistake that would fail identically the second time.
 */
function withRetry(tool: Tool, args: unknown, ctx: ToolContext): AppResultAsync<unknown> {
  const { maxAttempts, backoffMs } = retryBudget(tool.metadata);
  if (maxAttempts <= 1) return withTimeout(tool, args, ctx);

  const attempt = (n: number): AppResultAsync<unknown> =>
    withTimeout(tool, args, ctx).orElse((error) => {
      if (n >= maxAttempts || !error.retryable || ctx.signal.aborted) return errAsync(error);
      return ResultAsync.fromSafePromise(delay(backoffMs, ctx.signal)).andThen(() =>
        attempt(n + 1),
      );
    });

  return attempt(1);
}

/** Sleeps, but wakes immediately if the turn is cancelled underneath it. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * Enforces the tool's declared `timeoutMs`.
 *
 * Two mechanisms, because they fail differently. The signal lets a
 * well-behaved tool abort its own work and clean up; the race guarantees the
 * turn moves on even if the tool ignores the signal entirely. Without the
 * race, one `fetch` against a slow host wedges the assistant indefinitely —
 * `timeoutMs` was declared on every tool and read by nothing.
 */
function withTimeout(tool: Tool, args: unknown, ctx: ToolContext): AppResultAsync<unknown> {
  const { timeoutMs, name } = tool.metadata;
  const timer = new AbortController();
  const handle = setTimeout(() => {
    timer.abort();
  }, timeoutMs);

  const signal = AbortSignal.any([ctx.signal, timer.signal]);

  const timedOut = new Promise<never>((_, reject) => {
    timer.signal.addEventListener(
      'abort',
      () => {
        reject(new Error(`"${name}" exceeded its ${String(timeoutMs)}ms budget`));
      },
      { once: true },
    );
  });

  // ResultAsync is a PromiseLike, not a Promise, so it is wrapped rather than
  // passed straight to Promise.race.
  const execution = Promise.resolve<AppResult<unknown>>(tool.execute(args, { ...ctx, signal }));

  const raced = Promise.race([execution, timedOut]).finally(() => {
    clearTimeout(handle);
  });

  return ResultAsync.fromPromise(raced, (cause) =>
    appError('tool_timeout', cause instanceof Error ? cause.message : `"${name}" timed out`, {
      retryable: true,
    }),
  ).andThen((result) => result);
}

/**
 * Fixes an enum value the model spelled the way a person would.
 *
 * Models write `"Apple Music"` where the schema says `apple-music`, and
 * `"video"` where it says `facetime-video`. Measured 2026-09-03: gpt-oss:20b
 * had **7 of 15** calls rejected this way while qwen3:30b-a3b had none — and
 * every rejection costs a retry round trip, which on a slow local model is
 * seconds. It is a spelling difference, not a judgement difference, and the
 * model already chose the right option.
 *
 * Strictly bounded, because this is the validation boundary:
 *
 * - **Only enum fields**, and only ones Zod itself rejected. Nothing else is
 *   touched, so a wrong number or a missing field still fails.
 * - **Only an unambiguous match** after lowercasing and folding spaces and
 *   underscores to hyphens. Two candidates means the model was not clear and
 *   guessing would be worse than asking again.
 * - **One attempt.** If the repaired object still fails, the model's original
 *   error is what comes back, because that describes what it actually sent.
 *
 * Returns null when there is nothing it can fix.
 */
export function repairEnums(schema: z.ZodType, rawArgs: unknown): unknown {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) return null;

  const parsed = schema.safeParse(rawArgs);
  if (parsed.success) return null;

  const repaired: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };
  const drop = new Set<string>();
  let changed = false;

  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    // Top-level fields only: a nested enum is rare here and a deep write is
    // more surface than this is worth.
    if (typeof key !== 'string' || issue.path.length !== 1) continue;

    const actual = repaired[key];
    if (typeof actual !== 'string') continue;

    /**
     * An empty string where the model meant "not applicable".
     *
     * gpt-oss sent `url: ""` alongside a tab-closing call that needs no URL.
     * Collected rather than applied on the spot, because a call can be wrong
     * in both ways at once — that one also spelled the browser `"Safari"` —
     * and fixing either alone still fails. The caller re-parses, so dropping a
     * field the schema actually requires simply fails there, which is the
     * schema deciding what was optional rather than this function guessing.
     */
    if (actual === '') {
      drop.add(key);
      changed = true;
      continue;
    }

    const options = (issue as { values?: unknown }).values;
    if (!Array.isArray(options)) continue;
    const strings = options.filter((option): option is string => typeof option === 'string');

    const matched = matchOption(strings, actual);
    if (matched !== null && matched !== actual) {
      repaired[key] = matched;
      changed = true;
    }
  }

  if (!changed) return null;
  // Rebuilt rather than deleted from: a dynamic `delete` is banned here, and
  // filtering says the same thing without mutating.
  return Object.fromEntries(Object.entries(repaired).filter(([key]) => !drop.has(key)));
}

/**
 * The one option the model meant, or null if that is not obvious.
 *
 * Three passes, each requiring a *unique* winner, because two candidates means
 * the model was not clear and guessing is worse than making it ask again:
 *
 * 1. Exact, once case and separators are folded — `"Apple Music"`.
 * 2. The value is one of an option's hyphenated parts — `"video"` for
 *    `facetime-video`.
 * 3. An option appears among the value's own words — `"battery percentage"`
 *    for `battery`.
 */
function matchOption(options: readonly string[], actual: string): string | null {
  const fold = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const target = fold(actual);

  const unique = (candidates: readonly string[]) => (candidates.length === 1 ? candidates[0] ?? null : null);

  const exact = unique(options.filter((option) => fold(option) === target));
  if (exact !== null) return exact;

  const byPart = unique(options.filter((option) => fold(option).split('-').includes(target)));
  if (byPart !== null) return byPart;

  const words = new Set(target.split('-'));
  return unique(options.filter((option) => words.has(fold(option))));
}

export function unknownToolError(name: string, known: readonly string[]) {
  return appError('tool_unknown', `No tool named "${name}". Available: ${known.join(', ')}`);
}
