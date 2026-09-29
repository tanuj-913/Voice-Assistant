import { appError, fromPromise, parseWith, type AppResultAsync } from '@assistant/core';
import { z } from 'zod';

/**
 * Ollama chat client.
 *
 * Hand-rolled over fetch rather than using the SDK so every response is
 * Zod-parsed at the boundary, consistent with the rest of the codebase. A
 * local model returning an unexpected shape should be a typed error, not an
 * undefined that surfaces three frames later.
 */

export const OllamaToolCall = z.object({
  function: z.object({
    name: z.string(),
    /** Ollama returns arguments as an object, not a JSON string. */
    arguments: z.unknown(),
  }),
});
export type OllamaToolCall = z.infer<typeof OllamaToolCall>;

export const OllamaMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().default(''),
  thinking: z.string().nullish(),
  tool_calls: z.array(OllamaToolCall).optional(),
});
export type OllamaMessage = z.infer<typeof OllamaMessage>;

const ChatChunk = z.object({
  model: z.string(),
  message: OllamaMessage.optional(),
  done: z.boolean(),
  done_reason: z.string().nullish(),
});

const TagsResponse = z.object({
  models: z.array(z.object({ name: z.string(), size: z.number().optional() })).default([]),
});

export interface OllamaChatRequest {
  model: string;
  messages: readonly OutboundMessage[];
  tools?: readonly unknown[];
  /**
   * Qwen3 is a reasoning model. Counter-intuitively this defaults to ON:
   * with `think: false` Ollama does not suppress reasoning, it just stops
   * separating it — the chain of thought lands in `content` behind a stray
   * `</think>`, and the assistant reads its own scratchpad out loud.
   */
  think?: boolean;
  temperature?: number;
  numCtx?: number;
  signal?: AbortSignal;
}

export interface OutboundMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string;
  tool_calls?: readonly OllamaToolCall[];
}

export interface ChatStreamHandlers {
  onDelta?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

export class OllamaClient {
  readonly #baseUrl: string;
  readonly #keepAlive: string | number;

  constructor(baseUrl: string, keepAlive = '-1') {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#keepAlive = normaliseKeepAlive(keepAlive);
  }

  /**
   * Loads the model into memory without generating anything.
   *
   * Ollama treats a chat request with no messages as a preload. Worth doing
   * at startup because the cost is paid either way and it is large: a 19 GB
   * model that has been evicted takes over two minutes to page back in, and
   * without this the user pays that on their first question rather than while
   * the app is still starting.
   *
   * Failure is not fatal — the first real request will simply load it — so
   * this resolves either way and the caller only logs the outcome.
   */
  async warm(model: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [], keep_alive: this.#keepAlive }),
        signal: AbortSignal.timeout(300_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Streams a completion, accumulating into a final message. */
  chat(
    request: OllamaChatRequest,
    handlers: ChatStreamHandlers = {},
  ): AppResultAsync<OllamaMessage> {
    return fromPromise(this.#streamChat(request, handlers), 'ollama_chat_failed', {
      retryable: true,
    });
  }

  async #streamChat(
    request: OllamaChatRequest,
    handlers: ChatStreamHandlers,
  ): Promise<OllamaMessage> {
    const body = {
      model: request.model,
      messages: request.messages,
      stream: true,
      // Pinning the model resident removes a ~10s reload from the first
      // request after an idle period, which for an assistant is most of them.
      keep_alive: this.#keepAlive,
      think: request.think ?? true,
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      options: {
        temperature: request.temperature ?? 0.6,
        num_ctx: request.numCtx ?? 8192,
      },
    };

    const response = await fetch(`${this.#baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama responded ${String(response.status)}: ${detail.slice(0, 300)}`);
    }

    let content = '';
    let thinking = '';
    const toolCalls: OllamaToolCall[] = [];
    const filter = new ReasoningFilter();

    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let buffer = '';

    // Ollama streams NDJSON; a chunk boundary can split a line, so the tail is
    // carried into the next read rather than parsed.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim().length === 0) continue;

        const parsed = ChatChunk.safeParse(JSON.parse(line));
        if (!parsed.success) continue;

        const message = parsed.data.message;
        if (!message) continue;

