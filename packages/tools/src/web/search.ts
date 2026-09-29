import { appError, errAsync, fromPromise, okAsync, parseWith } from '@assistant/core';
import { WebSearchInput } from '@assistant/schemas';
import { z } from 'zod';
import { defineTool } from '../registry.js';

/**
 * Web search.
 *
 * Serper is the provider: it returns Google results, and crucially it returns
 * Google's answer box and knowledge panel. For a voice assistant that matters
 * more than ranking — an answer box is already the one-sentence reply Assistant
 * should say, where ten links are something it has to summarise and might get
 * wrong.
 *
 * DuckDuckGo remains only as a keyless fallback. It is HTML scraping and is
 * throttled aggressively, so it is a last resort rather than a peer.
 */

// --- Serper -----------------------------------------------------------------

const SerperResponse = z.object({
  organic: z
    .array(
      z.object({
        title: z.string(),
        link: z.string(),
        snippet: z.string().default(''),
        date: z.string().nullish(),
      }),
    )
    .default([]),
  /** Google's direct answer, when it has one. */
  answerBox: z
    .object({
      title: z.string().nullish(),
      answer: z.string().nullish(),
      snippet: z.string().nullish(),
    })
    .nullish(),
  knowledgeGraph: z
    .object({
      title: z.string().nullish(),
      type: z.string().nullish(),
      description: z.string().nullish(),
    })
    .nullish(),
});

export interface WebSearchDeps {
  serperApiKey?: string | undefined;
  region?: string;
  language?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export function createWebSearchTool(deps: WebSearchDeps) {
  return defineTool({
    metadata: {
      name: 'web_search',
      description:
        'Search the web for current information. Use for news, prices, weather, anything recent, or any fact you are not certain of.',
      category: 'web',
      risk: 'read',
      connector: 'http',
      // Someone else's server, read-only: a failed request is worth one
      // more try, and repeating it changes nothing.
      retry: { maxAttempts: 2, backoffMs: 400 },
      scopes: ['SERPER_API_KEY'],
      requiresNetwork: true,
      timeoutMs: 20_000,
    },
    input: WebSearchInput,
    execute: (args, ctx) => {
      if (deps.serperApiKey) return searchSerper(deps, deps.serperApiKey, args, ctx.signal);
      return searchDuckDuckGo(args, ctx.signal);
    },
  });
}

function searchSerper(
  deps: WebSearchDeps,
  key: string,
  args: { query: string; maxResults: number },
  signal: AbortSignal,
) {
  return fromPromise(
    fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        q: args.query,
        num: args.maxResults,
        gl: deps.region ?? 'in',
        hl: deps.language ?? 'en',
      }),
      signal,
    }).then(async (response) => {
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Serper responded ${String(response.status)}: ${detail.slice(0, 200)}`);
      }
      return await response.json();
    }),
    'web_search_failed',
    { retryable: true },
  )
    .andThen((json) => parseWith(SerperResponse, json, 'web_search_response_invalid'))
    .map((data) => {
      // Surfaced separately rather than folded into the result list: this is a
      // direct answer, and Assistant should lead with it instead of paraphrasing
      // ten snippets that all say the same thing.
      const direct =
        data.answerBox?.answer ??
        data.answerBox?.snippet ??
        data.knowledgeGraph?.description ??
        null;

      return {
        provider: 'serper',
        ...(direct ? { directAnswer: direct } : {}),
        results: data.organic.slice(0, args.maxResults).map((r) => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet,
          ...(r.date ? { date: r.date } : {}),
        })),
      };
    });
}

function searchDuckDuckGo(args: { query: string; maxResults: number }, signal: AbortSignal) {
  const ddg = new URL('https://html.duckduckgo.com/html/');
  ddg.searchParams.set('q', args.query);

  return fromPromise(
    fetch(ddg, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal,
    }).then((r) => r.text()),
    'web_search_failed',
    { retryable: true },
  ).andThen((html) => {
    const results = parseDuckDuckGo(html).slice(0, args.maxResults);
    if (results.length > 0) return okAsync({ provider: 'duckduckgo', results });

    // Empty is ambiguous, and the two cases must not be conflated. A genuine
    // no-match should let the model say "I found nothing"; a block must not,
    // because that sentence would be false.
    if (looksBlocked(html)) {
      return errAsync(
        appError(
          'web_search_blocked',
          'DuckDuckGo is rate limiting automated searches. Set SERPER_API_KEY for reliable search.',
          { retryable: true },
        ),
      );
    }
    return okAsync({ provider: 'duckduckgo', results: [] });
  });
}

/**
 * Recognises DuckDuckGo's block page. It answers HTTP 202 with a
 * normal-looking document, so the status code is no help.
 */
function looksBlocked(html: string): boolean {
  return /anomaly|unusual traffic|captcha|blocked/i.test(html) && !html.includes('result__a');
}

function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = snippetPattern.exec(html)) !== null) {
    snippets.push(stripTags(s[1] ?? ''));
  }

  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = linkPattern.exec(html)) !== null) {
    const href = decodeDuckDuckGoHref(m[1] ?? '');
    if (href) {
      hits.push({ title: stripTags(m[2] ?? ''), url: href, snippet: snippets[index] ?? '' });
    }
    index += 1;
  }
  return hits;
}

/** DuckDuckGo wraps results in a redirect with the real URL in `uddg`. */
function decodeDuckDuckGoHref(href: string): string | null {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ?? (url.protocol.startsWith('http') ? url.toString() : null);
  } catch {
    return null;
  }
}

export function stripTags(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
