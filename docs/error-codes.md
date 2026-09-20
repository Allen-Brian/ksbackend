# Error codes

Every error response uses the standard envelope:

```jsonc
{ "error": { "code": "…", "message": "…", "details": [] }, "requestId": "…" }
```

`code` is stable and machine-readable — the frontend switches on it. It is decoupled from HTTP
status and from the human `message`. **Renaming a code is a breaking API change.** The mapping
from domain tagged error → `(status, code)` lives in one place: `src/http/error-mapper.ts`.

| Code                         | HTTP | Domain error                     | Meaning                                                                                       |
| ---------------------------- | ---- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `NOT_FOUND`                  | 404  | `NotFound`                       | Resource does not exist                                                                       |
| `UNAUTHORIZED`               | 401  | `Unauthorized`                   | Authentication required / invalid                                                             |
| `FORBIDDEN`                  | 403  | `Forbidden`                      | Authenticated but not allowed                                                                 |
| `CONFLICT`                   | 409  | `Conflict`                       | Duplicate / state conflict (incl. client-supplied id)                                         |
| `VERIFICATION_STATE_INVALID` | 409  | `VerificationStateInvalid`       | Verification transition not allowed from the profile's current status                         |
| `VALIDATION_FAILED`          | 422  | `ValidationFailed`               | Request failed schema/domain validation (`details` carries field issues)                      |
| `SLOT_OVERLAP`               | 409  | `SlotOverlap`                    | A published availability slot overlaps an existing one                                        |
| `SLOT_UNAVAILABLE`           | 409  | `SlotUnavailable`                | The selected slot is taken, held by someone else, or no longer on the schedule                |
| `HOLD_EXPIRED`               | 409  | `HoldExpired`                    | The checkout hold lapsed before `confirm`; book again                                         |
| `NOT_A_CAREGIVER`            | 403  | `NotACaregiver`                  | No active caregiver link from the booker to the requested care subject                        |
| `APPOINTMENT_STATE_INVALID`  | 409  | `AppointmentStateInvalid`        | Transition not allowed from the appointment's current status (`current`)                      |
| `CANCELLATION_WINDOW_CLOSED` | 409  | `CancellationWindowClosed`       | Too close to the start to cancel (`APPOINTMENT_CANCEL_CUTOFF_HOURS`)                          |
| `BOOKING_LIMIT_REACHED`      | 409  | `BookingLimitReached`            | The booker already has `limit` live upcoming appointments (`APPOINTMENT_MAX_LIVE_PER_BOOKER`) |
| `PAYLOAD_TOO_LARGE`          | 413  | _(bodyLimit middleware)_         | Request body exceeds the 1 MB limit                                                           |
| `RATE_LIMITED`               | 429  | _(rate-limit middleware)_        | Too many requests (`Retry-After` header carries the wait in seconds)                          |
| `INTERNAL`                   | 500  | _(any unhandled failure/defect)_ | Unexpected server error (cause logged with `requestId`)                                       |

Add a new code by adding a tagged error in `src/domain/shared/errors.ts` (or a feature's
`domain/<feature>/errors.ts`) and a case in `src/http/error-mapper.ts`, then document it here.
