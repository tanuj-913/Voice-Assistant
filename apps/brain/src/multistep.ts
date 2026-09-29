/**
 * Whether a request is worth a planning round trip.
 *
 * Planning costs an entire extra generation, so it must not fire on "pause".
 * This is deliberately a cheap syntactic check rather than a model call — a
 * model deciding whether to think is still thinking, which is the cost we are
 * trying to avoid.
 *
 * It errs towards *not* planning. A missed plan degrades to the ordinary tool
 * loop, which already handles sequential calls; a spurious plan makes a
 * one-word command take seconds.
 *
 * It has a second job since 2026-09-03, and that one shifts the balance: it
 * also decides whether a tool may end the turn by speaking its own result.
 * "Open Spotify and play the last song" opened Spotify, said "Opened
 * Spotify.", and stopped — the request half-done and reported as success.
 * Against that, a false positive costs one extra model call, so the
 * borderline cases now lean towards *more* steps rather than fewer.
 */

/** Joins that suggest a second action rather than a longer description. */
const SEQUENCING = /\b(and then|then|after that|afterwards|followed by|and also)\b/i;

/**
 * "…and tell me what it was" — a second step that produces an answer rather
 * than an action, which the verb list below cannot see.
 *
 * This is the shape that caused the bug the user hit on 2026-09-03: the first
 * tool ran, its renderer spoke, and the turn ended before the reporting half
 * happened. Deliberately narrow — `and tell me`, not `and tell`, because "call
 * mum and tell her I'm late" is one action with a message in it.
 */
const REPORT_BACK =
  /\band\s+(tell me|let me know|show me|read (it|them|that)|say what|what|who|when|where|how much|how many)\b/i;

/**
 * Verbs that do something, as opposed to asking about something.
 *
 * Reporting verbs — tell, read, show — are deliberately *not* here. They are
 * handled by `REPORT_BACK` above, which requires "and tell **me**": "call mum
 * and tell her I'll be late" is one call with a message in it, and counting
 * "tell" as an action would split it in two.
 */
const ACTION =
  /\b(send|message|call|open|play|pause|create|make|add|set|close|quit|delete|move|remind|search|find|write|email|post|share|copy|type|reply|minimi[sz]e)\b/i;

/** Every action verb in a fragment, as a set of lowercase words. */
function actionsIn(text: string): Set<string> {
  const found = text.match(new RegExp(ACTION.source, 'gi')) ?? [];
  return new Set(found.map((verb) => verb.toLowerCase()));
}

export function looksMultiStep(text: string): boolean {
  const trimmed = text.trim();
  // Anything this short is a single command, whatever words it contains.
  if (trimmed.length < 25) return false;

  if (SEQUENCING.test(trimmed)) return true;
  if (REPORT_BACK.test(trimmed)) return true;

  /**
   * An action on each side of the "and" — "message Rahul and call Priya".
   *
   * Counting verbs across the whole sentence was too loose: "send a message to
   * Rahul saying I am on my way and running late" contains both `send` and
   * `message`, neither of which is on the far side of the "and", and it is
   * plainly one action. Splitting at the join is what tells the difference.
   */
  const join = /\s\band\b\s/i.exec(trimmed);
  if (!join) return false;

  const before = trimmed.slice(0, join.index);
  const after = trimmed.slice(join.index + join[0].length);
  const first = actionsIn(before);
  const second = actionsIn(after);
  if (first.size === 0 || second.size === 0) return false;

  // The same verb twice is usually one action with a compound object:
  // "open safari and chrome".
  return [...second].some((verb) => !first.has(verb));
}
