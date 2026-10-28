import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { CalculationMethod, Coordinates, Madhab, PrayerTimes } from "adhan";
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
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import OsmMapFrame from "@/components/OsmMapFrame";
import osmMosqueMapData from "../../data/osm_mosque_map_points.json";
import { trpc } from "@/lib/trpc";
import { getApiBaseUrl, startOAuthLogin } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";
import { buildPrayerReminderBody, getPrayerReminderIdentifier, PRAYER_REMINDER_DAYS } from "@/lib/prayerReminders";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { buildMapLocationCandidates, rankMapLocationsByDistance } from "@/lib/mapLocations";

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

const JORDAN_TIME_ZONE = "Asia/Amman";
const REMINDER_SETTINGS_KEY = "maslay.prayer-reminders.v1";
const REMINDER_IDS_KEY = "maslay.prayer-reminder-ids.v1";
const PLACES_CACHE_KEY = "maslay.places-cache.v1";
const PRAYER_REMINDER_CHANNEL = "prayer-reminders-v3";
const PRAYER_REMINDER_SOUND = "mehrabi_reminder.wav";

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
  // Cancel only prayer-time reminders. Deferred ten-minute reminders must
  // survive the foreground reschedule triggered when an action opens the app.
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const reminderIds = new Set(scheduled
    .filter((item) => (item.content.data as { prayerReminder?: boolean } | undefined)?.prayerReminder)
    .map((item) => item.identifier));
  const stored = await AsyncStorage.getItem(REMINDER_IDS_KEY);
  if (stored) {
    try {
      for (const id of JSON.parse(stored) as string[]) reminderIds.add(id);
    } catch {
      // The system-scheduled list above still allows cancellation if the local ID index is corrupt.
    }
  }
  await Promise.all([...reminderIds].map((id) =>
    Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined),
  ));
  const remaining = await Notifications.getAllScheduledNotificationsAsync();
  const remainingPrayerReminders = remaining.filter((item) =>
    (item.content.data as { prayerReminder?: boolean } | undefined)?.prayerReminder,
  );
  if (remainingPrayerReminders.length > 0) {
    throw new Error(`Failed to cancel ${remainingPrayerReminders.length} prayer reminders`);
  }
  await AsyncStorage.removeItem(REMINDER_IDS_KEY);
};

const schedulePrayerReminders = async (
  minutesBefore: number,
  location: { lat: number; lng: number } | null,
  isCurrent: () => boolean = () => true,
) => {
  if (Platform.OS === "web") return;
  const ids: string[] = [];
  try {
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    const storedIdsValue = await AsyncStorage.getItem(REMINDER_IDS_KEY);
    const storedIds = storedIdsValue ? JSON.parse(storedIdsValue) as string[] : [];
    const existingIds = new Set([
      ...storedIds,
      ...existing
        .filter((item) => (item.content.data as { prayerReminder?: boolean } | undefined)?.prayerReminder)
        .map((item) => item.identifier),
    ]);
    const now = new Date();
    const scheduledKeys = new Set<string>();
    const firstJordanDate = getJordanCalendarDate(now);
    for (let dayOffset = 0; dayOffset < PRAYER_REMINDER_DAYS; dayOffset += 1) {
      if (!isCurrent()) return;
      const date = new Date(firstJordanDate.getTime());
      date.setDate(date.getDate() + dayOffset);
      const prayerSchedule = getPrayerSchedule(date, location);
      const scheduledPrayerNames = prayerSchedule.map(([name]) => name);
      for (const [prayerIndex, [name, prayerTime]] of prayerSchedule.entries()) {
        if (!isCurrent()) return;
        const triggerDate = new Date(prayerTime.getTime() - minutesBefore * 60 * 1000);
        if (triggerDate <= now) continue;
        const reminderKey = `${name}:${triggerDate.getTime()}`;
        if (scheduledKeys.has(reminderKey)) continue;
        scheduledKeys.add(reminderKey);
        const identifier = getPrayerReminderIdentifier(date.getFullYear(), date.getMonth(), date.getDate(), prayerIndex);
        const id = await Notifications.scheduleNotificationAsync({
          identifier,
          content: {
            title: "نداء محرابي",
            body: buildPrayerReminderBody(minutesBefore, name, scheduledPrayerNames),
            sound: PRAYER_REMINDER_SOUND,
            data: { prayerName: name, reminderKey, prayerReminder: true },
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: triggerDate, channelId: PRAYER_REMINDER_CHANNEL },
        });
        ids.push(id);
      }
    }
    if (!isCurrent()) return;
    await Promise.all([...existingIds].filter((id) => !ids.includes(id)).map((id) =>
      Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined),
    ));
    await AsyncStorage.setItem(REMINDER_IDS_KEY, JSON.stringify(ids));
  } catch (error) {
    const prior = await AsyncStorage.getItem(REMINDER_IDS_KEY).catch(() => null);
    let priorIds: string[] = [];
    try {
      priorIds = prior ? JSON.parse(prior) as string[] : [];
    } catch {
      // Keep the system-scheduled notifications; the next successful refresh repairs this index.
    }
    await AsyncStorage.setItem(REMINDER_IDS_KEY, JSON.stringify([...new Set([...priorIds, ...ids])])).catch(() => undefined);
    throw error;
  }
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

