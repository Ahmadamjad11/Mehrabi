import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Location from "expo-location";
import { Magnetometer } from "expo-sensors";
import { normalizeDegrees, shortestSignedAngle } from "@/lib/qibla";

export type QiblaCoordinates = { latitude: number; longitude: number };
export type CompassHeadingSource = "true" | "magnetic" | "sensor" | null;
export type CompassSensorStatus = "checking" | "ready" | "unavailable";
export type QiblaLocationStatus = "loading" | "ready" | "denied" | "disabled" | "error";

type PermissionState = { canAskAgain: boolean };

export function useQiblaCompass() {
  const [location, setLocation] = useState<QiblaCoordinates | null>(null);
  const [locationStatus, setLocationStatus] = useState<QiblaLocationStatus>("loading");
  const [permission, setPermission] = useState<PermissionState>({ canAskAgain: true });
  const [heading, setHeading] = useState<number | null>(null);
  const [headingSource, setHeadingSource] = useState<CompassHeadingSource>(null);
  const [headingAccuracy, setHeadingAccuracy] = useState<number | null>(null);
  const [headingUpdatedAt, setHeadingUpdatedAt] = useState<number | null>(null);
  const [sensorStatus, setSensorStatus] = useState<CompassSensorStatus>("checking");
  const [isForeground, setIsForeground] = useState(AppState.currentState === "active");
  const locationRequestId = useRef(0);
  const screenFocused = useRef(false);

  const requestLocation = useCallback(async () => {
    const requestId = ++locationRequestId.current;
    const isCurrentRequest = () => requestId === locationRequestId.current;
    setLocation(null);
    setLocationStatus("loading");
    try {
      const currentPermission = await Location.getForegroundPermissionsAsync();
      if (!isCurrentRequest()) return;
      const response = currentPermission.granted
        ? currentPermission
        : await Location.requestForegroundPermissionsAsync();
      if (!isCurrentRequest()) return;
      setPermission({ canAskAgain: response.canAskAgain });
      if (!response.granted) {
        setLocationStatus("denied");
        return;
      }

      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!isCurrentRequest()) return;
      if (!servicesEnabled) {
        setLocationStatus("disabled");
        return;
      }

      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      if (!isCurrentRequest()) return;
      const next = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      if (!Number.isFinite(next.latitude) || !Number.isFinite(next.longitude)) {
        setLocationStatus("error");
        return;
      }
      setLocation(next);
      setLocationStatus("ready");
    } catch {
      if (isCurrentRequest()) setLocationStatus("error");
    }
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setIsForeground(state === "active");
      if (state === "active" && screenFocused.current && locationStatus !== "loading") {
        void requestLocation();
      }
    });
    return () => subscription.remove();
  }, [locationStatus, requestLocation]);

  useFocusEffect(
    useCallback(() => {
      screenFocused.current = true;
      void requestLocation();
      return () => {
        screenFocused.current = false;
        locationRequestId.current += 1;
      };
    }, [requestLocation]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!isForeground || Platform.OS === "web") return;

      let disposed = false;
      let receivedHeading = false;
      let locationHeadingSubscription: { remove: () => void } | null = null;
      let magnetometerSubscription: { remove: () => void } | null = null;
      let locationHeadingAvailable = false;
      const availabilityTimer = setTimeout(() => {
        if (!receivedHeading) setSensorStatus("unavailable");
      }, 5000);
      setHeading(null);
      setHeadingSource(null);
      setHeadingAccuracy(null);
      setHeadingUpdatedAt(null);
      setSensorStatus("checking");

      const publishHeading = (
        next: number,
        source: Exclude<CompassHeadingSource, null>,
        accuracy: number | null,
      ) => {
        if (disposed || !Number.isFinite(next)) return;
        receivedHeading = true;
        setSensorStatus("ready");
        const normalized = normalizeDegrees(next);
        setHeading((previous) =>
          previous === null
            ? normalized
            : normalizeDegrees(previous + shortestSignedAngle(normalized, previous) * 0.24),
        );
        setHeadingSource(source);
        setHeadingAccuracy(accuracy);
        setHeadingUpdatedAt(Date.now());
      };

      void Location.watchHeadingAsync((reading) => {
        const usesTrueNorth = reading.trueHeading >= 0;
        const value = usesTrueNorth ? reading.trueHeading : reading.magHeading;
        if (!Number.isFinite(value)) return;
        locationHeadingAvailable = true;
        publishHeading(
          value,
          usesTrueNorth ? "true" : "magnetic",
          Number.isFinite(reading.accuracy) && reading.accuracy >= 0 ? reading.accuracy : null,
        );
      })
        .then((subscription) => {
          if (disposed) subscription.remove();
          else locationHeadingSubscription = subscription;
        })
        .catch(() => undefined);

      void Magnetometer.isAvailableAsync()
        .then(async (available) => {
          if (disposed || locationHeadingAvailable) return;
          if (!available) {
            if (!receivedHeading) setSensorStatus("unavailable");
            return;
          }
          const permission = await Magnetometer.requestPermissionsAsync();
          if (disposed || locationHeadingAvailable) return;
          if (!permission.granted) {
            if (!receivedHeading) setSensorStatus("unavailable");
            return;
          }
          Magnetometer.setUpdateInterval(120);
          magnetometerSubscription = Magnetometer.addListener(({ x, y }) => {
            if (locationHeadingAvailable || !Number.isFinite(x) || !Number.isFinite(y)) return;
            const magneticAngle = (Math.atan2(y, x) * 180) / Math.PI;
            publishHeading(normalizeDegrees(360 - magneticAngle), "sensor", null);
          });
        })
        .catch(() => {
          if (!disposed && !receivedHeading) setSensorStatus("unavailable");
        });

      return () => {
        disposed = true;
        clearTimeout(availabilityTimer);
        locationHeadingSubscription?.remove();
        magnetometerSubscription?.remove();
      };
    }, [isForeground]),
  );

  return {
    location,
    locationStatus,
    permission,
    requestLocation,
    heading,
    headingSource,
    headingAccuracy,
    headingUpdatedAt,
    sensorStatus,
  };
}
