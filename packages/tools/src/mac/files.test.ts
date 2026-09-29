import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserSettings } from '@assistant/schemas';
import { createFolderTool, moveFileTool, openFileTool, searchFilesTool } from './files.js';
import { decide } from '../policy.js';

/**
 * File tools are where a misheard word costs the most, so most of what is
 * tested here is what Assistant *refuses* to do.
 *
 * The round-trip tests run against real files, because the interesting
 * failures — a move that silently overwrote something, a rollback that put the
 * file back on top of a newer one — are exactly what a mocked filesystem
 * cannot show you. They stay inside a temporary folder in the user's own home,
 * because that is the only place the tools will write.
 */

const ctx = { online: true, signal: new AbortController().signal };
const policyCtx = { settings: UserSettings.parse({}), online: true };

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(homedir(), '.assistant-file-tests-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('what the file tools refuse', () => {
  it('will not write outside the home folder', async () => {
    const result = await createFolderTool.execute({ path: '/System/Library/Assistant' }, ctx);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('path_not_allowed');
  });

  /**
   * `~/../../etc` resolves out of the home folder. Checking the string as
   * written rather than as resolved would let it through.
   */
  it('checks the resolved path, not the one it was given', async () => {
    const escape = join(homedir(), '..', '..', 'etc', 'assistant');
    const result = await createFolderTool.execute({ path: escape }, ctx);
    expect(result.isErr()).toBe(true);
  });

  it('refuses relative paths outright', async () => {
    const result = await moveFileTool.execute({ source: 'a.txt', destination: 'b.txt' }, ctx);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/absolute/i);
  });

  it('refuses to act on the home folder itself', async () => {
    const result = await createFolderTool.execute({ path: homedir() }, ctx);
    expect(result.isErr()).toBe(true);
  });

  /**
   * `mv -n` declines silently when the destination exists, and a caller
   * reading only the exit status would report a move that never happened.
   */
  it('will not overwrite an existing destination', async () => {
    const source = join(dir, 'from.txt');
    const destination = join(dir, 'to.txt');
    await writeFile(source, 'one');
    await writeFile(destination, 'two');

    const result = await moveFileTool.execute({ source, destination }, ctx);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('destination_exists');
    // And nothing moved.
    expect(await exists(source)).toBe(true);
  });

  it('reports a missing source rather than creating one', async () => {
    const result = await moveFileTool.execute(
      { source: join(dir, 'nope.txt'), destination: join(dir, 'somewhere.txt') },
      ctx,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('file_not_found');
  });

  it('reports a missing file rather than opening nothing', async () => {
    const result = await openFileTool.execute({ path: join(dir, 'ghost.pdf') }, ctx);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('file_not_found');
  });
});

describe('moving and putting back', () => {
  it('moves, verifies both ends, and rolls back', async () => {
    const source = join(dir, 'note.txt');
    const destination = join(dir, 'moved.txt');
    await writeFile(source, 'contents');

    const moved = await moveFileTool.execute({ source, destination }, ctx);
    expect(moved.isOk()).toBe(true);
    const result = moved._unsafeUnwrap();

    // Verification is about both ends: a copy would satisfy "it is there".
    const verified = await moveFileTool.verify?.(result, ctx);
    expect(verified?._unsafeUnwrap()).toBe(true);

    const undone = await moveFileTool.rollback?.(result, ctx);
    expect((undone?._unsafeUnwrap() as { rolledBack?: boolean }).rolledBack).toBe(true);
    expect(await exists(source)).toBe(true);
    expect(await exists(destination)).toBe(false);
  });

  /**
   * If something new is sitting where the file used to be, putting it back
   * would overwrite that. Undoing one action must not perform another.
   */
  it('declines to roll back onto a path that is occupied again', async () => {
    const source = join(dir, 'taken.txt');
    const destination = join(dir, 'elsewhere.txt');
    await writeFile(source, 'original');

    const moved = await moveFileTool.execute({ source, destination }, ctx);
    await writeFile(source, 'something newer');

    const undone = await moveFileTool.rollback?.(moved._unsafeUnwrap(), ctx);
    const outcome = undone?._unsafeUnwrap() as { rolledBack?: boolean; reason?: string };
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.reason).toMatch(/something else/i);
    expect(await exists(destination)).toBe(true);
  });

  it('creates a folder, confirms it, and removes it again', async () => {
    const path = join(dir, 'new', 'nested');
    const made = await createFolderTool.execute({ path }, ctx);
    const result = made._unsafeUnwrap();
    expect((result as { created?: boolean }).created).toBe(true);
    expect((await createFolderTool.verify?.(result, ctx))?._unsafeUnwrap()).toBe(true);

    const undone = await createFolderTool.rollback?.(result, ctx);
    expect((undone?._unsafeUnwrap() as { rolledBack?: boolean }).rolledBack).toBe(true);
    expect(await exists(path)).toBe(false);
  });

  /** A folder someone has since used is no longer the folder that was made. */
  it('leaves a folder alone once something is in it', async () => {
    const path = join(dir, 'occupied');
    const made = await createFolderTool.execute({ path }, ctx);
    await writeFile(join(path, 'file.txt'), 'something');

    const undone = await createFolderTool.rollback?.(made._unsafeUnwrap(), ctx);
    expect((undone?._unsafeUnwrap() as { rolledBack?: boolean }).rolledBack).toBe(false);
    expect(await exists(path)).toBe(true);
  });

  it('does not claim to have created a folder that was already there', async () => {
    const path = join(dir, 'twice');
    await createFolderTool.execute({ path }, ctx);
    const second = await createFolderTool.execute({ path }, ctx);
    expect((second._unsafeUnwrap() as { created?: boolean }).created).toBe(false);
    expect(createFolderTool.speak?.(second._unsafeUnwrap())).toMatch(/already exists/i);
  });
});

describe('searching', () => {
  it('reads without asking, because it returns paths and not contents', () => {
    expect(searchFilesTool.metadata.risk).toBe('read');
    expect(decide(searchFilesTool.metadata, policyCtx).action).toBe('allow');
  });

  it('says so plainly when nothing matched', () => {
    expect(searchFilesTool.speak?.({ total: 0, query: 'tax return' })).toBe(
      "I couldn't find anything matching tax return.",
    );
  });

  /** A list of file paths read aloud is useless; the model must shorten it. */
  it('declines to read a list of results aloud', () => {
    expect(searchFilesTool.speak?.({ total: 12, query: 'invoice', matches: [] })).toBeNull();
  });

  it('refuses a relative folder to search in', async () => {
    const result = await searchFilesTool.execute(
      { query: 'x', folder: 'Documents', scope: 'name', limit: 10 },
      ctx,
    );
    expect(result.isErr()).toBe(true);
  });
});
