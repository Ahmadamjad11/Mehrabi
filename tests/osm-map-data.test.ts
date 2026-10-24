import { describe, expect, it } from "vitest";
import osmMapData from "../data/osm_mosque_map_points.json";

type Feature = (typeof osmMapData.features)[number];

const features = osmMapData.features as Feature[];
const officialMatches = features.flatMap((feature) =>
  feature.officialMatch ? [{ feature, match: feature.officialMatch }] : [],
);

describe("OSM mosque map sidecar", () => {
  it("keeps its declared ODbL source and generated feature counts consistent", () => {
    expect(osmMapData.metadata.sourcePage).toBe("https://download.geofabrik.de/asia/jordan.html");
    expect(osmMapData.metadata.license).toContain("ODbL");
    expect(osmMapData.metadata.licenseUrl).toBe("https://www.openstreetmap.org/copyright");
    expect(osmMapData.metadata.attribution).toBe("© OpenStreetMap contributors");
    expect(osmMapData.metadata.featuresCount).toBe(features.length);
    expect(features).toHaveLength(1003);
    expect(osmMapData.metadata.featuresByKind).toEqual({ mosque: 998, musalla: 5 });
  });

  it("contains only valid Jordan coordinates and links each element to its OSM feature", () => {
    const elementKeys = features.map((feature) => `${feature.osmType}/${feature.osmId}`);
    expect(new Set(elementKeys).size).toBe(features.length);

    for (const feature of features) {
      expect(Number.isFinite(feature.latitude)).toBe(true);
      expect(Number.isFinite(feature.longitude)).toBe(true);
      expect(feature.latitude).toBeGreaterThanOrEqual(29);
      expect(feature.latitude).toBeLessThanOrEqual(33.5);
      expect(feature.longitude).toBeGreaterThanOrEqual(34.5);
      expect(feature.longitude).toBeLessThanOrEqual(39.5);
      expect(feature.osmUrl).toBe(`https://www.openstreetmap.org/${feature.osmType}/${feature.osmId}`);
    }
  });

  it("keeps ministry matches one-to-one and reports only the missing-coordinate additions", () => {
    const sourceKeys = officialMatches.map(({ match }) => match.sourceKey);
    expect(new Set(sourceKeys).size).toBe(sourceKeys.length);
    expect(officialMatches).toHaveLength(osmMapData.metadata.officialMatchesCount);
    expect(officialMatches.filter(({ match }) => !match.officialHasCoordinates)).toHaveLength(
      osmMapData.metadata.officialMatchesAddingCoverage,
    );
  });
});
