export const KAABA_COORDINATES = {
  latitude: 21.4225,
  longitude: 39.8262,
} as const;

export const normalizeDegrees = (degrees: number) =>
  ((degrees % 360) + 360) % 360;

export const shortestSignedAngle = (target: number, current: number) =>
  ((normalizeDegrees(target - current) + 540) % 360) - 180;

export const bearingToKaaba = (latitude: number, longitude: number) => {
  const targetLat = (KAABA_COORDINATES.latitude * Math.PI) / 180;
  const currentLat = (latitude * Math.PI) / 180;
  const deltaLong = ((KAABA_COORDINATES.longitude - longitude) * Math.PI) / 180;
  const bearing =
    (Math.atan2(
      Math.sin(deltaLong),
      Math.cos(currentLat) * Math.tan(targetLat) -
        Math.sin(currentLat) * Math.cos(deltaLong),
    ) *
      180) /
    Math.PI;

  return normalizeDegrees(bearing);
};

export const distanceToKaabaKm = (latitude: number, longitude: number) => {
  const earthRadiusKm = 6371;
  const lat1 = (latitude * Math.PI) / 180;
  const lat2 = (KAABA_COORDINATES.latitude * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((KAABA_COORDINATES.longitude - longitude) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** Maps the signed heading difference into a bounded horizontal AR offset.
 * The visible horizontal field is intentionally explicit (90 degrees), rather
 * than using an unexplained visual multiplier. Values outside the field clamp
 * to the edge and the arrow continues to communicate turn direction.
 */
export const qiblaScreenOffset = (
  signedDifference: number,
  viewportWidth: number,
  horizontalFieldOfView = 90,
) => {
  const halfWidth = viewportWidth / 2;
  const halfFov = horizontalFieldOfView / 2;
  const normalizedDifference = Math.max(
    -halfFov,
    Math.min(halfFov, signedDifference),
  );

  return (normalizedDifference / halfFov) * halfWidth;
};

export const isHeadingFresh = (
  headingUpdatedAt: number | null,
  now = Date.now(),
  maxAgeMs = 1500,
) =>
  headingUpdatedAt !== null &&
  Number.isFinite(headingUpdatedAt) &&
  now - headingUpdatedAt <= maxAgeMs;

export const isHeadingReliable = ({
  headingReady,
  headingUpdatedAt,
  headingSource,
  headingAccuracy,
  usesTrueNorth,
  now = Date.now(),
}: {
  headingReady: boolean;
  headingUpdatedAt: number | null;
  headingSource: "gps" | "sensor" | null;
  headingAccuracy: number | null;
  usesTrueNorth: boolean;
  now?: number;
}) => {
  if (!headingReady || !headingSource || !isHeadingFresh(headingUpdatedAt, now)) {
    return false;
  }

  if (headingSource === "gps" && !usesTrueNorth) {
    return false;
  }

  if (headingSource === "gps" && headingAccuracy !== null) {
    return Number.isFinite(headingAccuracy) && headingAccuracy <= 25;
  }

  // Magnetometer fallback has no accuracy value in Expo's event payload.
  // It may guide the user, but it is never treated as a precise confirmation.
  return headingSource === "gps";
};
