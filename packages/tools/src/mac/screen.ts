import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fromPromise } from '@assistant/core';
import { ReadScreenInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { ensureNativeBinary } from './native.js';

const run = promisify(execFile);

/**
 * Reading what is on screen, without a vision model.
 *
 * `capture_screen` returns a file path, and a text-only model cannot see it —
 * so it can confirm a screenshot happened and nothing more. The README named
 * the two ways out: a vision-capable model, or an OCR pass. This is the OCR
 * pass, using the Vision framework that ships with macOS. No download, no API,
 * no second model competing for memory, and it works offline.
 *
 * The Swift helper is compiled on first use — see `native.ts`, which the
 * authentication helper shares.
 */

export const readScreenTool = defineTool({
  metadata: {
    name: 'read_screen',
    description:
      'Capture the screen or the frontmost window and read the text on it. Use for "what does this error say", "what is on my screen", or to read a dialog the user is looking at.',
    category: 'system',
    /**
     * Same gate as `capture_screen`, and for a stronger reason: this one
     * returns the contents rather than a path. Whatever is on screen — a
     * password manager, someone's messages — becomes text in the transcript.
     * It always asks.
     */
    risk: 'destructive',
    connector: 'macos-native',
    requiredPermissions: ['screen-recording'],
    timeoutMs: 60_000,
  },
  input: ReadScreenInput,
  execute: (args, ctx) =>
    fromPromise(
      (async () => {
        const binary = await ensureNativeBinary('ocr');
        const dir = await mkdtemp(join(tmpdir(), 'assistant-read-'));
        const path = join(dir, 'screen.png');
        try {
          // -x suppresses the shutter sound; -o omits the window shadow.
          const flags = args.mode === 'window' ? ['-x', '-o', '-W'] : ['-x'];
          await run('screencapture', [...flags, path], { timeout: 20_000, signal: ctx.signal });

          const info = await stat(path);
          if (info.size === 0) throw new Error('the capture produced an empty file');

          const { stdout } = await run(binary, [path], {
            timeout: 40_000,
            maxBuffer: 4 * 1024 * 1024,
            signal: ctx.signal,
          });

          const lines = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

          return {
            mode: args.mode,
            lineCount: lines.length,
            // Bounded: a full screen of text is not something to read aloud,
            // and an unbounded dump would crowd out the rest of the prompt.
            text: lines.slice(0, 120).join('\n'),
            truncated: lines.length > 120,
          };
        } finally {
          // The screenshot is deleted either way. It may contain anything.
          await rm(dir, { recursive: true, force: true });
        }
      })(),
      'read_screen_failed',
    ),
  speak: (result) => {
    const r = result as { lineCount?: unknown };
    // Nothing found is a complete answer. Anything else is for the model to
    // summarise — reading a screen aloud verbatim is useless.
    return r.lineCount === 0 ? "I can't see any text on the screen." : null;
  },
});
