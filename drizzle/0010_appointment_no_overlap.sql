-- The no-double-booking invariant (SCRUM-18 AC 3). A practitioner can never be in
-- two live appointments (held or confirmed) whose [starts_at, ends_at) ranges
-- overlap — enforced by Postgres, so concurrent bookings race to insert and the
-- loser fails with 23P01 (mapped to 409 SLOT_UNAVAILABLE). An overlap check, not
-- a unique start time, so overlapping slots from different schedule sources can't
-- both be booked. Hand-authored: drizzle-kit manages neither extensions nor
-- EXCLUDE constraints, and this stays out of the schema snapshot (drift check).
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist (
    "practitioner_profile_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" IN ('held', 'confirmed'));
