ALTER TABLE "workspaces" ADD COLUMN "integration_locked_by" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "integration_locked_until" timestamp with time zone;