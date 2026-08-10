import type { Relationship } from "@/domain/dependent/dependent";

export type LinkStatus = "pending" | "active" | "revoked" | "declined";

/** A caregiver↔account-holder link, from either party's perspective. */
export type CaregiverLinkView = {
  readonly id: string;
  readonly caregiverUserId: string;
  readonly subjectUserId: string | null;
  readonly inviteIdentifier: string | null;
  readonly relationship: Relationship;
  readonly status: LinkStatus;
  /** "sent" if the current user is the caregiver, "received" if the invitee. */
  readonly direction: "sent" | "received";
};

/** Minimal, privacy-safe card returned by exact-match user search. */
export type UserCard = {
  readonly userId: string;
  readonly displayName: string;
};
