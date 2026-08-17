export const SLOT_STATUSES = ["open", "booked", "cancelled"] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

/** A bookable time slot a practitioner has published. */
export type AvailabilitySlot = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: SlotStatus;
};

/** What a practitioner submits to publish a slot. */
export type SlotInput = {
  readonly startsAt: Date;
  readonly endsAt: Date;
};
