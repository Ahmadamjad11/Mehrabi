import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { trpc } from "@/lib/trpc";

export default function AdminScreen() {
  const router = useRouter();
  const pending = trpc.admin.pendingPlaces.useQuery();
  const updateStatus = trpc.admin.setPlaceStatus.useMutation({ onSuccess: () => pending.refetch() });

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => router.back()}><Text style={styles.back}>رجوع</Text></Pressable>
        <Text style={styles.title}>لوحة إدارة مصلاي</Text>
        <Text style={styles.subtitle}>طلبات إضافة الأماكن التي تحتاج مراجعة</Text>
        {pending.isLoading && <ActivityIndicator color="#102D4A" />}
        {pending.isError && <Text style={styles.error}>لا تملك صلاحية الدخول أو تعذر تحميل الطلبات.</Text>}
        {!pending.isLoading && !pending.isError && pending.data?.length === 0 && <Text style={styles.empty}>لا توجد طلبات معلقة حاليًا.</Text>}
        {pending.data?.map((place) => (
          <View key={place.id} style={styles.card}>
            <Text style={styles.name}>{place.name}</Text>
            <Text style={styles.meta}>{place.type === "mosque" ? "مسجد" : "مصلى"} · {place.address ?? "عمّان"}</Text>
            <Text style={styles.meta}>{place.latitude.toFixed(5)}, {place.longitude.toFixed(5)}</Text>
            <View style={styles.actions}>
              <Pressable style={[styles.button, styles.reject]} onPress={() => updateStatus.mutate({ placeId: place.id, status: "rejected" })}><Text style={styles.rejectText}>رفض</Text></Pressable>
              <Pressable style={[styles.button, styles.approve]} onPress={() => updateStatus.mutate({ placeId: place.id, status: "approved" })}><Text style={styles.approveText}>قبول ونشر</Text></Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F7F9FA" },
  content: { padding: 20, gap: 12 },
  back: { color: "#102D4A", fontWeight: "700", textAlign: "left" },
  title: { color: "#102D4A", fontSize: 25, fontWeight: "900", textAlign: "right", marginTop: 18 },
  subtitle: { color: "#788595", fontSize: 13, textAlign: "right", marginBottom: 10 },
  card: { backgroundColor: "#FFF", borderColor: "#E7EDF2", borderWidth: 1, borderRadius: 16, padding: 15, gap: 6 },
  name: { color: "#122033", fontSize: 16, fontWeight: "800", textAlign: "right" },
  meta: { color: "#788595", fontSize: 12, textAlign: "right" },
  actions: { flexDirection: "row-reverse", gap: 8, marginTop: 9 },
  button: { flex: 1, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  approve: { backgroundColor: "#E5F7F0" },
  reject: { backgroundColor: "#FBEAE8" },
  approveText: { color: "#2B9A76", fontWeight: "800" },
  rejectText: { color: "#D46C66", fontWeight: "800" },
  error: { color: "#D46C66", textAlign: "right" },
  empty: { color: "#788595", textAlign: "center", marginTop: 40 },
});
