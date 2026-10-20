import { describe, expect, it } from "vitest";
import {
  KAABA_COORDINATES,
  bearingToKaaba,
  distanceToKaabaKm,
  isHeadingFresh,
  isHeadingReliable,
  isValidCoordinates,
  normalizeDegrees,
  shortestSignedAngle,
} from "../lib/qibla";

describe("qibla compass calculations", () => {
  it("calculates the true bearing and great-circle distance from Amman", () => {
    const bearing = bearingToKaaba(31.9539, 35.9106);
    const distance = distanceToKaabaKm(31.9539, 35.9106);

    expect(bearing).not.toBeNull();
    expect(bearing!).toBeGreaterThan(160);
    expect(bearing!).toBeLessThan(170);
    expect(distance).not.toBeNull();
    expect(distance!).toBeGreaterThan(1200);
    expect(distance!).toBeLessThan(1300);
  });

  it("returns zero distance at the Kaaba and validates coordinates", () => {
    expect(distanceToKaabaKm(KAABA_COORDINATES.latitude, KAABA_COORDINATES.longitude)).toBeCloseTo(0, 6);
    expect(isValidCoordinates(0, 0)).toBe(true);
    expect(isValidCoordinates(91, 0)).toBe(false);
    expect(isValidCoordinates(0, Number.NaN)).toBe(false);
    expect(bearingToKaaba(91, 0)).toBeNull();
    expect(distanceToKaabaKm(0, 181)).toBeNull();
  });

  it("normalizes rotations and takes the shortest turn across north", () => {
    expect(normalizeDegrees(-1)).toBe(359);
    expect(normalizeDegrees(721)).toBe(1);
    expect(shortestSignedAngle(1, 359)).toBeCloseTo(2);
    expect(shortestSignedAngle(359, 1)).toBeCloseTo(-2);
  });

  it("rejects missing, future, or stale heading readings", () => {
    expect(isHeadingFresh(null, 10_000)).toBe(false);
    expect(isHeadingFresh(10_100, 10_000)).toBe(false);
    expect(isHeadingFresh(8_000, 10_000)).toBe(false);
    expect(isHeadingFresh(9_000, 10_000)).toBe(true);
  });

  it("requires fresh, accurate true-north readings for precise confirmation", () => {
    expect(isHeadingReliable({
      headingReady: true,
      headingUpdatedAt: 9_900,
      headingSource: "gps",
      headingAccuracy: 20,
      usesTrueNorth: true,
      now: 10_000,
    })).toBe(true);
    expect(isHeadingReliable({
      headingReady: true,
      headingUpdatedAt: 9_900,
      headingSource: "gps",
      headingAccuracy: null,
      usesTrueNorth: true,
      now: 10_000,
    })).toBe(false);
    expect(isHeadingReliable({
      headingReady: true,
      headingUpdatedAt: 9_900,
      headingSource: "gps",
      headingAccuracy: 40,
      usesTrueNorth: true,
      now: 10_000,
    })).toBe(false);
    expect(isHeadingReliable({
      headingReady: true,
      headingUpdatedAt: 9_900,
      headingSource: "sensor",
      headingAccuracy: null,
      usesTrueNorth: false,
      now: 10_000,
    })).toBe(false);
  });
});
