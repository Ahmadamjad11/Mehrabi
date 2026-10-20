import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { trpc } from "@/lib/trpc";

const COLORS = {
  navy: "#102D4A",
  ink: "#122033",
  muted: "#788595",
  line: "#E7EDF2",
  canvas: "#F7F9FA",
  white: "#FFFFFF",
  teal: "#5AAFA7",
  gold: "#F3B44B",
  goldSoft: "#FFF2D8",
};
const PAGE_SIZE = 25;

type DirectoryRecord = {
  id: number;
  name: string;
  governorate: string;
  directorate: string;
  locality: string | null;
  latitude: number | null;
  longitude: number | null;
  mapUrl: string | null;
  dataYear: number;
  sourceRefs: { resourcePage: string }[];
};

export default function OfficialMosqueDirectory() {
  const router = useRouter();
  const params = useLocalSearchParams<{ lang?: string | string[] }>();
  const languageParam = Array.isArray(params.lang) ? params.lang[0] : params.lang;
  const isArabic = languageParam !== "en";
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearch(searchText.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchText]);

  const directoryQuery = trpc.officialMosques.list.useQuery(
    { search: search || undefined, limit: PAGE_SIZE, offset },
    { staleTime: 5 * 60_000, retry: 2 },
  );
  const records = (directoryQuery.data?.items ?? []) as DirectoryRecord[];
  const total = directoryQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(pageCount, Math.floor(offset / PAGE_SIZE) + 1);

  const openUrl = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      // The official list remains usable even when an external map or source link is unavailable.
    }
  };

  const openMap = (record: DirectoryRecord) => {
    const url = record.mapUrl ?? (record.latitude !== null && record.longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${record.latitude},${record.longitude}`
      : null);
    if (url) void openUrl(url);
  };

  const openSource = (record: DirectoryRecord) => {
    const url = record.sourceRefs[0]?.resourcePage;
    if (url) void openUrl(url);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel={isArabic ? "رجوع" : "Back"}>
            <Ionicons name="arrow-forward" size={20} color={COLORS.navy} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{isArabic ? "مصدر حكومي أردني" : "Jordanian government source"}</Text>
            <Text style={styles.title}>{isArabic ? "دليل المساجد الرسمي" : "Official mosque directory"}</Text>
          </View>
          <View style={styles.headerIcon}><MaterialCommunityIcons name="mosque" size={23} color={COLORS.gold} /></View>
        </View>

        <View style={styles.notice}>
          <Ionicons name="information-circle-outline" size={20} color={COLORS.teal} />
          <Text style={styles.noticeText}>
            {isArabic
              ? "يعرض هذا الدليل السجلات المنشورة والقابلة للتنزيل من الوزارة (2023–2024)، وليس حصرًا مؤكدًا لكل مسجد في المملكة. لا نخمّن مواقع غير مذكورة في المصدر."
              : "This directory shows downloadable Ministry records (2023–2024), not a verified census of every mosque in Jordan. Locations absent from the source are not inferred."}
          </Text>
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={19} color={COLORS.muted} />
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder={isArabic ? "ابحث بالاسم أو المحافظة أو المديرية" : "Search name, governorate or directorate"}
            placeholderTextColor="#9DA8B3"
            style={styles.searchInput}
            textAlign={isArabic ? "right" : "left"}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={isArabic ? "البحث في دليل المساجد الرسمي" : "Search official mosque directory"}
          />
          {searchText.length > 0 && (
            <Pressable onPress={() => setSearchText("")} accessibilityRole="button" accessibilityLabel={isArabic ? "مسح البحث" : "Clear search"}>
              <Ionicons name="close-circle" size={19} color={COLORS.muted} />
            </Pressable>
          )}
        </View>

        <View style={styles.resultHeader}>
          <Text style={styles.resultCount}>
            {total.toLocaleString(isArabic ? "ar-JO" : "en-US")} {isArabic ? "سجل متاح" : "records available"}
          </Text>
          {directoryQuery.isFetching && !directoryQuery.isLoading && <ActivityIndicator size="small" color={COLORS.teal} />}
        </View>

        {directoryQuery.isLoading ? (
          <View style={styles.stateBox}><ActivityIndicator size="large" color={COLORS.teal} /><Text style={styles.stateText}>{isArabic ? "جارٍ تحميل سجلات الوزارة…" : "Loading Ministry records…"}</Text></View>
        ) : directoryQuery.isError ? (
          <View style={styles.stateBox}>
            <Ionicons name="cloud-offline-outline" size={28} color={COLORS.muted} />
            <Text style={styles.stateText}>{isArabic ? "تعذر تحميل السجل الآن. تحقق من الاتصال وحاول مجددًا." : "The directory could not load. Check your connection and try again."}</Text>
            <Pressable style={styles.retryButton} onPress={() => void directoryQuery.refetch()}><Text style={styles.retryText}>{isArabic ? "إعادة المحاولة" : "Try again"}</Text></Pressable>
          </View>
        ) : records.length === 0 ? (
          <View style={styles.stateBox}><Ionicons name="search-outline" size={28} color={COLORS.muted} /><Text style={styles.stateText}>{isArabic ? "لا توجد سجلات تطابق البحث." : "No records match this search."}</Text></View>
        ) : (
          records.map((record) => {
            const hasMap = Boolean(record.mapUrl) || (record.latitude !== null && record.longitude !== null);
            return (
              <View key={record.id} style={styles.card}>
                <View style={styles.cardHeading}>
                  <View style={styles.officialPill}><Ionicons name="checkmark-circle" size={13} color={COLORS.teal} /><Text style={styles.officialText}>{isArabic ? "بيانات الوزارة" : "Ministry record"}</Text></View>
                  <Text style={[styles.mosqueName, { textAlign: isArabic ? "right" : "left" }]}>{record.name}</Text>
                </View>
                <Text style={[styles.area, { textAlign: isArabic ? "right" : "left" }]}>
                  {[record.governorate, record.directorate, record.locality].filter(Boolean).join(" · ")}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={styles.metaText}>{isArabic ? `بيانات ${record.dataYear}` : `Source year ${record.dataYear}`}</Text>
                  <View style={styles.metaDot} />
                  <Text style={styles.metaText}>
                    {record.latitude !== null && record.longitude !== null
                      ? (isArabic ? "إحداثيات واردة في المصدر" : "Coordinates in source")
                      : hasMap
                        ? (isArabic ? "رابط خريطة من المصدر" : "Map link in source")
                        : (isArabic ? "لا يوجد موقع جغرافي في الملف" : "No geographic location in file")}
                  </Text>
                </View>
                <View style={styles.actions}>
                  {hasMap && (
                    <Pressable style={styles.mapButton} onPress={() => openMap(record)} accessibilityRole="button">
                      <Ionicons name="navigate-outline" size={16} color={COLORS.white} />
                      <Text style={styles.mapButtonText}>{isArabic ? "موقع المسجد" : "Map"}</Text>
                    </Pressable>
                  )}
                  <Pressable style={styles.sourceButton} onPress={() => openSource(record)} accessibilityRole="button">
                    <Ionicons name="document-text-outline" size={16} color={COLORS.navy} />
                    <Text style={styles.sourceButtonText}>{isArabic ? "المصدر الرسمي" : "Official source"}</Text>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}

        {total > PAGE_SIZE && !directoryQuery.isError && (
          <View style={styles.pagination}>
            <Pressable
              onPress={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
              disabled={offset === 0}
              style={[styles.pageButton, offset === 0 && styles.disabledButton]}
            >
              <Ionicons name="chevron-forward" size={18} color={offset === 0 ? COLORS.muted : COLORS.navy} />
              <Text style={[styles.pageButtonText, offset === 0 && styles.disabledText]}>{isArabic ? "السابق" : "Previous"}</Text>
            </Pressable>
            <Text style={styles.pageLabel}>{isArabic ? `صفحة ${currentPage} من ${pageCount}` : `Page ${currentPage} of ${pageCount}`}</Text>
            <Pressable
              onPress={() => setOffset((current) => Math.min(current + PAGE_SIZE, (pageCount - 1) * PAGE_SIZE))}
              disabled={currentPage >= pageCount}
              style={[styles.pageButton, currentPage >= pageCount && styles.disabledButton]}
            >
              <Text style={[styles.pageButtonText, currentPage >= pageCount && styles.disabledText]}>{isArabic ? "التالي" : "Next"}</Text>
              <Ionicons name="chevron-back" size={18} color={currentPage >= pageCount ? COLORS.muted : COLORS.navy} />
            </Pressable>
          </View>
        )}
        <Text style={styles.footerNote}>
          {isArabic
            ? "المصدر: وزارة الأوقاف والشؤون والمقدسات الإسلامية الأردنية · الرخصة الأردنية للبيانات الحكومية المفتوحة."
            : "Source: Jordan Ministry of Awqaf · Jordanian Open Government Data License."}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.canvas },
  content: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 32, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9 },
  backButton: { width: 42, height: 42, borderRadius: 14, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, alignItems: "flex-end" },
  eyebrow: { color: COLORS.teal, fontSize: 11, fontWeight: "800", textAlign: "right" },
  title: { color: COLORS.ink, fontSize: 21, fontWeight: "900", textAlign: "right", marginTop: 3 },
  headerIcon: { width: 44, height: 44, borderRadius: 15, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center" },
  notice: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 9, backgroundColor: "#EFF8F7", borderColor: "#D7ECE9", borderWidth: 1, padding: 12, borderRadius: 16 },
  noticeText: { flex: 1, color: "#426E6B", fontSize: 12, lineHeight: 19, textAlign: "right" },
  searchBox: { minHeight: 48, flexDirection: "row-reverse", alignItems: "center", gap: 9, backgroundColor: COLORS.white, borderColor: COLORS.line, borderWidth: 1, borderRadius: 15, paddingHorizontal: 13 },
  searchInput: { flex: 1, color: COLORS.ink, fontSize: 13, paddingVertical: 10 },
  resultHeader: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", minHeight: 28 },
  resultCount: { color: COLORS.navy, fontSize: 13, fontWeight: "800", textAlign: "right" },
  stateBox: { alignItems: "center", justifyContent: "center", gap: 12, minHeight: 170, padding: 22, backgroundColor: COLORS.white, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line },
  stateText: { color: COLORS.muted, fontSize: 13, textAlign: "center", lineHeight: 20 },
  retryButton: { backgroundColor: COLORS.navy, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { color: COLORS.white, fontSize: 12, fontWeight: "800" },
  card: { backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, borderRadius: 18, padding: 15, gap: 8 },
  cardHeading: { alignItems: "flex-end", gap: 7 },
  officialPill: { flexDirection: "row-reverse", alignItems: "center", gap: 4, backgroundColor: "#EFF8F7", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  officialText: { color: COLORS.teal, fontSize: 10, fontWeight: "800" },
  mosqueName: { width: "100%", color: COLORS.ink, fontSize: 16, lineHeight: 23, fontWeight: "900" },
  area: { color: COLORS.muted, fontSize: 12, lineHeight: 19 },
  metaRow: { flexDirection: "row-reverse", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 2 },
  metaText: { color: COLORS.muted, fontSize: 10, lineHeight: 16 },
  metaDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: COLORS.gold },
  actions: { flexDirection: "row-reverse", alignItems: "center", gap: 8, marginTop: 4 },
  mapButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: COLORS.navy, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  mapButtonText: { color: COLORS.white, fontSize: 11, fontWeight: "800" },
  sourceButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: COLORS.goldSoft, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  sourceButtonText: { color: COLORS.navy, fontSize: 11, fontWeight: "800" },
  pagination: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 8 },
  pageButton: { flexDirection: "row-reverse", alignItems: "center", gap: 3, paddingHorizontal: 9, paddingVertical: 8, borderRadius: 10, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line },
  pageButtonText: { color: COLORS.navy, fontSize: 11, fontWeight: "800" },
  disabledButton: { backgroundColor: "#F1F3F5" },
  disabledText: { color: COLORS.muted },
  pageLabel: { color: COLORS.muted, fontSize: 11, textAlign: "center" },
  footerNote: { color: COLORS.muted, fontSize: 10, lineHeight: 17, textAlign: "center", marginTop: 6 },
});
