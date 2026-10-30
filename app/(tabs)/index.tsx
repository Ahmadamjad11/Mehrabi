import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as IntentLauncher from "expo-intent-launcher";
import Constants from "expo-constants";
import { Magnetometer } from "expo-sensors";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import OsmMapFrame from "@/components/OsmMapFrame";
import { trpc } from "@/lib/trpc";
import { getApiBaseUrl, startOAuthLogin } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { buildMapLocationCandidates, rankMapLocationsByDistance } from "@/lib/mapLocations";
import { createOsmHtml, createPickerHtml, EMPTY_COMMUNITY_MAP_POINTS, EMPTY_OFFICIAL_MAP_POINTS, OSM_COPYRIGHT_URL, OSM_MAP_FEATURES } from "@/lib/osmMapHtml";
import { bearingToKaaba, distanceToKaabaKm, formatClock, formatCountdown, getDynamicGreeting, getJordanCalendarDate, getPrayerSchedule, localizePrayerName } from "@/lib/prayerTimes";
import { clearPrayerReminderSchedule, configurePrayerNotifications, schedulePrayerReminders } from "@/lib/prayerReminderNotifications";
import { COLORS, styles } from "@/components/home/mehrabiStyles";

type Place = {
  id: string;
  name: string;
  type: string;
  distance: string;
  drive: string;
  distanceMeters: number;
  source: "community" | "ministry" | "osm";
  sourceLabelAr: string;
  sourceLabelEn: string;
  osmUrl?: string;
  alternateNames?: string[];
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

const REMINDER_SETTINGS_KEY = "maslay.prayer-reminders.v1";
const PLACES_CACHE_KEY = "maslay.places-cache.v1";







export default function HomeScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [placeOffset, setPlaceOffset] = useState(0);
  const [loadedApiPlaces, setLoadedApiPlaces] = useState<any[]>([]);
  const [usingCachedPlaces, setUsingCachedPlaces] = useState(false);
  const [activeFilter, setActiveFilter] = useState("nearest");
  const [placeTypeFilter, setPlaceTypeFilter] = useState<"all" | "mosque" | "musalla">("all");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [mapFocusLocation, setMapFocusLocation] = useState<{ lat: number; lng: number } | null>(null);
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
  const [prayerTimesVisible, setPrayerTimesVisible] = useState(false);
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
  const [emailAuthPhone, setEmailAuthPhone] = useState("");
  const [emailAuthEmail, setEmailAuthEmail] = useState("");
  const [emailAuthPassword, setEmailAuthPassword] = useState("");
  const [emailAuthBusy, setEmailAuthBusy] = useState(false);
  const [emailAuthError, setEmailAuthError] = useState<string | null>(null);
  const [emailAuthMessage, setEmailAuthMessage] = useState<string | null>(null);
  const [emailAuthCanResend, setEmailAuthCanResend] = useState(false);
  const [emailAuthNeedsOtp, setEmailAuthNeedsOtp] = useState(false);
  const [emailAuthOtp, setEmailAuthOtp] = useState("");
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [reminderMinutes, setReminderMinutes] = useState<15 | 30 | 45>(30);
  const [reminderScheduleError, setReminderScheduleError] = useState<string | null>(null);
  const [reminderSettingsLoaded, setReminderSettingsLoaded] = useState(false);
  const reminderScheduleKeyRef = useRef<string | null>(null);
  const reminderSyncGenerationRef = useRef(0);
  const reminderSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ui = language === "ar" ? {
    greeting: "صباح الخير ✦", title: "وين ناوي تصلي اليوم؟", useLocation: "استخدم موقعي", located: "تم تحديد موقعك",
    nextPrayer: "الصلاة القادمة ✦", today: "اليوم", remaining: "متبقي", prayerTimes: "مواقيت اليوم", guide: "دليلك في الطريق",
    nearby: "أماكن الصلاة القريبة منك", search: "ابحث عن مسجد أو مصلى أو منطقة...", mapLocation: "موقعك", all: "عرض القائمة", mosques: "المساجد", musallas: "المصليات", open: "مفتوح الآن", ablution: "وضوء", women: "مصلى النساء", nearest: "الأقرب أولًا", verified: "متحقق", unverified: "قيد المراجعة", unknownHours: "الأوقات غير معروفة",
    go: "اذهب", add: "أضف مكانًا تعرفه", home: "الرئيسية", explore: "استكشف", qibla: "القبلة", account: "حسابي", prayerPrefix: "صلاة", prayerHint: "لا تفوّت الصلاة أينما كنت", listTitle: "القائمة", listHint: "أنت تشاهد جميع الأماكن القريبة.", exploreTitle: "استكشف أماكن الصلاة", exploreHint: "ابحث وفلتر الأماكن حسب النوع والخدمات، والنتائج مرتبة من الأقرب.", accountTitle: "حسابي", accountHint: "سجّل الدخول لإضافة مكان وكتابة التقييمات.", login: "تسجيل الدخول", logout: "تسجيل الخروج", emailLogin: "تسجيل الدخول", emailRegister: "إنشاء حساب", email: "البريد الإلكتروني", phone: "رقم الهاتف", identifier: "البريد الإلكتروني أو رقم الهاتف", password: "كلمة المرور", name: "الاسم الكامل", forgotPassword: "نسيت كلمة المرور؟", sendReset: "إرسال رابط الاستعادة", resendVerification: "إعادة إرسال الرمز", createAccount: "إنشاء الحساب", haveAccount: "لديك حساب؟ تسجيل الدخول", backToLogin: "العودة لتسجيل الدخول", verifyHint: "افحص بريدك وأدخل رمز التحقق المكوّن من 6 أرقام قبل تسجيل الدخول.", resetSent: "إذا كان البريد مسجلًا فستصلك رسالة الاستعادة قريبًا.", verifySent: "تم إنشاء الحساب. افحص بريدك وأدخل رمز التحقق.", admin: "فتح لوحة الإدارة", addTitle: "إضافة مكان جديد", selectLocation: "حدد موقع المكان", placeData: "بيانات المكان", pickerHint: "اضغط على الخريطة لوضع الدبوس بدقة، أو استخدم موقعك الحالي.", useCurrentLocation: "استخدم موقعي الحالي", locationCorrect: "الموقع صحيح، متابعة", editLocation: "تعديل الموقع", namePlaceholder: "اسم المسجد أو المصلى", addressPlaceholder: "العنوان أو المنطقة", hoursPlaceholder: "ساعات العمل أو غير معروفة", buildingPlaceholder: "اسم المبنى (اختياري)", floorPlaceholder: "الطابق (اختياري)", submit: "إرسال للمراجعة", submitting: "جاري الإرسال...", editPlace: "المكان", parking: "مواقف", reviewTitle: "أضف تقييمك", reviewPlaceholder: "اكتب تعليقًا (اختياري)", publishReview: "نشر التقييم", loadMore: "تحميل 20 مكانًا إضافيًا", nearbyCount: "أماكن قريبة",
  } : {
    greeting: "Good morning ✦", title: "Where will you pray today?", useLocation: "Use my location", located: "Location detected",
    nextPrayer: "Next prayer ✦", today: "Today", remaining: "remaining", prayerTimes: "Today's times", guide: "Your guide on the way",
    nearby: "Prayer places near you", search: "Search for a mosque, musalla or area...", mapLocation: "Your location", all: "View list", mosques: "Mosques", musallas: "Musallas", open: "Open now", ablution: "Ablution", women: "Women's prayer", nearest: "Nearest first", verified: "Verified", unverified: "Not verified", unknownHours: "Hours unknown",
    go: "Go", add: "Add a place you know", home: "Home", explore: "Explore", qibla: "Qibla", account: "Account", prayerPrefix: "Prayer", prayerHint: "Never miss a prayer", listTitle: "List", listHint: "You are viewing nearby places.", exploreTitle: "Explore prayer places", exploreHint: "Search and filter by type and services, sorted by distance.", accountTitle: "Account", accountHint: "Sign in to add a place or write a review.", login: "Sign in", logout: "Sign out", emailLogin: "Sign in", emailRegister: "Create account", email: "Email", phone: "Phone number", identifier: "Email or phone number", password: "Password", name: "Full name", forgotPassword: "Forgot password?", sendReset: "Send reset link", resendVerification: "Resend code", createAccount: "Create account", haveAccount: "Already have an account? Sign in", backToLogin: "Back to sign in", verifyHint: "Check your inbox and enter the 6-digit code before signing in.", resetSent: "If this email is registered, you will receive a reset link shortly.", verifySent: "Account created. Check your inbox and enter the code.", admin: "Open admin dashboard", addTitle: "Add a new place", selectLocation: "Select location", placeData: "Place details", pickerHint: "Tap the map to place the pin accurately, or use your current location.", useCurrentLocation: "Use my current location", locationCorrect: "Location is correct, continue", editLocation: "Edit location", namePlaceholder: "Mosque or musalla name", addressPlaceholder: "Address or area", hoursPlaceholder: "Opening hours or unknown", buildingPlaceholder: "Building name (optional)", floorPlaceholder: "Floor (optional)", submit: "Submit for review", submitting: "Submitting...", editPlace: "Place", parking: "Parking", reviewTitle: "Add your review", reviewPlaceholder: "Write a comment (optional)", publishReview: "Publish review", loadMore: "Load 20 more places", nearbyCount: "nearby places",
  };
  const filterOptions = [
    { key: "nearest", label: ui.nearest, icon: "navigate-outline" },
    { key: "open", label: ui.open, icon: "time-outline" },
    { key: "ablution", label: ui.ablution, icon: "water-outline" },
    { key: "women", label: ui.women, icon: "people-outline" },
    { key: "favorites", label: language === "ar" ? "المفضلة" : "Favorites", icon: "heart-outline" },
  ] as const;
  const activeFilterLabel = filterOptions.find((option) => option.key === activeFilter)?.label ?? ui.nearest;
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
  const officialMosquesMapQuery = trpc.officialMosques.mapPoints.useQuery(undefined, { staleTime: 5 * 60_000, retry: 2 });
  const publicMapPlacesQuery = trpc.places.mapPoints.useQuery(undefined, { staleTime: 5 * 60_000, retry: 2 });
  const publicMapPlaces = publicMapPlacesQuery.data ?? EMPTY_COMMUNITY_MAP_POINTS;
  const officialMosqueMapPoints = officialMosquesMapQuery.data?.items ?? EMPTY_OFFICIAL_MAP_POINTS;
  const mapLocationCandidates = useMemo(() => {
    const communityDetails = new Map(loadedApiPlaces.map((place) => [String(place.id), place]));
    const community = publicMapPlaces.map((point) => {
      const details = communityDetails.get(String(point.id));
      const hours = String(details?.hours ?? "");
      const open = !hours || /غير معروفة|unknown/i.test(hours) ? null : /مفتوح طوال اليوم|open all day|24\/7/i.test(hours) ? true : /مغلق|closed/i.test(hours) ? false : null;
      return {
        ...point,
        open,
        hasAblution: Boolean(details?.hasAblution),
        hasWomenPrayer: Boolean(details?.hasWomenPrayer),
        hasParking: Boolean(details?.hasParking),
        status: details?.status,
      };
    });
    return buildMapLocationCandidates({
      community,
      official: officialMosqueMapPoints,
      osm: OSM_MAP_FEATURES,
      officialMapLoaded: officialMosquesMapQuery.isSuccess,
    });
  }, [publicMapPlaces, officialMosqueMapPoints, officialMosquesMapQuery.isSuccess, loadedApiPlaces]);
  const sourcePlaces: Place[] = useMemo(() => {
    const ranked = userLocation
      ? rankMapLocationsByDistance(mapLocationCandidates, userLocation)
      : mapLocationCandidates.map((location) => ({ ...location, distanceMeters: Number.MAX_SAFE_INTEGER }));
    return ranked.map((location) => ({
      id: location.id,
      name: location.name,
      type: location.kind === "mosque" ? "مسجد" : "مصلى",
      distance: formatDistance(userLocation, { lat: location.latitude, lng: location.longitude }),
      drive: "—",
      distanceMeters: location.distanceMeters,
      source: location.source,
      sourceLabelAr: location.sourceLabelAr,
      sourceLabelEn: location.sourceLabelEn,
      osmUrl: location.osmUrl,
      alternateNames: location.alternateNames,
      open: location.open ?? null,
      ablution: location.hasAblution ?? false,
      parking: location.hasParking ?? false,
      women: location.hasWomenPrayer ?? false,
      lat: location.latitude,
      lng: location.longitude,
      status: location.status,
    }));
  }, [mapLocationCandidates, userLocation]);
  const mapHtml = useMemo(
    () => createOsmHtml(publicMapPlaces, officialMosqueMapPoints, userLocation, language, officialMosquesMapQuery.isSuccess, placeTypeFilter, query, mapFocusLocation),
    [publicMapPlaces, officialMosqueMapPoints, userLocation, language, officialMosquesMapQuery.isSuccess, placeTypeFilter, query, mapFocusLocation],
  );
  const meQuery = trpc.auth.me.useQuery();
  const logoutMutation = trpc.auth.logout.useMutation();
  const nearestPlaces = trpc.places.nearest.useMutation();
  const submitPlace = trpc.places.submit.useMutation({ onSuccess: () => { setSubmitError(null); setAddFormVisible(false); setAddStep(1); setPlaceName(""); setPlaceAddress(""); setPlaceHours(""); placesQuery.refetch(); }, onError: (error) => setSubmitError(language === "ar" ? `تعذر إرسال المكان: ${error.message}` : `Could not submit place: ${error.message}`) });
  const submitReview = trpc.places.review.useMutation({ onSuccess: () => { setReviewVisible(false); setReviewComment(""); } });

  const queuePrayerReminderSync = useCallback((enabled: boolean, minutes: number, location: { lat: number; lng: number } | null) => {
    const jordanToday = getJordanCalendarDate(new Date());
    const locationKey = location ? `${location.lat.toFixed(3)},${location.lng.toFixed(3)}` : "default";
    const scheduleKey = enabled
      ? `${jordanToday.getFullYear()}-${jordanToday.getMonth()}-${jordanToday.getDate()}-${minutes}-${locationKey}`
      : "disabled";
    if (reminderScheduleKeyRef.current === scheduleKey) return reminderSyncQueueRef.current;
    const generation = ++reminderSyncGenerationRef.current;
    reminderScheduleKeyRef.current = scheduleKey;
    reminderSyncQueueRef.current = reminderSyncQueueRef.current.catch(() => undefined).then(async () => {
      if (generation !== reminderSyncGenerationRef.current) return;
      try {
        if (!enabled) {
          await clearPrayerReminderSchedule();
          if (generation === reminderSyncGenerationRef.current) {
            reminderScheduleKeyRef.current = "disabled";
            setReminderScheduleError(null);
          }
          return;
        }
        setReminderScheduleError(null);
        await schedulePrayerReminders(minutes, location, () => generation === reminderSyncGenerationRef.current);
        if (generation === reminderSyncGenerationRef.current) {
          reminderScheduleKeyRef.current = scheduleKey;
          setReminderScheduleError(null);
        }
      } catch (error) {
        console.warn("Prayer reminder synchronization failed; it will be retried.", error);
        if (generation === reminderSyncGenerationRef.current) {
          if (!enabled) reminderScheduleKeyRef.current = null;
          setReminderScheduleError(language === "ar" ? "تعذرت مزامنة التذكيرات. سيحاول التطبيق مجددًا عند فتحه." : "Could not synchronize reminders. The app will retry when reopened.");
        }
      }
    });
    return reminderSyncQueueRef.current;
  }, [language]);

  const updatePrayerReminders = async (enabled: boolean, minutes = reminderMinutes) => {
    if (enabled) {
      let ready = false;
      try {
        ready = await configurePrayerNotifications();
      } catch {
        ready = false;
      }
      if (!ready) {
        Alert.alert(language === "ar" ? "التنبيهات غير مفعّلة" : "Notifications are disabled", language === "ar" ? "اسمح للتطبيق بالتنبيهات من إعدادات الهاتف." : "Allow notifications in your phone settings.");
        return;
      }
    }
    setReminderMinutes(minutes as 15 | 30 | 45);
    setReminderScheduleError(null);
    setRemindersEnabled(enabled);
    await AsyncStorage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify({ enabled, minutes }));
    if (Platform.OS !== "web") await queuePrayerReminderSync(enabled, minutes, userLocation);
  };

  const openExactAlarmSettings = async () => {
    try {
      const packageName = Constants.expoConfig?.android?.package;
      if (!packageName) throw new Error("Android package name is unavailable");
      await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.REQUEST_SCHEDULE_EXACT_ALARM, {
        data: `package:${packageName}`,
      });
      reminderScheduleKeyRef.current = null;
      await queuePrayerReminderSync(true, reminderMinutes, userLocation);
    } catch {
      Alert.alert(
        language === "ar" ? "تعذر فتح إعداد الدقة" : "Could not open exact-alarm settings",
        language === "ar" ? "افتح إعدادات الهاتف > التطبيقات > محرابي > التنبيهات والمنبهات، ثم اسمح بالتنبيهات الدقيقة." : "Open Settings > Apps > Mehrabi > Alarms & reminders, then allow exact alarms.",
      );
    }
  };

  useEffect(() => {
    if (Platform.OS === "web") return;
    let responseSubscription: Notifications.EventSubscription | undefined;
    const handleNotificationResponse = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      void Notifications.dismissNotificationAsync(id).catch(() => undefined);
    };
    void (async () => {
      const stored = await AsyncStorage.getItem(REMINDER_SETTINGS_KEY);
      const settings = stored ? JSON.parse(stored) as { enabled?: boolean; minutes?: 15 | 30 | 45 } : undefined;
      const enabled = settings?.enabled === true;
      const minutes = settings?.minutes === 15 || settings?.minutes === 45 ? settings.minutes : 30;
      setRemindersEnabled(enabled);
      setReminderMinutes(minutes);
      setReminderSettingsLoaded(true);
      const lastResponse = await Notifications.getLastNotificationResponseAsync();
      if (lastResponse) {
        handleNotificationResponse(lastResponse);
        await Notifications.clearLastNotificationResponseAsync();
      }
    })();
    responseSubscription = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    return () => responseSubscription?.remove();
  }, []);

  useEffect(() => {
    if (Platform.OS === "web" || !reminderSettingsLoaded) return;
    if (!remindersEnabled) {
      void queuePrayerReminderSync(false, reminderMinutes, userLocation);
      return;
    }
    const jordanToday = getJordanCalendarDate(now);
    const locationKey = userLocation ? `${userLocation.lat.toFixed(3)},${userLocation.lng.toFixed(3)}` : "default";
    const scheduleKey = `${jordanToday.getFullYear()}-${jordanToday.getMonth()}-${jordanToday.getDate()}-${reminderMinutes}-${locationKey}`;
    if (reminderScheduleKeyRef.current === scheduleKey) return;
    void queuePrayerReminderSync(remindersEnabled, reminderMinutes, userLocation);
  }, [now, remindersEnabled, reminderMinutes, userLocation, language, reminderSettingsLoaded, queuePrayerReminderSync]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        reminderScheduleKeyRef.current = null;
        setReminderScheduleError(null);
        void queuePrayerReminderSync(remindersEnabled, reminderMinutes, userLocation);
      }
    });
    return () => subscription.remove();
  }, [remindersEnabled, reminderMinutes, userLocation, language, queuePrayerReminderSync]);

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
    if (Platform.OS !== "web") void Magnetometer.requestPermissionsAsync().catch(() => undefined);
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
    if (Platform.OS !== "web" && typeof Magnetometer.addListener === "function") {
      Magnetometer.setUpdateInterval(120);
      magnetometerSubscription = Magnetometer.addListener(({ x, y }) => {
        if (headingStreamRef.current || !Number.isFinite(x) || !Number.isFinite(y)) return;
        // Expo's native axes point east/north; convert them to a clockwise heading.
        const heading = (Math.atan2(y, x) * 180) / Math.PI;
        setHeadingSource("sensor");
        setHeadingAccuracy(null);
        smoothHeading((360 - heading + 360) % 360);
      });
    }
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

  const filteredPlaces = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    let result = sourcePlaces.filter((place) =>
      [place.name, ...(place.alternateNames ?? [])].some((name) => name.toLocaleLowerCase().includes(normalizedQuery)),
    );
    if (activeFilter === "open") result = result.filter((place) => place.open === true);
    if (activeFilter === "ablution") result = result.filter((place) => place.ablution);
    if (activeFilter === "women") result = result.filter((place) => place.women);
    if (activeFilter === "favorites") result = result.filter((place) => favorites.includes(place.id));
    if (placeTypeFilter === "mosque") result = result.filter((place) => place.type === "مسجد");
    if (placeTypeFilter === "musalla") result = result.filter((place) => place.type !== "مسجد");
    return result.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }, [activeFilter, favorites, placeTypeFilter, query, sourcePlaces]);

  const nearestFivePlaces = filteredPlaces.slice(0, 5);

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
      setMapFocusLocation(null);
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
    setEmailAuthNeedsOtp(false);
    setEmailAuthOtp("");
    setEmailAuthVisible(true);
  };

  const submitEmailAuth = async () => {
    setEmailAuthBusy(true);
    setEmailAuthError(null);
    setEmailAuthMessage(null);
    try {
      const endpoint = emailAuthMode === "register" ? "register" : emailAuthMode === "forgot" ? "forgot-password" : "login";
      const body = emailAuthMode === "register"
        ? { name: emailAuthName, phone: emailAuthPhone, email: emailAuthEmail, password: emailAuthPassword }
        : emailAuthMode === "forgot"
          ? { email: emailAuthEmail }
          : { identifier: emailAuthEmail, password: emailAuthPassword };
      const response = await fetch(`${getApiBaseUrl()}/api/auth/email/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-client-platform": Platform.OS === "web" ? "web" : "native" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string; app_session_id?: string; code?: string };
      if (!response.ok) {
        throw new Error(payload.error || (language === "ar" ? "تعذر إكمال العملية." : "Unable to complete the request."));
      }
      if (emailAuthMode === "login" || emailAuthMode === "register") {
        if (payload.app_session_id) await Auth.setSessionToken(payload.app_session_id);
        await meQuery.refetch();
        setEmailAuthVisible(false);
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
            <View style={styles.brandCopy}>
              <Text style={styles.brand}>محرابي</Text>
              <Text style={styles.brandTagline}>دليلك للصلاة</Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <Pressable onPress={() => setLanguage(language === "ar" ? "en" : "ar")} style={styles.languageButton}>
              <Text style={styles.languageText}>{language === "ar" ? "EN" : "ع"}</Text>
            </Pressable>
            <Pressable onPress={() => Alert.alert("محرابي", ui.accountHint)} style={styles.profileButton}>
              <Text style={styles.profileLetter}>م</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.greetingBlock}>
            <View style={styles.greetingPill}><View style={styles.greetingDot} /><Text style={styles.eyebrow}>{getDynamicGreeting(now, language)}</Text></View>
          <Text style={styles.title}>{ui.title}</Text>
          <Text style={styles.heroHint}>{language === "ar" ? "محرابك معك في كل طريق" : "Your prayer space, wherever you go"}</Text>
        </View>

        <Pressable style={[styles.locationButton, locationEnabled && styles.locationButtonActive]} onPress={requestLocation}>
          <Ionicons name={locationEnabled ? "checkmark-circle" : "locate-outline"} size={20} color={locationEnabled ? COLORS.green : COLORS.navy} />
          <Text style={styles.locationButtonText}>{locationEnabled ? ui.located : ui.useLocation}</Text>
        </Pressable>
        {locationError && <Text style={styles.locationError}>{locationError}</Text>}

        <View style={styles.prayerCard}>
          <View style={styles.prayerOrb} />
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
            <Pressable onPress={() => setPrayerTimesVisible(true)} style={styles.prayerTimesButton}><Text style={styles.prayerLink}>{ui.prayerTimes} <Ionicons name="arrow-back" size={12} color={COLORS.gold} /></Text></Pressable>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionEyebrow}>{ui.guide}</Text>
            <Text style={styles.sectionTitle}>{ui.nearby}</Text>
          </View>
        </View>

        <View style={styles.discoveryCard}>
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={19} color={COLORS.muted} />
            <TextInput value={query} onChangeText={setQuery} placeholder={ui.search} placeholderTextColor="#9DA8B3" style={styles.searchInput} textAlign="right" accessibilityLabel={ui.search} returnKeyType="search" />
            {query.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={language === "ar" ? "مسح البحث" : "Clear search"} onPress={() => setQuery("")}><Ionicons name="close-circle" size={18} color={COLORS.muted} /></Pressable>}
          </View>
          <View style={styles.typeSegmentRow}>
            {([{ key: "all", label: language === "ar" ? "الكل" : "All", icon: "map-outline" }, { key: "mosque", label: ui.mosques, icon: "mosque" }, { key: "musalla", label: ui.musallas, icon: "home-city-outline" }] as const).map((option) => {
              const selected = placeTypeFilter === option.key;
              return <Pressable key={option.key} onPress={() => setPlaceTypeFilter(option.key)} style={[styles.typeSegment, selected && styles.typeSegmentActive, option.key === "mosque" && selected && styles.typeSegmentMosque, option.key === "musalla" && selected && styles.typeSegmentMusalla]}><MaterialCommunityIcons name={option.icon as any} size={16} color={selected ? COLORS.white : option.key === "mosque" ? COLORS.mosqueGreen : option.key === "musalla" ? COLORS.musallaBlue : COLORS.muted} /><Text style={[styles.typeSegmentText, selected && styles.typeSegmentTextActive]}>{option.label}</Text></Pressable>;
            })}
          </View>
          <Pressable style={styles.filterButton} onPress={() => setActiveTab("explore")} accessibilityRole="button">
            <Ionicons name="options-outline" size={17} color={COLORS.navy} />
            <Text style={styles.filterButtonText}>{language === "ar" ? "تصفية وترتيب" : "Filter & sort"}</Text>
            <Text style={styles.filterButtonValue}>{activeFilterLabel}</Text>
          </Pressable>
        </View>

        <View style={styles.mapCard}>
          <OsmMapFrame html={mapHtml} />
          <View style={styles.mapHeader}><View style={styles.mapTitleBadge}><Ionicons name="navigate-outline" size={13} color={COLORS.green} /><Text style={styles.mapBadge}>{ui.mapLocation}</Text></View><Pressable accessibilityRole="link" onPress={() => { void Linking.openURL(OSM_COPYRIGHT_URL).catch(() => undefined); }}><Text style={styles.mapProvider}>© OpenStreetMap contributors</Text></Pressable></View>
          <Pressable style={styles.mapControl} onPress={() => { setMapFocusLocation(null); void requestLocation(); }}><Ionicons name="locate" size={19} color={COLORS.navy} /></Pressable>
          <View style={styles.mapLegend}><View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: COLORS.mosqueGreen }]} /><Text style={styles.legendText}>{ui.mosques}</Text></View><View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: COLORS.musallaBlue }]} /><Text style={styles.legendText}>{ui.musallas}</Text></View>{locationEnabled && <View style={styles.legendItem}><View style={[styles.legendDot, styles.legendLocation]} /><Text style={styles.legendText}>{language === "ar" ? "موقعك" : "You"}</Text></View>}</View>
        </View>
        {(officialMosquesMapQuery.isError || publicMapPlacesQuery.isError) && <View style={styles.mapCoverage}><Pressable accessibilityRole="button" onPress={() => { void officialMosquesMapQuery.refetch(); void publicMapPlacesQuery.refetch(); }}><Text style={styles.mapCoverageRetry}>{language === "ar" ? "إعادة المحاولة" : "Retry"}</Text></Pressable></View>}
        <View style={styles.quickActions}>
          <Pressable style={styles.quickAction} onPress={() => void openQibla()} accessibilityRole="button">
            <View style={[styles.quickIcon, styles.quickIconGold]}><MaterialCommunityIcons name="compass-rose" size={21} color={COLORS.navy} /></View>
            <Text style={styles.quickActionText}>{ui.qibla}</Text>
            <Text style={styles.quickActionHint}>{language === "ar" ? "اتجاه دقيق" : "Accurate bearing"}</Text>
          </Pressable>
          <Pressable style={styles.quickAction} onPress={openAddPlace} accessibilityRole="button">
            <View style={[styles.quickIcon, styles.quickIconBlue]}><Ionicons name="add" size={22} color={COLORS.navy} /></View>
            <Text style={styles.quickActionText}>{ui.add}</Text>
            <Text style={styles.quickActionHint}>{language === "ar" ? "شارك الخير" : "Add a place"}</Text>
          </Pressable>
        </View>

        {usingCachedPlaces && <Text style={styles.offlineNotice}>{language === "ar" ? "تُعرض آخر بيانات محفوظة — سنحدّثها عند عودة الاتصال" : "Showing saved data — it will refresh when you are online"}</Text>}
        <View style={styles.listHeader}><Text style={styles.nearbyCount}>{language === "ar" ? "أقرب المواقع إلى موقعك" : "Closest places to you"}</Text></View>
        {!userLocation && (
          <View style={styles.emptyPlacesNotice}>
            <Text style={styles.emptyPlacesNoticeText}>
              {language === "ar"
                ? "لا أقدّر المسافة من دون موقعك. اسمح بالوصول للموقع أو حرّك الخريطة يدويًا؛ جميع العلامات مبنية على إحداثيات المصدر فقط."
                : "Distances are not estimated without your location. Allow location access or move the map manually; markers use source coordinates only."}
            </Text>
          </View>
        )}
        {userLocation && filteredPlaces.length === 0 && !placesQuery.isLoading && (
          <View style={styles.emptyPlacesNotice}><Text style={styles.emptyPlacesNoticeText}>{language === "ar" ? "لا توجد مواقع تطابق البحث أو التصفية. جرّب «الكل» أو امسح التصفية والبحث." : "No map locations match this search or filter. Try All or clear the filters and search."}</Text></View>
        )}
        {userLocation && nearestFivePlaces.map((place) => (
          <View key={place.id} style={[styles.placeCard, place.type === "مسجد" ? styles.mosqueCard : styles.musallaCard]}>
            <View style={styles.placeMain}>
              <View style={[styles.placeIcon, place.type === "مسجد" ? styles.mosqueIcon : styles.musallaIcon]}><MaterialCommunityIcons name={place.type === "مسجد" ? "mosque" : "home-city-outline"} size={22} color={place.type === "مسجد" ? COLORS.mosqueGreen : COLORS.musallaBlue} /></View>
              <View style={styles.placeInfo}>
                <View style={styles.nameRow}><Text style={styles.placeName}>{place.name}</Text><View style={[styles.typePill, place.type === "مسجد" ? styles.typePillMosque : styles.typePillMusalla]}><Text style={styles.typePillText}>{language === "ar" ? place.type : (place.type === "مسجد" ? "Mosque" : "Musalla")}</Text></View></View>
                <Text style={styles.placeSourceText}>{language === "ar" ? place.sourceLabelAr : place.sourceLabelEn}</Text>
                {place.source === "community" && <View style={styles.statusRow}>{place.status === "pending" && <View style={styles.unverifiedPill}><Ionicons name="time-outline" size={11} color={COLORS.muted} /><Text style={styles.unverifiedText}>{ui.unverified}</Text></View>}<View style={[styles.openPill, place.open === false && styles.closedPill, place.open === null && styles.unknownPill]}><Text style={[styles.openText, place.open === false && styles.closedText, place.open === null && styles.unknownText]}>{place.open === true ? (language === "ar" ? "مفتوح" : "Open") : place.open === false ? (language === "ar" ? "مغلق" : "Closed") : ui.unknownHours}</Text></View></View>}
                <View style={styles.distanceRow}><Text style={styles.distanceValue}>{place.distance}</Text><Text style={styles.distanceHint}>{language === "ar" ? "مسافة بخط مستقيم" : "straight-line distance"}</Text></View>
                {place.source === "community" && <View style={styles.amenities}><Text style={styles.metaTime}>{language === "ar" ? "معلومات المكان" : "Place details"}</Text>{place.ablution && <Text style={styles.amenity}><Ionicons name="water" size={13} color={COLORS.teal} /> {language === "ar" ? "وضوء" : "Ablution"}</Text>}{place.parking && <Text style={styles.amenity}><Ionicons name="car" size={13} color={COLORS.muted} /> {language === "ar" ? "موقف" : "Parking"}</Text>}</View>}
              </View>
            </View>
            <View style={styles.placeActions}>
              {place.source === "community" && <Pressable onPress={() => toggleFavorite(place.id)} style={styles.iconAction}><Ionicons name={favorites.includes(place.id) ? "heart" : "heart-outline"} size={18} color={favorites.includes(place.id) ? COLORS.red : COLORS.muted} /></Pressable>}
              {place.source === "community" && <Pressable onPress={() => { setReviewPlaceId(Number(place.id)); if (meQuery.data) setReviewVisible(true); else openEmailAuth("login"); }} style={styles.iconAction}><Ionicons name="star-outline" size={18} color={COLORS.gold} /></Pressable>}
              <Pressable onPress={() => sharePlace(place)} style={styles.iconAction}><Ionicons name="share-social-outline" size={18} color={COLORS.muted} /></Pressable>
              <Pressable onPress={() => openMaps(place)} style={styles.goButton}><Ionicons name="navigate" size={16} color={COLORS.white} /><Text style={styles.goText}>{language === "ar" ? "الطريق" : "Directions"}</Text></Pressable>
            </View>
          </View>
        ))}
        <View style={styles.bottomSpace} />
      </ScrollView>
      <Modal visible={activeTab !== "home"} animationType="slide" transparent onRequestClose={() => setActiveTab("home")}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Pressable style={styles.modalClose} onPress={() => setActiveTab("home")}><Ionicons name="close" size={22} color={COLORS.navy} /></Pressable>
            {activeTab === "explore" && <>
              <View style={styles.exploreHero}><View style={styles.exploreHeroIcon}><Ionicons name="options-outline" size={25} color={COLORS.gold} /></View><Text style={styles.modalTitle}>{language === "ar" ? "تصفية وترتيب النتائج" : "Filter and sort results"}</Text><Text style={styles.modalHint}>{language === "ar" ? "اختر طريقة عرض النتائج؛ البحث ونوع المكان يطبّقان مباشرة على الخريطة." : "Choose how results are filtered; search and place type also filter the map."}</Text></View>
              <View style={styles.exploreQuickGrid}>
                {filterOptions.map((option) => {
                  const selected = activeFilter === option.key;
                  return <Pressable key={option.key} style={styles.exploreRow} onPress={() => { setActiveFilter(option.key); setPlaceOffset(0); setActiveTab("home"); }} accessibilityRole="button" accessibilityState={{ selected }}><View style={{ flexDirection: "row-reverse", alignItems: "center", gap: 9 }}><Ionicons name={option.icon} size={18} color={selected ? COLORS.green : COLORS.muted} /><Text style={styles.exploreRowText}>{option.label}</Text></View><Ionicons name={selected ? "checkmark-circle" : "chevron-back"} size={17} color={selected ? COLORS.green : COLORS.muted} /></Pressable>;
                })}
              </View>
              <View style={styles.exploreLocationNote}><Ionicons name="information-circle-outline" size={17} color={COLORS.gold} /><Text style={styles.exploreLocationText}>{language === "ar" ? "فلاتر الدوام والخدمات تعتمد على البيانات المتاحة، وقد لا تُظهر بعض المواقع في قائمة النتائج عند استخدامها." : "Hours and amenity filters depend on available data and may omit some places from the results list."}</Text></View>
              <Pressable style={styles.secondaryModalButton} onPress={() => { setActiveFilter("nearest"); setPlaceTypeFilter("all"); setQuery(""); setPlaceOffset(0); setActiveTab("home"); }}><Text style={styles.secondaryModalText}>{language === "ar" ? "مسح البحث والفلاتر" : "Clear search and filters"}</Text></Pressable>
            </>}
            {activeTab === "qibla" && <>
              <Text style={styles.modalTitle}>{language === "ar" ? "اتجاه القبلة" : "Qibla direction"}</Text>
              <View style={styles.qiblaSmartBadge}><MaterialCommunityIcons name="auto-fix" size={15} color={COLORS.green} /><Text style={styles.qiblaSmartText}>{language === "ar" ? "تعمل تلقائيًا — بلا معايرة" : "Automatic — no calibration"}</Text></View>
              <Text style={styles.qiblaHeroHint}>{language === "ar" ? "أمسك هاتفك بأي اتجاه؛ السهم يصحح نفسه ويشير للكعبة" : "Hold your phone in any direction; the arrow corrects itself toward the Kaaba"}</Text>
              <View style={styles.qiblaCompass}>
                <View style={styles.qiblaGlow} />
                <View style={styles.qiblaRing}>
                  <Text style={styles.qiblaNorth}>{language === "ar" ? "ش" : "N"}</Text><Text style={styles.qiblaEast}>{language === "ar" ? "ق" : "E"}</Text><Text style={styles.qiblaSouth}>{language === "ar" ? "ج" : "S"}</Text><Text style={styles.qiblaWest}>{language === "ar" ? "غ" : "W"}</Text>
                  <View style={[styles.qiblaNeedle, { transform: [{ rotate: `${qiblaRotation}deg` }] }]}><MaterialCommunityIcons name="navigation" size={70} color={COLORS.gold} /><View style={styles.kaabaBadge}><MaterialCommunityIcons name="cube-outline" size={20} color={COLORS.white} /></View></View>
                  <View style={styles.qiblaCenter} />
                </View>
              </View>
              <View style={styles.qiblaStats}><View><Text style={styles.qiblaStatValue}>{Math.round(qiblaBearing)}°</Text><Text style={styles.qiblaStatLabel}>{language === "ar" ? "اتجاه القبلة" : "Qibla bearing"}</Text></View><View><Text style={styles.qiblaStatValue}>{Math.round(compassHeading)}°</Text><Text style={styles.qiblaStatLabel}>{language === "ar" ? "اتجاه الهاتف" : "Phone heading"}</Text></View><View><Text style={styles.qiblaStatValue}>{Math.round(kaabaDistance).toLocaleString(language === "ar" ? "ar-JO" : "en-US")}</Text><Text style={styles.qiblaStatLabel}>{language === "ar" ? "كم إلى الكعبة" : "km to Kaaba"}</Text></View></View>
              <View style={styles.qiblaAutoNote}><Ionicons name="information-circle-outline" size={17} color={COLORS.teal} /><Text style={styles.qiblaAutoNoteText}>{userLocation ? (language === "ar" ? "لا تحتاج معرفة 161° أو تحريك الهاتف إلى زاوية معينة. نقرأ اتجاه الهاتف ونحسب الفرق تلقائيًا." : "You do not need to know 161° or point your phone to a fixed angle. We read your heading and calculate the difference automatically.") : (language === "ar" ? "فعّل الموقع ليبدأ الحساب التلقائي للقبلة." : "Enable location to start automatic Qibla calculation.")}</Text></View>
              <View style={styles.compassStatus}><View style={[styles.compassStatusDot, (userLocation && headingReady) ? styles.compassStatusReady : styles.compassStatusWaiting]} /><Text style={styles.compassStatusText}>{userLocation && headingReady ? (language === "ar" ? `البوصلة جاهزة · ${headingSource === "gps" ? "اتجاه حقيقي" : "حساس الهاتف"}${headingAccuracy !== null ? ` · دقة ${Math.round(headingAccuracy)}°` : ""}` : `Compass ready · ${headingSource === "gps" ? "true heading" : "phone sensor"}`) : (language === "ar" ? "جارٍ تشغيل الموقع والحساس تلقائيًا" : "Starting location and sensors automatically")}</Text></View>
              {!locationEnabled && <Pressable style={styles.primaryModalButton} onPress={requestLocation}><Text style={styles.primaryModalText}>{language === "ar" ? "تحديد موقعي" : "Use my location"}</Text></Pressable>}
            </>}
            {activeTab === "account" && <>
              <View style={styles.accountHero}><View style={styles.accountHeroIcon}><Ionicons name={meQuery.data ? "person" : "person-outline"} size={27} color={COLORS.gold} /></View><Text style={styles.modalTitle}>{meQuery.data ? (language === "ar" ? `أهلًا ${meQuery.data.name || "بك"}` : `Welcome ${meQuery.data.name || ""}`) : ui.accountTitle}</Text><Text style={styles.modalHint}>{meQuery.data ? (language === "ar" ? "حسابك جاهز لإضافة الأماكن وكتابة التقييمات." : "Your account is ready for adding places and reviews.") : (language === "ar" ? "الحساب اختياري. تحتاجه فقط لإضافة مكان أو كتابة تقييم." : ui.accountHint)}</Text></View>
              {!meQuery.data && <View style={styles.accountAuthCard}><View style={styles.accountBenefit}><Ionicons name="shield-checkmark-outline" size={19} color={COLORS.green} /><Text style={styles.accountBenefitText}>{language === "ar" ? "بياناتك محفوظة بأمان" : "Your data stays secure"}</Text></View><Pressable style={styles.primaryModalButton} onPress={() => openEmailAuth("login")}><Text style={styles.primaryModalText}>{ui.emailLogin}</Text></Pressable><Pressable style={styles.secondaryModalButton} onPress={() => openEmailAuth("register")}><Text style={styles.secondaryModalText}>{ui.emailRegister}</Text></Pressable><Pressable style={styles.authLink} onPress={beginLogin}><Text style={styles.authLinkText}>{language === "ar" ? "تسجيل الدخول بطريقة أخرى" : "Use another sign-in method"}</Text></Pressable></View>}
              {meQuery.data && <View style={styles.accountSignedIn}><View style={styles.accountUserRow}><View style={styles.accountAvatar}><Text style={styles.accountAvatarText}>{(meQuery.data.name || "م").slice(0, 1)}</Text></View><View style={styles.accountUserCopy}><Text style={styles.accountUserName}>{meQuery.data.name || "مستخدم محرابي"}</Text><Text style={styles.accountUserHint}>{language === "ar" ? "عضو في مجتمع محرابي" : "Mehrabi community member"}</Text></View><Ionicons name="checkmark-circle" size={20} color={COLORS.green} /></View></View>}
              <View style={styles.reminderBox}>
                <View style={styles.reminderHeader}><View><Text style={styles.reminderTitle}>{language === "ar" ? "تذكير الصلاة" : "Prayer reminder"}</Text><Text style={styles.reminderHint}>{language === "ar" ? "تنبيه محلي قبل الصلاة، ويمكنك اختيار نعم أو تأجيله" : "A local reminder before prayer; choose done or snooze"}</Text></View><Pressable accessibilityRole="switch" accessibilityState={{ checked: remindersEnabled }} onPress={() => void updatePrayerReminders(!remindersEnabled)} style={[styles.reminderSwitch, remindersEnabled && styles.reminderSwitchOn]}><View style={[styles.reminderKnob, remindersEnabled && styles.reminderKnobOn]} /></Pressable></View>
                {remindersEnabled && <View style={styles.reminderMinutes}><Text style={styles.reminderMinutesLabel}>{language === "ar" ? "التنبيه قبل الصلاة بـ" : "Remind me"}</Text>{([15, 30, 45] as const).map((minutes) => <Pressable key={minutes} onPress={() => { setReminderMinutes(minutes); void updatePrayerReminders(true, minutes); }} style={[styles.minuteChip, reminderMinutes === minutes && styles.minuteChipActive]}><Text style={[styles.minuteChipText, reminderMinutes === minutes && styles.minuteChipTextActive]}>{minutes} {language === "ar" ? "دقيقة" : "min"}</Text></Pressable>)}</View>}
                {reminderScheduleError && <Text style={styles.reminderError}>{reminderScheduleError}</Text>}
                {remindersEnabled && Platform.OS === "android" && Number(Platform.Version) >= 31 && <View style={styles.exactAlarmHelp}><Text style={styles.reminderHint}>{language === "ar" ? "قد يؤخر Android التذكير إذا لم تسمح لمحرابي بالتنبيهات الدقيقة. فعّل الإذن من إعدادات النظام." : "Android may delay reminders unless Mehrabi is allowed to schedule exact alarms. Enable it in system settings."}</Text><Pressable onPress={() => void openExactAlarmSettings()} accessibilityRole="button"><Text style={styles.authLinkText}>{language === "ar" ? "ضبط التنبيهات الدقيقة" : "Set exact alarms"}</Text></Pressable></View>}
              </View>
              <View style={styles.legalLinks}><Pressable onPress={() => { setActiveTab("home"); router.push({ pathname: "/privacy" } as never); }}><Text style={styles.legalLinkText}>{language === "ar" ? "سياسة الخصوصية" : "Privacy policy"}</Text></Pressable><Text style={styles.legalSeparator}>•</Text><Pressable onPress={() => { setActiveTab("home"); router.push({ pathname: "/terms" } as never); }}><Text style={styles.legalLinkText}>{language === "ar" ? "شروط الاستخدام" : "Terms of use"}</Text></Pressable></View>
              {meQuery.data && <Pressable style={styles.secondaryModalButton} onPress={signOut}><Text style={styles.secondaryModalText}>{ui.logout}</Text></Pressable>}
            </>}
          </View>
        </View>
      </Modal>
      <Modal visible={prayerTimesVisible} animationType="slide" transparent onRequestClose={() => setPrayerTimesVisible(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modalCard}>
          <Pressable style={styles.modalClose} onPress={() => setPrayerTimesVisible(false)}><Ionicons name="close" size={22} color={COLORS.navy} /></Pressable>
          <View style={styles.dailyPrayersHeader}>
            <View style={styles.dailyPrayersTitleRow}>
              <Text style={styles.dailyPrayersTitle}>{ui.prayerTimes}</Text>
              <View style={styles.dailyPrayersDate}><Ionicons name="calendar-outline" size={13} color={COLORS.teal} /><Text style={styles.dailyPrayersDateText}>{language === "ar" ? "اليوم" : "Today"}</Text></View>
            </View>
            <Text style={styles.dailyPrayersHint}>{language === "ar" ? "مواقيت اليوم في مكان واحد" : "Today's prayer times at a glance"}</Text>
          </View>
          <View style={styles.dailyPrayersGrid}>
            {getPrayerSchedule(now, userLocation).map(([name, time]) => {
              const isNext = name === prayerState.name;
              return <View key={name} style={[styles.dailyPrayerTile, isNext && styles.dailyPrayerTileActive]}><View style={[styles.dailyPrayerIcon, isNext && styles.dailyPrayerIconActive]}><Ionicons name={name === "المغرب" || name === "العشاء" ? "moon-outline" : "sunny-outline"} size={17} color={isNext ? COLORS.gold : COLORS.teal} /></View><Text style={[styles.dailyPrayerName, isNext && styles.dailyPrayerNameActive]}>{localizePrayerName(name, language)}</Text><Text style={[styles.dailyPrayerTime, isNext && styles.dailyPrayerTimeActive]}>{formatClock(time, language)}</Text>{isNext && <View style={styles.nextPrayerBadge}><Text style={styles.nextPrayerBadgeText}>{language === "ar" ? "القادمة" : "Next"}</Text></View>}</View>;
            })}
          </View>
        </View></View>
      </Modal>
      <Modal visible={emailAuthVisible} animationType="slide" transparent onRequestClose={() => setEmailAuthVisible(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modalCard}>
          <Pressable style={styles.modalClose} onPress={() => setEmailAuthVisible(false)}><Ionicons name="close" size={22} color={COLORS.navy} /></Pressable>
          <Text style={styles.modalTitle}>{emailAuthNeedsOtp ? (language === "ar" ? "تأكيد البريد الإلكتروني" : "Verify your email") : emailAuthMode === "register" ? ui.emailRegister : emailAuthMode === "forgot" ? ui.forgotPassword : ui.emailLogin}</Text>
          {!emailAuthNeedsOtp && emailAuthMode === "register" && <TextInput value={emailAuthName} onChangeText={setEmailAuthName} placeholder={ui.name} placeholderTextColor="#8A98A5" style={styles.formInput} textAlign="right" autoCapitalize="words" />}
          {!emailAuthNeedsOtp && emailAuthMode === "register" && <TextInput value={emailAuthPhone} onChangeText={setEmailAuthPhone} placeholder={ui.phone} placeholderTextColor="#8A98A5" style={styles.formInput} textAlign="left" keyboardType="phone-pad" autoCapitalize="none" autoCorrect={false} />}
          {!emailAuthNeedsOtp && <TextInput value={emailAuthEmail} onChangeText={setEmailAuthEmail} placeholder={emailAuthMode === "login" ? ui.identifier : ui.email} placeholderTextColor="#8A98A5" style={[styles.formInput, styles.emailInput]} textAlign="left" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />}
          {!emailAuthNeedsOtp && emailAuthMode !== "forgot" && <TextInput value={emailAuthPassword} onChangeText={setEmailAuthPassword} placeholder={ui.password} placeholderTextColor="#8A98A5" style={styles.formInput} textAlign="right" secureTextEntry autoCapitalize="none" />}
          {emailAuthNeedsOtp && <TextInput value={emailAuthOtp} onChangeText={(value) => setEmailAuthOtp(value.replace(/\D/g, "").slice(0, 6))} placeholder={language === "ar" ? "رمز التحقق من 6 أرقام" : "6-digit verification code"} placeholderTextColor="#8A98A5" style={[styles.formInput, styles.otpInput]} textAlign="center" keyboardType="number-pad" maxLength={6} />}
          {emailAuthMessage && <Text style={styles.formSuccess}>{emailAuthMessage}</Text>}
          {emailAuthError && <Text style={styles.formError}>{emailAuthError}</Text>}
          <Pressable style={styles.primaryModalButton} disabled={emailAuthBusy} onPress={submitEmailAuth}><Text style={styles.primaryModalText}>{emailAuthBusy ? (language === "ar" ? "جاري المعالجة..." : "Working...") : emailAuthNeedsOtp ? (language === "ar" ? "تأكيد الرمز" : "Verify code") : emailAuthMode === "register" ? ui.createAccount : emailAuthMode === "forgot" ? ui.sendReset : ui.login}</Text></Pressable>
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
            <TextInput value={placeName} onChangeText={setPlaceName} placeholder={ui.namePlaceholder} placeholderTextColor="#8A98A5" style={styles.formInput} textAlign="right" />
            <TextInput value={placeAddress} onChangeText={setPlaceAddress} placeholder={ui.addressPlaceholder} placeholderTextColor="#8A98A5" style={styles.formInput} textAlign="right" />
            <View style={styles.typeRow}><Pressable style={[styles.typeButton, placeType === "mosque" && styles.typeButtonActive]} onPress={() => setPlaceType("mosque")}><Text style={styles.typeText}>{ui.mosques}</Text></Pressable><Pressable style={[styles.typeButton, placeType === "musalla" && styles.typeButtonActive]} onPress={() => setPlaceType("musalla")}><Text style={styles.typeText}>{ui.musallas}</Text></Pressable></View>
            <TextInput value={placeHours} onChangeText={setPlaceHours} placeholder={ui.hoursPlaceholder} placeholderTextColor="#8A98A5" style={styles.formInput} textAlign="right" />
            {placeType === "musalla" && <><TextInput value={buildingName} onChangeText={setBuildingName} placeholder={ui.buildingPlaceholder} placeholderTextColor="#8A98A5" style={styles.formInput} textAlign="right" /><TextInput value={buildingFloor} onChangeText={setBuildingFloor} placeholder={ui.floorPlaceholder} placeholderTextColor="#8A98A5" style={styles.formInput} textAlign="right" /></>}
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
          <TextInput value={reviewComment} onChangeText={setReviewComment} placeholder={ui.reviewPlaceholder} placeholderTextColor="#8A98A5" style={[styles.formInput, styles.commentInput]} multiline textAlign="right" />
          <Pressable style={styles.primaryModalButton} disabled={submitReview.isPending} onPress={() => reviewPlaceId && submitReview.mutate({ placeId: reviewPlaceId, rating: reviewRating, comment: reviewComment })}><Text style={styles.primaryModalText}>{ui.publishReview}</Text></Pressable>
        </View></View>
      </Modal>
      <View style={styles.tabBar}>
        <Pressable style={styles.tabItem} onPress={() => setActiveTab("home")}><View style={[styles.tabIconWrap, activeTab === "home" && styles.tabIconWrapActive]}><Ionicons name="home" size={20} color={activeTab === "home" ? COLORS.navy : COLORS.muted} /></View><Text style={[styles.tabText, activeTab === "home" && styles.tabActive]}>{ui.home}</Text></Pressable>
        <Pressable style={styles.tabItem} onPress={() => setActiveTab("explore")}><View style={[styles.tabIconWrap, activeTab === "explore" && styles.tabIconWrapActive]}><Ionicons name="compass-outline" size={21} color={activeTab === "explore" ? COLORS.navy : COLORS.muted} /></View><Text style={[styles.tabText, activeTab === "explore" && styles.tabActive]}>{ui.explore}</Text></Pressable>
        <Pressable style={[styles.tabItem, styles.qiblaTabItem]} onPress={() => void openQibla()}><View style={styles.qiblaTabIcon}><MaterialCommunityIcons name="compass-rose" size={25} color={COLORS.white} /></View><Text style={[styles.tabText, styles.qiblaTabText]}>{ui.qibla}</Text></Pressable>
        <Pressable style={styles.tabItem} onPress={() => setActiveTab("account")}><View style={[styles.tabIconWrap, activeTab === "account" && styles.tabIconWrapActive]}><Ionicons name="person-outline" size={20} color={activeTab === "account" ? COLORS.navy : COLORS.muted} /></View><Text style={[styles.tabText, activeTab === "account" && styles.tabActive]}>{ui.account}</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}
