import { SqlError } from "@effect/sql";
import { Clock, Config, Context, Effect, Layer } from "effect";
import { Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { CurrentUser } from "@/infra/auth";
import { requireAnyRole } from "@/infra/authz";
import { BookingPolicyRepo } from "./booking-policy.repo";

type Policy = {
  readonly cancellationCutoffHours: number;
  readonly overrideCancellationCutoffHours: number | null;
};
export class BookingPolicyService extends Context.Tag("BookingPolicyService")<
  BookingPolicyService,
  {
    readonly getPublic: (
      id: string,
    ) => Effect.Effect<{ readonly cancellationCutoffHours: number }, NotFound | SqlError.SqlError>;
    readonly getMine: () => Effect.Effect<
      Policy,
      Forbidden | NotFound | SqlError.SqlError,
      CurrentUser
    >;
    readonly updateMine: (
      cutoff: number | null,
    ) => Effect.Effect<
      Policy,
      Forbidden | NotFound | ValidationFailed | SqlError.SqlError,
      CurrentUser
    >;
  }
>() {}
export const BookingPolicyServiceLive = Layer.effect(
  BookingPolicyService,
  Effect.gen(function* () {
    const repo = yield* BookingPolicyRepo;
    const defaultCutoff = yield* Config.integer("APPOINTMENT_CANCEL_CUTOFF_HOURS").pipe(
      Config.withDefault(0),
    );
    const policy = (cutoff: number | null): Policy => ({
      cancellationCutoffHours: cutoff ?? defaultCutoff,
      overrideCancellationCutoffHours: cutoff,
    });
    return {
      getPublic: (id) =>
        Effect.gen(function* () {
          const found = yield* repo.findPublic(id);
          if (found === undefined)
            return yield* Effect.fail(new NotFound({ resource: "Practitioner", id }));
          return { cancellationCutoffHours: found.cutoff ?? defaultCutoff };
        }),
      getMine: () =>
        Effect.gen(function* () {
          yield* requireAnyRole("doctor", "nurse");
          const user = yield* CurrentUser;
          const found = yield* repo.findForUser(user.id);
          if (found === undefined)
            return yield* Effect.fail(new NotFound({ resource: "Practitioner profile" }));
          return policy(found.cutoff);
        }),
      updateMine: (cutoff) =>
        Effect.gen(function* () {
          yield* requireAnyRole("doctor", "nurse");
          if (cutoff !== null && (!Number.isInteger(cutoff) || cutoff < 0 || cutoff > 168)) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [
                  {
                    path: "cancellationCutoffHours",
                    message: "Use an integer between 0 and 168 hours, or null to use the default.",
                  },
                ],
              }),
            );
          }
          const user = yield* CurrentUser;
          const now = new Date(yield* Clock.currentTimeMillis);
          const found = yield* repo.updateForUser(user.id, cutoff, now);
          if (found === undefined)
            return yield* Effect.fail(new NotFound({ resource: "Practitioner profile" }));
          return policy(found.cutoff);
        }),
    };
  }),
);
