import { z } from 'zod';
import { AppError, ToolCallId } from './common.js';

/**
 * Tool contracts.
 *
 * An LLM deciding to run `osascript` is an untrusted-input problem: the model
 * will eventually emit a malformed or wrong-shaped call. Every tool declares a
 * Zod input schema, and nothing reaches an executor until it has parsed
 * cleanly. The same schema is converted to JSON Schema and handed to the model,
 * so the contract the model sees and the contract we enforce cannot drift.
 */

/**
 * Risk tiers drive the confirmation policy. `destructive` always prompts,
 * regardless of user settings — an LLM should never delete without a human
 * in the loop.
 */
/**
 * Five levels, escalating. The gap between them is who has to agree before
 * the action happens, not how complicated it is.
 *
 * - `read`        Nothing changes. Search, summarise, read permitted state.
 * - `reversible`  Changes something local that can be undone: a note, the
 *                 volume, an open window.
 * - `external`    Leaves the machine and reaches another person or service.
 *                 A sent message cannot be unsent.
 * - `destructive` Removes or exposes something: trash, shell, screen capture,
 *                 reading arbitrary files.
 * - `critical`    Money, credentials, security settings. Reserved; no tool
 *                 carries it yet, and adding one should be a deliberate act.
 */
export const RiskLevel = z.enum(['read', 'reversible', 'external', 'destructive', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * What the policy engine decided. Deterministic and computed from metadata
 * and settings alone — never from anything the model said.
 */
export const PolicyDecision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allow') }),
  z.object({
    action: z.literal('confirm'),
    /** `strong` additionally asks for platform authentication where available. */
    strength: z.enum(['normal', 'strong']),
    reason: z.string(),
  }),
  z.object({ action: z.literal('deny'), reason: z.string() }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const ToolCategory = z.enum([
  'system',
  'media',
  'communication',
  'web',
  'knowledge',
  'device',
]);
export type ToolCategory = z.infer<typeof ToolCategory>;

/** macOS permissions a tool needs, surfaced in the UI before first use. */
export const MacPermission = z.enum([
  'automation',
  'accessibility',
  'contacts',
  'calendar',
  'reminders',
  'photos',
  'microphone',
  'screen-recording',
  'full-disk-access',
]);
export type MacPermission = z.infer<typeof MacPermission>;

/**
 * What the tool acts *through*. The PRD requires every tool to name its
 * connector, and it is not decoration: it is what tells a reader whether a
 * failure is a permissions dialog, a missing binary or someone else's server
 * being down, and it is what makes "add a connector without touching the
 * policy model" checkable rather than aspirational.
 */
export const ToolConnector = z.enum([
  /** A binary run with an argument vector — `open`, `mdfind`, `pmset`. */
  'macos-cli',
  /** AppleScript against an app's dictionary. */
  'macos-applescript',
  /** A compiled Swift helper using a system framework. */
  'macos-native',
  /** The filesystem, read or written directly. */
  'filesystem',
  /** Somebody else's HTTP API. */
  'http',
  /** This machine's own Postgres. */
  'postgres',
  /** Pure computation; nothing outside the process. */
  'internal',
]);
export type ToolConnector = z.infer<typeof ToolConnector>;

/**
 * How many times a failed call may be repeated.
 *
 * Defaults to once — that is, no retry — because the dangerous default is the
 * other one. Retrying "send the message" after a timeout sends it twice, and
 * the tool cannot tell a request that failed from a reply that went missing.
 * Only tools that are safe to repeat raise this, and the registry additionally
 * refuses to retry anything above `reversible`.
 */
export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(3).default(1),
  backoffMs: z.number().int().min(0).max(5_000).default(0),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const ToolMetadata = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'Tool names must be snake_case — model APIs reject other forms'),
  description: z.string().min(10).max(500),
  category: ToolCategory,
  risk: RiskLevel,
  connector: ToolConnector,
  /**
   * Credentials or entitlements the *connector* needs, in the vocabulary of
   * the service granting them — `chat:write` for Slack, `SERPER_API_KEY` for
   * search. Distinct from `requiredPermissions`, which is macOS asking the
   * human. Empty means the tool needs nothing beyond being on this Mac.
   */
  scopes: z.array(z.string().min(1).max(60)).max(10).default([]),
  requiredPermissions: z.array(MacPermission).default([]),
  /** Whether this tool needs network access; gates it in offline mode. */
  requiresNetwork: z.boolean().default(false),
  /** Hard ceiling on execution before the call is abandoned. */
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  retry: RetryPolicy.prefault({}),
});
export type ToolMetadata = z.infer<typeof ToolMetadata>;

