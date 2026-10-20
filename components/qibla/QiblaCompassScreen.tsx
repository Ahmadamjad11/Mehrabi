import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Defs, Line, RadialGradient, Stop } from "react-native-svg";
import { useQiblaCompass } from "@/hooks/use-qibla-compass";
import {
  bearingToKaaba,
  distanceToKaabaKm,
  isHeadingFresh,
  isHeadingReliable,
  normalizeDegrees,
  shortestSignedAngle,
} from "@/lib/qibla";

const copy = {
  ar: {
    eyebrow: "محرابي · دليل القبلة",
    title: "وجهتك إلى بيت الله",
    subtitle: "اتبع النور حتى تستقر البوصلة على وجهتها.",
    location: "موقعك الحالي",
    locationLoading: "نحدد موقعك…",
    locate: "تحديد موقعي",
    updateLocation: "تحديث الموقع",
    permissionDenied: "اسمح بالوصول إلى الموقع لحساب اتجاه القبلة بدقة.",
    permissionBlocked: "فعّل إذن الموقع من إعدادات الهاتف لحساب الاتجاه.",
    servicesDisabled: "فعّل خدمات الموقع ثم حاول مرة أخرى.",
    locationError: "تعذر تحديد الموقع الآن. حاول مرة أخرى.",
    openSettings: "فتح إعدادات الموقع",
    live: "بوصلة حية",
    sensorOffline: "الحساس غير متاح",
    approximateBadge: "اتجاه تقريبي",
    accuracyBadge: "دقة منخفضة",
    northBearing: "الزاوية من الشمال",
    direction: "اتجاه القبلة",
    distance: "المسافة إلى الكعبة",
    aligned: "أنت الآن باتجاه القبلة",
    turnRight: "التف يمينًا",
    turnLeft: "التف يسارًا",
    calibrating: "حرّك الهاتف ببطء على شكل ٨ لمعايرة البوصلة",
    sensorApprox: "الاتجاه تقريبي؛ استخدم هاتفًا بحساس بوصلة للحصول على توجيه حي دقيق.",
    webCompass: "الزاوية محسوبة من الشمال. البوصلة الحية تحتاج إلى تطبيق الهاتف وحساس الاتجاه.",
    noLocation: "حدد موقعك أولًا لعرض الاتجاه والمسافة الحقيقيين.",
    calibrationTitle: "لأفضل دقة",
    calibrationText: "حرّك الهاتف على شكل رقم ٨ ببطء، وأبعده عن المغناطيس والأغطية المغناطيسية. يتغير اتجاه البوصلة بحسب الجهاز والمكان.",
    showTip: "كيف أعاير البوصلة؟",
    hideTip: "إخفاء إرشاد المعايرة",
    precise: "اتجاه شمال حقيقي",
    approximate: "اتجاه مغناطيسي تقريبي",
    accuracyUnknown: "تعذر تحديد دقة القراءة؛ لن نؤكد المحاذاة.",
    accuracyLow: "دقة البوصلة منخفضة",
    compassUnavailable: "البوصلة الحية غير متاحة على هذا الجهاز",
    back: "العودة إلى محرابي",
    kaaba: "الكعبة المشرفة",
    degrees: "°",
    km: "كم",
    retry: "إعادة المحاولة",
    privacy: "لا نحفظ موقعك؛ نستخدمه لحساب الاتجاه والمسافة فقط.",
  },
  en: {
    eyebrow: "MEHRABI · QIBLA GUIDE",
    title: "Face the House of Allah",
    subtitle: "Follow the light as the compass settles on its direction.",
    location: "Your current location",
    locationLoading: "Finding your location…",
    locate: "Use my location",
    updateLocation: "Update location",
    permissionDenied: "Allow location access to calculate the Qibla direction accurately.",
    permissionBlocked: "Enable location access in Settings to calculate the direction.",
    servicesDisabled: "Turn on location services and try again.",
    locationError: "Unable to determine your location. Try again.",
    openSettings: "Open location settings",
    live: "LIVE COMPASS",
    sensorOffline: "NO COMPASS",
    approximateBadge: "APPROX. HEADING",
    accuracyBadge: "LOW ACCURACY",
    northBearing: "BEARING FROM NORTH",
    direction: "QIBLA DIRECTION",
    distance: "DISTANCE TO KAABA",
    aligned: "You are facing the Qibla",
    turnRight: "Turn right",
    turnLeft: "Turn left",
    calibrating: "Slowly move your phone in a figure eight to calibrate",
    sensorApprox: "Direction is approximate; use a phone with a compass sensor for precise live guidance.",
    webCompass: "Bearing is measured from north. A live compass requires the mobile app and a heading sensor.",
    noLocation: "Set your location first to see the true direction and distance.",
    calibrationTitle: "For best accuracy",
    calibrationText: "Slowly move your phone in a figure eight and keep it away from magnets and magnetic cases. Compass accuracy varies by device and surroundings.",
    showTip: "How do I calibrate the compass?",
    hideTip: "Hide calibration guide",
    precise: "True north heading",
    approximate: "Approximate magnetic heading",
    accuracyUnknown: "Heading accuracy is unavailable; alignment cannot be confirmed.",
    accuracyLow: "Compass accuracy is low",
    compassUnavailable: "Live compass is not available on this device",
    back: "Back to Mehrabi",
    kaaba: "The Holy Kaaba",
    degrees: "°",
    km: "km",
    retry: "Try again",
    privacy: "Your location is not saved; it is only used to calculate direction and distance.",
  },
} as const;

