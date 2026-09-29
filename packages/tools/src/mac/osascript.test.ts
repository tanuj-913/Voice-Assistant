import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runAppleScript } from './osascript.js';

/**
 * These are integration tests against the real `osascript` binary.
 *
 * The claim being tested — that model-supplied arguments cannot become
 * executable script — is the single most important security property in this
 * codebase, so it is verified against the actual interpreter rather than a mock.
 */
const CANARY = '/tmp/assistant-test-canary.txt';

afterEach(() => {
  rmSync(CANARY, { force: true });
});

describe('AppleScript argument handling', () => {
  it('passes arguments through as inert data', async () => {
    const result = await runAppleScript(['return item 1 of argv'], ['Safari']);
    expect(result.isOk()).toBe(true);
    result.map((value) => {
      expect(value).toBe('Safari');
    });
  });

  it.each([
    ['string-break', `Safari" & (do shell script "touch ${CANARY}") & "`],
    ['statement-break', `"; do shell script "touch ${CANARY}"; "`],
    ['concat-injection', `x" & (do shell script "echo pwned > ${CANARY}") & "y`],
    ['backslash', `Safari\\" & (do shell script "touch ${CANARY}") & \\"`],
  ])('treats a %s payload as literal text', async (_name, payload) => {
    const result = await runAppleScript(['return item 1 of argv'], [payload]);

    expect(result.isOk()).toBe(true);
    result.map((value) => {
      // Echoed back verbatim: parsed as data, never as script.
      expect(value).toBe(payload);
    });
    expect(existsSync(CANARY)).toBe(false);
  });

  it('rejects a null byte rather than passing it to the shell', async () => {
    const result = await runAppleScript(['return item 1 of argv'], ['bad\0value']);
    expect(result.isErr()).toBe(true);
  });

  it('surfaces a script error as a typed failure instead of throwing', async () => {
    const result = await runAppleScript(['error "deliberate failure"'], []);
    expect(result.isErr()).toBe(true);
    result.mapErr((e) => {
      expect(e.code).toBe('osascript_failed');
    });
  });
});