type OfficialMosqueMapPoint = { id: number; name: string; latitude: number; longitude: number };
type CommunityMapPoint = { id: number; name: string; type: string; latitude: number; longitude: number };
const EMPTY_OFFICIAL_MAP_POINTS: OfficialMosqueMapPoint[] = [];
const EMPTY_COMMUNITY_MAP_POINTS: CommunityMapPoint[] = [];
type OsmMapFeature = {
  osmType: "node" | "way" | "relation";
  osmId: number;
  osmUrl: string;
  kind: "mosque" | "musalla";
  osmName: string | null;
  alternateNames: string[];
  latitude: number;
  longitude: number;
  geometryMethod: string;
  officialMatch: {
    sourceKey: string;
    officialName: string;
    officialHasCoordinates: boolean;
    matchMethod: string;
  } | null;
};

const OSM_MAP_FEATURES = osmMosqueMapData.features as OsmMapFeature[];
const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

const safeInlineJson = (value: unknown) =>
  (JSON.stringify(value) ?? "null")
  .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const createOsmHtml = (
  places: CommunityMapPoint[],
  officialMosques: OfficialMosqueMapPoint[],
  userLocation: { lat: number; lng: number } | null,
  language: "ar" | "en",
  officialMosquesLoaded: boolean,
  placeTypeFilter: "all" | "mosque" | "musalla",
  searchQuery: string,
  mapFocusLocation: { lat: number; lng: number } | null,
) => {
  const communityPoints = safeInlineJson(places.map(({ latitude, longitude, name, type }) => [latitude, longitude, name, type]));
  const officialPoints = safeInlineJson(officialMosques.map(({ id, name, latitude, longitude }) => ({ id, name, latitude, longitude })));
  const osmPoints = safeInlineJson(OSM_MAP_FEATURES.map((feature) => ({
    osmType: feature.osmType,
    osmId: feature.osmId,
    osmUrl: feature.osmUrl,
    kind: feature.kind,
    osmName: feature.osmName,
    alternateNames: feature.alternateNames,
    latitude: feature.latitude,
    longitude: feature.longitude,
    officialMatch: feature.officialMatch,
  })));
  const currentLocation = safeInlineJson(userLocation);
  const mapViewCenter = safeInlineJson(mapFocusLocation ?? userLocation);

  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="strict-origin" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="anonymous" />
    <style>html,body,#map{width:100%;height:100%;margin:0;background:#e3efef}.leaflet-control-attribution{font-size:8px}.leaflet-popup-content{line-height:1.45}.leaflet-popup-content a{display:block;margin-top:4px}</style>
  </head>
  <body>
    <div id="map"></div>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin="anonymous"></script>
    <script>
      const mapViewCenter = ${mapViewCenter};
      const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(mapViewCenter ? [Number(mapViewCenter.lat), Number(mapViewCenter.lng)] : [31.9539, 35.9106], ${mapFocusLocation ? 14 : userLocation ? 13 : 9});
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' }).addTo(map);
      const communityPoints = ${communityPoints};
      const officialMosques = ${officialPoints};
      const osmFeatures = ${osmPoints};
      const userLocation = ${currentLocation};
      const officialMosquesLoaded = ${officialMosquesLoaded ? "true" : "false"};
      const mapTypeFilter = ${safeInlineJson(placeTypeFilter)};
      const mapSearchQuery = ${safeInlineJson(searchQuery.trim().toLocaleLowerCase())};
      const markerRenderer = L.canvas({ padding: 0.5 });

      function shouldShowMarker(name, isMosque, alternateNames = []) {
        if (mapTypeFilter === 'mosque' && !isMosque) return false;
        if (mapTypeFilter === 'musalla' && isMosque) return false;
        if (!mapSearchQuery) return true;
        const searchableName = [name, ...alternateNames].filter(Boolean).join(' ').toLocaleLowerCase();
        return searchableName.includes(mapSearchQuery);
      }

      function isValidOsmUrl(value) {
        const prefix = 'https://www.openstreetmap.org/';
        const url = String(value || '');
        if (!url.startsWith(prefix)) return false;
        const parts = url.slice(prefix.length).split('/');
        return parts.length === 2
          && ['node', 'way', 'relation'].includes(parts[0])
          && parts[1].length > 0
          && Array.from(parts[1]).every((digit) => digit >= '0' && digit <= '9');
      }

      function popupContent(name, category, source, osmUrl) {
        const content = document.createElement('div');
        content.dir = "${language}" === 'ar' ? 'rtl' : 'ltr';
        const title = document.createElement('strong');
        title.textContent = String(name ?? '');
        const detail = document.createElement('div');
        detail.textContent = category;
        const sourceLine = document.createElement('div');
        sourceLine.textContent = source;
        content.appendChild(title);
        content.appendChild(detail);
        content.appendChild(sourceLine);
        if (isValidOsmUrl(osmUrl)) {
          const link = document.createElement('a');
          link.href = osmUrl;
          link.textContent = "${language}" === 'ar' ? 'فتح عنصر OSM' : 'Open OSM element';
          link.addEventListener('click', (event) => {
            event.preventDefault();
            if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'open-osm-link', url: link.href }));
            } else {
              window.open(link.href, '_blank', 'noopener,noreferrer');
            }
          });
          content.appendChild(link);
        }
        return content;
      }

      function addMarker(lat, lng, color, name, category, source, osmUrl, radius = 5) {
        const latitude = Number(lat);
        const longitude = Number(lng);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
        const position = [latitude, longitude];
        L.circleMarker(position, { renderer: markerRenderer, radius, color: '#fff', weight: 1.25, fillColor: color, fillOpacity: 0.92 })
          .addTo(map)
          .bindPopup(popupContent(name, category, source, osmUrl));
      }

      communityPoints.forEach(([lat, lng, name, type]) => {
        const isMosque = type === 'مسجد' || type === 'mosque';
        if (!shouldShowMarker(name, isMosque)) return;
        const category = isMosque ? ("${language}" === 'ar' ? 'مسجد' : 'Mosque') : ("${language}" === 'ar' ? 'مصلى' : 'Musalla');
        const source = "${language}" === 'ar' ? 'مكان معتمد في التطبيق' : 'Approved place in the app';
        addMarker(lat, lng, isMosque ? '#2B9A76' : '#7C8EDB', name, category, source, null, 5.5);
      });

      officialMosques.forEach(({ name, latitude, longitude }) => {
        if (!shouldShowMarker(name, true)) return;
        addMarker(latitude, longitude, '#2B9A76', name, "${language}" === 'ar' ? 'جامع رسمي' : 'Official mosque', "${language}" === 'ar' ? 'إحداثيات سجل وزارة الأوقاف' : 'Ministry registry coordinates', null, 6);
      });

      osmFeatures.forEach((feature) => {
        const officialMatch = feature.officialMatch;
        if (officialMatch?.officialHasCoordinates && officialMosquesLoaded) return;
        const matchedMissingCoordinates = Boolean(officialMatch && !officialMatch.officialHasCoordinates);
        const isMosque = feature.kind === 'mosque';
        const fallbackName = isMosque
          ? ("${language}" === 'ar' ? 'مسجد غير مسمّى من OSM' : 'Unnamed mosque from OSM')
          : ("${language}" === 'ar' ? 'مصلى غير مسمّى من OSM' : 'Unnamed musalla from OSM');
        const name = officialMatch?.officialName || feature.osmName || fallbackName;
        if (!shouldShowMarker(name, isMosque, [feature.osmName, ...(feature.alternateNames || []), officialMatch?.officialName])) return;
        const category = matchedMissingCoordinates
          ? ("${language}" === 'ar' ? 'جامع رسمي — موقعه من OSM' : 'Official mosque — location from OSM')
          : (isMosque ? ("${language}" === 'ar' ? 'جامع من OpenStreetMap' : 'Mosque from OpenStreetMap') : ("${language}" === 'ar' ? 'مصلى من OpenStreetMap' : 'Musalla from OpenStreetMap'));
        const source = matchedMissingCoordinates
          ? ("${language}" === 'ar' ? 'اسم وزارة الأوقاف؛ الإحداثيات من OSM' : 'Ministry name; coordinates from OSM')
          : ("${language}" === 'ar' ? 'معلم OSM غير مربوط بثقة بسجل الوزارة' : 'OSM feature not confidently linked to a Ministry record');
        addMarker(feature.latitude, feature.longitude, isMosque ? '#2B9A76' : '#7C8EDB', name, category, source, feature.osmUrl, 5);
      });

      if (userLocation) {
          const latitude = Number(userLocation.lat);
          const longitude = Number(userLocation.lng);
          if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
            const position = [latitude, longitude];
            L.circleMarker(position, { renderer: markerRenderer, radius: 8, color: '#fff', weight: 2, fillColor: '#4A94F5', fillOpacity: 0.92 })
            .addTo(map)
            .bindPopup("${language}" === 'ar' ? 'موقعك الحالي' : 'Your location');
        }
      }

      setTimeout(() => map.invalidateSize(), 80);
    </script>
  </body>
