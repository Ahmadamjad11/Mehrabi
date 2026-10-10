import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { CalculationMethod, Coordinates, Madhab, PrayerTimes } from "adhan";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { Magnetometer } from "expo-sensors";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Image,
  Linking,
  Modal,
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
import { getApiBaseUrl, startOAuthLogin } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";

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
  mosqueGreen: "#2B9A76",
  musallaBlue: "#7C8EDB",
  musallaSoft: "#EEF0FF",
};

type Place = {
  id: string;
  name: string;
  type: string;
  distance: string;
  drive: string;
  distanceMeters: number;
  open: boolean | null;
  ablution: boolean;
  parking: boolean;
  women: boolean;
  lat: number;
  lng: number;
  status?: "approved" | "pending" | "rejected";
};

const formatDistance = (from: { lat: number; lng: number } | null, to: { lat: number; lng: number }) => {
  if (!from) return "حدد موقعك";
  const earthRadiusKm = 6371;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((from.lat * Math.PI) / 180) * Math.cos((to.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const distanceKm = earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)} م` : `${distanceKm.toFixed(1)} كم`;
};

const JORDAN_TIME_ZONE = "Asia/Amman";
const REMINDER_SETTINGS_KEY = "maslay.prayer-reminders.v1";
const REMINDER_IDS_KEY = "maslay.prayer-reminder-ids.v1";
const PLACES_CACHE_KEY = "maslay.places-cache.v1";
const PRAYER_REMINDER_CHANNEL = "prayer-reminders-v2";
const PRAYER_REMINDER_CATEGORY = "prayer_reminder";
const PRAYER_DONE_ACTION = "prayer_done";
const PRAYER_LATER_ACTION = "prayer_later";

if (Notifications.setNotificationHandler) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

const configurePrayerNotifications = async () => {
  if (Platform.OS === "web") return false;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) {
    const requested = await Notifications.requestPermissionsAsync();
    if (!requested.granted) return false;
  }
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(PRAYER_REMINDER_CHANNEL, {
      name: "تذكيرات الصلاة مع صوت",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      sound: "default",
    });
  }
  await Notifications.setNotificationCategoryAsync(PRAYER_REMINDER_CATEGORY, [
    // Foregrounding the app is required when it was killed; otherwise the
    // response listener cannot receive the action on Android.
    { identifier: PRAYER_DONE_ACTION, buttonTitle: "نعم، صليت", options: { opensAppToForeground: true } },
    { identifier: PRAYER_LATER_ACTION, buttonTitle: "ذكّرني بعد 10 دقائق", options: { opensAppToForeground: true } },
  ]);
  return true;
};

const clearPrayerReminderSchedule = async () => {
  // Also clear orphaned schedules from older builds/racing reschedules.
  await Notifications.cancelAllScheduledNotificationsAsync();
  const stored = await AsyncStorage.getItem(REMINDER_IDS_KEY);
  if (!stored) return;
  const ids = JSON.parse(stored) as string[];
  await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
  await AsyncStorage.removeItem(REMINDER_IDS_KEY);
};

const schedulePrayerReminders = async (minutesBefore: number, location: { lat: number; lng: number } | null) => {
  if (Platform.OS === "web") return;
  await clearPrayerReminderSchedule();
  const now = new Date();
  const ids: string[] = [];
  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const date = getJordanCalendarDate(new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000));
    date.setDate(date.getDate() + dayOffset);
    for (const [name, prayerTime] of getPrayerSchedule(date, location)) {
      const triggerDate = new Date(prayerTime.getTime() - minutesBefore * 60 * 1000);
      if (triggerDate <= now) continue;
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: "تذكير من مصلاي",
          body: `باقي ${minutesBefore} دقيقة على صلاة ${name}. هل صليت الصلاة السابقة؟`,
          categoryIdentifier: PRAYER_REMINDER_CATEGORY,
          data: { prayerName: name },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: triggerDate, channelId: PRAYER_REMINDER_CHANNEL },
      });
      ids.push(id);
    }
  }
  await AsyncStorage.setItem(REMINDER_IDS_KEY, JSON.stringify(ids));
};

const getJordanCalendarDate = (value: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JORDAN_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const getPart = (type: "year" | "month" | "day") => Number(parts.find((part) => part.type === type)?.value);
  // Use midday to avoid an edge case where timezone conversion crosses midnight
  // while adhan is constructing the day's solar calculations.
  return new Date(getPart("year"), getPart("month") - 1, getPart("day"), 12, 0, 0, 0);
};

const getPrayerSchedule = (now: Date, location: { lat: number; lng: number } | null) => {
  const params = CalculationMethod.MuslimWorldLeague();
  params.madhab = Madhab.Shafi;
  const jordanDate = getJordanCalendarDate(now);
  const times = new PrayerTimes(new Coordinates(location?.lat ?? 31.9539, location?.lng ?? 35.9106), jordanDate, params);
  return [
    ["الفجر", times.fajr],
    [jordanDate.getDay() === 5 ? "الجمعة" : "الظهر", times.dhuhr],
    ["العصر", times.asr],
    ["المغرب", times.maghrib],
    ["العشاء", times.isha],
  ] as const;
};

const formatClock = (date: Date, language: "ar" | "en") =>
  date.toLocaleTimeString(language === "ar" ? "ar-JO" : "en-US", { hour: "numeric", minute: "2-digit", timeZone: JORDAN_TIME_ZONE });

const localizePrayerName = (name: string, language: "ar" | "en") => {
  if (language === "ar") return name;
  return ({ الفجر: "Fajr", الظهر: "Dhuhr", الجمعة: "Jumu'ah", العصر: "Asr", المغرب: "Maghrib", العشاء: "Isha" } as Record<string, string>)[name] ?? name;
};

const formatCountdown = (target: Date, now: Date) => {
  const seconds = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const rest = (seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
};

const bearingToKaaba = (latitude: number, longitude: number) => {
  const targetLat = (21.4225 * Math.PI) / 180;
  const currentLat = (latitude * Math.PI) / 180;
  const deltaLong = ((39.8262 - longitude) * Math.PI) / 180;
  const bearing = (Math.atan2(Math.sin(deltaLong), Math.cos(currentLat) * Math.tan(targetLat) - Math.sin(currentLat) * Math.cos(deltaLong)) * 180) / Math.PI;
  return (bearing + 360) % 360;
};

const distanceToKaabaKm = (latitude: number, longitude: number) => {
  const earthRadiusKm = 6371;
  const lat1 = (latitude * Math.PI) / 180;
  const lat2 = (21.4225 * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((39.8262 - longitude) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const createOsmHtml = (places: Place[], userLocation: { lat: number; lng: number } | null) => {
  const points = JSON.stringify(places.map((place) => [place.lat, place.lng, place.name]));
  const center = userLocation ? `[${userLocation.lat},${userLocation.lng}]` : "[31.9539,35.9106]";
  const userMarker = userLocation ? `L.circleMarker([${userLocation.lat},${userLocation.lng}],{radius:8,color:'#4A94F5',fillColor:'#4A94F5',fillOpacity:.9}).addTo(map).bindPopup('موقعك الحالي');` : "";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><style>html,body,#map{height:100%;margin:0;background:#e3efef} .leaflet-control-attribution{font-size:8px}</style></head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>const map=L.map('map',{zoomControl:false}).setView(${center},13);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);const points=${points};points.forEach(([lat,lng,name])=>L.marker([lat,lng]).addTo(map).bindPopup(name));${userMarker}</script></body></html>`;
};

