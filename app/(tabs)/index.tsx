import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { CalculationMethod, Coordinates, Madhab, PrayerTimes } from "adhan";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { Magnetometer } from "expo-sensors";
import { useRouter } from "expo-router";
import { createElement, useEffect, useMemo, useRef, useState } from "react";
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
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { trpc } from "@/lib/trpc";
import { getApiBaseUrl, startOAuthLogin } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";
import { buildPrayerReminderBody, PRAYER_REMINDER_DAYS } from "@/lib/prayerReminders";
import { bearingToKaaba, distanceToKaabaKm, isHeadingReliable, qiblaScreenOffset, shortestSignedAngle } from "@/lib/qibla";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { filterApprovedPlaces } from "@/shared/place-visibility";

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
  sourceKey?: string | null;
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
const REMINDER_STATE_KEY = "maslay.prayer-reminder-state.v2";
const PLACES_CACHE_KEY = "maslay.places-cache.v2";
const PRAYER_REMINDER_CHANNEL = "prayer-reminders-v3";
const PRAYER_REMINDER_SOUND = "mehrabi_reminder.wav";

type ReminderEntry = { key: string; prayerName: string; triggerAt: number };
type ReminderGeneration = {
  generationId: string;
  status: "building" | "active" | "failed";
  expectedEntries: ReminderEntry[];
  notificationIds: string[];
  createdAt: number;
};
type ReminderState = { activeGenerationId: string | null; generations: ReminderGeneration[] };

let prayerReminderQueue: Promise<void> = Promise.resolve();

const enqueuePrayerReminderWork = <T,>(work: () => Promise<T>) => {
  const next = prayerReminderQueue.catch(() => undefined).then(work);
  prayerReminderQueue = next.then(() => undefined, () => undefined);
  return next;
};

const newReminderGenerationId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const readReminderState = async (): Promise<ReminderState> => {
  const stored = await AsyncStorage.getItem(REMINDER_STATE_KEY);
  if (!stored) return { activeGenerationId: null, generations: [] };
  try {
    const parsed = JSON.parse(stored) as Partial<ReminderState>;
    const generations = Array.isArray(parsed.generations) ? parsed.generations : [];
    return {
      activeGenerationId: typeof parsed.activeGenerationId === "string" ? parsed.activeGenerationId : null,
      generations: generations.filter((generation): generation is ReminderGeneration =>
        Boolean(generation && typeof generation.generationId === "string" && Array.isArray(generation.expectedEntries) && Array.isArray(generation.notificationIds)),
      ),
    };
  } catch {
    return { activeGenerationId: null, generations: [] };
  }
};

const writeReminderState = (state: ReminderState) => AsyncStorage.setItem(REMINDER_STATE_KEY, JSON.stringify(state));

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
      sound: PRAYER_REMINDER_SOUND,
    });
  }
  return true;
};

const clearPrayerReminderSchedule = async () => {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const ids = new Set<string>();
  for (const item of scheduled) {
    const data = item.content.data as { prayerReminder?: boolean } | undefined;
    if (data?.prayerReminder === true) ids.add(item.identifier);
  }
  const state = await readReminderState();
  state.generations.forEach((generation) => generation.notificationIds.forEach((id) => ids.add(id)));
  const legacy = await AsyncStorage.getItem(REMINDER_IDS_KEY);
  if (legacy) {
    try {
      (JSON.parse(legacy) as unknown[]).forEach((id) => { if (typeof id === "string") ids.add(id); });
    } catch { /* Ignore malformed legacy state; scheduled metadata above is authoritative. */ }
  }
  await Promise.all([...ids].map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)));
  await AsyncStorage.multiRemove([REMINDER_IDS_KEY, REMINDER_STATE_KEY]);
};

const getScheduledTriggerAt = (item: Notifications.NotificationRequest) => {
  const trigger = item.trigger as { date?: Date | number } | null;
  if (!trigger || trigger.date === undefined) return null;
  return typeof trigger.date === "number" ? trigger.date : trigger.date instanceof Date ? trigger.date.getTime() : null;
};

const schedulePrayerReminders = (minutesBefore: number, location: { lat: number; lng: number } | null) =>
  enqueuePrayerReminderWork(async () => {
    if (Platform.OS === "web") return;
    const generationId = newReminderGenerationId();
    const now = new Date();
    const expectedEntries: ReminderEntry[] = [];
    const scheduledKeys = new Set<string>();
    const firstJordanDate = getJordanCalendarDate(now);
    for (let dayOffset = 0; dayOffset < PRAYER_REMINDER_DAYS; dayOffset += 1) {
      const date = new Date(firstJordanDate.getTime());
      date.setDate(date.getDate() + dayOffset);
      const prayerSchedule = getPrayerSchedule(date, location);
      for (const [name, prayerTime] of prayerSchedule) {
        const triggerAt = prayerTime.getTime() - minutesBefore * 60 * 1000;
        if (triggerAt <= now.getTime()) continue;
        const key = `${name}:${triggerAt}`;
        if (scheduledKeys.has(key)) continue;
        scheduledKeys.add(key);
        expectedEntries.push({ key, prayerName: name, triggerAt });
      }
    }
    const state = await readReminderState();
    const building: ReminderGeneration = { generationId, status: "building", expectedEntries, notificationIds: [], createdAt: Date.now() };
    await writeReminderState({ ...state, generations: [...state.generations, building] });
    try {
      for (const entry of expectedEntries) {
        const prayerSchedule = getPrayerSchedule(new Date(entry.triggerAt + minutesBefore * 60 * 1000), location);
        const prayerNames = prayerSchedule.map(([name]) => name);
        const notificationId = await Notifications.scheduleNotificationAsync({
          content: {
            title: "نداء محرابي",
            body: buildPrayerReminderBody(minutesBefore, entry.prayerName, prayerNames),
            sound: PRAYER_REMINDER_SOUND,
            data: { prayerName: entry.prayerName, reminderKey: entry.key, generationId, prayerReminder: true },
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(entry.triggerAt), channelId: PRAYER_REMINDER_CHANNEL },
        });
        building.notificationIds.push(notificationId);
        await writeReminderState({ ...state, generations: [...state.generations.filter((item) => item.generationId !== generationId), building] });
        console.info("[PrayerReminder] scheduled", { prayerName: entry.prayerName, prayerTimeISO: new Date(entry.triggerAt + minutesBefore * 60 * 1000).toISOString(), triggerTimeISO: new Date(entry.triggerAt).toISOString(), nowISO: now.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, minutesBefore, generationId });
      }
      const actual = await Notifications.getAllScheduledNotificationsAsync();
      const actualForGeneration = actual.filter((item) => (item.content.data as { generationId?: string } | undefined)?.generationId === generationId);
      const valid = expectedEntries.every((entry) => actualForGeneration.some((item) => {
        const data = item.content.data as { reminderKey?: string; prayerName?: string } | undefined;
        const actualTrigger = getScheduledTriggerAt(item);
        return data?.reminderKey === entry.key && data.prayerName === entry.prayerName && actualTrigger !== null && Math.abs(actualTrigger - entry.triggerAt) <= 5000;
      }));
      if (!valid) throw new Error(`Reminder generation ${generationId} failed verification (${actualForGeneration.length}/${expectedEntries.length})`);
      const activeState = await readReminderState();
      const oldGenerations = activeState.generations.filter((item) => item.generationId !== generationId);
      const orphanedPrayerIds = actual
        .filter((item) => {
          const data = item.content.data as { prayerReminder?: boolean; generationId?: string } | undefined;
          return data?.prayerReminder === true && data.generationId !== generationId;
        })
        .map((item) => item.identifier);
      const legacyIds: string[] = [];
      const legacyStored = await AsyncStorage.getItem(REMINDER_IDS_KEY);
      if (legacyStored) {
        try {
          (JSON.parse(legacyStored) as unknown[]).forEach((id) => { if (typeof id === "string") legacyIds.push(id); });
        } catch { /* Ignore malformed legacy state. */ }
      }
      await writeReminderState({ activeGenerationId: generationId, generations: [...activeState.generations.filter((item) => item.generationId !== generationId), { ...building, status: "active" }] });
      await Promise.all([...oldGenerations.flatMap((generation) => generation.notificationIds), ...legacyIds, ...orphanedPrayerIds].map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)));
      await AsyncStorage.removeItem(REMINDER_IDS_KEY);
      await writeReminderState({ activeGenerationId: generationId, generations: [{ ...building, status: "active" }] });
    } catch (error) {
      await Promise.all(building.notificationIds.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)));
      const latestState = await readReminderState();
      await writeReminderState({ activeGenerationId: latestState.activeGenerationId === generationId ? null : latestState.activeGenerationId, generations: latestState.generations.filter((item) => item.generationId !== generationId) });
      throw error;
    }
  });

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
  // Jordan calibration: the Ministry of Awqaf timetable is closest to the
  // Karachi angles, with local minute adjustments for Amman/Jordan.
  const params = CalculationMethod.Karachi();
  params.madhab = Madhab.Shafi;
  params.adjustments = { fajr: 0, sunrise: 0, dhuhr: -1, asr: 1, maghrib: 6, isha: 0 };
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

