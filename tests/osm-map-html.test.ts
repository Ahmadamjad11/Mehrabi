import { describe, expect, it } from "vitest";
import { createOsmHtml, type OsmMapFeature } from "../lib/osmMapHtml";

describe("approved names in the map HTML", () => {
  it("renders community and OSM display names instead of their source names", () => {
    const osmFeature: OsmMapFeature = {
      osmType: "node",
      osmId: 91234,
      osmUrl: "https://www.openstreetmap.org/node/91234",
      kind: "mosque",
      osmName: null,
      displayName: "اسم OSM المعتمد",
      alternateNames: [],
      latitude: 31.95,
      longitude: 35.91,
      geometryMethod: "node",
      officialMatch: null,
    };
    const ministryMatchedFeature: OsmMapFeature = {
      ...osmFeature,
      osmId: 91235,
      osmUrl: "https://www.openstreetmap.org/node/91235",
      displayName: null,
      officialMatch: {
        sourceKey: "ministry-record-1",
        officialName: "اسم الوزارة الخام",
        displayName: "اسم الوزارة المعتمد",
        officialHasCoordinates: false,
        matchMethod: "manual",
      },
    };
    const html = createOsmHtml(
      [{ id: 1, name: "اسم المجتمع الخام", displayName: "اسم المجتمع المعتمد", type: "mosque", latitude: 31.95, longitude: 35.91 }],
      [],
      null,
      "ar",
      true,
      "all",
      "",
      null,
      [osmFeature, ministryMatchedFeature],
    );

    expect(html).toContain("اسم المجتمع المعتمد");
    expect(html).toContain("اسم OSM المعتمد");
    expect(html).toContain("اسم الوزارة المعتمد");
    expect(html).toContain('"displayName":"اسم OSM المعتمد"');
    expect(html).toContain("data-mehrabi-favorite-key");
    expect(html).toContain("'community:' + placeId");
    expect(html).toContain("'ministry:' + id");
    expect(html).toContain("'osm:' + feature.osmType + '/' + feature.osmId");
    expect(html).not.toContain("اسم المجتمع الخام");
  });

  it("moves the GPS marker without recentering or zooming on routine location updates", () => {
    const html = createOsmHtml([], [], null, "ar", true, "all", "", null);

    expect(html).toContain("userLocationMarker.setLatLng(position)");
    expect(html).toContain("if (centerOnFirstFix) map.setView(position");
    expect(html).toContain("window.centerMehrabiMapOnUserLocation");
    expect(html).toContain("event.data.type === 'mehrabi-user-location'");
  });
});
