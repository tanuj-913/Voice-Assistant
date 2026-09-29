#!/usr/bin/env node
/**
 * Runs the voice-conversion server alongside the app.
 *
 * The converter is a separate Python process because it holds ~800 MB of
 * models resident and must not be reloaded per sentence. Without this it has
 * to be started by hand, which means the trained voice silently degrades to
 * the pitch-shifted one whenever somebody forgets — the exact failure the
 * boot-time probe was added to surface.
 *
 * Exits 0 immediately when RVC_ENABLED is not true, so it can sit in the
 * normal start-up list without forcing anyone to run Python.
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

if (cfg.RVC_ENABLED !== 'true') {
  console.log('voice conversion off (RVC_ENABLED is not true) — nothing to start');
  process.exit(0);
}

const python = join(root, 'voice-training', '.venv', 'bin', 'python');
const server = join(root, 'voice-training', 'rvc_server.py');

for (const [path, hint] of [
  [python, 'the voice-training virtualenv is missing'],
  [server, 'rvc_server.py is missing'],
]) {
  if (!existsSync(path)) {
    console.error(`RVC_ENABLED is true but ${hint} (${path}).`);
    console.error('Assistant will still speak — it falls back to the pitch-shifted voice.');
    process.exit(0); // Not fatal: never take the app down over an optional voice.
  }
}

const port = new URL(cfg.RVC_BASE_URL ?? 'http://127.0.0.1:4318').port || '4318';
// A pinned checkpoint wins over "newest on disk": the voice was chosen by
// ear, and a later epoch is not automatically a better one.
const args = [server, '--port', port];
if (cfg.RVC_MODEL) args.push('--model', cfg.RVC_MODEL);

const child = spawn(python, args, { stdio: 'inherit' });

const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
