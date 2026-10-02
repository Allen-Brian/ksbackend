CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"recipient_user_id" text NOT NULL,
	"channel" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"frozen_payload" jsonb,
	"due_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"acceptance_unknown" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"provider_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_dedupe_key" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_delivery_due_idx" ON "notification_delivery" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "notification_delivery_appointment_idx" ON "notification_delivery" USING btree ("appointment_id","revision");