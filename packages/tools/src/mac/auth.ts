import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureNativeBinary } from './native.js';

const run = promisify(execFile);

/**
 * Asks macOS to confirm the person at the keyboard is the owner.
 *
 * This is what the PRD means by "strong confirmation; platform authentication
 * where available". The difference from the ordinary approval card is who is
 * asking: the card is drawn by the process that wants permission, and a bug —
 * or a model that learned to phrase things persuasively — cannot produce a
 * Touch ID prompt.
 *
 * Three outcomes, and they are not two:
 *
 * - `authorised` — the user proved who they are.
 * - `denied` — they cancelled, or failed. The action must not run.
 * - `unavailable` — this Mac has no way to ask. Also refuses, because
 *   degrading a critical action to "well, they clicked yes" would quietly
 *   remove the guarantee the tier exists for. It says so, so the user can see
 *   why rather than assuming Assistant ignored them.
 */
export type AuthOutcome =
  | { status: 'authorised' }
  | { status: 'denied'; message: string }
  | { status: 'unavailable'; message: string };

export type Authenticator = (reason: string) => Promise<AuthOutcome>;

export const authenticateWithMac: Authenticator = async (reason) => {
  let binary: string;
  try {
    binary = await ensureNativeBinary('auth');
  } catch (error) {
    return {
      status: 'unavailable',
      message: error instanceof Error ? error.message : 'authentication is unavailable',
    };
  }

  try {
    // Two minutes: the user may be reaching for their Mac, and a timeout that
    // fires while the system prompt is still on screen would read as a denial
    // of something they were in the middle of approving.
    await run(binary, [reason], { timeout: 120_000 });
    return { status: 'authorised' };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    const message = (failure.stderr ?? '').trim();
    return failure.code === 2
      ? { status: 'unavailable', message: message || 'this Mac cannot ask for authentication' }
      : { status: 'denied', message: message || 'authentication was not completed' };
  }
};
