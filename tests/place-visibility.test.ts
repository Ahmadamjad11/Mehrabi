import { describe, expect, it } from "vitest";
import { filterApprovedPlaces } from "../shared/place-visibility";

describe("public place visibility", () => {
  it("keeps only approved records, including when input comes from an offline cache", () => {
    const places = [
      { id: 1, status: "approved" },
      { id: 2, status: "pending" },
      { id: 3, status: "rejected" },
      { id: 4, status: null },
      { id: 5 },
    ];

    expect(filterApprovedPlaces(places)).toEqual([{ id: 1, status: "approved" }]);
  });
});
