import { CalculationMethod, Coordinates, Madhab, PrayerTimes } from "adhan";

export const JORDAN_TIME_ZONE = "Asia/Amman";

export const getJordanCalendarDate = (value: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JORDAN_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const getPart = (type: "year" | "month" | "day") => Number(parts.find((part) => part.type === type)?.value);
  // Use midday to avoid an edge case where timezone conversion crosses midnight
  // while adhan is constructing the day's solar calculations.
  return new Date(getPart("year"), getPart("month") - 1, getPart("day"), 12, 0, 0, 0);
};

export const getPrayerSchedule = (now: Date, location: { lat: number; lng: number } | null) => {
  // Jordan calibration: the Ministry of Awqaf timetable is closest to the
  // Karachi angles, with local minute adjustments for Amman/Jordan.
  const params = CalculationMethod.Karachi();
  params.madhab = Madhab.Shafi;
  params.adjustments = { fajr: 0, sunrise: 0, dhuhr: -1, asr: 1, maghrib: 6, isha: 0 };
  const jordanDate = getJordanCalendarDate(now);
  const times = new PrayerTimes(new Coordinates(location?.lat ?? 31.9539, location?.lng ?? 35.9106), jordanDate, params);
  return [
    ["الفجر", times.fajr],
    [jordanDate.getDay() === 5 ? "الجمعة" : "الظهر", times.dhuhr],
    ["العصر", times.asr],
    ["المغرب", times.maghrib],
    ["العشاء", times.isha],
  ] as const;
};

export const formatClock = (date: Date, language: "ar" | "en") =>
  date.toLocaleTimeString(language === "ar" ? "ar-JO" : "en-US", { hour: "numeric", minute: "2-digit", timeZone: JORDAN_TIME_ZONE });

export const localizePrayerName = (name: string, language: "ar" | "en") => {
  if (language === "ar") return name;
  return ({ الفجر: "Fajr", الظهر: "Dhuhr", الجمعة: "Jumu'ah", العصر: "Asr", المغرب: "Maghrib", العشاء: "Isha" } as Record<string, string>)[name] ?? name;
};

export const getDynamicGreeting = (date: Date, language: "ar" | "en") => {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: JORDAN_TIME_ZONE, hour: "numeric", hour12: false }).format(date));
  if (language === "ar") return hour < 12 ? "صباح النور" : hour < 18 ? "مساء الخير" : "ليلة هادئة";
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};

export const formatCountdown = (target: Date, now: Date) => {
  const seconds = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const rest = (seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
};

export const getPrayerProgress = (previousPrayerTime: Date, nextPrayerTime: Date, now: Date) => {
  const previous = previousPrayerTime.getTime();
  const next = nextPrayerTime.getTime();
  const current = now.getTime();
  const duration = next - previous;

  if (!Number.isFinite(previous) || !Number.isFinite(next) || !Number.isFinite(current) || duration <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(0, (current - previous) / duration));
};

export const bearingToKaaba = (latitude: number, longitude: number) => {
  const targetLat = (21.4225 * Math.PI) / 180;
  const currentLat = (latitude * Math.PI) / 180;
  const deltaLong = ((39.8262 - longitude) * Math.PI) / 180;
  const bearing = (Math.atan2(Math.sin(deltaLong), Math.cos(currentLat) * Math.tan(targetLat) - Math.sin(currentLat) * Math.cos(deltaLong)) * 180) / Math.PI;
  return (bearing + 360) % 360;
};

export const isValidCompassHeading = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= 360;

export const normalizeCompassHeading = (value: number) =>
  ((value % 360) + 360) % 360;

export const smoothCompassHeading = (
  previous: number | null,
  next: number,
  factor = 0.28,
): number | null => {
  if (!isValidCompassHeading(next)) return previous;
  const normalizedNext = normalizeCompassHeading(next);
  if (
    previous === null ||
    !isValidCompassHeading(previous) ||
    !Number.isFinite(factor) ||
    factor <= 0 ||
    factor > 1
  ) {
    return normalizedNext;
  }

  const normalizedPrevious = normalizeCompassHeading(previous);
  const delta = ((normalizedNext - normalizedPrevious + 540) % 360) - 180;
  return normalizeCompassHeading(normalizedPrevious + delta * factor);
};

export const getQiblaRotation = (qiblaBearing: number, heading: number) => {
  if (!isValidCompassHeading(qiblaBearing) || !isValidCompassHeading(heading)) return null;
  return ((normalizeCompassHeading(qiblaBearing) - normalizeCompassHeading(heading) + 540) % 360) - 180;
};

export const isQiblaAligned = (rotation: number | null, tolerance = 7) =>
  rotation !== null && Number.isFinite(rotation) && Number.isFinite(tolerance) && tolerance >= 0 && Math.abs(rotation) <= tolerance;

export const getCompassAccuracyLevel = (accuracy: number | null) => {
  switch (accuracy) {
    case 3:
      return "high" as const;
    case 2:
      return "medium" as const;
    case 1:
      return "low" as const;
    case 0:
      return "none" as const;
    default:
      return null;
  }
};

export const isReliableCompassAccuracy = (accuracy: number | null) =>
  accuracy === 2 || accuracy === 3;

export const distanceToKaabaKm = (latitude: number, longitude: number) => {
  const earthRadiusKm = 6371;
  const lat1 = (latitude * Math.PI) / 180;
  const lat2 = (21.4225 * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((39.8262 - longitude) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
