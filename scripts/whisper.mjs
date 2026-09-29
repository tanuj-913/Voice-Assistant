#!/usr/bin/env node
/**
 * Runs a resident whisper-server alongside the app.
 *
 * Transcription otherwise spawns `whisper-cli` per utterance. Measured on this
 * machine, alternating runs, same clip and model and thread count:
 *
 *     whisper-cli     median 789 ms
 *     whisper-server  median 626 ms
 *
 * So ~165 ms a turn — worth having, but an early reading of 2,076-2,502 ms for
 * the CLI (which would have made this a 1.5 s win) turned out to be a cold
 * Metal shader cache, not the steady state. The other benefit is real though:
 * the server compiles those shaders once here at start-up, where the CLI pays
 * ~2 s on the first utterance after any cache eviction.
 *
 * Exits 0 when disabled or when the binary is absent, so it can sit in the
 * normal start-up list: the provider falls back to the CLI on its own.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function env() {
  const path = join(root, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const cfg = { ...env(), ...process.env };

if (cfg.WHISPER_SERVER_ENABLED === 'false') {
  console.log('whisper server off (WHISPER_SERVER_ENABLED=false) — the CLI will be used');
  process.exit(0);
}

const model = resolve(root, cfg.WHISPER_MODEL_PATH ?? './models/ggml-large-v3-turbo.bin');
if (!existsSync(model)) {
  console.error(`whisper model missing (${model}) — falling back to the CLI.`);
  process.exit(0); // Never take the app down over a speed-up.
}

const port = new URL(cfg.WHISPER_SERVER_URL ?? 'http://127.0.0.1:4319').port || '4319';
// `--convert` lets the server accept whatever sample rate the browser records
// at, rather than refusing anything that is not 16 kHz.
const args = ['-m', model, '--port', port, '-t', cfg.WHISPER_THREADS ?? '6', '--convert'];

const binary = cfg.WHISPER_SERVER_BINARY ?? 'whisper-server';
const child = spawn(binary, args, { stdio: 'inherit' });

child.on('error', (error) => {
  console.error(`could not start ${binary} (${error.message}) — falling back to the CLI.`);
  process.exit(0);
});

const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
