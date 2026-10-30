import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { buildPrayerReminderBody, getPrayerReminderIdentifier, PRAYER_REMINDER_DAYS } from "./prayerReminders";
import { getJordanCalendarDate, getPrayerSchedule } from "./prayerTimes";

const REMINDER_IDS_KEY = "maslay.prayer-reminder-ids.v1";
const PRAYER_REMINDER_CHANNEL = "prayer-reminders-v3";
const PRAYER_REMINDER_SOUND = "mehrabi_reminder.wav";

if (Notifications.setNotificationHandler) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

export const configurePrayerNotifications = async () => {
  if (Platform.OS === "web") return false;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) {
    const requested = await Notifications.requestPermissionsAsync();
    if (!requested.granted) return false;
  }
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(PRAYER_REMINDER_CHANNEL, {
      name: "تذكيرات الصلاة مع صوت",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      sound: PRAYER_REMINDER_SOUND,
    });
  }
  return true;
};

export const clearPrayerReminderSchedule = async () => {
  // Cancel only prayer-time reminders. Deferred ten-minute reminders must
  // survive the foreground reschedule triggered when an action opens the app.
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const reminderIds = new Set(scheduled
    .filter((item) => (item.content.data as { prayerReminder?: boolean } | undefined)?.prayerReminder)
    .map((item) => item.identifier));
  const stored = await AsyncStorage.getItem(REMINDER_IDS_KEY);
  if (stored) {
    try {
      for (const id of JSON.parse(stored) as string[]) reminderIds.add(id);
    } catch {
      // The system-scheduled list above still allows cancellation if the local ID index is corrupt.
    }
  }
  await Promise.all([...reminderIds].map((id) =>
    Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined),
  ));
  const remaining = await Notifications.getAllScheduledNotificationsAsync();
  const remainingPrayerReminders = remaining.filter((item) =>
    (item.content.data as { prayerReminder?: boolean } | undefined)?.prayerReminder,
  );
  if (remainingPrayerReminders.length > 0) {
    throw new Error(`Failed to cancel ${remainingPrayerReminders.length} prayer reminders`);
  }
  await AsyncStorage.removeItem(REMINDER_IDS_KEY);
};

export const schedulePrayerReminders = async (
  minutesBefore: number,
  location: { lat: number; lng: number } | null,
  isCurrent: () => boolean = () => true,
) => {
  if (Platform.OS === "web") return;
  const ids: string[] = [];
  try {
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    const storedIdsValue = await AsyncStorage.getItem(REMINDER_IDS_KEY);
    const storedIds = storedIdsValue ? JSON.parse(storedIdsValue) as string[] : [];
    const existingIds = new Set([
      ...storedIds,
      ...existing
        .filter((item) => (item.content.data as { prayerReminder?: boolean } | undefined)?.prayerReminder)
        .map((item) => item.identifier),
    ]);
    const now = new Date();
    const scheduledKeys = new Set<string>();
    const firstJordanDate = getJordanCalendarDate(now);
    for (let dayOffset = 0; dayOffset < PRAYER_REMINDER_DAYS; dayOffset += 1) {
      if (!isCurrent()) return;
      const date = new Date(firstJordanDate.getTime());
      date.setDate(date.getDate() + dayOffset);
      const prayerSchedule = getPrayerSchedule(date, location);
      const scheduledPrayerNames = prayerSchedule.map(([name]) => name);
      for (const [prayerIndex, [name, prayerTime]] of prayerSchedule.entries()) {
        if (!isCurrent()) return;
        const triggerDate = new Date(prayerTime.getTime() - minutesBefore * 60 * 1000);
        if (triggerDate <= now) continue;
        const reminderKey = `${name}:${triggerDate.getTime()}`;
        if (scheduledKeys.has(reminderKey)) continue;
        scheduledKeys.add(reminderKey);
        const identifier = getPrayerReminderIdentifier(date.getFullYear(), date.getMonth(), date.getDate(), prayerIndex);
        const id = await Notifications.scheduleNotificationAsync({
          identifier,
          content: {
            title: "نداء محرابي",
            body: buildPrayerReminderBody(minutesBefore, name, scheduledPrayerNames),
            sound: PRAYER_REMINDER_SOUND,
            data: { prayerName: name, reminderKey, prayerReminder: true },
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: triggerDate, channelId: PRAYER_REMINDER_CHANNEL },
        });
        ids.push(id);
      }
    }
    if (!isCurrent()) return;
    await Promise.all([...existingIds].filter((id) => !ids.includes(id)).map((id) =>
      Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined),
    ));
    await AsyncStorage.setItem(REMINDER_IDS_KEY, JSON.stringify(ids));
  } catch (error) {
    const prior = await AsyncStorage.getItem(REMINDER_IDS_KEY).catch(() => null);
    let priorIds: string[] = [];
    try {
      priorIds = prior ? JSON.parse(prior) as string[] : [];
    } catch {
      // Keep the system-scheduled notifications; the next successful refresh repairs this index.
    }
    await AsyncStorage.setItem(REMINDER_IDS_KEY, JSON.stringify([...new Set([...priorIds, ...ids])])).catch(() => undefined);
    throw error;
  }
};
