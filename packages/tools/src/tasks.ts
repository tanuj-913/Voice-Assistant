import { z } from 'zod';
import { appError, errAsync, fromPromise } from '@assistant/core';
import { defineTool } from './registry.js';

/**
 * Multi-step tasks that outlive the turn that started them.
 *
 * The PRD asks for "project/task continuation using context". Task state
 * already existed inside a turn — a plan knows which steps ran — but it died
 * with the process, so "did you finish moving those photos?" the next morning
 * had nothing behind it. This is the store that survives, and the two tools
 * that let the user ask about it and let it go.
 *
 * Injected like the memory store, so a turn is testable without Postgres.
 */

export interface OpenTask {
  id: string;
  goal: string;
  status: string;
  summary: string | null;
}

export interface TaskStore {
  start: (goal: string) => Promise<string>;
  finish: (
    id: string,
    status: 'completed' | 'partial' | 'failed',
    summary: string,
    steps: { description: string; status: string }[],
  ) => Promise<void>;
  unfinished: (limit: number) => Promise<OpenTask[]>;
  /** False when nothing matched — closing nothing is not closing something. */
  close: (id: string) => Promise<boolean>;
}

export const ListTasksInput = z.object({
  limit: z.number().int().min(1).max(20).default(5),
});

export const CloseTaskInput = z.object({
  id: z.string().min(1).max(80).describe('Id of the task to close, as returned by list_tasks'),
});

export function createTaskTools(store: TaskStore | null) {
  const unavailable = () =>
    errAsync(appError('tasks_unavailable', 'Task memory is not configured.'));

  const listTasksTool = defineTool({
    metadata: {
      name: 'list_tasks',
      description:
        'List multi-step tasks that were started and never finished. Use when the user asks what is outstanding, or refers to something they asked for earlier.',
      category: 'knowledge',
      risk: 'read',
      connector: 'postgres',
      timeoutMs: 10_000,
    },
    input: ListTasksInput,
    execute: (args) =>
      store
        ? fromPromise(store.unfinished(args.limit), 'list_tasks_failed').map((tasks) => ({
            tasks,
            count: tasks.length,
          }))
        : unavailable(),
    speak: (result) => {
      const r = result as { count?: unknown };
      // Nothing outstanding is a complete answer. A list is not — the model
      // should say what they were, not read ids aloud.
      return r.count === 0 ? 'Nothing is outstanding.' : null;
    },
  });

  const closeTaskTool = defineTool({
    metadata: {
      name: 'close_task',
      description:
        'Mark an unfinished task as closed, when the user says to drop it or has dealt with it themselves.',
      category: 'knowledge',
      // Nothing is deleted — the row stays for the audit trail — and the user
      // asked for it. Closing the wrong one costs a sentence to undo.
      risk: 'reversible',
      connector: 'postgres',
      timeoutMs: 10_000,
    },
    input: CloseTaskInput,
    execute: (args) =>
      store
        ? fromPromise(store.close(args.id), 'close_task_failed').map((closed) => ({
            closed,
            id: args.id,
          }))
        : unavailable(),
    speak: (result) => {
      const r = result as { closed?: unknown };
      // Says so when there was nothing to close, rather than claiming a
      // tidiness that did not happen.
      return r.closed === true ? "Closed it — I won't bring it up again." : null;
    },
  });

  // A tuple rather than a plain array: callers destructure these, and a
  // widened element type would give each tool the other's argument shape.
  return [listTasksTool, closeTaskTool] as const;
}
