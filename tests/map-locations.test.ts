import { describe, expect, it } from "vitest";
import {
  buildMapLocationCandidates,
  distanceMetersBetween,
  rankMapLocationsByDistance,
} from "../lib/mapLocations";

const origin = { lat: 31.9539, lng: 35.9106 };

const osmFeature = (overrides: Partial<{
  osmType: "node" | "way" | "relation";
  osmId: number;
  osmUrl: string;
  kind: "mosque" | "musalla";
  osmName: string | null;
  alternateNames: string[];
  latitude: number;
  longitude: number;
  officialMatch: { officialName: string; officialHasCoordinates: boolean } | null;
}> = {}) => ({
  osmType: "node" as const,
  osmId: 10,
  osmUrl: "https://www.openstreetmap.org/node/10",
  kind: "mosque" as const,
  osmName: "مسجد OSM",
  alternateNames: [],
  latitude: 31.96,
  longitude: 35.91,
  officialMatch: null,
  ...overrides,
});

describe("map prayer locations", () => {
  it("ranks official, OSM, and community points by exact straight-line distance", () => {
    const locations = buildMapLocationCandidates({
      community: [{ id: 7, name: "مكان مجتمع", type: "mosque", latitude: 32.1, longitude: 35.91 }],
      official: [{ id: 2, name: "مسجد رسمي", latitude: 32.02, longitude: 35.91 }],
      osm: [osmFeature({ latitude: 31.9545, longitude: 35.9106 })],
      officialMapLoaded: true,
    });

    const ranked = rankMapLocationsByDistance(locations, origin);
    expect(ranked.map((location) => location.source)).toEqual(["osm", "ministry", "community"]);
    expect(ranked[0].distanceMeters).toBeGreaterThan(0);
    expect(ranked[0].distanceMeters).toBeLessThan(ranked[1].distanceMeters);
    expect(distanceMetersBetween(origin, { latitude: origin.lat, longitude: origin.lng })).toBe(0);
  });

  it("keeps the Ministry name for a matched OSM coordinate and avoids the duplicate when Ministry coordinates load", () => {
    const locations = buildMapLocationCandidates({
      community: [],
      official: [{ id: 22, name: "جامع له إحداثي رسمي", latitude: 32, longitude: 36 }],
      osm: [
        osmFeature({
          osmId: 11,
          osmUrl: "https://www.openstreetmap.org/node/11",
          officialMatch: { officialName: "اسم الوزارة المعتمد", officialHasCoordinates: false },
        }),
        osmFeature({
          osmId: 12,
          osmUrl: "https://www.openstreetmap.org/node/12",
          officialMatch: { officialName: "جامع له إحداثي رسمي", officialHasCoordinates: true },
        }),
      ],
      officialMapLoaded: true,
    });

    expect(locations.map((location) => location.id)).toContain("osm:node/11");
    expect(locations.find((location) => location.id === "osm:node/11")?.name).toBe("اسم الوزارة المعتمد");
    expect(locations.find((location) => location.id === "osm:node/11")?.sourceLabelAr).toBe("اسم وزارة الأوقاف · الإحداثيات من OSM");
    expect(locations.map((location) => location.id)).not.toContain("osm:node/12");
    expect(locations.some((location) => location.id === "ministry:22")).toBe(true);
  });

  it("does not rank invalid or approximate coordinates supplied as invalid values", () => {
    const locations = buildMapLocationCandidates({
      community: [{ id: 1, name: "خارج النطاق", type: "mosque", latitude: 120, longitude: 36 }],
      official: [],
      osm: [osmFeature({ latitude: Number.NaN })],
      officialMapLoaded: false,
    });

    expect(locations).toHaveLength(0);
    expect(rankMapLocationsByDistance(locations, origin)).toHaveLength(0);
  });
});
