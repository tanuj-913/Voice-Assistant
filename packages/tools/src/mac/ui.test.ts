import { describe, expect, it } from 'vitest';
import { PressKeyInput, TypeTextInput, UserSettings } from '@assistant/schemas';
import { clickAtTool, pressKeyTool, typeTextTool } from './ui.js';
import { readClipboardTool, writeClipboardTool } from './clipboard.js';
import { closeAppTool, windowControlTool } from './window.js';
import { decide } from '../policy.js';
import { buildToolRegistry } from '../index.js';

/**
 * The tools that act on whatever happens to be in front of the user, rather
 * than on something they named. Assistant cannot see what is focused, so what is
 * pinned here is that none of them can ever run without a human saying yes.
 */

const ctx = { settings: UserSettings.parse({}), online: true };
const preApproved = {
  settings: UserSettings.parse({
    autoApprovedTools: ['type_text', 'press_key', 'click_at', 'read_clipboard'],
  }),
  online: true,
};

describe('direct UI control always asks', () => {
  it.each([typeTextTool, pressKeyTool, clickAtTool])('confirms %#', (tool) => {
    expect(tool.metadata.risk).toBe('destructive');
    expect(decide(tool.metadata, ctx).action).toBe('confirm');
  });

  /**
   * "Always let Assistant type for me" is a reasonable-sounding preference and a
   * terrible one: the next thing typed could go into a payment field.
   */
  it('cannot be unlocked by pre-approval', () => {
    for (const tool of [typeTextTool, pressKeyTool, clickAtTool]) {
      expect(decide(tool.metadata, preApproved).action).toBe('confirm');
    }
  });

  /**
   * Submitting is its own call with its own approval. If pressing return were
   * folded into `type_text`, approving the text would also approve the send.
   */
  it('keeps typing and submitting as separate decisions', () => {
    expect(typeTextTool.metadata.name).not.toBe(pressKeyTool.metadata.name);
    expect(TypeTextInput.safeParse({ text: 'hello', reason: 'fill the search box' }).success).toBe(
      true,
    );
    expect(PressKeyInput.safeParse({ key: 'return', reason: 'submit the form' }).success).toBe(
      true,
    );
  });

  /**
   * Named keys only. Were arbitrary characters allowed here, a prompt reading
   * "press tab" could type anything.
   */
  it('takes named keys only', () => {
    expect(PressKeyInput.safeParse({ key: 'a', reason: 'type a letter' }).success).toBe(false);
    expect(PressKeyInput.safeParse({ key: 'return', reason: 'submit' }).success).toBe(true);
  });

  it('requires a reason it can show the user', () => {
    expect(TypeTextInput.safeParse({ text: 'hello' }).success).toBe(false);
  });

  it('says nothing on its own — it cannot see what it did', () => {
    // No `speak` renderer, and no `verify`: reading back what was typed would
    // mean reading the screen, which is a separate gated decision.
    expect(typeof typeTextTool.speak).toBe('undefined');
    expect(typeof typeTextTool.verify).toBe('undefined');
  });
});

describe('the clipboard', () => {
  /** Same reasoning as `read_screen`: a copied password is on it. */
  it('asks before reading, and cannot be pre-approved', () => {
    expect(readClipboardTool.metadata.risk).toBe('destructive');
    expect(decide(readClipboardTool.metadata, preApproved).action).toBe('confirm');
  });

  it('writes without asking, because nothing leaves the machine', () => {
    expect(decide(writeClipboardTool.metadata, ctx).action).toBe('allow');
  });

  it('reports an empty clipboard rather than silence', () => {
    expect(readClipboardTool.speak?.({ empty: true })).toMatch(/nothing on the clipboard/i);
    expect(readClipboardTool.speak?.({ empty: false, text: 'x' })).toBeNull();
  });
});

describe('apps and windows', () => {
  it('quits rather than kills, so unsaved work still prompts', () => {
    expect(closeAppTool.metadata.risk).toBe('reversible');
    expect(closeAppTool.metadata.description).toMatch(/unsaved/i);
  });

  /**
   * A `quit` that raised a save dialog returns success while the app is still
   * running. Saying "closed Pages" over an unanswered dialog is the false
   * success the PRD forbids, so the renderer declines unless it really quit.
   */
  it('does not claim to have closed an app that was not running', () => {
    expect(closeAppTool.speak?.({ app: 'Pages', wasRunning: false })).toBeNull();
    expect(closeAppTool.speak?.({ app: 'Pages', wasRunning: true })).toBe('Closed Pages.');
  });

  it('speaks only when the window action actually happened', () => {
    expect(windowControlTool.speak?.({ app: 'Safari', action: 'minimize', status: 'done' })).toBe(
      'Minimised Safari.',
    );
    // "no-window" is an answer for the model to explain, not a success.
    expect(
      windowControlTool.speak?.({ app: 'Safari', action: 'minimize', status: 'no-window' }),
    ).toBeNull();
  });

  it('registers all of them exactly once', () => {
    const names = buildToolRegistry()
      .list()
      .map((t) => t.metadata.name);
    for (const name of [
      'type_text',
      'press_key',
      'click_at',
      'read_clipboard',
      'write_clipboard',
      'close_app',
      'window_control',
      'search_files',
      'open_file',
      'create_folder',
      'move_file',
    ]) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
  });
});
