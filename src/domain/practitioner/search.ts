import type { ConsultationType } from "./practitioner";

/**
 * Allow-list of sort keys for practitioner discovery. A `const` tuple so the
 * contract can feed it straight to `z.enum(...)` — validation there yields this
 * exact union with no cast, and the repo maps each field to an ORDER BY clause.
 */
export const PRACTITIONER_SORT_FIELDS = [
  "availability",
  "distance",
  "rating",
  "fee",
  "experience",
  "name",
  "recency",
] as const;
export type PractitionerSortField = (typeof PRACTITIONER_SORT_FIELDS)[number];

export type SortDirection = "asc" | "desc";
export type PractitionerSort = {
  readonly field: PractitionerSortField;
  readonly direction: SortDirection;
};

/** The natural direction applied when the client omits `order`. */
export const PRACTITIONER_SORT_DEFAULT_DIRECTION = {
  availability: "asc",
  distance: "asc",
  rating: "desc",
  fee: "asc",
  experience: "desc",
  name: "asc",
  recency: "desc",
} satisfies Record<PractitionerSortField, SortDirection>;

/** The point distance is measured from — the patient's location, not the caller's. */
export type GeoPoint = { readonly latitude: number; readonly longitude: number };

/** Kilometres per degree of latitude — the bounding box that pre-filters a radius search. */
const KM_PER_DEGREE = 111.045;

/**
 * A lat/lng box that fully contains the circle of `radiusKm` around `origin`.
 * Used as a cheap, index-backed pre-filter before the exact haversine test.
 * `longitude` is null when the box would wrap the antimeridian (or the poles
 * make it meaningless) — the caller then relies on the distance test alone.
 */
export const boundingBox = (origin: GeoPoint, radiusKm: number) => {
  const latitudeDelta = radiusKm / KM_PER_DEGREE;
  const cosLatitude = Math.cos((origin.latitude * Math.PI) / 180);
  const longitudeDelta =
    Math.abs(cosLatitude) < 0.01
      ? Number.POSITIVE_INFINITY
      : radiusKm / (KM_PER_DEGREE * cosLatitude);
  const min = origin.longitude - longitudeDelta;
  const max = origin.longitude + longitudeDelta;
  return {
    latitude: {
      min: Math.max(-90, origin.latitude - latitudeDelta),
      max: Math.min(90, origin.latitude + latitudeDelta),
    },
    longitude: min < -180 || max > 180 ? null : { min, max },
  };
};

/** Every filter is optional and independent — so they combine and clear freely. */
export type PractitionerSearchCriteria = {
  readonly specialty?: string | undefined;
  readonly city?: string | undefined;
  readonly language?: string | undefined;
  readonly consultationTypes?: ReadonlyArray<ConsultationType> | undefined;
  readonly feeMin?: number | undefined;
  readonly feeMax?: number | undefined;
  readonly professionId?: string | undefined;
  readonly q?: string | undefined;
  readonly origin?: GeoPoint | undefined;
  /** With `origin`, keeps only practitioners within this many km of it. */
  readonly radiusKm?: number | undefined;
};

/** The lightweight card projection the repo returns (photo is presigned by the service). */
export type PractitionerCardRow = {
  readonly id: string;
  readonly professionId: string;
  readonly professionNameEn: string;
  readonly professionNameFr: string;
  readonly professionPrefixHint: string | null;
  readonly prefix: string | null;
  readonly surname: string;
  readonly givenNames: string;
  readonly specialty: string | null;
  readonly location: string | null;
  readonly consultationTypes: ReadonlyArray<ConsultationType> | null;
  readonly languagesSpoken: ReadonlyArray<string> | null;
  readonly consultationFeeXaf: number | null;
  readonly ratingAverage: number;
  readonly ratingCount: number;
  readonly nextAvailableAt: Date | null;
  readonly distanceKm: number | null;
  readonly profilePhotoFileKey: string | null;
};
