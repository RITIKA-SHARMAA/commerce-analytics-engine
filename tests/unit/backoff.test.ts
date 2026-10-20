import { delayForRetry } from "../../apps/api/src/connector";

describe("delayForRetry", () => {
  it("honours a numeric Retry-After header in seconds", () => {
    expect(delayForRetry(2, "3", () => 0.5)).toBe(3000);
    expect(delayForRetry(0, "0", () => 0.5)).toBe(0);
  });

  it("caps a hostile Retry-After at 60 seconds", () => {
    expect(delayForRetry(0, "86400")).toBe(60_000);
  });

  it("ignores a non-numeric Retry-After and falls back to exponential backoff", () => {
    expect(delayForRetry(1, "Wed, 21 Oct 2026 07:28:00 GMT", () => 0)).toBe(500);
  });

  it("grows exponentially with jitter between half and the full ceiling", () => {
    expect(delayForRetry(0, undefined, () => 0)).toBe(250);
    expect(delayForRetry(0, undefined, () => 1)).toBe(500);
    expect(delayForRetry(2, undefined, () => 0)).toBe(1000);
    expect(delayForRetry(2, undefined, () => 1)).toBe(2000);
  });

  it("never exceeds the 30 second ceiling", () => {
    for (const attempt of [10, 20, 50]) {
      expect(delayForRetry(attempt, undefined, () => 1)).toBeLessThanOrEqual(30_000);
      expect(delayForRetry(attempt, undefined, () => 0)).toBe(15_000);
    }
  });
});
