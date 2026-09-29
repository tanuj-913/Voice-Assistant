import { randomUUID } from 'node:crypto';
import { childLogger, Trace, type TypedEmitter } from '@assistant/core';
import {
  ConversationId,
  MessageId,
  ToolCallId,
  TurnId,
  type LanguageCode,
  type AppError,
  type ServerEvent,
  type ToolResult,
  Plan,
  type UserSettings,
} from '@assistant/schemas';
import {
  authenticateWithMac,
  decide,
  matchIntent,
  runPlan,
  validatePlan,
  type Authenticator,
  type TaskStore,
  type ToolRegistry,
} from '@assistant/tools';
import { conversations, messages as messagesTable, toolCalls, type AssistantDb } from '@assistant/db';
import { buildSystemPrompt, buildTurnContext } from './prompt.js';
import { buildPlannerPrompt, describePlan, parsePlan } from './planning.js';
import { looksMultiStep } from './multistep.js';
import type { OutboundMessage } from './llm/ollama.js';
import type { LlmClient } from './llm/router.js';
import { SentenceStream, SerialQueue } from '@assistant/voice';
import type { VoiceStack } from './voice.js';

const log = childLogger('orchestrator');

/**
 * How long `success` or `failure` stays on screen before the UI returns to
 * rest. Long enough to register, short enough not to look stuck.
 */
const SETTLE_MS = 1_800;

/** Ceiling on tool round-trips, so a confused model cannot loop forever. */
const MAX_TOOL_ITERATIONS = 5;

export interface OrchestratorDeps {
  /**
   * Whichever model answers. The router decides local or cloud per turn; the
   * turn loop is deliberately unaware of which one it got.
   */
  llm: LlmClient;
  db: AssistantDb;
  registry: ToolRegistry;
  events: TypedEmitter<ServerEvent>;
  model: string;
  /**
   * How long `success` or `failure` stays on screen before the UI returns to
   * rest. Configurable only so a test does not have to wait out the real one.
   */
  settleMs?: number;
  /** Ask for a plan on multi-step requests. Costs a whole extra generation. */
  plannerEnabled?: boolean;
  /**
   * Called once per turn with the finished stage timings, immediately after
   * they are logged.
   *
   * Exists because the timings were otherwise observable only by reading a log
   * line, which is no way to hold a latency claim to account — and every
   * latency number in this project's history that was not asserted somewhere
   * turned out to be wrong at least once.
   */
  onTrace?: (summary: ReturnType<Trace['summary']>) => void;
  /** How Assistant talks. Configuration, because personality is taste. */
  personality?: string;
  /**
   * Looks up stored facts relevant to the request.
   *
   * Injected rather than reached for, so a turn is testable without Postgres
   * and a failing lookup can never take a turn down with it.
   */
  recallMemories?: (query: string) => Promise<readonly string[]>;
  /**
   * Read as a function, not a value: settings are editable at runtime now, and
   * a snapshot captured at construction would mean a preference took effect
   * only after a restart. Called once per turn — changing a setting must not
   * change the rules underneath a turn that is already running.
   */
  /**
   * Where multi-step tasks are recorded, so one can be continued after a
   * restart. Optional: without it, plans still run, they are just forgotten.
   */
  tasks?: TaskStore | null;
  settings: () => UserSettings;
  /**
   * Asks macOS to confirm the person at the keyboard is the owner.
   *
   * Injected so a turn can be tested without a fingerprint, and so the one
   * thing the model can never fake stays outside the model's reach.
   */
  authenticate?: Authenticator;
  voice: VoiceStack;
  isOnline: () => boolean;
}

interface PendingDecision {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #history: OutboundMessage[] = [];
  readonly #pending = new Map<string, PendingDecision>();
  readonly #conversationId = ConversationId.parse(randomUUID());
  #abort: AbortController | null = null;
  /**
   * Serialises turns.
   *
   * `handleTurn` is fire-and-forget from the HTTP layer, so a second question
   * asked while the first is still thinking used to run concurrently: both
   * turns appended to the same `#history` in interleaved order and the second
   * overwrote the first's AbortController, leaving it uncancellable. Asking a
   * follow-up now cancels the turn in flight and waits for it to unwind.
   */
  #inFlight: Promise<void> = Promise.resolve();
  /** Set by the STT layer so replies are spoken in the language heard. */
  #lastLanguage: LanguageCode | null = null;

  #conversationReady: Promise<void> | null = null;

  /**
   * Whether the turn now ending went wrong, so it can end on `failure` rather
   * than `success`. Read once, at the end, by `#settle`.
   */
  #turnFailed = false;
  /** Returns the UI to rest a moment after a turn ends. */
  #settleTimer: NodeJS.Timeout | null = null;

