import type { EmergencyContact } from "@/domain/patient/patient";

export type Sex = "male" | "female";
export type Relationship = "child" | "parent" | "spouse" | "sibling" | "other";

/**
 * A dependent person (no login) as seen BY a caregiver — `relationship` is that
 * caregiver's relationship to them (it lives on the caregiver_link, not the
 * person, since a dependent may have several caregivers). `emergencyContact` is
 * someone local to the dependent, since the caregiver is typically abroad.
 */
export type Dependent = {
  readonly id: string;
  readonly surname: string;
  readonly givenNames: string;
  readonly dateOfBirth: string;
  readonly sex: Sex;
  readonly relationship: Relationship;
  readonly phone: string | null;
  readonly location: string | null;
  readonly emergencyContact: EmergencyContact | null;
};

export type DependentInput = {
  readonly surname: string;
  readonly givenNames: string;
  readonly dateOfBirth: string;
  readonly sex: Sex;
  readonly relationship: Relationship;
  readonly phone?: string | undefined;
  readonly location?: string | undefined;
  readonly emergencyContact?: EmergencyContact | undefined;
};

export type DependentPatch = {
  readonly surname?: string | undefined;
  readonly givenNames?: string | undefined;
  readonly dateOfBirth?: string | undefined;
  readonly sex?: Sex | undefined;
  readonly relationship?: Relationship | undefined;
  readonly phone?: string | undefined;
  readonly location?: string | undefined;
  /** An object replaces, `null` clears, `undefined` leaves it as-is. */
  readonly emergencyContact?: EmergencyContact | null | undefined;
};
