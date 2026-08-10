import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Patient } from "@/domain/patient/patient";
import { NotFound } from "@/domain/shared/errors";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import { CompletePatientProfileBody, PatientProfileResponse } from "./patient.contract";
import { PatientService } from "./patient.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toResponse = (patient: Patient) => ({
  id: patient.id,
  userId: patient.userId,
  surname: patient.surname,
  givenNames: patient.givenNames,
  phone: patient.phone,
  dateOfBirth: patient.dateOfBirth,
  sex: patient.sex,
  emergencyContact: patient.emergencyContact,
});

const completeProfile = createRoute({
  method: "post",
  path: "/v1/patients/me/profile",
  tags: ["Patients"],
  summary: "Create or update the current patient's profile",
  request: { body: jsonBody(CompletePatientProfileBody) },
  responses: {
    200: { ...jsonBody(PatientProfileResponse), description: "Profile saved" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed" },
  },
});

const getProfile = createRoute({
  method: "get",
  path: "/v1/patients/me/profile",
  tags: ["Patients"],
  summary: "Get the current patient's profile",
  responses: {
    200: { ...jsonBody(PatientProfileResponse), description: "The profile" },
    401: { ...jsonBody(ErrorResponse), description: "Not authenticated" },
    404: { ...jsonBody(ErrorResponse), description: "No profile yet" },
  },
});

export const registerPatientRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(completeProfile, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PatientService;
        const body = c.req.valid("json");
        const saved = yield* service.completeProfile(user.id, {
          surname: body.surname,
          givenNames: body.givenNames,
          phone: body.phone,
          dateOfBirth: body.dateOfBirth,
          sex: body.sex,
          consentVersion: body.consentVersion,
          emergencyContact: body.emergencyContact,
        });
        return c.json(toResponse(saved), 200);
      }),
    ),
  );

  app.openapi(getProfile, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PatientService;
        const found = yield* service.getProfile(user.id);
        if (found === undefined) {
          return yield* Effect.fail(new NotFound({ resource: "Patient profile" }));
        }
        return c.json(toResponse(found), 200);
      }),
    ),
  );
};
