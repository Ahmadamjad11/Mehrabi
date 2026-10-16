import { describe, expect, it } from "vitest";
import { buildPrayerReminderBody, getPreviousPrayerName, PRAYER_REMINDER_DAYS } from "../lib/prayerReminders";

describe("prayer reminders", () => {
  const dailyPrayers = ["الفجر", "الظهر", "العصر", "المغرب", "العشاء"];

  it("uses a seven-day scheduling horizon", () => {
    expect(PRAYER_REMINDER_DAYS).toBe(7);
  });

  it("derives the previous prayer in the daily cycle", () => {
    expect(getPreviousPrayerName("الظهر", dailyPrayers)).toBe("الفجر");
    expect(getPreviousPrayerName("العصر", dailyPrayers)).toBe("الظهر");
    expect(getPreviousPrayerName("المغرب", dailyPrayers)).toBe("العصر");
    expect(getPreviousPrayerName("العشاء", dailyPrayers)).toBe("المغرب");
    expect(getPreviousPrayerName("الفجر", dailyPrayers)).toBe("العشاء");
  });

  it("uses Friday as the previous prayer before Asr on Friday", () => {
    expect(getPreviousPrayerName("العصر", ["الفجر", "الجمعة", "العصر", "المغرب", "العشاء"])).toBe("الجمعة");
  });

  it("keeps the selected interval in the Arabic notification body", () => {
    expect(buildPrayerReminderBody(30, "العصر", dailyPrayers)).toBe(
      "باقي 30 دقيقة على صلاة العصر — استعد للصلاة. هل صلّيت صلاة الظهر؟",
    );
  });
});
