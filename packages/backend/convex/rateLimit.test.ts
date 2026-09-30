import { describe, expect, it } from "vitest";
import { decideWindow, rateLimitedResult } from "./rateLimit";

const H = 3_600_000;

describe("decideWindow", () => {
  it("opens a window on the first call", () => {
    expect(decideWindow(null, 1000, 3, H)).toEqual({
      allowed: true,
      next: { windowStart: 1000, count: 1 },
      retryAfterMs: 0,
    });
  });

  it("allows up to the limit then refuses with the time left", () => {
    let state = { windowStart: 0, count: 0 };
    for (let i = 0; i < 3; i++) {
      const d = decideWindow(state, 10 + i, 3, H);
      expect(d.allowed).toBe(true);
      state = d.next;
    }
    const d = decideWindow(state, 600_000, 3, H);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(H - 600_000);
    expect(d.next).toEqual(state);
  });

  it("starts a new window once the old one has run", () => {
    const d = decideWindow({ windowStart: 0, count: 3 }, H, 3, H);
    expect(d).toEqual({ allowed: true, next: { windowStart: H, count: 1 }, retryAfterMs: 0 });
  });

  it("a clock that went backwards does not lock the user out", () => {
    expect(decideWindow({ windowStart: 5000, count: 99 }, 1000, 3, H).allowed).toBe(true);
  });

  it("formats a typed failure", () => {
    const r = rateLimitedResult(90_000);
    expect(r.status).toBe("rate_limited");
    expect(r.retryAfterMs).toBe(90_000);
    expect(r.message).toContain("2 minutes");
  });
});
