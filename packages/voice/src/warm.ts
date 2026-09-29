import type { LanguageCode } from '@assistant/schemas';
import type { TextToSpeechProvider } from './types.js';

/**
 * Pre-synthesising the sentences Assistant says most often, so the first person to
 * ask for one is not the person who pays for it.
 *
 * The phrase cache already answers a repeat in ~260 ms against Sarvam's ~950 ms
 * round trip, but only *after* someone has waited out that round trip once.
 * Every fresh checkout, every checkpoint change and every cache clear puts the
 * full cost back in front of a real request — and it lands on the fast-path
 * commands, which are the ones that are supposed to feel instant.
 *
 * Warming is deliberately dull: sequential, interruptible, and silent about
 * failure. It is an optimisation, and an optimisation that can delay a turn or
 * fail a boot has cost more than it saves.
 */

/**
 * Fixed sentences that do not depend on what the user asked.
 *
 * Curated by hand rather than extracted from the renderers: most renderers
 * interpolate ("Opened Safari.", "Volume set to 40 percent.") and only a
 * caller that knows the argument space can expand those. `warmPhraseCache`
 * takes whatever list it is given, so the brain composes the full set.
 *
 * Kept honest by `warm.test.ts`, which asserts each of these still appears
 * verbatim in the tool that speaks it — a phrase that has been reworded is
 * worse than no warming, because it fills the cache with audio nobody will
 * ever ask for.
 */
export const COMMON_PHRASES: readonly string[] = [
  // media_control — the highest-traffic fast-path tool by a distance.
  'Playing.',
  'Paused.',
  'Stopped.',
  'Skipped to the next track.',
  'Went back a track.',
  // Navigation and files.
  'Opened that link.',
  'Opened that in your browser.',
  'Opened it.',
  'Showed it in Finder.',
  'Made that folder.',
  'Moved it.',
  // Clipboard.
  'Copied that to your clipboard.',
  'There is nothing on the clipboard.',
  // Memory and tasks.
  'Forgotten.',
  'Nothing is outstanding.',
  // The orchestrator's own word for a plan that finished cleanly.
  'Done.',
];

export interface WarmOptions {
  /** The phrases to warm. Defaults to {@link COMMON_PHRASES}. */
  phrases?: readonly string[];
  /** Warming one language only — the cache key includes it. */
  language?: LanguageCode;
  /**
   * True while a real turn is in flight.
   *
   * Voice conversion runs on a single local server, so a warm clip being
   * converted while someone is waiting to be answered delays the answer. That
   * is the same trap as the whisper queue: a background optimisation that
   * takes the foreground's slot is a regression wearing a speed-up's clothes.
   */
  isBusy?: () => boolean;
  /** Stops warming — on shutdown, or when whatever asked for it gives up. */
  signal?: AbortSignal;
  /** How long to wait before re-checking `isBusy`. */
  pollMs?: number;
  /** Called after each phrase, for a progress line in the boot log. */
  onPhrase?: (text: string, outcome: 'synthesised' | 'cached' | 'failed') => void;
}

export interface WarmResult {
  /** Phrases that were missing and have now been synthesised and stored. */
  synthesised: number;
  /** Phrases already in the cache — the steady state after the first run. */
  cached: number;
  /** Phrases that could not be synthesised. Never fatal. */
  failed: number;
  /** True when warming stopped early because the signal aborted. */
  aborted: boolean;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Synthesises each phrase through the given provider, which is expected to be
 * the cache-wrapped one — a phrase already on disk costs a file read, so this
 * is safe to run on every boot rather than only the first.
 *
 * Sequential on purpose. Firing twenty conversions at once would saturate the
 * converter for as long as it took, which is the one thing warming must not do.
 */
export async function warmPhraseCache(
  tts: TextToSpeechProvider,
  options: WarmOptions = {},
): Promise<WarmResult> {
  const {
    phrases = COMMON_PHRASES,
    language = 'en-IN',
    isBusy,
    signal,
    pollMs = 500,
    onPhrase,
  } = options;

  const out: WarmResult = { synthesised: 0, cached: 0, failed: 0, aborted: false };

  for (const text of phrases) {
    if (signal?.aborted) {
      out.aborted = true;
      return out;
    }

    // Yield the converter to anyone who is actually being spoken to.
    while (isBusy?.() === true) {
      await delay(pollMs, signal);
      if (signal?.aborted) {
        out.aborted = true;
        return out;
      }
    }

    const result = await tts.synthesize({ text, language });
    if (result.isErr()) {
      // A phrase that will not synthesise now is simply not warmed. Sarvam
      // being down at boot is not a reason for Assistant not to start.
      out.failed += 1;
      onPhrase?.(text, 'failed');
      continue;
    }

    if (result.value.timings?.cached === true) {
      out.cached += 1;
      onPhrase?.(text, 'cached');
    } else {
      out.synthesised += 1;
      onPhrase?.(text, 'synthesised');
    }
  }

  return out;
}
