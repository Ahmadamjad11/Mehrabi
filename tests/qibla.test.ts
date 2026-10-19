import { describe, expect, it } from "vitest";
import {
  bearingToKaaba,
  isHeadingFresh,
  isHeadingReliable,
  qiblaScreenOffset,
  shortestSignedAngle,
} from "../lib/qibla";

describe("qibla calculations", () => {
  it("calculates different bearings for different locations", () => {
    const amman = bearingToKaaba(31.9539, 35.9106);
    const aqaba = bearingToKaaba(29.5321, 35.0063);

    expect(amman).not.toBeCloseTo(aqaba, 1);
    expect(amman).toBeGreaterThanOrEqual(0);
    expect(amman).toBeLessThan(360);
  });

  it("handles the 359/0 degree boundary with the shortest turn", () => {
    expect(shortestSignedAngle(1, 359)).toBeCloseTo(2);
    expect(shortestSignedAngle(359, 1)).toBeCloseTo(-2);
  });

  it("maps the heading difference to a bounded screen position", () => {
    expect(qiblaScreenOffset(0, 300)).toBe(0);
    expect(qiblaScreenOffset(45, 300)).toBe(150);
    expect(qiblaScreenOffset(-45, 300)).toBe(-150);
    expect(qiblaScreenOffset(180, 300)).toBe(150);
  });

  it("rejects missing or stale heading readings", () => {
    expect(isHeadingFresh(null, 10_000)).toBe(false);
    expect(isHeadingFresh(8_000, 10_000)).toBe(false);
    expect(isHeadingFresh(9_000, 10_000)).toBe(true);
    expect(
      isHeadingReliable({
        headingReady: true,
        headingUpdatedAt: 8_000,
        headingSource: "gps",
        headingAccuracy: 5,
        now: 10_000,
      }),
    ).toBe(false);
  });

  it("does not confirm qibla from an unverified magnetometer fallback", () => {
    expect(
      isHeadingReliable({
        headingReady: true,
        headingUpdatedAt: 9_900,
        headingSource: "sensor",
        headingAccuracy: null,
        now: 10_000,
      }),
    ).toBe(false);
  });

  it("requires fresh and accurate true heading for confirmation", () => {
    expect(
      isHeadingReliable({
        headingReady: true,
        headingUpdatedAt: 9_900,
        headingSource: "gps",
        headingAccuracy: 20,
        now: 10_000,
      }),
    ).toBe(true);

    expect(
      isHeadingReliable({
        headingReady: true,
        headingUpdatedAt: 9_900,
        headingSource: "gps",
        headingAccuracy: 40,
        now: 10_000,
      }),
    ).toBe(false);
  });
});
