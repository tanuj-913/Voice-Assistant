#!/usr/bin/env node
/**
 * Checks everything Assistant needs before you try to run it.
 *
 * Exists because the failure modes are otherwise silent and confusing: a
 * missing Postgres extension surfaces as a boot crash, a stopped Ollama as
 * "cannot reach Ollama", and a missing whisper model simply turns speech
 * recognition off without saying so.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PASS = '[32m✓[0m';
const FAIL = '[31m✗[0m';
const WARN = '[33m![0m';

let blocking = 0;

function report(status, label, detail) {
  const mark = status === 'pass' ? PASS : status === 'warn' ? WARN : FAIL;
  if (status === 'fail') blocking += 1;
  console.log(`  ${mark} ${label.padEnd(26)} ${detail}`);
}

async function binary(name, args = ['--version']) {
  try {
    // Generous timeout on purpose. At 8s this reported whisper.cpp as missing
    // while the 19GB model was resident and the machine was busy — a checker
    // that produces false failures under load is worse than no checker.
    await run(name, args, { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

function env() {
  if (!existsSync('.env')) return null;
  const out = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  // A real environment variable wins, matching `node --env-file=.env`, which
  // does not overwrite what is already set. Otherwise the doctor would report
  // on a different configuration than the one the brain will actually boot with.
  return { ...out, ...process.env };
}

console.log('\nAssistant — environment check\n');

// --- Required ---------------------------------------------------------------
console.log('Required:');

const cfg = env();
report(cfg ? 'pass' : 'fail', '.env file', cfg ? 'present' : 'missing — run: cp .env.example .env');

const pg = await binary('pg_isready', []);
report(pg ? 'pass' : 'fail', 'PostgreSQL', pg ? 'accepting connections' : 'not running — brew services start postgresql@16');

if (pg) {
  try {
    const { stdout } = await run('psql', ['-d', 'assistant', '-tAc', "SELECT extname FROM pg_extension WHERE extname='vector'"], { timeout: 8000 });
    const ok = stdout.trim() === 'vector';
    report(ok ? 'pass' : 'fail', 'assistant database', ok ? 'exists, pgvector enabled' : 'pgvector missing — psql -d assistant -c "CREATE EXTENSION vector;"');
  } catch {
    report('fail', 'assistant database', 'not found — createdb assistant');
  }
}

const ollamaUp = await reachable('http://127.0.0.1:11434/api/version');
report(ollamaUp ? 'pass' : 'fail', 'Ollama', ollamaUp ? 'running' : 'not running — open -a Ollama');

if (ollamaUp) {
  const model = cfg?.OLLAMA_MODEL || 'qwen3:30b-a3b';
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    const { models = [] } = await res.json();
    const has = models.some((m) => m.name === model);
    report(has ? 'pass' : 'fail', 'LLM model', has ? model : `${model} not pulled — ollama pull ${model}`);
  } catch {
    report('fail', 'LLM model', 'could not list models');
  }
}

// --- Voice ------------------------------------------------------------------
console.log('\nVoice:');

const whisperBin = await binary('whisper-cli', ['--help']);
report(whisperBin ? 'pass' : 'warn', 'whisper.cpp', whisperBin ? 'installed' : 'missing — brew install whisper-cpp');

const modelPath = cfg?.WHISPER_MODEL_PATH || './models/ggml-large-v3-turbo.bin';
const hasModel = existsSync(modelPath);
report(hasModel ? 'pass' : 'warn', 'whisper model', hasModel ? modelPath : `${modelPath} missing — speech input will be off`);

for (const [bin, label] of [['say', 'macOS voices'], ['rubberband', 'Assistant pitch shift'], ['ffmpeg', 'audio processing']]) {
  const args = bin === 'say' ? ['-v', '?'] : ['--version'];
  const ok = await binary(bin, bin === 'ffmpeg' ? ['-version'] : args);
  report(ok ? 'pass' : 'warn', label, ok ? 'ok' : `${bin} missing`);
}

// The trained voice is opt-in, so a stopped converter is only worth reporting
// when it has actually been asked for. Silence here means RVC_ENABLED=false.
if (cfg?.RVC_ENABLED === 'true') {
  const base = cfg.RVC_BASE_URL || 'http://127.0.0.1:4318';
  let model = null;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) ({ model } = await res.json());
  } catch {
    // Unreachable is the answer, not an error.
  }
  report(
    model ? 'pass' : 'warn',
    'voice conversion',
    model
      ? `serving ${model}`
      : `not running at ${base} — Assistant falls back to the pitch-shifted voice. Start it with: pnpm run start:rvc`,
  );
}

// Transcription works either way, so this is a warning about speed rather
// than about function: the server is ~165 ms a turn faster in steady state,
// and avoids a ~2 s penalty on the first utterance after a cold shader cache.
if (cfg?.WHISPER_SERVER_ENABLED !== 'false') {
  const base = cfg?.WHISPER_SERVER_URL || 'http://127.0.0.1:4319';
  let up = false;
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(4000) });
    up = res.status < 500;
  } catch {
    // Unreachable is the answer, not an error.
  }
  report(
    up ? 'pass' : 'warn',
    'whisper server',
    up
      ? `resident at ${base} — transcription is ~165ms faster per turn`
      : `not running at ${base} — every utterance re-spawns whisper-cli (~165ms slower, ~2s on a cold cache). Start it with: pnpm run start:whisper`,
  );
}

// --- Optional ---------------------------------------------------------------
console.log('\nOptional keys:');
report(cfg?.SERPER_API_KEY ? 'pass' : 'warn', 'SERPER_API_KEY', cfg?.SERPER_API_KEY ? 'set — web search enabled' : 'unset — search falls back to a throttled DuckDuckGo scrape');

// The cloud fallback is the one setting that changes where the user's words
// go, so it is reported whether it is on or off rather than only when broken.
if (cfg?.CLOUD_FALLBACK === 'true' || cfg?.CLOUD_FALLBACK === true) {
  report(
    cfg?.GEMINI_API_KEY ? 'warn' : 'fail',
    'CLOUD_FALLBACK',
    cfg?.GEMINI_API_KEY
      ? `ON — turns the fast path cannot route go to ${cfg?.GEMINI_MODEL ?? 'gemini'} and leave this Mac`
      : 'ON but GEMINI_API_KEY is unset — Assistant will stay local',
  );
} else {
  report('pass', 'CLOUD_FALLBACK', 'off — every model call stays on this Mac');
}
report(cfg?.SARVAM_API_KEY ? 'pass' : 'warn', 'SARVAM_API_KEY', cfg?.SARVAM_API_KEY ? 'set' : 'unset — using local whisper + macOS voices');

console.log(
  blocking === 0
    ? `\n${PASS} Ready. Run: pnpm start\n`
    : `\n${FAIL} ${blocking} blocking issue(s) above. Fix those first.\n`,
);
process.exit(blocking === 0 ? 0 : 1);
