import type { AssistantState, ServerEvent, ToolResult, RiskLevel } from '@assistant/schemas';
import { create } from 'zustand';
import { SILENT_SPECTRUM, type Spectrum } from '../lib/audio.js';

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** True while tokens are still streaming in. */
  streaming: boolean;
}

export interface PendingTool {
  callId: string;
  name: string;
  arguments: unknown;
  // Taken from the schema rather than restated here — the risk levels went
  // from three to five and a hand-written copy silently rotted.
  risk: RiskLevel;
  /** `strong` means macOS will ask for Touch ID after this card is approved. */
  strength: 'normal' | 'strong';
  reason: string | null;
  permissions: string[];
}

interface AssistantStore {
  state: AssistantState;
  /**
   * The complete reply, held back until it is spoken.
   *
   * The transcript reveals sentences as their audio starts, so this is what
   * gets shown if speech fails, is blocked, or is switched off — silent *and*
   * blank is two failures where there should be at most one.
   */
  fullReply: string;
  connected: boolean;
  spectrum: Spectrum;
  entries: TranscriptEntry[];
  pendingTool: PendingTool | null;
  toolLog: ToolResult[];
  lastError: string | null;

  apply: (event: ServerEvent) => void;
  setConnected: (connected: boolean) => void;
  addUserEntry: (text: string) => void;
  clearPendingTool: () => void;
  /** Shows a sentence at the moment its audio starts. */
  revealSpoken: (text: string) => void;
  /** Shows the whole reply at once, when speech is not going to happen. */
  revealAll: () => void;
}

/**
 * The UI is a projection of the brain's event stream. Nothing here decides
 * what Assistant is doing — it only records what the brain said it is doing, so
 * the two can never disagree.
 */
export const useAssistant = create<AssistantStore>((set) => ({
  state: 'idle',
  connected: false,
  spectrum: SILENT_SPECTRUM,
  entries: [],
  pendingTool: null,
  toolLog: [],
  lastError: null,
  fullReply: '',

  setConnected: (connected) => {
    set({ connected });
  },

  addUserEntry: (text) => {
    set((prev) => ({
      entries: [...prev.entries, { id: crypto.randomUUID(), role: 'user', text, streaming: false }],
    }));
  },

  revealSpoken: (text) => {
    set((prev) => {
      const last = prev.entries.at(-1);
      if (last?.role === 'assistant' && last.streaming) {
        // A space between sentences, never before the first one.
        const joined = last.text.length > 0 ? `${last.text} ${text}` : text;
        return { entries: [...prev.entries.slice(0, -1), { ...last, text: joined }] };
      }
      return {
        entries: [
          ...prev.entries,
          { id: crypto.randomUUID(), role: 'assistant' as const, text, streaming: true },
        ],
      };
    });
  },

  revealAll: () => {
    set((prev) => {
      if (prev.fullReply.length === 0) return prev;
      const last = prev.entries.at(-1);
      if (last?.role === 'assistant' && last.streaming) {
        return {
          entries: [
            ...prev.entries.slice(0, -1),
            { ...last, text: prev.fullReply, streaming: false },
          ],
        };
      }
      return {
        entries: [
          ...prev.entries,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            text: prev.fullReply,
            streaming: false,
          },
        ],
      };
    });
  },

  clearPendingTool: () => {
    set({ pendingTool: null });
  },

  apply: (event) => {
    switch (event.type) {
      case 'state.changed':
        set({ state: event.state });
        break;

      case 'audio.level':
        // Level from the brain is a coarse fallback; the UI's own analyser
        // produces the full spectrum locally and at frame rate.
        set((prev) => ({ spectrum: { ...prev.spectrum, level: event.level } }));
        break;

      case 'transcript.final':
        set((prev) => ({
          entries: [
            ...prev.entries,
            { id: crypto.randomUUID(), role: 'user', text: event.text, streaming: false },
          ],
        }));
        break;

      /**
       * Accumulated, not displayed.
       *
       * The model writes about three seconds faster than the voice can say it,
       * so streaming tokens into the transcript meant reading the answer and
       * then listening to it — which reads as an echo rather than a reply.
       * `revealSpoken` puts each sentence on screen as it is spoken instead.
       */
      case 'response.delta':
        set((prev) => ({ fullReply: prev.fullReply + event.delta }));
        break;

      case 'response.done':
        // Held, not shown: the last clips are usually still playing.
        set({ fullReply: event.message.content });
        break;

      case 'tool.proposed':
        set({
          pendingTool: event.needsConfirmation
            ? {
                callId: event.callId,
                name: event.name,
                arguments: event.arguments,
                risk: event.risk,
                strength: event.strength,
                reason: event.reason,
                permissions: event.permissions,
              }
            : null,
        });
        break;

      case 'tool.completed':
        set((prev) => ({
          pendingTool: null,
          toolLog: [...prev.toolLog.slice(-19), event.result],
        }));
        break;

      case 'error':
        set({ lastError: event.error.message });
        break;

      // Nothing to record. `speech.ready` is listed so the exhaustiveness
      // check keeps working; playback is a side effect owned by the App.
      case 'wake.detected':
      case 'transcript.partial':
      case 'speech.ready':
        break;
    }
  },
}));
