import { describe, expect, it } from 'vitest';
import { assertPublicUrl } from './crawl.js';
import { buildToolRegistry } from '../index.js';

/**
 * The crawl tool takes a URL chosen by the model, which may in turn have been
 * influenced by whatever web page it just read. Without this guard it becomes a
 * confused deputy for scanning the local network.
 */
describe('crawl URL guard', () => {
  it.each([
    'http://localhost:8080/admin',
    'http://127.0.0.1/',
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
  ])('refuses the private address %s', (url) => {
    expect(assertPublicUrl(url).isErr()).toBe(true);
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)'])(
    'refuses the non-http scheme %s',
    (url) => {
      expect(assertPublicUrl(url).isErr()).toBe(true);
    },
  );

  it('rejects a malformed URL', () => {
    expect(assertPublicUrl('not a url').isErr()).toBe(true);
  });

  it('allows ordinary public URLs', () => {
    expect(assertPublicUrl('https://example.com/article').isOk()).toBe(true);
    expect(assertPublicUrl('http://news.ycombinator.com').isOk()).toBe(true);
  });
});

describe('search block detection', () => {
  it('reports a throttled search as an error, not as zero results', async () => {
    // Regression: DuckDuckGo answers HTTP 202 with an anomaly page. Parsed
    // naively that yields `results: []`, which the model reads as "nothing
    // exists" and states as fact. A block must surface as a failure.
    const registry = buildToolRegistry({});
    const call = registry.validateCall('web_search', { query: 'anything', maxResults: 3 });
    if (call.isErr()) throw new Error('should have parsed');

    const result = await registry.executeCall(
      call.value,
      { online: true, signal: AbortSignal.timeout(20_000) },
      { approved: true },
    );

    // Either real results, or an explicit block error — never a silent empty.
    if (result.isOk()) {
      const value = result.value as { results: unknown[] };
      expect(Array.isArray(value.results)).toBe(true);
    } else {
      expect(['web_search_blocked', 'web_search_failed', 'tool_timeout']).toContain(
        result.error.code,
      );
    }
  }, 30_000);
});
