import { NotifyInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript } from './osascript.js';

/**
 * macOS notifications, for things worth surfacing when the user is not looking
 * at Assistant.
 *
 * The PRD asks for "proactive approved notifications", and the word doing the
 * work there is *approved*. An assistant that can interrupt you unprompted is a
 * different product from one that answers when asked, so this is gated twice:
 * the capability is off unless `PROACTIVE_NOTIFICATIONS` is set, and each call
 * still passes the policy engine like any other.
 *
 * Notifications are deliberately not spoken. The point is to reach someone who
 * is doing something else, and speaking would interrupt exactly the thing the
 * notification was trying not to interrupt.
 */

const NOTIFY = [
  'display notification (item 2 of argv) with title (item 1 of argv)',
  'return "shown"',
];

/**
 * Shows a notification without going through the tool layer.
 *
 * The tool is how the *model* raises one; this is how Assistant itself does, when
 * something it is watching becomes worth saying. Same script, same
 * permission — only the caller differs.
 */
export function showNotification(title: string, body: string, opts: { signal?: AbortSignal } = {}) {
  return runAppleScript(NOTIFY, [title, body], opts).map(() => ({ shown: true, title }));
}

export interface NotifyOptions {
  /** Off unless the user turned it on. */
  enabled: boolean;
}

export function createNotifyTool(options: NotifyOptions) {
  return defineTool({
    metadata: {
      name: 'notify',
      description: options.enabled
        ? 'Show a macOS notification. Use for something the user asked to be told about later, or a long task finishing — not to reply to what they just said.'
        : 'Show a macOS notification. Currently disabled — the user has not turned proactive notifications on.',
      category: 'system',
      // Dismissible and changes nothing. The real gate is the config flag.
      risk: 'reversible',
      connector: 'macos-applescript',
      requiredPermissions: ['automation'],
      timeoutMs: 10_000,
    },
    input: NotifyInput,
    execute: (args, ctx) => {
      if (!options.enabled) {
        // Reported as a result rather than an error: the model should tell the
        // user this is switched off, not treat it as something that broke.
        return runAppleScript(['return "disabled"'], [], { signal: ctx.signal }).map(() => ({
          shown: false,
          reason: 'proactive notifications are turned off',
        }));
      }
      return runAppleScript(NOTIFY, [args.title, args.body], { signal: ctx.signal }).map(() => ({
        shown: true,
        title: args.title,
      }));
    },
    speak: (result) => {
      const r = result as { shown?: unknown };
      // Nothing is said when a notification appears — that is the point of one.
      // Only the refusal is worth voicing.
      return r.shown === false ? 'Notifications are turned off, so I have not shown that.' : null;
    },
  });
}
