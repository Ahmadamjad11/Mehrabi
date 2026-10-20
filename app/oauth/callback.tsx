import { ThemedView } from "@/components/themed-view";
import * as Api from "@/lib/_core/api";
import * as Auth from "@/lib/_core/auth";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function OAuthCallback() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string }>();
  const [status, setStatus] = useState<"processing" | "success" | "error">("processing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const handledCallback = useRef(false);

  useEffect(() => {
    let active = true;

    const finishWithError = (message: string) => {
      if (!active) return;
      setStatus("error");
      setErrorMessage(message);
    };

    const completeLogin = async (code: string | null, state: string | null, providerError: string | null) => {
      if (handledCallback.current) return;
      if (!state) {
        handledCallback.current = true;
        finishWithError("تعذر التحقق من طلب تسجيل الدخول. ابدأ تسجيل الدخول من جديد.");
        return;
      }

      handledCallback.current = true;
      try {
        const stateMatches = await Auth.consumePendingOAuthState(state);
        if (!stateMatches) throw new Error("انتهت صلاحية طلب تسجيل الدخول أو لم يبدأ من هذا التطبيق.");
        if (providerError) throw new Error("أُلغي تسجيل الدخول أو تعذر إكماله.");
        if (!code) throw new Error("رمز تسجيل الدخول غير موجود. حاول مرة أخرى.");

        const result = await Api.exchangeOAuthCode(code, state);
        if (!result.sessionToken || !result.user) throw new Error("لم يكتمل إنشاء جلسة تسجيل الدخول.");

        await Auth.setSessionToken(result.sessionToken);
        await Auth.setUserInfo({
          id: result.user.id,
          openId: result.user.openId,
          name: result.user.name,
          email: result.user.email,
          loginMethod: result.user.loginMethod,
          role: result.user.role,
          lastSignedIn: new Date(result.user.lastSignedIn || Date.now()),
        });
        if (!active) return;
        setStatus("success");
        setTimeout(() => router.replace("/(tabs)"), 700);
      } catch (error) {
        finishWithError(error instanceof Error ? error.message : "تعذر إكمال تسجيل الدخول.");
      }
    };

    const handleUrl = (url?: string) => {
      let code = params.code ?? null;
      let state = params.state ?? null;
      let providerError = params.error ?? null;

      if (url) {
        try {
          const parsed = new URL(url);
          code ??= parsed.searchParams.get("code");
          state ??= parsed.searchParams.get("state");
          providerError ??= parsed.searchParams.get("error");
        } catch {
          // Expo Router parameters above remain the fallback for a relative callback URL.
        }
      }
      if (code || state || providerError) void completeLogin(code, state, providerError);
    };

    const subscription = Linking.addEventListener("url", ({ url }) => handleUrl(url));
    handleUrl();
    if (!params.code && !params.state && !params.error) {
      void Linking.getInitialURL().then((url) => {
        if (url) handleUrl(url);
      });
    }

    return () => {
      active = false;
      subscription.remove();
    };
  }, [params.code, params.state, params.error, router]);

  return (
    <SafeAreaView className="flex-1" edges={["top", "bottom", "left", "right"]}>
      <ThemedView className="flex-1 items-center justify-center gap-4 p-5">
        {status === "processing" && (
          <>
            <ActivityIndicator size="large" />
            <Text className="mt-4 text-base leading-6 text-center text-foreground">جارٍ إكمال تسجيل الدخول…</Text>
          </>
        )}
        {status === "success" && (
          <>
            <Text className="text-base leading-6 text-center text-foreground">تم تسجيل الدخول بنجاح.</Text>
            <Text className="text-base leading-6 text-center text-foreground">جارٍ الرجوع إلى التطبيق…</Text>
          </>
        )}
        {status === "error" && (
          <>
            <Text className="mb-2 text-xl font-bold leading-7 text-error">تعذر تسجيل الدخول</Text>
            <Text className="text-base leading-6 text-center text-foreground">{errorMessage}</Text>
          </>
        )}
      </ThemedView>
    </SafeAreaView>
  );
}
