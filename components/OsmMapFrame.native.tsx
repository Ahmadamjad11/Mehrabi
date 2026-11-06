import { useCallback, useEffect, useRef } from "react";
import { Linking, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { normalizeFavoritePlaceKey } from "../shared/favoritePlaceKeys";

type MapCoordinate = { lat: number; lng: number };

type OsmMapFrameProps = {
  html: string;
  userLocation: MapCoordinate | null;
  favoriteKeys: string[];
  onToggleFavorite: (key: string) => void;
  recenterSignal?: number;
};

export default function OsmMapFrame({ html, userLocation, favoriteKeys, onToggleFavorite, recenterSignal = 0 }: OsmMapFrameProps) {
  const webViewRef = useRef<WebView | null>(null);
  const mapLoadedRef = useRef(false);
  const didCenterOnFirstFixRef = useRef(false);
  const pendingRecenterRef = useRef(false);
  const previousRecenterSignalRef = useRef(recenterSignal);

  const injectLocation = (location: MapCoordinate, centerOnFirstFix: boolean) => {
    const payload = JSON.stringify(location);
    webViewRef.current?.injectJavaScript(
      `window.updateMehrabiUserLocation?.(${payload}, ${centerOnFirstFix ? "true" : "false"}); true;`,
    );
    if (centerOnFirstFix) didCenterOnFirstFixRef.current = true;
  };

  const centerOnUserLocation = () => {
    webViewRef.current?.injectJavaScript("window.centerMehrabiMapOnUserLocation?.(); true;");
  };

  const injectFavoriteKeys = useCallback(() => {
    const payload = JSON.stringify(favoriteKeys);
    webViewRef.current?.injectJavaScript(`window.setMehrabiFavoriteKeys?.(${payload}); true;`);
  }, [favoriteKeys]);

  useEffect(() => {
    if (!userLocation || !mapLoadedRef.current) return;
    const centerOnFirstFix = !didCenterOnFirstFixRef.current;
    injectLocation(userLocation, centerOnFirstFix);
    if (pendingRecenterRef.current) {
      pendingRecenterRef.current = false;
      if (!centerOnFirstFix) centerOnUserLocation();
    }
  }, [userLocation]);

  useEffect(() => {
    if (previousRecenterSignalRef.current === recenterSignal) return;
    previousRecenterSignalRef.current = recenterSignal;
    if (!userLocation) {
      pendingRecenterRef.current = true;
      return;
    }
    if (mapLoadedRef.current) centerOnUserLocation();
    else pendingRecenterRef.current = true;
  }, [recenterSignal, userLocation]);

  useEffect(() => {
    if (mapLoadedRef.current) injectFavoriteKeys();
  }, [injectFavoriteKeys]);

  const handleLoadEnd = () => {
    mapLoadedRef.current = true;
    injectFavoriteKeys();
    if (userLocation) injectLocation(userLocation, !didCenterOnFirstFixRef.current);
    if (pendingRecenterRef.current && userLocation) {
      pendingRecenterRef.current = false;
      centerOnUserLocation();
    }
  };

  return (
    <WebView
      ref={webViewRef}
      source={{ html }}
      style={StyleSheet.absoluteFill}
      originWhitelist={["*"]}
      userAgent="MehrabiPrayerMap/1.0 (+https://mehrabi-dvz6xk8x.manus.space)"
      javaScriptEnabled
      onLoadEnd={handleLoadEnd}
      onMessage={(event) => {
        try {
          const message = JSON.parse(event.nativeEvent.data) as { type?: string; url?: string; key?: unknown };
          if (message.type === "toggle-favorite") {
            const key = normalizeFavoritePlaceKey(message.key);
            if (key && key === message.key) onToggleFavorite(key);
            return;
          }
          if (message.type === "open-osm-link" && typeof message.url === "string"
            && /^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/.test(message.url)) {
            void Linking.openURL(message.url).catch(() => undefined);
          }
        } catch {
          // Ignore messages that are not OSM source links.
        }
      }}
    />
  );
}
