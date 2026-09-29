import { appError, err, errAsync, fromPromise, ok } from '@assistant/core';
import { WebCrawlInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { stripTags } from './search.js';

/** Blocked so a crawl tool cannot be turned into a local network scanner. */
const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const PRIVATE_RANGES = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/i;

export const webCrawlTool = defineTool({
  metadata: {
    name: 'web_crawl',
    description:
      'Fetch a web page and extract its readable text. Use after web_search when a result needs reading in full.',
    category: 'web',
    risk: 'read',
    connector: 'http',
    // Someone else's server, read-only: a failed request is worth one
    // more try, and repeating it changes nothing.
    retry: { maxAttempts: 2, backoffMs: 400 },
    requiresNetwork: true,
    timeoutMs: 25_000,
  },
  input: WebCrawlInput,
  execute: (args, ctx) => {
    const guard = assertPublicUrl(args.url);
    if (guard.isErr()) return errAsync(guard.error);

    return fromPromise(
      fetch(args.url, {
        headers: { 'User-Agent': 'AssistantAssistant/0.1 (+local)' },
        signal: ctx.signal,
        redirect: 'follow',
      }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);

        const contentType = response.headers.get('content-type') ?? '';
        if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
          throw new Error(`Unsupported content type: ${contentType}`);
        }
        return response.text();
      }),
      'crawl_failed',
      { retryable: true },
    ).map((html) => {
      const text = extractReadableText(html);
      return {
        url: args.url,
        title: extractTitle(html),
        text: text.slice(0, args.maxChars),
        truncated: text.length > args.maxChars,
      };
    });
  },
});

export function assertPublicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(appError('crawl_invalid_url', `Not a valid URL: ${raw}`));
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return err(appError('crawl_blocked_scheme', `Only http and https are allowed`));
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || PRIVATE_RANGES.test(host)) {
    return err(appError('crawl_blocked_host', 'Refusing to crawl a private or loopback address'));
  }
  return ok(url);
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? stripTags(match[1] ?? '') : null;
}

/**
 * Strips non-content elements then flattens to text.
 *
 * Deliberately simple — good enough to feed a model, and avoids pulling a
 * full DOM parser into the dependency tree for a best-effort extraction.
 */
function extractReadableText(html: string): string {
  return stripTags(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n'),
  );
}
