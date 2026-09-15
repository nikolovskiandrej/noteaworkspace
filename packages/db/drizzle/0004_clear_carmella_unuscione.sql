CREATE SEQUENCE IF NOT EXISTS "notea_agent_uid_seq" AS integer START WITH 20001 INCREMENT BY 1 MINVALUE 20001 MAXVALUE 29999 NO CYCLE;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "auth_mode" text DEFAULT 'api_key' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "agent_uid" integer DEFAULT nextval('notea_agent_uid_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_agent_uid_unique" UNIQUE("agent_uid");
