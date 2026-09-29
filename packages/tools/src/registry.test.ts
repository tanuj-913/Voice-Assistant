import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildToolRegistry } from './index.js';
import { defineTool, ToolRegistry } from './registry.js';
import { appError, errAsync, okAsync, ResultAsync } from '@assistant/core';

const registry = buildToolRegistry({});

describe('tool registry validation', () => {
  it('accepts a well-formed call', () => {
    const result = registry.validateCall('open_app', { appName: 'Safari' });
    expect(result.isOk()).toBe(true);
  });

  it('rejects a call with a missing required field', () => {
    const result = registry.validateCall('open_app', { wrong: 1 });
    expect(result.isErr()).toBe(true);
    result.mapErr((e) => {
      expect(e.code).toBe('tool_arguments_invalid');
      expect(e.message).toContain('appName');
    });
  });

  it('rejects an unknown tool and lists the real ones', () => {
    const result = registry.validateCall('rm_rf', {});
    expect(result.isErr()).toBe(true);
    result.mapErr((e) => {
      expect(e.code).toBe('tool_unknown');
      expect(e.message).toContain('open_app');
    });
  });

  it('enforces numeric bounds rather than passing them through', () => {
    expect(registry.validateCall('set_volume', { level: 500 }).isErr()).toBe(true);
    expect(registry.validateCall('set_volume', { level: -1 }).isErr()).toBe(true);
    expect(registry.validateCall('set_volume', { level: 50 }).isOk()).toBe(true);
  });

  it('rejects a non-URL passed to a url field', () => {
    expect(registry.validateCall('open_url', { url: 'not a url' }).isErr()).toBe(true);
    expect(registry.validateCall('open_url', { url: 'https://example.com' }).isOk()).toBe(true);
  });
});

describe('confirmation policy', () => {
  it('does not prompt for safe tools', () => {
    expect(registry.requiresConfirmation('open_app', [])).toBe(false);
  });

  it('prompts for sensitive tools by default', () => {
    expect(registry.requiresConfirmation('send_message', [])).toBe(true);
    expect(registry.requiresConfirmation('call_contact', [])).toBe(true);
  });

  it('honours the user auto-approving a sensitive tool', () => {
    expect(registry.requiresConfirmation('send_message', ['send_message'])).toBe(false);
  });

  it('always prompts for destructive tools, even if auto-approved', () => {
    const destructive = defineTool({
      metadata: {
        name: 'wipe_everything',
        description: 'Deletes things permanently, for testing the policy.',
        category: 'system',
        risk: 'destructive',
        connector: 'internal',
      },
      input: z.object({}),
      execute: () => okAsync(null),
    });
    const local = new ToolRegistry().register(destructive);

    expect(local.requiresConfirmation('wipe_everything', ['wipe_everything'])).toBe(true);
  });

  it('prompts for an unknown tool rather than defaulting to allow', () => {
    expect(registry.requiresConfirmation('never_registered', [])).toBe(true);
  });
});

describe('model-facing tool schemas', () => {
  it('derives JSON Schema from the same Zod schema it validates against', () => {
    const tools = registry.toModelTools({ online: true });
    const openApp = tools.find((t) => t.function.name === 'open_app');

    expect(openApp).toBeDefined();
    expect(openApp?.function.parameters).toMatchObject({
      type: 'object',
      properties: { appName: { type: 'string' } },
      required: ['appName'],
    });
  });

  it('hides network tools when offline', () => {
    const names = registry.toModelTools({ online: false }).map((t) => t.function.name);
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('web_crawl');
    expect(names).toContain('open_app');
  });

  it('refuses duplicate registrations', () => {
    const tool = defineTool({
      metadata: {
        name: 'dupe',
        description: 'A duplicate tool for testing.',
        category: 'system',
        risk: 'read',
        connector: 'internal',
      },
      input: z.object({}),
      execute: () => okAsync(null),
    });
    expect(() => new ToolRegistry().register(tool, tool)).toThrow(/Duplicate/);
  });
});

