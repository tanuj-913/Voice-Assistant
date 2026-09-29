import { ToolRegistry } from './registry.js';
import { callContactTool, sendMessageTool } from './mac/comms.js';
import {
  captureScreenTool,
  moveToTrashTool,
  openTerminalTool,
  readFileTool,
  runShellCommandTool,
} from './mac/dangerous.js';
import { memoryTools, type MemoryStore } from './memory.js';
import { createTaskTools, type TaskStore } from './tasks.js';
import { browserControlTool } from './mac/browser.js';
import { findContactTool } from './mac/find-contact.js';
import { readClipboardTool, writeClipboardTool } from './mac/clipboard.js';
import { closeAppTool, windowControlTool } from './mac/window.js';
import { createFolderTool, moveFileTool, openFileTool, searchFilesTool } from './mac/files.js';
import { clickAtTool, pressKeyTool, typeTextTool } from './mac/ui.js';
import { draftEmailTool, searchMailTool, sendEmailTool } from './mac/mail.js';
import { createNotifyTool } from './mac/notify.js';
import { readScreenTool } from './mac/screen.js';
import { mediaControlTool, nowPlayingTool, playMusicTool } from './mac/media.js';
import { openAppTool, openUrlTool, setVolumeTool, systemInfoTool } from './mac/system.js';
import {
  appendNoteTool,
  createNoteTool,
  createReminderTool,
  readCalendarTool,
  revealInFinderTool,
  whatsAppTool,
} from './mac/productivity.js';
import { webCrawlTool } from './web/crawl.js';
import { createWebSearchTool } from './web/search.js';
import { slackTools } from './web/slack.js';

export * from './intent.js';
export * from './memory.js';
export * from './tasks.js';
export * from './planner.js';
export * from './policy.js';
export * from './registry.js';
export * from './mac/osascript.js';
export * from './mac/auth.js';
export * from './mac/reminders.js';
export * from './mac/contacts.js';
export * from './mac/whatsapp-contacts.js';
export { showNotification } from './mac/notify.js';

export interface BuildRegistryOptions {
  serperApiKey?: string | undefined;
  /** Long-term memory. Null leaves the memory tools registered but inert. */
  memory?: MemoryStore | null;
  /** Unfinished multi-step tasks. Null leaves the task tools registered but inert. */
  tasks?: TaskStore | null;
  /** Slack Web API token. Absent leaves the Slack tools registered but inert. */
  slackToken?: string | undefined;
  /** Whether Assistant may interrupt with a notification unprompted. */
  proactiveNotifications?: boolean;
  region?: string;
  language?: string;
}

/** Assembles every tool Assistant can call. */
export function buildToolRegistry(options: BuildRegistryOptions = {}): ToolRegistry {
  return new ToolRegistry().register(
    openAppTool,
    openUrlTool,
    setVolumeTool,
    systemInfoTool,
    playMusicTool,
    mediaControlTool,
    nowPlayingTool,
    browserControlTool,
    closeAppTool,
    windowControlTool,
    writeClipboardTool,
    searchFilesTool,
    openFileTool,
    createFolderTool,
    moveFileTool,
    callContactTool,
    sendMessageTool,
    findContactTool,
    createWebSearchTool({
      serperApiKey: options.serperApiKey,
      ...(options.region ? { region: options.region } : {}),
      ...(options.language ? { language: options.language } : {}),
    }),
    webCrawlTool,
    // Gated capabilities — every one of these prompts on every call.
    runShellCommandTool,
    openTerminalTool,
    moveToTrashTool,
    captureScreenTool,
    readScreenTool,
    readFileTool,
    readClipboardTool,
    // Direct UI control. These act on whatever is in front rather than on a
    // named object, so they sit here with the rest of the always-confirmed.
    typeTextTool,
    pressKeyTool,
    clickAtTool,
    // Apps Assistant can operate on the user's behalf.
    createNoteTool,
    appendNoteTool,
    readCalendarTool,
    createReminderTool,
    revealInFinderTool,
    whatsAppTool,
    draftEmailTool,
    sendEmailTool,
    searchMailTool,
    // Long-term memory. Registered even without a store so the model is told
    // the capability exists and can explain why it is unavailable.
    ...memoryTools(options.memory ?? null),
    // Task continuation. Registered without a store for the same reason as
    // memory: the model should be able to say the capability is unconfigured
    // rather than appear not to have it.
    ...createTaskTools(options.tasks ?? null),
    // Slack has no AppleScript route, so these need a token to do anything.
    // Registered regardless, so the model can say so.
    ...slackTools({ token: options.slackToken }),
    createNotifyTool({ enabled: options.proactiveNotifications ?? false }),
  );
}
