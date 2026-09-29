import { childLogger, type AppResultAsync } from '@assistant/core';
import type { GeminiClient } from './gemini.js';
import type {
  ChatStreamHandlers,
  OllamaChatRequest,
  OllamaClient,
  OllamaMessage,
} from './ollama.js';

const log = childLogger('llm');

/**
 * The seam between the model on this machine and the one that is not.
 *
 * Everything upstream calls `chat` and does not know which answered. Three
 * rules decide, in order, and none of them is the model's to influence:
 *
 * 1. **The user's own setting wins.** `offlineFirst` means never cloud, even
 *    when a key is configured and the cloud would be faster. Someone who asked
 *    to stay local did not mean "unless it is slow".
 * 2. **Offline means local.** Obviously, but stated because the failure would
 *    otherwise be a timeout rather than an answer.
 * 3. **A cloud failure falls back to local**, once, rather than failing the
 *    turn. A rate limit on a free tier is an expected condition, not an
 *    outage — the reply is slower, not absent.
 *
 * What it deliberately does *not* do is split a single turn across both
 * models. A tool call chosen by one and phrased by the other would be two
 * different assistants sharing a voice.
 */
export interface LlmClient {
  chat(request: OllamaChatRequest, handlers?: ChatStreamHandlers): AppResultAsync<OllamaMessage>;
}

export interface RouterOptions {
  local: OllamaClient;
  cloud: GeminiClient | null;
  /** Read per turn, so turning `offlineFirst` on takes effect immediately. */
  offlineFirst: () => boolean;
  isOnline: () => boolean;
}

export function createLlmRouter(options: RouterOptions): LlmClient {
  const { local, cloud, offlineFirst, isOnline } = options;

  return {
    chat(request, handlers = {}) {
      // Narrowed here rather than re-checked below: `cloud` is fixed for the
      // life of the router, so a second guard would be dead code.
      if (cloud === null || offlineFirst() || !isOnline()) return local.chat(request, handlers);

      return cloud.chat({ ...request, model: cloud.model }, handlers).orElse((error) => {
        log.warn({ error, model: cloud.model }, 'cloud model failed, answering locally');
        // Handlers are passed again on purpose: if the cloud produced no
        // deltas there is nothing to undo, and if it produced some the
        // sentence stream has already spoken them. Partial-then-local is
        // still a complete answer, where a failed turn is not.
        return local.chat(request, handlers);
      });
    },
  };
}
