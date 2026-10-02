ALTER TABLE "appointment" ADD COLUMN "cancellation_cutoff_hours" integer;--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD COLUMN "cancellation_cutoff_hours" integer;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_cancellation_cutoff_nonnegative" CHECK ("appointment"."cancellation_cutoff_hours" >= 0);--> statement-breakpoint
ALTER TABLE "practitioner_profile" ADD CONSTRAINT "practitioner_cancellation_cutoff_range" CHECK ("practitioner_profile"."cancellation_cutoff_hours" between 0 and 168);