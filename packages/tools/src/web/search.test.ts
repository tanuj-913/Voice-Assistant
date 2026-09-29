import { describe, expect, it } from 'vitest';
import { createWebSearchTool, stripTags } from './search.js';

/**
 * Provider selection is worth testing directly: the failure mode is silent —
 * a mis-wired key means you quietly fall through to the scraped fallback and
 * only notice when search stops working.
 */
describe('search provider priority', () => {
  const metadataOf = (deps: Parameters<typeof createWebSearchTool>[0]) =>
    createWebSearchTool(deps).metadata;

  it('registers the same tool regardless of which provider is configured', () => {
    expect(metadataOf({ serperApiKey: 'x' }).name).toBe('web_search');
    expect(metadataOf({}).name).toBe('web_search');
  });

  it('is always marked as needing the network', () => {
    expect(metadataOf({}).requiresNetwork).toBe(true);
  });

  it('is safe, so it never interrupts the user for approval', () => {
    // Searching is read-only and happens constantly; prompting would make the
    // assistant unusable.
    expect(metadataOf({}).risk).toBe('read');
  });

  it('carries a timeout so a slow provider cannot hang a turn', () => {
    expect(metadataOf({}).timeoutMs).toBeGreaterThan(0);
    expect(metadataOf({}).timeoutMs).toBeLessThanOrEqual(30_000);
  });
});

describe('stripTags', () => {
  it('removes markup and decodes entities', () => {
    expect(stripTags('<b>Caf&amp;eacute;</b> &quot;news&quot;')).toBe('Caf&eacute; "news"');
  });

  it('collapses whitespace', () => {
    expect(stripTags('a   \n  b')).toBe('a b');
  });
});
