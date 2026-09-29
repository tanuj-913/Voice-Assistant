import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AssistantVoiceProfile } from '@assistant/schemas';

const run = promisify(execFile);

/**
 * Turns a normal TTS voice into Assistant's.
 *
 * Two stages, because no single tool does both well:
 *   1. `rubberband` — pitch and tempo. Shifting pitch *without* preserving
 *      formants scales the whole spectrum, which is what makes the speaker
 *      sound physically small rather than like an adult pitched up.
 *   2. `ffmpeg` — a presence lift around 4kHz so the result cuts through
 *      laptop speakers instead of sounding thin.
 *
 * This is a stylised transform over a licensed TTS voice, deliberately not a
 * clone of any copyrighted character performance.
 */
export async function applyAssistantVoice(
  input: Buffer,
  profile: AssistantVoiceProfile,
): Promise<Buffer> {
  if (!profile.enabled) return input;

  const dir = await mkdtemp(join(tmpdir(), 'assistant-voice-'));
  const inPath = join(dir, 'in.wav');
  const shiftedPath = join(dir, 'shifted.wav');
  const outPath = join(dir, 'out.wav');

  try {
    await writeFile(inPath, input);

    const rubberbandArgs = [
      '--pitch',
      profile.pitchShiftSemitones.toFixed(3),
      '--tempo',
      profile.tempoRatio.toFixed(3),
      // Favour transient clarity; speech artefacts are more audible than in music.
      '--crisp',
      '5',
    ];
    if (profile.preserveFormants) rubberbandArgs.push('--formant');
    rubberbandArgs.push(inPath, shiftedPath);

    await run('rubberband', rubberbandArgs, { timeout: 20_000 });

    if (profile.presenceBoostDb <= 0) {
      return await readFile(shiftedPath);
    }

    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        shiftedPath,
        '-af',
        `equalizer=f=4000:width_type=q:w=1.2:g=${profile.presenceBoostDb.toFixed(1)},alimiter=limit=0.95`,
        outPath,
      ],
      { timeout: 20_000 },
    );

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether the binaries the transform depends on are actually present. */
export async function checkAssistantVoiceTooling(): Promise<{
  rubberband: boolean;
  ffmpeg: boolean;
}> {
  const probe = async (bin: string, args: string[]) => {
    try {
      await run(bin, args, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  };

  // `--version` rather than `--help`: rubberband exits 2 on --help, which a
  // naive probe reads as "not installed" and then silently disables the
  // Assistant voice with only a log line to show for it.
  const [rubberband, ffmpeg] = await Promise.all([
    probe('rubberband', ['--version']),
    probe('ffmpeg', ['-version']),
  ]);
  return { rubberband, ffmpeg };
}

/**
 * Applies a per-phrase pitch shift and joins the results into one clip.
 *
 * Each phrase is shifted independently so the pitch contour across a sentence
 * is shaped rather than constant — the difference between a voice and a
 * character. Concatenation happens after shifting because rubberband works on
 * whole files, and shifting the joined audio would flatten the contour back
 * out again.
 */
export async function renderPhrases(
  clips: readonly { wav: Buffer; pitch: number }[],
  profile: AssistantVoiceProfile,
): Promise<Buffer> {
  if (clips.length === 0) return Buffer.alloc(0);
  if (!profile.enabled) return concatWav(clips.map((c) => c.wav));

  const dir = await mkdtemp(join(tmpdir(), 'assistant-phrases-'));
  try {
    const shifted: string[] = [];

    for (const [index, clip] of clips.entries()) {
      const inPath = join(dir, `in-${String(index)}.wav`);
      const outPath = join(dir, `out-${String(index)}.wav`);
      await writeFile(inPath, clip.wav);

      const args = [
        '--pitch',
        clip.pitch.toFixed(3),
        '--tempo',
        profile.tempoRatio.toFixed(3),
        '--crisp',
        '5',
      ];
      if (profile.preserveFormants) args.push('--formant');
      args.push(inPath, outPath);

      await run('rubberband', args, { timeout: 20_000 });
      shifted.push(outPath);
    }

    const listPath = join(dir, 'list.txt');
    await writeFile(listPath, shifted.map((f) => `file '${f}'`).join('\n'));

    const finalPath = join(dir, 'final.wav');
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-af',
        `equalizer=f=4000:width_type=q:w=1.2:g=${profile.presenceBoostDb.toFixed(1)},alimiter=limit=0.95`,
        finalPath,
      ],
      { timeout: 30_000 },
    );

    return await readFile(finalPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Joins WAVs by keeping the first header and appending the rest's samples. */
function concatWav(clips: readonly Buffer[]): Buffer {
  if (clips.length === 0) return Buffer.alloc(0);
  const first = clips[0];
  if (!first || clips.length === 1) return first ?? Buffer.alloc(0);

  const HEADER = 44;
  const bodies = clips.map((c, i) => (i === 0 ? c.subarray(HEADER) : c.subarray(HEADER)));
  const body = Buffer.concat(bodies);

  const out = Buffer.concat([first.subarray(0, HEADER), body]);
  out.writeUInt32LE(36 + body.length, 4);
  out.writeUInt32LE(body.length, 40);
  return out;
}