/** A tool call as emitted by the model, before validation. */
export const RawToolCall = z.object({
  id: ToolCallId,
  name: z.string(),
  /** Unvalidated — shape is whatever the model produced. */
  arguments: z.unknown(),
});
export type RawToolCall = z.infer<typeof RawToolCall>;

export const ToolResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    id: ToolCallId,
    name: z.string(),
    result: z.unknown(),
    durationMs: z.number().nonnegative(),
    /**
     * Whether the action was independently confirmed to have taken effect.
     *
     * A tool returning without error means the command was accepted, not that
     * anything changed — `set volume 40` succeeds against a muted output
     * device. Tools that can check declare a `verify`; those that cannot stay
     * `unverified`, which is honest rather than absent.
     */
    verification: z.enum(['confirmed', 'contradicted', 'unverified']).default('unverified'),
  }),
  z.object({
    status: z.literal('error'),
    id: ToolCallId,
    name: z.string(),
    error: AppError,
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    status: z.literal('denied'),
    id: ToolCallId,
    name: z.string(),
    reason: z.enum([
      'user_declined',
      'missing_permission',
      'offline',
      'rate_limited',
      /** Approved in the app, but Touch ID or the password was not given. */
      'authentication_failed',
    ]),
  }),
]);
export type ToolResult = z.infer<typeof ToolResult>;

// ---------------------------------------------------------------------------
// Concrete tool input schemas
// ---------------------------------------------------------------------------

export const OpenAppInput = z.object({
  appName: z.string().min(1).max(100).describe('Application name as it appears in /Applications'),
});

export const PlayMusicInput = z.object({
  query: z.string().min(1).max(200).describe('Song, artist, album, or playlist to play'),
  source: z.enum(['spotify', 'apple-music', 'youtube']).default('apple-music'),
});

/**
 * `auto` picks whichever player is actually playing, falling back to whichever
 * is running. Users say "pause" without naming an app, and asking them which
 * one would be a worse assistant than guessing correctly.
 */
export const MediaApp = z.enum(['auto', 'apple-music', 'spotify']);
export type MediaApp = z.infer<typeof MediaApp>;

export const MediaControlInput = z.object({
  action: z.enum(['play', 'pause', 'next', 'previous', 'stop']),
  app: MediaApp.default('auto'),
});

export const NowPlayingInput = z.object({});

export const BrowserControlInput = z.object({
  action: z
    .enum([
      'open',
      'list_tabs',
      'focus_tab',
      'close_tab',
      'current_tab',
      'back',
      'forward',
      'reload',
    ])
    .describe(
      'What to do. `focus_tab` and `close_tab` need `match`; `open` needs `url`. `back`, `forward` and `reload` act on the frontmost tab.',
    ),
  url: z.url().optional(),
  /** Matched case-insensitively against both tab titles and URLs. */
  match: z.string().min(1).max(120).optional(),
  browser: z.enum(['auto', 'safari', 'chrome']).default('auto'),
});

export const SetVolumeInput = z.object({
  level: z.number().int().min(0).max(100).describe('Output volume percentage'),
});

export const CallContactInput = z.object({
  contactName: z.string().min(1).max(100),
  method: z.enum(['facetime-audio', 'facetime-video', 'phone']).default('facetime-audio'),
});

export const SendMessageInput = z.object({
  contactName: z.string().min(1).max(100),
  body: z.string().min(1).max(1000),
});

export const WebSearchInput = z.object({
  query: z.string().min(1).max(300),
  maxResults: z.number().int().min(1).max(20).default(5),
});

export const WebCrawlInput = z.object({
  url: z.url().describe('Absolute URL to fetch and extract readable text from'),
  /** Guards against pulling a multi-megabyte page into the context window. */
  maxChars: z.number().int().min(500).max(50_000).default(8_000),
});

export const OpenUrlInput = z.object({
  url: z.url(),
});

export const RememberInput = z.object({
  fact: z.string().min(3).max(500).describe('A durable fact about the user worth recalling later'),
  tags: z.array(z.string().min(1).max(30)).max(6).default([]),
});

export const NotifyInput = z.object({
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(200),
});

