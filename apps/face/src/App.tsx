import type { AssistantState } from '@assistant/schemas';
import { AnimatePresence, motion } from 'motion/react';
import { CornerDownLeft, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlPanel } from './components/ControlPanel.js';
import { EnergyField } from './components/EnergyField.js';
import { GlowText } from './components/GlowText.js';
import { Orb } from './components/Orb.js';
import { RiveOrb, type RiveDiagnostics } from './components/RiveOrb.js';
import { ToolConfirm } from './components/ToolConfirm.js';
import { Transcript } from './components/Transcript.js';
import { Waveform } from './components/Waveform.js';
import {
  connectEvents,
  onSpeechEvents,
  playSpeech,
  sendCommand,
  unlockAudioPlayback,
} from './lib/api.js';
import { SILENT_SPECTRUM, type Spectrum } from './lib/audio.js';
import { cn } from './lib/cn.js';
import { useVoice } from './lib/useVoice.js';
import { useAssistant } from './store/assistant.js';

const LABEL: Record<AssistantState, string> = {
  idle: '',
  listening: 'LISTENING',
  transcribing: 'TRANSCRIBING',
  thinking: 'THINKING',
  acting: 'WORKING',
  awaiting_approval: 'NEEDS YOU',
  speaking: 'SPEAKING',
  success: 'DONE',
  failure: 'FAILED',
};

const TONE: Record<AssistantState, string> = {
  idle: 'text-cyan-200/40',
  listening: 'text-cyan-200',
  transcribing: 'text-teal-200',
  thinking: 'text-violet-200',
  acting: 'text-amber-200',
  awaiting_approval: 'text-amber-300',
  speaking: 'text-yellow-100',
  success: 'text-emerald-200',
  failure: 'text-rose-300',
};

/**
 * How large the reactor sits at, per state.
 *
 * Scale carries the meaning here. Listening swells toward the user — the
 * "leaning in" of something paying attention. Working holds steady. Once a
 * reply exists the reactor recedes and dims, because at that point the answer
 * is the thing worth reading and the animation is just atmosphere.
 */
const SCALE: Record<AssistantState, number> = {
  idle: 1,
  listening: 1.22,
  transcribing: 1.12,
  thinking: 1.06,
  acting: 1.06,
  // Held a touch larger than working: something is waiting on the user, and
  // the reactor leaning in is the cue to look at the card.
  awaiting_approval: 1.14,
  speaking: 1.1,
  success: 1.02,
  failure: 1.04,
};

