import { appError, fromPromise, type AppResultAsync } from '@assistant/core';
import {
  OllamaMessage,
  type ChatStreamHandlers,
  type OllamaChatRequest,
  type OutboundMessage,
} from './ollama.js';

/**
 * Gemini, as a stand-in for the local model on turns the fast path cannot
 * route.
 *
 * The case for it is one measurement: an unrouted turn spends 5–8 s generating
 * reasoning tokens at ~32 tok/s, and no local model tested is both fast enough
 * and trustworthy enough to fix that. A hosted model runs an order of
 * magnitude faster, which is the only route to the PRD's ≤3 s for arbitrary
 * requests.
 *
 * The case against it is the first line of the PRD: local-first. So this is
 * off unless `CLOUD_FALLBACK=true` **and** a key is set, it is skipped
 * entirely when the user has chosen `offlineFirst`, and every turn it handles
 * leaves the machine — which the boot log says out loud rather than burying.
 *
 * It speaks the same interface as the Ollama client, translating at the
 * boundary, so nothing upstream knows which model answered.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Keys Gemini's schema subset rejects outright. */
const UNSUPPORTED = new Set([
  '$schema',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'const',
  'default',
  'examples',
  'patternProperties',
  'definitions',
  '$defs',
  '$ref',
]);

/**
 * Zod produces draft-7 JSON Schema; Gemini accepts a subset of OpenAPI 3.0 and
 * **rejects the whole request** on an unknown key rather than ignoring it. One
 * `additionalProperties: false` in one tool would take every tool down with
 * it, so this is pruned rather than hoped about.
 */
export function sanitiseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitiseSchema);
  if (typeof schema !== 'object' || schema === null) return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED.has(key)) continue;
    // Zod writes `type: ['string', 'null']` for nullables; Gemini wants one
    // type and a nullable flag.
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t): t is string => typeof t === 'string' && t !== 'null');
      out.type = types[0] ?? 'string';
      if (value.includes('null')) out.nullable = true;
      continue;
    }
    out[key] = sanitiseSchema(value);
  }
  return out;
}

/** Ollama's tool shape → Gemini's `functionDeclarations`. */
export function toGeminiTools(tools: readonly unknown[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  const declarations = tools.flatMap((tool) => {
    const fn = (
      tool as { function?: { name?: string; description?: string; parameters?: unknown } }
    ).function;
    if (!fn?.name) return [];
    return [
      {
        name: fn.name,
        description: fn.description ?? '',
        parameters: sanitiseSchema(fn.parameters),
      },
    ];
  });
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

/**
 * Ollama's flat message list → Gemini's `contents` plus a separate system
 * instruction.
 *
 * Gemini has no `system` role and no `tool` role: the system prompt is its own
 * field, a tool result is a `functionResponse` part on a `user` turn, and the
 * model's own tool call is a `functionCall` part on a `model` turn.
 */
export function toGeminiContents(messages: readonly OutboundMessage[]) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

  const contents: { role: 'user' | 'model'; parts: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      let payload: unknown;
      try {
        payload = JSON.parse(message.content);
      } catch {
        // A tool that returned plain text is still a result; wrapping it keeps
        // the shape Gemini requires without inventing structure.
        payload = { result: message.content };
      }
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.tool_name ?? 'tool',
              response:
                typeof payload === 'object' && payload !== null ? payload : { result: payload },
            },
          },
        ],
      });
      continue;
    }

    const parts: unknown[] = [];
    if (message.content.length > 0) parts.push({ text: message.content });
    for (const call of message.tool_calls ?? []) {
      parts.push({
        functionCall: {
          name: call.function.name,
          args: (call.function.arguments ?? {}) as Record<string, unknown>,
        },
      });
    }
    // Gemini rejects an empty parts array.
    if (parts.length === 0) continue;
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }

  return { system, contents };
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** Injected so tests do not reach the network. */
  fetchImpl?: typeof fetch;
}

export class GeminiClient {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(options: GeminiOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.#model;
  }

  /** Boot check: names the models this key can actually reach. */
  listModels(): AppResultAsync<string[]> {
    return fromPromise(
      (async () => {
        const response = await this.#fetch(`${BASE}/models?key=${this.#apiKey}`);
        if (!response.ok) throw new Error(`Gemini responded ${String(response.status)}`);
        const body = (await response.json()) as { models?: { name?: string }[] };
        return (body.models ?? [])
          .map((m) => (m.name ?? '').replace(/^models\//, ''))
          .filter((name) => name.length > 0);
      })(),
      'gemini_list_models_failed',
    );
  }

  chat(
    request: OllamaChatRequest,
    handlers: ChatStreamHandlers = {},
  ): AppResultAsync<OllamaMessage> {
    return fromPromise(this.#stream(request, handlers), 'gemini_chat_failed', { retryable: true });
  }

  async #stream(request: OllamaChatRequest, handlers: ChatStreamHandlers): Promise<OllamaMessage> {
    const { system, contents } = toGeminiContents(request.messages);
    const tools = toGeminiTools(request.tools);

    const body = {
      contents,
      ...(system.length > 0 ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(tools ? { tools } : {}),
      generationConfig: {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      },
    };

    const response = await this.#fetch(
      `${BASE}/models/${this.#model}:streamGenerateContent?alt=sse&key=${this.#apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      // 429 is the one worth naming: the free tier's limits are low enough
      // that a long prompt can exhaust a minute's budget in one request.
      throw new Error(
        response.status === 429
          ? `Gemini rate limit reached (${detail.slice(0, 200)})`
          : `Gemini responded ${String(response.status)}: ${detail.slice(0, 300)}`,
      );
    }

    let text = '';
    const toolCalls: { function: { name: string; arguments: unknown } }[] = [];

    // Typed explicitly: `body` is `any` at the DOM boundary, and an untyped
    // chunk here would flow untracked into the decoder.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // SSE frames arrive split across chunks; only whole `data:` lines parse.
    for (;;) {
      // Annotated by hand: `ReadableStreamReadResult` is not in this project's
      // lib set, and an implicit `any` here would flow into the decoder.
      const chunk: { done: boolean; value: Uint8Array | undefined } = await reader.read();
      if (chunk.done || !chunk.value) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || payload.length === 0) continue;

        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const parts =
          (chunk as { candidates?: { content?: { parts?: unknown[] } }[] }).candidates?.[0]?.content
            ?.parts ?? [];
        for (const part of parts) {
          const asText = (part as { text?: unknown }).text;
          if (typeof asText === 'string' && asText.length > 0) {
            text += asText;
            // Streamed through so speech still starts at the first sentence
            // rather than at the end of the reply.
            handlers.onDelta?.(asText);
          }
          const call = (part as { functionCall?: { name?: string; args?: unknown } }).functionCall;
          if (call?.name) {
            toolCalls.push({ function: { name: call.name, arguments: call.args ?? {} } });
          }
        }
      }
    }

    return OllamaMessage.parse({
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
}

export function geminiUnavailable(reason: string) {
  return appError('gemini_unavailable', reason, { retryable: false });
}
