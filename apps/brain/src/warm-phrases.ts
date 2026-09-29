import { KNOWN_APPS } from '@assistant/tools';
import { COMMON_PHRASES } from '@assistant/voice';

/**
 * The full set of sentences worth having in the cache before anyone speaks.
 *
 * Lives in the brain rather than in `@assistant/voice` because it is assembled
 * from both sides: the fixed strings belong to the speech layer, but the
 * interpolated ones — "Opened Safari.", "Volume set to 40 percent." — can only
 * be expanded by something that knows the fast path's argument space. Derived
 * from `KNOWN_APPS` rather than retyped, so an app added to the router is
 * warmed without anyone remembering to.
 */

/**
 * Volume levels people actually say.
 *
 * The router accepts anything from 0 to 100, but "set the volume to
 * thirty-seven" is not a thing anyone says out loud; the tens are, and warming
 * all 101 would spend a hundred round trips to cover requests that will not
 * arrive. A level outside this set still works — it just pays the round trip
 * once, like everything else.
 */
const WARMED_VOLUME_LEVELS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export function warmablePhrases(): readonly string[] {
  const apps = [...new Set(Object.values(KNOWN_APPS))].map((app) => `Opened ${app}.`);
  const volumes = WARMED_VOLUME_LEVELS.map((level) => `Volume set to ${String(level)} percent.`);
  // Deduplicated: two spoken aliases can resolve to the same app, and
  // synthesising "Opened Music." twice would be two round trips for one clip.
  return [...new Set([...COMMON_PHRASES, ...apps, ...volumes])];
}