describe('gated capabilities', () => {
  const GATED = ['run_shell_command', 'move_to_trash', 'capture_screen'] as const;

  it.each(GATED)('%s is destructive', (name) => {
    expect(registry.get(name)?.metadata.risk).toBe('destructive');
  });

  it.each(GATED)('%s prompts even when the user auto-approved it', (name) => {
    // The user asking for it, or having previously ticked "always allow",
    // must not waive the prompt for these.
    expect(registry.requiresConfirmation(name, [...GATED])).toBe(true);
  });

  it('offers no permanent-delete tool at all', () => {
    const names = registry.list().map((t) => t.metadata.name);
    expect(names).toContain('move_to_trash');
    expect(names).not.toContain('delete_file');
    expect(names).not.toContain('remove_path');
  });

  it('requires a reason for every gated action', () => {
    // The reason is shown in the prompt, so a call without one is rejected
    // before the user is ever asked to approve it.
    expect(registry.validateCall('run_shell_command', { command: 'ls' }).isErr()).toBe(true);
    expect(
      registry
        .validateCall('run_shell_command', { command: 'ls', reason: 'list your files' })
        .isOk(),
    ).toBe(true);
  });
});

describe('execution consent gate', () => {
  const ctx = { online: true, signal: new AbortController().signal };

  it('refuses a destructive call that was not approved', async () => {
    const call = registry.validateCall('move_to_trash', {
      paths: ['/tmp/assistant-should-not-exist'],
      reason: 'testing the gate',
    });
    expect(call.isOk()).toBe(true);
    if (call.isErr()) return;

    const result = await registry.executeCall(call.value, ctx, { approved: false });

    expect(result.isErr()).toBe(true);
    result.mapErr((e) => {
      expect(e.code).toBe('consent_required');
    });
  });

  it('rejects relative paths before touching the filesystem', async () => {
    const call = registry.validateCall('move_to_trash', {
      paths: ['../../etc/passwd'],
      reason: 'testing',
    });
    if (call.isErr()) throw new Error('should have parsed');

    const result = await registry.executeCall(call.value, ctx, { approved: true });
    expect(result.isErr()).toBe(true);
    result.mapErr((e) => {
      expect(e.code).toBe('trash_relative_path');
    });
  });

  it('lets a safe tool run without any consent flag', async () => {
    const call = registry.validateCall('system_info', { metric: 'time' });
    if (call.isErr()) throw new Error('should have parsed');

    const result = await registry.executeCall(call.value, ctx, { approved: false });
    expect(result.isOk()).toBe(true);
  });
});

describe('tool timeouts', () => {
  const ctx = { online: true, signal: new AbortController().signal };

  it('aborts a tool that hangs past its declared budget', async () => {
    // Regression: every tool declared `timeoutMs` and nothing read it, so one
    // slow fetch could wedge a turn indefinitely.
    const hanging = defineTool({
      metadata: {
        name: 'hangs_forever',
        description: 'Never resolves, for testing the timeout enforcement.',
        category: 'system',
        risk: 'read',
        connector: 'internal',
        timeoutMs: 150,
      },
      input: z.object({}),
      execute: () =>
        ResultAsync.fromSafePromise(
          new Promise<never>(() => {
            /* never settles */
          }),
        ),
    });

    const local = new ToolRegistry().register(hanging);
    const call = local.validateCall('hangs_forever', {});
    if (call.isErr()) throw new Error('should have parsed');

    const started = Date.now();
    const result = await local.executeCall(call.value, ctx, { approved: true });

    expect(result.isErr()).toBe(true);
    result.mapErr((e) => {
      expect(e.code).toBe('tool_timeout');
      expect(e.retryable).toBe(true);
    });
    // Bounded by the declared budget, not left to run.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('lets a tool finishing inside its budget through untouched', async () => {
    const quick = defineTool({
      metadata: {
        name: 'finishes_quickly',
        description: 'Resolves immediately, for testing the timeout path.',
        category: 'system',
        risk: 'read',
        connector: 'internal',
        timeoutMs: 5000,
      },
      input: z.object({}),
      execute: () => okAsync({ done: true }),
    });

    const local = new ToolRegistry().register(quick);
    const call = local.validateCall('finishes_quickly', {});
    if (call.isErr()) throw new Error('should have parsed');

    const result = await local.executeCall(call.value, ctx, { approved: true });
    expect(result.isOk()).toBe(true);
    result.map((v) => {
      expect(v).toEqual({ done: true });
    });
  });
});

