import { motion } from 'motion/react';

/**
 * Status text rendered inside the reactor, lit letter by letter.
 *
 * Per-letter animation rather than a single fading word: a whole word pulsing
 * reads as a loading spinner, while letters lighting in sequence reads as a
 * machine spelling something out. The glow is a text-shadow in the current
 * colour, so it inherits whatever tint the state has.
 */
const SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function segment(text: string): string[] {
  if (!SEGMENTER) return text.split(' ').join(' ').match(/./gu) ?? [];
  return [...SEGMENTER.segment(text)].map((entry) => entry.segment);
}

export function GlowText({ text, className }: { text: string; className: string }) {
  // Grapheme clusters, not code points. Spreading a string splits Devanagari
  // conjuncts and combining marks apart, so a Hindi or Telugu label would
  // render as broken fragments — each with its own glow.
  const letters = segment(text);

  return (
    <span className={className} aria-label={text}>
      {letters.map((char, index) => (
        <motion.span
          key={`${char}-${String(index)}`}
          aria-hidden
          className="inline-block"
          style={{
            // Two shadows: a tight halo for legibility, a wide one for bloom.
            textShadow: '0 0 6px currentColor, 0 0 22px currentColor',
          }}
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{
            duration: 2.1,
            repeat: Infinity,
            // Stagger by position so the light sweeps across the word.
            delay: index * 0.085,
            ease: 'easeInOut',
          }}
        >
          {char === ' ' ? ' ' : char}
        </motion.span>
      ))}
    </span>
  );
}