export const ReadScreenInput = z.object({
  mode: z.enum(['screen', 'window']).default('screen'),
  reason: z
    .string()
    .min(3)
    .max(200)
    .describe('Why the screen needs reading. Shown to the user when they are asked to approve.'),
});

export const SlackSendInput = z.object({
  channel: z.string().min(1).max(80).describe('Channel name, with or without the leading #'),
  text: z.string().min(1).max(3000),
});

export const SlackSearchInput = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(5),
});

const emailBody = z.string().min(1).max(5000);

export const DraftEmailInput = z.object({
  to: z.email(),
  subject: z.string().min(1).max(200),
  body: emailBody,
});

/** Same shape as a draft; a separate schema so the two can diverge safely. */
export const SendEmailInput = DraftEmailInput;

export const SearchMailInput = z.object({
  query: z.string().min(1).max(120).describe('Text to match against message subjects'),
});

export const ForgetInput = z.object({
  id: z.uuid().describe('Id of the memory to delete, as returned by list_memories'),
});

export const RecallInput = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(5),
});

export const SystemInfoInput = z.object({
  metric: z.enum(['battery', 'storage', 'memory', 'network', 'time']),
});

// ---------------------------------------------------------------------------
// Gated capabilities
//
// Everything below is `destructive`, which means it can never be auto-approved
// and always requires an explicit decision — including when the user asked for
// it in the same breath. A spoken instruction is easy to mishear and easy to
// over-interpret; these are the actions where being wrong is expensive.
// ---------------------------------------------------------------------------

export const RunShellCommandInput = z.object({
  command: z
    .string()
    .min(1)
    .max(2000)
    .describe('The exact shell command to run. Shown to the user verbatim for approval.'),
  /** Optional working directory; defaults to the user's home. */
  workingDirectory: z.string().max(500).optional(),
  reason: z
    .string()
    .min(3)
    .max(200)
    .describe('A short, plain explanation of why this command is needed, shown in the prompt.'),
});

export const MoveToTrashInput = z.object({
  paths: z
    .array(z.string().min(1).max(1000))
    .min(1)
    .max(20)
    .describe('Absolute paths to move to the Trash.'),
  reason: z.string().min(3).max(200),
});

export const CaptureScreenInput = z.object({
  mode: z
    .enum(['full', 'window'])
    .default('full')
    .describe('Capture the whole screen or just the frontmost window.'),
  reason: z.string().min(3).max(200),
});

export const CreateNoteInput = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
});

export const AppendNoteInput = z.object({
  title: z.string().min(1).max(200).describe('Title of an existing note to append to'),
  body: z.string().min(1).max(10_000),
});

export const ReadCalendarInput = z.object({
  /** How many days ahead to look. 0 means today only. */
  daysAhead: z.number().int().min(0).max(60).default(0),
});

export const CreateReminderInput = z.object({
  text: z.string().min(1).max(500),
  /** Natural due date, e.g. "tomorrow 9am". Omitted means no due date. */
  dueAt: z.string().max(100).optional(),
});

export const RevealInFinderInput = z.object({
  path: z.string().min(1).max(1000).describe('Absolute path to reveal in Finder'),
});

/**
 * A name or a number, not both required.
 *
 * WhatsApp's URL scheme needs digits, but people say "message Rahul" — and the
 * Mac's own Contacts holds that mapping, which is where the number comes from
 * when only a name is given.
 */
export const WhatsAppInput = z
  .object({
    /** Name to look up in Contacts. Preferred: it is how the user will ask. */
    contactName: z.string().min(1).max(100).optional(),
    /** Phone number in international format, digits only. */
    phone: z
      .string()
      .regex(/^[0-9]{8,15}$/, 'Digits only, including country code')
      .optional(),
    message: z.string().min(1).max(1000),
    /**
     * Press send, rather than leaving the message sitting in the box.
     *
     * WhatsApp has no dictionary, so this is a Return keystroke delivered to
     * WhatsApp once it is genuinely frontmost — checked first, because a
     * keystroke sent to the wrong window is a message to the wrong person.
     * The action is `external`, so the user has already approved the exact
     * text on the confirmation card before any of this happens.
     */
    send: z.boolean().default(true),
  })
  .refine((input) => input.contactName !== undefined || input.phone !== undefined, {
    message: 'Give either a contactName to look up, or a phone number',
    path: ['contactName'],
  });

