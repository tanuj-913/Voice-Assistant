import { AnimatePresence, motion } from 'motion/react';
import { Check, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  deleteMemory,
  editMemory,
  fetchMemories,
  fetchSettings,
  fetchTools,
  patchSettings,
  type RemoteMemory,
  type RemoteSettings,
  type ToolDeclaration,
} from '../lib/api.js';
import { cn } from '../lib/cn.js';

/**
 * The panel where Assistant stops being a black box.
 *
 * Three things live here because all three were previously invisible: the
 * settings (which existed as a schema nobody could edit), the facts Assistant has
 * stored about you, and the full list of what it can do and on what terms.
 *
 * Deliberately not here: the voice profile. Those settings are read once when
 * the speech stack is built, so offering them would mean a control that
 * appears to work and does not until the next restart.
 */

type Tab = 'settings' | 'memory' | 'tools';

const LANGUAGES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Follow what I speak' },
  { value: 'en-IN', label: 'English' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'ta-IN', label: 'Tamil' },
  { value: 'te-IN', label: 'Telugu' },
  { value: 'od-IN', label: 'Odia' },
  { value: 'bn-IN', label: 'Bengali' },
  { value: 'gu-IN', label: 'Gujarati' },
  { value: 'kn-IN', label: 'Kannada' },
  { value: 'ml-IN', label: 'Malayalam' },
  { value: 'mr-IN', label: 'Marathi' },
  { value: 'pa-IN', label: 'Punjabi' },
];

