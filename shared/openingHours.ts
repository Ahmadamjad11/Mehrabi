import { z } from "zod";

export const OPENING_HOURS_MODES = ["prayer_times", "weekly", "unknown"] as const;
export type OpeningHoursMode = (typeof OPENING_HOURS_MODES)[number];

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type OpeningInterval = { opensAt: string; closesAt: string };
export type WeeklyOpeningHours = Record<Weekday, OpeningInterval[] | null>;

const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm time");
const intervalSchema = z.object({ opensAt: timeSchema, closesAt: timeSchema }).strict();
const daySchema = z.array(intervalSchema).max(2);

export const weeklyOpeningHoursSchema = z.object({
  sunday: daySchema.nullable(),
  monday: daySchema.nullable(),
  tuesday: daySchema.nullable(),
  wednesday: daySchema.nullable(),
  thursday: daySchema.nullable(),
  friday: daySchema.nullable(),
  saturday: daySchema.nullable(),
}).strict();

const minutesSinceMidnight = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

export function validateWeeklyOpeningHours(value: WeeklyOpeningHours): string | null {
  let hasKnownOpening = false;
  for (const weekday of WEEKDAYS) {
    const intervals = value[weekday];
    if (intervals === null) continue;
    for (const interval of intervals) {
      const start = minutesSinceMidnight(interval.opensAt);
      const end = minutesSinceMidnight(interval.closesAt);
      if (end <= start) return "Closing time must be later than opening time on the same day";
      hasKnownOpening = true;
    }
    const sorted = intervals.map((interval) => ({
      start: minutesSinceMidnight(interval.opensAt),
      end: minutesSinceMidnight(interval.closesAt),
    })).sort((left, right) => left.start - right.start);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].start < sorted[index - 1].end) return "Opening intervals on a day cannot overlap";
    }
  }
  return hasKnownOpening ? null : "A weekly schedule must include at least one opening interval";
}

export function validateOpeningHoursConfiguration(input: {
  kind: "mosque" | "musalla";
  mode: OpeningHoursMode;
  weeklyHours: WeeklyOpeningHours | null;
}): string | null {
  if (input.kind === "mosque") {
    return input.mode === "prayer_times" && input.weeklyHours === null
      ? null
      : "Mosques use the prayer-times schedule and do not accept guessed manual hours";
  }
  if (input.mode === "prayer_times") return "Prayer-times mode is reserved for mosques";
  if (input.mode === "unknown") return input.weeklyHours === null ? null : "Unknown hours cannot include a weekly schedule";
  if (!input.weeklyHours) return "A weekly schedule is required for manual musalla hours";
  return validateWeeklyOpeningHours(input.weeklyHours);
}

export function getOpeningHoursStatus(input: {
  kind: "mosque" | "musalla";
  mode: OpeningHoursMode;
  weeklyHours: WeeklyOpeningHours | null;
  isTemporarilyClosed: boolean;
}, now = new Date()): boolean | null {
  if (input.isTemporarilyClosed) return false;
  if (input.kind === "mosque" || input.mode !== "weekly" || !input.weeklyHours) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Amman",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = String(values.weekday).toLowerCase() as Weekday;
  const day = input.weeklyHours[weekday];
  if (day === null) return null;
  const currentMinutes = Number(values.hour) * 60 + Number(values.minute);
  return day.some((interval) => currentMinutes >= minutesSinceMidnight(interval.opensAt)
    && currentMinutes < minutesSinceMidnight(interval.closesAt));
}

const WEEKDAY_LABELS: Record<Weekday, { ar: string; en: string }> = {
  sunday: { ar: "الأحد", en: "Sun" },
  monday: { ar: "الاثنين", en: "Mon" },
  tuesday: { ar: "الثلاثاء", en: "Tue" },
  wednesday: { ar: "الأربعاء", en: "Wed" },
  thursday: { ar: "الخميس", en: "Thu" },
  friday: { ar: "الجمعة", en: "Fri" },
  saturday: { ar: "السبت", en: "Sat" },
};

export function formatOpeningHoursLabel(input: {
  kind: "mosque" | "musalla";
  mode: OpeningHoursMode;
  weeklyHours: WeeklyOpeningHours | null;
  isTemporarilyClosed: boolean;
}, language: "ar" | "en"): string {
  if (input.isTemporarilyClosed) return language === "ar" ? "مغلق مؤقتًا" : "Temporarily closed";
  if (input.kind === "mosque" && input.mode === "prayer_times") {
    return language === "ar" ? "يفتح وقت الصلوات" : "Open for prayer times";
  }
  if (input.mode !== "weekly" || !input.weeklyHours) {
    return language === "ar" ? "ساعات العمل غير محددة" : "Hours not specified";
  }

  const lines = WEEKDAYS.flatMap((weekday) => {
    const periods = input.weeklyHours?.[weekday];
    if (periods === null || periods === undefined) return [];
    const label = WEEKDAY_LABELS[weekday][language];
    if (periods.length === 0) return [`${label}: ${language === "ar" ? "مغلق" : "Closed"}`];
    return [`${label}: ${periods.map((period) => `${period.opensAt}–${period.closesAt}`).join("، ")}`];
  });
  return lines.length
    ? `${language === "ar" ? "ساعات محددة" : "Scheduled hours"}: ${lines.join(" · ")}`
    : (language === "ar" ? "ساعات العمل غير محددة" : "Hours not specified");
}
