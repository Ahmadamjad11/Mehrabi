import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";
import Constants from "expo-constants";
import * as ReactNative from "react-native";
import { APP_NATIVE_OAUTH_SCHEME } from "../shared/oauth";

const configuredScheme = Constants.expoConfig?.scheme;
const deepLinkScheme = Array.isArray(configuredScheme)
  ? configuredScheme[0] ?? APP_NATIVE_OAUTH_SCHEME
  : configuredScheme ?? APP_NATIVE_OAUTH_SCHEME;
if (deepLinkScheme !== APP_NATIVE_OAUTH_SCHEME) {
  throw new Error("The Expo OAuth scheme does not match the Manus project configuration");
}

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;
export const API_BASE_URL = extra.apiBaseUrl ?? process.env.EXPO_PUBLIC_API_BASE_URL ?? "";
export const SESSION_TOKEN_KEY = "app_session_token";
export const USER_INFO_KEY = "manus-runtime-user-info";
export const PENDING_OAUTH_STATE_KEY = "mehrabi.pending-oauth-state.v1";

export function getApiBaseUrl(): string {
  if (API_BASE_URL) return API_BASE_URL.replace(/\/$/, "");

  if (ReactNative.Platform.OS === "web" && typeof window !== "undefined" && window.location) {
    const { protocol, hostname } = window.location;
    const apiHostname = hostname.replace(/^8081-/, "3000-");
    if (apiHostname !== hostname) return `${protocol}//${apiHostname}`;
  }
  return "";
}

export function getRedirectUri(): string {
  if (ReactNative.Platform.OS === "web") {
    const baseUrl = getApiBaseUrl();
    if (!baseUrl) throw new Error("خدمة تسجيل الدخول غير متاحة حاليًا");
    return `${baseUrl}/api/oauth/callback`;
  }
  return Linking.createURL("oauth/callback", { scheme: deepLinkScheme });
}

export async function startOAuthLogin(): Promise<string | null> {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) throw new Error("خدمة تسجيل الدخول غير متاحة حاليًا");

  const response = await fetch(`${baseUrl}/api/oauth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify({ redirectUri: getRedirectUri() }),
  });

  if (!response.ok) throw new Error("تعذر بدء تسجيل الدخول الآمن؛ حاول مرة أخرى.");
  const result = (await response.json()) as { loginUrl?: string; state?: string };
  if (!result.loginUrl || !result.state) throw new Error("لم تُرجع خدمة تسجيل الدخول بيانات صالحة.");

  if (ReactNative.Platform.OS === "web") {
    if (typeof window !== "undefined") window.location.assign(result.loginUrl);
    return null;
  }

  // Keep the initiating native app's nonce out of the callback URL and app logs.
  await SecureStore.setItemAsync(PENDING_OAUTH_STATE_KEY, result.state);
  try {
    await Linking.openURL(result.loginUrl);
  } catch (error) {
    await SecureStore.deleteItemAsync(PENDING_OAUTH_STATE_KEY);
    throw error instanceof Error ? error : new Error("تعذر فتح صفحة تسجيل الدخول.");
  }
  return null;
}
