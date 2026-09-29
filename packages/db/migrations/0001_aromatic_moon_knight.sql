CREATE TYPE "public"."task_status" AS ENUM('running', 'completed', 'partial', 'failed', 'closed');--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal" text NOT NULL,
	"status" "task_status" DEFAULT 'running' NOT NULL,
	"summary" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tasks_updated_idx" ON "tasks" USING btree ("updated_at" DESC NULLS LAST);