const createPickerHtml = (location: { lat: number; lng: number }) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>const map=L.map('map').setView([${location.lat},${location.lng}],16);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);let marker=L.marker([${location.lat},${location.lng}]).addTo(map);map.on('click',e=>{marker.setLatLng(e.latlng);window.ReactNativeWebView.postMessage(JSON.stringify({lat:e.latlng.lat,lng:e.latlng.lng}))});</script></body></html>`;

export default function HomeScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [placeOffset, setPlaceOffset] = useState(0);
  const [loadedApiPlaces, setLoadedApiPlaces] = useState<any[]>([]);
  const [usingCachedPlaces, setUsingCachedPlaces] = useState(false);
  const [activeFilter, setActiveFilter] = useState("nearest");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [language, setLanguage] = useState<"ar" | "en">("ar");
  const [now, setNow] = useState(() => new Date());
  const [compassHeading, setCompassHeading] = useState(0);
  const [headingReady, setHeadingReady] = useState(false);
  const [headingSource, setHeadingSource] = useState<"gps" | "sensor" | null>(null);
  const [headingAccuracy, setHeadingAccuracy] = useState<number | null>(null);
  const headingStreamRef = useRef(false);
  const [activeTab, setActiveTab] = useState<"home" | "explore" | "qibla" | "account">("home");
  const [addFormVisible, setAddFormVisible] = useState(false);
  const [reviewPlaceId, setReviewPlaceId] = useState<number | null>(null);
  const [reviewVisible, setReviewVisible] = useState(false);
  const [placeName, setPlaceName] = useState("");
  const [placeAddress, setPlaceAddress] = useState("");
  const [placeType, setPlaceType] = useState<"mosque" | "musalla">("mosque");
  const [addStep, setAddStep] = useState<1 | 2>(1);
  const [placeHours, setPlaceHours] = useState("");
  const [hasAblution, setHasAblution] = useState(false);
  const [hasWomenPrayer, setHasWomenPrayer] = useState(false);
  const [hasParking, setHasParking] = useState(false);
  const [buildingName, setBuildingName] = useState("");
  const [buildingFloor, setBuildingFloor] = useState("");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewRating, setReviewRating] = useState(5);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [emailAuthVisible, setEmailAuthVisible] = useState(false);
  const [emailAuthMode, setEmailAuthMode] = useState<"login" | "register" | "forgot">("login");
  const [emailAuthName, setEmailAuthName] = useState("");
  const [emailAuthEmail, setEmailAuthEmail] = useState("");
  const [emailAuthPassword, setEmailAuthPassword] = useState("");
  const [emailAuthBusy, setEmailAuthBusy] = useState(false);
  const [emailAuthError, setEmailAuthError] = useState<string | null>(null);
  const [emailAuthMessage, setEmailAuthMessage] = useState<string | null>(null);
  const [emailAuthCanResend, setEmailAuthCanResend] = useState(false);
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [reminderMinutes, setReminderMinutes] = useState<15 | 30 | 45>(30);
  const reminderSettingsLoadedRef = useRef(false);
  const reminderScheduleKeyRef = useRef<string | null>(null);
  const reminderSchedulingRef = useRef(false);
  const ui = language === "ar" ? {
    greeting: "صباح الخير ✦", title: "وين ناوي تصلي اليوم؟", useLocation: "استخدم موقعي", located: "تم تحديد موقعك",
    nextPrayer: "الصلاة القادمة ✦", today: "اليوم", remaining: "متبقي", prayerTimes: "مواقيت اليوم", guide: "دليلك في الطريق",
    nearby: "أماكن الصلاة القريبة منك", search: "ابحث عن مسجد أو مصلى أو منطقة...", mapLocation: "موقعك", all: "عرض القائمة", mosques: "المساجد", musallas: "المصليات", open: "مفتوح الآن", ablution: "وضوء", women: "مصلى النساء", nearest: "الأقرب أولًا", verified: "متحقق", unverified: "قيد المراجعة", unknownHours: "الأوقات غير معروفة",
    go: "اذهب", add: "أضف مكانًا تعرفه", home: "الرئيسية", explore: "استكشف", qibla: "القبلة", account: "حسابي", prayerPrefix: "صلاة", prayerHint: "لا تفوّت الصلاة أينما كنت", listTitle: "القائمة", listHint: "أنت تشاهد جميع الأماكن القريبة.", exploreTitle: "استكشف أماكن الصلاة", exploreHint: "ابحث وفلتر الأماكن حسب النوع والخدمات، والنتائج مرتبة من الأقرب.", accountTitle: "حسابي", accountHint: "سجّل الدخول لإضافة مكان وكتابة التقييمات.", login: "تسجيل الدخول", logout: "تسجيل الخروج", emailLogin: "الدخول بالبريد الإلكتروني", emailRegister: "إنشاء حساب بالبريد", email: "البريد الإلكتروني", password: "كلمة المرور", name: "الاسم", forgotPassword: "نسيت كلمة المرور؟", sendReset: "إرسال رابط الاستعادة", resendVerification: "إعادة إرسال رسالة التأكيد", createAccount: "إنشاء الحساب", haveAccount: "لديك حساب؟ تسجيل الدخول", backToLogin: "العودة لتسجيل الدخول", verifyHint: "افحص بريدك واضغط رابط التأكيد قبل تسجيل الدخول.", resetSent: "إذا كان البريد مسجلًا فستصلك رسالة الاستعادة قريبًا.", verifySent: "تم إنشاء الحساب. افحص بريدك لتأكيد الحساب.", admin: "فتح لوحة الإدارة", addTitle: "إضافة مكان جديد", selectLocation: "حدد موقع المكان", placeData: "بيانات المكان", pickerHint: "اضغط على الخريطة لوضع الدبوس بدقة، أو استخدم موقعك الحالي.", useCurrentLocation: "استخدم موقعي الحالي", locationCorrect: "الموقع صحيح، متابعة", editLocation: "تعديل الموقع", namePlaceholder: "اسم المسجد أو المصلى", addressPlaceholder: "العنوان أو المنطقة", hoursPlaceholder: "ساعات العمل أو غير معروفة", buildingPlaceholder: "اسم المبنى (اختياري)", floorPlaceholder: "الطابق (اختياري)", submit: "إرسال للمراجعة", submitting: "جاري الإرسال...", editPlace: "المكان", parking: "مواقف", reviewTitle: "أضف تقييمك", reviewPlaceholder: "اكتب تعليقًا (اختياري)", publishReview: "نشر التقييم", loadMore: "تحميل 20 مكانًا إضافيًا", nearbyCount: "أماكن قريبة",
  } : {
    greeting: "Good morning ✦", title: "Where will you pray today?", useLocation: "Use my location", located: "Location detected",
    nextPrayer: "Next prayer ✦", today: "Today", remaining: "remaining", prayerTimes: "Today's times", guide: "Your guide on the way",
    nearby: "Prayer places near you", search: "Search for a mosque, musalla or area...", mapLocation: "Your location", all: "View list", mosques: "Mosques", musallas: "Musallas", open: "Open now", ablution: "Ablution", women: "Women's prayer", nearest: "Nearest first", verified: "Verified", unverified: "Not verified", unknownHours: "Hours unknown",
    go: "Go", add: "Add a place you know", home: "Home", explore: "Explore", qibla: "Qibla", account: "Account", prayerPrefix: "Prayer", prayerHint: "Never miss a prayer", listTitle: "List", listHint: "You are viewing nearby places.", exploreTitle: "Explore prayer places", exploreHint: "Search and filter by type and services, sorted by distance.", accountTitle: "Account", accountHint: "Sign in to add a place or write a review.", login: "Sign in", logout: "Sign out", emailLogin: "Sign in with email", emailRegister: "Create account with email", email: "Email", password: "Password", name: "Name", forgotPassword: "Forgot password?", sendReset: "Send reset link", resendVerification: "Resend confirmation email", createAccount: "Create account", haveAccount: "Already have an account? Sign in", backToLogin: "Back to sign in", verifyHint: "Check your inbox and tap the confirmation link before signing in.", resetSent: "If this email is registered, you will receive a reset link shortly.", verifySent: "Account created. Check your inbox to confirm it.", admin: "Open admin dashboard", addTitle: "Add a new place", selectLocation: "Select location", placeData: "Place details", pickerHint: "Tap the map to place the pin accurately, or use your current location.", useCurrentLocation: "Use my current location", locationCorrect: "Location is correct, continue", editLocation: "Edit location", namePlaceholder: "Mosque or musalla name", addressPlaceholder: "Address or area", hoursPlaceholder: "Opening hours or unknown", buildingPlaceholder: "Building name (optional)", floorPlaceholder: "Floor (optional)", submit: "Submit for review", submitting: "Submitting...", editPlace: "Place", parking: "Parking", reviewTitle: "Add your review", reviewPlaceholder: "Write a comment (optional)", publishReview: "Publish review", loadMore: "Load 20 more places", nearbyCount: "nearby places",
  };
  const filterOptions = [
    { key: "nearest", label: ui.nearest },
    { key: "open", label: ui.open },
    { key: "ablution", label: ui.ablution },
    { key: "women", label: ui.women },
    { key: "favorites", label: language === "ar" ? "المفضلة" : "Favorites" },
  ];
  const serverPlaceFilters = {
    search: query.trim() || undefined,
    openNow: activeFilter === "open" ? true : undefined,
    hasAblution: activeFilter === "ablution" ? true : undefined,
    hasWomenPrayer: activeFilter === "women" ? true : undefined,
    hasParking: undefined,
    limit: 20,
    offset: placeOffset,
  };
  const placesQuery = trpc.places.list.useQuery(serverPlaceFilters, { staleTime: 60_000, retry: 2 });
  const meQuery = trpc.auth.me.useQuery();
  const logoutMutation = trpc.auth.logout.useMutation();
  const nearestPlaces = trpc.places.nearest.useMutation();
  const submitPlace = trpc.places.submit.useMutation({ onSuccess: () => { setSubmitError(null); setAddFormVisible(false); setAddStep(1); setPlaceName(""); setPlaceAddress(""); setPlaceHours(""); placesQuery.refetch(); }, onError: (error) => setSubmitError(language === "ar" ? `تعذر إرسال المكان: ${error.message}` : `Could not submit place: ${error.message}`) });
  const submitReview = trpc.places.review.useMutation({ onSuccess: () => { setReviewVisible(false); setReviewComment(""); } });

  const updatePrayerReminders = async (enabled: boolean, minutes = reminderMinutes) => {
    if (enabled) {
      const ready = await configurePrayerNotifications();
      if (!ready) {
        Alert.alert(language === "ar" ? "التنبيهات غير مفعّلة" : "Notifications are disabled", language === "ar" ? "اسمح للتطبيق بالتنبيهات من إعدادات الهاتف." : "Allow notifications in your phone settings.");
        return;
      }
    } else if (Platform.OS !== "web") {
      await clearPrayerReminderSchedule();
      reminderScheduleKeyRef.current = null;
    }
    setReminderMinutes(minutes as 15 | 30 | 45);
    setRemindersEnabled(enabled);
    await AsyncStorage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify({ enabled, minutes }));
  };

  useEffect(() => {
    if (Platform.OS === "web") return;
    let responseSubscription: Notifications.EventSubscription | undefined;
    void (async () => {
      const stored = await AsyncStorage.getItem(REMINDER_SETTINGS_KEY);
      const settings = stored ? JSON.parse(stored) as { enabled?: boolean; minutes?: 15 | 30 | 45 } : undefined;
      const enabled = settings?.enabled === true;
      const minutes = settings?.minutes === 15 || settings?.minutes === 45 ? settings.minutes : 30;
      setRemindersEnabled(enabled);
      setReminderMinutes(minutes);
      reminderSettingsLoadedRef.current = true;
    })();
    responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const id = response.notification.request.identifier;
      if (response.actionIdentifier === PRAYER_LATER_ACTION) {
        void Notifications.scheduleNotificationAsync({
          content: {
            title: "تذكير من مصلاي",
            body: "تذكيرك المؤجل للصلاة",
            categoryIdentifier: PRAYER_REMINDER_CATEGORY,
            data: { deferred: true },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(Date.now() + 10 * 60 * 1000),
            channelId: PRAYER_REMINDER_CHANNEL,
          },
        });
      }
      void Notifications.dismissNotificationAsync(id).catch(() => undefined);
    });
    return () => responseSubscription?.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS === "web" || !reminderSettingsLoadedRef.current) return;
    if (!remindersEnabled) return;
    const scheduleKey = `${reminderMinutes}`;
    if (reminderScheduleKeyRef.current === scheduleKey || reminderSchedulingRef.current) return;
    reminderSchedulingRef.current = true;
    void schedulePrayerReminders(reminderMinutes, userLocation)
      .then(() => {
        reminderScheduleKeyRef.current = scheduleKey;
      })
      .finally(() => {
        reminderSchedulingRef.current = false;
      });
  }, [remindersEnabled, reminderMinutes, userLocation]);

  useEffect(() => {
    // Reset the cursor and accumulated server pages when the search/filter key changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlaceOffset(0);
    setLoadedApiPlaces([]);
  }, [activeFilter, query]);

  useEffect(() => {
    if (activeFilter !== "nearest" || !userLocation) return;
    nearestPlaces.mutate({
      latitude: userLocation.lat,
      longitude: userLocation.lng,
      search: query.trim() || undefined,
      limit: 20,
      offset: placeOffset,
    });
    // Coordinates are sent only for this explicit nearest request and never persisted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilter, placeOffset, query, userLocation?.lat, userLocation?.lng]);

  useEffect(() => {
    if (activeFilter === "nearest" && userLocation) return;
    if (!placesQuery.data) return;
    // Synchronize the accumulated view with the latest server page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadedApiPlaces((current) => {
      if (placeOffset === 0) return placesQuery.data;
      const known = new Set(current.map((place) => place.id));
      return [...current, ...placesQuery.data.filter((place) => !known.has(place.id))];
    });
    void AsyncStorage.setItem(PLACES_CACHE_KEY, JSON.stringify(placesQuery.data));
    setUsingCachedPlaces(false);
  }, [activeFilter, placeOffset, placesQuery.data, userLocation]);

  useEffect(() => {
    void AsyncStorage.getItem(PLACES_CACHE_KEY).then((value) => {
      if (!value || loadedApiPlaces.length > 0 || placesQuery.data) return;
      try {
        const cached = JSON.parse(value) as any[];
        if (cached.length > 0) {
          setLoadedApiPlaces(cached);
          setUsingCachedPlaces(true);
        }
      } catch { /* ignore an invalid cache and continue with the network */ }
    });
  }, [loadedApiPlaces.length, placesQuery.data]);

  useEffect(() => {
    if (activeFilter !== "nearest" || !nearestPlaces.data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadedApiPlaces((current) => {
      if (placeOffset === 0) return nearestPlaces.data;
      const known = new Set(current.map((place) => place.id));
      return [...current, ...nearestPlaces.data.filter((place) => !known.has(place.id))];
    });
  }, [activeFilter, nearestPlaces.data, placeOffset]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void AsyncStorage.getItem("maslay:favorites").then((value) => {
      if (value) setFavorites(JSON.parse(value));
    });
  }, []);

  useEffect(() => {
    void AsyncStorage.setItem("maslay:favorites", JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    let watcher: Location.LocationSubscription | null = null;
    let cancelled = false;
    const refreshLocation = async () => {
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== "granted") return;
        const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!cancelled) {
          setUserLocation({ lat: current.coords.latitude, lng: current.coords.longitude });
          setLocationEnabled(true);
          setLocationError(null);
        }
      } catch {
        if (!cancelled) setLocationError(language === "ar" ? "تعذر تحديد الموقع" : "Unable to determine location");
      }
    };
    void refreshLocation();
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshLocation();
    });
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, distanceInterval: 100, timeInterval: 60_000 },
      (position) => {
        setUserLocation({ lat: position.coords.latitude, lng: position.coords.longitude });
        setLocationEnabled(true);
      },
    ).then((subscription) => { watcher = subscription; }).catch(() => undefined);
    return () => {
      cancelled = true;
      watcher?.remove();
      appStateSubscription.remove();
    };
  }, [language, locationEnabled]);

  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    let magnetometerSubscription: { remove: () => void } | null = null;
    if (activeTab !== "qibla") {
      headingStreamRef.current = false;
      return () => undefined;
    }
    headingStreamRef.current = false;
    const smoothHeading = (next: number) => {
      const normalized = (next + 360) % 360;
      setCompassHeading((previous) => {
        const delta = ((normalized - previous + 540) % 360) - 180;
        return (previous + delta * 0.28 + 360) % 360;
      });
      setHeadingReady(true);
    };
    void Magnetometer.requestPermissionsAsync().catch(() => undefined);
    Location.watchHeadingAsync((heading) => {
      // trueHeading is corrected for magnetic declination when available.
      const value = heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
      if (Number.isFinite(value)) {
        headingStreamRef.current = true;
        setHeadingSource("gps");
        setHeadingAccuracy(Number.isFinite(heading.accuracy) ? heading.accuracy : null);
        smoothHeading(value);
      }
    }).then((next) => { subscription = next; }).catch(() => {
      // Magnetometer fallback below handles devices without Location heading support.
    });
    Magnetometer.setUpdateInterval(120);
    magnetometerSubscription = Magnetometer.addListener(({ x, y }) => {
      if (headingStreamRef.current || !Number.isFinite(x) || !Number.isFinite(y)) return;
      // Expo's native axes point east/north; convert them to a clockwise heading.
      const heading = (Math.atan2(y, x) * 180) / Math.PI;
      setHeadingSource("sensor");
      setHeadingAccuracy(null);
      smoothHeading((360 - heading + 360) % 360);
    });
    return () => {
      subscription?.remove();
      magnetometerSubscription?.remove();
      headingStreamRef.current = false;
    };
  }, [activeTab, locationEnabled]);

  const prayerState = useMemo(() => {
    const today = getPrayerSchedule(now, userLocation);
    let next = today.find(([, time]) => time.getTime() > now.getTime());
    if (!next) {
      const tomorrow = getJordanCalendarDate(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      next = getPrayerSchedule(tomorrow, userLocation)[0];
    }
    return { name: next[0], time: next[1] };
  }, [now, userLocation]);

  const qiblaBearing = bearingToKaaba(userLocation?.lat ?? 31.9539, userLocation?.lng ?? 35.9106);
  const qiblaRotation = ((qiblaBearing - compassHeading + 540) % 360) - 180;
  const kaabaDistance = distanceToKaabaKm(userLocation?.lat ?? 31.9539, userLocation?.lng ?? 35.9106);

  const apiPlaces: Place[] = loadedApiPlaces.map((place) => ({
    id: String(place.id),
    name: place.name,
    type: place.type === "mosque" ? "مسجد" : place.type === "mall" ? "مصلى مول" : place.type === "station" ? "مصلى محطة" : "مصلى",
    distance: formatDistance(userLocation, { lat: place.latitude, lng: place.longitude }),
    drive: "—",
    open: !place.hours || /غير معروفة|unknown/i.test(place.hours) ? null : /مفتوح طوال اليوم|open all day|24\/7/i.test(place.hours) ? true : /مغلق|closed/i.test(place.hours) ? false : null,
    ablution: place.hasAblution,
    women: place.hasWomenPrayer,
    parking: place.hasParking,
    lat: place.latitude,
    lng: place.longitude,
    status: place.status,
    distanceMeters: userLocation ? Math.round(formatDistance(userLocation, { lat: place.latitude, lng: place.longitude }).includes("كم") ? Number(formatDistance(userLocation, { lat: place.latitude, lng: place.longitude }).replace(" كم", "")) * 1000 : Number(formatDistance(userLocation, { lat: place.latitude, lng: place.longitude }).replace(" م", ""))) : Number.MAX_SAFE_INTEGER,
  }));
  const sourcePlaces = apiPlaces;

  const filteredPlaces = useMemo(() => {
    let result = sourcePlaces.filter((place) =>
      place.name.toLowerCase().includes(query.trim().toLowerCase()),
    );
    if (activeFilter === "open") result = result.filter((place) => place.open === true);
    if (activeFilter === "ablution") result = result.filter((place) => place.ablution);
    if (activeFilter === "women") result = result.filter((place) => place.women);
    if (activeFilter === "favorites") result = result.filter((place) => favorites.includes(place.id));
    return result.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }, [activeFilter, favorites, query, sourcePlaces]);

  const mosques = filteredPlaces.filter((place) => place.type === "مسجد");
  const musallas = filteredPlaces.filter((place) => place.type !== "مسجد");

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
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert(language === "ar" ? "نحتاج موقعك" : "Location needed", language === "ar" ? "نستخدمه لعرض الأماكن الأقرب فقط، ويمكنك البحث يدويًا بدلًا من ذلك." : "We use it only to show nearby places. You can search manually instead.");
        return;
      }
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setUserLocation({ lat: current.coords.latitude, lng: current.coords.longitude });
      setLocationEnabled(true);
      setLocationError(null);
    } catch {
      setLocationError(language === "ar" ? "تعذر تحديد الموقع" : "Unable to determine location");
    }
  };

  const openQibla = async () => {
    setHeadingReady(false);
    setHeadingSource(null);
    setHeadingAccuracy(null);
    setActiveTab("qibla");
    if (!locationEnabled) await requestLocation();
  };

  const beginLogin = async () => {
    try {
      await startOAuthLogin();
    } catch (error) {
      Alert.alert(language === "ar" ? "تعذر تسجيل الدخول" : "Sign-in failed", error instanceof Error ? error.message : (language === "ar" ? "تحقق من اتصال الإنترنت وحاول مرة أخرى." : "Check your connection and try again."));
    }
  };

  const openEmailAuth = (mode: "login" | "register" | "forgot") => {
    setEmailAuthMode(mode);
    setEmailAuthError(null);
    setEmailAuthMessage(null);
    setEmailAuthCanResend(false);
    setEmailAuthVisible(true);
  };

  const submitEmailAuth = async () => {
    setEmailAuthBusy(true);
    setEmailAuthError(null);
    setEmailAuthMessage(null);
    try {
      const endpoint = emailAuthMode === "register" ? "register" : emailAuthMode === "forgot" ? "forgot-password" : "login";
      const body = emailAuthMode === "register"
        ? { name: emailAuthName, email: emailAuthEmail, password: emailAuthPassword }
        : emailAuthMode === "forgot"
          ? { email: emailAuthEmail }
          : { email: emailAuthEmail, password: emailAuthPassword };
      const response = await fetch(`${getApiBaseUrl()}/api/auth/email/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-client-platform": Platform.OS === "web" ? "web" : "native" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string; app_session_id?: string; code?: string };
      if (!response.ok) {
        if (payload.code === "EMAIL_NOT_VERIFIED") {
          setEmailAuthCanResend(true);
          throw new Error(ui.verifyHint);
        }
        throw new Error(payload.error || (language === "ar" ? "تعذر إكمال العملية." : "Unable to complete the request."));
      }
      if (emailAuthMode === "login") {
        if (payload.app_session_id) await Auth.setSessionToken(payload.app_session_id);
        await meQuery.refetch();
        setEmailAuthVisible(false);
      } else if (emailAuthMode === "register") {
        setEmailAuthMode("login");
        setEmailAuthMessage(ui.verifySent);
      } else {
        setEmailAuthMessage(ui.resetSent);
      }
    } catch (error) {
      setEmailAuthError(error instanceof Error ? error.message : (language === "ar" ? "تعذر إكمال العملية." : "Unable to complete the request."));
    } finally {
      setEmailAuthBusy(false);
    }
  };

  const resendVerification = async () => {
    setEmailAuthBusy(true);
    setEmailAuthError(null);
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/auth/email/resend-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: emailAuthEmail }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || (language === "ar" ? "تعذر إرسال الرسالة." : "Unable to send the email."));
      setEmailAuthMessage(payload.message || ui.verifySent);
      setEmailAuthCanResend(false);
    } catch (error) {
      setEmailAuthError(error instanceof Error ? error.message : (language === "ar" ? "تعذر إرسال الرسالة." : "Unable to send the email."));
    } finally {
      setEmailAuthBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await logoutMutation.mutateAsync();
    } finally {
      await Auth.removeSessionToken();
      await Auth.clearUserInfo();
      await meQuery.refetch({ cancelRefetch: true });
      setActiveTab("home");
    }
  };

  const placeGroups: { groupTitle: string; groupPlaces: Place[] }[] = [
    { groupTitle: ui.mosques ?? "", groupPlaces: mosques },
    { groupTitle: ui.musallas ?? "", groupPlaces: musallas },
  ];
  const canLoadMore = activeFilter === "nearest" && userLocation
    ? nearestPlaces.data?.length === 20
    : placesQuery.data?.length === 20;

  const openAddPlace = () => {
    if (!meQuery.data) {
      openEmailAuth("login");
      return;
    }
    setSubmitError(null);
    setAddStep(1);
    setAddFormVisible(true);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.logoMark}><Image source={require("@/assets/images/icon.png")} style={styles.logoImage} /></View>
            <Text style={styles.brand}>مصلاي</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable onPress={() => setLanguage(language === "ar" ? "en" : "ar")} style={styles.languageButton}>
              <Text style={styles.languageText}>{language === "ar" ? "EN" : "ع"}</Text>
            </Pressable>
            <Pressable onPress={() => Alert.alert("مصلاي", ui.accountHint)} style={styles.profileButton}>
              <Text style={styles.profileLetter}>م</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.greetingBlock}>
          <Text style={styles.eyebrow}>{ui.greeting}</Text>
          <Text style={styles.title}>{ui.title}</Text>
        </View>

        <Pressable style={[styles.locationButton, locationEnabled && styles.locationButtonActive]} onPress={requestLocation}>
          <Ionicons name={locationEnabled ? "checkmark-circle" : "locate-outline"} size={20} color={locationEnabled ? COLORS.green : COLORS.navy} />
          <Text style={styles.locationButtonText}>{locationEnabled ? ui.located : ui.useLocation}</Text>
        </Pressable>
        {locationError && <Text style={styles.locationError}>{locationError}</Text>}

        <View style={styles.prayerCard}>
          <View style={styles.prayerTop}>
            <View>
              <Text style={styles.prayerLabel}>{ui.nextPrayer}</Text>
              <Text style={styles.prayerName}>{ui.prayerPrefix} {localizePrayerName(prayerState.name, language)}</Text>
              <Text style={styles.prayerTime}>{ui.today}، {formatClock(prayerState.time, language)}</Text>
            </View>
            <View style={styles.countdownWrap}>
              <Text style={styles.countdown}>{formatCountdown(prayerState.time, now)}</Text>
              <Text style={styles.countdownCaption}>{ui.remaining}</Text>
            </View>
          </View>
          <View style={styles.progressTrack}><View style={styles.progressFill} /></View>
          <View style={styles.prayerFooter}>
            <Text style={styles.nextHint}>{ui.prayerHint}</Text>
              <Pressable onPress={() => Alert.alert(ui.prayerTimes, getPrayerSchedule(now, userLocation).map(([name, time]) => `${localizePrayerName(name, language)}: ${formatClock(time, language)}`).join("\n"))}>
              <Text style={styles.prayerLink}>{ui.prayerTimes} <Ionicons name="arrow-back" size={12} color={COLORS.gold} /></Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionEyebrow}>{ui.guide}</Text>
            <Text style={styles.sectionTitle}>{ui.nearby}</Text>
          </View>
          <Pressable onPress={() => Alert.alert(ui.listTitle, ui.listHint)}>
            <Text style={styles.seeAll}>{ui.all}</Text>
          </Pressable>
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={19} color={COLORS.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={ui.search}
            placeholderTextColor="#9DA8B3"
            style={styles.searchInput}
            textAlign="right"
          />
          <View style={styles.shortcut}><Text style={styles.shortcutText}>⌘ K</Text></View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {filterOptions.map((filter) => {
            const active = activeFilter === filter.key;
            return (
              <Pressable key={filter.key} onPress={() => setActiveFilter(filter.key)} style={[styles.filterChip, active && styles.filterChipActive]}>
                {filter.key === "open" && <View style={[styles.dot, { backgroundColor: active ? COLORS.white : COLORS.green }]} />}
                {filter.key === "ablution" && <Ionicons name="water-outline" size={15} color={active ? COLORS.white : COLORS.teal} />}
                {filter.key === "women" && <Ionicons name="people-outline" size={15} color={active ? COLORS.white : COLORS.teal} />}
                {filter.key === "favorites" && <Ionicons name="heart-outline" size={15} color={active ? COLORS.white : COLORS.red} />}
                <Text style={[styles.filterText, active && styles.filterTextActive]}>{filter.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.mapCard}>
          {Platform.OS !== "web" ? <WebView source={{ html: createOsmHtml(sourcePlaces, userLocation) }} style={styles.nativeMap} originWhitelist={["*"]} javaScriptEnabled /> : null}
          <View style={styles.mapHeader}><Text style={styles.mapBadge}>{ui.mapLocation}</Text><Text style={styles.mapProvider}>OpenStreetMap</Text></View>
          {Platform.OS === "web" ? <><View style={[styles.mapRoad, styles.roadOne]} /><View style={[styles.mapRoad, styles.roadTwo]} /><View style={[styles.mapRoad, styles.roadThree]} /><View style={styles.mapWater} /><View style={[styles.mapPin, { top: 52, right: 78 }]}><Ionicons name="location" size={28} color={COLORS.navy} /><View style={styles.pinNumber}><Text style={styles.pinNumberText}>1</Text></View></View><View style={[styles.mapPin, { top: 101, right: 178 }]}><Ionicons name="location" size={28} color={COLORS.teal} /><View style={styles.pinNumber}><Text style={styles.pinNumberText}>2</Text></View></View><View style={[styles.mapPin, { top: 153, right: 112 }]}><Ionicons name="location" size={28} color={COLORS.gold} /><View style={styles.pinNumber}><Text style={styles.pinNumberText}>3</Text></View></View><View style={styles.currentLocation}><View style={styles.currentDot} /></View></> : null}
          <Pressable style={styles.mapControl} onPress={requestLocation}><Ionicons name="locate" size={19} color={COLORS.navy} /></Pressable>
        </View>

        {usingCachedPlaces && <Text style={styles.offlineNotice}>{language === "ar" ? "تُعرض آخر بيانات محفوظة — سنحدّثها عند عودة الاتصال" : "Showing saved data — it will refresh when you are online"}</Text>}
        <View style={styles.listHeader}><Text style={styles.nearbyCount}>{filteredPlaces.length} {ui.nearbyCount}</Text><Pressable onPress={() => setActiveFilter("nearest")}><Text style={styles.sortText}>{ui.nearest}</Text></Pressable></View>
        {placeGroups.map(({ groupTitle, groupPlaces }) => groupPlaces.length > 0 && <View key={groupTitle}>
          <Text style={[styles.groupTitle, groupTitle === ui.mosques ? styles.mosqueTitle : styles.musallaTitle]}>{groupTitle}</Text>
          {groupPlaces.map((place) => (
          <View key={place.id} style={styles.placeCard}>
            <View style={styles.placeMain}>
              <View style={[styles.placeIcon, place.type === "مسجد" ? styles.mosqueIcon : styles.musallaIcon]}><MaterialCommunityIcons name={place.type === "مسجد" ? "mosque" : "home-city-outline"} size={22} color={place.type === "مسجد" ? COLORS.mosqueGreen : COLORS.musallaBlue} /></View>
              <View style={styles.placeInfo}>
                <View style={styles.nameRow}><Text style={styles.placeName}>{place.name}</Text>{place.status === "pending" && <View style={styles.unverifiedPill}><Text style={styles.unverifiedText}>{ui.unverified}</Text></View>}<View style={[styles.openPill, place.open === false && styles.closedPill, place.open === null && styles.unknownPill]}><Text style={[styles.openText, place.open === false && styles.closedText, place.open === null && styles.unknownText]}>{place.open === true ? (language === "ar" ? "مفتوح" : "Open") : place.open === false ? (language === "ar" ? "مغلق" : "Closed") : ui.unknownHours}</Text></View></View>
                <Text style={styles.placeMeta}>{language === "ar" ? place.type : (place.type === "مسجد" ? "Mosque" : "Musalla")} · {place.distance} · {place.drive}{language === "ar" ? " بالسيارة" : " by car"}</Text>
                <View style={styles.amenities}><Text style={styles.metaTime}>{language === "ar" ? "قريب" : "Nearby"}</Text>{place.ablution && <Text style={styles.amenity}><Ionicons name="water" size={13} color={COLORS.teal} /> {language === "ar" ? "وضوء" : "Ablution"}</Text>}{place.parking && <Text style={styles.amenity}><Ionicons name="car" size={13} color={COLORS.muted} /> {language === "ar" ? "موقف" : "Parking"}</Text>}</View>
              </View>
            </View>
            <View style={styles.placeActions}>
              <Pressable onPress={() => toggleFavorite(place.id)} style={styles.iconAction}><Ionicons name={favorites.includes(place.id) ? "heart" : "heart-outline"} size={18} color={favorites.includes(place.id) ? COLORS.red : COLORS.muted} /></Pressable>
              <Pressable onPress={() => { setReviewPlaceId(Number(place.id)); if (meQuery.data) setReviewVisible(true); else beginLogin(); }} style={styles.iconAction}><Ionicons name="star-outline" size={18} color={COLORS.gold} /></Pressable>
              <Pressable onPress={() => sharePlace(place)} style={styles.iconAction}><Ionicons name="share-social-outline" size={18} color={COLORS.muted} /></Pressable>
              <Pressable onPress={() => openMaps(place)} style={styles.goButton}><Ionicons name="navigate" size={16} color={COLORS.white} /><Text style={styles.goText}>{ui.go}</Text></Pressable>
            </View>
          </View>
          ))}
        </View>)}

        {canLoadMore && <Pressable style={styles.loadMoreButton} onPress={() => setPlaceOffset((current) => current + 20)}><Text style={styles.loadMoreText}>{ui.loadMore}</Text></Pressable>}

        <Pressable style={styles.addPlaceButton} onPress={openAddPlace}><Ionicons name="add" size={19} color={COLORS.navy} /><Text style={styles.addPlaceText}>{ui.add}</Text></Pressable>
        <View style={styles.bottomSpace} />
      </ScrollView>
      <Modal visible={activeTab !== "home"} animationType="slide" transparent onRequestClose={() => setActiveTab("home")}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Pressable style={styles.modalClose} onPress={() => setActiveTab("home")}><Ionicons name="close" size={22} color={COLORS.navy} /></Pressable>
            {activeTab === "explore" && <>
              <Text style={styles.modalTitle}>{ui.exploreTitle}</Text>
              <Text style={styles.modalHint}>{ui.exploreHint}</Text>
              {filterOptions.map((filter) => <Pressable key={filter.key} style={styles.exploreRow} onPress={() => { setActiveFilter(filter.key); setActiveTab("home"); }}><Text style={styles.exploreRowText}>{filter.label}</Text><Ionicons name="chevron-back" size={18} color={COLORS.muted} /></Pressable>)}
            </>}
            {activeTab === "qibla" && <>
              <Text style={styles.modalTitle}>{language === "ar" ? "اتجاه القبلة" : "Qibla direction"}</Text>
              <View style={styles.qiblaSmartBadge}><MaterialCommunityIcons name="auto-fix" size={15} color={COLORS.green} /><Text style={styles.qiblaSmartText}>{language === "ar" ? "قبلة ذكية — تتحدث تلقائيًا" : "Smart Qibla — updates automatically"}</Text></View>
              <Text style={styles.qiblaHeroHint}>{language === "ar" ? "السهم الذهبي يشير إلى الكعبة حسب اتجاه هاتفك" : "The gold arrow points to the Kaaba using your phone heading"}</Text>
              <View style={styles.qiblaCompass}>
                <View style={styles.qiblaGlow} />
                <View style={styles.qiblaRing}>
                  <Text style={styles.qiblaNorth}>{language === "ar" ? "ش" : "N"}</Text><Text style={styles.qiblaEast}>{language === "ar" ? "ق" : "E"}</Text><Text style={styles.qiblaSouth}>{language === "ar" ? "ج" : "S"}</Text><Text style={styles.qiblaWest}>{language === "ar" ? "غ" : "W"}</Text>
                  <View style={[styles.qiblaNeedle, { transform: [{ rotate: `${qiblaRotation}deg` }] }]}><MaterialCommunityIcons name="navigation" size={70} color={COLORS.gold} /><View style={styles.kaabaBadge}><MaterialCommunityIcons name="cube-outline" size={20} color={COLORS.white} /></View></View>
                  <View style={styles.qiblaCenter} />
                </View>
              </View>
              <View style={styles.qiblaStats}><View><Text style={styles.qiblaStatValue}>{Math.round(qiblaBearing)}°</Text><Text style={styles.qiblaStatLabel}>{language === "ar" ? "اتجاه القبلة" : "Qibla bearing"}</Text></View><View><Text style={styles.qiblaStatValue}>{Math.round(compassHeading)}°</Text><Text style={styles.qiblaStatLabel}>{language === "ar" ? "اتجاه الهاتف" : "Phone heading"}</Text></View><View><Text style={styles.qiblaStatValue}>{Math.round(kaabaDistance).toLocaleString(language === "ar" ? "ar-JO" : "en-US")}</Text><Text style={styles.qiblaStatLabel}>{language === "ar" ? "كم إلى الكعبة" : "km to Kaaba"}</Text></View></View>
              <Text style={styles.modalHint}>{userLocation ? (language === "ar" ? "تحسب الاتجاه الجغرافي تلقائيًا من موقعك وتحدّث السهم مع اتجاه الهاتف، دون معايرة يدوية." : "The bearing is calculated from your location and the arrow updates with your phone, without manual calibration.") : (language === "ar" ? "فعّل الموقع للحصول على أدق اتجاه" : "Enable location for the most accurate direction")}</Text>
              <View style={styles.compassStatus}><View style={[styles.compassStatusDot, (userLocation && headingReady) ? styles.compassStatusReady : styles.compassStatusWaiting]} /><Text style={styles.compassStatusText}>{userLocation && headingReady ? (language === "ar" ? `البوصلة جاهزة · ${headingSource === "gps" ? "اتجاه حقيقي" : "حساس الهاتف"}${headingAccuracy !== null ? ` · دقة ${Math.round(headingAccuracy)}°` : ""}` : `Compass ready · ${headingSource === "gps" ? "true heading" : "phone sensor"}`) : (language === "ar" ? "جارٍ تشغيل الموقع والحساس تلقائيًا" : "Starting location and sensors automatically")}</Text></View>
              {!locationEnabled && <Pressable style={styles.primaryModalButton} onPress={requestLocation}><Text style={styles.primaryModalText}>{language === "ar" ? "تحديد موقعي" : "Use my location"}</Text></Pressable>}
            </>}
            {activeTab === "account" && <>
              <Text style={styles.modalTitle}>{ui.accountTitle}</Text>
              <Text style={styles.modalHint}>{meQuery.data ? (language === "ar" ? `مرحبًا ${meQuery.data.name || "بك"}` : `Welcome ${meQuery.data.name || ""}`) : ui.accountHint}</Text>
              {!meQuery.data && <>
                <Pressable style={styles.primaryModalButton} onPress={beginLogin}><Text style={styles.primaryModalText}>{ui.login}</Text></Pressable>
                <Pressable style={styles.secondaryModalButton} onPress={() => openEmailAuth("login")}><Text style={styles.secondaryModalText}>{ui.emailLogin}</Text></Pressable>
              </>}
              <View style={styles.reminderBox}>
                <View style={styles.reminderHeader}><View><Text style={styles.reminderTitle}>{language === "ar" ? "تذكير الصلاة" : "Prayer reminder"}</Text><Text style={styles.reminderHint}>{language === "ar" ? "تنبيه محلي قبل الصلاة، ويمكنك اختيار نعم أو تأجيله" : "A local reminder before prayer; choose done or snooze"}</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: remindersEnabled }} onPress={() => void updatePrayerReminders(!remindersEnabled)} style={[styles.reminderSwitch, remindersEnabled && styles.reminderSwitchOn]}><View style={[styles.reminderKnob, remindersEnabled && styles.reminderKnobOn]} /></Pressable></View>
                {remindersEnabled && <View style={styles.reminderMinutes}><Text style={styles.reminderMinutesLabel}>{language === "ar" ? "التنبيه قبل الصلاة بـ" : "Remind me"}</Text>{([15, 30, 45] as const).map((minutes) => <Pressable key={minutes} onPress={() => { setReminderMinutes(minutes); void updatePrayerReminders(true, minutes); }} style={[styles.minuteChip, reminderMinutes === minutes && styles.minuteChipActive]}><Text style={[styles.minuteChipText, reminderMinutes === minutes && styles.minuteChipTextActive]}>{minutes} {language === "ar" ? "دقيقة" : "min"}</Text></Pressable>)}</View>}
              </View>
              <View style={styles.legalLinks}><Pressable onPress={() => { setActiveTab("home"); router.push({ pathname: "/privacy" } as never); }}><Text style={styles.legalLinkText}>{language === "ar" ? "سياسة الخصوصية" : "Privacy policy"}</Text></Pressable><Text style={styles.legalSeparator}>•</Text><Pressable onPress={() => { setActiveTab("home"); router.push({ pathname: "/terms" } as never); }}><Text style={styles.legalLinkText}>{language === "ar" ? "شروط الاستخدام" : "Terms of use"}</Text></Pressable></View>
              {meQuery.data && <Pressable style={styles.secondaryModalButton} onPress={signOut}><Text style={styles.secondaryModalText}>{ui.logout}</Text></Pressable>}
            </>}
          </View>
        </View>
      </Modal>
      <Modal visible={emailAuthVisible} animationType="slide" transparent onRequestClose={() => setEmailAuthVisible(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modalCard}>
          <Pressable style={styles.modalClose} onPress={() => setEmailAuthVisible(false)}><Ionicons name="close" size={22} color={COLORS.navy} /></Pressable>
          <Text style={styles.modalTitle}>{emailAuthMode === "register" ? ui.emailRegister : emailAuthMode === "forgot" ? ui.forgotPassword : ui.emailLogin}</Text>
          {emailAuthMode === "register" && <TextInput value={emailAuthName} onChangeText={setEmailAuthName} placeholder={ui.name} style={styles.formInput} textAlign="right" autoCapitalize="words" />}
          <TextInput value={emailAuthEmail} onChangeText={setEmailAuthEmail} placeholder={ui.email} style={styles.formInput} textAlign="right" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
          {emailAuthMode !== "forgot" && <TextInput value={emailAuthPassword} onChangeText={setEmailAuthPassword} placeholder={ui.password} style={styles.formInput} textAlign="right" secureTextEntry autoCapitalize="none" />}
          {emailAuthMessage && <Text style={styles.formSuccess}>{emailAuthMessage}</Text>}
          {emailAuthError && <Text style={styles.formError}>{emailAuthError}</Text>}
          <Pressable style={styles.primaryModalButton} disabled={emailAuthBusy} onPress={submitEmailAuth}><Text style={styles.primaryModalText}>{emailAuthBusy ? (language === "ar" ? "جاري المعالجة..." : "Working...") : emailAuthMode === "register" ? ui.createAccount : emailAuthMode === "forgot" ? ui.sendReset : ui.login}</Text></Pressable>
          {emailAuthCanResend && <Pressable style={styles.authLink} disabled={emailAuthBusy} onPress={resendVerification}><Text style={styles.authLinkText}>{ui.resendVerification}</Text></Pressable>}
          {emailAuthMode === "login" && <>
            <Pressable style={styles.authLink} onPress={() => openEmailAuth("forgot")}><Text style={styles.authLinkText}>{ui.forgotPassword}</Text></Pressable>
            <Pressable style={styles.secondaryModalButton} onPress={() => openEmailAuth("register")}><Text style={styles.secondaryModalText}>{ui.emailRegister}</Text></Pressable>
          </>}
          {emailAuthMode === "register" && <Pressable style={styles.authLink} onPress={() => openEmailAuth("login")}><Text style={styles.authLinkText}>{ui.haveAccount}</Text></Pressable>}
          {emailAuthMode === "forgot" && <Pressable style={styles.authLink} onPress={() => openEmailAuth("login")}><Text style={styles.authLinkText}>{ui.backToLogin}</Text></Pressable>}
        </View></View>
      </Modal>
      <Modal visible={addFormVisible} animationType="slide" transparent onRequestClose={() => setAddFormVisible(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modalCard}>
          <Pressable style={styles.modalClose} onPress={() => setAddFormVisible(false)}><Ionicons name="close" size={22} color={COLORS.navy} /></Pressable>
          <Text style={styles.modalTitle}>{addStep === 1 ? ui.selectLocation : ui.placeData}</Text>
          {addStep === 1 ? <>
            <Text style={styles.modalHint}>{ui.pickerHint}</Text>
            <View style={styles.pickerMap}><WebView source={{ html: createPickerHtml(userLocation ?? { lat: 31.9539, lng: 35.9106 }) }} onMessage={(event) => { try { const next = JSON.parse(event.nativeEvent.data); setUserLocation({ lat: next.lat, lng: next.lng }); } catch { /* ignore malformed map events */ } }} originWhitelist={["*"]} javaScriptEnabled /></View>
            <Pressable style={styles.secondaryModalButton} onPress={requestLocation}><Text style={styles.secondaryModalText}>{ui.useCurrentLocation}</Text></Pressable>
            <Pressable style={styles.primaryModalButton} disabled={!userLocation} onPress={() => setAddStep(2)}><Text style={styles.primaryModalText}>{ui.locationCorrect}</Text></Pressable>
          </> : <>
            <TextInput value={placeName} onChangeText={setPlaceName} placeholder={ui.namePlaceholder} style={styles.formInput} textAlign="right" />
            <TextInput value={placeAddress} onChangeText={setPlaceAddress} placeholder={ui.addressPlaceholder} style={styles.formInput} textAlign="right" />
            <View style={styles.typeRow}><Pressable style={[styles.typeButton, placeType === "mosque" && styles.typeButtonActive]} onPress={() => setPlaceType("mosque")}><Text style={styles.typeText}>{ui.mosques}</Text></Pressable><Pressable style={[styles.typeButton, placeType === "musalla" && styles.typeButtonActive]} onPress={() => setPlaceType("musalla")}><Text style={styles.typeText}>{ui.musallas}</Text></Pressable></View>
            <TextInput value={placeHours} onChangeText={setPlaceHours} placeholder={ui.hoursPlaceholder} style={styles.formInput} textAlign="right" />
            {placeType === "musalla" && <><TextInput value={buildingName} onChangeText={setBuildingName} placeholder={ui.buildingPlaceholder} style={styles.formInput} textAlign="right" /><TextInput value={buildingFloor} onChangeText={setBuildingFloor} placeholder={ui.floorPlaceholder} style={styles.formInput} textAlign="right" /></>}
            <View style={styles.checkRow}><Pressable onPress={() => setHasAblution(!hasAblution)} style={[styles.checkButton, hasAblution && styles.checkButtonActive]}><Text style={styles.typeText}>{hasAblution ? "✓ " : ""}{ui.ablution}</Text></Pressable><Pressable onPress={() => setHasWomenPrayer(!hasWomenPrayer)} style={[styles.checkButton, hasWomenPrayer && styles.checkButtonActive]}><Text style={styles.typeText}>{hasWomenPrayer ? "✓ " : ""}{ui.women}</Text></Pressable><Pressable onPress={() => setHasParking(!hasParking)} style={[styles.checkButton, hasParking && styles.checkButtonActive]}><Text style={styles.typeText}>{hasParking ? "✓ " : ""}{ui.parking}</Text></Pressable></View>
            <Pressable style={styles.secondaryModalButton} onPress={() => setAddStep(1)}><Text style={styles.secondaryModalText}>{ui.editLocation}</Text></Pressable>
            <Pressable style={styles.primaryModalButton} disabled={submitPlace.isPending || !placeName.trim()} onPress={() => submitPlace.mutate({ name: placeName, type: placeType, address: placeAddress, hours: placeHours || "غير معروفة", description: buildingName ? `المبنى: ${buildingName}، الطابق: ${buildingFloor || "غير محدد"}` : undefined, latitude: userLocation?.lat ?? 31.9539, longitude: userLocation?.lng ?? 35.9106, hasAblution, hasWomenPrayer, hasParking })}><Text style={styles.primaryModalText}>{submitPlace.isPending ? ui.submitting : ui.submit}</Text></Pressable>
            {submitError && <Text style={styles.formError}>{submitError}</Text>}
          </>}
        </View></View>
      </Modal>
      <Modal visible={reviewVisible} animationType="slide" transparent onRequestClose={() => setReviewVisible(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modalCard}>
          <Pressable style={styles.modalClose} onPress={() => setReviewVisible(false)}><Ionicons name="close" size={22} color={COLORS.navy} /></Pressable>
          <Text style={styles.modalTitle}>{ui.reviewTitle}</Text>
          <View style={styles.ratingRow}>{[1, 2, 3, 4, 5].map((rating) => <Pressable key={rating} onPress={() => setReviewRating(rating)}><Ionicons name={rating <= reviewRating ? "star" : "star-outline"} size={30} color={COLORS.gold} /></Pressable>)}</View>
          <TextInput value={reviewComment} onChangeText={setReviewComment} placeholder={ui.reviewPlaceholder} style={[styles.formInput, styles.commentInput]} multiline textAlign="right" />
          <Pressable style={styles.primaryModalButton} disabled={submitReview.isPending} onPress={() => reviewPlaceId && submitReview.mutate({ placeId: reviewPlaceId, rating: reviewRating, comment: reviewComment })}><Text style={styles.primaryModalText}>{ui.publishReview}</Text></Pressable>
        </View></View>
      </Modal>
      <View style={styles.tabBar}>
        <Pressable style={styles.tabItem}><Ionicons name="home" size={22} color={COLORS.navy} /><Text style={[styles.tabText, styles.tabActive]}>{ui.home}</Text></Pressable>
        <Pressable style={styles.tabItem} onPress={() => setActiveTab("explore")}><Ionicons name="compass-outline" size={22} color={COLORS.muted} /><Text style={styles.tabText}>{ui.explore}</Text></Pressable>
        <Pressable style={styles.tabItem} onPress={() => void openQibla()}><MaterialCommunityIcons name="compass-rose" size={22} color={COLORS.muted} /><Text style={styles.tabText}>{ui.qibla}</Text></Pressable>
        <Pressable style={styles.tabItem} onPress={() => setActiveTab("account")}><Ionicons name="person-outline" size={22} color={COLORS.muted} /><Text style={styles.tabText}>{ui.account}</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.canvas },
  scroll: { paddingHorizontal: 18, paddingBottom: 88 },
  header: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingTop: 8, paddingBottom: 23 },
  brandRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9 },
  logoMark: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  logoImage: { width: 38, height: 38 },
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
  locationError: { color: COLORS.red, fontSize: 11, textAlign: "right", marginTop: -8, marginBottom: 10 },
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
  offlineNotice: { color: COLORS.gold, backgroundColor: COLORS.goldSoft, borderRadius: 8, padding: 8, fontSize: 10, textAlign: "right", marginBottom: 8 },
  groupTitle: { color: COLORS.navy, fontSize: 16, fontWeight: "800", textAlign: "right", marginTop: 10, marginBottom: 8 },
  mosqueTitle: { color: COLORS.mosqueGreen },
  musallaTitle: { color: COLORS.musallaBlue },
  placeCard: { backgroundColor: COLORS.white, borderRadius: 16, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: COLORS.line },
  placeMain: { flexDirection: "row-reverse", alignItems: "flex-start" },
  placeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", marginLeft: 10 },
  mosqueIcon: { backgroundColor: "#E5F7F0" },
  musallaIcon: { backgroundColor: COLORS.musallaSoft },
  placeInfo: { flex: 1 },
  nameRow: { flexDirection: "row-reverse", alignItems: "center", gap: 7, marginBottom: 5 },
  placeName: { color: COLORS.ink, fontSize: 14, fontWeight: "800", textAlign: "right" },
  openPill: { backgroundColor: "#E5F7F0", borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 },
  closedPill: { backgroundColor: "#FBEAE8" },
  unknownPill: { backgroundColor: "#FFF2D8" },
  unverifiedPill: { backgroundColor: "#F1F3F5", borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 },
  unverifiedText: { color: COLORS.muted, fontSize: 9, fontWeight: "800" },
  openText: { color: COLORS.green, fontSize: 9, fontWeight: "800" },
  closedText: { color: COLORS.red },
  unknownText: { color: "#B87914" },
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
  loadMoreButton: { height: 42, borderRadius: 12, backgroundColor: "#EEF5F8", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  loadMoreText: { color: COLORS.navy, fontSize: 12, fontWeight: "800" },
  bottomSpace: { height: 12 },
  tabBar: { position: "absolute", bottom: 0, left: 0, right: 0, height: 73, backgroundColor: "rgba(255,255,255,0.98)", borderTopWidth: 1, borderTopColor: COLORS.line, flexDirection: "row-reverse", justifyContent: "space-around", alignItems: "center", paddingBottom: 8 },
  tabItem: { alignItems: "center", gap: 4, minWidth: 62 },
  tabText: { color: COLORS.muted, fontSize: 10, fontWeight: "700" },
  tabActive: { color: COLORS.navy },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(16,45,74,0.35)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: COLORS.white, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, minHeight: 300, paddingBottom: 38 },
  modalClose: { alignSelf: "flex-start", width: 34, height: 34, borderRadius: 17, backgroundColor: COLORS.canvas, alignItems: "center", justifyContent: "center" },
  modalTitle: { color: COLORS.navy, fontSize: 22, fontWeight: "800", textAlign: "right", marginTop: 14, marginBottom: 8 },
  modalHint: { color: COLORS.muted, fontSize: 12, lineHeight: 20, textAlign: "right", marginBottom: 16 },
  exploreRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  exploreRowText: { color: COLORS.ink, fontSize: 14, fontWeight: "700" },
  qiblaHeroHint: { color: COLORS.teal, fontSize: 13, fontWeight: "800", textAlign: "center", marginBottom: 3 },
  qiblaSmartBadge: { alignSelf: "center", flexDirection: "row-reverse", alignItems: "center", gap: 5, backgroundColor: "#E5F7F0", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 7 },
  qiblaSmartText: { color: COLORS.green, fontSize: 11, fontWeight: "900" },
  qiblaCompass: { alignItems: "center", justifyContent: "center", height: 220, marginVertical: 2, position: "relative" },
  qiblaGlow: { position: "absolute", width: 205, height: 205, borderRadius: 103, backgroundColor: "#EAF7F5" },
  qiblaDegrees: { color: COLORS.navy, fontSize: 30, fontWeight: "900", textAlign: "center", marginBottom: 8 },
  qiblaRing: { width: 188, height: 188, borderRadius: 94, borderWidth: 7, borderColor: "#C9E3E0", backgroundColor: "#F8FCFC", alignItems: "center", justifyContent: "center", shadowColor: COLORS.navy, shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  qiblaNorth: { position: "absolute", top: 10, color: COLORS.navy, fontWeight: "900", fontSize: 12 },
  qiblaEast: { position: "absolute", right: 12, color: COLORS.muted, fontWeight: "800", fontSize: 11 },
  qiblaSouth: { position: "absolute", bottom: 10, color: COLORS.muted, fontWeight: "800", fontSize: 11 },
  qiblaWest: { position: "absolute", left: 12, color: COLORS.muted, fontWeight: "800", fontSize: 11 },
  qiblaNeedle: { alignItems: "center", justifyContent: "center", width: 86, height: 86 },
  kaabaBadge: { position: "absolute", top: 6, width: 34, height: 34, borderRadius: 17, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: COLORS.gold },
  qiblaCenter: { position: "absolute", width: 14, height: 14, borderRadius: 7, backgroundColor: COLORS.navy, borderWidth: 3, borderColor: COLORS.white },
  qiblaStats: { flexDirection: "row-reverse", justifyContent: "space-evenly", marginVertical: 10, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: COLORS.line },
  qiblaStatValue: { color: COLORS.navy, fontSize: 20, fontWeight: "900", textAlign: "center" },
  qiblaStatLabel: { color: COLORS.muted, fontSize: 10, textAlign: "center", marginTop: 2 },
  compassStatus: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, marginBottom: 4 },
  compassStatusDot: { width: 8, height: 8, borderRadius: 4 },
  compassStatusReady: { backgroundColor: COLORS.green },
  compassStatusWaiting: { backgroundColor: COLORS.gold },
  compassStatusText: { color: COLORS.muted, fontSize: 11, fontWeight: "700" },
  primaryModalButton: { height: 46, borderRadius: 13, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center", marginTop: 10 },
  primaryModalText: { color: COLORS.white, fontSize: 13, fontWeight: "800" },
  calibrationHint: { color: COLORS.muted, fontSize: 11, lineHeight: 18, textAlign: "center", marginBottom: 3 },
  secondaryModalButton: { height: 44, borderRadius: 13, backgroundColor: COLORS.canvas, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center", marginTop: 10 },
  secondaryModalText: { color: COLORS.navy, fontSize: 12, fontWeight: "800" },
  pickerMap: { height: 220, overflow: "hidden", borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, marginBottom: 4 },
  checkRow: { flexDirection: "row-reverse", gap: 8, marginBottom: 4 },
  checkButton: { flex: 1, height: 40, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center" },
  checkButtonActive: { backgroundColor: "#E5F7F0", borderColor: COLORS.green },
  adminLink: { alignItems: "center", paddingVertical: 14 },
  adminLinkText: { color: COLORS.teal, fontSize: 13, fontWeight: "800" },
  formInput: { height: 48, borderWidth: 1, borderColor: "#C8D4DC", borderRadius: 12, paddingHorizontal: 12, color: COLORS.ink, marginBottom: 10, backgroundColor: COLORS.white, fontSize: 15 },
  commentInput: { height: 90, paddingTop: 12, textAlignVertical: "top" },
  formError: { color: COLORS.red, fontSize: 11, lineHeight: 17, textAlign: "right", marginTop: 8 },
  formSuccess: { color: COLORS.green, fontSize: 11, lineHeight: 17, textAlign: "right", marginTop: 8 },
  authLink: { alignItems: "center", paddingVertical: 12 },
  authLinkText: { color: COLORS.teal, fontSize: 12, fontWeight: "800" },
  reminderBox: { backgroundColor: "#F3F8F8", borderRadius: 14, padding: 13, marginTop: 10, borderWidth: 1, borderColor: "#DCECEB" },
  reminderHeader: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 10 },
  reminderTitle: { color: COLORS.navy, fontSize: 13, fontWeight: "900", textAlign: "right" },
  reminderHint: { color: COLORS.muted, fontSize: 10, lineHeight: 16, textAlign: "right", marginTop: 3, maxWidth: 230 },
  reminderSwitch: { width: 46, height: 27, borderRadius: 14, backgroundColor: "#C8D4DC", padding: 3, justifyContent: "center" },
  reminderSwitchOn: { backgroundColor: COLORS.green },
  reminderKnob: { width: 21, height: 21, borderRadius: 11, backgroundColor: COLORS.white },
  reminderKnobOn: { alignSelf: "flex-end" },
  reminderMinutes: { flexDirection: "row-reverse", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 11 },
  reminderMinutesLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "700" },
  minuteChip: { borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, paddingHorizontal: 8, paddingVertical: 6 },
  minuteChipActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  minuteChipText: { color: COLORS.muted, fontSize: 10, fontWeight: "800" },
  minuteChipTextActive: { color: COLORS.white },
  legalLinks: { flexDirection: "row-reverse", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 12 },
  legalLinkText: { color: COLORS.teal, fontSize: 10, fontWeight: "800" },
  legalSeparator: { color: COLORS.muted, fontSize: 10 },
  ratingRow: { flexDirection: "row", justifyContent: "center", gap: 10, marginVertical: 14 },
  typeRow: { flexDirection: "row-reverse", gap: 8, marginBottom: 6 },
  typeButton: { flex: 1, height: 40, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center" },
  typeButtonActive: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold },
  typeText: { color: COLORS.navy, fontWeight: "800" },
});