const getDynamicGreeting = (date: Date, language: "ar" | "en") => {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: JORDAN_TIME_ZONE, hour: "numeric", hour12: false }).format(date));
  if (language === "ar") return hour < 12 ? "صباح النور" : hour < 18 ? "مساء الخير" : "ليلة هادئة";
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};

const formatCountdown = (target: Date, now: Date) => {
  const seconds = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const rest = (seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
};

const createOsmHtml = (places: Place[], userLocation: { lat: number; lng: number } | null) => {
  const points = JSON.stringify(places.map((place) => [place.lat, place.lng, place.name, place.type]))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const center = userLocation ? `[${userLocation.lat},${userLocation.lng}]` : "[31.9539,35.9106]";
  const userMarker = userLocation ? `L.circleMarker([${userLocation.lat},${userLocation.lng}],{radius:8,color:'#4A94F5',fillColor:'#4A94F5',fillOpacity:.9}).addTo(map).bindPopup('موقعك الحالي');` : "";
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><style>html,body,#map{height:100%;margin:0;background:#e3efef}.leaflet-control-attribution{font-size:8px}</style></head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>const map=L.map('map',{zoomControl:false}).setView(${center},13);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);const points=${points};points.forEach(([lat,lng,name,type])=>{const color=type==='مسجد'?'#2B9A76':'#7C8EDB';const marker=L.circleMarker([lat,lng],{radius:8,color:'#fff',weight:2,fillColor:color,fillOpacity:.98}).addTo(map);const popup=document.createElement('div');const title=document.createElement('strong');title.textContent=String(name);popup.appendChild(title);popup.appendChild(document.createElement('br'));popup.appendChild(document.createTextNode(String(type)));marker.bindPopup(popup)});${userMarker}</script></body></html>`;
};

const createPickerHtml = (location: { lat: number; lng: number }) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>const map=L.map('map').setView([${location.lat},${location.lng}],16);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);let marker=L.marker([${location.lat},${location.lng}]).addTo(map);map.on('click',e=>{marker.setLatLng(e.latlng);window.ReactNativeWebView.postMessage(JSON.stringify({lat:e.latlng.lat,lng:e.latlng.lng}))});</script></body></html>`;

export default function HomeScreen() {
  const router = useRouter();
  const { width: viewportWidth } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [placeOffset, setPlaceOffset] = useState(0);
  const [loadedApiPlaces, setLoadedApiPlaces] = useState<any[]>([]);
  const [usingCachedPlaces, setUsingCachedPlaces] = useState(false);
  const [activeFilter, setActiveFilter] = useState("nearest");
  const [placeTypeFilter, setPlaceTypeFilter] = useState<"all" | "mosque" | "musalla">("all");
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [language, setLanguage] = useState<"ar" | "en">("ar");
  const [now, setNow] = useState(() => new Date());
  const [compassHeading, setCompassHeading] = useState(0);
  const [headingReady, setHeadingReady] = useState(false);
  const [headingSource, setHeadingSource] = useState<"gps" | "sensor" | null>(null);
  const [headingAccuracy, setHeadingAccuracy] = useState<number | null>(null);
  const [usesTrueNorth, setUsesTrueNorth] = useState(false);
  const [headingUpdatedAt, setHeadingUpdatedAt] = useState<number | null>(null);
  const [appIsActive, setAppIsActive] = useState(true);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [qiblaCameraMode, setQiblaCameraMode] = useState(true);
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
  const reminderSettingsLoadedRef = useRef(false);
  const reminderScheduleKeyRef = useRef<string | null>(null);
  const reminderSchedulingRef = useRef(false);
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
  const favoriteIdsQuery = trpc.places.favoriteIds.useQuery({ userId: meQuery.data?.id ?? 0 }, {
    enabled: Boolean(meQuery.data),
    staleTime: 0,
  });
  const favorites = meQuery.data ? (favoriteIdsQuery.data ?? []).map(String) : [];
  const trpcUtils = trpc.useUtils();
  const logoutMutation = trpc.auth.logout.useMutation();
  const setFavoriteMutation = trpc.places.setFavorite.useMutation({
    onSuccess: async () => { await favoriteIdsQuery.refetch(); },
    onError: (error) => Alert.alert(language === "ar" ? "تعذر تحديث المفضلة" : "Could not update favorites", error.message),
  });
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
      await enqueuePrayerReminderWork(clearPrayerReminderSchedule);
      reminderScheduleKeyRef.current = null;
    }
    setReminderMinutes(minutes as 15 | 30 | 45);
    setRemindersEnabled(enabled);
    await AsyncStorage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify({ enabled, minutes }));
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
      reminderSettingsLoadedRef.current = true;
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
    if (Platform.OS === "web" || !reminderSettingsLoadedRef.current) return;
    if (!remindersEnabled) return;
    const jordanToday = getJordanCalendarDate(now);
    const locationKey = userLocation ? `${userLocation.lat.toFixed(3)},${userLocation.lng.toFixed(3)}` : "default";
    const scheduleKey = `${jordanToday.getFullYear()}-${jordanToday.getMonth()}-${jordanToday.getDate()}-${reminderMinutes}-${locationKey}`;
    if (reminderScheduleKeyRef.current === scheduleKey || reminderSchedulingRef.current) return;
    reminderSchedulingRef.current = true;
    void schedulePrayerReminders(reminderMinutes, userLocation)
      .then(() => {
        reminderScheduleKeyRef.current = scheduleKey;
      })
      .catch((error) => {
        console.warn("Prayer reminder scheduling failed; it will be retried.", error);
      })
      .finally(() => {
        reminderSchedulingRef.current = false;
      });
  }, [now, remindersEnabled, reminderMinutes, userLocation]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && remindersEnabled && !reminderSchedulingRef.current) {
        reminderScheduleKeyRef.current = null;
        reminderSchedulingRef.current = true;
        void schedulePrayerReminders(reminderMinutes, userLocation)
          .catch((error) => {
            console.warn("Prayer reminder foreground refresh failed; it will be retried.", error);
          })
          .finally(() => {
            reminderSchedulingRef.current = false;
          });
      }
    });
    return () => subscription.remove();
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
    const approvedPage = filterApprovedPlaces(placesQuery.data);
    // Synchronize the accumulated view with the latest server page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadedApiPlaces((current) => {
      const approvedCurrent = filterApprovedPlaces(current);
      if (placeOffset === 0) return approvedPage;
      const known = new Set(approvedCurrent.map((place) => place.id));
      return [...approvedCurrent, ...approvedPage.filter((place) => !known.has(place.id))];
    });
    void AsyncStorage.setItem(PLACES_CACHE_KEY, JSON.stringify(approvedPage));
    setUsingCachedPlaces(false);
  }, [activeFilter, placeOffset, placesQuery.data, userLocation]);

  useEffect(() => {
    void AsyncStorage.getItem(PLACES_CACHE_KEY).then((value) => {
      if (!value || loadedApiPlaces.length > 0 || placesQuery.data) return;
      try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return;
        const cached = filterApprovedPlaces(parsed as any[]);
        if (cached.length > 0) {
          setLoadedApiPlaces(cached);
          setUsingCachedPlaces(true);
        }
      } catch { /* ignore an invalid cache and continue with the network */ }
    });
  }, [loadedApiPlaces.length, placesQuery.data]);

  useEffect(() => {
    if (activeFilter !== "nearest" || !nearestPlaces.data) return;
    const approvedNearest = filterApprovedPlaces(nearestPlaces.data);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadedApiPlaces((current) => {
      const approvedCurrent = filterApprovedPlaces(current);
      if (placeOffset === 0) return approvedNearest;
      const known = new Set(approvedCurrent.map((place) => place.id));
      return [...approvedCurrent, ...approvedNearest.filter((place) => !known.has(place.id))];
    });
  }, [activeFilter, nearestPlaces.data, placeOffset]);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const subscription = AppState.addEventListener("change", (state) => {
      setAppIsActive(state === "active");
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

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
    if (Platform.OS === "web" || activeTab !== "qibla" || !appIsActive) return;
    if (cameraPermission?.granted || cameraPermission?.canAskAgain === false) return;
    void requestCameraPermission().catch(() => undefined);
  }, [activeTab, appIsActive, cameraPermission?.canAskAgain, cameraPermission?.granted, requestCameraPermission]);

  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    let magnetometerSubscription: { remove: () => void } | null = null;
    if (activeTab !== "qibla" || !appIsActive) {
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
      setHeadingUpdatedAt(Date.now());
    };
    if (Platform.OS !== "web") void Magnetometer.requestPermissionsAsync().catch(() => undefined);
    Location.watchHeadingAsync((heading) => {
      // trueHeading is corrected for magnetic declination when available.
      const value = heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
      if (Number.isFinite(value)) {
        headingStreamRef.current = true;
        setHeadingSource("gps");
        setUsesTrueNorth(heading.trueHeading >= 0);
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
        setUsesTrueNorth(false);
        setHeadingAccuracy(null);
        smoothHeading((360 - heading + 360) % 360);
      });
    }
    return () => {
      subscription?.remove();
      magnetometerSubscription?.remove();
      headingStreamRef.current = false;
    };
  }, [activeTab, appIsActive, locationEnabled]);

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
  const qiblaRotation = shortestSignedAngle(qiblaBearing, compassHeading);
  const qiblaHeadingReliable = Boolean(userLocation) && isHeadingReliable({ headingReady, headingUpdatedAt, headingSource, headingAccuracy, usesTrueNorth });
  const qiblaMarkerOffset = qiblaScreenOffset(qiblaRotation, Math.max(280, viewportWidth - 80));
  const kaabaDistance = distanceToKaabaKm(userLocation?.lat ?? 31.9539, userLocation?.lng ?? 35.9106);

  const apiPlaces: Place[] = filterApprovedPlaces(loadedApiPlaces).map((place) => ({
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
    sourceKey: place.sourceKey,
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
    if (placeTypeFilter === "mosque") result = result.filter((place) => place.type === "مسجد");
    if (placeTypeFilter === "musalla") result = result.filter((place) => place.type !== "مسجد");
    return result.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }, [activeFilter, favorites, placeTypeFilter, query, sourcePlaces]);

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
    if (!meQuery.data) {
      setActiveTab("account");
      return;
    }
    const placeId = Number(id);
    if (!Number.isSafeInteger(placeId) || placeId <= 0 || setFavoriteMutation.isPending) return;
    setFavoriteMutation.mutate({ placeId, enabled: !favorites.includes(id) });
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
    setUsesTrueNorth(false);
    setHeadingUpdatedAt(null);
    setQiblaCameraMode(true);
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
      const endpoint = emailAuthNeedsOtp ? "verify-otp" : emailAuthMode === "register" ? "register" : emailAuthMode === "forgot" ? "forgot-password" : "login";
      const body = emailAuthNeedsOtp
        ? { email: emailAuthEmail, code: emailAuthOtp }
        : emailAuthMode === "register"
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
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string; app_session_id?: string; code?: string; verificationRequired?: boolean };
      if (!response.ok) {
        if (payload.code === "EMAIL_AUTH_UNAVAILABLE") {
          throw new Error(language === "ar" ? payload.error || "استخدم تسجيل الدخول عبر Manus." : "Email sign-up is unavailable until outgoing email is configured. Use Manus sign-in.");
        }
        if (payload.code === "EMAIL_NOT_VERIFIED" && emailAuthMode === "login") {
          setEmailAuthNeedsOtp(true);
          setEmailAuthCanResend(true);
          setEmailAuthMessage(language === "ar" ? "أكد بريدك برمز التحقق لإكمال تسجيل الدخول." : "Verify your email with the code to continue.");
          return;
        }
        throw new Error(payload.error || (language === "ar" ? "تعذر إكمال العملية." : "Unable to complete the request."));
      }
      if (emailAuthMode === "register" && payload.verificationRequired) {
        setEmailAuthNeedsOtp(true);
        setEmailAuthCanResend(true);
        setEmailAuthMessage(language === "ar" ? "أدخل رمز التحقق الذي أُرسل إلى بريدك الإلكتروني." : "Enter the verification code sent to your email.");
      } else if (emailAuthMode === "login" || emailAuthNeedsOtp) {
        if (payload.app_session_id) await Auth.setSessionToken(payload.app_session_id);
        await meQuery.refetch();
        setEmailAuthNeedsOtp(false);
        setEmailAuthCanResend(false);
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
    const userId = meQuery.data?.id;
    if (userId) await trpcUtils.places.favoriteIds.cancel({ userId });
    try {
      await logoutMutation.mutateAsync();
    } catch (error) {
      if (userId) void favoriteIdsQuery.refetch();
      Alert.alert(
        language === "ar" ? "تعذر تسجيل الخروج" : "Could not sign out",
        language === "ar" ? "تحقق من الاتصال وحاول مجددًا؛ بقيت جلستك فعالة." : "Check your connection and try again; your session remains active.",
      );
      return;
    }
    await Auth.removeSessionToken();
    await Auth.clearUserInfo();
    await trpcUtils.auth.me.cancel();
    trpcUtils.auth.me.setData(undefined, null);
    if (userId) {
      await trpcUtils.places.favoriteIds.cancel({ userId });
      trpcUtils.places.favoriteIds.setData({ userId }, []);
    }
    await meQuery.refetch({ cancelRefetch: true });
    setActiveTab("home");
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
      void beginLogin();
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

        <View style={styles.quickActions}>
          <Pressable style={styles.quickAction} onPress={() => void openQibla()}>
            <View style={[styles.quickIcon, styles.quickIconGold]}><MaterialCommunityIcons name="compass-rose" size={21} color={COLORS.navy} /></View>
            <Text style={styles.quickActionText}>{ui.qibla}</Text>
            <Text style={styles.quickActionHint}>{language === "ar" ? "اتجاه دقيق" : "Accurate bearing"}</Text>
          </Pressable>
          <Pressable style={styles.quickAction} onPress={() => setActiveTab("explore")}>
            <View style={[styles.quickIcon, styles.quickIconTeal]}><Ionicons name="compass-outline" size={21} color={COLORS.navy} /></View>
            <Text style={styles.quickActionText}>{ui.explore}</Text>
            <Text style={styles.quickActionHint}>{language === "ar" ? "اكتشف حولك" : "Discover nearby"}</Text>
          </Pressable>
          <Pressable style={styles.quickAction} onPress={openAddPlace}>
            <View style={[styles.quickIcon, styles.quickIconBlue]}><Ionicons name="add" size={22} color={COLORS.navy} /></View>
            <Text style={styles.quickActionText}>{ui.add}</Text>
            <Text style={styles.quickActionHint}>{language === "ar" ? "شارك الخير" : "Add a place"}</Text>
          </Pressable>
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

        <View style={styles.discoveryCard}>
          <View style={styles.discoveryTitleRow}>
            <View style={styles.discoveryIcon}><Ionicons name="sparkles-outline" size={18} color={COLORS.gold} /></View>
            <View style={styles.discoveryCopy}><Text style={styles.discoveryEyebrow}>{language === "ar" ? "اعثر على مكان صلاتك" : "Find your prayer place"}</Text><Text style={styles.discoveryTitle}>{language === "ar" ? "أين ستصلي اليوم؟" : "Where will you pray today?"}</Text></View>
          </View>
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={19} color={COLORS.muted} />
            <TextInput value={query} onChangeText={setQuery} placeholder={ui.search} placeholderTextColor="#9DA8B3" style={styles.searchInput} textAlign="right" />
            {query.length > 0 ? <Pressable onPress={() => setQuery("")}><Ionicons name="close-circle" size={18} color={COLORS.muted} /></Pressable> : <View style={styles.shortcut}><Text style={styles.shortcutText}>⌘ K</Text></View>}
          </View>
          <View style={styles.typeSegmentRow}>
            {([{ key: "all", label: language === "ar" ? "الكل" : "All", icon: "map-outline" }, { key: "mosque", label: ui.mosques, icon: "mosque" }, { key: "musalla", label: ui.musallas, icon: "home-city-outline" }] as const).map((option) => {
              const selected = placeTypeFilter === option.key;
              return <Pressable key={option.key} onPress={() => setPlaceTypeFilter(option.key)} style={[styles.typeSegment, selected && styles.typeSegmentActive, option.key === "mosque" && selected && styles.typeSegmentMosque, option.key === "musalla" && selected && styles.typeSegmentMusalla]}><MaterialCommunityIcons name={option.icon as any} size={16} color={selected ? COLORS.white : option.key === "mosque" ? COLORS.mosqueGreen : option.key === "musalla" ? COLORS.musallaBlue : COLORS.muted} /><Text style={[styles.typeSegmentText, selected && styles.typeSegmentTextActive]}>{option.label}</Text></Pressable>;
            })}
          </View>
          <Pressable style={styles.filterButton} onPress={() => setActiveTab("explore")}><Ionicons name="options-outline" size={16} color={COLORS.navy} /><Text style={styles.filterButtonText}>{language === "ar" ? "تصفية وترتيب" : "Filter & sort"}</Text><Text style={styles.filterButtonValue}>{activeFilter === "nearest" ? ui.nearest : filterOptions.find((item) => item.key === activeFilter)?.label}</Text></Pressable>
        </View>

        <View style={styles.mapCard}>
          {Platform.OS !== "web" ? <WebView source={{ html: createOsmHtml(sourcePlaces, userLocation) }} style={styles.nativeMap} originWhitelist={["*"]} javaScriptEnabled /> : createElement("iframe", { title: language === "ar" ? "خريطة الأماكن المعتمدة" : "Approved places map", srcDoc: createOsmHtml(sourcePlaces, userLocation), loading: "lazy", referrerPolicy: "no-referrer", style: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: 0 } })}
          <View style={styles.mapHeader}><View style={styles.mapTitleBadge}><Ionicons name="navigate-outline" size={13} color={COLORS.green} /><Text style={styles.mapBadge}>{ui.mapLocation}</Text></View><Text style={styles.mapProvider}>OpenStreetMap</Text></View>
          <Pressable style={styles.mapControl} onPress={requestLocation}><Ionicons name="locate" size={19} color={COLORS.navy} /></Pressable>
          <View style={styles.mapLegend}><View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: COLORS.mosqueGreen }]} /><Text style={styles.legendText}>{ui.mosques}</Text></View><View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: COLORS.musallaBlue }]} /><Text style={styles.legendText}>{ui.musallas}</Text></View>{locationEnabled && <View style={styles.legendItem}><View style={[styles.legendDot, styles.legendLocation]} /><Text style={styles.legendText}>{language === "ar" ? "موقعك" : "You"}</Text></View>}</View>
        </View>

        {usingCachedPlaces && <Text style={styles.offlineNotice}>{language === "ar" ? "تُعرض آخر بيانات محفوظة — سنحدّثها عند عودة الاتصال" : "Showing saved data — it will refresh when you are online"}</Text>}
        <View style={styles.listHeader}><Text style={styles.nearbyCount}>{filteredPlaces.length} {ui.nearbyCount}</Text><Pressable onPress={() => setActiveFilter("nearest")}><Text style={styles.sortText}>{ui.nearest}</Text></Pressable></View>
        {activeFilter === "favorites" && filteredPlaces.length === 0 && <Text style={styles.offlineNotice}>{!meQuery.data ? (language === "ar" ? "سجّل الدخول من تبويب حسابي لعرض المفضلة وحفظها." : "Sign in from the Account tab to view and save favorites.") : (language === "ar" ? "لم تحفظ أي مكان في المفضلة بعد." : "You have not saved any places yet.")}</Text>}
        {placeGroups.map(({ groupTitle, groupPlaces }) => groupPlaces.length > 0 && <View key={groupTitle}>
          <Text style={[styles.groupTitle, groupTitle === ui.mosques ? styles.mosqueTitle : styles.musallaTitle]}>{groupTitle}</Text>
          {groupPlaces.map((place) => (
          <View key={place.id} style={[styles.placeCard, place.type === "مسجد" ? styles.mosqueCard : styles.musallaCard]}>
            <View style={styles.placeMain}>
              <View style={[styles.placeIcon, place.type === "مسجد" ? styles.mosqueIcon : styles.musallaIcon]}><MaterialCommunityIcons name={place.type === "مسجد" ? "mosque" : "home-city-outline"} size={22} color={place.type === "مسجد" ? COLORS.mosqueGreen : COLORS.musallaBlue} /></View>
              <View style={styles.placeInfo}>
                <View style={styles.nameRow}><Text style={styles.placeName}>{place.name}</Text>{place.sourceKey && <View style={styles.officialPlacePill}><Text style={styles.officialPlaceText}>{language === "ar" ? "رسمي" : "Official"}</Text></View>}<View style={[styles.typePill, place.type === "مسجد" ? styles.typePillMosque : styles.typePillMusalla]}><Text style={styles.typePillText}>{language === "ar" ? place.type : (place.type === "مسجد" ? "Mosque" : "Musalla")}</Text></View></View>
                <View style={styles.statusRow}>{place.status === "pending" && <View style={styles.unverifiedPill}><Ionicons name="time-outline" size={11} color={COLORS.muted} /><Text style={styles.unverifiedText}>{ui.unverified}</Text></View>}<View style={[styles.openPill, place.open === false && styles.closedPill, place.open === null && styles.unknownPill]}><Text style={[styles.openText, place.open === false && styles.closedText, place.open === null && styles.unknownText]}>{place.open === true ? (language === "ar" ? "مفتوح" : "Open") : place.open === false ? (language === "ar" ? "مغلق" : "Closed") : ui.unknownHours}</Text></View></View>
                <View style={styles.distanceRow}><Text style={styles.distanceValue}>{place.distance}</Text><Text style={styles.distanceHint}>{language === "ar" ? "على بُعد دقائق منك" : "minutes away"}</Text></View>
                <View style={styles.amenities}><Text style={styles.metaTime}>{language === "ar" ? "قريب" : "Nearby"}</Text>{place.ablution && <Text style={styles.amenity}><Ionicons name="water" size={13} color={COLORS.teal} /> {language === "ar" ? "وضوء" : "Ablution"}</Text>}{place.parking && <Text style={styles.amenity}><Ionicons name="car" size={13} color={COLORS.muted} /> {language === "ar" ? "موقف" : "Parking"}</Text>}</View>
              </View>
            </View>
            <View style={styles.placeActions}>
              <Pressable onPress={() => toggleFavorite(place.id)} style={styles.iconAction}><Ionicons name={favorites.includes(place.id) ? "heart" : "heart-outline"} size={18} color={favorites.includes(place.id) ? COLORS.red : COLORS.muted} /></Pressable>
              <Pressable onPress={() => { setReviewPlaceId(Number(place.id)); if (meQuery.data) setReviewVisible(true); else openEmailAuth("login"); }} style={styles.iconAction}><Ionicons name="star-outline" size={18} color={COLORS.gold} /></Pressable>
              <Pressable onPress={() => sharePlace(place)} style={styles.iconAction}><Ionicons name="share-social-outline" size={18} color={COLORS.muted} /></Pressable>
              <Pressable onPress={() => openMaps(place)} style={styles.goButton}><Ionicons name="navigate" size={16} color={COLORS.white} /><Text style={styles.goText}>{language === "ar" ? "الطريق" : "Directions"}</Text></Pressable>
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
              <View style={styles.exploreHero}><View style={styles.exploreHeroIcon}><Ionicons name="compass-outline" size={25} color={COLORS.gold} /></View><Text style={styles.modalTitle}>{language === "ar" ? "اكتشف أماكن الصلاة حولك" : "Discover prayer places nearby"}</Text><Text style={styles.modalHint}>{language === "ar" ? "ابحث عن أقرب مسجد أو مصلى يناسب احتياجك." : "Find the nearest mosque or musalla for your needs."}</Text></View>
              <View style={styles.exploreTypeCards}>
                <Pressable style={[styles.exploreTypeCard, styles.exploreMosqueCard]} onPress={() => { setPlaceTypeFilter("mosque"); setActiveFilter("nearest"); setActiveTab("home"); }}><View style={styles.exploreCardIcon}><MaterialCommunityIcons name="mosque" size={23} color={COLORS.mosqueGreen} /></View><Text style={styles.exploreCardTitle}>{ui.mosques}</Text><Text style={styles.exploreCardCount}>{mosques.length} {language === "ar" ? "قريب" : "nearby"}</Text><Text style={styles.exploreCardAction}>{language === "ar" ? "عرض المساجد ←" : "View mosques →"}</Text></Pressable>
                <Pressable style={[styles.exploreTypeCard, styles.exploreMusallaCard]} onPress={() => { setPlaceTypeFilter("musalla"); setActiveFilter("nearest"); setActiveTab("home"); }}><View style={[styles.exploreCardIcon, styles.exploreCardIconBlue]}><MaterialCommunityIcons name="home-city-outline" size={23} color={COLORS.musallaBlue} /></View><Text style={styles.exploreCardTitle}>{ui.musallas}</Text><Text style={styles.exploreCardCount}>{musallas.length} {language === "ar" ? "قريب" : "nearby"}</Text><Text style={styles.exploreCardAction}>{language === "ar" ? "عرض المصليات ←" : "View musallas →"}</Text></Pressable>
              </View>
              <View style={styles.exploreLocationNote}><Ionicons name={locationEnabled ? "checkmark-circle" : "location-outline"} size={17} color={locationEnabled ? COLORS.green : COLORS.gold} /><Text style={styles.exploreLocationText}>{locationEnabled ? (language === "ar" ? "نعرض لك الأماكن الأقرب حسب موقعك الحالي." : "Showing places nearest to your current location.") : (language === "ar" ? "فعّل موقعك لنقترح الأماكن الأقرب لك." : "Enable your location for the nearest places.")}</Text></View>
              <Pressable
                style={styles.officialDirectoryButton}
                onPress={() => {
                  setActiveTab("home");
                  router.push({ pathname: "/(tabs)/official", params: { lang: language } });
                }}
              >
                <View style={styles.officialDirectoryIcon}><Ionicons name="business-outline" size={18} color={COLORS.gold} /></View>
                <View style={styles.officialDirectoryCopy}>
                  <Text style={styles.officialDirectoryTitle}>{language === "ar" ? "دليل المساجد الرسمي" : "Official mosque directory"}</Text>
                  <Text style={styles.officialDirectoryHint}>{language === "ar" ? "سجلات وزارة الأوقاف الأردنية" : "Jordan Ministry of Awqaf records"}</Text>
                </View>
                <Ionicons name="chevron-back" size={17} color={COLORS.teal} />
              </Pressable>
              <Text style={styles.exploreQuickTitle}>{language === "ar" ? "اختصارات ذكية" : "Smart shortcuts"}</Text>
              <View style={styles.exploreQuickGrid}>{filterOptions.filter((filter) => filter.key !== "nearest").map((filter) => <Pressable key={filter.key} style={styles.exploreQuickItem} onPress={() => { setPlaceTypeFilter("all"); setActiveFilter(filter.key); setActiveTab("home"); }}><Ionicons name={filter.key === "open" ? "time-outline" : filter.key === "ablution" ? "water-outline" : filter.key === "women" ? "people-outline" : "heart-outline"} size={17} color={COLORS.teal} /><Text style={styles.exploreQuickText}>{filter.label}</Text><Ionicons name="chevron-back" size={15} color={COLORS.muted} /></Pressable>)}</View>
            </>}
            {activeTab === "qibla" && <>
              {qiblaCameraMode && cameraPermission?.granted && Platform.OS !== "web" && appIsActive ? <View style={styles.qiblaArFrame}>
                <CameraView style={styles.qiblaCamera} facing="back" />
                <View style={styles.qiblaArShade} />
                <View style={styles.qiblaArTopShade} />
                <View style={styles.qiblaArBottomShade} />
                <View style={styles.qiblaArReticle}><View style={styles.qiblaArCrosshair} /><View style={[styles.qiblaArKaaba, { transform: [{ translateX: qiblaMarkerOffset }] }]}><View style={styles.kaabaIllustration}><View style={styles.kaabaIllustrationBand} /><View style={styles.kaabaIllustrationDoor} /></View><Text style={styles.qiblaArKaabaLabel}>{language === "ar" ? "الكعبة" : "Kaaba"}</Text></View><View style={[styles.qiblaArDirection, { transform: [{ rotate: `${qiblaRotation}deg` }] }]}><MaterialCommunityIcons name="navigation" size={52} color={COLORS.gold} /></View></View>
                <View style={styles.qiblaArTopBadge}><Ionicons name="scan-outline" size={15} color={COLORS.gold} /><Text style={styles.qiblaArTopText}>{language === "ar" ? "القبلة بالواقع المعزز" : "AR Qibla"}</Text></View>
                <View style={styles.qiblaArBottomBadge}><Text style={styles.qiblaArBottomText}>{!userLocation ? (language === "ar" ? "جارٍ تحديد موقعك" : "Finding your location") : !qiblaHeadingReliable ? (language === "ar" ? "جارٍ تحديد الاتجاه — حرّك الهاتف ببطء" : "Finding direction — move the phone slowly") : Math.abs(qiblaRotation) <= 8 ? (language === "ar" ? "أنت باتجاه القبلة" : "You are facing Qibla") : qiblaRotation > 0 ? (language === "ar" ? "التف يمينًا" : "Turn right") : (language === "ar" ? "التف يسارًا" : "Turn left")}</Text></View>
              </View> : <View style={styles.qiblaCompass}>
                <View style={styles.qiblaGlow} />
                <View style={styles.qiblaRing}>
                  <Text style={styles.qiblaNorth}>{language === "ar" ? "ش" : "N"}</Text><Text style={styles.qiblaEast}>{language === "ar" ? "ق" : "E"}</Text><Text style={styles.qiblaSouth}>{language === "ar" ? "ج" : "S"}</Text><Text style={styles.qiblaWest}>{language === "ar" ? "غ" : "W"}</Text>
                  <View style={[styles.qiblaNeedle, { transform: [{ rotate: `${qiblaRotation}deg` }] }]}><MaterialCommunityIcons name="navigation" size={70} color={COLORS.gold} /><View style={styles.kaabaBadge}><View style={styles.kaabaMini}><View style={styles.kaabaMiniBand} /><View style={styles.kaabaMiniDoor} /></View></View></View>
                  <View style={styles.qiblaCenter} />
                </View>
              </View>}
              {qiblaCameraMode && !cameraPermission?.granted && <View style={styles.qiblaCameraNotice}><Ionicons name={cameraPermission?.canAskAgain === false ? "lock-closed-outline" : "camera-outline"} size={19} color={COLORS.gold} /><Text style={styles.qiblaCameraNoticeText}>{cameraPermission?.canAskAgain === false ? (language === "ar" ? "الكاميرا غير مفعّلة. استخدم البوصلة التقليدية أو فعّلها من إعدادات الهاتف." : "Camera access is disabled. Use the compass or enable it in phone settings.") : (language === "ar" ? "نحتاج إذن الكاميرا لعرض القبلة بالواقع المعزز." : "Camera permission is needed for AR Qibla.")}</Text></View>}
              <Pressable style={styles.qiblaModeButton} onPress={() => setQiblaCameraMode((current) => !current)}><Ionicons name={qiblaCameraMode ? "compass-outline" : "camera-outline"} size={17} color={COLORS.navy} /><Text style={styles.qiblaModeButtonText}>{qiblaCameraMode ? (language === "ar" ? "استخدام البوصلة التقليدية" : "Use traditional compass") : (language === "ar" ? "فتح القبلة بالواقع المعزز" : "Open AR Qibla")}</Text></Pressable>
              <View style={[styles.qiblaStats, styles.qiblaStatsSingle]}><View><Text style={styles.qiblaStatValue}>{Math.round(kaabaDistance).toLocaleString(language === "ar" ? "ar-JO" : "en-US")} {language === "ar" ? "كم" : "km"}</Text><Text style={styles.qiblaStatLabel}>{language === "ar" ? "المسافة إلى الكعبة" : "Distance to Kaaba"}</Text></View></View>
              <View style={styles.qiblaAutoNote}><Ionicons name="information-circle-outline" size={17} color={COLORS.teal} /><Text style={styles.qiblaAutoNoteText}>{userLocation ? (language === "ar" ? "لا تحتاج إلى معرفة زاوية معينة؛ نقرأ اتجاه الهاتف ونحسب الفرق تلقائيًا." : "You do not need to know a fixed angle; we read your heading and calculate the difference automatically.") : (language === "ar" ? "فعّل الموقع ليبدأ الحساب التلقائي للقبلة." : "Enable location to start automatic Qibla calculation.")}</Text></View>
              <View style={styles.compassStatus}><View style={[styles.compassStatusDot, qiblaHeadingReliable ? styles.compassStatusReady : styles.compassStatusWaiting]} /><Text style={styles.compassStatusText}>{qiblaHeadingReliable ? (language === "ar" ? `البوصلة جاهزة · اتجاه حقيقي${headingAccuracy !== null ? ` · دقة ${Math.round(headingAccuracy)}°` : ""}` : `Compass ready · true heading${headingAccuracy !== null ? ` · ${Math.round(headingAccuracy)}° accuracy` : ""}`) : (language === "ar" ? (userLocation ? "جارٍ تثبيت الاتجاه — حرّك الهاتف ببطء" : "جارٍ تحديد موقعك والاتجاه") : (userLocation ? "Stabilizing direction — move the phone slowly" : "Finding your location and direction"))}</Text></View>
              {!locationEnabled && <Pressable style={styles.primaryModalButton} onPress={requestLocation}><Text style={styles.primaryModalText}>{language === "ar" ? "تحديد موقعي" : "Use my location"}</Text></Pressable>}
            </>}
            {activeTab === "account" && <>
              <View style={styles.accountHero}><View style={styles.accountHeroIcon}><Ionicons name={meQuery.data ? "person" : "person-outline"} size={27} color={COLORS.gold} /></View><Text style={styles.modalTitle}>{meQuery.data ? (language === "ar" ? `أهلًا ${meQuery.data.name || "بك"}` : `Welcome ${meQuery.data.name || ""}`) : ui.accountTitle}</Text><Text style={styles.modalHint}>{meQuery.data ? (language === "ar" ? "حسابك جاهز لإضافة الأماكن وكتابة التقييمات." : "Your account is ready for adding places and reviews.") : (language === "ar" ? "الحساب اختياري. تحتاجه فقط لإضافة مكان أو كتابة تقييم." : ui.accountHint)}</Text></View>
              {!meQuery.data && <View style={styles.accountAuthCard}><View style={styles.accountBenefit}><Ionicons name="shield-checkmark-outline" size={19} color={COLORS.green} /><Text style={styles.accountBenefitText}>{language === "ar" ? "بياناتك محفوظة بأمان" : "Your data stays secure"}</Text></View><Pressable style={styles.primaryModalButton} onPress={beginLogin}><Text style={styles.primaryModalText}>{language === "ar" ? "تسجيل الدخول عبر Manus" : "Sign in with Manus"}</Text></Pressable><Pressable style={styles.secondaryModalButton} onPress={() => openEmailAuth("login")}><Text style={styles.secondaryModalText}>{ui.emailLogin}</Text></Pressable><Pressable style={styles.authLink} onPress={() => openEmailAuth("register")}><Text style={styles.authLinkText}>{ui.emailRegister}</Text></Pressable></View>}
              {meQuery.data && <View style={styles.accountSignedIn}><View style={styles.accountUserRow}><View style={styles.accountAvatar}><Text style={styles.accountAvatarText}>{(meQuery.data.name || "م").slice(0, 1)}</Text></View><View style={styles.accountUserCopy}><Text style={styles.accountUserName}>{meQuery.data.name || "مستخدم محرابي"}</Text><Text style={styles.accountUserHint}>{language === "ar" ? "عضو في مجتمع محرابي" : "Mehrabi community member"}</Text></View><Ionicons name="checkmark-circle" size={20} color={COLORS.green} /></View></View>}
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
          {emailAuthMode === "login" && !emailAuthNeedsOtp && <>
            <Pressable style={styles.authLink} onPress={() => openEmailAuth("forgot")}><Text style={styles.authLinkText}>{ui.forgotPassword}</Text></Pressable>
            <Pressable style={styles.secondaryModalButton} onPress={() => openEmailAuth("register")}><Text style={styles.secondaryModalText}>{ui.emailRegister}</Text></Pressable>
          </>}
          {emailAuthMode === "register" && !emailAuthNeedsOtp && <Pressable style={styles.authLink} onPress={() => openEmailAuth("login")}><Text style={styles.authLinkText}>{ui.haveAccount}</Text></Pressable>}
          {emailAuthMode === "forgot" && !emailAuthNeedsOtp && <Pressable style={styles.authLink} onPress={() => openEmailAuth("login")}><Text style={styles.authLinkText}>{ui.backToLogin}</Text></Pressable>}
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.canvas },
  scroll: { paddingHorizontal: 20, paddingBottom: 104 },
  header: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingTop: 12, paddingBottom: 20 },
  brandRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9 },
  logoMark: { width: 46, height: 46, borderRadius: 15, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center", overflow: "hidden", shadowColor: COLORS.navy, shadowOpacity: 0.16, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 4 },
  logoImage: { width: 46, height: 46 },
  brandCopy: { alignItems: "flex-end" },
  brand: { color: COLORS.navy, fontSize: 20, fontWeight: "900", letterSpacing: -0.3 },
  brandTagline: { color: COLORS.teal, fontSize: 9, fontWeight: "700", marginTop: -1 },
  headerActions: { flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  languageButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.line },
  languageText: { fontSize: 11, fontWeight: "800", color: COLORS.navy },
  profileButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.goldSoft, alignItems: "center", justifyContent: "center" },
  profileLetter: { color: COLORS.navy, fontWeight: "800", fontSize: 15 },
  greetingBlock: { alignItems: "flex-end", marginBottom: 15 },
  greetingPill: { flexDirection: "row-reverse", alignItems: "center", gap: 6, backgroundColor: COLORS.goldSoft, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, marginBottom: 9 },
  greetingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.gold },
  eyebrow: { color: COLORS.navy, fontSize: 11, fontWeight: "800" },
  title: { color: COLORS.ink, fontSize: 28, fontWeight: "900", letterSpacing: -0.6 },
  heroHint: { color: COLORS.muted, fontSize: 12, marginTop: 6, textAlign: "right" },
  locationButton: { alignSelf: "flex-end", flexDirection: "row-reverse", alignItems: "center", gap: 7, paddingHorizontal: 15, height: 40, borderRadius: 14, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, marginBottom: 15 },
  locationButtonActive: { borderColor: "#B9E4D4", backgroundColor: "#F2FCF8" },
  locationButtonText: { color: COLORS.navy, fontSize: 13, fontWeight: "700" },
  locationError: { color: COLORS.red, fontSize: 11, textAlign: "right", marginTop: -8, marginBottom: 10 },
  prayerCard: { backgroundColor: COLORS.navy, borderRadius: 26, padding: 21, minHeight: 174, marginBottom: 16, overflow: "hidden", shadowColor: COLORS.navy, shadowOpacity: 0.24, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 6 },
  prayerOrb: { position: "absolute", width: 185, height: 185, borderRadius: 93, right: -68, top: -64, backgroundColor: "rgba(90,175,167,0.19)", borderWidth: 1, borderColor: "rgba(243,180,75,0.22)" },
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
  prayerTimesButton: { paddingVertical: 4, paddingHorizontal: 2 },
  dailyPrayersHeader: { marginTop: 3, marginBottom: 10 },
  dailyPrayersTitleRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between" },
  dailyPrayersTitle: { color: COLORS.navy, fontSize: 17, fontWeight: "900", textAlign: "right" },
  dailyPrayersDate: { flexDirection: "row-reverse", alignItems: "center", gap: 5, backgroundColor: "#EAF6F4", borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  dailyPrayersDateText: { color: COLORS.teal, fontSize: 10, fontWeight: "800" },
  dailyPrayersHint: { color: COLORS.muted, fontSize: 10, textAlign: "right", marginTop: 4 },
  dailyPrayersGrid: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  dailyPrayerTile: { width: "30%", minHeight: 105, backgroundColor: COLORS.white, borderRadius: 17, padding: 10, alignItems: "flex-end", borderWidth: 1, borderColor: COLORS.line, shadowColor: COLORS.navy, shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  dailyPrayerTileActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy, shadowOpacity: 0.16 },
  dailyPrayerIcon: { width: 31, height: 31, borderRadius: 11, backgroundColor: "#E7F6F3", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  dailyPrayerIconActive: { backgroundColor: "rgba(243,180,75,0.18)" },
  dailyPrayerName: { color: COLORS.muted, fontSize: 11, fontWeight: "800", textAlign: "right" },
  dailyPrayerNameActive: { color: "#B6CAD9" },
  dailyPrayerTime: { color: COLORS.navy, fontSize: 15, fontWeight: "900", marginTop: 4, textAlign: "right" },
  dailyPrayerTimeActive: { color: COLORS.white },
  nextPrayerBadge: { position: "absolute", left: 8, bottom: 8, backgroundColor: COLORS.gold, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
  nextPrayerBadgeText: { color: COLORS.navy, fontSize: 8, fontWeight: "900" },
  quickActions: { flexDirection: "row-reverse", gap: 9, marginBottom: 27 },
  quickAction: { flex: 1, minHeight: 101, backgroundColor: COLORS.white, borderRadius: 18, padding: 11, alignItems: "flex-end", borderWidth: 1, borderColor: COLORS.line, shadowColor: COLORS.navy, shadowOpacity: 0.05, shadowRadius: 9, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  quickIcon: { width: 35, height: 35, borderRadius: 12, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  quickIconGold: { backgroundColor: COLORS.goldSoft },
  quickIconTeal: { backgroundColor: "#E7F6F3" },
  quickIconBlue: { backgroundColor: "#EAF0FA" },
  quickActionText: { color: COLORS.ink, fontSize: 12, fontWeight: "900", textAlign: "right" },
  quickActionHint: { color: COLORS.muted, fontSize: 9, marginTop: 3, textAlign: "right" },
  discoveryCard: { backgroundColor: "#F0F7F7", borderRadius: 24, padding: 14, marginBottom: 17, borderWidth: 1, borderColor: "#DCEBEA" },
  discoveryTitleRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9, marginBottom: 12 },
  discoveryIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center" },
  discoveryCopy: { flex: 1, alignItems: "flex-end" },
  discoveryEyebrow: { color: COLORS.teal, fontSize: 10, fontWeight: "800", textAlign: "right", marginBottom: 2 },
  discoveryTitle: { color: COLORS.ink, fontSize: 17, fontWeight: "900", textAlign: "right" },
  typeSegmentRow: { flexDirection: "row-reverse", gap: 6, marginTop: 10 },
  typeSegment: { flex: 1, height: 39, borderRadius: 12, backgroundColor: COLORS.white, borderWidth: 1, borderColor: "#DDE7EA", flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 5 },
  typeSegmentActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  typeSegmentMosque: { backgroundColor: COLORS.mosqueGreen, borderColor: COLORS.mosqueGreen },
  typeSegmentMusalla: { backgroundColor: COLORS.musallaBlue, borderColor: COLORS.musallaBlue },
  typeSegmentText: { color: COLORS.muted, fontSize: 11, fontWeight: "800" },
  typeSegmentTextActive: { color: COLORS.white },
  filterButton: { height: 35, marginTop: 9, borderTopWidth: 1, borderTopColor: "#DCEBEA", flexDirection: "row-reverse", alignItems: "center", gap: 5, paddingTop: 8 },
  filterButtonText: { color: COLORS.navy, fontSize: 11, fontWeight: "900" },
  filterButtonValue: { color: COLORS.muted, fontSize: 10, marginRight: "auto" },
  sectionHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 13 },
  sectionEyebrow: { color: COLORS.teal, fontSize: 11, textAlign: "right", marginBottom: 4, fontWeight: "700" },
  sectionTitle: { color: COLORS.ink, fontSize: 21, fontWeight: "900", textAlign: "right", letterSpacing: -0.3 },
  seeAll: { color: COLORS.navy, fontSize: 12, fontWeight: "700", paddingBottom: 2 },
  searchBox: { height: 53, borderRadius: 17, backgroundColor: COLORS.white, borderWidth: 1, borderColor: "#D9E5EA", flexDirection: "row-reverse", alignItems: "center", paddingHorizontal: 15, gap: 9, shadowColor: COLORS.navy, shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 1 },
  searchInput: { flex: 1, color: COLORS.ink, fontSize: 13, paddingVertical: 0 },
  shortcut: { backgroundColor: COLORS.canvas, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 6 },
  shortcutText: { color: COLORS.muted, fontSize: 10 },
  filters: { flexDirection: "row-reverse", gap: 7, paddingVertical: 12 },
  filterChip: { flexDirection: "row-reverse", alignItems: "center", gap: 5, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, borderRadius: 999, paddingHorizontal: 12, height: 35 },
  filterChipActive: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  filterText: { color: COLORS.muted, fontSize: 11, fontWeight: "700" },
  filterTextActive: { color: COLORS.white },
  dot: { width: 6, height: 6, borderRadius: 3 },
  mapCard: { height: 205, borderRadius: 23, overflow: "hidden", backgroundColor: "#E3EFEF", position: "relative", borderWidth: 1, borderColor: "#D9E5E7", marginBottom: 18, shadowColor: COLORS.navy, shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 2 },
  nativeMap: StyleSheet.absoluteFill,
  mapHeader: { position: "absolute", zIndex: 3, top: 10, left: 11, right: 11, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  mapTitleBadge: { flexDirection: "row-reverse", alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.93)", borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 },
  mapBadge: { backgroundColor: "rgba(255,255,255,0.9)", color: COLORS.green, fontSize: 10, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 },
  mapProvider: { color: "#6A8A8F", fontSize: 9, fontWeight: "700" },
  mapControl: { position: "absolute", bottom: 10, left: 10, width: 34, height: 34, borderRadius: 10, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center" },
  mapLegend: { position: "absolute", right: 10, bottom: 10, flexDirection: "row-reverse", alignItems: "center", gap: 8, backgroundColor: "rgba(255,255,255,0.93)", borderRadius: 10, paddingHorizontal: 9, paddingVertical: 7 },
  legendItem: { flexDirection: "row-reverse", alignItems: "center", gap: 4 },
  legendDot: { width: 7, height: 7, borderRadius: 4 },
  legendLocation: { backgroundColor: "#4A94F5", borderWidth: 2, borderColor: "#DDEBFF" },
  legendText: { color: COLORS.muted, fontSize: 9, fontWeight: "800" },
  listHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", marginBottom: 9 },
  nearbyCount: { color: COLORS.ink, fontSize: 13, fontWeight: "800" },
  sortText: { color: COLORS.muted, fontSize: 11 },
  offlineNotice: { color: COLORS.gold, backgroundColor: COLORS.goldSoft, borderRadius: 8, padding: 8, fontSize: 10, textAlign: "right", marginBottom: 8 },
  groupTitle: { color: COLORS.navy, fontSize: 16, fontWeight: "800", textAlign: "right", marginTop: 10, marginBottom: 8 },
  mosqueTitle: { color: COLORS.mosqueGreen },
  musallaTitle: { color: COLORS.musallaBlue },
  placeCard: { backgroundColor: COLORS.white, borderRadius: 19, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: COLORS.line, shadowColor: COLORS.navy, shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 1 },
  mosqueCard: { borderRightWidth: 3, borderRightColor: COLORS.mosqueGreen },
  musallaCard: { borderRightWidth: 3, borderRightColor: COLORS.musallaBlue },
  placeMain: { flexDirection: "row-reverse", alignItems: "flex-start" },
  placeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", marginLeft: 10 },
  mosqueIcon: { backgroundColor: "#E5F7F0" },
  musallaIcon: { backgroundColor: COLORS.musallaSoft },
  placeInfo: { flex: 1 },
  nameRow: { flexDirection: "row-reverse", alignItems: "center", gap: 7, marginBottom: 6 },
  placeName: { color: COLORS.ink, fontSize: 15, fontWeight: "900", textAlign: "right", flexShrink: 1 },
  officialPlacePill: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3, backgroundColor: "#EFF8F7" },
  officialPlaceText: { color: COLORS.teal, fontSize: 9, fontWeight: "900" },
  typePill: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  typePillMosque: { backgroundColor: "#E5F7F0" },
  typePillMusalla: { backgroundColor: COLORS.musallaSoft },
  typePillText: { color: COLORS.navy, fontSize: 9, fontWeight: "900" },
  statusRow: { flexDirection: "row-reverse", alignItems: "center", gap: 6, marginBottom: 5 },
  openPill: { backgroundColor: "#E5F7F0", borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 },
  closedPill: { backgroundColor: "#FBEAE8" },
  unknownPill: { backgroundColor: "#FFF2D8" },
  unverifiedPill: { backgroundColor: "#F1F3F5", borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 },
  unverifiedText: { color: COLORS.muted, fontSize: 9, fontWeight: "800" },
  openText: { color: COLORS.green, fontSize: 9, fontWeight: "800" },
  closedText: { color: COLORS.red },
  unknownText: { color: "#B87914" },
  placeMeta: { color: COLORS.muted, fontSize: 10, textAlign: "right", marginBottom: 6 },
  distanceRow: { flexDirection: "row-reverse", alignItems: "baseline", gap: 6, marginBottom: 7 },
  distanceValue: { color: COLORS.navy, fontSize: 17, fontWeight: "900" },
  distanceHint: { color: COLORS.muted, fontSize: 9, fontWeight: "600" },
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
  tabBar: { position: "absolute", bottom: 12, left: 14, right: 14, height: 68, backgroundColor: "rgba(255,255,255,0.98)", borderWidth: 1, borderColor: "#E1E9ED", borderRadius: 23, flexDirection: "row-reverse", justifyContent: "space-around", alignItems: "center", paddingBottom: 2, shadowColor: COLORS.navy, shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 7 }, elevation: 7 },
  tabItem: { alignItems: "center", gap: 3, minWidth: 62, paddingVertical: 5 },
  tabIconWrap: { width: 34, height: 30, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  tabIconWrapActive: { backgroundColor: "#E7F3F2" },
  qiblaTabItem: { marginTop: -15 },
  qiblaTabIcon: { width: 51, height: 51, borderRadius: 18, backgroundColor: COLORS.navy, borderWidth: 3, borderColor: COLORS.goldSoft, alignItems: "center", justifyContent: "center", shadowColor: COLORS.navy, shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 5 },
  qiblaTabText: { color: COLORS.navy, fontWeight: "900" },
  tabText: { color: COLORS.muted, fontSize: 10, fontWeight: "700" },
  tabActive: { color: COLORS.navy },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(16,45,74,0.35)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: COLORS.white, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, minHeight: 300, paddingBottom: 38 },
  modalClose: { alignSelf: "flex-start", width: 34, height: 34, borderRadius: 17, backgroundColor: COLORS.canvas, alignItems: "center", justifyContent: "center" },
  modalTitle: { color: COLORS.navy, fontSize: 25, fontWeight: "900", textAlign: "right", writingDirection: "rtl", marginTop: 14, marginBottom: 10 },
  modalHint: { color: COLORS.muted, fontSize: 13, lineHeight: 21, fontWeight: "500", textAlign: "right", writingDirection: "rtl", marginBottom: 16 },
  accountHero: { alignItems: "flex-end", marginTop: 8 },
  accountHeroIcon: { width: 52, height: 52, borderRadius: 17, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  accountAuthCard: { backgroundColor: "#F3F8F8", borderRadius: 17, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: "#DCECEB" },
  accountBenefit: { flexDirection: "row-reverse", alignItems: "center", gap: 7, marginBottom: 2 },
  accountBenefitText: { color: COLORS.green, fontSize: 10, fontWeight: "800" },
  accountSignedIn: { backgroundColor: "#F3F8F8", borderRadius: 17, padding: 13, marginBottom: 10, borderWidth: 1, borderColor: "#DCECEB" },
  accountUserRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9 },
  accountAvatar: { width: 43, height: 43, borderRadius: 15, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center" },
  accountAvatarText: { color: COLORS.gold, fontSize: 19, fontWeight: "900" },
  accountUserCopy: { flex: 1, alignItems: "flex-end" },
  accountUserName: { color: COLORS.ink, fontSize: 14, fontWeight: "900", textAlign: "right" },
  accountUserHint: { color: COLORS.muted, fontSize: 10, marginTop: 2, textAlign: "right" },
  exploreRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  exploreRowText: { color: COLORS.ink, fontSize: 14, fontWeight: "700" },
  exploreHero: { alignItems: "flex-end", marginTop: 8, marginBottom: 14 },
  exploreHeroIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  exploreTypeCards: { flexDirection: "row-reverse", gap: 9, marginBottom: 12 },
  exploreTypeCard: { flex: 1, borderRadius: 17, padding: 13, borderWidth: 1, minHeight: 142, alignItems: "flex-end" },
  exploreMosqueCard: { backgroundColor: "#F0FAF6", borderColor: "#D5EEE3" },
  exploreMusallaCard: { backgroundColor: "#F3F4FF", borderColor: "#E0E3FF" },
  exploreCardIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center", marginBottom: 11 },
  exploreCardIconBlue: { backgroundColor: COLORS.white },
  exploreCardTitle: { color: COLORS.ink, fontSize: 14, fontWeight: "900", textAlign: "right" },
  exploreCardCount: { color: COLORS.muted, fontSize: 10, marginTop: 3, textAlign: "right" },
  exploreCardAction: { color: COLORS.navy, fontSize: 10, fontWeight: "900", marginTop: "auto", textAlign: "right" },
  exploreLocationNote: { flexDirection: "row-reverse", alignItems: "center", gap: 7, backgroundColor: COLORS.goldSoft, borderRadius: 12, padding: 10, marginBottom: 16 },
  exploreLocationText: { flex: 1, color: COLORS.navy, fontSize: 10, fontWeight: "700", textAlign: "right", lineHeight: 16 },
  officialDirectoryButton: { flexDirection: "row-reverse", alignItems: "center", gap: 10, backgroundColor: "#F0F7F7", borderColor: "#DCEBEA", borderWidth: 1, borderRadius: 16, padding: 12, marginBottom: 14 },
  officialDirectoryIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center" },
  officialDirectoryCopy: { flex: 1, alignItems: "flex-end" },
  officialDirectoryTitle: { color: COLORS.navy, fontSize: 12, fontWeight: "900", textAlign: "right" },
  officialDirectoryHint: { color: COLORS.muted, fontSize: 10, marginTop: 3, textAlign: "right" },
  exploreQuickTitle: { color: COLORS.ink, fontSize: 14, fontWeight: "900", textAlign: "right", marginBottom: 5 },
  exploreQuickGrid: { borderTopWidth: 1, borderTopColor: COLORS.line },
  exploreQuickItem: { flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  exploreQuickText: { color: COLORS.ink, fontSize: 12, fontWeight: "800", flex: 1, textAlign: "right" },
  qiblaHeroHint: { color: COLORS.teal, fontSize: 13, fontWeight: "800", textAlign: "center", marginBottom: 3 },
  qiblaSmartBadge: { alignSelf: "center", flexDirection: "row-reverse", alignItems: "center", gap: 5, backgroundColor: "#E5F7F0", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 7 },
  qiblaSmartText: { color: COLORS.green, fontSize: 11, fontWeight: "900" },
  qiblaAutoNote: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 7, backgroundColor: "#F0F7F7", borderRadius: 13, padding: 11, marginBottom: 8, borderWidth: 1, borderColor: "#DCEBEA" },
  qiblaAutoNoteText: { flex: 1, color: COLORS.navy, fontSize: 11, lineHeight: 18, fontWeight: "700", textAlign: "right" },
  qiblaArFrame: { height: 320, borderRadius: 24, overflow: "hidden", position: "relative", backgroundColor: "#102D4A", marginVertical: 10, borderWidth: 1.5, borderColor: "rgba(243,180,75,0.82)" },
  qiblaCamera: { ...StyleSheet.absoluteFill },
  qiblaArShade: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(16,45,74,0.18)" },
  qiblaArTopShade: { position: "absolute", top: 0, left: 0, right: 0, height: 92, backgroundColor: "rgba(7,24,40,0.34)" },
  qiblaArBottomShade: { position: "absolute", bottom: 0, left: 0, right: 0, height: 112, backgroundColor: "rgba(7,24,40,0.42)" },
  qiblaArReticle: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  qiblaArCrosshair: { width: 112, height: 112, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.78)", borderRadius: 56, shadowColor: COLORS.gold, shadowOpacity: 0.38, shadowRadius: 15, elevation: 4 },
  qiblaArKaaba: { position: "absolute", left: "50%", top: "50%", width: 94, marginLeft: -47, marginTop: -47, alignItems: "center", justifyContent: "center", padding: 9, borderRadius: 17, backgroundColor: "rgba(16,45,74,0.86)", borderWidth: 1, borderColor: COLORS.gold, shadowColor: COLORS.gold, shadowOpacity: 0.35, shadowRadius: 14, elevation: 5 },
  qiblaArKaabaLabel: { color: COLORS.white, fontSize: 11, fontWeight: "900", marginTop: 5 },
  kaabaIllustration: { width: 48, height: 48, borderRadius: 7, backgroundColor: "#171717", borderWidth: 2, borderColor: COLORS.gold, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  kaabaIllustrationBand: { position: "absolute", top: 13, left: 0, right: 0, height: 5, backgroundColor: COLORS.gold },
  kaabaIllustrationDoor: { position: "absolute", bottom: 0, right: 10, width: 10, height: 17, backgroundColor: COLORS.gold, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  qiblaArDirection: { position: "absolute", left: "50%", bottom: 28, width: 52, marginLeft: -26, alignItems: "center", justifyContent: "center" },
  qiblaArTopBadge: { position: "absolute", top: 12, right: 12, flexDirection: "row-reverse", alignItems: "center", gap: 6, backgroundColor: "rgba(16,45,74,0.84)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7 },
  qiblaArTopText: { color: COLORS.white, fontSize: 11, fontWeight: "900" },
  qiblaArBottomBadge: { position: "absolute", bottom: 12, left: 20, right: 20, alignItems: "center", backgroundColor: "rgba(16,45,74,0.84)", borderRadius: 999, paddingVertical: 8 },
  qiblaArBottomText: { color: COLORS.gold, fontSize: 13, fontWeight: "900" },
  qiblaCameraNotice: { flexDirection: "row-reverse", alignItems: "center", gap: 7, backgroundColor: COLORS.goldSoft, borderRadius: 13, padding: 11, marginVertical: 7 },
  qiblaCameraNoticeText: { flex: 1, color: COLORS.navy, fontSize: 11, lineHeight: 17, fontWeight: "700", textAlign: "right" },
  qiblaModeButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: COLORS.canvas, borderWidth: 1, borderColor: COLORS.line, borderRadius: 13, paddingVertical: 10, marginBottom: 4 },
  qiblaModeButtonText: { color: COLORS.navy, fontSize: 12, fontWeight: "900" },
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
  kaabaMini: { width: 17, height: 17, borderRadius: 3, backgroundColor: "#171717", borderWidth: 1, borderColor: COLORS.gold, overflow: "hidden" },
  kaabaMiniBand: { position: "absolute", top: 4, left: 0, right: 0, height: 2, backgroundColor: COLORS.gold },
  kaabaMiniDoor: { position: "absolute", bottom: 0, right: 3, width: 4, height: 6, backgroundColor: COLORS.gold },
  qiblaCenter: { position: "absolute", width: 14, height: 14, borderRadius: 7, backgroundColor: COLORS.navy, borderWidth: 3, borderColor: COLORS.white },
  qiblaStats: { flexDirection: "row-reverse", justifyContent: "space-evenly", marginVertical: 10, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: COLORS.line },
  qiblaStatsSingle: { justifyContent: "center" },
  qiblaStatValue: { color: COLORS.navy, fontSize: 20, fontWeight: "900", textAlign: "center" },
  qiblaStatLabel: { color: COLORS.muted, fontSize: 10, textAlign: "center", marginTop: 2 },
  compassStatus: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, marginBottom: 4 },
  compassStatusDot: { width: 8, height: 8, borderRadius: 4 },
  compassStatusReady: { backgroundColor: COLORS.green },
  compassStatusWaiting: { backgroundColor: COLORS.gold },
  compassStatusText: { color: COLORS.muted, fontSize: 11, fontWeight: "700" },
  primaryModalButton: { height: 50, borderRadius: 14, backgroundColor: COLORS.navy, alignItems: "center", justifyContent: "center", marginTop: 10 },
  primaryModalText: { color: COLORS.white, fontSize: 15, fontWeight: "800", writingDirection: "rtl" },
  calibrationHint: { color: COLORS.muted, fontSize: 11, lineHeight: 18, textAlign: "center", marginBottom: 3 },
  secondaryModalButton: { height: 44, borderRadius: 13, backgroundColor: COLORS.canvas, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center", marginTop: 10 },
  secondaryModalText: { color: COLORS.navy, fontSize: 14, fontWeight: "800", writingDirection: "rtl" },
  pickerMap: { height: 220, overflow: "hidden", borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, marginBottom: 4 },
  checkRow: { flexDirection: "row-reverse", gap: 8, marginBottom: 4 },
  checkButton: { flex: 1, height: 40, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center" },
  checkButtonActive: { backgroundColor: "#E5F7F0", borderColor: COLORS.green },
  adminLink: { alignItems: "center", paddingVertical: 14 },
  adminLinkText: { color: COLORS.teal, fontSize: 13, fontWeight: "800" },
  formInput: { height: 52, borderWidth: 1.5, borderColor: "#C8D4DC", borderRadius: 14, paddingHorizontal: 15, paddingVertical: 0, color: COLORS.ink, marginBottom: 11, backgroundColor: COLORS.white, fontSize: 16, fontWeight: "500", writingDirection: "rtl", textAlignVertical: "center" },
  otpInput: { fontSize: 22, fontWeight: "900", letterSpacing: 6, color: COLORS.navy },
  emailInput: { writingDirection: "ltr", fontWeight: "500" },
  commentInput: { height: 96, paddingTop: 14, textAlignVertical: "top" },
  formError: { color: COLORS.red, fontSize: 11, lineHeight: 17, textAlign: "right", marginTop: 8 },
  formSuccess: { color: COLORS.green, fontSize: 11, lineHeight: 17, textAlign: "right", marginTop: 8 },
  authLink: { alignItems: "center", paddingVertical: 12 },
  authLinkText: { color: COLORS.teal, fontSize: 13, fontWeight: "800", writingDirection: "rtl" },
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