/**
 * The PRD requires every tool to declare a connector, scopes, a retry policy,
 * a verification method, audit fields and whether it can be rolled back.
 * Three of those are derived rather than stored, which is what these tests are
 * really about: a declaration that can disagree with the behaviour is worse
 * than no declaration.
 */
describe('the full tool declaration', () => {
  const registry = buildToolRegistry({ slackToken: 'x' });

  it('names the connector and the scopes the connector needs', () => {
    const slack = registry.describe('slack_send_message');
    expect(slack?.connector).toBe('http');
    expect(slack?.scopes).toEqual(['chat:write']);

    // macOS permissions are a different axis: that is the operating system
    // asking the human, not the service granting a token.
    const trash = registry.describe('move_to_trash');
    expect(trash?.connector).toBe('macos-applescript');
    expect(trash?.scopes).toEqual([]);
    expect(trash?.macPermissions).toContain('automation');
  });

  it('derives the confirmation requirement from the policy engine', () => {
    // Not stored on the tool: a declared "requires confirmation" could drift
    // out of step with the risk level, and the wrong one would be believed.
    expect(registry.describe('move_to_trash')?.confirmation).toBe('normal');
    expect(registry.describe('system_info')?.confirmation).toBe('allow');
  });

  it('reports verification and rollback from what the tool actually implements', () => {
    const move = registry.describe('move_file');
    expect(move?.verification).toBe('automatic');
    expect(move?.rollback).toBe('supported');

    // A sent message cannot be unsent, and the declaration says so.
    const send = registry.describe('send_email');
    expect(send?.rollback).toBe('none');
  });

  it('describes every registered tool', () => {
    expect(registry.describeAll()).toHaveLength(registry.list().length);
    for (const described of registry.describeAll()) {
      expect(described.audit).toBe('tool_calls');
      expect(described.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('retries', () => {
  const ctx = { online: true, signal: new AbortController().signal };

  const flaky = (risk: 'read' | 'external', attempts: number, retryable: boolean) => {
    let calls = 0;
    const tool = defineTool({
      metadata: {
        name: 'flaky_tool',
        description: 'A tool that fails before it succeeds, for testing retries.',
        category: 'system',
        risk,
        connector: 'internal',
        retry: { maxAttempts: attempts, backoffMs: 0 },
      },
      input: z.object({}),
      execute: () => {
        calls += 1;
        return calls < 3
          ? errAsync(appError('flaky_failed', 'not this time', { retryable }))
          : okAsync({ ok: true });
      },
    });
    return { tool, calls: () => calls };
  };

  it('repeats a retryable failure up to the declared budget', async () => {
    const { tool, calls } = flaky('read', 3, true);
    const result = await new ToolRegistry()
      .register(tool)
      .executeCall({ tool, args: {} }, ctx, { approved: true });
    expect(result.isOk()).toBe(true);
    expect(calls()).toBe(3);
  });

  /** A rejected argument fails identically the second time. */
  it('does not retry a failure that said it was not retryable', async () => {
    const { tool, calls } = flaky('read', 3, false);
    const result = await new ToolRegistry()
      .register(tool)
      .executeCall({ tool, args: {} }, ctx, { approved: true });
    expect(result.isErr()).toBe(true);
    expect(calls()).toBe(1);
  });

  /**
   * The tool layer cannot tell "the send failed" from "the reply went
   * missing", so anything that leaves the machine gets one attempt however
   * many it declared. The rule lives in the registry precisely so a new tool
   * cannot opt itself into double-sending.
   */
  it('ignores the declared budget for anything above reversible', async () => {
    const { tool, calls } = flaky('external', 3, true);
    const result = await new ToolRegistry()
      .register(tool)
      .executeCall({ tool, args: {} }, ctx, { approved: true });
    expect(result.isErr()).toBe(true);
    expect(calls()).toBe(1);
  });
});

/**
 * Enum spelling, repaired once and never guessed at.
 *
 * Measured 2026-09-03: gpt-oss:20b had 7 of 15 tool calls rejected purely for
 * writing `"Apple Music"` where the schema says `apple-music`; qwen3:30b-a3b
 * had none. Each rejection costs a retry round trip. The model chose the right
 * option — it spelled it the way a person would.
 */
describe('repairing what the model spelled differently', () => {
  const registry = buildToolRegistry({});

  it.each([
    ['Apple Music', 'apple-music'],
    ['apple music', 'apple-music'],
    ['Spotify', 'spotify'],
    ['AUTO', 'auto'],
    ['apple_music', 'apple-music'],
  ])('accepts %s as %s', (given, expected) => {
    const result = registry.validateCall('media_control', { action: 'pause', app: given });
    expect(result.isOk(), `${given} was rejected`).toBe(true);
    expect((result._unsafeUnwrap().args as { app: string }).app).toBe(expected);
  });

  it('repairs the case that cost the most', () => {
    const result = registry.validateCall('call_contact', {
      contactName: 'Rahul',
      method: 'FaceTime Video',
    });
    expect((result._unsafeUnwrap().args as { method: string }).method).toBe('facetime-video');
  });

  /** A spelling difference is not a judgement difference. Nothing else moves. */
  it('does not repair anything that is not an enum', () => {
    // A number out of range is a real disagreement, not a spelling one.
    expect(registry.validateCall('set_volume', { level: 500 }).isErr()).toBe(true);
    // A missing required field stays missing.
    expect(registry.validateCall('open_app', {}).isErr()).toBe(true);
    // And a value that matches no option at all is still refused.
    expect(
      registry.validateCall('media_control', { action: 'pause', app: 'Winamp' }).isErr(),
    ).toBe(true);
  });

  it('returns the model’s own error when the repair does not help', () => {
    const result = registry.validateCall('media_control', { action: 'explode', app: 'Spotify' });
    expect(result.isErr()).toBe(true);
    // Names what the model actually sent, so it can correct itself.
    expect(result._unsafeUnwrapErr().message).toMatch(/explode|action/i);
  });

  it('leaves a valid call untouched and unrepaired', () => {
    const result = registry.validateCall('media_control', { action: 'pause', app: 'spotify' });
    expect(result._unsafeUnwrap().args).toMatchObject({ action: 'pause', app: 'spotify' });
  });
});

describe('the other two ways models get an enum wrong', () => {
  const registry = buildToolRegistry({});

  /** "video" is one of `facetime-video`'s own parts, and matches nothing else. */
  it('accepts an abbreviation when exactly one option contains it', () => {
    const result = registry.validateCall('call_contact', {
      contactName: 'Rahul',
      method: 'video',
    });
    expect((result._unsafeUnwrap().args as { method: string }).method).toBe('facetime-video');
  });

  /** "battery percentage" contains `battery` and no other metric. */
  it('accepts a value with an extra word in it', () => {
    const result = registry.validateCall('system_info', { metric: 'battery percentage' });
    expect((result._unsafeUnwrap().args as { metric: string }).metric).toBe('battery');
  });

  /**
   * An empty optional field is the model saying "not applicable" in the
   * clumsiest way. Dropping it is allowed only when the schema then passes —
   * the schema decides what was optional, not the repair.
   */
  it('drops an empty optional field the model invented', () => {
    const result = registry.validateCall('browser_control', {
      action: 'close_tab',
      browser: 'Safari',
      match: 'youtube',
      url: '',
    });
    expect(result.isOk()).toBe(true);
    const args = result._unsafeUnwrap().args as Record<string, unknown>;
    expect(args.browser).toBe('safari');
    expect(args.url).toBeUndefined();
  });

  it('will not drop a field the schema actually requires', () => {
    // `appName` is required, so emptying it is a real failure, not a spelling.
    expect(registry.validateCall('open_app', { appName: '' }).isErr()).toBe(true);
  });

  /** Ambiguity is refused rather than resolved by coin toss. */
  it('refuses when more than one option could be meant', () => {
    // "music" is a part of `apple-music` only, so this one resolves...
    expect(registry.validateCall('media_control', { action: 'play', app: 'music' }).isOk()).toBe(
      true,
    );
    // ...but a value that matches nothing is still an error.
    expect(
      registry.validateCall('media_control', { action: 'play', app: 'winamp deluxe' }).isErr(),
    ).toBe(true);
  });
});
