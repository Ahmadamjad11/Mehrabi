import type { ComponentType, PropsWithChildren } from "react";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as SplashScreen from "expo-splash-screen";

type RuntimeProps = PropsWithChildren<{ allowColdStartAd: boolean }>;
type ProviderComponent = ComponentType<RuntimeProps>;

const COLD_START_SPLASH_TIMEOUT_MS = 1500;
const appId = process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID ?? "";
const appOpenUnitId = process.env.EXPO_PUBLIC_ADMOB_APP_OPEN_UNIT_ID ?? "";
const realAdMobBuild =
  Platform.OS === "android" &&
  !__DEV__ &&
  process.env.EXPO_PUBLIC_ADMOB_ENABLED === "true" &&
  /^ca-app-pub-\d+~\d+$/.test(appId) &&
  /^ca-app-pub-\d+\/\d+$/.test(appOpenUnitId);

if (realAdMobBuild) {
  void SplashScreen.preventAutoHideAsync().catch(() => undefined);
}

export default function AdsProvider({ children }: PropsWithChildren) {
  const [RuntimeProvider, setRuntimeProvider] = useState<ProviderComponent | null>(null);
  const [allowColdStartAd, setAllowColdStartAd] = useState(true);

  useEffect(() => {
    if (!realAdMobBuild) return;

    let mounted = true;
    const fallbackTimer = setTimeout(() => {
      if (!mounted) return;
      void SplashScreen.hideAsync().catch(() => undefined);
    }, COLD_START_SPLASH_TIMEOUT_MS);

    void import("./AdMobRuntime.native")
      .then((module) => {
        if (mounted) setRuntimeProvider(() => module.default);
      })
      .catch(() => {
        if (!mounted) return;
        setAllowColdStartAd(false);
        void SplashScreen.hideAsync().catch(() => undefined);
      });

    return () => {
      mounted = false;
      clearTimeout(fallbackTimer);
    };
  }, []);

  if (!RuntimeProvider) return <>{children}</>;
  return <RuntimeProvider allowColdStartAd={allowColdStartAd}>{children}</RuntimeProvider>;
}
