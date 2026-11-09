import AsyncStorage from "@react-native-async-storage/async-storage";
import mobileAds, {
  AdsConsent,
  AdsConsentPrivacyOptionsRequirementStatus,
  useAppOpenAdManager,
  type AdsConsentInfo,
} from "react-native-google-mobile-ads";
import type { PropsWithChildren } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as SplashScreen from "expo-splash-screen";
import { AdsConsentContext } from "./AdsConsentContext";

const APP_OPEN_LAUNCH_COUNT_KEY = "mehrabi.admob.app-open-launch-count.v1";
const FIRST_ELIGIBLE_LAUNCH = 3;
const COLD_START_AD_WINDOW_MS = 8000;
const appOpenUnitId = process.env.EXPO_PUBLIC_ADMOB_APP_OPEN_UNIT_ID ?? "";

type Props = PropsWithChildren<{ allowColdStartAd: boolean }>;

export default function AdMobRuntime({ children, allowColdStartAd }: Props) {
  const [canRequestAds, setCanRequestAds] = useState(false);
  const [privacyOptionsRequired, setPrivacyOptionsRequired] = useState(false);
  const [eligibleAfterSeveralOpens, setEligibleAfterSeveralOpens] = useState<boolean | null>(null);
  const [coldStartAdWindowOpen, setColdStartAdWindowOpen] = useState(true);
  const initializationPromise = useRef<Promise<unknown> | null>(null);
  const coldStartResolved = useRef(false);
  const coldStartAdOffered = useRef(false);

  const finishColdStart = useCallback(() => {
    if (coldStartResolved.current) return;
    coldStartResolved.current = true;
    void SplashScreen.hideAsync().catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setColdStartAdWindowOpen(false);
      finishColdStart();
    }, COLD_START_AD_WINDOW_MS);

    return () => clearTimeout(timer);
  }, [finishColdStart]);

  const initializeSdkOnce = useCallback(() => {
    if (!initializationPromise.current) {
      initializationPromise.current = mobileAds().initialize().catch((error: unknown) => {
        initializationPromise.current = null;
        throw error;
      });
    }
    return initializationPromise.current;
  }, []);

  const applyConsentInfo = useCallback(
    async (consentInfo: AdsConsentInfo) => {
      setPrivacyOptionsRequired(
        consentInfo.privacyOptionsRequirementStatus ===
          AdsConsentPrivacyOptionsRequirementStatus.REQUIRED,
      );

      if (!consentInfo.canRequestAds) {
        setCanRequestAds(false);
        return;
      }

      try {
        await initializeSdkOnce();
        setCanRequestAds(true);
      } catch {
        setCanRequestAds(false);
      }
    },
    [initializeSdkOnce],
  );

  useEffect(() => {
    let mounted = true;

    const updateConsent = async () => {
      let consentInfo: AdsConsentInfo | null = null;
      try {
        consentInfo = await AdsConsent.gatherConsent();
      } catch {
        try {
          consentInfo = await AdsConsent.getConsentInfo();
        } catch {
          consentInfo = null;
        }
      }

      if (mounted && consentInfo) await applyConsentInfo(consentInfo);
    };

    void updateConsent();
    return () => {
      mounted = false;
    };
  }, [applyConsentInfo]);

  useEffect(() => {
    let mounted = true;

    const recordAppOpen = async () => {
      try {
        const savedCount = await AsyncStorage.getItem(APP_OPEN_LAUNCH_COUNT_KEY);
        const parsedCount = Number.parseInt(savedCount ?? "0", 10);
        const nextCount = Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount + 1 : 1;
        await AsyncStorage.setItem(APP_OPEN_LAUNCH_COUNT_KEY, String(nextCount));
        if (mounted) setEligibleAfterSeveralOpens(nextCount >= FIRST_ELIGIBLE_LAUNCH);
      } catch {
        if (mounted) setEligibleAfterSeveralOpens(false);
      }
    };

    void recordAppOpen();
    return () => {
      mounted = false;
    };
  }, []);

  const openPrivacyOptions = useCallback(async () => {
    const consentInfo = await AdsConsent.getConsentInfo();
    if (
      consentInfo.privacyOptionsRequirementStatus !==
      AdsConsentPrivacyOptionsRequirementStatus.REQUIRED
    ) {
      await applyConsentInfo(consentInfo);
      return;
    }

    await AdsConsent.showPrivacyOptionsForm();
    const updatedConsentInfo = await AdsConsent.getConsentInfo();
    await applyConsentInfo(updatedConsentInfo);
  }, [applyConsentInfo]);

  const consentContextValue = useMemo(
    () => ({
      enabled: true,
      privacyOptionsRequired,
      openPrivacyOptions,
    }),
    [privacyOptionsRequired, openPrivacyOptions],
  );

  const { status: appOpenStatus, showAdIfAvailable, isShowing } = useAppOpenAdManager({
    adUnitId:
      coldStartAdWindowOpen &&
      canRequestAds &&
      eligibleAfterSeveralOpens === true &&
      appOpenUnitId.length > 0
        ? appOpenUnitId
        : null,
    autoLoad:
      coldStartAdWindowOpen && canRequestAds && eligibleAfterSeveralOpens === true,
  });

  useEffect(() => {
    if (!allowColdStartAd || !coldStartAdWindowOpen) {
      finishColdStart();
      return;
    }

    if (eligibleAfterSeveralOpens === false) {
      finishColdStart();
      return;
    }

    if (
      coldStartResolved.current ||
      eligibleAfterSeveralOpens !== true ||
      !canRequestAds
    ) {
      return;
    }

    if (appOpenStatus === "loaded" && !coldStartAdOffered.current) {
      coldStartAdOffered.current = true;
      showAdIfAvailable();
      return;
    }

    if (appOpenStatus === "no-fill" || appOpenStatus === "error") {
      finishColdStart();
      return;
    }

    if (
      coldStartAdOffered.current &&
      !isShowing &&
      appOpenStatus === "closed"
    ) {
      finishColdStart();
    }
  }, [
    appOpenStatus,
    allowColdStartAd,
    coldStartAdWindowOpen,
    canRequestAds,
    eligibleAfterSeveralOpens,
    finishColdStart,
    isShowing,
    showAdIfAvailable,
  ]);

  return (
    <AdsConsentContext.Provider value={consentContextValue}>
      {children}
    </AdsConsentContext.Provider>
  );
}
