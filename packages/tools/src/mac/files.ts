import { mkdir, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { appError, errAsync, fromPromise, okAsync, type AppResultAsync } from '@assistant/core';
import { CreateFolderInput, MoveFileInput, OpenFileInput, SearchFilesInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runCommand } from './osascript.js';

/**
 * Finding, opening and organising files.
 *
 * Everything here is bounded by one rule: Assistant writes inside the user's home
 * folder and on mounted volumes, and nowhere else. A misheard path is the
 * expected failure mode of a voice assistant, and the difference between a
 * misheard path inside `~/Documents` and one that lands in `/System` is the
 * difference between a mess and a broken Mac. The check is on the *resolved*
 * path, so `~/../../etc` does not slip through.
 */

const HOME = homedir();

/** Absolute, resolved, and inside somewhere the user actually owns. */
function checkWritable(path: string): string | null {
  if (!isAbsolute(path)) return 'Path must be absolute — a relative path is ambiguous here.';
  const full = resolve(path);
  if (full === HOME) return 'Refusing to act on the home folder itself.';
  if (full.startsWith(`${HOME}/`) || full.startsWith('/Volumes/')) return null;
  return `Refusing to write outside your home folder or a mounted volume (${full}).`;
}

function rejectPath(reason: string): AppResultAsync<never> {
  return errAsync(appError('path_not_allowed', reason, { retryable: false }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const searchFilesTool = defineTool({
  metadata: {
    name: 'search_files',
    description:
      'Find files on this Mac by name or by the text inside them, using Spotlight. Use for "find my tax pdf" or "which file mentions the invoice number".',
    category: 'system',
    // Returns paths, not contents. Reading one is a separate, gated decision.
    risk: 'read',
    connector: 'macos-cli',
    timeoutMs: 20_000,
    // Spotlight occasionally returns nothing while its index is busy; asking
    // twice is free and changes nothing on disk.
    retry: { maxAttempts: 2, backoffMs: 300 },
  },
  input: SearchFilesInput,
  execute: (args, ctx) => {
    if (args.folder !== undefined && !isAbsolute(args.folder)) {
      return rejectPath('The folder to search must be an absolute path.');
    }
    // `mdfind -name x` matches file names; the bare form searches indexed
    // content. Both take the query as its own argv entry, so a query of
    // `foo && rm -rf ~` is a search for that literal string.
    const argv = [
      ...(args.folder === undefined ? [] : ['-onlyin', args.folder]),
      ...(args.scope === 'name' ? ['-name'] : []),
      args.query,
    ];

    return runCommand('mdfind', argv, { signal: ctx.signal }).map((out) => {
      const paths = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return {
        query: args.query,
        scope: args.scope,
        matches: paths.slice(0, args.limit),
        total: paths.length,
        truncated: paths.length > args.limit,
      };
    });
  },
  speak: (result) => {
    const r = result as { total?: unknown; query?: unknown };
    // Nothing found is a complete answer. Anything else is a list, and a list
    // of paths read aloud is useless without the model shortening it.
    return r.total === 0 && typeof r.query === 'string'
      ? `I couldn't find anything matching ${r.query}.`
      : null;
  },
});

export const openFileTool = defineTool({
  metadata: {
    name: 'open_file',
    description:
      'Open a file or folder in whichever application handles it, the same as double-clicking it in Finder.',
    category: 'system',
    risk: 'reversible',
    connector: 'macos-cli',
    timeoutMs: 15_000,
  },
  input: OpenFileInput,
  execute: (args, ctx) => {
    if (!isAbsolute(args.path)) return rejectPath('Path must be absolute.');
    return fromPromise(exists(args.path), 'open_file_failed').andThen((there) =>
      there
        ? runCommand('open', [args.path], { signal: ctx.signal }).map(() => ({
            opened: args.path,
          }))
        : errAsync(
            appError('file_not_found', `There is nothing at ${args.path}.`, { retryable: false }),
          ),
    );
  },
  speak: (result) =>
    typeof (result as { opened?: unknown }).opened === 'string' ? 'Opened it.' : null,
});

export const createFolderTool = defineTool({
  metadata: {
    name: 'create_folder',
    description: 'Create a new folder at an absolute path, including any missing parent folders.',
    category: 'system',
    risk: 'reversible',
    connector: 'macos-cli',
    timeoutMs: 10_000,
  },
  input: CreateFolderInput,
  execute: (args) => {
    const problem = checkWritable(args.path);
    if (problem !== null) return rejectPath(problem);
    const path = resolve(args.path);

    return fromPromise(
      (async () => {
        const already = await exists(path);
        await mkdir(path, { recursive: true });
        return { path, created: !already };
      })(),
      'create_folder_failed',
    );
  },
  verify: (result) => {
    const path = (result as { path?: unknown }).path;
    return typeof path === 'string' ? fromPromise(exists(path), 'stat_failed') : okAsync(false);
  },
  /**
   * Only removes it if it is still empty. A folder the user has since put
   * something in is no longer the thing that was created, and undoing the
   * creation must not take the contents with it.
   */
  rollback: (result) => {
    const r = result as { path?: unknown; created?: unknown };
    if (typeof r.path !== 'string' || r.created !== true) {
      return okAsync({ rolledBack: false, reason: 'the folder already existed' });
    }
    const path = r.path;
    return fromPromise(
      rmdir(path).then(
        () => ({ rolledBack: true, path }),
        () => ({ rolledBack: false, reason: 'the folder is no longer empty' }),
      ),
      'rollback_failed',
    );
  },
  speak: (result) => {
    const r = result as { created?: unknown };
    return r.created === true ? 'Made that folder.' : 'That folder already exists.';
  },
});

export const moveFileTool = defineTool({
  metadata: {
    name: 'move_file',
    description:
      'Move or rename a file or folder. Refuses to overwrite anything already at the destination.',
    category: 'system',
    risk: 'reversible',
    connector: 'macos-cli',
    timeoutMs: 30_000,
  },
  input: MoveFileInput,
  execute: (args, ctx) => {
    for (const path of [args.source, args.destination]) {
      const problem = checkWritable(path);
      if (problem !== null) return rejectPath(problem);
    }
    const source = resolve(args.source);
    const destination = resolve(args.destination);
    if (source === destination) {
      return rejectPath('The source and the destination are the same path.');
    }

    return fromPromise(
      Promise.all([exists(source), exists(destination)]),
      'move_file_failed',
    ).andThen(([from, to]) => {
      if (!from) {
        return errAsync(
          appError('file_not_found', `There is nothing at ${source}.`, { retryable: false }),
        );
      }
      if (to) {
        // `mv -n` would silently do nothing here, which the caller would read
        // as success. Refusing loudly is the only honest option.
        return errAsync(
          appError(
            'destination_exists',
            `Something is already at ${destination}. Nothing was moved.`,
            { retryable: false },
          ),
        );
      }
      // `mv` rather than `rename`, which fails across volumes — moving a file
      // to an external disk is an ordinary thing to ask for.
      return runCommand('mv', ['-n', source, destination], { signal: ctx.signal }).map(() => ({
        source,
        destination,
      }));
    });
  },
  verify: (result) => {
    const r = result as { source?: unknown; destination?: unknown };
    if (typeof r.source !== 'string' || typeof r.destination !== 'string') return okAsync(false);
    const { source, destination } = r;
    return fromPromise(
      Promise.all([exists(destination), exists(source)]).then(([there, gone]) => there && !gone),
      'stat_failed',
    );
  },
  /** Moves it straight back, and only if nothing has taken the old place. */
  rollback: (result, ctx) => {
    const r = result as { source?: unknown; destination?: unknown };
    if (typeof r.source !== 'string' || typeof r.destination !== 'string') {
      return okAsync({ rolledBack: false, reason: 'nothing to undo' });
    }
    const { source, destination } = r;
    return fromPromise(exists(source), 'stat_failed').andThen((taken) =>
      taken
        ? okAsync({ rolledBack: false, reason: `something else is at ${source} now` })
        : runCommand('mv', ['-n', destination, source], { signal: ctx.signal }).map(() => ({
            rolledBack: true,
            path: source,
          })),
    );
  },
  speak: (result) => {
    const r = result as { destination?: unknown };
    return typeof r.destination === 'string' ? 'Moved it.' : null;
  },
});
