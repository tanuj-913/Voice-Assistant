#!/usr/bin/env node
/**
 * Stops Assistant's own processes, and only those.
 *
 * Deliberately targets ports rather than matching process names. A pattern
 * like `pkill -f vite` looks equivalent and is not — it also matches `vitest`
 * running in an unrelated project, and will happily kill someone's test suite
 * in another window. Ports are unambiguous.
 *
 * Ollama is left alone: it is a shared background service, not part of Assistant.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PORTS = [
  { port: 4317, name: 'brain' },
  { port: 5273, name: 'UI dev server' },
  // The converter is Python, so it needs its own signature: `python` alone
  // would match anything else the user happens to be running.
  { port: 4318, name: 'voice conversion', ours: /rvc_server\.py/ },
  // Same reasoning as the converter: match the binary, not the runtime, so a
  // whisper the user is running for something else is left alone.
  { port: 4319, name: 'whisper server', ours: /whisper-server/ },
];

/** Only kill processes we recognise; a browser holding the port is not ours. */
const DEFAULT_OURS = /node|vite/i;

for (const { port, name, ours = DEFAULT_OURS } of PORTS) {
  let pids = [];
  try {
    const { stdout } = await run('lsof', ['-ti', `:${port}`], { timeout: 5000 });
    pids = stdout.split('\n').filter(Boolean);
  } catch {
    console.log(`  ${name} (:${port}) — not running`);
    continue;
  }

  let killed = 0;
  for (const pid of pids) {
    let command = '';
    try {
      const { stdout } = await run('ps', ['-o', 'command=', '-p', pid], { timeout: 5000 });
      command = stdout.trim();
    } catch {
      continue;
    }

    // A browser tab with an open connection also holds the port. Killing that
    // would take out the user's browser, which is not what "stop Assistant" means.
    if (!ours.test(command)) {
      console.log(`  ${name} (:${port}) — skipping pid ${pid} (not ours: ${command.slice(0, 40)})`);
      continue;
    }

    try {
      process.kill(Number(pid), 'SIGTERM');
      killed += 1;
    } catch {
      /* already gone */
    }
  }

  console.log(`  ${name} (:${port}) — ${killed > 0 ? `stopped (${killed})` : 'nothing of ours running'}`);
}

/**
 * SIGTERM returns immediately; the socket does not.
 *
 * `pnpm start` runs this and then binds straight away, so returning before the
 * port is actually free produced EADDRINUSE and a restart loop against a
 * process that was already on its way out.
 */
for (const { port, name } of PORTS) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let held = false;
    try {
      const { stdout } = await run('lsof', ['-ti', `:${port}`], { timeout: 5000 });
      held = stdout.trim().length > 0;
    } catch {
      held = false; // lsof exits non-zero when nothing holds the port
    }
    if (!held) break;
    if (attempt === 19) {
      console.log(`  ${name} (:${port}) — still held after 10s; start may fail`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

console.log('\nOllama left running (shared service). Quit it from the menu bar if you want the memory back.');
