import { useCallback, useEffect, useRef } from "react";
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
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const didCenterOnFirstFixRef = useRef(false);
  const pendingRecenterRef = useRef(false);
  const previousRecenterSignalRef = useRef(recenterSignal);

  const sendLocation = (location: MapCoordinate, centerOnFirstFix: boolean) => {
    frameRef.current?.contentWindow?.postMessage({
      type: "mehrabi-user-location",
      location,
      centerOnFirstFix,
    }, window.location.origin);
    if (centerOnFirstFix) didCenterOnFirstFixRef.current = true;
  };

  const centerOnUserLocation = () => {
    frameRef.current?.contentWindow?.postMessage({
      type: "mehrabi-user-location",
      recenter: true,
    }, window.location.origin);
  };

  const sendFavoriteKeys = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({
      type: "mehrabi-favorite-keys",
      keys: favoriteKeys,
    }, window.location.origin);
  }, [favoriteKeys]);

  useEffect(() => {
    if (!userLocation) return;
    const centerOnFirstFix = !didCenterOnFirstFixRef.current;
    sendLocation(userLocation, centerOnFirstFix);
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
    centerOnUserLocation();
  }, [recenterSignal, userLocation]);

  useEffect(() => {
    sendFavoriteKeys();
  }, [sendFavoriteKeys]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || !event.data || event.data.type !== "toggle-favorite") return;
      const key = normalizeFavoritePlaceKey(event.data.key);
      if (key && key === event.data.key) onToggleFavorite(key);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onToggleFavorite]);

  const handleLoad = () => {
    sendFavoriteKeys();
    if (userLocation) sendLocation(userLocation, !didCenterOnFirstFixRef.current);
    if (pendingRecenterRef.current && userLocation) {
      pendingRecenterRef.current = false;
      centerOnUserLocation();
    }
  };

  return (
    <iframe
      ref={frameRef}
      title="OpenStreetMap prayer places"
      srcDoc={html}
      onLoad={handleLoad}
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="strict-origin"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: "100%",
        height: "100%",
        border: 0,
      }}
    />
  );
}
