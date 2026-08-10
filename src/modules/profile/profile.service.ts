import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Profile, ProfilePatch } from "@/domain/profile/profile";
import { NotFound } from "@/domain/shared/errors";
import { ProfileRepo } from "./profile.repo";

export interface ProfileServiceService {
  readonly get: (userId: string) => Effect.Effect<Profile, NotFound | SqlError.SqlError>;
  readonly update: (
    userId: string,
    patch: ProfilePatch,
  ) => Effect.Effect<Profile, NotFound | SqlError.SqlError>;
}

export class ProfileService extends Context.Tag("ProfileService")<
  ProfileService,
  ProfileServiceService
>() {}

export const ProfileServiceLive = Layer.effect(
  ProfileService,
  Effect.gen(function* () {
    const repo = yield* ProfileRepo;

    const orNotFound = (found: Profile | undefined) =>
      found === undefined
        ? Effect.fail(new NotFound({ resource: "Profile" }))
        : Effect.succeed(found);

    return {
      get: (userId) => repo.findByUserId(userId).pipe(Effect.flatMap(orNotFound)),

      update: (userId, patch) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          const updated = yield* repo.patch(userId, patch, now);
          return yield* orNotFound(updated);
        }),
    };
  }),
);
