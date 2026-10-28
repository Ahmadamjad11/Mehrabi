import { describe, expect, it } from "vitest";
import { buildPrayerReminderBody, getPrayerReminderIdentifier, getPreviousPrayerName, PRAYER_REMINDER_DAYS } from "../lib/prayerReminders";

describe("prayer reminders", () => {
  const dailyPrayers = ["الفجر", "الظهر", "العصر", "المغرب", "العشاء"];

  it("keeps ten days of reminders queued while leaving room under iOS's 64 pending-notification ceiling", () => {
    expect(PRAYER_REMINDER_DAYS).toBe(10);
    expect(PRAYER_REMINDER_DAYS * dailyPrayers.length).toBe(50);
    expect(PRAYER_REMINDER_DAYS * dailyPrayers.length).toBeLessThanOrEqual(64);
  });

  it("creates deterministic per-date, per-prayer identifiers for safe rescheduling", () => {
    expect(getPrayerReminderIdentifier(2026, 9, 28, 0)).toBe("mehrabi-prayer-2026-10-28-0");
    expect(getPrayerReminderIdentifier(2026, 9, 28, 0)).toBe(getPrayerReminderIdentifier(2026, 9, 28, 0));
    expect(getPrayerReminderIdentifier(2026, 9, 28, 0)).not.toBe(getPrayerReminderIdentifier(2026, 9, 28, 1));
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
