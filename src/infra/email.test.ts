import { describe, expect, it } from "vitest";
import { makeResendClient } from "./email";

describe("makeResendClient", () => {
  // Non-prod stages may run without RESEND_API_KEY (.env.schema: required only
  // forEnv(prod)). Constructing the client must not throw — the Resend SDK does
  // on "" — and a send must fail naming the missing key, not a bogus auth error.
  it("boots with an unset key and fails at send time with a pointed message", async () => {
    const client = makeResendClient("", "KanaSanté <no-reply@kanasante.com>");
    await expect(
      client.send({ to: "someone@example.com", subject: "hi", html: "<p>hi</p>" }),
    ).rejects.toThrow(/RESEND_API_KEY is not set/);
  });
});
