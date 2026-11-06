import { createContext, useContext } from "react";

export type AdsConsentContextValue = {
  enabled: boolean;
  privacyOptionsRequired: boolean;
  openPrivacyOptions: () => Promise<void>;
};

const defaultValue: AdsConsentContextValue = {
  enabled: false,
  privacyOptionsRequired: false,
  openPrivacyOptions: async () => undefined,
};

export const AdsConsentContext = createContext<AdsConsentContextValue>(defaultValue);

export function useAdsConsent() {
  return useContext(AdsConsentContext);
}
