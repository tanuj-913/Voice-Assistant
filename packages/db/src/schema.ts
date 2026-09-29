import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Embedding width for `nomic-embed-text`, the local embedding model.
 * Changing models means changing this and regenerating a migration —
 * pgvector fixes dimensionality at the column level.
 */
export const EMBEDDING_DIMENSIONS = 768;

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool']);
export const toolCallStatusEnum = pgEnum('tool_call_status', [
  'ok',
  'error',
  'denied',
  'invalid_arguments',
]);

/**
 * Where a multi-step task got to.
 *
 * `partial` is the one that matters: it is what a task looks like when three
 * steps of five worked. Without somewhere to record it, that state died with
 * the process and the user had to remember what was left.
 */
export const taskStatusEnum = pgEnum('task_status', [
  'running',
  'completed',
  'partial',
  'failed',
  /** The user said to drop it. Kept rather than deleted, for the audit trail. */
  'closed',
]);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    language: text('language'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

/**
 * Audit log of every tool the model tried to run — including calls rejected by
 * validation and calls the user declined.
 *
 * Kept deliberately complete: when an assistant can place calls and send
 * messages, "what did it actually do, and did I approve it?" needs an answer
 * that does not depend on the model's own account of itself.
 */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    turnId: uuid('turn_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Raw arguments exactly as the model emitted them, before validation. */
    rawArguments: jsonb('raw_arguments').notNull(),
    status: toolCallStatusEnum('status').notNull(),
    result: jsonb('result'),
    error: jsonb('error'),
    /** Null when the tool's risk tier required no confirmation. */
    userApproved: boolean('user_approved'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tool_calls_turn_idx').on(t.turnId),
    index('tool_calls_created_idx').on(t.createdAt.desc()),
  ],
);

/** Long-term facts, searchable by meaning rather than keyword. */
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fact: text('fact').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    recallCount: integer('recall_count').notNull().default(0),
    lastRecalledAt: timestamp('last_recalled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // HNSW over cosine distance: the right index for "what do I know that is
    // related to this?" against a corpus that grows slowly and is read often.
    index('memories_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('memories_created_idx').on(t.createdAt.desc()),
    // Keyword fallback for when the embedding model is unavailable.
    index('memories_fact_search_idx').using('gin', sql`to_tsvector('english', ${t.fact})`),
  ],
);

/**
 * Multi-step tasks and what became of them.
 *
 * Deliberately not tied to a conversation. "Did you finish moving those
 * photos?" is a question people ask the next morning, after a restart, in what
 * is technically a different conversation — and a task that cannot outlive the
 * process it started in is not something anyone can continue.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The request in the user's own words, which is how they will refer to it. */
    goal: text('goal').notNull(),
    status: taskStatusEnum('status').notNull().default('running'),
    /** What happened, in the plan's own descriptions rather than tool names. */
    summary: text('summary'),
    steps: jsonb('steps').$type<{ description: string; status: string }[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tasks_updated_idx').on(t.updatedAt.desc())],
);

/** Key-value settings, validated against UserSettings on read. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type NewToolCallRow = typeof toolCalls.$inferInsert;
export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
