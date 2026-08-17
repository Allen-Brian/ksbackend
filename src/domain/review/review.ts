/** A patient's rating + optional comment for a practitioner. */
export type Review = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly reviewerUserId: string;
  readonly reviewerName: string | null;
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** What a patient submits (create or update their single active review). */
export type ReviewInput = {
  readonly rating: number;
  readonly comment?: string | undefined;
};
