import { useEffect, useState } from "react";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import { getAnalyticsConsent, updateAnalyticsConsent } from "@/lib/analytics";

type Props = {
  language: "ar" | "en";
};

export default function AnalyticsConsentSettings({ language }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let mounted = true;
    void getAnalyticsConsent()
      .then((value) => {
        if (mounted) setEnabled(value);
      })
      .catch(() => {
        if (mounted) setEnabled(false);
      })
      .finally(() => {
        if (mounted) setBusy(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (Platform.OS === "web") return null;

  const toggle = async () => {
    if (busy) return;
    const next = !enabled;
    setBusy(true);
    try {
      await updateAnalyticsConsent(next);
      setEnabled(next);
    } catch {
      Alert.alert(
        language === "ar" ? "تعذر تحديث الإعداد" : "Could not update setting",
        language === "ar"
          ? "حاول مرة أخرى. سيبقى قياس الاستخدام متوقفًا إذا تعذر حفظ موافقتك."
          : "Please try again. Usage analytics will remain disabled if your choice cannot be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ marginTop: 14, padding: 14, borderRadius: 14, backgroundColor: "#F1F6F7", gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: "#102D4A", fontSize: 14, fontWeight: "800", textAlign: "right" }}>
            {language === "ar" ? "مشاركة إحصاءات الاستخدام" : "Share usage analytics"}
          </Text>
          <Text style={{ color: "#526274", fontSize: 12, lineHeight: 19, textAlign: "right", marginTop: 4 }}>
            {language === "ar"
              ? "تساعدنا على معرفة عدد المستخدمين والميزات الأكثر استخدامًا. لا نرسل الاسم أو البريد أو الهاتف أو موقعك الدقيق. يستخدم Firebase معرّفًا تقنيًا للتطبيق لاحتساب المستخدمين."
              : "Helps us understand active users and popular features. We do not send your name, email, phone number, or precise location. Firebase uses a technical app identifier to count users."}
          </Text>
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: enabled, disabled: busy }}
          disabled={busy}
          onPress={() => void toggle()}
          style={{
            width: 48,
            height: 28,
            borderRadius: 16,
            padding: 3,
            justifyContent: "center",
            backgroundColor: enabled ? "#2B8C82" : "#AAB5C0",
            opacity: busy ? 0.6 : 1,
          }}
        >
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: "#FFFFFF",
              alignSelf: enabled ? "flex-end" : "flex-start",
            }}
          />
        </Pressable>
      </View>
      <Text style={{ color: "#6B7785", fontSize: 11, textAlign: "right" }}>
        {busy
          ? (language === "ar" ? "جارٍ تحميل الإعداد..." : "Loading setting...")
          : enabled
            ? (language === "ar" ? "مفعّل — يمكنك إيقافه في أي وقت." : "Enabled — you can turn it off at any time.")
            : (language === "ar" ? "متوقف افتراضيًا — لن تُجمع إحصاءات الاستخدام دون تفعيلك." : "Off by default — usage analytics are not collected unless you enable it.")}
      </Text>
    </View>
  );
}
