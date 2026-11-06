import osmMosqueMapData from "../data/osm_mosque_map_points.json";

export type OfficialMosqueMapPoint = { id: number; name: string; latitude: number; longitude: number };
export type CommunityMapPoint = { id: number; name: string; displayName?: string | null; type: string; latitude: number; longitude: number };
export const EMPTY_OFFICIAL_MAP_POINTS: OfficialMosqueMapPoint[] = [];
export const EMPTY_COMMUNITY_MAP_POINTS: CommunityMapPoint[] = [];
export type OsmMapFeature = {
  osmType: "node" | "way" | "relation";
  osmId: number;
  osmUrl: string;
  kind: "mosque" | "musalla";
  osmName: string | null;
  displayName?: string | null;
  alternateNames: string[];
  latitude: number;
  longitude: number;
  geometryMethod: string;
  officialMatch: {
    sourceKey: string;
    officialName: string;
    displayName?: string | null;
    officialHasCoordinates: boolean;
    matchMethod: string;
  } | null;
};

export const OSM_MAP_FEATURES = osmMosqueMapData.features as OsmMapFeature[];
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

const safeInlineJson = (value: unknown) =>
  (JSON.stringify(value) ?? "null")
  .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export const createOsmHtml = (
  places: CommunityMapPoint[],
  officialMosques: OfficialMosqueMapPoint[],
  userLocation: { lat: number; lng: number } | null,
  language: "ar" | "en",
  officialMosquesLoaded: boolean,
  placeTypeFilter: "all" | "mosque" | "musalla",
  searchQuery: string,
  mapFocusLocation: { lat: number; lng: number } | null,
  osmFeatures: OsmMapFeature[] = OSM_MAP_FEATURES,
) => {
  const communityPoints = safeInlineJson(places.map(({ id, latitude, longitude, name, displayName, type }) => [latitude, longitude, displayName?.trim() || name, type, id]));
  const officialPoints = safeInlineJson(officialMosques.map(({ id, name, latitude, longitude }) => ({ id, name, latitude, longitude })));
  const osmPoints = safeInlineJson(osmFeatures.map((feature) => ({
    osmType: feature.osmType,
    osmId: feature.osmId,
    osmUrl: feature.osmUrl,
    kind: feature.kind,
    osmName: feature.osmName,
    displayName: feature.displayName,
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
      const favoriteKeys = new Set();

      window.setMehrabiFavoriteKeys = (keys) => {
        favoriteKeys.clear();
        (Array.isArray(keys) ? keys : []).forEach((key) => favoriteKeys.add(String(key)));
        document.querySelectorAll('[data-mehrabi-favorite-key]').forEach((button) => {
          const key = button.getAttribute('data-mehrabi-favorite-key');
          const selected = favoriteKeys.has(key);
          button.textContent = selected ? '♥' : '♡';
          button.setAttribute('aria-pressed', String(selected));
          button.setAttribute('aria-label', selected
            ? ("${language}" === 'ar' ? 'إزالة من المفضلة' : 'Remove from favorites')
            : ("${language}" === 'ar' ? 'إضافة إلى المفضلة' : 'Add to favorites'));
        });
      };

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

      function popupContent(name, category, source, osmUrl, favoriteKey) {
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
        if (favoriteKey) {
          const favoriteButton = document.createElement('button');
          favoriteButton.type = 'button';
          favoriteButton.setAttribute('data-mehrabi-favorite-key', favoriteKey);
          favoriteButton.setAttribute('aria-pressed', String(favoriteKeys.has(favoriteKey)));
          favoriteButton.setAttribute('aria-label', favoriteKeys.has(favoriteKey)
            ? ("${language}" === 'ar' ? 'إزالة من المفضلة' : 'Remove from favorites')
            : ("${language}" === 'ar' ? 'إضافة إلى المفضلة' : 'Add to favorites'));
          favoriteButton.textContent = favoriteKeys.has(favoriteKey) ? '♥' : '♡';
          favoriteButton.style.cssText = 'margin-top:8px;padding:5px 10px;border:1px solid #e7edf2;border-radius:8px;background:#f7f9fa;color:#d46c66;font-size:18px;line-height:1;';
          favoriteButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const message = { type: 'toggle-favorite', key: favoriteKey };
            if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
              window.ReactNativeWebView.postMessage(JSON.stringify(message));
            } else if (window.parent !== window) {
              window.parent.postMessage(message, '*');
            }
          });
          content.appendChild(favoriteButton);
        }
        return content;
      }

      function addMarker(lat, lng, color, name, category, source, osmUrl, favoriteKey, radius = 5) {
        const latitude = Number(lat);
        const longitude = Number(lng);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
        const position = [latitude, longitude];
        L.circleMarker(position, { renderer: markerRenderer, radius, color: '#fff', weight: 1.25, fillColor: color, fillOpacity: 0.92 })
          .addTo(map)
          .bindPopup(popupContent(name, category, source, osmUrl, favoriteKey));
      }

      let userLocationMarker = null;
      window.updateMehrabiUserLocation = (location, centerOnFirstFix = false) => {
        const latitude = Number(location?.lat);
        const longitude = Number(location?.lng);
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return false;
        const position = [latitude, longitude];
        if (userLocationMarker) {
          userLocationMarker.setLatLng(position);
        } else {
          userLocationMarker = L.circleMarker(position, { renderer: markerRenderer, radius: 8, color: '#fff', weight: 2, fillColor: '#4A94F5', fillOpacity: 0.92 })
            .addTo(map)
            .bindPopup("${language}" === 'ar' ? 'موقعك الحالي' : 'Your location');
        }
        if (centerOnFirstFix) map.setView(position, Math.max(map.getZoom(), 13), { animate: false });
        return true;
      };

      window.centerMehrabiMapOnUserLocation = () => {
        if (!userLocationMarker) return false;
        map.setView(userLocationMarker.getLatLng(), Math.max(map.getZoom(), 13), { animate: false });
        return true;
      };

      window.addEventListener('message', (event) => {
        if (event.source !== window.parent || !event.data) return;
        if (event.data.type === 'mehrabi-user-location') {
          window.updateMehrabiUserLocation(event.data.location, event.data.centerOnFirstFix === true);
          if (event.data.recenter === true) window.centerMehrabiMapOnUserLocation();
        } else if (event.data.type === 'mehrabi-favorite-keys') {
          window.setMehrabiFavoriteKeys(event.data.keys);
        }
      });

      communityPoints.forEach(([lat, lng, name, type, placeId]) => {
        const isMosque = type === 'مسجد' || type === 'mosque';
        if (!shouldShowMarker(name, isMosque)) return;
        const category = isMosque ? ("${language}" === 'ar' ? 'مسجد' : 'Mosque') : ("${language}" === 'ar' ? 'مصلى' : 'Musalla');
        const source = "${language}" === 'ar' ? 'مكان معتمد في التطبيق' : 'Approved place in the app';
        addMarker(lat, lng, isMosque ? '#2B9A76' : '#7C8EDB', name, category, source, null, 'community:' + placeId, 5.5);
      });

      officialMosques.forEach(({ id, name, latitude, longitude }) => {
        if (!shouldShowMarker(name, true)) return;
        const source = "${language}" === 'ar' ? 'إحداثيات سجل وزارة الأوقاف' : 'Ministry registry coordinates';
        addMarker(latitude, longitude, '#2B9A76', name, "${language}" === 'ar' ? 'جامع رسمي' : 'Official mosque', source, null, 'ministry:' + id, 6);
      });

      osmFeatures.forEach((feature) => {
        const officialMatch = feature.officialMatch;
        if (officialMatch?.officialHasCoordinates && officialMosquesLoaded) return;
        const matchedMissingCoordinates = Boolean(officialMatch && !officialMatch.officialHasCoordinates);
        const isMosque = feature.kind === 'mosque';
        const fallbackName = isMosque
          ? ("${language}" === 'ar' ? 'مسجد غير مسمّى من OSM' : 'Unnamed mosque from OSM')
          : ("${language}" === 'ar' ? 'مصلى غير مسمّى من OSM' : 'Unnamed musalla from OSM');
        const name = feature.displayName || officialMatch?.displayName || officialMatch?.officialName || feature.osmName || fallbackName;
        if (!shouldShowMarker(name, isMosque, [feature.displayName, feature.osmName, ...(feature.alternateNames || []), officialMatch?.displayName, officialMatch?.officialName])) return;
        const category = matchedMissingCoordinates
          ? ("${language}" === 'ar' ? 'جامع رسمي — موقعه من OSM' : 'Official mosque — location from OSM')
          : (isMosque ? ("${language}" === 'ar' ? 'جامع من OpenStreetMap' : 'Mosque from OpenStreetMap') : ("${language}" === 'ar' ? 'مصلى من OpenStreetMap' : 'Musalla from OpenStreetMap'));
        const source = matchedMissingCoordinates
          ? ("${language}" === 'ar' ? 'اسم وزارة الأوقاف؛ الإحداثيات من OSM' : 'Ministry name; coordinates from OSM')
          : ("${language}" === 'ar' ? 'معلم OSM غير مربوط بثقة بسجل الوزارة' : 'OSM feature not confidently linked to a Ministry record');
        addMarker(feature.latitude, feature.longitude, isMosque ? '#2B9A76' : '#7C8EDB', name, category, source, feature.osmUrl, 'osm:' + feature.osmType + '/' + feature.osmId, 5);
      });

      if (userLocation) window.updateMehrabiUserLocation(userLocation, false);

      setTimeout(() => map.invalidateSize(), 80);
    </script>
  </body>
</html>`;
};

export const createPickerHtml = (location: { lat: number; lng: number }) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/><style>html,body,#map{height:100%;margin:0}</style></head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>const map=L.map('map').setView([${location.lat},${location.lng}],16);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);let marker=L.marker([${location.lat},${location.lng}]).addTo(map);map.on('click',e=>{marker.setLatLng(e.latlng);window.ReactNativeWebView.postMessage(JSON.stringify({lat:e.latlng.lat,lng:e.latlng.lng}))});</script></body></html>`;
