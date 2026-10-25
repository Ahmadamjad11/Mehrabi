export type MapLocationKind = "mosque" | "musalla";
export type MapLocationSource = "community" | "ministry" | "osm";

export type MapLocationCandidate = {
  id: string;
  name: string;
  kind: MapLocationKind;
  latitude: number;
  longitude: number;
  source: MapLocationSource;
  sourceLabelAr: string;
  sourceLabelEn: string;
  osmUrl?: string;
  alternateNames?: string[];
  open?: boolean | null;
  hasAblution?: boolean;
  hasWomenPrayer?: boolean;
  hasParking?: boolean;
  status?: "approved" | "pending" | "rejected";
};

export type Coordinate = { lat: number; lng: number };
export type RankedMapLocation = MapLocationCandidate & { distanceMeters: number };

export type CommunityMapPointInput = {
  id: number;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  open?: boolean | null;
  hasAblution?: boolean;
  hasWomenPrayer?: boolean;
  hasParking?: boolean;
  status?: "approved" | "pending" | "rejected";
};

export type OfficialMapPointInput = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
};

export type OsmMapFeatureInput = {
  osmType: "node" | "way" | "relation";
  osmId: number;
  osmUrl: string;
  kind: MapLocationKind;
  osmName: string | null;
  alternateNames: string[];
  latitude: number;
  longitude: number;
  officialMatch: {
    officialName: string;
    officialHasCoordinates: boolean;
  } | null;
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
    .map((point): MapLocationCandidate => ({
      id: String(point.id),
      name: point.name,
      kind: point.type === "mosque" || point.type === "مسجد" ? "mosque" : "musalla",
      latitude: point.latitude,
      longitude: point.longitude,
      source: "community",
      sourceLabelAr: "مكان معتمد في محرابي",
      sourceLabelEn: "Approved place in Mehrabi",
      open: point.open ?? null,
      hasAblution: point.hasAblution ?? false,
      hasWomenPrayer: point.hasWomenPrayer ?? false,
      hasParking: point.hasParking ?? false,
      status: point.status ?? "approved",
    }));

  const official = input.official
    .filter((point) => hasValidCoordinates(point.latitude, point.longitude))
    .map((point): MapLocationCandidate => ({
      id: `ministry:${point.id}`,
      name: point.name,
      kind: "mosque",
      latitude: point.latitude,
      longitude: point.longitude,
      source: "ministry",
      sourceLabelAr: "إحداثيات وزارة الأوقاف",
      sourceLabelEn: "Ministry registry coordinates",
    }));

  const osm = input.osm
    .filter((feature) => hasValidCoordinates(feature.latitude, feature.longitude))
    .filter((feature) => !(input.officialMapLoaded && feature.officialMatch?.officialHasCoordinates))
    .map((feature): MapLocationCandidate => {
      const ministryNameMatch = Boolean(feature.officialMatch && !feature.officialMatch.officialHasCoordinates);
      const name = feature.officialMatch?.officialName
        || feature.osmName
        || (feature.kind === "mosque" ? "مسجد غير مسمى من OSM" : "مصلى غير مسمى من OSM");
      return {
        id: `osm:${feature.osmType}/${feature.osmId}`,
        name,
        kind: feature.kind,
        latitude: feature.latitude,
        longitude: feature.longitude,
        source: "osm",
        sourceLabelAr: ministryNameMatch ? "اسم وزارة الأوقاف · الإحداثيات من OSM" : "OpenStreetMap",
        sourceLabelEn: ministryNameMatch ? "Ministry name · OSM coordinates" : "OpenStreetMap",
        osmUrl: feature.osmUrl,
        alternateNames: feature.alternateNames,
      };
    });

  return [...community, ...official, ...osm];
};

export const rankMapLocationsByDistance = (locations: MapLocationCandidate[], origin: Coordinate): RankedMapLocation[] =>
  locations
    .filter((location) => hasValidCoordinates(location.latitude, location.longitude))
    .map((location) => ({ ...location, distanceMeters: distanceMetersBetween(origin, location) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
