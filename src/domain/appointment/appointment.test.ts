import { describe, expect, it } from "vitest";
import { effectiveStatus, isLive, withinCancellationWindow } from "./appointment";

const at = (iso: string): Date => new Date(iso);

describe("effectiveStatus / isLive", () => {
  it("a held appointment is expired once its hold lapses, and is not live", () => {
    const held = { status: "held", holdExpiresAt: at("2026-09-20T10:10:00Z") } as const;
    expect(effectiveStatus(held, at("2026-09-20T10:09:59Z"))).toBe("held");
    expect(effectiveStatus(held, at("2026-09-20T10:10:00Z"))).toBe("expired");
    expect(isLive(held, at("2026-09-20T10:09:59Z"))).toBe(true);
    expect(isLive(held, at("2026-09-20T10:10:00Z"))).toBe(false);
  });

  it("confirmed stays live regardless of any leftover expiry; cancelled never is", () => {
    const stale = at("2000-01-01T00:00:00Z");
    expect(isLive({ status: "confirmed", holdExpiresAt: stale }, at("2026-01-01T00:00:00Z"))).toBe(
      true,
    );
    expect(isLive({ status: "cancelled", holdExpiresAt: null }, at("2026-01-01T00:00:00Z"))).toBe(
      false,
    );
  });
});

describe("withinCancellationWindow", () => {
  it("cutoff 0 allows cancelling right up to the start, not after", () => {
    const start = at("2026-09-20T10:00:00Z");
    expect(withinCancellationWindow(start, at("2026-09-20T09:59:59Z"), 0)).toBe(true);
    expect(withinCancellationWindow(start, at("2026-09-20T10:00:00Z"), 0)).toBe(false);
  });

  it("a positive cutoff closes the window that many hours before the start", () => {
    const start = at("2026-09-20T10:00:00Z");
    expect(withinCancellationWindow(start, at("2026-09-20T07:59:59Z"), 2)).toBe(true);
    expect(withinCancellationWindow(start, at("2026-09-20T08:00:00Z"), 2)).toBe(false);
  });
});
