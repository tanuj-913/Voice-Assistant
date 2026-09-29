import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Swift helpers, compiled on first use.
 *
 * Checked in as source rather than as binaries: a committed executable is
 * unreviewable, and `swiftc` is present on any Mac with the command line
 * tools. The build is cached under `.cache/native`, so the cost is paid once
 * per install, and concurrent callers share one compile rather than racing to
 * write the same file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(process.cwd(), '.cache', 'native');

const building = new Map<string, Promise<string>>();

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureNativeBinary(name: string): Promise<string> {
  const binary = join(CACHE_DIR, name);
  if (await exists(binary)) return binary;

  const existing = building.get(name);
  if (existing) return existing;

  const build = (async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    try {
      await run('swiftc', ['-O', '-o', binary, join(here, 'native', `${name}.swift`)], {
        timeout: 120_000,
      });
    } catch (error) {
      // Named precisely: "authentication failed" or "OCR failed" would send
      // someone hunting in the wrong place for a missing Xcode CLT install.
      throw new Error(
        `could not compile the ${name} helper — is swiftc installed? (xcode-select --install)`,
        { cause: error },
      );
    }
    return binary;
  })();

  building.set(name, build);
  try {
    return await build;
  } finally {
    building.delete(name);
  }
}
