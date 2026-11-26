import AsyncStorage from "@react-native-async-storage/async-storage";
import { getAnalytics, logEvent, setAnalyticsCollectionEnabled, setConsent } from "@react-native-firebase/analytics";
import { Platform } from "react-native";

const ANALYTICS_CONSENT_KEY = "mehrabi.analytics-consent.v1";

export type MehrabiAnalyticsEvent =
  | "qibla_open"
  | "explore_open"
  | "account_open"
  | "prayer_times_open";

const applyAnalyticsConsent = async (enabled: boolean) => {
  if (Platform.OS === "web") return;

  const analytics = getAnalytics();
  const consent = {
    analytics_storage: enabled,
    ad_storage: false,
    ad_user_data: false,
    ad_personalization: false,
  };

  if (enabled) {
    await setConsent(analytics, consent);
    await setAnalyticsCollectionEnabled(analytics, true);
  } else {
    await setAnalyticsCollectionEnabled(analytics, false);
    await setConsent(analytics, consent);
  }
};

export async function initializeAnalyticsConsent() {
  if (Platform.OS === "web") return;

  try {
    const savedChoice = await AsyncStorage.getItem(ANALYTICS_CONSENT_KEY);
    await applyAnalyticsConsent(savedChoice === "granted");
  } catch {
    // Keep collection disabled if consent cannot be read or applied.
    try {
      await applyAnalyticsConsent(false);
    } catch {
      // Native Analytics may not be available in non-native preview environments.
    }
  }
}

export async function getAnalyticsConsent(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  return (await AsyncStorage.getItem(ANALYTICS_CONSENT_KEY)) === "granted";
}

export async function updateAnalyticsConsent(enabled: boolean) {
  if (Platform.OS === "web") return;
  await AsyncStorage.setItem(ANALYTICS_CONSENT_KEY, enabled ? "granted" : "denied");
  await applyAnalyticsConsent(enabled);
}

export function trackAnalyticsEvent(event: MehrabiAnalyticsEvent) {
  if (Platform.OS === "web") return;

  try {
    logEvent(getAnalytics(), event);
  } catch {
    // Analytics must never interrupt the app experience.
  }
}
