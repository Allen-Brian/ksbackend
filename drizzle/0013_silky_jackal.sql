ALTER TABLE "appointment" ADD COLUMN "schedule_timezone" text DEFAULT 'Africa/Douala' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;