        if (message.content.length > 0) {
          content += message.content;
          // Filtered before it reaches the UI: the final strip runs too late
          // to stop reasoning that has already been rendered token by token.
          const visible = filter.push(message.content);
          if (visible.length > 0) handlers.onDelta?.(visible);
        }
        if (typeof message.thinking === 'string' && message.thinking.length > 0) {
          thinking += message.thinking;
          handlers.onThinking?.(message.thinking);
        }
        if (message.tool_calls) toolCalls.push(...message.tool_calls);
      }
    }

    const tail = filter.flush();
    if (tail.length > 0) handlers.onDelta?.(tail);

    return OllamaMessage.parse({
      role: 'assistant',
      content: stripReasoning(content),
      thinking: thinking.length > 0 ? thinking : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  /** Models present locally, used to fail fast if the configured one is absent. */
  listModels(): AppResultAsync<string[]> {
    return fromPromise(
      fetch(`${this.#baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) }).then((r) =>
        r.json(),
      ),
      'ollama_unreachable',
      { retryable: true },
    )
      .andThen((json) => parseWith(TagsResponse, json, 'ollama_tags_invalid'))
      .map((data) => data.models.map((m) => m.name));
  }
}

/**
 * Coerces the configured keep-alive into a shape Ollama accepts.
 *
 * Ollama takes either a number of seconds (-1 meaning "never unload") or a Go
 * duration string like "10m". A *numeric string* is rejected outright:
 * `keep_alive: "-1"` fails with `missing unit in duration "-1"` and takes down
 * every chat request, which is a silent config footgun.
 */
export function normaliseKeepAlive(value: string): string | number {
  const trimmed = value.trim();
  if (trimmed === '') return '5m';

  const asNumber = Number(trimmed);
  return Number.isFinite(asNumber) ? asNumber : trimmed;
}

/**
 * Strips reasoning from a token stream as it arrives.
 *
 * Stateful because `<think>` and `</think>` can straddle a chunk boundary; a
 * per-chunk regex would miss a tag split across two reads and pass the whole
 * chain of thought through.
 */
export class ReasoningFilter {
  static readonly #OPEN = '<think>';
  static readonly #CLOSE = '</think>';

  #inside = false;
  #pending = '';

  push(chunk: string): string {
    this.#pending += chunk;
    let visible = '';

    for (;;) {
      if (this.#inside) {
        const close = this.#pending.indexOf(ReasoningFilter.#CLOSE);
        if (close === -1) {
          // Inside a block: nothing here is visible. Retain only what could
          // still turn out to be the start of the closing tag.
          this.#pending = keepPartialTailOf(this.#pending, ReasoningFilter.#CLOSE);
          return visible;
        }
        this.#pending = this.#pending.slice(close + ReasoningFilter.#CLOSE.length);
        this.#inside = false;
        continue;
      }

      const open = this.#pending.indexOf(ReasoningFilter.#OPEN);
      if (open === -1) {
        // Hold back only a genuine partial opening tag — a fixed-width
        // holdback would swallow the tail of ordinary content.
        const held = keepPartialTailOf(this.#pending, ReasoningFilter.#OPEN);
        visible += this.#pending.slice(0, this.#pending.length - held.length);
        this.#pending = held;
        return visible;
      }

      visible += this.#pending.slice(0, open);
      this.#pending = this.#pending.slice(open + ReasoningFilter.#OPEN.length);
      this.#inside = true;
    }
  }

  /** Emits anything held back. Call once the stream has ended. */
  flush(): string {
    if (this.#inside) {
      // Unterminated block: the remainder is reasoning, so drop it.
      this.#pending = '';
      return '';
    }
    const rest = this.#pending;
    this.#pending = '';
    return rest;
  }
}

/**
 * Returns the longest suffix of `text` that is a proper prefix of `tag`.
 *
 * This is what makes a tag split across chunk boundaries safe: only those few
 * ambiguous characters are withheld, and everything before them is released.
 */
function keepPartialTailOf(text: string, tag: string): string {
  const max = Math.min(text.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (tag.startsWith(text.slice(text.length - length))) {
      return text.slice(text.length - length);
    }
  }
  return '';
}

/**
 * Removes any reasoning that leaked into the content stream.
 *
 * Belt and braces alongside `think: true`: chat templates vary between models
 * and Ollama releases, and the failure mode — Assistant speaking its own private
 * deliberation, including invented placeholder values — is bad enough to be
 * worth defending against twice.
 */
export function stripReasoning(content: string): string {
  return (
    content
      // Complete <think>...</think> blocks.
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      // An unmatched closing tag means the opening tag came from the template,
      // so everything before it is reasoning.
      .replace(/^[\s\S]*?<\/think>/i, '')
      // An unterminated opening tag: drop from there on.
      .replace(/<think>[\s\S]*$/i, '')
      .trim()
  );
}

export const modelMissingError = (model: string, available: readonly string[]) =>
  appError(
    'ollama_model_missing',
    `Model "${model}" is not pulled. Available: ${available.join(', ') || '(none)'}. Run: ollama pull ${model}`,
  );
