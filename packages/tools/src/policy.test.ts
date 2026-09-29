import { describe, expect, it } from 'vitest';
import { ToolMetadata, UserSettings, type RiskLevel } from '@assistant/schemas';
import { decide } from './policy.js';
import { buildToolRegistry } from './index.js';

/**
 * The PRD's mandatory rule: the model may propose a tool call but cannot grant
 * itself permission. These tests pin the two halves of that — the escalation
 * table, and the places where a user preference is deliberately *not* allowed
 * to relax the gate.
 */

const meta = (risk: RiskLevel, extra: Partial<ToolMetadata> = {}) =>
  ToolMetadata.parse({
    name: 'a_tool',
    description: 'A tool used for testing policy decisions.',
    category: 'system',
    connector: 'internal',
    risk,
    ...extra,
  });

const ctx = (settings: Partial<UserSettings> = {}, online = true) => ({
  settings: UserSettings.parse(settings),
  online,
});

describe('escalation', () => {
  it.each([
    ['read', 'allow'],
    ['reversible', 'allow'],
    ['external', 'confirm'],
    ['destructive', 'confirm'],
    ['critical', 'confirm'],
  ] as const)('%s → %s', (risk, action) => {
    expect(decide(meta(risk), ctx()).action).toBe(action);
  });

  it('asks for platform authentication only at critical', () => {
    const critical = decide(meta('critical'), ctx());
    const destructive = decide(meta('destructive'), ctx());
    expect(critical.action === 'confirm' && critical.strength).toBe('strong');
    expect(destructive.action === 'confirm' && destructive.strength).toBe('normal');
  });

  it('explains why, so an approval card can show the consequence', () => {
    const decision = decide(meta('external', { name: 'send_message' }), ctx());
    expect(decision.action === 'confirm' && decision.reason).toMatch(/cannot be taken back/);
  });
});

describe('what a preference may and may not relax', () => {
  it('lets a user pre-approve an external action', () => {
    const settings = ctx({ autoApprovedTools: ['a_tool'] });
    expect(decide(meta('external'), settings).action).toBe('allow');
  });

  /**
   * The important one. A blanket approval collected once, for something
   * harmless, must never become authority to delete things later.
   */
  it('refuses to let pre-approval unlock a destructive action', () => {
    const settings = ctx({ autoApprovedTools: ['a_tool'] });
    expect(decide(meta('destructive'), settings).action).toBe('confirm');
    expect(decide(meta('critical'), settings).action).toBe('confirm');
  });

  it('honours always-confirm even for a harmless tool', () => {
    const settings = ctx({ alwaysConfirmTools: ['a_tool'] });
    expect(decide(meta('read'), settings).action).toBe('confirm');
  });

  it('lets always-confirm beat pre-approval when both name the tool', () => {
    const settings = ctx({ autoApprovedTools: ['a_tool'], alwaysConfirmTools: ['a_tool'] });
    expect(decide(meta('external'), settings).action).toBe('confirm');
  });
});

describe('availability', () => {
  it('denies a network tool while offline rather than letting it hang', () => {
    const decision = decide(meta('read', { requiresNetwork: true }), ctx({}, false));
    expect(decision.action).toBe('deny');
    expect(decision.action === 'deny' && decision.reason).toMatch(/network/);
  });

  it('denies before it confirms — no point approving something that cannot run', () => {
    const decision = decide(meta('destructive', { requiresNetwork: true }), ctx({}, false));
    expect(decision.action).toBe('deny');
  });
});

describe('the shipped tools', () => {
  const registry = buildToolRegistry({});

  const actionFor = (name: string) => {
    const tool = registry.get(name);
    expect(tool, `${name} is not registered`).toBeDefined();
    return tool ? decide(tool.metadata, ctx()).action : 'missing';
  };

  it('gates every genuinely dangerous tool', () => {
    for (const name of ['run_shell_command', 'move_to_trash', 'capture_screen', 'read_file']) {
      expect(actionFor(name), `${name} was not gated`).toBe('confirm');
    }
  });

  it('gates everything that leaves the machine', () => {
    for (const name of ['send_message', 'whatsapp_message', 'call_contact']) {
      expect(actionFor(name), name).toBe('confirm');
    }
  });

  it('does not make the everyday commands ask', () => {
    for (const name of ['system_info', 'now_playing', 'set_volume', 'media_control']) {
      expect(actionFor(name), name).toBe('allow');
    }
  });

  it('stages a shell command behind a prompt, like running one', () => {
    // `open_in_terminal` types a command without executing it — but a staged
    // `rm -rf` is one keystroke from real, so it keeps the gate.
    expect(actionFor('open_in_terminal')).toBe('confirm');
  });
});

/**
 * Platform authentication.
 *
 * `critical` demands it by definition. The settings list exists so a user can
 * demand it of anything else they consider theirs alone — and, crucially,
 * cannot use it to demand *less*.
 */
describe('strong confirmation', () => {
  it('asks the operating system for anything critical, always', () => {
    const decision = decide(meta('critical'), ctx());
    expect(decision).toMatchObject({ action: 'confirm', strength: 'strong' });
  });

  it('lets the user pin an ordinary tool behind Touch ID', () => {
    const pinned = ctx({ strongAuthTools: ['a_tool'] });
    expect(decide(meta('reversible'), pinned)).toMatchObject({ strength: 'strong' });
    expect(decide(meta('destructive'), pinned)).toMatchObject({ strength: 'strong' });
    // Even a read-only tool: "it only reads" is our judgement, not theirs.
    expect(decide(meta('read'), pinned)).toMatchObject({ action: 'confirm', strength: 'strong' });
  });

  /**
   * The two lists pull in opposite directions, and the stricter one wins. A
   * tool that is both pre-approved and pinned to Touch ID must still ask —
   * otherwise adding a gate would have quietly removed one.
   */
  it('does not let pre-approval cancel out a pinned tool', () => {
    const both = ctx({ autoApprovedTools: ['a_tool'], strongAuthTools: ['a_tool'] });
    expect(decide(meta('external'), both)).toMatchObject({ action: 'confirm', strength: 'strong' });
  });

  it('leaves everything else alone', () => {
    const pinned = ctx({ strongAuthTools: ['some_other_tool'] });
    expect(decide(meta('read'), pinned).action).toBe('allow');
    expect(decide(meta('destructive'), pinned)).toMatchObject({ strength: 'normal' });
  });
});
