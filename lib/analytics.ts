import { getAnalytics, logEvent, setAnalyticsCollectionEnabled } from "@react-native-firebase/analytics";
import { Platform } from "react-native";

/** Records app launches; Firebase calculates daily and monthly active users. */
export async function initializeAnalytics() {
  if (Platform.OS === "web") return;
  try {
    const instance = getAnalytics();
    await setAnalyticsCollectionEnabled(instance, true);
    await logEvent(instance, "app_open");
  } catch {
    // Analytics must never interrupt the app experience.
  }
}

export function trackAnalyticsEvent() {
  if (Platform.OS === "web") return;
  try {
    void logEvent(getAnalytics(), "app_open");
  } catch {
    // Analytics must never interrupt the app experience.
  }
}
