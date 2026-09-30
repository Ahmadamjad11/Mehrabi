import { useRouter } from "expo-router";
import * as React from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { trpc } from "@/lib/trpc";

const colors = { navy: "#102D4A", ink: "#122033", muted: "#788595", line: "#E7EDF2", canvas: "#F7F9FA", white: "#FFF", green: "#2B9A76", red: "#D46C66", gold: "#B87914" };

type Filter = "all" | "pending" | "approved" | "rejected" | "deleted";

const statusLabel = (status: string) => ({ pending: "قيد المراجعة", approved: "مقبول ومتحقق", rejected: "مرفوض", deleted: "في سلة المحذوفات" }[status] ?? status);

export default function AdminScreen() {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("pending");
  const places = trpc.admin.allPlaces.useQuery(undefined, { retry: 1 });
  const reviews = trpc.admin.reviews.useQuery(undefined, { retry: 1 });
  const setStatus = trpc.admin.setPlaceStatus.useMutation({ onSuccess: () => places.refetch() });
  const deletePlace = trpc.admin.deletePlace.useMutation({ onSuccess: () => places.refetch() });
  const restorePlace = trpc.admin.restorePlace.useMutation({ onSuccess: () => places.refetch() });
  const setReviewStatus = trpc.admin.setReviewStatus.useMutation({ onSuccess: () => reviews.refetch() });

  const filteredPlaces = (places.data ?? []).filter((place) => filter === "all" || place.status === filter);
  const confirmDelete = (placeId: number) => Alert.alert("نقل إلى سلة المحذوفات", "يمكن استرجاع المكان لاحقًا من تبويب السلة.", [{ text: "إلغاء", style: "cancel" }, { text: "متابعة", style: "destructive", onPress: () => deletePlace.mutate({ placeId }) }]);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}><Pressable onPress={() => router.back()}><Text style={styles.back}>رجوع</Text></Pressable><View><Text style={styles.title}>لوحة إدارة مصلاي</Text><Text style={styles.subtitle}>إدارة الأماكن والتعليقات والمحتوى</Text></View></View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>{(["pending", "approved", "all", "deleted", "rejected"] as Filter[]).map((item) => <Pressable key={item} onPress={() => setFilter(item)} style={[styles.tab, filter === item && styles.tabActive]}><Text style={[styles.tabText, filter === item && styles.tabTextActive]}>{item === "all" ? "الكل" : statusLabel(item)}</Text></Pressable>)}</ScrollView>
        <Text style={styles.sectionTitle}>الأماكن ({filteredPlaces.length})</Text>
        {places.isLoading && <ActivityIndicator color={colors.navy} />}
        {places.isError && <Text style={styles.error}>لا تملك صلاحية الدخول أو تعذر تحميل الأماكن.</Text>}
        {!places.isLoading && !places.isError && filteredPlaces.length === 0 && <Text style={styles.empty}>لا توجد أماكن في هذه الحالة.</Text>}
        {filteredPlaces.map((place) => <View key={place.id} style={styles.card}>
          <View style={styles.cardTop}><Text style={styles.name}>{place.name}</Text><Text style={[styles.badge, place.status === "approved" && styles.badgeGreen, place.status === "deleted" && styles.badgeRed]}>{statusLabel(place.status)}</Text></View>
          <Text style={styles.meta}>{place.type === "mosque" ? "مسجد" : "مصلى"} · {place.address ?? "بدون عنوان"}</Text><Text style={styles.meta}>{place.latitude.toFixed(5)}, {place.longitude.toFixed(5)}</Text>
          <View style={styles.actions}>{place.status === "pending" && <><Pressable style={[styles.button, styles.reject]} onPress={() => setStatus.mutate({ placeId: place.id, status: "rejected" })}><Text style={styles.rejectText}>رفض</Text></Pressable><Pressable style={[styles.button, styles.approve]} onPress={() => setStatus.mutate({ placeId: place.id, status: "approved" })}><Text style={styles.approveText}>قبول ونشر</Text></Pressable></>}{place.status === "deleted" ? <Pressable style={[styles.button, styles.approve]} onPress={() => restorePlace.mutate({ placeId: place.id })}><Text style={styles.approveText}>استرجاع</Text></Pressable> : <Pressable style={[styles.button, styles.delete]} onPress={() => confirmDelete(place.id)}><Text style={styles.rejectText}>سلة المحذوفات</Text></Pressable>}</View>
        </View>)}
        <Text style={[styles.sectionTitle, { marginTop: 22 }]}>التعليقات ({reviews.data?.length ?? 0})</Text>
        {reviews.data?.map((review) => <View key={review.id} style={styles.reviewCard}><View style={styles.cardTop}><Text style={styles.name}>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</Text><Text style={styles.badge}>{review.status === "visible" ? "ظاهر" : review.status === "hidden" ? "مخفي" : "مبلّغ عنه"}</Text></View><Text style={styles.meta}>{review.comment || "بدون تعليق"}</Text><View style={styles.actions}>{review.status !== "visible" && <Pressable style={[styles.button, styles.approve]} onPress={() => setReviewStatus.mutate({ reviewId: review.id, status: "visible" })}><Text style={styles.approveText}>إظهار</Text></Pressable>}{review.status !== "hidden" && <Pressable style={[styles.button, styles.delete]} onPress={() => setReviewStatus.mutate({ reviewId: review.id, status: "hidden" })}><Text style={styles.rejectText}>إخفاء</Text></Pressable>}</View></View>)}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 20, gap: 12, paddingBottom: 40 }, headerRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-start" }, back: { color: colors.navy, fontWeight: "800", paddingTop: 5 }, title: { color: colors.navy, fontSize: 25, fontWeight: "900", textAlign: "right" }, subtitle: { color: colors.muted, fontSize: 13, textAlign: "right", marginTop: 3 }, tabs: { flexDirection: "row-reverse", gap: 7, paddingVertical: 8 }, tab: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 11, height: 35, justifyContent: "center", backgroundColor: colors.white }, tabActive: { backgroundColor: colors.navy, borderColor: colors.navy }, tabText: { color: colors.muted, fontSize: 11, fontWeight: "800" }, tabTextActive: { color: colors.white }, sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: "900", textAlign: "right", marginTop: 8 }, card: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 15, gap: 6 }, reviewCard: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 13, gap: 6 }, cardTop: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", gap: 7 }, name: { color: colors.ink, fontSize: 16, fontWeight: "800", textAlign: "right", flex: 1 }, meta: { color: colors.muted, fontSize: 12, textAlign: "right" }, badge: { backgroundColor: "#FFF2D8", color: colors.gold, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4, fontSize: 10, fontWeight: "800" }, badgeGreen: { backgroundColor: "#E5F7F0", color: colors.green }, badgeRed: { backgroundColor: "#FBEAE8", color: colors.red }, actions: { flexDirection: "row-reverse", gap: 8, marginTop: 8 }, button: { flex: 1, minHeight: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 }, approve: { backgroundColor: "#E5F7F0" }, reject: { backgroundColor: "#FBEAE8" }, delete: { backgroundColor: "#FFF2D8" }, approveText: { color: colors.green, fontWeight: "800" }, rejectText: { color: colors.red, fontWeight: "800" }, error: { color: colors.red, textAlign: "right" }, empty: { color: colors.muted, textAlign: "center", marginTop: 20 } });
