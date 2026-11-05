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
    expect(html).not.toContain("اسم المجتمع الخام");
  });
});
