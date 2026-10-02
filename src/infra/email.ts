import { Config, Context, Data, Effect, Layer, Redacted } from "effect";
import { Resend } from "resend";

export type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly idempotencyKey?: string | undefined;
};

export class EmailError extends Data.TaggedError("EmailError")<{
  readonly reason: string;
  readonly retryable?: boolean;
  readonly ambiguous?: boolean;
  readonly message?: string;
}> {}

/** Effect email seam for OUR emails (verification-decision notifications, etc.). */
export interface EmailSenderService {
  readonly send: (message: EmailMessage) => Effect.Effect<void, EmailError>;
  readonly sendReceipt?: (
    message: EmailMessage,
  ) => Effect.Effect<{ readonly providerId: string | undefined }, EmailError>;
}
export class EmailSender extends Context.Tag("EmailSender")<EmailSender, EmailSenderService>() {}

/**
 * Plain (Promise-based) client for better-auth's emailOTP callback, which runs
 * OUTSIDE Effect. Backed by the same Resend account as the Effect `EmailSender`.
 */
export type EmailClient = {
  readonly send: (message: EmailMessage) => Promise<void>;
  readonly sendReceipt?: (
    message: EmailMessage,
  ) => Promise<{ readonly providerId: string | undefined }>;
};

/**
 * `baseUrl` points the Resend SDK somewhere other than the real API — locally at
 * resend-local (http://localhost:8005) so email is captured in its dashboard
 * instead of sent. When omitted the SDK also honors a `RESEND_BASE_URL` env var,
 * so `RESEND_BASE_URL=… bun run dev` works without setting it in config.
 */
export const makeResendClient = (apiKey: string, from: string, baseUrl?: string): EmailClient => {
  // RESEND_API_KEY is only required in prod (.env.schema). Elsewhere an unset key
  // must still let the server boot — the SDK constructor throws on "", so give it
  // a sentinel and fail at send time with a message that names the real problem.
  const unset = apiKey === "";
  const resend = new Resend(
    unset ? "re_unset" : apiKey,
    baseUrl !== undefined ? { baseUrl } : undefined,
  );
  const sendReceipt = async ({ to, subject, html, idempotencyKey }: EmailMessage) => {
    if (unset)
      throw new EmailError({
        reason: "RESEND_API_KEY is not set — email cannot be sent",
        message: "RESEND_API_KEY is not set — email cannot be sent",
        retryable: false,
        ambiguous: false,
      });
    const { error, data } = await resend.emails.send(
      { from, to, subject, html },
      idempotencyKey === undefined ? undefined : { idempotencyKey },
    );
    if (error)
      throw new EmailError({
        reason: `Email provider error: ${error.name}`,
        retryable:
          error.name === "rate_limit_exceeded" ||
          error.name === "application_error" ||
          error.name === "internal_server_error",
        ambiguous: error.name === "application_error" || error.name === "internal_server_error",
      });
    return { providerId: data?.id };
  };
  return { send: (message) => sendReceipt(message).then(() => {}), sendReceipt };
};

/** Dev/console client — prints instead of sending (no Resend account needed locally). */
export const makeConsoleClient = (): EmailClient => ({
  send: ({ to, subject, html }) =>
    Promise.resolve(console.log(`[email:dev] to=${to} subject="${subject}"\n${html}`)),
});

export const EmailSenderResendLive = Layer.effect(
  EmailSender,
  Effect.gen(function* () {
    const apiKey = Redacted.value(yield* Config.redacted("RESEND_API_KEY"));
    const from = yield* Config.string("EMAIL_FROM");
    const baseUrl = yield* Config.string("RESEND_BASE_URL").pipe(Config.withDefault(""));
    const client = makeResendClient(apiKey, from, baseUrl === "" ? undefined : baseUrl);
    return {
      sendReceipt: (message: EmailMessage) =>
        Effect.tryPromise({
          try: () =>
            client.sendReceipt === undefined
              ? client.send(message).then(() => ({ providerId: undefined }))
              : client.sendReceipt(message),
          catch: (cause) =>
            cause instanceof EmailError
              ? cause
              : new EmailError({
                  reason: "Email provider request failed",
                  retryable: true,
                  ambiguous: true,
                }),
        }),
      send: (message) =>
        Effect.tryPromise({
          try: () => client.send(message),
          catch: (cause) =>
            cause instanceof EmailError
              ? cause
              : new EmailError({
                  reason: "Email provider request failed",
                  retryable: true,
                  ambiguous: true,
                }),
        }),
    };
  }),
);

/** Console-backed Effect sender for local/dev/test. */
export const EmailSenderConsoleLive = Layer.sync(EmailSender, () => {
  const client = makeConsoleClient();
  return {
    send: (message) =>
      Effect.tryPromise({
        try: () => client.send(message),
        catch: (cause) =>
          cause instanceof EmailError
            ? cause
            : new EmailError({
                reason: "Email provider request failed",
                retryable: true,
                ambiguous: true,
              }),
      }),
  };
});