type QiblaCompassScreenProps = { language: "ar" | "en" };

const formatNumber = (value: number, language: "ar" | "en", fractionDigits = 0) =>
  value.toLocaleString(language === "ar" ? "ar-JO" : "en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

export function QiblaCompassScreen({ language }: QiblaCompassScreenProps) {
  const t = copy[language];
  const router = useRouter();
  const { width } = useWindowDimensions();
  const compass = useQiblaCompass();
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const hapticLock = useRef(false);
  const dialAngle = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const dialSize = Math.max(260, Math.min(width - 72, 318));
  const ticks = useMemo(() => Array.from({ length: 72 }, (_, index) => index), []);

  const currentLocation = compass.locationStatus === "ready" ? compass.location : null;
  const bearing = currentLocation
    ? bearingToKaaba(currentLocation.latitude, currentLocation.longitude)
    : null;
  const distance = currentLocation
    ? distanceToKaabaKm(currentLocation.latitude, currentLocation.longitude)
    : null;
  const headingFresh = isHeadingFresh(compass.headingUpdatedAt, clock);
  const headingTimedOut = compass.headingUpdatedAt !== null && clock - compass.headingUpdatedAt > 5000;
  const sensorUnavailable = compass.sensorStatus === "unavailable" || headingTimedOut;
  const reliable = Boolean(currentLocation) && isHeadingReliable({
    headingReady: compass.heading !== null,
    headingUpdatedAt: compass.headingUpdatedAt,
    headingSource: compass.headingSource === "sensor" ? "sensor" : compass.headingSource ? "gps" : null,
    headingAccuracy: compass.headingAccuracy,
    usesTrueNorth: compass.headingSource === "true",
    now: clock,
  });
  const delta = bearing !== null && compass.heading !== null
    ? shortestSignedAngle(bearing, compass.heading)
    : null;
  const aligned = reliable && delta !== null && Math.abs(delta) <= 4;

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  useEffect(() => {
    if (sensorUnavailable) {
      dialAngle.stopAnimation();
      dialAngle.setValue(0);
      return;
    }
    if (compass.heading === null) return;
    dialAngle.stopAnimation((currentValue) => {
      const currentHeading = normalizeDegrees(currentValue);
      const target = currentValue + shortestSignedAngle(compass.heading as number, currentHeading);
      Animated.timing(dialAngle, {
        toValue: target,
        duration: 170,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
  }, [compass.heading, dialAngle, sensorUnavailable]);

  useEffect(() => {
    if (!aligned) {
      hapticLock.current = false;
      return;
    }
    if (hapticLock.current || Platform.OS === "web") return;
    hapticLock.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }, [aligned]);

  const animatedDialRotation = dialAngle.interpolate({
    inputRange: [0, 360],
    outputRange: ["0deg", "-360deg"],
    extrapolate: "extend",
  });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.08] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.62] });
  const headingIsTrue = compass.headingSource === "true" && reliable;

  let guidance: string = t.noLocation;
  if (currentLocation && Platform.OS === "web") guidance = t.webCompass;
  else if (currentLocation && sensorUnavailable) guidance = t.compassUnavailable;
  else if (currentLocation && !headingFresh) guidance = t.calibrating;
  else if (currentLocation && !reliable) guidance = t.sensorApprox;
  else if (aligned) guidance = t.aligned;
  else if (delta !== null && delta > 0) guidance = `${t.turnRight} ${formatNumber(Math.round(Math.abs(delta)), language)}${t.degrees}`;
  else if (delta !== null) guidance = `${t.turnLeft} ${formatNumber(Math.round(Math.abs(delta)), language)}${t.degrees}`;

  const locationMessage = compass.locationStatus === "loading"
    ? t.locationLoading
    : compass.locationStatus === "denied"
      ? (compass.permission.canAskAgain ? t.permissionDenied : t.permissionBlocked)
      : compass.locationStatus === "disabled"
        ? t.servicesDisabled
        : compass.locationStatus === "error"
          ? t.locationError
          : t.location;

  const openLocationSettings = () => {
    if (Platform.OS === "web") return;
    void Linking.openSettings().catch(() => undefined);
  };
  const locationAction = compass.locationStatus === "denied" && !compass.permission.canAskAgain
    ? openLocationSettings
    : compass.locationStatus === "disabled" && Platform.OS !== "web"
      ? openLocationSettings
    : () => void compass.requestLocation();
  const locationActionLabel = compass.locationStatus === "loading"
    ? t.locationLoading
    : (compass.locationStatus === "disabled" || (compass.locationStatus === "denied" && !compass.permission.canAskAgain)) && Platform.OS !== "web"
      ? t.openSettings
      : compass.locationStatus === "error"
        ? t.retry
        : t.locate;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.backdropGlowTop} />
      <View style={styles.backdropGlowBottom} />
      <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.back}
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Ionicons name={language === "ar" ? "arrow-forward" : "arrow-back"} size={19} color="#F3B44B" />
          </Pressable>
          <View style={styles.brandBlock}>
            <Text style={styles.brandName}>محرابي</Text>
            <Text style={styles.brandSub}>{language === "ar" ? "اتجاه الصلاة" : "PRAYER DIRECTION"}</Text>
          </View>
          <View style={styles.liveBadge}>
            <View style={[styles.liveDot, reliable && styles.liveDotReady]} />
            <Text style={styles.liveBadgeText}>
              {reliable
                ? t.live
                : sensorUnavailable
                  ? t.sensorOffline
                  : compass.headingSource === "magnetic" || compass.headingSource === "sensor"
                    ? t.approximateBadge
                    : compass.headingSource === "true" && !reliable
                      ? t.accuracyBadge
                      : language === "ar" ? "تحديد الاتجاه" : "LOCATING"}
            </Text>
          </View>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Text style={styles.eyebrow}>{t.eyebrow}</Text>
            <Text style={styles.title}>{t.title}</Text>
            <Text style={styles.subtitle}>{t.subtitle}</Text>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={locationAction}
            style={styles.locationPill}
          >
            <View style={styles.locationIcon}><Ionicons name="location" size={15} color="#F3B44B" /></View>
            <View style={styles.locationCopy}>
              <Text style={styles.locationTitle}>{currentLocation ? t.location : locationMessage}</Text>
              <Text style={styles.locationSub}>{t.privacy}</Text>
            </View>
            <Ionicons name={compass.location ? "refresh-outline" : "chevron-back"} size={17} color="#95B8C5" />
          </Pressable>

          <View
            style={styles.compassStage}
            accessible
            accessibilityRole="image"
            accessibilityLabel={`${t.direction} · ${t.kaaba}`}
            accessibilityValue={{ text: bearing === null ? t.noLocation : `${formatNumber(Math.round(bearing), language)}${t.degrees}` }}
            accessibilityHint={distance === null ? t.noLocation : `${t.distance}: ${formatNumber(distance, language, 1)} ${t.km}`}
          >
            <Animated.View
              pointerEvents="none"
              style={[styles.ambientPulse, { width: dialSize + 42, height: dialSize + 42, opacity: pulseOpacity, transform: [{ scale: pulseScale }] }]}
            />
            <View style={[styles.compassOuter, { width: dialSize + 22, height: dialSize + 22 }]}>
              <Animated.View
                style={[
                  styles.compassDial,
                  { width: dialSize, height: dialSize },
                  { transform: [{ rotate: animatedDialRotation }] },
                ]}
              >
                <Svg width={dialSize} height={dialSize} viewBox="0 0 320 320">
                  <Defs>
                    <RadialGradient id="qiblaDiscGlow" cx="50%" cy="45%" r="60%">
                      <Stop offset="0%" stopColor="#1A4960" stopOpacity="0.82" />
                      <Stop offset="100%" stopColor="#0B2237" stopOpacity="1" />
                    </RadialGradient>
                  </Defs>
                  <Circle cx="160" cy="160" r="153" fill="url(#qiblaDiscGlow)" stroke="#D8AD59" strokeOpacity="0.78" strokeWidth="1.4" />
                  <Circle cx="160" cy="160" r="137" fill="none" stroke="#83B8B5" strokeOpacity="0.35" strokeWidth="1" />
                  <Circle cx="160" cy="160" r="105" fill="none" stroke="#83B8B5" strokeOpacity="0.19" strokeWidth="1" />
                  {ticks.map((index) => {
                    const angle = (index * 5 * Math.PI) / 180;
                    const isMajor = index % 6 === 0;
                    const inner = isMajor ? 116 : 123;
                    const outer = 137;
                    const x1 = 160 + Math.sin(angle) * inner;
                    const y1 = 160 - Math.cos(angle) * inner;
                    const x2 = 160 + Math.sin(angle) * outer;
                    const y2 = 160 - Math.cos(angle) * outer;
                    return (
                      <Line
                        key={index}
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke={isMajor ? "#F3B44B" : "#84B7B6"}
                        strokeOpacity={isMajor ? 0.95 : 0.56}
                        strokeWidth={isMajor ? 2 : 1}
                        strokeLinecap="round"
                      />
                    );
                  })}
                </Svg>

                {[
                  { label: language === "ar" ? "شمال" : "N", style: styles.cardinalNorth },
                  { label: language === "ar" ? "شرق" : "E", style: styles.cardinalEast },
                  { label: language === "ar" ? "جنوب" : "S", style: styles.cardinalSouth },
                  { label: language === "ar" ? "غرب" : "W", style: styles.cardinalWest },
                ].map(({ label, style }) => <Text key={label} style={[styles.cardinalLabel, style]}>{label}</Text>)}

                {bearing !== null && (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.qiblaOrbit,
                      { transform: [{ rotate: `${bearing}deg` }] },
                    ]}
                  >
                    <View style={[styles.qiblaRay, { top: dialSize * 0.14, bottom: dialSize * 0.49 }]} />
                    <View style={[styles.kaabaMarker, { top: dialSize * 0.035 }]}>
                      <View style={styles.kaabaCube}>
                        <View style={styles.kaabaBand} />
                        <View style={styles.kaabaDoor} />
                      </View>
                    </View>
                  </View>
                )}
              </Animated.View>

              <View pointerEvents="none" style={styles.compassCoreHalo} />
              <View pointerEvents="none" style={styles.compassCore}>
                <MaterialCommunityIcons name="compass-rose" size={31} color="#F3B44B" />
              </View>
            </View>
          </View>

          <View style={[styles.guidanceCard, aligned && styles.guidanceCardAligned]}>
            <View style={[styles.guidanceIcon, aligned && styles.guidanceIconAligned]}>
              <Ionicons
                name={aligned ? "checkmark" : delta === null ? "compass-outline" : delta > 0 ? "arrow-forward" : "arrow-back"}
                size={19}
                color={aligned ? "#0B2237" : "#F3B44B"}
              />
            </View>
            <View style={styles.guidanceCopy}>
              <Text
                style={[styles.guidanceTitle, aligned && styles.guidanceTitleAligned]}
                accessibilityLiveRegion={aligned ? "polite" : "none"}
              >
                {aligned
                  ? t.aligned
                  : !currentLocation
                    ? t.noLocation
                    : Platform.OS === "web"
                      ? t.direction
                      : sensorUnavailable
                        ? t.compassUnavailable
                        : compass.headingSource === "true" && compass.headingAccuracy === null
                          ? t.accuracyUnknown
                          : compass.headingSource === "true" && compass.headingAccuracy !== null && compass.headingAccuracy > 25
                            ? `${t.accuracyLow} · ${formatNumber(Math.round(compass.headingAccuracy), language)}${t.degrees}`
                            : delta !== null && reliable
                              ? guidance
                              : compass.headingSource === "magnetic" || compass.headingSource === "sensor"
                                ? t.sensorApprox
                                : t.calibrating}
              </Text>
              <Text style={[styles.guidanceHint, aligned && styles.guidanceHintAligned]}>
                {sensorUnavailable && Platform.OS !== "web"
                  ? t.compassUnavailable
                  : headingIsTrue
                  ? `${t.precise}${compass.headingAccuracy !== null ? ` · ${formatNumber(Math.round(compass.headingAccuracy), language)}${t.degrees}` : ""}`
                  : compass.headingSource === "true" && compass.headingAccuracy === null
                    ? t.accuracyUnknown
                  : compass.headingSource === "true" && compass.headingAccuracy !== null
                    ? `${t.accuracyLow} · ${formatNumber(Math.round(compass.headingAccuracy), language)}${t.degrees}`
                  : compass.headingSource === "magnetic"
                    ? t.approximate
                    : Platform.OS === "web" && currentLocation
                      ? t.webCompass
                      : compass.headingSource === "sensor"
                        ? t.sensorApprox
                        : currentLocation && compass.sensorStatus === "checking"
                          ? t.calibrating
                          : currentLocation
                            ? t.compassUnavailable
                          : t.sensorApprox}
              </Text>
            </View>
            {delta !== null && reliable && (
              <Text style={[styles.deltaValue, aligned && styles.deltaValueAligned]}>
                {formatNumber(Math.round(Math.abs(delta)), language)}{t.degrees}
              </Text>
            )}
          </View>

          <View style={styles.metricsRow}>
            <View style={styles.metricCard}>
              <View style={styles.metricIcon}><Ionicons name="navigate-outline" size={16} color="#F3B44B" /></View>
              <Text style={styles.metricLabel}>{t.northBearing}</Text>
              <Text style={styles.metricValue}>{bearing === null ? "—" : `${formatNumber(Math.round(bearing), language)}${t.degrees}`}</Text>
            </View>
            <View style={styles.metricCard}>
              <View style={styles.metricIcon}><Ionicons name="trail-sign-outline" size={16} color="#F3B44B" /></View>
              <Text style={styles.metricLabel}>{t.distance}</Text>
              <Text style={styles.metricValue}>{distance === null ? "—" : `${formatNumber(distance, language, 1)} ${t.km}`}</Text>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: calibrationOpen }}
            onPress={() => {
              setCalibrationOpen((open) => !open);
              if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
            }}
            style={styles.calibrationToggle}
          >
            <Ionicons name="help-circle-outline" size={18} color="#F3B44B" />
            <Text style={styles.calibrationToggleText}>{calibrationOpen ? t.hideTip : t.showTip}</Text>
            <Ionicons name={calibrationOpen ? "chevron-up" : "chevron-down"} size={16} color="#8DAAB6" />
          </Pressable>
          {calibrationOpen && (
            <View style={styles.calibrationCard}>
              <View style={styles.calibrationBadge}><MaterialCommunityIcons name="rotate-orbit" size={20} color="#F3B44B" /></View>
              <View style={styles.calibrationCopy}>
                <Text style={styles.calibrationTitle}>{t.calibrationTitle}</Text>
                <Text style={styles.calibrationText}>{t.calibrationText}</Text>
              </View>
            </View>
          )}

          {compass.locationStatus !== "ready" && (
            <Pressable
              accessibilityRole="button"
              onPress={locationAction}
              style={styles.locationAction}
            >
              <Ionicons name={compass.locationStatus === "loading" ? "time-outline" : "locate-outline"} size={18} color="#0B2237" />
              <Text style={styles.locationActionText}>
                {locationActionLabel}
              </Text>
            </Pressable>
          )}
          <Text style={styles.footerNote}>{locationMessage}</Text>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#071B2D", overflow: "hidden" },
  safeArea: { flex: 1, paddingTop: 4 },
  backdropGlowTop: { position: "absolute", width: 360, height: 360, borderRadius: 180, top: -220, right: -100, backgroundColor: "rgba(90,175,167,0.17)" },
  backdropGlowBottom: { position: "absolute", width: 330, height: 330, borderRadius: 165, bottom: -220, left: -120, backgroundColor: "rgba(243,180,75,0.09)" },
  topBar: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 19, paddingTop: 7, paddingBottom: 7 },
  backButton: { width: 42, height: 42, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.07)", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  brandBlock: { alignItems: "center" },
  brandName: { color: "#FFFFFF", fontSize: 16, fontWeight: "900", letterSpacing: 0.2 },
  brandSub: { color: "#81AAA9", fontSize: 8, letterSpacing: 1.1, marginTop: 2, fontWeight: "800" },
  liveBadge: { flexDirection: "row-reverse", alignItems: "center", gap: 6, backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", borderRadius: 999, paddingHorizontal: 9, paddingVertical: 7 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#F3B44B" },
  liveDotReady: { backgroundColor: "#72D4A5" },
  liveBadgeText: { color: "#C4D8DF", fontSize: 8, fontWeight: "900", letterSpacing: 0.6 },
  scroll: { flex: 1 },
  content: { width: "100%", maxWidth: 640, alignSelf: "center", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 30 },
  hero: { alignItems: "center", marginBottom: 16 },
  eyebrow: { color: "#E3B967", fontSize: 10, fontWeight: "900", letterSpacing: 1.1, marginBottom: 7 },
  title: { color: "#FFFFFF", fontSize: 26, fontWeight: "900", textAlign: "center", letterSpacing: -0.45 },
  subtitle: { color: "#A5BCC7", fontSize: 11, fontWeight: "600", marginTop: 6, textAlign: "center" },
  locationPill: { flexDirection: "row-reverse", alignItems: "center", gap: 9, paddingHorizontal: 11, paddingVertical: 9, marginBottom: 5, borderRadius: 15, backgroundColor: "rgba(255,255,255,0.055)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" },
  locationIcon: { width: 31, height: 31, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(243,180,75,0.12)" },
  locationCopy: { flex: 1, alignItems: "flex-end" },
  locationTitle: { color: "#F4F7F8", fontSize: 11, fontWeight: "800", textAlign: "right" },
  locationSub: { color: "#7996A5", fontSize: 8, marginTop: 3, textAlign: "right" },
  compassStage: { alignItems: "center", justifyContent: "center", paddingVertical: 21, marginTop: 2, marginBottom: 4 },
  ambientPulse: { position: "absolute", borderRadius: 999, backgroundColor: "rgba(90,175,167,0.12)", borderWidth: 1, borderColor: "rgba(90,175,167,0.18)" },
  compassOuter: { alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: "rgba(255,255,255,0.025)", borderWidth: 1, borderColor: "rgba(216,173,89,0.19)" },
  compassDial: { position: "relative", alignItems: "center", justifyContent: "center", borderRadius: 999, overflow: "hidden" },
  cardinalLabel: { position: "absolute", color: "#F6C66E", fontSize: 9, fontWeight: "900", textAlign: "center", minWidth: 26, textShadowColor: "rgba(0,0,0,0.65)", textShadowRadius: 4 },
  cardinalNorth: { top: 28, alignSelf: "center" },
  cardinalEast: { right: 25, top: "50%", marginTop: -6 },
  cardinalSouth: { bottom: 25, alignSelf: "center" },
  cardinalWest: { left: 25, top: "50%", marginTop: -6 },
  qiblaOrbit: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "flex-start" },
  qiblaRay: { position: "absolute", left: "50%", width: 2, marginLeft: -1, backgroundColor: "rgba(243,180,75,0.62)", borderRadius: 2 },
  kaabaMarker: { position: "absolute", width: 43, height: 43, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: "#F3B44B", borderWidth: 2, borderColor: "#FFF2D8", shadowColor: "#F3B44B", shadowOpacity: 0.48, shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 9 },
  kaabaCube: { width: 21, height: 19, borderRadius: 3, backgroundColor: "#101820", borderWidth: 1, borderColor: "#C69232", overflow: "hidden" },
  kaabaBand: { position: "absolute", top: 5, left: 0, right: 0, height: 3, backgroundColor: "#F3B44B" },
  kaabaDoor: { position: "absolute", bottom: 0, right: 4, width: 5, height: 8, backgroundColor: "#F3B44B", borderTopLeftRadius: 1, borderTopRightRadius: 1 },
  compassCoreHalo: { position: "absolute", width: 72, height: 72, borderRadius: 36, backgroundColor: "rgba(90,175,167,0.12)", borderWidth: 1, borderColor: "rgba(243,180,75,0.24)" },
  compassCore: { width: 55, height: 55, borderRadius: 28, backgroundColor: "#0B2237", borderWidth: 1.5, borderColor: "rgba(243,180,75,0.7)", alignItems: "center", justifyContent: "center", shadowColor: "#000000", shadowOpacity: 0.3, shadowRadius: 8, elevation: 6 },
  guidanceCard: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 17, backgroundColor: "rgba(255,255,255,0.065)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" },
  guidanceCardAligned: { backgroundColor: "rgba(83,205,151,0.14)", borderColor: "rgba(83,205,151,0.42)" },
  guidanceIcon: { width: 34, height: 34, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(243,180,75,0.12)" },
  guidanceIconAligned: { backgroundColor: "#72D4A5" },
  guidanceCopy: { flex: 1, alignItems: "flex-end" },
  guidanceTitle: { color: "#FFFFFF", fontSize: 12, fontWeight: "900", textAlign: "right" },
  guidanceTitleAligned: { color: "#9AE2BA" },
  guidanceHint: { color: "#93AEB9", fontSize: 9, marginTop: 3, textAlign: "right" },
  guidanceHintAligned: { color: "#83CFA7" },
  deltaValue: { color: "#F3B44B", fontSize: 15, fontWeight: "900" },
  deltaValueAligned: { color: "#9AE2BA" },
  metricsRow: { flexDirection: "row-reverse", gap: 9, marginTop: 11 },
  metricCard: { flex: 1, minHeight: 85, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10, alignItems: "flex-end", backgroundColor: "rgba(255,255,255,0.055)", borderWidth: 1, borderColor: "rgba(255,255,255,0.085)" },
  metricIcon: { width: 27, height: 27, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(243,180,75,0.1)", marginBottom: 5 },
  metricLabel: { color: "#809CA9", fontSize: 8, fontWeight: "800", textAlign: "right" },
  metricValue: { color: "#F4F7F8", fontSize: 16, fontWeight: "900", marginTop: 3, textAlign: "right" },
  calibrationToggle: { flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingHorizontal: 3, paddingVertical: 14 },
  calibrationToggleText: { color: "#C5D6DD", fontSize: 10, fontWeight: "800", flex: 1, textAlign: "right" },
  calibrationCard: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 10, padding: 12, marginBottom: 8, borderRadius: 15, backgroundColor: "rgba(243,180,75,0.085)", borderWidth: 1, borderColor: "rgba(243,180,75,0.18)" },
  calibrationBadge: { width: 34, height: 34, borderRadius: 12, backgroundColor: "rgba(243,180,75,0.13)", alignItems: "center", justifyContent: "center" },
  calibrationCopy: { flex: 1, alignItems: "flex-end" },
  calibrationTitle: { color: "#F5D08B", fontSize: 10, fontWeight: "900", textAlign: "right" },
  calibrationText: { color: "#A6BAC3", fontSize: 9, lineHeight: 16, marginTop: 4, textAlign: "right" },
  locationAction: { height: 48, borderRadius: 15, backgroundColor: "#F3B44B", flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 5 },
  locationActionText: { color: "#0B2237", fontSize: 12, fontWeight: "900" },
  footerNote: { color: "#6F8B99", fontSize: 8, lineHeight: 14, textAlign: "center", marginTop: 12, paddingHorizontal: 12 },
});