export function ControlPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('settings');
  const [settings, setSettings] = useState<RemoteSettings | null>(null);
  const [memories, setMemories] = useState<RemoteMemory[] | null>(null);
  const [memoryConfigured, setMemoryConfigured] = useState(true);
  const [tools, setTools] = useState<ToolDeclaration[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; fact: string } | null>(null);

  const fail = useCallback((error: unknown) => {
    // Surfaced rather than swallowed: a panel that silently fails to save is
    // indistinguishable from one that saved.
    setProblem(error instanceof Error ? error.message : 'Something went wrong.');
  }, []);

  // Loaded when the panel opens rather than on mount, so a closed panel costs
  // nothing and a reopened one shows current state.
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    void fetchSettings().then(setSettings).catch(fail);
    void fetchMemories()
      .then((result) => {
        setMemories(result.memories);
        setMemoryConfigured(result.configured);
      })
      .catch(fail);
    void fetchTools().then(setTools).catch(fail);
  }, [open, fail]);

  const change = (patch: Partial<RemoteSettings>) => {
    setSaving(true);
    setProblem(null);
    patchSettings(patch)
      .then(setSettings)
      .catch(fail)
      .finally(() => {
        setSaving(false);
      });
  };

  const saveEdit = () => {
    if (!editing) return;
    const { id, fact } = editing;
    const existing = memories?.find((m) => m.id === id);
    editMemory(id, fact, existing?.tags ?? [])
      .then((updated) => {
        setMemories((prev) => prev?.map((m) => (m.id === id ? updated : m)) ?? null);
        setEditing(null);
      })
      .catch(fail);
  };

  const forget = (id: string) => {
    deleteMemory(id)
      .then(() => {
        setMemories((prev) => prev?.filter((m) => m.id !== id) ?? null);
      })
      .catch(fail);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-30 flex justify-end bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.aside
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 220, damping: 26 }}
            onClick={(event) => {
              event.stopPropagation();
            }}
            className="flex h-full w-full max-w-md flex-col border-l border-cyan-200/20 bg-slate-950/95"
          >
            <header className="flex items-center gap-2 border-b border-cyan-200/10 px-4 py-3">
              {(['settings', 'memory', 'tools'] as const).map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    setTab(name);
                  }}
                  className={cn(
                    'font-mono text-[10px] tracking-[0.28em] uppercase transition',
                    tab === name ? 'text-cyan-100' : 'text-cyan-100/35 hover:text-cyan-100/70',
                  )}
                >
                  {name}
                </button>
              ))}
              <span className="flex-1" />
              {saving && <Loader2 className="size-3.5 animate-spin text-cyan-200/60" />}
              <button
                onClick={onClose}
                aria-label="Close"
                className="text-cyan-100/40 transition hover:text-cyan-100"
              >
                <X className="size-4" />
              </button>
            </header>

            {problem && (
              <p className="border-b border-rose-500/20 bg-rose-950/40 px-4 py-2 text-[11px] text-rose-200/90">
                {problem}
              </p>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-[12px] text-cyan-50/85">
              {tab === 'settings' && settings && (
                <div className="space-y-5">
                  <Field
                    label="Wake word"
                    hint="Off means everything you say is treated as addressed to Assistant."
                  >
                    <Toggle
                      on={settings.wakeWordEnabled}
                      onChange={(on) => {
                        change({ wakeWordEnabled: on });
                      }}
                      label={settings.wakeWordEnabled ? 'Say “Hey Assistant” first' : 'Always on'}
                    />
                  </Field>

                  <Field label="Reply language" hint="Auto answers in whatever you spoke.">
                    <select
                      value={settings.preferredLanguage}
                      onChange={(event) => {
                        change({ preferredLanguage: event.target.value });
                      }}
                      className="w-full border border-cyan-200/25 bg-slate-900/80 px-2 py-1.5 font-mono text-[12px] text-cyan-50 focus:border-cyan-300/60 focus:outline-none"
                    >
                      {LANGUAGES.map((language) => (
                        <option key={language.value} value={language.value}>
                          {language.label}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field
                    label="Stay local"
                    hint="Prefers on-device models even when the network is available."
                  >
                    <Toggle
                      on={settings.offlineFirst}
                      onChange={(on) => {
                        change({ offlineFirst: on });
                      }}
                      label={settings.offlineFirst ? 'Local first' : 'Use the network freely'}
                    />
                  </Field>

                  {/*
                    The two lists that the policy engine reads. Shown as plain
                    text rather than a picker because they are rarely edited
                    and the engine's rules matter more than the convenience:
                    approving a tool here can never unlock a destructive one.
                  */}
                  <Field
                    label="Approved without asking"
                    hint="Only ever applies to actions that leave your Mac. Deleting, the shell and reading your screen always ask, whatever is listed here."
                  >
                    <TokenList
                      values={settings.autoApprovedTools}
                      empty="Nothing — every external action is confirmed."
                      onRemove={(name) => {
                        change({
                          autoApprovedTools: settings.autoApprovedTools.filter((t) => t !== name),
                        });
                      }}
                    />
                  </Field>

                  <Field label="Always ask" hint="Beats everything above.">
                    <TokenList
                      values={settings.alwaysConfirmTools}
                      empty="Nothing pinned."
                      onRemove={(name) => {
                        change({
                          alwaysConfirmTools: settings.alwaysConfirmTools.filter((t) => t !== name),
                        });
                      }}
                    />
                  </Field>
                </div>
              )}

              {tab === 'memory' && (
                <div className="space-y-2">
                  {!memoryConfigured && (
                    <p className="text-cyan-100/50">Long-term memory is not configured.</p>
                  )}
                  {memories?.length === 0 && memoryConfigured && (
                    <p className="text-cyan-100/50">Assistant has not stored anything about you.</p>
                  )}
                  {memories?.map((memory) => (
                    <div
                      key={memory.id}
                      className="group border border-cyan-200/10 bg-white/[0.02] px-3 py-2"
                    >
                      {editing?.id === memory.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            autoFocus
                            value={editing.fact}
                            onChange={(event) => {
                              setEditing({ id: memory.id, fact: event.target.value });
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') saveEdit();
                              if (event.key === 'Escape') setEditing(null);
                            }}
                            className="min-w-0 flex-1 bg-transparent text-cyan-50 focus:outline-none"
                          />
                          <button onClick={saveEdit} aria-label="Save" className="text-cyan-200">
                            <Check className="size-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 leading-relaxed">{memory.fact}</p>
                          <button
                            onClick={() => {
                              setEditing({ id: memory.id, fact: memory.fact });
                            }}
                            aria-label={`Edit: ${memory.fact}`}
                            className="text-cyan-100/30 transition group-hover:text-cyan-100/80"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              forget(memory.id);
                            }}
                            aria-label={`Forget: ${memory.fact}`}
                            className="text-rose-300/40 transition group-hover:text-rose-300"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {tab === 'tools' && (
                <div className="space-y-1.5">
                  {tools?.map((tool) => (
                    <details key={tool.name} className="border border-cyan-200/10 bg-white/[0.02]">
                      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-mono text-[11px]">
                        <span className="flex-1 truncate text-cyan-100/90">{tool.name}</span>
                        <span
                          className={cn(
                            'text-[9px] tracking-[0.2em] uppercase',
                            tool.confirmation === 'allow'
                              ? 'text-cyan-200/50'
                              : 'text-amber-300/80',
                          )}
                        >
                          {tool.confirmation === 'allow' ? 'runs' : 'asks'}
                        </span>
                      </summary>
                      <div className="space-y-1 px-3 pb-3 text-[11px] text-cyan-100/60">
                        <p className="leading-relaxed text-cyan-50/70">{tool.description}</p>
                        <p className="font-mono text-[10px]">
                          {tool.connector} · {tool.risk} · verify: {tool.verification} · undo:{' '}
                          {tool.rollback}
                        </p>
                        {tool.scopes.length > 0 && (
                          <p className="font-mono text-[10px]">needs: {tool.scopes.join(', ')}</p>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-[10px] tracking-[0.28em] text-cyan-100/50 uppercase">{label}</p>
      {children}
      <p className="text-[10px] leading-relaxed text-cyan-100/35">{hint}</p>
    </div>
  );
}

function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => {
        onChange(!on);
      }}
      className={cn(
        'flex w-full items-center justify-between border px-3 py-1.5 text-left transition',
        on
          ? 'border-cyan-300/45 bg-cyan-400/10 text-cyan-100'
          : 'border-cyan-200/15 bg-white/[0.02] text-cyan-100/50',
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          'size-2 rounded-full',
          on ? 'bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.9)]' : 'bg-cyan-100/20',
        )}
      />
    </button>
  );
}

function TokenList({
  values,
  empty,
  onRemove,
}: {
  values: string[];
  empty: string;
  onRemove: (value: string) => void;
}) {
  if (values.length === 0) return <p className="text-[11px] text-cyan-100/40">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <button
          key={value}
          onClick={() => {
            onRemove(value);
          }}
          aria-label={`Remove ${value}`}
          className="flex items-center gap-1 border border-cyan-200/20 bg-white/[0.03] px-2 py-1 font-mono text-[10px] text-cyan-100/80 transition hover:border-rose-300/40 hover:text-rose-200"
        >
          {value}
          <X className="size-2.5" />
        </button>
      ))}
    </div>
  );
}
