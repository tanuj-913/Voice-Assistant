import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn.js';
import type { TranscriptEntry } from '../store/assistant.js';

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-1 py-2">
      <AnimatePresence initial={false}>
        {entries.map((entry) => (
          <motion.div
            key={entry.id}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'max-w-[86%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed backdrop-blur-sm',
              entry.role === 'user'
                ? 'self-end rounded-br-md border border-white/10 bg-white/[0.07] text-white/85'
                : 'self-start rounded-bl-md border border-cyan-300/20 bg-cyan-400/[0.06] text-cyan-50/95',
            )}
          >
            {entry.text}
            {entry.streaming && (
              <motion.span
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
                className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] rounded-full bg-cyan-300"
              />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
      <div ref={endRef} />
    </div>
  );
}
