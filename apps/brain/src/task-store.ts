import { childLogger } from '@assistant/core';
import { closeTask, finishTask, listUnfinishedTasks, startTask, type AssistantDb } from '@assistant/db';
import type { OpenTask, TaskStore } from '@assistant/tools';

const log = childLogger('tasks');

/**
 * Postgres-backed task memory.
 *
 * Kept behind the same seam as the memory store: the brain owns the database,
 * the tool layer owns the promises made to the user. Failures here degrade the
 * feature rather than the turn — a task that could not be recorded is worse
 * than one that was, and much better than a plan that refuses to run because
 * its bookkeeping failed.
 */
export function createDbTaskStore(db: AssistantDb): TaskStore {
  return {
    start: (goal) => startTask(db, goal),
    finish: (id, status, summary, steps) => finishTask(db, id, status, summary, steps),
    unfinished: async (limit): Promise<OpenTask[]> => {
      const rows = await listUnfinishedTasks(db, limit);
      return rows.map((row) => ({
        id: row.id,
        goal: row.goal,
        status: row.status,
        summary: row.summary,
      }));
    },
    close: (id) => closeTask(db, id),
  };
}

/** Records a plan run without ever letting the bookkeeping take the turn down. */
export function bestEffort<T>(work: Promise<T>, what: string): Promise<T | null> {
  return work.catch((error: unknown) => {
    log.warn({ error, what }, 'could not record task state');
    return null;
  });
}
