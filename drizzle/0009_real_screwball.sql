CREATE TYPE "public"."appointment_status" AS ENUM('held', 'confirmed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practitioner_profile_id" uuid NOT NULL,
	"booker_user_id" text NOT NULL,
	"dependent_id" uuid,
	"subject_user_id" text,
	"offering_id" uuid NOT NULL,
	"consultation_type" "consultation_type" NOT NULL,
	"location_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"slot_key" text NOT NULL,
	"preferred_language" text NOT NULL,
	"status" "appointment_status" DEFAULT 'held' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_time_order" CHECK ("appointment"."ends_at" > "appointment"."starts_at"),
	CONSTRAINT "appointment_single_subject" CHECK ("appointment"."dependent_id" is null or "appointment"."subject_user_id" is null),
	CONSTRAINT "appointment_hold_has_expiry" CHECK ("appointment"."status" <> 'held' or "appointment"."hold_expires_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_practitioner_profile_id_practitioner_profile_id_fk" FOREIGN KEY ("practitioner_profile_id") REFERENCES "public"."practitioner_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_booker_user_id_user_id_fk" FOREIGN KEY ("booker_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_dependent_id_dependent_id_fk" FOREIGN KEY ("dependent_id") REFERENCES "public"."dependent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_offering_id_consultation_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."consultation_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_location_id_practice_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."practice_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_practitioner_live_idx" ON "appointment" USING btree ("practitioner_profile_id","starts_at") WHERE "appointment"."status" in ('held', 'confirmed');--> statement-breakpoint
CREATE INDEX "appointment_booker_idx" ON "appointment" USING btree ("booker_user_id","id");--> statement-breakpoint
CREATE INDEX "appointment_subject_user_idx" ON "appointment" USING btree ("subject_user_id","id");