export function App() {
  const {
    state,
    connected,
    entries,
    pendingTool,
    lastError,
    apply,
    setConnected,
    addUserEntry,
    revealSpoken,
    revealAll,
  } = useAssistant();

  const [draft, setDraft] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [partial, setPartial] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const spectrumRef = useRef<Spectrum>(SILENT_SPECTRUM);
  const [, forceOrb] = useState(0);

  /**
   * Which visual to show. The energy field is the real one — a hollow ring
   * with ribbons orbiting it, driven entirely by the four audio bands. The
   * other two are kept only for comparison: the Rive files are a designer's
   * finished artwork but react through whatever inputs they happen to expose,
   * and the old sphere fills the centre that the ring deliberately leaves
   * dark for text. Swap with `?visual=rive` or `?visual=webgl`.
   */
  const [visual] = useState<'field' | 'rive' | 'webgl'>(() => {
    const requested = new URLSearchParams(window.location.search).get('visual');
    return requested === 'rive' || requested === 'webgl' ? requested : 'field';
  });

  // What the Rive files turned out to expose, surfaced rather than logged —
  // it decides how much of the animation can actually be driven.
  const [riveInfo, setRiveInfo] = useState<RiveDiagnostics[]>([]);
  const onRiveDiagnostics = useCallback((d: RiveDiagnostics) => {
    setRiveInfo((prev) => (prev.some((p) => p.file === d.file) ? prev : [...prev, d]));
  }, []);

  const onSpectrum = useCallback((next: Spectrum) => {
    spectrumRef.current = next;
  }, []);

  const voice = useVoice({ onSpectrum, onError: setNotice, onPartialText: setPartial });

  useEffect(() => {
    if (!voice.listening) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      forceOrb((n) => (n + 1) % 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      spectrumRef.current = SILENT_SPECTRUM;
    };
  }, [voice.listening]);

  /**
   * Words appear when they are spoken, not when they are written.
   *
   * The reveal is driven by playback rather than by the token stream: the
   * model finishes about three seconds before the voice does, so showing text
   * as it arrives meant reading the reply and then hearing it repeated back.
   */
  useEffect(() => {
    onSpeechEvents({ spoken: revealSpoken, lost: revealAll });
  }, [revealSpoken, revealAll]);

  const handleEvent = useCallback(
    (event: Parameters<typeof apply>[0]) => {
      apply(event);
      if (event.type === 'speech.ready') {
        playSpeech(event.url, event.turnId, event.text, setNotice);
      }
      /**
       * Nothing to speak with, or nothing came back — show the words rather
       * than leaving the reply invisible. A turn that ends without audio is a
       * degraded turn, not a silent one.
       */
      if (event.type === 'state.changed' && (event.state === 'failure' || event.state === 'idle')) {
        revealAll();
      }
    },
    [apply, revealAll],
  );

  useEffect(() => connectEvents(handleEvent, setConnected), [handleEvent, setConnected]);
  useEffect(unlockAudioPlayback, []);

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    addUserEntry(text);
    setDraft('');
    void sendCommand({ type: 'text.submit', text });
  };

  const hasConversation = entries.length > 0;
  const busy = state !== 'idle';

  // Voice level drives an extra swell on top of the state scale, so the
  // reactor visibly reacts to how loudly you are speaking.
  const level = spectrumRef.current.level;
  const scale = SCALE[state] * (voice.listening ? 1 + level * 0.14 : 1);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#04070d]">
      {/*
        The reactor is a background layer, not a panel in the column. That is
        what lets it fill the view while listening and sink behind the text
        once there is an answer to read.
      */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
        animate={{
          scale,
          opacity: hasConversation ? 0.4 : 1,
          y: hasConversation ? '-18%' : '0%',
        }}
        transition={{ type: 'spring', stiffness: 90, damping: 20, mass: 0.7 }}
      >
        {/*
          The field runs full-bleed rather than inside a square. Its canvas
          cannot be transparent — EffectComposer's final pass writes an opaque
          frame regardless of the clear alpha — so any box smaller than the
          viewport shows up as a visible rectangle against the page.
        */}
        {visual === 'field' && (
          <div className="absolute inset-0">
            <EnergyField state={state} spectrum={spectrumRef.current} />
          </div>
        )}
        <div className="aspect-square h-[min(78vh,78vw)]">
          {visual === 'rive' && (
            <RiveOrb
              state={state}
              spectrum={spectrumRef.current}
              onDiagnostics={onRiveDiagnostics}
            />
          )}
          {visual === 'webgl' && <Orb state={state} spectrum={spectrumRef.current} />}
        </div>
      </motion.div>

      <header className="relative z-10 shrink-0 px-6 pt-4">
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-gradient-to-r from-transparent to-cyan-300/35" />
          {/*
            The wordmark sits over the reactor's own glow, so opacity alone is
            not enough to make it read — it needs its own light. The text
            shadow is what separates it from the field behind it.
          */}
          <span
            className="font-mono text-[12px] font-semibold tracking-[0.46em] text-cyan-50/95 uppercase"
            style={{
              textShadow: '0 0 14px rgba(103,232,249,0.55), 0 0 34px rgba(56,189,248,0.28)',
            }}
          >
            Assistant
          </span>
          <span className="h-px flex-1 bg-gradient-to-l from-transparent to-cyan-300/35" />
          {/*
            The way in to everything Assistant knows and every rule it follows.
            Kept at the edge of the header rather than in the footer: it is not
            part of the conversation, and it should never be near the buttons
            that approve an action.
          */}
          <button
            onClick={() => {
              setPanelOpen(true);
            }}
            aria-label="Settings, memory and permissions"
            className="text-cyan-100/35 transition hover:text-cyan-100"
          >
            <SlidersHorizontal className="size-4" />
          </button>
        </div>
      </header>

      <ControlPanel
        open={panelOpen}
        onClose={() => {
          setPanelOpen(false);
        }}
      />

      {/* Status lives inside the reactor rather than beside it. */}
      <div className="pointer-events-none relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8">
        {!hasConversation && <Waveform spectrum={spectrumRef.current} active={voice.listening} />}
        <AnimatePresence mode="wait">
          {partial ? (
            <motion.p
              key="heard"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="max-w-xl text-center text-[17px] leading-snug text-cyan-50/90"
              style={{ textShadow: '0 0 18px rgba(103,232,249,0.45)' }}
            >
              {partial}
            </motion.p>
          ) : busy ? (
            <motion.div
              key={state}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className="flex flex-col items-center gap-2"
            >
              <GlowText
                text={LABEL[state]}
                className={cn(
                  'font-mono text-[13px] tracking-[0.4em] transition-colors duration-500',
                  TONE[state],
                )}
              />
            </motion.div>
          ) : !hasConversation ? (
            <motion.span
              key="prompt"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center font-mono text-[11px] tracking-[0.3em] text-cyan-100/30 uppercase"
            >
              {connected ? 'Say “Hey Assistant”' : 'Disconnected'}
              {/*
                The hairline under the prompt, with a single lit point at its
                centre. Purely compositional — it gives the text a base so it
                sits in the ring rather than floating loose in it.
              */}
              <span className="mt-3 flex items-center justify-center">
                <span className="h-px w-28 bg-gradient-to-r from-transparent to-cyan-200/25" />
                <span className="mx-1 size-[3px] rounded-full bg-cyan-100/80 shadow-[0_0_6px_rgba(165,243,252,0.9)]" />
                <span className="h-px w-28 bg-gradient-to-l from-transparent to-cyan-200/25" />
              </span>
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>

      {hasConversation && (
        <main className="relative z-10 max-h-[46%] min-h-0 shrink-0 px-4">
          <Transcript entries={entries} />
        </main>
      )}

      <footer className="relative z-10 space-y-2 px-4 pt-2 pb-4">
        <AnimatePresence>
          {notice && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-start gap-2 overflow-hidden rounded-lg border border-amber-400/25 bg-amber-950/30 px-3 py-2 text-[11px] leading-relaxed text-amber-100/90"
            >
              <span className="flex-1">{notice}</span>
              <button
                onClick={() => {
                  setNotice(null);
                }}
                className="text-amber-200/40 transition hover:text-amber-100"
              >
                ✕
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {visual === 'rive' && riveInfo.length > 0 && (
          <details className="rounded-lg border border-cyan-200/10 bg-white/[0.02] px-3 py-2 text-[10px] text-cyan-100/40">
            <summary className="cursor-pointer font-mono tracking-wider uppercase">
              Rive controls found
            </summary>
            <div className="mt-2 space-y-1 font-mono">
              {riveInfo.map((info) => (
                <div key={info.file}>
                  <span className="text-cyan-200/70">{info.file.split('/').pop()}</span>
                  {' — machines: '}
                  {info.stateMachines.join(', ') || 'none'}
                  {' | animations: '}
                  {info.animations.join(', ') || 'none'}
                  {' | inputs: '}
                  {info.inputs.join(', ') || 'none'}
                </div>
              ))}
            </div>
          </details>
        )}

        {lastError && (
          <div className="rounded-lg border border-rose-500/25 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200/90">
            {lastError}
          </div>
        )}

        <ToolConfirm
          pending={pendingTool}
          onDecide={(approved) => {
            if (!pendingTool) return;
            void sendCommand({
              type: 'tool.decision',
              callId: pendingTool.callId as never,
              approved,
              remember: false,
            });
          }}
        />

        <div
          className={cn(
            // A near-transparent field disappears against the black backdrop.
            // It needs an actual surface — a dark fill plus a visible edge —
            // to read as somewhere you can type.
            'relative flex items-center gap-3 border px-4 py-3 shadow-[0_0_28px_rgba(34,211,238,0.10)] backdrop-blur-xl transition-all duration-300',
            voice.listening
              ? 'border-cyan-300/55 bg-slate-950/75'
              : 'border-cyan-200/30 bg-slate-950/70 focus-within:border-cyan-300/55',
          )}
          style={{
            clipPath: 'polygon(16px 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 0 100%, 0 16px)',
          }}
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={busy ? 'Working…' : 'Say “Hey Assistant”, or type here'}
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] tracking-wide text-cyan-50 placeholder:text-cyan-100/50 focus:outline-none"
          />

          <button
            onClick={submit}
            disabled={draft.trim().length === 0}
            className="grid size-8 shrink-0 place-items-center rounded-full border border-cyan-200/35 text-cyan-200/80 transition hover:border-cyan-200/70 hover:text-cyan-100 disabled:opacity-30"
          >
            <CornerDownLeft className="size-3.5" />
          </button>
        </div>
      </footer>
    </div>
  );
}
