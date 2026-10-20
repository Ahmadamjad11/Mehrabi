import { useRouter } from "expo-router";
import * as React from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { trpc } from "@/lib/trpc";
import { getApiBaseUrl } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";

const colors = { navy: "#102D4A", ink: "#122033", muted: "#788595", line: "#E7EDF2", canvas: "#F7F9FA", white: "#FFF", green: "#2B9A76", red: "#D46C66", gold: "#B87914" };

type Filter = "all" | "pending" | "approved" | "rejected" | "deleted";

const statusLabel = (status: string) => ({ pending: "قيد المراجعة", approved: "مقبول ومتحقق", rejected: "مرفوض", deleted: "في سلة المحذوفات" }[status] ?? status);

function AdminContent() {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("pending");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loginBusy, setLoginBusy] = React.useState(false);
  const [loginError, setLoginError] = React.useState<string | null>(null);
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const pendingPlaces = trpc.admin.pendingPlaces.useQuery(undefined, { enabled: isAdmin && filter === "pending", retry: 1 });
  const allPlaces = trpc.admin.allPlaces.useQuery(undefined, { enabled: isAdmin && filter !== "pending", retry: 1 });
  const reviews = trpc.admin.reviews.useQuery(undefined, { enabled: isAdmin, retry: 1 });
  const refreshPlaces = () => { void pendingPlaces.refetch(); void allPlaces.refetch(); };
  const places = filter === "pending" ? pendingPlaces : allPlaces;
  const setStatus = trpc.admin.setPlaceStatus.useMutation({ onSuccess: refreshPlaces });
  const deletePlace = trpc.admin.deletePlace.useMutation({ onSuccess: refreshPlaces });
  const restorePlace = trpc.admin.restorePlace.useMutation({ onSuccess: refreshPlaces });
  const approveAll = trpc.admin.approveAllPendingPlaces.useMutation({ onSuccess: refreshPlaces });
  const setReviewStatus = trpc.admin.setReviewStatus.useMutation({ onSuccess: () => reviews.refetch() });

  const login = async () => {
    setLoginBusy(true);
    setLoginError(null);
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/auth/email/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-client-platform": Platform.OS === "web" ? "web" : "native" },
        credentials: "include",
        body: JSON.stringify({ identifier: email, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; app_session_id?: string };
      if (!response.ok) throw new Error(payload.error || "تعذر تسجيل الدخول");
      if (payload.app_session_id) await Auth.setSessionToken(payload.app_session_id);
      setPassword("");
      await me.refetch();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "تعذر تسجيل الدخول");
    } finally {
      setLoginBusy(false);
    }
  };

  const logout = async () => {
    const token = await Auth.getSessionToken();
    await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    }).catch(() => undefined);
    await Auth.removeSessionToken();
    await Auth.clearUserInfo();
    await me.refetch();
    setEmail("");
    setPassword("");
  };

  const filteredPlaces = (places.data ?? []).filter((place) => filter === "all" || place.status === filter);
  const confirmDelete = (placeId: number) => Alert.alert("نقل إلى سلة المحذوفات", "يمكن استرجاع المكان لاحقًا من تبويب السلة.", [{ text: "إلغاء", style: "cancel" }, { text: "متابعة", style: "destructive", onPress: () => deletePlace.mutate({ placeId }) }]);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}><Pressable onPress={() => router.back()}><Text style={styles.back}>رجوع</Text></Pressable><View><Text style={styles.title}>لوحة إدارة محرابي</Text><Text style={styles.subtitle}>لوحة ويب مستقلة لإدارة الأماكن والتعليقات والمحتوى</Text></View></View>
        {!me.isLoading && !isAdmin && <View style={styles.loginCard}>
          <Text style={styles.loginTitle}>{me.data ? "هذا الحساب لا يملك صلاحية الإدارة" : "دخول المدير"}</Text>
          <Text style={styles.loginHint}>استخدم حساب المدير للوصول إلى لوحة المراجعة. لا يلزم تسجيل دخول المدير داخل تطبيق الهاتف.</Text>
          <TextInput value={email} onChangeText={setEmail} placeholder="البريد الإلكتروني" placeholderTextColor="#8A98A5" autoCapitalize="none" keyboardType="email-address" style={[styles.loginInput, styles.emailInput]} />
          <TextInput value={password} onChangeText={setPassword} placeholder="كلمة المرور" placeholderTextColor="#8A98A5" secureTextEntry style={styles.loginInput} />
          {loginError && <Text style={styles.error}>{loginError}</Text>}
          <Pressable style={styles.loginButton} disabled={loginBusy || !email.trim() || !password} onPress={() => void login()}><Text style={styles.loginButtonText}>{loginBusy ? "جارٍ الدخول..." : "تسجيل دخول المدير"}</Text></Pressable>
        </View>}
        {isAdmin && <View style={styles.loggedInRow}><Text style={styles.loggedInText}>تم الدخول كمدير: {me.data?.email}</Text><Pressable style={styles.logoutButton} onPress={() => void logout()}><Text style={styles.logoutText}>تسجيل الخروج</Text></Pressable></View>}
        {!isAdmin ? null : <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>{(["pending", "approved", "all", "deleted", "rejected"] as Filter[]).map((item) => <Pressable key={item} onPress={() => setFilter(item)} style={[styles.tab, filter === item && styles.tabActive]}><Text style={[styles.tabText, filter === item && styles.tabTextActive]}>{item === "all" ? "الكل" : statusLabel(item)}</Text></Pressable>)}</ScrollView>
        <View style={{ flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between" }}><Text style={styles.sectionTitle}>الأماكن ({filteredPlaces.length})</Text>{filter === "pending" && filteredPlaces.length > 0 && <Pressable style={styles.logoutButton} disabled={approveAll.isPending} onPress={() => approveAll.mutate()}><Text style={styles.approveText}>{approveAll.isPending ? "جارٍ الاعتماد..." : "اعتماد الكل"}</Text></Pressable>}</View>
        {places.isLoading && <ActivityIndicator color={colors.navy} />}
        {places.isError && <View style={styles.accessBox}><Text style={styles.error}>انتهت جلسة الإدارة. سجّل الدخول مرة أخرى.</Text></View>}
        {!places.isLoading && !places.isError && filteredPlaces.length === 0 && <Text style={styles.empty}>لا توجد أماكن في هذه الحالة.</Text>}
        {filteredPlaces.map((place) => <View key={place.id} style={styles.card}>
          <View style={styles.cardTop}><Text style={styles.name}>{place.name}</Text><Text style={[styles.badge, place.status === "approved" && styles.badgeGreen, place.status === "deleted" && styles.badgeRed]}>{statusLabel(place.status)}</Text></View>
          <Text style={styles.meta}>{place.type === "mosque" ? "مسجد" : "مصلى"} · {place.address ?? "بدون عنوان"}</Text><Text style={styles.meta}>{place.latitude.toFixed(5)}, {place.longitude.toFixed(5)}</Text>
          <View style={styles.actions}>{place.status === "pending" && <><Pressable style={[styles.button, styles.reject]} onPress={() => setStatus.mutate({ placeId: place.id, status: "rejected" })}><Text style={styles.rejectText}>رفض</Text></Pressable><Pressable style={[styles.button, styles.approve]} onPress={() => setStatus.mutate({ placeId: place.id, status: "approved" })}><Text style={styles.approveText}>قبول ونشر</Text></Pressable></>}{place.status === "deleted" ? <Pressable style={[styles.button, styles.approve]} onPress={() => restorePlace.mutate({ placeId: place.id })}><Text style={styles.approveText}>استرجاع</Text></Pressable> : <Pressable style={[styles.button, styles.delete]} onPress={() => confirmDelete(place.id)}><Text style={styles.rejectText}>سلة المحذوفات</Text></Pressable>}</View>
        </View>)}
        <Text style={[styles.sectionTitle, { marginTop: 22 }]}>التعليقات ({reviews.data?.length ?? 0})</Text>
        {reviews.data?.map((review) => <View key={review.id} style={styles.reviewCard}><View style={styles.cardTop}><Text style={styles.name}>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</Text><Text style={styles.badge}>{review.status === "visible" ? "ظاهر" : review.status === "hidden" ? "مخفي" : "مبلّغ عنه"}</Text></View><Text style={styles.meta}>{review.comment || "بدون تعليق"}</Text><View style={styles.actions}>{review.status !== "visible" && <Pressable style={[styles.button, styles.approve]} onPress={() => setReviewStatus.mutate({ reviewId: review.id, status: "visible" })}><Text style={styles.approveText}>إظهار</Text></Pressable>}{review.status !== "hidden" && <Pressable style={[styles.button, styles.delete]} onPress={() => setReviewStatus.mutate({ reviewId: review.id, status: "hidden" })}><Text style={styles.rejectText}>إخفاء</Text></Pressable>}</View></View>)}
        </>}
      </ScrollView>
    </SafeAreaView>
  );
}

class AdminErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <SafeAreaView style={styles.safe}><View style={styles.errorPage}><Text style={styles.title}>تعذر تحميل لوحة الإدارة</Text><Text style={styles.error}>أعد تحميل الصفحة. إذا استمرت المشكلة، تحقق من اتصال الخادم.</Text></View></SafeAreaView>;
    }
    return this.props.children;
  }
}

export default function AdminScreen() {
  return <AdminErrorBoundary><AdminContent /></AdminErrorBoundary>;
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 20, gap: 12, paddingBottom: 40 }, errorPage: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }, headerRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-start" }, back: { color: colors.navy, fontWeight: "800", paddingTop: 5, writingDirection: "rtl" }, title: { color: colors.navy, fontSize: 25, fontWeight: "900", textAlign: "right", writingDirection: "rtl" }, subtitle: { color: colors.muted, fontSize: 13, textAlign: "right", writingDirection: "rtl", marginTop: 3 }, loginCard: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 }, loginTitle: { color: colors.navy, fontSize: 22, fontWeight: "900", textAlign: "right", writingDirection: "rtl" }, loginHint: { color: colors.muted, fontSize: 13, lineHeight: 21, fontWeight: "500", textAlign: "right", writingDirection: "rtl" }, loginInput: { height: 52, borderWidth: 1.5, borderColor: "#C8D4DC", borderRadius: 14, paddingHorizontal: 15, paddingVertical: 0, color: colors.ink, fontSize: 16, fontWeight: "500", textAlign: "right", writingDirection: "rtl", textAlignVertical: "center", backgroundColor: colors.white }, emailInput: { textAlign: "left", writingDirection: "ltr" }, loggedInRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 10, backgroundColor: "#E5F7F0", borderRadius: 12, padding: 12 }, loggedInText: { color: colors.green, fontSize: 12, fontWeight: "800", flex: 1, textAlign: "right" }, logoutButton: { backgroundColor: colors.white, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 8 }, logoutText: { color: colors.red, fontSize: 12, fontWeight: "800" }, tabs: { flexDirection: "row-reverse", gap: 7, paddingVertical: 8 }, tab: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 11, height: 35, justifyContent: "center", backgroundColor: colors.white }, tabActive: { backgroundColor: colors.navy, borderColor: colors.navy }, tabText: { color: colors.muted, fontSize: 11, fontWeight: "800" }, tabTextActive: { color: colors.white }, sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: "900", textAlign: "right" , writingDirection: "rtl", marginTop: 8 }, card: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 15, gap: 6 }, reviewCard: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 13, gap: 6 }, cardTop: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", gap: 7 }, name: { color: colors.ink, fontSize: 16, fontWeight: "800", textAlign: "right", flex: 1 }, meta: { color: colors.muted, fontSize: 12, textAlign: "right" }, badge: { backgroundColor: "#FFF2D8", color: colors.gold, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4, fontSize: 10, fontWeight: "800" }, badgeGreen: { backgroundColor: "#E5F7F0", color: colors.green }, badgeRed: { backgroundColor: "#FBEAE8", color: colors.red }, actions: { flexDirection: "row-reverse", gap: 8, marginTop: 8 }, button: { flex: 1, minHeight: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 }, approve: { backgroundColor: "#E5F7F0" }, reject: { backgroundColor: "#FBEAE8" }, delete: { backgroundColor: "#FFF2D8" }, approveText: { color: colors.green, fontWeight: "800" }, rejectText: { color: colors.red, fontWeight: "800" }, error: { color: colors.red, textAlign: "right", writingDirection: "rtl" }, accessBox: { backgroundColor: "#FFF7E8", borderRadius: 14, padding: 14, gap: 10 }, loginButton: { backgroundColor: colors.navy, borderRadius: 14, minHeight: 50, paddingVertical: 10, alignItems: "center", justifyContent: "center" }, loginButtonText: { color: colors.white, fontSize: 15, fontWeight: "800", writingDirection: "rtl" }, empty: { color: colors.muted, textAlign: "center", marginTop: 20 } });
