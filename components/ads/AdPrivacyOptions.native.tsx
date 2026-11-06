import { Alert, Pressable, Text } from "react-native";
import { useAdsConsent } from "./AdsConsentContext";

type Props = {
  language: "ar" | "en";
};

export default function AdPrivacyOptions({ language }: Props) {
  const { enabled, privacyOptionsRequired, openPrivacyOptions } = useAdsConsent();

  if (!enabled || !privacyOptionsRequired) return null;

  const handlePress = async () => {
    try {
      await openPrivacyOptions();
    } catch {
      Alert.alert(
        language === "ar" ? "تعذر فتح إعدادات الخصوصية" : "Could not open privacy settings",
        language === "ar"
          ? "حاول مرة أخرى عند توفر اتصال بالإنترنت."
          : "Please try again when an internet connection is available.",
      );
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => void handlePress()}
      style={{
        marginTop: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderColor: "#D7E2E8",
        borderWidth: 1,
        borderRadius: 12,
        alignItems: "center",
      }}
    >
      <Text style={{ color: "#2B6570", fontSize: 14, fontWeight: "600" }}>
        {language === "ar" ? "إعدادات خصوصية الإعلانات" : "Ad privacy settings"}
      </Text>
    </Pressable>
  );
}
