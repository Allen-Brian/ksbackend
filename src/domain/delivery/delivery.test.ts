import { describe, expect, it } from "vitest";
import { reminderDeadlines, retryDelayMillis } from "./delivery";

const date = (value: string) => new Date(value);

describe("appointment reminder scheduling", () => {
  it("schedules UTC deadlines across the end of the month", () => {
    expect(reminderDeadlines(date("2026-11-01T00:30:00Z"), date("2026-10-30T00:00:00Z"))).toEqual([
      {
        offset: 24,
        dueAt: date("2026-10-31T00:30:00Z"),
        expiresAt: date("2026-10-31T00:45:00Z"),
      },
      {
        offset: 1,
        dueAt: date("2026-10-31T23:30:00Z"),
        expiresAt: date("2026-10-31T23:45:00Z"),
      },
    ]);
  });
  it("does not catch up a 24-hour reminder for a near-term booking", () => {
    expect(
      reminderDeadlines(date("2026-10-02T12:00:00Z"), date("2026-10-02T10:00:00Z")).map(
        (row) => row.offset,
      ),
    ).toEqual([1]);
    expect(reminderDeadlines(date("2026-10-02T12:00:00Z"), date("2026-10-02T11:00:00Z"))).toEqual(
      [],
    );
  });
  it("never allows reminder grace to extend past the appointment start", () => {
    expect(
      reminderDeadlines(date("2026-10-02T12:00:00Z"), date("2026-10-02T10:00:00Z"), 120)[0]
        ?.expiresAt,
    ).toEqual(date("2026-10-02T12:00:00Z"));
  });
});

describe("delivery retry pacing", () => {
  it("backs off after consecutive failures and caps an extended outage", () => {
    expect([1, 2, 3, 20].map(retryDelayMillis)).toEqual([60_000, 120_000, 240_000, 3_600_000]);
  });
});
