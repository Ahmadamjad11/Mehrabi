export const PRAYER_REMINDER_DAYS = 7;

const PRAYER_ORDER = ["الفجر", "الظهر", "العصر", "المغرب", "العشاء"] as const;

export const getPreviousPrayerName = (currentPrayer: string, scheduledPrayerNames: string[]) => {
  const currentKey = currentPrayer === "الجمعة" ? "الظهر" : currentPrayer;
  const currentIndex = PRAYER_ORDER.indexOf(currentKey as (typeof PRAYER_ORDER)[number]);
  if (currentIndex < 0) return "العشاء";
  const previousPrayer = PRAYER_ORDER[(currentIndex + PRAYER_ORDER.length - 1) % PRAYER_ORDER.length];
  return previousPrayer === "الظهر" && scheduledPrayerNames.includes("الجمعة") ? "الجمعة" : previousPrayer;
};

export const buildPrayerReminderBody = (minutesBefore: number, prayerName: string, scheduledPrayerNames: string[]) =>
  `باقي ${minutesBefore} دقيقة على صلاة ${prayerName} — استعد للصلاة. هل صلّيت صلاة ${getPreviousPrayerName(prayerName, scheduledPrayerNames)}؟`;
