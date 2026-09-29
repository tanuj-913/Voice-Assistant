/**
 * Deterministic routing for the commands people actually repeat.
 *
 * Measured on 2026-09-01: a turn asking the time spent **22,278 ms** in the
 * model deciding to call `system_info`, and **8 ms** running it. For a closed
 * set of phrasings there is nothing for a language model to decide, and asking
 * one costs the entire interaction.
 *
 * Deliberately *not* a small classifier model. The README records that routing
 * between two local models fails on this machine — only one stays resident, so
 * each switch costs a ~10 s eviction reload. This is string matching, and it
 * either matches or gets out of the way.
 *
 * Two rules govern what belongs here:
 *
 * 1. **Whole-utterance matches only.** "Pause" routes; "pause and tell me what
 *    was playing before that" does not, and must reach the planner intact.
 *    Substring matching would hijack sentences it cannot fulfil.
 * 2. **Safe, reversible tools only.** A fast path exists to skip *deliberation*,
 *    never to skip policy. Matches still execute through the registry and its
 *    consent gate exactly as a model-chosen call would.
 *
 * English only. Other languages go to the model, which is where the language
 * handling lives.
 */

export interface IntentMatch {
  /** Registered tool name. */
  tool: string;
  /** Arguments, still validated by the tool's schema before execution. */
  args: Record<string, unknown>;
  /** Which rule fired, for the turn trace. */
  rule: string;
}

/** Lowercase, strip punctuation and filler, collapse whitespace. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"']/g, '')
    .replace(/\b(please|assistant|hey assistant|could you|can you|now)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Rule {
  name: string;
  /** Anchored on purpose — see rule 1 above. */
  pattern: RegExp;
  build: (m: RegExpExecArray) => { tool: string; args: Record<string, unknown> } | null;
}

/**
 * Numbers as people say them, because that is how they arrive.
 *
 * Whisper writes "set the volume to forty percent", not "40". Without this the
 * commonest command in the app misses the fast path entirely and pays a full
 * generation. Parsed rather than guessed: a 3B model asked the same question
 * answered `level: 50`, and a wrong argument is worse than a wrong tool —
 * the action succeeds and nobody is told.
 */
const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Returns null for anything it cannot read exactly. Null routes to the model. */
export function parseSpokenNumber(text: string): number | null {
  const clean = text.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
  if (/^\d{1,3}$/.test(clean)) return Number(clean);
  if (clean === 'a hundred' || clean === 'one hundred' || clean === 'hundred') return 100;
  if (clean in ONES) return ONES[clean] ?? null;
  if (clean in TENS) return TENS[clean] ?? null;

  const [tens, ones, ...rest] = clean.split(' ');
  if (rest.length > 0 || tens === undefined || ones === undefined) return null;
  const tensValue = TENS[tens];
  const onesValue = ONES[ones];
  // "twenty five" only. "five twenty" is not a number anyone means by volume.
  return tensValue !== undefined && onesValue !== undefined && onesValue < 10
    ? tensValue + onesValue
    : null;
}

/**
 * Apps the fast path will open or quit by name.
 *
 * A curated list rather than "open (.+)", because `open -a "the pod bay doors"`
 * fails with a shell error where the model would have said something useful.
 * An app that is not here falls through, which is the safe default and costs
 * only the turns nobody repeats.
 */
export const KNOWN_APPS: Record<string, string> = {
  safari: 'Safari',
  chrome: 'Google Chrome',
  'google chrome': 'Google Chrome',
  firefox: 'Firefox',
  spotify: 'Spotify',
  music: 'Music',
  'apple music': 'Music',
  notes: 'Notes',
  mail: 'Mail',
  messages: 'Messages',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  zoom: 'zoom.us',
  terminal: 'Terminal',
  finder: 'Finder',
  calendar: 'Calendar',
  reminders: 'Reminders',
  photos: 'Photos',
  preview: 'Preview',
  maps: 'Maps',
  calculator: 'Calculator',
  'system settings': 'System Settings',
  settings: 'System Settings',
  'app store': 'App Store',
  'vs code': 'Visual Studio Code',
  vscode: 'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  xcode: 'Xcode',
  discord: 'Discord',
  telegram: 'Telegram',
  notion: 'Notion',
  figma: 'Figma',
};

