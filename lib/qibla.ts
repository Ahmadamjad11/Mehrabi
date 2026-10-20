export const KAABA_COORDINATES = {
  latitude: 21.4225,
  longitude: 39.8262,
} as const;

export const isValidCoordinates = (latitude: number, longitude: number) =>
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  latitude >= -90 &&
  latitude <= 90 &&
  longitude >= -180 &&
  longitude <= 180;

export const normalizeDegrees = (degrees: number) =>
  Number.isFinite(degrees) ? ((degrees % 360) + 360) % 360 : Number.NaN;

export const shortestSignedAngle = (target: number, current: number) => {
  if (!Number.isFinite(target) || !Number.isFinite(current)) return Number.NaN;
  return ((normalizeDegrees(target - current) + 540) % 360) - 180;
};

/** Initial true bearing from a validated point on Earth to the Kaaba. */
export const bearingToKaaba = (
  latitude: number,
  longitude: number,
): number | null => {
  if (!isValidCoordinates(latitude, longitude)) return null;

  const targetLat = (KAABA_COORDINATES.latitude * Math.PI) / 180;
  const currentLat = (latitude * Math.PI) / 180;
  const deltaLong = ((KAABA_COORDINATES.longitude - longitude) * Math.PI) / 180;
  const y = Math.sin(deltaLong) * Math.cos(targetLat);
  const x =
    Math.cos(currentLat) * Math.sin(targetLat) -
    Math.sin(currentLat) * Math.cos(targetLat) * Math.cos(deltaLong);

  return normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI);
};

/** Great-circle distance in kilometers, or null when coordinates are invalid. */
export const distanceToKaabaKm = (
  latitude: number,
  longitude: number,
): number | null => {
  if (!isValidCoordinates(latitude, longitude)) return null;

  const earthRadiusKm = 6371.0088;
  const lat1 = (latitude * Math.PI) / 180;
  const lat2 = (KAABA_COORDINATES.latitude * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((KAABA_COORDINATES.longitude - longitude) * Math.PI) / 180;
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const clamped = Math.max(0, Math.min(1, haversine));

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
};

export const isHeadingFresh = (
  headingUpdatedAt: number | null,
  now = Date.now(),
  maxAgeMs = 1500,
) =>
  headingUpdatedAt !== null &&
  Number.isFinite(headingUpdatedAt) &&
  Number.isFinite(now) &&
  now - headingUpdatedAt >= 0 &&
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

  if (headingSource !== "gps" || !usesTrueNorth || headingAccuracy === null) return false;

  return Number.isFinite(headingAccuracy) && headingAccuracy >= 0 && headingAccuracy <= 25;
};
