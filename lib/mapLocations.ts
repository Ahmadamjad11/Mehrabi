import { getOpeningHoursStatus, type OpeningHoursMode, type WeeklyOpeningHours } from "../shared/openingHours";

export type MapLocationKind = "mosque" | "musalla";
export type MapLocationSource = "community" | "ministry" | "osm";

export type MapLocationCandidate = {
  id: string;
  favoriteKey: string;
  name: string;
  kind: MapLocationKind;
  latitude: number;
  longitude: number;
  source: MapLocationSource;
  sourceLabelAr: string;
  sourceLabelEn: string;
  osmUrl?: string;
  alternateNames?: string[];
  hoursMode?: OpeningHoursMode;
  weeklyHours?: WeeklyOpeningHours | null;
  isTemporarilyClosed?: boolean;
  open?: boolean | null;
  hasAblution?: boolean;
  hasWomenPrayer?: boolean;
  hasParking?: boolean;
  status?: "approved" | "pending" | "rejected";
};

export type Coordinate = { lat: number; lng: number };
export type RankedMapLocation = MapLocationCandidate & { distanceMeters: number };

type OpeningHoursFields = {
  hoursMode?: OpeningHoursMode;
  weeklyHours?: WeeklyOpeningHours | null;
  isTemporarilyClosed?: boolean;
};

export type CommunityMapPointInput = OpeningHoursFields & {
  id: number;
  name: string;
  displayName?: string | null;
  type: string;
  latitude: number;
  longitude: number;
  open?: boolean | null;
  hasAblution?: boolean;
  hasWomenPrayer?: boolean;
  hasParking?: boolean;
  status?: "approved" | "pending" | "rejected";
};

export type OfficialMapPointInput = OpeningHoursFields & {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
};

export type OsmMapFeatureInput = OpeningHoursFields & {
  osmType: "node" | "way" | "relation";
  osmId: number;
  osmUrl: string;
  kind: MapLocationKind;
  osmName: string | null;
  alternateNames: string[];
  latitude: number;
  longitude: number;
  displayName?: string | null;
  officialMatch: (OpeningHoursFields & {
    officialName: string;
    officialHasCoordinates: boolean;
    displayName?: string | null;
  }) | null;
};

const hasValidCoordinates = (latitude: number, longitude: number) =>
  Number.isFinite(latitude)
  && latitude >= -90
  && latitude <= 90
  && Number.isFinite(longitude)
  && longitude >= -180
  && longitude <= 180;

export const distanceMetersBetween = (origin: Coordinate, target: { latitude: number; longitude: number }) => {
  const earthRadiusMeters = 6_371_000;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lat2 = (target.latitude * Math.PI) / 180;
  const deltaLat = lat2 - lat1;
  const deltaLng = ((target.longitude - origin.lng) * Math.PI) / 180;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
};

export const buildMapLocationCandidates = (input: {
  community: CommunityMapPointInput[];
  official: OfficialMapPointInput[];
  osm: OsmMapFeatureInput[];
  officialMapLoaded: boolean;
}): MapLocationCandidate[] => {
  const community = input.community
    .filter((point) => hasValidCoordinates(point.latitude, point.longitude))
    .map((point): MapLocationCandidate => {
      const kind = point.type === "mosque" || point.type === "مسجد" ? "mosque" : "musalla";
      const hoursMode = point.hoursMode ?? (kind === "mosque" ? "prayer_times" : "unknown");
      const weeklyHours = point.weeklyHours ?? null;
      const isTemporarilyClosed = point.isTemporarilyClosed ?? false;
      return {
        id: String(point.id),
        favoriteKey: `community:${point.id}`,
        name: point.displayName?.trim() || point.name,
        kind,
        latitude: point.latitude,
        longitude: point.longitude,
        source: "community",
        sourceLabelAr: "مكان معتمد في محرابي",
        sourceLabelEn: "Approved place in Mehrabi",
        hoursMode,
        weeklyHours,
        isTemporarilyClosed,
        open: point.open ?? getOpeningHoursStatus({ kind, mode: hoursMode, weeklyHours, isTemporarilyClosed }),
        hasAblution: point.hasAblution ?? false,
        hasWomenPrayer: point.hasWomenPrayer ?? false,
        hasParking: point.hasParking ?? false,
        status: point.status ?? "approved",
      };
    });

  const official = input.official
    .filter((point) => hasValidCoordinates(point.latitude, point.longitude))
    .map((point): MapLocationCandidate => {
      const hoursMode = point.hoursMode ?? "prayer_times";
      const weeklyHours = point.weeklyHours ?? null;
      const isTemporarilyClosed = point.isTemporarilyClosed ?? false;
      return {
        id: `ministry:${point.id}`,
        favoriteKey: `ministry:${point.id}`,
        name: point.name,
        kind: "mosque",
        latitude: point.latitude,
        longitude: point.longitude,
        source: "ministry",
        sourceLabelAr: "إحداثيات وزارة الأوقاف",
        sourceLabelEn: "Ministry registry coordinates",
        hoursMode,
        weeklyHours,
        isTemporarilyClosed,
        open: getOpeningHoursStatus({ kind: "mosque", mode: hoursMode, weeklyHours, isTemporarilyClosed }),
      };
    });

  const osm = input.osm
    .filter((feature) => hasValidCoordinates(feature.latitude, feature.longitude))
    .filter((feature) => !(input.officialMapLoaded && feature.officialMatch?.officialHasCoordinates))
    .map((feature): MapLocationCandidate => {
      const ministryNameMatch = Boolean(feature.officialMatch && !feature.officialMatch.officialHasCoordinates);
      const name = feature.displayName?.trim()
        || feature.officialMatch?.displayName?.trim()
        || feature.officialMatch?.officialName
        || feature.osmName?.trim()
        || (feature.kind === "mosque" ? "مسجد" : "مصلى");
      const hoursMode = feature.hoursMode
        ?? feature.officialMatch?.hoursMode
        ?? (feature.kind === "mosque" ? "prayer_times" : "unknown");
      const weeklyHours = feature.weeklyHours ?? feature.officialMatch?.weeklyHours ?? null;
      const isTemporarilyClosed = feature.isTemporarilyClosed
        ?? feature.officialMatch?.isTemporarilyClosed
        ?? false;
      return {
        id: `osm:${feature.osmType}/${feature.osmId}`,
        favoriteKey: `osm:${feature.osmType}/${feature.osmId}`,
        name,
        kind: feature.kind,
        latitude: feature.latitude,
        longitude: feature.longitude,
        source: "osm",
        sourceLabelAr: ministryNameMatch ? "اسم وزارة الأوقاف · الإحداثيات من OSM" : "OpenStreetMap",
        sourceLabelEn: ministryNameMatch ? "Ministry name · OSM coordinates" : "OpenStreetMap",
        osmUrl: feature.osmUrl,
        alternateNames: [feature.osmName, ...feature.alternateNames].filter((value): value is string => Boolean(value?.trim())),
        hoursMode,
        weeklyHours,
        isTemporarilyClosed,
        open: getOpeningHoursStatus({ kind: feature.kind, mode: hoursMode, weeklyHours, isTemporarilyClosed }),
      };
    });

  return [...community, ...official, ...osm];
};

export const rankMapLocationsByDistance = (locations: MapLocationCandidate[], origin: Coordinate): RankedMapLocation[] =>
  locations
    .filter((location) => hasValidCoordinates(location.latitude, location.longitude))
    .map((location) => ({ ...location, distanceMeters: distanceMetersBetween(origin, location) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
