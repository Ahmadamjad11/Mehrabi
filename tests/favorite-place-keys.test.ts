import { describe, expect, it } from "vitest";
import {
  normalizeFavoritePlaceKey,
  normalizeFavoritePlaceKeys,
  planFavoriteSync,
} from "../shared/favoritePlaceKeys";

describe("favorite place keys", () => {
  it("normalizes legacy community IDs and accepts only known source shapes", () => {
    expect(normalizeFavoritePlaceKey("17")).toBe("community:17");
    expect(normalizeFavoritePlaceKey("community:17")).toBe("community:17");
    expect(normalizeFavoritePlaceKey("ministry:9")).toBe("ministry:9");
    expect(normalizeFavoritePlaceKey("osm:relation/12345")).toBe("osm:relation/12345");
    expect(normalizeFavoritePlaceKey("osm:area/12345")).toBeNull();
    expect(normalizeFavoritePlaceKey("community:0")).toBeNull();
    expect(normalizeFavoritePlaceKey("javascript:alert(1)")).toBeNull();
  });

  it("deduplicates and sorts locally stored keys", () => {
    expect(normalizeFavoritePlaceKeys(["17", "community:17", "osm:node/2", "bad"])).toEqual([
      "community:17",
      "osm:node/2",
    ]);
  });

  it("merges device favorites into the account on first sign-in without removing either side", () => {
    const plan = planFavoriteSync({
      localKeys: ["17", "osm:node/12"],
      remoteKeys: ["ministry:4"],
      snapshot: null,
      userId: 3,
    });

    expect(plan.localAdditions).toEqual(["community:17", "osm:node/12"]);
    expect(plan.mergedKeys).toEqual(["community:17", "ministry:4", "osm:node/12"]);
  });

  it("does not resurrect a cloud favorite removed on another device after the last sync", () => {
    const plan = planFavoriteSync({
      localKeys: ["community:17", "osm:node/12"],
      remoteKeys: ["community:17"],
      snapshot: { userId: 3, keys: ["community:17", "osm:node/12"] },
      userId: 3,
    });

    expect(plan.localAdditions).toEqual([]);
    expect(plan.mergedKeys).toEqual(["community:17"]);
  });

  it("does not copy another account's synced favorites, but preserves new guest favorites on account switch", () => {
    const plan = planFavoriteSync({
      localKeys: ["community:17", "osm:node/25"],
      remoteKeys: ["ministry:4"],
      snapshot: { userId: 3, keys: ["community:17"] },
      userId: 4,
    });

    expect(plan.localAdditions).toEqual(["osm:node/25"]);
    expect(plan.mergedKeys).toEqual(["ministry:4", "osm:node/25"]);
  });
});
