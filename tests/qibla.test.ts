import { describe, expect, it } from "vitest";
import {
  bearingToKaaba,
  getCompassAccuracyLevel,
  getQiblaRotation,
  isQiblaAligned,
  isReliableCompassAccuracy,
  smoothCompassHeading,
} from "../lib/prayerTimes";

describe("qibla compass", () => {
  it("calculates the Qibla bearing for central Amman", () => {
    expect(bearingToKaaba(31.9539, 35.9106)).toBeCloseTo(160.7, 1);
  });

  it("uses the shortest clockwise/counter-clockwise turn across north", () => {
    expect(getQiblaRotation(10, 350)).toBeCloseTo(20, 5);
    expect(getQiblaRotation(350, 10)).toBeCloseTo(-20, 5);
    expect(getQiblaRotation(160, 170)).toBeCloseTo(-10, 5);
  });

  it("reports alignment only when the red line is close to the Kaaba marker", () => {
    expect(isQiblaAligned(0)).toBe(true);
    expect(isQiblaAligned(7)).toBe(true);
    expect(isQiblaAligned(-7)).toBe(true);
    expect(isQiblaAligned(7.1)).toBe(false);
    expect(isQiblaAligned(null)).toBe(false);
  });

  it("rejects sentinel and out-of-range headings instead of inventing a rotation", () => {
    expect(getQiblaRotation(160, -1)).toBeNull();
    expect(getQiblaRotation(160, 361)).toBeNull();
  });

  it("accepts the first sensor reading directly instead of smoothing from zero", () => {
    expect(smoothCompassHeading(null, 160.7)).toBeCloseTo(160.7, 5);
  });

  it("smooths over north using the short arc", () => {
    expect(smoothCompassHeading(359, 1, 0.5)).toBeCloseTo(0, 5);
  });

  it("maps Expo's calibration levels correctly and requires at least medium accuracy", () => {
    expect(getCompassAccuracyLevel(3)).toBe("high");
    expect(getCompassAccuracyLevel(2)).toBe("medium");
    expect(getCompassAccuracyLevel(1)).toBe("low");
    expect(getCompassAccuracyLevel(0)).toBe("none");
    expect(getCompassAccuracyLevel(4)).toBeNull();
    expect(isReliableCompassAccuracy(2)).toBe(true);
    expect(isReliableCompassAccuracy(1)).toBe(false);
  });
});
