import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useMemo, useState } from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { trpc } from "@/lib/trpc";

const COLORS = {
  navy: "#102D4A",
  navySoft: "#173B5E",
  ink: "#122033",
  muted: "#788595",
  line: "#E7EDF2",
  canvas: "#F7F9FA",
  white: "#FFFFFF",
  teal: "#5AAFA7",
  gold: "#F3B44B",
  goldSoft: "#FFF2D8",
  green: "#2B9A76",
  red: "#D46C66",
};

type Place = {
  id: string;
  name: string;
  type: string;
  distance: string;
  drive: string;
  open: boolean;
  ablution: boolean;
  parking: boolean;
  lat: number;
  lng: number;
};

const PLACES: Place[] = [
  {
    id: "1",
    name: "مسجد الملك عبدالله",
    type: "مسجد",
    distance: "650 م",
    drive: "8 د",
    open: true,
    ablution: true,
    parking: true,
    lat: 31.9632,
    lng: 35.9106,
  },
  {
    id: "2",
    name: "مصلى محطة الواحة",
    type: "مصلى محطة وقود",
    distance: "1.1 كم",
    drive: "10 د",
    open: true,
    ablution: true,
    parking: true,
    lat: 31.9721,
    lng: 35.9162,
  },
  {
    id: "3",
    name: "مصلى تاج مول",
    type: "مصلى مول",
    distance: "1.8 كم",
    drive: "13 د",
    open: false,
    ablution: true,
    parking: true,
    lat: 31.986,
    lng: 35.897,
  },
];

const OSM_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><style>html,body,#map{height:100%;margin:0;background:#e3efef} .leaflet-control-attribution{font-size:8px}</style></head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>const map=L.map('map',{zoomControl:false}).setView([31.975,35.91],13);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);const points=[[31.9632,35.9106,'مسجد الملك عبدالله'],[31.9721,35.9162,'مصلى محطة الواحة'],[31.986,35.897,'مصلى تاج مول']];points.forEach(([lat,lng,name])=>L.marker([lat,lng]).addTo(map).bindPopup(name));</script></body></html>`;