  /**
   * A question Assistant asked and is waiting on.
   *
   * The next thing the user says is the answer, so it is folded back into the
   * original request rather than treated as a fresh one — the PRD asks for the
   * minimum question with context preserved, and re-asking "what did you want
   * again?" is the opposite of that.
   */
  #awaitingAnswer: { question: string; goal: string } | null = null;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  /**
   * Inserts the conversation row once, on first use. Tool-call rows carry a
   * foreign key to it, so this must land before any audit write.
   */
  #ensureConversation(): Promise<void> {
    this.#conversationReady ??= this.#deps.db
      .insert(conversations)
      .values({ id: this.#conversationId })
      .onConflictDoNothing()
      .then(() => undefined);
    return this.#conversationReady;
  }

  /**
   * Records a tool attempt.
   *
   * Deliberately best-effort and never awaited on the critical path: an audit
   * write failing should not abort an action the user already approved. It is
   * logged loudly instead, because silently losing audit rows would be worse
   * than the original failure.
   */
  #audit(row: {
    turnId: string;
    name: string;
    rawArguments: unknown;
    status: 'ok' | 'error' | 'denied' | 'invalid_arguments';
    result?: unknown;
    error?: unknown;
    userApproved?: boolean | undefined;
    durationMs?: number | undefined;
  }): void {
    void this.#ensureConversation()
      .then(() =>
        this.#deps.db.insert(toolCalls).values({
          turnId: row.turnId,
          conversationId: this.#conversationId,
          name: row.name,
          rawArguments: row.rawArguments ?? null,
          status: row.status,
          result: row.result ?? null,
          error: row.error ?? null,
          userApproved: row.userApproved ?? null,
          durationMs: row.durationMs ?? null,
        }),
      )
      .catch((error: unknown) => {
        log.error({ error, tool: row.name }, 'failed to write tool-call audit row');
      });
  }

  #recordMessage(role: 'user' | 'assistant', content: string): void {
    void this.#ensureConversation()
      .then(() =>
        this.#deps.db
          .insert(messagesTable)
          .values({ conversationId: this.#conversationId, role, content }),
      )
      .catch((error: unknown) => {
        log.error({ error, role }, 'failed to persist message');
      });
  }

  /**
   * The call waiting on a human, if one is.
   *
   * Exposed so an utterance can answer the consent card: "allow" spoken across
   * the room should do what clicking Allow does, and the microphone layer
   * needs to know there is a question outstanding before it treats an answer
   * as one.
   */
  get awaitingDecision(): string | null {
    return this.#pending.keys().next().value ?? null;
  }

  /** Resolves a confirmation prompt raised by `tool.proposed`. */
  resolveDecision(callId: string, approved: boolean): boolean {
    const pending = this.#pending.get(callId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.#pending.delete(callId);
    pending.resolve(approved);
    return true;
  }

  setLanguage(language: LanguageCode | null): void {
    this.#lastLanguage = language;
  }

  /**
   * Whether a turn is currently running.
   *
   * Callers need this because `handleTurn` cancels whatever is in flight, so
   * submitting a turn is destructive to the one before it. Anything that can
   * fire without the user meaning it — a burst of room noise reaching the
   * always-on microphone, say — has to check this first.
   */
  get busy(): boolean {
    return this.#abort !== null;
  }

  /** Cancels the in-flight turn, if any. */
  cancel(): void {
    this.#abort?.abort();
    this.#abort = null;
  }

  async handleTurn(userText: string): Promise<void> {
    // A new question supersedes the one being answered — that is what the user
    // means by asking it. Cancel, then queue behind the unwind so history is
    // never written by two turns at once.
    this.cancel();
    const previous = this.#inFlight;
    this.#inFlight = previous.then(
      () => this.#runTurn(userText),
      () => this.#runTurn(userText),
    );
    return this.#inFlight;
  }

  async #runTurn(spokenText: string): Promise<void> {
    // An answer to a question Assistant asked is not a new request. Rejoining it
    // to the original goal keeps the task alive across the clarification.
    const pending = this.#awaitingAnswer;
    this.#awaitingAnswer = null;
    const userText = pending
      ? `${pending.goal} (in answer to "${pending.question}": ${spokenText})`
      : spokenText;

    const turnId = TurnId.parse(randomUUID());
    const abort = new AbortController();
    this.#abort = abort;

    // Every latency claim about this system has been a stopwatch around the
    // whole turn, which hides where the time goes. One log line per turn, with
    // each stage, is the cheapest way to stop guessing.
    const trace = new Trace(turnId);

    const { events, llm, registry, model } = this.#deps;
    const settings = this.#deps.settings();

    // A settle from the previous turn must not drop this one back to idle
    // half a second after it starts.
    if (this.#settleTimer) {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = null;
    }
    this.#turnFailed = false;
    const online = this.#deps.isOnline();

    /**
     * Speak the reply sentence by sentence as the model writes it, rather than
     * synthesising the whole thing once it has finished. On a long answer the
     * model is the slowest part, so waiting for it to finish means the user
     * hears nothing for most of the turn.
     *
     * The queue keeps clips in reading order: a short sentence synthesises
     * faster than a long one, so completion order is not reading order.
     *
     * This also speaks any prose the model emits before reaching for a tool.
     * That is deliberate — "let me check that for you" ahead of a lookup is
     * how an assistant should sound, not a bug to suppress.
     */
    const sentences = new SentenceStream();
    const speech = new SerialQueue();
    let clipIndex = 0;
    let announcedSpeaking = false;

    const speakSegment = (text: string, final: boolean): void => {
      if (text.trim().length === 0) return;
      const index = clipIndex;
      clipIndex += 1;
      // Only the first clip is traced. The rest are synthesised while the user
      // is already listening, so their timings say nothing about the wait.
      if (index === 0) trace.mark('speech_queued');
      void speech.run(async () => {
        if (abort.signal.aborted) return;
        // The gap from `speech_queued` is time spent waiting behind another
        // clip, which no other mark could show — and a queue wait and a slow
        // Sarvam call look identical from outside.
        if (index === 0) trace.mark('speech_dequeued');
        if (!announcedSpeaking) {
          announcedSpeaking = true;
          events.emit({ type: 'state.changed', state: 'speaking', turnId });
        }
        await this.#speak(turnId, text, index, final, index === 0 ? trace : null);
        // What the user actually waits for.
        if (index === 0) trace.mark('first_audio');
      });
    };

    /**
     * Ends the turn on `content` and speaks `speakText` as the last clip.
     *
     * The two differ only when a tool answered for itself: `content` is the
     * whole reply, `speakText` is whatever the sentence stream has not already
     * sent to be spoken.
     */
    const finish = async (content: string, speakText: string): Promise<void> => {
      this.#history.push({ role: 'assistant', content });
      this.#recordMessage('assistant', content);
      events.emit({
        type: 'response.done',
        turnId,
        message: {
          id: MessageId.parse(randomUUID()),
          conversationId: this.#conversationId,
          role: 'assistant',
          content,
          language: null,
          createdAt: new Date().toISOString(),
        },
      });
      speakSegment(speakText, true);
      if (clipIndex === 0) {
        // Nothing was speakable at all; do not leave the UI in `speaking`.
        events.emit({ type: 'state.changed', state: 'idle', turnId: null });
      }
      await speech.drain();
    };

    this.#history.push({ role: 'user', content: userText });
    this.#recordMessage('user', userText);

    /**
     * Facts the user asked to be remembered, when any relate to this request.
     *
     * Given to the model rather than left behind a `recall` tool call: making
     * Assistant ask itself what it knows costs a whole round trip, and it will
     * often simply forget to.
     */
    let remembered: readonly string[] = [];
    if (this.#deps.recallMemories) {
      try {
        remembered = await this.#deps.recallMemories(userText);
        if (remembered.length > 0) trace.mark('recall');
      } catch (error) {
        // Memory is an enhancement. Losing it must never lose the turn.
        log.warn({ turnId, error }, 'memory lookup failed, continuing without it');
      }
    }

    /**
     * Anything left half-done, so "did you finish that?" has something behind
     * it. Read every turn rather than cached: a task can finish, or be closed,
     * between one question and the next.
     */
    let unfinished: readonly { goal: string; status: string }[] = [];
    if (this.#deps.tasks) {
      try {
        unfinished = await this.#deps.tasks.unfinished(3);
      } catch (error) {
        // Same rule as memory: an enhancement must never cost the turn.
        log.warn({ turnId, error }, 'could not read unfinished tasks, continuing without them');
      }
    }

    /**
     * The turn's variable context rides on the user's own message, not in the
     * system prompt.
     *
     * The system prompt plus the tool schemas is ~4,700 tokens, and Ollama
     * caches that prefix — but only while it is byte-identical. Putting a
     * recalled fact inside it cost a measured 12 seconds of re-read on every
     * turn where the recall differed. Appended here it costs its own tokens
     * and nothing else. See `buildTurnContext`.
     *
     * `#history` keeps the user's words alone, so the context of one turn
     * never becomes part of the prefix of the next.
     */
    const context = buildTurnContext({
      ...(remembered.length > 0 ? { remembered } : {}),
      ...(unfinished.length > 0 ? { unfinished } : {}),
    });

    const outbound = [...this.#history];
    const lastIndex = outbound.length - 1;
    const last = outbound[lastIndex];
    if (context !== null && last?.role === 'user' && typeof last.content === 'string') {
      outbound[lastIndex] = { ...last, content: `${last.content}\n${context}` };
    }

    const messages: OutboundMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          toolNames: registry.list().map((t) => t.metadata.name),
          online,
          ...(this.#deps.personality ? { personality: this.#deps.personality } : {}),
        }),
      },
      ...outbound,
    ];

    try {
      /**
       * Fast path: a handful of exact phrasings route straight to a tool.
       *
       * Measured 2026-09-01 — a turn asking the time spent 22,278 ms in the
       * model deciding to call `system_info` and 8 ms running it. Skipping
       * *deliberation* for a closed set of commands is the single largest
       * latency win available. It skips no policy: the call goes through
       * `#runToolCall` and its consent gate exactly as a model-chosen one does.
       */
      /**
       * Whether the user asked for more than one thing.
       *
       * This gates the speakable short-circuit below. A tool that can phrase
       * its own result ends the turn without a second model call — which is
       * pure win for "set the volume to forty", and quietly wrong for "open
       * Spotify and play the last song": the model calls `open_app`, the
       * renderer says "Opened Spotify.", and the rest of the request is
       * dropped while the user is told something that sounds like success.
       *
       * Found by using it, 2026-09-03. The syntactic gate already exists for
       * the planner and errs towards *not* claiming multi-step, so the
       * short-circuit keeps working for everything it was built for.
       */
      const multiStep = looksMultiStep(userText);

      const fast = matchIntent(userText);
      // A rule naming a tool this registry does not have must not fire — it
      // would surface a validation error to the user for a command that is
      // simply unavailable, and the model can say so properly.
      if (fast && registry.get(fast.tool)) {
        trace.mark('fast_path_match');
        events.emit({ type: 'state.changed', state: 'acting', turnId });
        const result = await this.#runToolCall(turnId, fast.tool, fast.args, {
          settings,
          online,
          signal: abort.signal,
        });
        events.emit({ type: 'tool.completed', turnId, result });
        trace.mark('tools_end');

        const call = { function: { name: fast.tool, arguments: fast.args } };

        const question = this.#clarificationFor(fast.tool, result);
        if (question) {
          this.#awaitingAnswer = { question: question.text, goal: spokenText };
          log.info({ turnId, tool: fast.tool }, 'asking rather than guessing');
          events.emit({ type: 'response.delta', turnId, delta: question.spoken });
          await finish(question.spoken, question.spoken);
          return;
        }

        const answered = multiStep ? null : this.#speakableAnswer([call], [result]);
        if (answered !== null) {
          log.info({ turnId, rule: fast.rule, tool: fast.tool }, 'answered on the fast path');
          events.emit({ type: 'response.delta', turnId, delta: answered });
          await finish(answered, answered);
          return;
        }

        /**
         * The tool ran but cannot phrase its own outcome — it failed, or
         * succeeded partially ("no contact matched"). Hand the model what
         * already happened rather than letting it call the tool a second time;
         * `next track` is not safe to run twice.
         */
        trace.mark('fast_path_deferred');
        log.info(
          { turnId, rule: fast.rule, status: result.status },
          'fast path ran the tool but deferred phrasing to the model',
        );
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
        messages.push({
          role: 'tool',
          tool_name: fast.tool,
          content: JSON.stringify(summariseForModel(result)),
        });
      }

      /**
       * Planning pass. Only for requests that look like more than one action,
       * and only when enabled — it is an entire extra generation before
       * anything happens.
       */
      if (this.#deps.plannerEnabled === true && multiStep) {
        trace.mark('plan_start');
        const drafted = await llm.chat(
          {
            model,
            messages: [
              {
                role: 'user',
                content: buildPlannerPrompt({
                  toolNames: registry.list().map((t) => t.metadata.name),
                  goal: userText,
                }),
              },
            ],
            signal: abort.signal,
            think: true,
          },
          {},
        );
        trace.mark('plan_end');

        const parsed = drafted.isOk() ? parsePlan(drafted.value.content) : null;
        if (parsed?.ok) {
          // Say what is about to happen before doing it — the PRD asks for
          // progressive updates, not silence followed by a verdict.
          const preview = describePlan(parsed.plan.steps);
          events.emit({ type: 'response.delta', turnId, delta: preview });
          speakSegment(preview, false);

          const executed = await this.#executePlan(turnId, parsed.plan, trace, {
            settings,
            online,
            signal: abort.signal,
          });
          if (executed) {
            await finish(executed, executed);
            return;
          }
        } else if (parsed) {
          // A plan that will not parse is not a reason to give up on the
          // request; the ordinary tool loop below still handles it.
          log.warn({ turnId, problem: parsed.problem }, 'planner output rejected');
        }
      }

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        events.emit({ type: 'state.changed', state: 'thinking', turnId });

        trace.mark('model_call_start');
        const completion = await llm.chat(
          {
            model,
            messages,
            tools: registry.toModelTools({ online }),
            signal: abort.signal,
            /**
             * Always true, despite the tokens it costs.
             *
             * `think: false` does not stop qwen3 reasoning — it stops it
             * *separating* the reasoning. Measured against qwen3:30b-a3b on
             * 2026-09-01: with `think: true` the chain of thought arrives in a
             * `thinking` field and `content` is "Hello! How can I help you
             * today?"; with `think: false` there is no `thinking` field and
             * `content` begins "Okay, the user just said... Hmm, let me think
             * about how to approach this." Untagged, so `ReasoningFilter`
             * cannot strip it, and Assistant would read the monologue aloud.
             *
             * The round trip this was meant to save is now avoided properly:
             * a tool that can phrase its own result ends the turn without a
             * second model call at all. See `#speakableAnswer`.
             */
            think: true,
          },
          {
            onDelta: (delta) => {
              events.emit({ type: 'response.delta', turnId, delta });
              for (const sentence of sentences.push(delta)) {
                speakSegment(sentence, false);
              }
            },
          },
        );

        if (completion.isErr()) {
          this.#fail(turnId, completion.error);
          return;
        }

        trace.mark('model_call_end');
        const message = completion.value;
        const toolCalls = message.tool_calls ?? [];

        messages.push({
          role: 'assistant',
          content: message.content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });

        if (toolCalls.length === 0) {
          // Whatever did not end in a terminator — usually the last sentence,
          // since a trailing "." is held until the next character proves it is
          // not a decimal point.
          await finish(message.content, sentences.flush() ?? '');
          return;
        }

        speakSegment(sentences.flush() ?? '', false);
        events.emit({ type: 'state.changed', state: 'acting', turnId });

        trace.mark('tools_start');
        const results = await this.#executeCalls(turnId, toolCalls, trace, userText, {
          settings,
          online,
          signal: abort.signal,
        });
        for (const [index, result] of results.entries()) {
          const call = toolCalls[index];
          if (!call) continue;
          // The model needs the outcome — including failures — to respond
          // truthfully rather than assuming the action succeeded.
          messages.push({
            role: 'tool',
            tool_name: call.function.name,
            content: JSON.stringify(summariseForModel(result)),
          });
        }

        trace.mark('tools_end');

        /**
         * A tool that came back ambiguous asks the question itself.
         *
         * This used to run only on the fast path, so "message Tilak" — which
         * the *model* routes, not the matcher — hit two contacts called Tilak
         * and the structured question was thrown away. The model then
         * improvised something of its own, usually asking for a phone number
         * it had no way to want. Reported by the user on 2026-09-03: the names
         * are right there, and reading them out is the whole answer.
         *
         * Only for a single call: with two tools in flight it is not clear
         * which question the user would be answering.
         */
        if (toolCalls.length === 1) {
          const only = toolCalls[0];
          const result = results[0];
          const question =
            only && result ? this.#clarificationFor(only.function.name, result) : null;
          if (question) {
            this.#awaitingAnswer = { question: question.text, goal: userText };
            log.info({ turnId, tool: only?.function.name }, 'asking rather than guessing');
            events.emit({ type: 'response.delta', turnId, delta: question.spoken });
            await finish(question.spoken, question.spoken);
            return;
          }
        }

        /**
         * "Volume set to 40 percent" needs no language model. When the tool
         * can say it itself, the second round trip is pure latency — but only
         * when the request was a single thing. On a multi-step request the
         * model has to come back and finish the job.
         */
        const answered = multiStep ? null : this.#speakableAnswer(toolCalls, results);
        if (answered !== null) {
          events.emit({ type: 'response.delta', turnId, delta: answered });
          await finish(answered, answered);
          return;
        }
      }

      log.warn({ turnId }, 'tool iteration ceiling reached');
      this.#fail(turnId, {
        code: 'tool_loop_limit',
        message: 'Gave up after too many tool steps without a final answer.',
        retryable: false,
      });
    } catch (error) {
      this.#fail(turnId, {
        code: 'turn_failed',
        message: error instanceof Error ? error.message : 'Unknown failure',
        retryable: true,
      });
    } finally {
      trace.mark('turn_end');
      const summary = trace.summary();
      log.info({ ...summary, firstAudioMs: trace.at('first_audio') }, 'turn timing');
      // After the log, not instead of it: a listener that throws must not lose
      // the timings it was watching.
      try {
        this.#deps.onTrace?.(summary);
      } catch {
        // A trace observer is diagnostics. It cannot be allowed to fail a turn.
      }
      this.#abort = null;
      this.#settle(turnId);
    }
  }

  /**
   * Synthesises the reply and publishes a URL for it.
   *
   * Failures here are logged but never surfaced as a turn error: the user
   * already has the answer on screen, and a dead TTS call should not repaint
   * a successful turn as a failure.
   */
  /**
   * A tool's own sentence, when using it instead of a second model call is
   * safe.
   *
   * Deliberately narrow. Two tool calls need composing and composing is what
   * the model is for; a failure needs explaining; and the renderers are
   * English, so a reply owed in another language has to go back to the model
   * or Assistant would answer Hindi in English.
   */
  #speakableAnswer(
    calls: readonly { function: { name: string } }[],
    results: readonly ToolResult[],
  ): string | null {
    if (calls.length !== 1 || results.length !== 1) return null;
    const call = calls[0];
    const result = results[0];
    if (!call || result?.status !== 'ok') return null;

    const language = this.#lastLanguage;
    if (language !== null && language !== 'en-IN') return null;

    const rendered = this.#deps.registry.get(call.function.name)?.speak?.(result.result);
    const trimmed = rendered?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
  }

  async #speak(
    turnId: TurnId,
    text: string,
    index: number,
    final: boolean,
    /** Non-null only for the clip the user is actually waiting on. */
    trace: Trace | null,
  ): Promise<void> {
    const { voice, events } = this.#deps;
    if (text.trim().length === 0) return;
    const tts = voice.tts;

    // Only a hint: the speech layer detects the actual language from the text
    // it is about to speak, which is the only place that knows.
    const language = this.#lastLanguage ?? 'en-IN';
    trace?.mark('tts_start');
    const result = await tts.synthesize({ text, language });
    trace?.mark('tts_end');

    if (result.isErr()) {
      log.warn({ turnId, error: result.error }, 'speech synthesis failed');
      return;
    }

    const wav = Buffer.from(result.value.audio.data, 'base64');
    const id = voice.speech.put(wav);
    // Base64-decoding and storing a clip is not free at megabyte sizes, and it
    // sat between two marks with nothing to attribute it to.
    trace?.mark('speech_stored');
    log.info(
      {
        turnId,
        provider: result.value.provider,
        bytes: wav.length,
        language,
        chars: text.length,
        // Splits `tts_end - tts_start` into the network and the voice
        // conversion. Null when the provider cannot break its own time down.
        timings: result.value.timings,
      },
      'speech ready',
    );
    events.emit({
      type: 'speech.ready',
      turnId,
      url: `/speech/${id}`,
      text,
      provider: result.value.provider,
      index,
      final,
    });
  }

  /**
   * Runs the calls the model asked for in one response.
   *
   * A single call is just executed. Two or more become a `Plan` and go through
   * `runPlan`, which is where dependency ordering, retry rules and honest
   * partial reporting live. That matters most when some of them fail: the plan
   * distinguishes done from skipped from "ran but did not take effect", where
   * a bare loop left the model to guess.
   *
   * The model supplies no dependencies yet, so today's steps are independent
   * and the planner mainly buys the reporting. When the planner prompt lands,
   * the same path carries real dependency graphs unchanged.
   */
  /**
   * A question worth asking instead of acting, or null.
   *
   * Only raised for a *successful* call that is nonetheless too ambiguous to
   * act on — a failure is something the model should explain, not something
   * the user can resolve by choosing.
   */
  #clarificationFor(toolName: string, result: ToolResult): { text: string; spoken: string } | null {
    if (result.status !== 'ok') return null;
    const raised = this.#deps.registry.get(toolName)?.clarify?.(result.result);
    if (!raised) return null;
    const spoken =
      raised.options.length > 0
        ? `${raised.question} ${raised.options.join(', or ')}?`
        : raised.question;
    return { text: raised.question, spoken };
  }

  /**
   * Runs a validated plan and reports what actually happened.
   *
   * Returns the sentence to speak, or null when the plan could not be run at
   * all — in which case the caller falls back to the ordinary tool loop rather
   * than leaving the request unanswered.
   */
  async #executePlan(
    turnId: TurnId,
    plan: Plan,
    trace: Trace,
    ctx: { settings: UserSettings; online: boolean; signal: AbortSignal },
  ): Promise<string | null> {
    const { events, registry } = this.#deps;

    const structural = validatePlan(plan, (name) => registry.get(name) !== undefined);
    if (!structural.ok) {
      log.warn({ turnId, problem: structural.problem }, 'plan failed validation');
      return null;
    }

    /**
     * Recorded before it runs, not after.
     *
     * A plan that dies with the process — the Mac sleeps, the brain is
     * restarted — is exactly the one worth remembering, and a row written only
     * on completion would never capture it. The `running` status it leaves
     * behind is what tells the next session something was interrupted.
     */
    const taskId = await this.#startTask(turnId, plan.goal);

    const run = await runPlan(plan, {
      signal: ctx.signal,
      onStep: (step) => {
        trace.mark(`step:${step.tool}`);
        events.emit({ type: 'state.changed', state: 'acting', turnId });
      },
      run: async (step) => {
        const result = await this.#runToolCall(turnId, step.tool, step.arguments, ctx);
        events.emit({ type: 'tool.completed', turnId, result });
        return result;
      },
    });

    log.info({ turnId, outcome: run.outcome, summary: run.summary }, 'plan finished');

    await this.#finishTask(turnId, taskId, run);

    // Never report a half-done task as done. The summary already distinguishes
    // done from skipped from "ran but did not take effect".
    if (run.outcome === 'completed') {
      const unconfirmed = run.steps.filter((s) => s.verification === 'contradicted');
      return unconfirmed.length === 0
        ? 'Done.'
        : `I ran everything, but ${String(unconfirmed.length)} step did not take effect.`;
    }
    const failed = run.steps.filter((s) => s.status === 'failed');
    const firstProblem = failed[0]?.description ?? 'one of the steps';
    return run.outcome === 'failed'
      ? `I could not do that — ${firstProblem} failed.`
      : `I got part of the way: ${run.summary}. It stopped at ${firstProblem}.`;
  }

  /**
   * Opens a task row before the work starts.
   *
   * Before rather than after, because the run that never finishes is the one
   * worth remembering — a Mac that sleeps mid-plan leaves a `running` row, and
   * that row is what tells the next session something was interrupted.
   *
   * Never throws. Task history is an enhancement; a database that will not
   * answer must cost the user their history, never their task.
   */
  async #startTask(turnId: TurnId, goal: string): Promise<string | null> {
    if (!this.#deps.tasks) return null;
    try {
      return await this.#deps.tasks.start(goal);
    } catch (error) {
      log.warn({ turnId, error }, 'could not record the task');
      return null;
    }
  }

  async #finishTask(
    turnId: TurnId,
    taskId: string | null,
    run: {
      outcome: 'completed' | 'partial' | 'failed' | 'awaiting_user';
      summary: string;
      steps: readonly { description: string; status: string }[];
    },
  ): Promise<void> {
    if (taskId === null || !this.#deps.tasks) return;
    try {
      await this.#deps.tasks.finish(
        taskId,
        // A plan waiting on an answer is unfinished, which is what `partial`
        // means here. A status of its own would be a state nobody reading the
        // list back later would act on differently.
        run.outcome === 'awaiting_user' ? 'partial' : run.outcome,
        run.summary,
        // The plan's own step descriptions rather than tool names, because
        // this is what gets read back to a person tomorrow.
        run.steps.map((step) => ({ description: step.description, status: step.status })),
      );
    } catch (error) {
      log.warn({ turnId, error }, 'could not record how the task ended');
    }
  }

  async #executeCalls(
    turnId: TurnId,
    calls: readonly { function: { name: string; arguments: unknown } }[],
    trace: Trace,
    /** The request in the user's own words — what a recorded task is called. */
    goal: string,
    ctx: { settings: UserSettings; online: boolean; signal: AbortSignal },
  ): Promise<ToolResult[]> {
    const { events, registry } = this.#deps;

    const runOne = async (name: string, args: unknown): Promise<ToolResult> => {
      const result = await this.#runToolCall(turnId, name, args, ctx);
      events.emit({ type: 'tool.completed', turnId, result });
      return result;
    };

    const inOrder = async (): Promise<ToolResult[]> => {
      const out: ToolResult[] = [];
      for (const call of calls) out.push(await runOne(call.function.name, call.function.arguments));
      return out;
    };

    if (calls.length <= 1) {
      const call = calls[0];
      return call ? [await runOne(call.function.name, call.function.arguments)] : [];
    }

    const parsed = Plan.safeParse({
      // The user's own words rather than "the current request": this goal is
      // what gets read back to them tomorrow if the task does not finish.
      goal,
      steps: calls.map((call, index) => ({
        id: `step_${String(index)}`,
        description: `Run ${call.function.name}`,
        tool: call.function.name,
        arguments: call.function.arguments,
      })),
    });
    // A plan we cannot build is no reason to refuse to act; fall back to what
    // happened before the planner existed.
    if (!parsed.success) return inOrder();

    const structural = validatePlan(parsed.data, (name) => registry.get(name) !== undefined);
    if (!structural.ok) {
      log.warn({ turnId, problem: structural.problem }, 'plan rejected, running calls in order');
      return inOrder();
    }

    const byStep = new Map<string, ToolResult>();
    // Several tool calls in one turn is a multi-step task, whether or not the
    // planner wrote it down, so it is recorded on the same terms — before it
    // runs, so an interrupted one is still there afterwards.
    const taskId = await this.#startTask(turnId, goal);
    const run = await runPlan(parsed.data, {
      signal: ctx.signal,
      onStep: (step) => {
        trace.mark(`step:${step.tool}`);
      },
      run: async (step) => {
        const result = await runOne(step.tool, step.arguments);
        byStep.set(step.id, result);
        return result;
      },
    });
    log.info({ turnId, outcome: run.outcome, summary: run.summary }, 'plan finished');
    await this.#finishTask(turnId, taskId, run);

    // Keep the model's call order so each result lines up with its message.
    return parsed.data.steps.map(
      (step) =>
        byStep.get(step.id) ?? {
          status: 'denied' as const,
          id: ToolCallId.parse(randomUUID()),
          name: step.tool,
          reason: 'offline' as const,
        },
    );
  }

  async #runToolCall(
    turnId: TurnId,
    name: string,
    rawArgs: unknown,
    ctx: { settings: UserSettings; online: boolean; signal: AbortSignal },
  ): Promise<ToolResult> {
    const { registry, events } = this.#deps;
    const callId = ToolCallId.parse(randomUUID());
    const startedAt = performance.now();

    const validated = registry.validateCall(name, rawArgs);
    if (validated.isErr()) {
      this.#audit({
        turnId,
        name,
        rawArguments: rawArgs,
        status: 'invalid_arguments',
        error: validated.error,
        durationMs: Math.round(performance.now() - startedAt),
      });
      // Returned as a tool error, not thrown: the model can usually fix a
      // malformed call on the next iteration if it is told what was wrong.
      return {
        status: 'error',
        id: callId,
        name,
        error: validated.error,
        durationMs: Math.round(performance.now() - startedAt),
      };
    }

    const { tool, args } = validated.value;

    if (!ctx.online && tool.metadata.requiresNetwork) {
      this.#audit({ turnId, name, rawArguments: rawArgs, status: 'denied' });
      return { status: 'denied', id: callId, name, reason: 'offline' };
    }

    /**
     * Asked of the policy engine directly rather than through the registry's
     * boolean, because the strength of the confirmation matters now: some
     * actions need the operating system to agree, not just a click in a window
     * this process drew.
     */
    const decision = decide(tool.metadata, { settings: ctx.settings, online: ctx.online });
    const needsConfirmation = decision.action === 'confirm';
    const strength = decision.action === 'confirm' ? decision.strength : 'normal';

    events.emit({
      type: 'tool.proposed',
      turnId,
      callId,
      name,
      arguments: args,
      needsConfirmation,
      risk: tool.metadata.risk,
      strength,
      reason: extractReason(args),
      permissions: tool.metadata.requiredPermissions,
    });

    let approved = !needsConfirmation;
    let authenticated = false;
    if (needsConfirmation) {
      // The turn is not working, it is waiting on a person — and until this
      // state existed the two looked identical from the outside.
      events.emit({ type: 'state.changed', state: 'awaiting_approval', turnId });
      approved = await this.#awaitDecision(callId);
      events.emit({ type: 'state.changed', state: 'acting', turnId });
      if (!approved) {
        this.#audit({
          turnId,
          name,
          rawArguments: rawArgs,
          status: 'denied',
          userApproved: false,
        });
        return { status: 'denied', id: callId, name, reason: 'user_declined' };
      }

      if (strength === 'strong') {
        /**
         * The second gate, and the one the app cannot forge. Approving in
         * Assistant's own window proves someone clicked; Touch ID proves who.
         *
         * A Mac that cannot ask is treated as a refusal rather than waved
         * through — degrading a critical action to "well, they clicked yes"
         * would quietly remove the guarantee the tier exists for.
         */
        const outcome = await (this.#deps.authenticate ?? authenticateWithMac)(
          `${name}: ${decision.reason}`,
        );
        if (outcome.status !== 'authorised') {
          log.warn(
            { turnId, tool: name, outcome: outcome.status },
            'platform authentication failed',
          );
          this.#audit({
            turnId,
            name,
            rawArguments: rawArgs,
            status: 'denied',
            userApproved: true,
          });
          return { status: 'denied', id: callId, name, reason: 'authentication_failed' };
        }
        authenticated = true;
      }
    }

    // Routed through the registry rather than calling the tool directly: it
    // refuses destructive actions that carry no approval, so losing the prompt
    // above fails closed instead of silently executing.
    const outcome = await registry.executeCall(
      { tool, args },
      { online: ctx.online, signal: ctx.signal },
      { approved, authenticated },
    );
    const durationMs = Math.round(performance.now() - startedAt);

    this.#audit({
      turnId,
      name,
      rawArguments: rawArgs,
      status: outcome.isOk() ? 'ok' : 'error',
      result: outcome.isOk() ? outcome.value : null,
      error: outcome.isErr() ? outcome.error : null,
      userApproved: needsConfirmation ? true : undefined,
      durationMs,
    });

    if (outcome.isErr()) {
      return { status: 'error', id: callId, name, error: outcome.error, durationMs };
    }

    /**
     * Executing without error means the command was accepted, not that
     * anything changed. Where a tool can read the state back, do it, so
     * "success" is evidence rather than a claim.
     *
     * A verifier that itself fails leaves the result `unverified`. Turning a
     * flaky check into a reported failure would be its own kind of lie.
     */
    let verification: 'confirmed' | 'contradicted' | 'unverified' = 'unverified';
    if (tool.verify) {
      const checked = await tool.verify(outcome.value, {
        online: ctx.online,
        signal: ctx.signal,
      });
      if (checked.isOk()) {
        verification = checked.value ? 'confirmed' : 'contradicted';
      } else {
        log.warn({ turnId, tool: name, error: checked.error }, 'verification could not run');
      }
      if (verification === 'contradicted') {
        log.warn({ turnId, tool: name }, 'tool reported success but the state disagrees');
      }
    }

    return { status: 'ok', id: callId, name, result: outcome.value, durationMs, verification };
  }

  /** Waits for the user's approval, defaulting to deny if they never answer. */
  #awaitDecision(callId: ToolCallId): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(callId);
        resolve(false);
      }, 60_000);

      this.#pending.set(callId, { resolve, timer });
    });
  }

  #fail(turnId: TurnId, error: AppError): void {
    log.error({ turnId, error }, 'turn failed');
    this.#turnFailed = true;
    // The error event still carries the detail; the state is settled with the
    // rest of the turn so the UI never shows "failure" and then "success".
    this.#deps.events.emit({ type: 'error', error, turnId });
  }

  /**
   * Ends the turn on `success` or `failure`, then returns to rest.
   *
   * Both are held briefly rather than emitted and immediately replaced: the
   * point of the state is that a person sees it. The decay lives here rather
   * than in the UI so the interface stays a projection of what the brain says
   * is happening, which is the property that keeps the two from disagreeing.
   */
  #settle(turnId: TurnId): void {
    const state = this.#turnFailed ? 'failure' : 'success';
    this.#deps.events.emit({ type: 'state.changed', state, turnId });

    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      this.#deps.events.emit({ type: 'state.changed', state: 'idle', turnId: null });
    }, this.#deps.settleMs ?? SETTLE_MS);
    // Never the reason the process stays alive.
    this.#settleTimer.unref();
  }
}

