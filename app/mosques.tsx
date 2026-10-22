import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { trpc } from "@/lib/trpc";

const PAGE_SIZE = 100;
const COLORS = {
  navy: "#102D4A",
  ink: "#122033",
  muted: "#788595",
  line: "#E7EDF2",
  canvas: "#F7F9FA",
  white: "#FFFFFF",
  teal: "#5AAFA7",
  green: "#2B9A76",
  greenSoft: "#E5F7F0",
};

export default function OfficialMosquesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ language?: string }>();
  const language = params.language === "en" ? "en" : "ar";
  const isArabic = language === "ar";
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const nextSearch = searchInput.trim();
      setSearch(nextSearch);
      setOffset(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = trpc.officialMosques.list.useQuery(
    { search: search || undefined, limit: PAGE_SIZE, offset },
    { staleTime: 60_000, retry: 2 },
  );
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const firstResult = total === 0 ? 0 : offset + 1;
  const lastResult = Math.min(offset + items.length, total);
  const numberLocale = isArabic ? "ar-JO" : "en-US";
  const rowDirection: "row" | "row-reverse" = isArabic ? "row-reverse" : "row";
  const contentAlignment: "flex-start" | "flex-end" = isArabic ? "flex-end" : "flex-start";

  const openMap = async (mapUrl: string | null, latitude: number | null, longitude: number | null) => {
    const officialUrl = mapUrl?.trim();
    const url = officialUrl && /^https:\/\//i.test(officialUrl)
      ? officialUrl
      : typeof latitude === "number" && Number.isFinite(latitude)
        && typeof longitude === "number" && Number.isFinite(longitude)
        ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`
        : null;

    setMapError(null);
    if (!url) {
      setMapError(isArabic ? "لا يوجد رابط خريطة لهذا المسجد." : "No map location is available for this mosque.");
      return;
    }
    try {
      await Linking.openURL(url);
    } catch {
      setMapError(isArabic ? "تعذّر فتح الخريطة. تحقق من اتصال الإنترنت وحاول مرة أخرى." : "Could not open the map. Check your connection and try again.");
    }
  };

  const emptyState = query.isPending ? (
    <View style={styles.messageState}>
      <ActivityIndicator color={COLORS.green} />
      <Text style={styles.messageText}>{isArabic ? "جارٍ تحميل الجوامع…" : "Loading mosques…"}</Text>
    </View>
  ) : query.isError ? (
    <View style={styles.messageState}>
      <Ionicons name="cloud-offline-outline" size={28} color={COLORS.muted} />
      <Text style={styles.messageText}>{isArabic ? "تعذر تحميل الدليل الآن." : "The directory could not be loaded."}</Text>
      <Pressable accessibilityRole="button" onPress={() => void query.refetch()} style={styles.retryButton}>
        <Text style={styles.retryText}>{isArabic ? "إعادة المحاولة" : "Try again"}</Text>
      </Pressable>
    </View>
  ) : (
    <View style={styles.messageState}>
      <MaterialCommunityIcons name="mosque" size={30} color={COLORS.muted} />
      <Text style={styles.messageText}>{isArabic ? "لا توجد نتائج مطابقة." : "No matching mosques."}</Text>
    </View>
  );

  const footer = total > 0 ? (
    <View style={[styles.pagination, { flexDirection: rowDirection }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: offset === 0 || query.isFetching }}
        disabled={offset === 0 || query.isFetching}
        onPress={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
        style={[styles.pageButton, { flexDirection: rowDirection }, (offset === 0 || query.isFetching) && styles.pageButtonDisabled]}
      >
        <Ionicons name={isArabic ? "chevron-forward" : "chevron-back"} size={17} color={offset === 0 ? "#AAB5BF" : COLORS.navy} />
        <Text style={[styles.pageButtonText, offset === 0 && styles.pageButtonTextDisabled]}>{isArabic ? "السابق" : "Previous"}</Text>
      </Pressable>
      <Text style={styles.pageIndicator}>
        {page.toLocaleString(numberLocale)} / {pageCount.toLocaleString(numberLocale)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: offset + PAGE_SIZE >= total || query.isFetching }}
        disabled={offset + PAGE_SIZE >= total || query.isFetching}
        onPress={() => setOffset((current) => current + PAGE_SIZE)}
        style={[styles.pageButton, { flexDirection: rowDirection }, (offset + PAGE_SIZE >= total || query.isFetching) && styles.pageButtonDisabled]}
      >
        <Text style={[styles.pageButtonText, (offset + PAGE_SIZE >= total || query.isFetching) && styles.pageButtonTextDisabled]}>{isArabic ? "التالي" : "Next"}</Text>
        <Ionicons name={isArabic ? "chevron-back" : "chevron-forward"} size={17} color={offset + PAGE_SIZE >= total ? "#AAB5BF" : COLORS.navy} />
      </Pressable>
    </View>
  ) : null;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={[styles.header, { flexDirection: rowDirection }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={isArabic ? "رجوع" : "Go back"} onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name={isArabic ? "arrow-forward" : "arrow-back"} size={21} color={COLORS.navy} />
        </Pressable>
        <View style={[styles.headerCopy, { alignItems: contentAlignment }]}>
          <Text style={[styles.title, isArabic ? styles.rtl : styles.ltr]}>{isArabic ? "دليل الجوامع الرسمي" : "Official Mosque Directory"}</Text>
          <Text style={[styles.subtitle, isArabic ? styles.rtl : styles.ltr]}>
            {isArabic ? "ابحث في المساجد المتاحة وتصفّحها حسب المنطقة." : "Search the available mosque records by location."}
          </Text>
        </View>
        <View style={styles.headerIcon}>
          <MaterialCommunityIcons name="mosque" size={23} color={COLORS.green} />
        </View>
      </View>

      <View style={[styles.searchBox, { flexDirection: rowDirection }]}>
        <Ionicons name="search-outline" size={19} color={COLORS.muted} />
        <TextInput
          accessibilityLabel={isArabic ? "البحث في دليل الجوامع" : "Search the mosque directory"}
          value={searchInput}
          onChangeText={setSearchInput}
          placeholder={isArabic ? "اسم المسجد أو المحافظة أو المديرية أو المنطقة" : "Name, governorate, directorate, or locality"}
          placeholderTextColor="#9DA8B3"
          style={[styles.searchInput, isArabic ? styles.rtl : styles.ltr]}
          textAlign={isArabic ? "right" : "left"}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={100}
          onSubmitEditing={() => {
            setSearch(searchInput.trim());
            setOffset(0);
          }}
        />
        {searchInput.length > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel={isArabic ? "مسح البحث" : "Clear search"} onPress={() => setSearchInput("")}>
            <Ionicons name="close-circle" size={19} color={COLORS.muted} />
          </Pressable>
        )}
      </View>

      <View style={[styles.resultsSummary, { flexDirection: rowDirection }]}>
        <Text style={[styles.resultsLabel, isArabic ? styles.rtl : styles.ltr]}>
          {query.isPending && !query.data
            ? (isArabic ? "جارٍ جلب العدد…" : "Loading count…")
            : isArabic
              ? `${total.toLocaleString(numberLocale)} مسجد متاح`
              : `${total.toLocaleString(numberLocale)} mosques available`}
        </Text>
        {total > 0 && (
          <Text style={styles.rangeLabel}>
            {isArabic
              ? `${firstResult.toLocaleString(numberLocale)}–${lastResult.toLocaleString(numberLocale)} من ${total.toLocaleString(numberLocale)}`
              : `${firstResult.toLocaleString(numberLocale)}–${lastResult.toLocaleString(numberLocale)} of ${total.toLocaleString(numberLocale)}`}
          </Text>
        )}
      </View>

      <View style={[styles.coverageNote, { flexDirection: rowDirection }]}>
        <Ionicons name="information-circle-outline" size={16} color={COLORS.muted} />
        <Text style={[styles.coverageNoteText, isArabic ? styles.rtl : styles.ltr]}>
          {isArabic
            ? "سجلات رسمية متاحة وليست حصرًا وطنيًا؛ بعض السجلات بلا موقع خريطة."
            : "Available official records, not a verified national census; some lack map data."}
        </Text>
      </View>

      {mapError && (
        <Pressable accessibilityRole="button" accessibilityLabel={isArabic ? "إغلاق التنبيه" : "Dismiss message"} onPress={() => setMapError(null)} style={[styles.mapError, { flexDirection: rowDirection }]}>
          <Text style={[styles.mapErrorText, isArabic ? styles.rtl : styles.ltr]}>{mapError}</Text>
          <Ionicons name="close-circle-outline" size={17} color={COLORS.muted} />
        </Pressable>
      )}

      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => {
          const location = [item.locality, item.directorate, item.governorate]
            .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
            .join(isArabic ? "، " : ", ");
          const hasCoordinates = typeof item.latitude === "number" && Number.isFinite(item.latitude)
            && typeof item.longitude === "number" && Number.isFinite(item.longitude);
          const hasOfficialMapUrl = Boolean(item.mapUrl?.trim() && /^https:\/\//i.test(item.mapUrl.trim()));
          const hasMapLink = hasOfficialMapUrl || hasCoordinates;

          return (
            <View style={styles.mosqueCard}>
              <View style={[styles.cardTop, { flexDirection: rowDirection }]}>
                <View style={styles.mosqueIcon}>
                  <MaterialCommunityIcons name="mosque" size={21} color={COLORS.green} />
                </View>
                <View style={[styles.cardCopy, { alignItems: contentAlignment }]}>
                  <Text style={[styles.mosqueName, isArabic ? styles.rtl : styles.ltr]}>{item.name}</Text>
                  {!!location && <Text style={[styles.locationText, isArabic ? styles.rtl : styles.ltr]}>{location}</Text>}
                  <Text style={[styles.sourceText, isArabic ? styles.rtl : styles.ltr]}>
                    {isArabic ? `سجل رسمي · بيانات ${item.dataYear}` : `Official record · ${item.dataYear} data`}
                  </Text>
                </View>
              </View>
              {hasMapLink && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void openMap(item.mapUrl, item.latitude, item.longitude)}
                  style={[styles.mapButton, { flexDirection: rowDirection, alignSelf: contentAlignment }]}
                >
                  <Ionicons name="navigate-outline" size={16} color={COLORS.green} />
                  <Text style={[styles.mapButtonText, isArabic ? styles.rtl : styles.ltr]}>{isArabic ? "افتح الموقع على الخريطة" : "Open location in maps"}</Text>
                </Pressable>
              )}
            </View>
          );
        }}
        ListEmptyComponent={emptyState}
        ListFooterComponent={footer}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.canvas },
  header: { alignItems: "center", paddingHorizontal: 18, paddingTop: 10, paddingBottom: 14, gap: 10 },
  backButton: { width: 42, height: 42, borderRadius: 14, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1 },
  title: { color: COLORS.navy, fontSize: 20, fontWeight: "900" },
  subtitle: { color: COLORS.muted, fontSize: 11, marginTop: 4, lineHeight: 17 },
  headerIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: COLORS.greenSoft, alignItems: "center", justifyContent: "center" },
  rtl: { writingDirection: "rtl", textAlign: "right" },
  ltr: { writingDirection: "ltr", textAlign: "left" },
  searchBox: { minHeight: 50, marginHorizontal: 18, marginBottom: 8, borderRadius: 15, backgroundColor: COLORS.white, borderWidth: 1, borderColor: "#D9E5EA", alignItems: "center", paddingHorizontal: 14, gap: 9 },
  searchInput: { flex: 1, color: COLORS.ink, fontSize: 13, paddingVertical: 8 },
  resultsSummary: { alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 10, gap: 8 },
  resultsLabel: { color: COLORS.navy, fontSize: 12, fontWeight: "900", flex: 1 },
  rangeLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "700" },
  mapError: { alignItems: "center", gap: 8, marginHorizontal: 18, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: "#FFF4E7", borderWidth: 1, borderColor: "#F1D9B8" },
  mapErrorText: { flex: 1, color: COLORS.navy, fontSize: 11, lineHeight: 17 },
  coverageNote: { alignItems: "center", gap: 6, marginHorizontal: 18, marginBottom: 6, paddingHorizontal: 2 },
  coverageNoteText: { flex: 1, color: COLORS.muted, fontSize: 10, lineHeight: 15 },
  listContent: { paddingHorizontal: 16, paddingBottom: 28, flexGrow: 1 },
  mosqueCard: { backgroundColor: COLORS.white, borderRadius: 17, padding: 14, marginBottom: 9, borderWidth: 1, borderColor: COLORS.line },
  cardTop: { alignItems: "flex-start", gap: 10 },
  mosqueIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: COLORS.greenSoft, alignItems: "center", justifyContent: "center" },
  cardCopy: { flex: 1 },
  mosqueName: { alignSelf: "stretch", color: COLORS.ink, fontSize: 14, fontWeight: "900", lineHeight: 21 },
  locationText: { alignSelf: "stretch", color: COLORS.muted, fontSize: 11, lineHeight: 18, marginTop: 3 },
  sourceText: { alignSelf: "stretch", color: COLORS.green, fontSize: 10, fontWeight: "700", marginTop: 5 },
  mapButton: { alignItems: "center", justifyContent: "center", gap: 6, marginTop: 12, minHeight: 36, paddingHorizontal: 12, borderRadius: 11, backgroundColor: "#F2FCF8", borderWidth: 1, borderColor: "#D7EEE4" },
  mapButtonText: { color: COLORS.green, fontSize: 11, fontWeight: "800" },
  messageState: { alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 42 },
  messageText: { color: COLORS.muted, fontSize: 13, textAlign: "center" },
  retryButton: { minHeight: 40, paddingHorizontal: 18, borderRadius: 12, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center" },
  retryText: { color: COLORS.white, fontSize: 12, fontWeight: "800" },
  pagination: { alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 14, paddingHorizontal: 2 },
  pageButton: { minHeight: 42, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 12, borderRadius: 12, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line },
  pageButtonDisabled: { backgroundColor: "#F1F4F5" },
  pageButtonText: { color: COLORS.navy, fontSize: 11, fontWeight: "800" },
  pageButtonTextDisabled: { color: "#AAB5BF" },
  pageIndicator: { color: COLORS.muted, fontSize: 11, fontWeight: "800" },
});
