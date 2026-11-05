import { describe, expect, it } from "vitest";
import { getPrayerProgress } from "../lib/prayerTimes";

describe("prayer progress", () => {
  const previousPrayer = new Date("2026-11-05T17:00:00.000Z");
  const nextPrayer = new Date("2026-11-05T21:00:00.000Z");

  it("starts at zero and advances by the elapsed fraction", () => {
    expect(getPrayerProgress(previousPrayer, nextPrayer, previousPrayer)).toBe(0);
    expect(getPrayerProgress(previousPrayer, nextPrayer, new Date("2026-11-05T19:00:00.000Z"))).toBe(0.5);
    expect(getPrayerProgress(previousPrayer, nextPrayer, nextPrayer)).toBe(1);
  });

  it("clamps times outside the interval to the visible range", () => {
    expect(getPrayerProgress(previousPrayer, nextPrayer, new Date("2026-11-05T16:00:00.000Z"))).toBe(0);
    expect(getPrayerProgress(previousPrayer, nextPrayer, new Date("2026-11-05T22:00:00.000Z"))).toBe(1);
  });

  it("handles an interval that crosses midnight", () => {
    const afterMidnight = new Date("2026-11-06T00:00:00.000Z");
    const nextMorningPrayer = new Date("2026-11-06T03:00:00.000Z");
    expect(getPrayerProgress(nextPrayer, nextMorningPrayer, afterMidnight)).toBe(0.5);
  });

  it("returns zero for invalid or non-positive intervals", () => {
    expect(getPrayerProgress(nextPrayer, previousPrayer, new Date("2026-11-05T19:00:00.000Z"))).toBe(0);
    expect(getPrayerProgress(new Date(Number.NaN), nextPrayer, previousPrayer)).toBe(0);
  });
});
