import { AnimatePresence, motion } from 'motion/react';
import { Check, Fingerprint, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { cn } from '../lib/cn.js';
import type { PendingTool } from '../store/assistant.js';

/**
 * The consent gate.
 *
 * Raw arguments are shown verbatim rather than paraphrased. A friendly summary
 * is exactly where the wrong filename, the wrong contact, or an unexpected
 * `rm` would hide — and for destructive actions this prompt is the last thing
 * standing between the model and something irreversible.
 */

/**
 * One entry per risk level. The card is the last thing between the model and
 * an irreversible action, so the label says what will actually happen rather
 * than how the code classifies it — "This leaves your Mac" is useful, "orange"
 * is not.
 */
const RISK_STYLES = {
  critical: {
    frame: 'border-rose-500/60 bg-rose-950/60',
    accent: 'text-rose-200',
    allow: 'bg-rose-500 text-rose-50 hover:bg-rose-400',
    label: 'Sensitive — money, credentials or security',
    Icon: TriangleAlert,
  },
  destructive: {
    frame: 'border-rose-500/45 bg-rose-950/45',
    accent: 'text-rose-300',
    allow: 'bg-rose-500/85 text-rose-50 hover:bg-rose-400',
    label: 'Destructive action',
    Icon: TriangleAlert,
  },
  external: {
    frame: 'border-amber-400/35 bg-amber-950/40',
    accent: 'text-amber-300',
    allow: 'bg-amber-400/85 text-amber-950 hover:bg-amber-300',
    label: 'This leaves your Mac and cannot be taken back',
    Icon: ShieldAlert,
  },
  reversible: {
    frame: 'border-hud/30 bg-hud/10',
    accent: 'text-hud',
    allow: 'bg-hud/80 text-slate-950 hover:bg-hud',
    label: 'Confirm action',
    Icon: ShieldAlert,
  },
  read: {
    frame: 'border-hud/30 bg-hud/10',
    accent: 'text-hud',
    allow: 'bg-hud/80 text-slate-950 hover:bg-hud',
    label: 'Confirm action',
    Icon: ShieldAlert,
  },
} as const;

export function ToolConfirm({
  pending,
  onDecide,
}: {
  pending: PendingTool | null;
  onDecide: (approved: boolean) => void;
}) {
  // Defaults to the strictest styling: an unknown level should look more
  // alarming than it is, never less.
  const style = RISK_STYLES[pending?.risk ?? 'destructive'];
  const { Icon } = style;

  return (
    <AnimatePresence>
      {pending && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className={cn('rounded-xl border p-3 backdrop-blur-md', style.frame)}
        >
          <div className={cn('mb-2 flex items-center gap-2', style.accent)}>
            <Icon className="size-4" />
            <span className="text-xs font-semibold tracking-wide uppercase">{style.label}</span>
            {(pending.risk === 'destructive' || pending.risk === 'critical') && (
              <span className="ml-auto rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-medium text-rose-200">
                always asks
              </span>
            )}
          </div>

          <div className={cn('mb-1.5 font-mono text-sm', style.accent)}>{pending.name}</div>

          {/*
            Said before it happens. A Touch ID sheet appearing unannounced,
            seconds after you clicked Allow, reads as something going wrong —
            and a user who does not expect it is a user who cancels it.
          */}
          {pending.strength === 'strong' && (
            <p className="mb-2 flex items-center gap-1.5 text-[11px] text-white/70">
              <Fingerprint className="size-3.5" />
              You will be asked for Touch ID or your login password.
            </p>
          )}

          {pending.reason && (
            <p className="mb-2 text-[12px] leading-relaxed text-white/70">{pending.reason}</p>
          )}

          <pre className="mb-2 max-h-32 overflow-auto rounded-md bg-black/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-white/80">
            {JSON.stringify(pending.arguments, null, 2)}
          </pre>

          {pending.permissions.length > 0 && (
            <p className="mb-2 text-[11px] text-white/45">
              Needs macOS permission: {pending.permissions.join(', ')}
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => {
                onDecide(true);
              }}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition',
                style.allow,
              )}
            >
              <Check className="size-3.5" /> Allow once
            </button>
            <button
              onClick={() => {
                onDecide(false);
              }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-white/15 py-1.5 text-xs font-semibold text-white/75 transition hover:bg-white/10"
            >
              <X className="size-3.5" /> Deny
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
