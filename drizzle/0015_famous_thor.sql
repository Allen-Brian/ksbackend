CREATE TABLE "appointment_change" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"previous_starts_at" timestamp with time zone NOT NULL,
	"previous_ends_at" timestamp with time zone NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_change" ADD CONSTRAINT "appointment_change_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_change" ADD CONSTRAINT "appointment_change_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_change_appointment_idx" ON "appointment_change" USING btree ("appointment_id","id");