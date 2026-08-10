import type { ManagedRuntime } from "effect";
import type { EvlogVariables } from "evlog/hono";
import type { RequestIdVariables } from "hono/request-id";
import type { AuthUser } from "@/infra/auth";
import type { Health } from "@/infra/health";
import type { Locale } from "@/infra/i18n";
import type { RateLimiter } from "@/infra/rate-limiter";
import type { AdminService } from "@/modules/admin/admin.service";
import type { DependentService } from "@/modules/dependent/dependent.service";
import type { InvitationService } from "@/modules/invitation/invitation.service";
import type { NotificationService } from "@/modules/notification/notification.service";
import type { PatientService } from "@/modules/patient/patient.service";
import type { PractitionerService } from "@/modules/practitioner/practitioner.service";
import type { ProfileService } from "@/modules/profile/profile.service";

/** Hono context variables available on every request. */
export type AppEnv = {
  Variables: RequestIdVariables &
    EvlogVariables & {
      // Set by the session middleware; null when the request is unauthenticated.
      user: AuthUser | null;
      // Set by the locale middleware from Accept-Language.
      locale: Locale;
    };
};

/** The services the HTTP layer runs through the runtime. */
export type AppServices =
  | Health
  | RateLimiter
  | ProfileService
  | NotificationService
  | PatientService
  | PractitionerService
  | AdminService
  | DependentService
  | InvitationService;

/**
 * The application runtime as seen by the HTTP layer. Any runtime that provides
 * `AppServices` satisfies this. `E` is `unknown` because every failure is caught
 * and mapped at the boundary. (Auth is passed to createApp separately — it lives
 * at the edge, not in the runtime.)
 */
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, unknown>;
