import { describe, expect, it } from "vitest";
import { renderEmail } from "./email-render";

describe("appointment email", () => {
  it("renders recipient language and schedule timezone with the previous time", () => {
    const scenario = {
      kind: "appointment",
      event: "rescheduled",
      startsAt: "2026-10-02T12:00:00Z",
      timezone: "Africa/Douala",
      previousStartsAt: "2026-10-01T10:00:00Z",
    } satisfies Parameters<typeof renderEmail>[0];
    const french = renderEmail(scenario, "fr");
    expect(french.subject).toBe("Rendez-vous reporté");
    expect(french.text).toContain("13:00");
    expect(french.text).toContain("11:00");
    expect(french.text).toContain("Ancien horaire");
    expect(french.html).toContain("Africa/Douala");
    const english = renderEmail(scenario, "en");
    expect(english.subject).toBe("Appointment rescheduled");
    expect(english.text).toContain("Previous time");
  });
});