/** Pulls the model's stated justification out of a tool's arguments. */
function extractReason(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const reason = (args as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

/**
 * Renders a tool result for the model.
 *
 * The wording matters more than it looks. An earlier version returned
 * `{ denied: 'user_declined' }` and the model told the user that the message
 * *recipient* had declined it — inventing a fact about another person from an
 * ambiguous enum. Each outcome now states plainly who did what.
 */
function summariseForModel(result: ToolResult): unknown {
  switch (result.status) {
    case 'ok':
      return { ok: true, result: result.result };

    case 'error':
      return { ok: false, failed: true, reason: result.error.message };

    case 'denied':
      return { ok: false, executed: false, reason: DENIAL_EXPLANATIONS[result.reason] };
  }
}

/**
 * Written as full sentences addressed to the model, because a bare enum is
 * exactly the kind of token a small model will confabulate a story around.
 */
const DENIAL_EXPLANATIONS: Record<Extract<ToolResult, { status: 'denied' }>['reason'], string> = {
  user_declined:
    'The action did not run. The user was asked to approve it and chose not to. Tell them it was not done, and do not attribute the refusal to anyone else.',
  missing_permission:
    'The action did not run because macOS has not granted the required permission. Tell the user which permission to enable in System Settings.',
  offline:
    'The action did not run because there is no network connection and this tool requires one.',
  rate_limited:
    'The action did not run because the service is rate limiting requests. Suggest trying again shortly.',
  authentication_failed:
    'The action did not run. It needs Touch ID or the login password, and that was not given. Tell the user it was not done and that they can try again.',
};