</html>`;
};

const createPickerHtml = (location: { lat: number; lng: number }) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>const map=L.map('map').setView([${location.lat},${location.lng}],16);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);let marker=L.marker([${location.lat},${location.lng}]).addTo(map);map.on('click',e=>{marker.setLatLng(e.latlng);window.ReactNativeWebView.postMessage(JSON.stringify({lat:e.latlng.lat,lng:e.latlng.lng}))});</script></body></html>`;

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
  dot: { width: 6, height: 6, borderRadius: 3 },
  mapCard: { height: 300, borderRadius: 23, overflow: "hidden", backgroundColor: "#E3EFEF", position: "relative", borderWidth: 1, borderColor: "#D9E5E7", marginBottom: 8, shadowColor: COLORS.navy, shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 2 },
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
  mapCoverage: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 4, marginBottom: 10 },
  mapCoverageRetry: { color: COLORS.green, fontSize: 10, fontWeight: "800" },
  listHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", marginBottom: 9 },
  nearbyCount: { color: COLORS.ink, fontSize: 13, fontWeight: "800" },
  emptyPlacesNotice: { backgroundColor: "#F5F8FA", borderRadius: 12, padding: 11, marginBottom: 10, borderWidth: 1, borderColor: COLORS.line },
  emptyPlacesNoticeText: { color: COLORS.muted, fontSize: 11, lineHeight: 18, textAlign: "right", writingDirection: "rtl" },
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
  placeSourceText: { color: COLORS.muted, fontSize: 10, lineHeight: 15, textAlign: "right", marginBottom: 4 },
  nameRow: { flexDirection: "row-reverse", alignItems: "center", gap: 7, marginBottom: 6 },
  placeName: { color: COLORS.ink, fontSize: 15, fontWeight: "900", textAlign: "right", flexShrink: 1 },
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
  exploreLocationNote: { flexDirection: "row-reverse", alignItems: "center", gap: 7, backgroundColor: COLORS.goldSoft, borderRadius: 12, padding: 10, marginBottom: 16 },
  exploreLocationText: { flex: 1, color: COLORS.navy, fontSize: 10, fontWeight: "700", textAlign: "right", lineHeight: 16 },
  exploreQuickTitle: { color: COLORS.ink, fontSize: 14, fontWeight: "900", textAlign: "right", marginBottom: 5 },
  exploreQuickGrid: { borderTopWidth: 1, borderTopColor: COLORS.line },
  exploreQuickItem: { flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  exploreQuickText: { color: COLORS.ink, fontSize: 12, fontWeight: "800", flex: 1, textAlign: "right" },
  qiblaHeroHint: { color: COLORS.teal, fontSize: 13, fontWeight: "800", textAlign: "center", marginBottom: 3 },
  qiblaSmartBadge: { alignSelf: "center", flexDirection: "row-reverse", alignItems: "center", gap: 5, backgroundColor: "#E5F7F0", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 7 },
  qiblaSmartText: { color: COLORS.green, fontSize: 11, fontWeight: "900" },
  qiblaAutoNote: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 7, backgroundColor: "#F0F7F7", borderRadius: 13, padding: 11, marginBottom: 8, borderWidth: 1, borderColor: "#DCEBEA" },
  qiblaAutoNoteText: { flex: 1, color: COLORS.navy, fontSize: 11, lineHeight: 18, fontWeight: "700", textAlign: "right" },
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
  reminderError: { color: COLORS.red, fontSize: 11, lineHeight: 17, textAlign: "right", marginTop: 8 },
  exactAlarmHelp: { borderTopWidth: 1, borderTopColor: COLORS.line, marginTop: 9, paddingTop: 7 },
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
