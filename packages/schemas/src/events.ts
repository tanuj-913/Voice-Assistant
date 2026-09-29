import { z } from 'zod';
import { AppError, ConversationId, LanguageCode, MessageId, ToolCallId, TurnId } from './common.js';
import { MacPermission, RiskLevel, ToolResult } from './tools.js';
import { WakeWordEvent } from './voice.js';

/**
 * The assistant's lifecycle. The UI renders directly off this — the orb's
 * colour, motion and intensity are a pure function of the current state, so
 * there is exactly one place that decides what Assistant is "doing".
 */
/**
 * What Assistant is doing, as the UI shows it.
 *
 * `awaiting_approval`, `success` and `failure` exist because the PRD asks the
 * interface to distinguish them, and because they are the three moments a user
 * most needs to see: something is waiting on them, something finished, or
 * something did not. The first two used to be invisible — a turn waiting on a
 * consent card still read as "working", and a finished turn went straight back
 * to idle with no sign it had done anything.
 *
 * `success` and `failure` are terminal and brief; the brain returns to `idle`
 * shortly after, so the UI stays a projection of the brain's state rather than
 * running a timer of its own.
 */
export const AssistantState = z.enum([
  'idle',
  'listening',
  'transcribing',
  'thinking',
  'acting',
  'awaiting_approval',
  'speaking',
  'success',
  'failure',
]);
export type AssistantState = z.infer<typeof AssistantState>;

export const MessageRole = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof MessageRole>;

export const Message = z.object({
  id: MessageId,
  conversationId: ConversationId,
  role: MessageRole,
  content: z.string(),
  language: LanguageCode.nullable().default(null),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Message = z.infer<typeof Message>;

/**
 * Everything the brain broadcasts to the UI, as one discriminated union.
 * A single union means the UI's event handler is exhaustively checkable —
 * adding an event type produces a compile error at every consumer.
 */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state.changed'), state: AssistantState, turnId: TurnId.nullable() }),

  z.object({ type: z.literal('wake.detected'), event: WakeWordEvent }),

  /** Live mic amplitude, 0-1, for the waveform. High frequency, never persisted. */
  z.object({ type: z.literal('audio.level'), level: z.number().min(0).max(1) }),

  z.object({
    type: z.literal('transcript.partial'),
    turnId: TurnId,
    text: z.string(),
  }),
  z.object({
    type: z.literal('transcript.final'),
    turnId: TurnId,
    text: z.string(),
    language: LanguageCode.nullable(),
  }),

  /** Streaming assistant tokens. */
  z.object({ type: z.literal('response.delta'), turnId: TurnId, delta: z.string() }),
  z.object({ type: z.literal('response.done'), turnId: TurnId, message: Message }),

  z.object({
    type: z.literal('tool.proposed'),
    turnId: TurnId,
    callId: ToolCallId,
    name: z.string(),
    arguments: z.unknown(),
    /** Set when the tool's risk tier requires a human decision first. */
    needsConfirmation: z.boolean(),
    risk: RiskLevel,
    /**
     * `strong` means approving in the UI is not the end of it: macOS will ask
     * for Touch ID or the login password before anything runs. Sent so the
     * card can say so, rather than a system prompt appearing from nowhere.
     */
    strength: z.enum(['normal', 'strong']).default('normal'),
    /** The model's stated reason, on tools that require one. */
    reason: z.string().nullable().default(null),
    /** macOS permissions this action needs, so the prompt can warn up front. */
    permissions: z.array(MacPermission).default([]),
  }),
  z.object({ type: z.literal('tool.completed'), turnId: TurnId, result: ToolResult }),

  /**
   * Synthesised speech is ready to play. The audio is fetched over HTTP rather
   * than inlined here — base64 WAV on an event stream that also carries 60Hz
   * audio levels would starve the levels.
   */
  z.object({
    type: z.literal('speech.ready'),
    turnId: TurnId,
    url: z.string(),
    /**
     * The sentence this clip says.
     *
     * Carried so the interface can reveal the words *as they are spoken*
     * rather than as they are written. Synthesis takes ~3 s, so streaming the
     * model's tokens straight to the transcript meant reading the answer and
     * then hearing it three seconds later — which the user rightly called
     * wrong on 2026-09-03.
     */
    text: z.string().default(''),
    provider: z.enum(['sarvam', 'macos-say']),
    /**
     * Position of this clip within the reply. A reply is spoken sentence by
     * sentence as the model writes it, so several of these arrive per turn and
     * the client must play them in this order rather than as they land —
     * synthesis time varies with sentence length, so arrival order is not
     * guaranteed to match reading order.
     */
    index: z.number().int().nonnegative(),
    /** True on the last clip of the turn. */
    final: z.boolean(),
  }),

  z.object({ type: z.literal('error'), error: AppError, turnId: TurnId.nullable() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Commands the UI sends back to the brain. */
export const ClientCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('listen.start') }),
  z.object({ type: z.literal('listen.stop') }),
  z.object({ type: z.literal('speak.cancel') }),
  z.object({ type: z.literal('text.submit'), text: z.string().min(1).max(4000) }),
  z.object({
    type: z.literal('tool.decision'),
    callId: ToolCallId,
    approved: z.boolean(),
    /** Skip the prompt for this tool from now on. */
    remember: z.boolean().default(false),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;