const APP_NAMES = Object.keys(KNOWN_APPS).join('|');

const RULES: Rule[] = [
  {
    name: 'media.pause',
    pattern: /^(pause|hold on|stop)( the)? ?(music|song|track|playback)?$/,
    build: () => ({ tool: 'media_control', args: { action: 'pause' } }),
  },
  {
    name: 'media.play',
    pattern: /^(play|resume|continue|unpause)( the)? ?(music|song|track|playback)?$/,
    build: () => ({ tool: 'media_control', args: { action: 'play' } }),
  },
  {
    name: 'media.next',
    pattern: /^(next|skip)( this)?( the)? ?(song|track|one)?$/,
    build: () => ({ tool: 'media_control', args: { action: 'next' } }),
  },
  {
    name: 'media.previous',
    pattern: /^(previous|go back|back)( a| one)? ?(song|track)?$/,
    build: () => ({ tool: 'media_control', args: { action: 'previous' } }),
  },
  {
    name: 'media.nowPlaying',
    pattern: /^(what(s| is) (playing|this song|this)|whats this|which song is this)$/,
    build: () => ({ tool: 'now_playing', args: {} }),
  },
  {
    name: 'system.time',
    pattern: /^(what(s| is) the time|what time is it|the time|time)$/,
    build: () => ({ tool: 'system_info', args: { metric: 'time' } }),
  },
  {
    name: 'system.battery',
    pattern:
      /^(battery|what(s| is) my battery|how much battery( is left| do i have)?|battery (level|percentage))$/,
    build: () => ({ tool: 'system_info', args: { metric: 'battery' } }),
  },
  {
    name: 'system.volume',
    // "set volume to 40", "volume 40", "turn the volume to forty percent"
    pattern: /^(set |turn |put )?(the )?(volume|sound)( to| at)? ([a-z0-9 -]+?)( percent)?$/,
    build: (m) => {
      const level = parseSpokenNumber(m[5] ?? '');
      // A misheard "volume two hundred" must fall through to the model, not be
      // clamped into something the user did not ask for. Same for anything the
      // number parser cannot read exactly.
      return level !== null && level >= 0 && level <= 100
        ? { tool: 'set_volume', args: { level } }
        : null;
    },
  },
  {
    name: 'system.volumeMax',
    pattern: /^(set |turn )?(the )?(volume|sound)( to)? (max|maximum|full|all the way up)$/,
    build: () => ({ tool: 'set_volume', args: { level: 100 } }),
  },
  {
    name: 'system.storage',
    pattern:
      /^(how much (storage|disk space|space)( do i have| is left| have i got)?|(free )?(disk )?space( left)?|storage)$/,
    build: () => ({ tool: 'system_info', args: { metric: 'storage' } }),
  },
  {
    name: 'system.memory',
    pattern: /^(how much (memory|ram)( is free| do i have)?|memory( pressure| usage)?)$/,
    build: () => ({ tool: 'system_info', args: { metric: 'memory' } }),
  },
  {
    name: 'system.network',
    pattern:
      /^(am i (online|connected)|is the (wifi|internet|network) (on|working|up)|(wifi|network|internet) status)$/,
    build: () => ({ tool: 'system_info', args: { metric: 'network' } }),
  },
  {
    name: 'system.date',
    // The clock renderer only speaks the time, so a date still costs a
    // phrasing pass — but not the far more expensive selection pass.
    pattern: /^(what(s| is) (todays |the )?date|what day is it( today)?|todays date)$/,
    build: () => ({ tool: 'system_info', args: { metric: 'time' } }),
  },
  {
    name: 'app.open',
    pattern: new RegExp(`^(open|launch|start|go to) (the )?(${APP_NAMES})( app)?$`),
    build: (m) => {
      const app = KNOWN_APPS[m[3] ?? ''];
      return app ? { tool: 'open_app', args: { appName: app } } : null;
    },
  },
  {
    name: 'app.quit',
    pattern: new RegExp(`^(quit|close|exit) (the )?(${APP_NAMES})( app)?$`),
    build: (m) => {
      const app = KNOWN_APPS[m[3] ?? ''];
      return app ? { tool: 'close_app', args: { appName: app } } : null;
    },
  },
  {
    name: 'app.minimise',
    pattern: new RegExp(`^(minimi[sz]e|hide) (the )?(${APP_NAMES})( window| app)?$`),
    build: (m) => {
      const app = KNOWN_APPS[m[3] ?? ''];
      return app ? { tool: 'window_control', args: { action: 'minimize', appName: app } } : null;
    },
  },
  {
    name: 'browser.listTabs',
    pattern:
      /^(what tabs (are|do i have) open|list (my )?tabs|show (me )?(my )?tabs|what(s| is) open in( the)? (browser|safari|chrome))$/,
    build: () => ({ tool: 'browser_control', args: { action: 'list_tabs' } }),
  },
  {
    name: 'browser.reload',
    pattern: /^(reload|refresh)( the| this)? (page|tab|site)$/,
    build: () => ({ tool: 'browser_control', args: { action: 'reload' } }),
  },
  {
    name: 'calendar.today',
    pattern:
      /^(what(s| is) on my calendar( today)?|what(s| is) my (schedule|agenda)( today| for today)?|do i have (anything|any meetings) today|whats (my day|today) look like)$/,
    build: () => ({ tool: 'read_calendar', args: { daysAhead: 0 } }),
  },
  {
    name: 'calendar.tomorrow',
    pattern:
      /^(what(s| is) on my calendar tomorrow|what(s| is) my (schedule|agenda) (tomorrow|for tomorrow)|do i have (anything|any meetings) tomorrow)$/,
    build: () => ({ tool: 'read_calendar', args: { daysAhead: 1 } }),
  },
  {
    name: 'files.find',
    /**
     * Anchored on a file-shaped noun. "find my tax return pdf" is a file
     * search; "find my keys" is not, and routing it to Spotlight would answer
     * a question nobody asked.
     */
    pattern:
      /^(find|search for|look for) (my |a |the )?(.+?) ?(file|files|document|documents|pdf|pdfs|folder|photo|photos|screenshot|screenshots)$/,
    build: (m) => {
      const stem = (m[3] ?? '').trim();
      const noun = m[4] ?? '';
      const query = stem.length > 0 ? stem : noun;
      return query.length > 1 ? { tool: 'search_files', args: { query, scope: 'name' } } : null;
    },
  },
  {
    name: 'system.mute',
    pattern: /^(mute|silence)( the)?( volume| sound| audio)?$/,
    build: () => ({ tool: 'set_volume', args: { level: 0 } }),
  },
  {
    name: 'browser.currentTab',
    pattern: /^(what (am i (looking at|on)|tab is this)|what(s| is) this (page|tab))$/,
    build: () => ({ tool: 'browser_control', args: { action: 'current_tab' } }),
  },
];

/**
 * Returns a routable tool call, or null when the model should handle it.
 *
 * Null is the safe answer and the common one — this covers a handful of
 * phrasings, not a language.
 */
export function matchIntent(text: string): IntentMatch | null {
  const normalised = normalise(text);
  if (normalised.length === 0) return null;

  for (const rule of RULES) {
    const m = rule.pattern.exec(normalised);
    if (!m) continue;
    const built = rule.build(m);
    if (built) return { ...built, rule: rule.name };
  }
  return null;
}

/** Every tool the fast path can reach — all safe and reversible by design. */
export const FAST_PATH_TOOLS: readonly string[] = [
  'media_control',
  'now_playing',
  'system_info',
  'set_volume',
  'browser_control',
  'open_app',
  'close_app',
  'window_control',
  'read_calendar',
  'search_files',
];
