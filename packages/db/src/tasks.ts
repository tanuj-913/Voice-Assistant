import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AssistantDb } from './client.js';
import { tasks } from './schema.js';

/** Statuses that mean there is still something the user might want finished. */
const UNFINISHED = ['running', 'partial', 'failed'] as const;

export async function startTask(db: AssistantDb, goal: string) {
  const [row] = await db.insert(tasks).values({ goal }).returning({ id: tasks.id });
  if (!row) throw new Error('the task was not recorded');
  return row.id;
}

export async function finishTask(
  db: AssistantDb,
  id: string,
  status: 'completed' | 'partial' | 'failed',
  summary: string,
  steps: { description: string; status: string }[],
) {
  await db
    .update(tasks)
    .set({ status, summary, steps, updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

/**
 * Tasks that never finished, most recent first.
 *
 * A `running` row with no end is included on purpose: it means the process
 * died mid-task, which is exactly the case the user needs telling about.
 */
export async function listUnfinishedTasks(db: AssistantDb, limit = 5) {
  return db
    .select({
      id: tasks.id,
      goal: tasks.goal,
      status: tasks.status,
      summary: tasks.summary,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(inArray(tasks.status, [...UNFINISHED]))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit);
}

/** False when nothing matched: closing nothing is not closing something. */
export async function closeTask(db: AssistantDb, id: string): Promise<boolean> {
  const closed = await db
    .update(tasks)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(and(eq(tasks.id, id), inArray(tasks.status, [...UNFINISHED])))
    .returning({ id: tasks.id });
  return closed.length > 0;
}