export const ReadFileInput = z.object({
  path: z.string().min(1).max(1000),
  maxChars: z.number().int().min(100).max(50_000).default(8_000),
});

// ---------------------------------------------------------------------------
// Clipboard, windows and files
// ---------------------------------------------------------------------------

/**
 * Reading the clipboard needs a reason for the same reason `read_screen` does:
 * whatever is on it — a copied password, a one-time code — becomes text in the
 * transcript, and the user should be told why before that happens.
 */
export const ReadClipboardInput = z.object({
  reason: z
    .string()
    .min(3)
    .max(200)
    .describe('Why the clipboard needs reading. Shown to the user when they are asked to approve.'),
});

export const WriteClipboardInput = z.object({
  text: z.string().min(1).max(10_000).describe('Text to place on the clipboard'),
});

export const CloseAppInput = z.object({
  appName: z
    .string()
    .min(1)
    .max(100)
    .describe('Application to quit, as it appears in the menu bar'),
});

export const WindowControlInput = z.object({
  action: z
    .enum(['minimize', 'unminimize', 'zoom', 'close', 'focus'])
    .describe('What to do with the frontmost window of the named app.'),
  appName: z.string().min(1).max(100),
});

export const SearchFilesInput = z.object({
  query: z.string().min(1).max(200).describe('What to look for'),
  /** Absolute path to search within. Omitted means everywhere Spotlight indexes. */
  folder: z.string().max(1000).optional(),
  scope: z
    .enum(['name', 'contents'])
    .default('name')
    .describe('Match the file name, or the text inside the file.'),
  limit: z.number().int().min(1).max(50).default(10),
});

export const OpenFileInput = z.object({
  path: z.string().min(1).max(1000).describe('Absolute path to open in its default application'),
});

export const CreateFolderInput = z.object({
  path: z.string().min(1).max(1000).describe('Absolute path of the folder to create'),
});

/** Covers renaming too: a rename is a move whose destination shares a parent. */
export const MoveFileInput = z.object({
  source: z.string().min(1).max(1000).describe('Absolute path of the file or folder to move'),
  destination: z
    .string()
    .min(1)
    .max(1000)
    .describe('Absolute destination path, including the new name'),
});

// ---------------------------------------------------------------------------
// Direct UI control
//
// These drive whatever is on screen — they fill a form field, press a key,
// click a point. There is no undo and no way to know in advance what is
// underneath, so all three are `destructive` and can never be auto-approved.
// ---------------------------------------------------------------------------

export const TypeTextInput = z.object({
  text: z.string().min(1).max(2000).describe('Text to type into whatever is focused'),
  reason: z
    .string()
    .min(3)
    .max(200)
    .describe('What this is filling in, shown to the user before it is typed.'),
});

/**
 * Named keys only. Anything that types a character goes through `type_text`,
 * so this cannot be used to assemble arbitrary input one keystroke at a time.
 */
export const PressKeyInput = z.object({
  key: z.enum([
    'return',
    'tab',
    'escape',
    'space',
    'delete',
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'page_up',
    'page_down',
  ]),
  modifiers: z
    .array(z.enum(['command', 'shift', 'option', 'control']))
    .max(4)
    .default([]),
  reason: z.string().min(3).max(200),
});

export const ClickAtInput = z.object({
  x: z.number().int().min(0).max(20_000).describe('Screen x coordinate in points'),
  y: z.number().int().min(0).max(20_000).describe('Screen y coordinate in points'),
  reason: z
    .string()
    .min(3)
    .max(200)
    .describe('What is being clicked, in the words the user would recognise.'),
});

/**
 * An edit to a stored memory, from the panel rather than from the model.
 *
 * Same bounds as `RememberInput`, because a fact corrected by hand is still a
 * fact and should not be able to become something a spoken one could not.
 */
export const MemoryEdit = z.object({
  fact: z.string().min(3).max(500),
  tags: z.array(z.string().min(1).max(30)).max(6).default([]),
});
export type MemoryEdit = z.infer<typeof MemoryEdit>;

/**
 * Looking someone up without messaging them.
 *
 * "Who do I have called Tilak?" had no tool behind it: names were resolved
 * only inside `whatsapp_message`, so Assistant could act on a contact but never
 * simply answer a question about one.
 */
export const FindContactInput = z.object({
  query: z.string().min(1).max(100).describe('Name, or part of one, to look for'),
  limit: z.number().int().min(1).max(25).default(10),
});