export default function HomeScreen() {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("الأقرب أولًا");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [language, setLanguage] = useState<"ar" | "en">("ar");
  const placesQuery = trpc.places.list.useQuery(undefined, { staleTime: 60_000 });

  const apiPlaces: Place[] = (placesQuery.data ?? []).map((place) => ({
    id: String(place.id),
    name: place.name,
    type: place.type === "mosque" ? "مسجد" : place.type === "mall" ? "مصلى مول" : place.type === "station" ? "مصلى محطة" : "مصلى",
    distance: "—",
    drive: "—",
    open: true,
    ablution: place.hasAblution,
    parking: place.hasParking,
    lat: place.latitude,
    lng: place.longitude,
  }));
  const sourcePlaces = apiPlaces.length > 0 ? apiPlaces : PLACES;

  const filteredPlaces = useMemo(() => {
    let result = sourcePlaces.filter((place) =>
      place.name.toLowerCase().includes(query.trim().toLowerCase()),
    );
    if (activeFilter === "مفتوح الآن") result = result.filter((place) => place.open);
    if (activeFilter === "يوجد وضوء") result = result.filter((place) => place.ablution);
    if (activeFilter === "يوجد موقف") result = result.filter((place) => place.parking);
    if (activeFilter === "المفضلة") result = result.filter((place) => favorites.includes(place.id));
    return result;
  }, [activeFilter, favorites, query, sourcePlaces]);

  const openMaps = (place: Place) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
    Linking.openURL(url);
  };

  const sharePlace = async (place: Place) => {
    await Share.share({ message: `${place.name} — ${place.distance}، ${place.drive} بالسيارة\nhttps://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}` });
  };

  const toggleFavorite = (id: string) => {
    setFavorites((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const requestLocation = async () => {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== "granted") {
      Alert.alert("نحتاج موقعك", "يمكنك استخدام البحث اليدوي بدلًا من ذلك، أو تفعيل الموقع من إعدادات الهاتف.");
      return;
    }
    setLocationEnabled(true);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.logoMark}>
              <MaterialCommunityIcons name="mosque-outline" size={22} color={COLORS.white} />
            </View>
            <Text style={styles.brand}>مصلاي</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable onPress={() => setLanguage(language === "ar" ? "en" : "ar")} style={styles.languageButton}>
              <Text style={styles.languageText}>{language === "ar" ? "EN" : "ع"}</Text>
            </Pressable>
            <Pressable onPress={() => Alert.alert("مصلاي", "سيتم تفعيل الحسابات وإضافة الأماكن في النسخة القادمة.")} style={styles.profileButton}>
              <Text style={styles.profileLetter}>م</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.greetingBlock}>
          <Text style={styles.eyebrow}>صباح الخير، محمد ✦</Text>
          <Text style={styles.title}>وين ناوي تصلي اليوم؟</Text>
        </View>

        <Pressable style={[styles.locationButton, locationEnabled && styles.locationButtonActive]} onPress={requestLocation}>
          <Ionicons name={locationEnabled ? "checkmark-circle" : "locate-outline"} size={20} color={locationEnabled ? COLORS.green : COLORS.navy} />
          <Text style={styles.locationButtonText}>{locationEnabled ? "تم تحديد موقعك" : "استخدم موقعي"}</Text>
        </Pressable>

        <View style={styles.prayerCard}>
          <View style={styles.prayerTop}>
            <View>
              <Text style={styles.prayerLabel}>الصلاة القادمة ✦</Text>
              <Text style={styles.prayerName}>صلاة العصر</Text>
              <Text style={styles.prayerTime}>اليوم، 04:18 م</Text>
            </View>
            <View style={styles.countdownWrap}>
              <Text style={styles.countdown}>00:26:14</Text>
              <Text style={styles.countdownCaption}>متبقي</Text>
            </View>
          </View>
          <View style={styles.progressTrack}><View style={styles.progressFill} /></View>
          <View style={styles.prayerFooter}>
            <Text style={styles.nextHint}>لا تفوّت الصلاة أينما كنت</Text>
            <Pressable onPress={() => Alert.alert("مواقيت الصلاة", "سيتم عرض المواقيت اليومية بالتفصيل قريبًا.")}>
              <Text style={styles.prayerLink}>مواقيت اليوم <Ionicons name="arrow-back" size={12} color={COLORS.gold} /></Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionEyebrow}>دليلك في الطريق</Text>
            <Text style={styles.sectionTitle}>أماكن الصلاة القريبة منك</Text>
          </View>
          <Pressable onPress={() => Alert.alert("القائمة", "أنت تشاهد جميع الأماكن القريبة.")}>
            <Text style={styles.seeAll}>عرض القائمة</Text>
          </Pressable>
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={19} color={COLORS.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="ابحث عن مسجد، مصلى أو منطقة..."
            placeholderTextColor="#9DA8B3"
            style={styles.searchInput}
            textAlign="right"
          />
          <View style={styles.shortcut}><Text style={styles.shortcutText}>⌘ K</Text></View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {["المزيد", "مفتوح الآن", "يوجد وضوء", "يوجد موقف", "المفضلة"].map((filter) => {
            const active = activeFilter === filter;
            return (
              <Pressable key={filter} onPress={() => setActiveFilter(filter)} style={[styles.filterChip, active && styles.filterChipActive]}>
                {filter === "مفتوح الآن" && <View style={[styles.dot, { backgroundColor: active ? COLORS.white : COLORS.green }]} />}
                {filter === "يوجد وضوء" && <Ionicons name="water-outline" size={15} color={active ? COLORS.white : COLORS.teal} />}
                {filter === "يوجد موقف" && <Ionicons name="car-outline" size={15} color={active ? COLORS.white : COLORS.muted} />}
                {filter === "المفضلة" && <Ionicons name="heart-outline" size={15} color={active ? COLORS.white : COLORS.red} />}
                <Text style={[styles.filterText, active && styles.filterTextActive]}>{filter}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.mapCard}>
          {Platform.OS !== "web" ? <WebView source={{ html: OSM_HTML }} style={styles.nativeMap} originWhitelist={["*"]} javaScriptEnabled /> : null}
          <View style={styles.mapHeader}><Text style={styles.mapBadge}>موقعك الآن</Text><Text style={styles.mapProvider}>OpenStreetMap</Text></View>
          {Platform.OS === "web" ? <><View style={[styles.mapRoad, styles.roadOne]} /><View style={[styles.mapRoad, styles.roadTwo]} /><View style={[styles.mapRoad, styles.roadThree]} /><View style={styles.mapWater} /><View style={[styles.mapPin, { top: 52, right: 78 }]}><Ionicons name="location" size={28} color={COLORS.navy} /><View style={styles.pinNumber}><Text style={styles.pinNumberText}>1</Text></View></View><View style={[styles.mapPin, { top: 101, right: 178 }]}><Ionicons name="location" size={28} color={COLORS.teal} /><View style={styles.pinNumber}><Text style={styles.pinNumberText}>2</Text></View></View><View style={[styles.mapPin, { top: 153, right: 112 }]}><Ionicons name="location" size={28} color={COLORS.gold} /><View style={styles.pinNumber}><Text style={styles.pinNumberText}>3</Text></View></View><View style={styles.currentLocation}><View style={styles.currentDot} /></View></> : null}
          <Pressable style={styles.mapControl} onPress={() => setLocationEnabled(true)}><Ionicons name="locate" size={19} color={COLORS.navy} /></Pressable>
        </View>

        <View style={styles.listHeader}><Text style={styles.nearbyCount}>{filteredPlaces.length} أماكن قريبة</Text><Pressable onPress={() => setActiveFilter("الأقرب أولًا")}><Text style={styles.sortText}>{activeFilter === "الأقرب أولًا" ? "الأقرب أولًا" : "إلغاء الفلتر"}</Text></Pressable></View>
        {filteredPlaces.map((place) => (
          <View key={place.id} style={styles.placeCard}>
            <View style={styles.placeMain}>
              <View style={styles.placeIcon}><MaterialCommunityIcons name={place.type === "مسجد" ? "mosque" : "home-city-outline"} size={22} color={COLORS.navy} /></View>
              <View style={styles.placeInfo}>
                <View style={styles.nameRow}><Text style={styles.placeName}>{place.name}</Text><View style={[styles.openPill, !place.open && styles.closedPill]}><Text style={[styles.openText, !place.open && styles.closedText]}>{place.open ? "مفتوح" : "مغلق"}</Text></View></View>
                <Text style={styles.placeMeta}>{place.type} · {place.distance} · {place.drive} بالسيارة</Text>
                <View style={styles.amenities}><Text style={styles.metaTime}>منذ 8 دقائق</Text>{place.ablution && <Text style={styles.amenity}><Ionicons name="water" size={13} color={COLORS.teal} /> وضوء</Text>}{place.parking && <Text style={styles.amenity}><Ionicons name="car" size={13} color={COLORS.muted} /> موقف</Text>}</View>
              </View>
            </View>
            <View style={styles.placeActions}>
              <Pressable onPress={() => toggleFavorite(place.id)} style={styles.iconAction}><Ionicons name={favorites.includes(place.id) ? "heart" : "heart-outline"} size={18} color={favorites.includes(place.id) ? COLORS.red : COLORS.muted} /></Pressable>
              <Pressable onPress={() => sharePlace(place)} style={styles.iconAction}><Ionicons name="share-social-outline" size={18} color={COLORS.muted} /></Pressable>
              <Pressable onPress={() => openMaps(place)} style={styles.goButton}><Ionicons name="navigate" size={16} color={COLORS.white} /><Text style={styles.goText}>اذهب</Text></Pressable>
            </View>
          </View>
        ))}

        <Pressable style={styles.addPlaceButton} onPress={() => Alert.alert("أضف مكانًا", "تسجيل الدخول سيكون مطلوبًا عند إضافة مكان جديد.")}><Ionicons name="add" size={19} color={COLORS.navy} /><Text style={styles.addPlaceText}>أضف مكانًا تعرفه</Text></Pressable>
        <View style={styles.bottomSpace} />
      </ScrollView>
      <View style={styles.tabBar}>
        <Pressable style={styles.tabItem}><Ionicons name="home" size={22} color={COLORS.navy} /><Text style={[styles.tabText, styles.tabActive]}>الرئيسية</Text></Pressable>
        <Pressable style={styles.tabItem} onPress={() => Alert.alert("استكشف", "استكشاف الأماكن حسب المنطقة سيضاف قريبًا.")}><Ionicons name="compass-outline" size={22} color={COLORS.muted} /><Text style={styles.tabText}>استكشف</Text></Pressable>
        <Pressable style={styles.tabItem} onPress={() => Alert.alert("القبلة", "ميزة اتجاه القبلة ستكون متاحة في النسخة التالية.")}><MaterialCommunityIcons name="compass-rose" size={22} color={COLORS.muted} /><Text style={styles.tabText}>القبلة</Text></Pressable>
        <Pressable style={styles.tabItem} onPress={() => Alert.alert("حسابي", "يمكنك تسجيل الدخول عند إضافة مكان جديد.")}><Ionicons name="person-outline" size={22} color={COLORS.muted} /><Text style={styles.tabText}>حسابي</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.canvas },
  scroll: { paddingHorizontal: 18, paddingBottom: 88 },
  header: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingTop: 8, paddingBottom: 23 },
  brandRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9 },
  logoMark: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center" },
  brand: { color: COLORS.navy, fontSize: 20, fontWeight: "800" },
  headerActions: { flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  languageButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.line },
  languageText: { fontSize: 11, fontWeight: "800", color: COLORS.navy },
  profileButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.goldSoft, alignItems: "center", justifyContent: "center" },
  profileLetter: { color: COLORS.navy, fontWeight: "800", fontSize: 15 },
  greetingBlock: { alignItems: "flex-end", marginBottom: 15 },
  eyebrow: { color: COLORS.muted, fontSize: 12, marginBottom: 7 },
  title: { color: COLORS.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.4 },
  locationButton: { alignSelf: "flex-end", flexDirection: "row-reverse", alignItems: "center", gap: 7, paddingHorizontal: 15, height: 40, borderRadius: 14, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, marginBottom: 15 },
  locationButtonActive: { borderColor: "#B9E4D4", backgroundColor: "#F2FCF8" },
  locationButtonText: { color: COLORS.navy, fontSize: 13, fontWeight: "700" },
  prayerCard: { backgroundColor: COLORS.navy, borderRadius: 22, padding: 19, minHeight: 160, marginBottom: 27, shadowColor: COLORS.navy, shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 4 },
  prayerTop: { flexDirection: "row-reverse", justifyContent: "space-between" },
  prayerLabel: { color: "#88A9C3", fontSize: 11, marginBottom: 7, textAlign: "right" },
  prayerName: { color: COLORS.white, fontSize: 22, fontWeight: "800", textAlign: "right" },
  prayerTime: { color: "#B6CAD9", fontSize: 11, marginTop: 4, textAlign: "right" },
  countdownWrap: { alignItems: "flex-start", paddingTop: 12 },
  countdown: { color: COLORS.white, fontSize: 24, fontWeight: "800", letterSpacing: 0.5 },
  countdownCaption: { color: "#9FB6C7", fontSize: 10, marginTop: 2 },
  progressTrack: { height: 4, backgroundColor: "#2C4C68", borderRadius: 4, marginTop: 19, overflow: "hidden" },
  progressFill: { height: 4, width: "44%", backgroundColor: COLORS.gold, borderRadius: 4 },
  prayerFooter: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  nextHint: { color: "#8BA4B8", fontSize: 10 },
  prayerLink: { color: COLORS.gold, fontSize: 11, fontWeight: "700" },
  sectionHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 13 },
  sectionEyebrow: { color: COLORS.teal, fontSize: 11, textAlign: "right", marginBottom: 4, fontWeight: "700" },
  sectionTitle: { color: COLORS.ink, fontSize: 19, fontWeight: "800", textAlign: "right" },
  seeAll: { color: COLORS.navy, fontSize: 12, fontWeight: "700", paddingBottom: 2 },
  searchBox: { height: 49, borderRadius: 15, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, flexDirection: "row-reverse", alignItems: "center", paddingHorizontal: 13, gap: 9 },
  searchInput: { flex: 1, color: COLORS.ink, fontSize: 13, paddingVertical: 0 },
  shortcut: { backgroundColor: COLORS.canvas, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 6 },
  shortcutText: { color: COLORS.muted, fontSize: 10 },
  filters: { flexDirection: "row-reverse", gap: 7, paddingVertical: 12 },
  filterChip: { flexDirection: "row-reverse", alignItems: "center", gap: 5, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 10, height: 32 },
  filterChipActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  filterText: { color: COLORS.muted, fontSize: 11, fontWeight: "700" },
  filterTextActive: { color: COLORS.white },
  dot: { width: 6, height: 6, borderRadius: 3 },
  mapCard: { height: 190, borderRadius: 19, overflow: "hidden", backgroundColor: "#E3EFEF", position: "relative", borderWidth: 1, borderColor: "#D9E5E7", marginBottom: 16 },
  nativeMap: StyleSheet.absoluteFill,
  mapHeader: { position: "absolute", zIndex: 3, top: 10, left: 11, right: 11, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  mapBadge: { backgroundColor: "rgba(255,255,255,0.9)", color: COLORS.green, fontSize: 10, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 },
  mapProvider: { color: "#6A8A8F", fontSize: 9, fontWeight: "700" },
  mapRoad: { position: "absolute", height: 2, backgroundColor: "rgba(255,255,255,0.95)", transform: [{ rotate: "28deg" }] },
  roadOne: { width: "120%", top: 90, left: -20 },
  roadTwo: { width: "115%", top: 145, left: 20, transform: [{ rotate: "-34deg" }] },
  roadThree: { width: "85%", top: 64, left: 88, transform: [{ rotate: "80deg" }] },
  mapWater: { position: "absolute", width: 145, height: 38, borderRadius: 50, backgroundColor: "rgba(131, 202, 207, 0.42)", bottom: 20, left: -20, transform: [{ rotate: "-18deg" }] },
  mapPin: { position: "absolute", alignItems: "center" },
  pinNumber: { position: "absolute", top: 3, width: 15, height: 15, borderRadius: 8, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center" },
  pinNumberText: { color: COLORS.navy, fontSize: 9, fontWeight: "900" },
  currentLocation: { position: "absolute", top: 84, left: 83, width: 22, height: 22, borderRadius: 12, backgroundColor: "rgba(67, 151, 255, 0.18)", alignItems: "center", justifyContent: "center" },
  currentDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#4A94F5", borderWidth: 2, borderColor: COLORS.white },
  mapControl: { position: "absolute", bottom: 10, left: 10, width: 34, height: 34, borderRadius: 10, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center" },
  listHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", marginBottom: 9 },
  nearbyCount: { color: COLORS.ink, fontSize: 13, fontWeight: "800" },
  sortText: { color: COLORS.muted, fontSize: 11 },
  placeCard: { backgroundColor: COLORS.white, borderRadius: 16, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: COLORS.line },
  placeMain: { flexDirection: "row-reverse", alignItems: "flex-start" },
  placeIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: "#EEF5F8", alignItems: "center", justifyContent: "center", marginLeft: 10 },
  placeInfo: { flex: 1 },
  nameRow: { flexDirection: "row-reverse", alignItems: "center", gap: 7, marginBottom: 5 },
  placeName: { color: COLORS.ink, fontSize: 14, fontWeight: "800", textAlign: "right" },
  openPill: { backgroundColor: "#E5F7F0", borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 },
  closedPill: { backgroundColor: "#FBEAE8" },
  openText: { color: COLORS.green, fontSize: 9, fontWeight: "800" },
  closedText: { color: COLORS.red },
  placeMeta: { color: COLORS.muted, fontSize: 10, textAlign: "right", marginBottom: 6 },
  amenities: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  metaTime: { color: "#A2ABB4", fontSize: 9 },
  amenity: { color: COLORS.muted, fontSize: 10 },
  placeActions: { borderTopWidth: 1, borderTopColor: "#F0F3F5", marginTop: 11, paddingTop: 9, flexDirection: "row-reverse", alignItems: "center", gap: 7 },
  iconAction: { width: 31, height: 31, borderRadius: 9, backgroundColor: COLORS.canvas, alignItems: "center", justifyContent: "center" },
  goButton: { marginRight: "auto", backgroundColor: COLORS.navy, borderRadius: 9, height: 31, paddingHorizontal: 11, flexDirection: "row-reverse", alignItems: "center", gap: 5 },
  goText: { color: COLORS.white, fontSize: 10, fontWeight: "800" },
  addPlaceButton: { height: 46, borderRadius: 13, borderWidth: 1, borderColor: "#D6E0E5", borderStyle: "dashed", alignItems: "center", justifyContent: "center", flexDirection: "row-reverse", gap: 7, marginTop: 2 },
  addPlaceText: { color: COLORS.navy, fontSize: 12, fontWeight: "800" },
  bottomSpace: { height: 12 },
  tabBar: { position: "absolute", bottom: 0, left: 0, right: 0, height: 73, backgroundColor: "rgba(255,255,255,0.98)", borderTopWidth: 1, borderTopColor: COLORS.line, flexDirection: "row-reverse", justifyContent: "space-around", alignItems: "center", paddingBottom: 8 },
  tabItem: { alignItems: "center", gap: 4, minWidth: 62 },
  tabText: { color: COLORS.muted, fontSize: 10, fontWeight: "700" },
  tabActive: { color: COLORS.navy },
});
