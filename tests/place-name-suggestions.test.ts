import { describe, expect, it } from "vitest";
import { comparablePlaceName, effectivePlaceName, isNameSnapshotCurrent, isUnchangedPlaceName } from "../shared/placeNameSuggestions";

describe("place-name suggestion comparison", () => {
  it("ignores surrounding/internal whitespace, Arabic marks and tatweel", () => {
    expect(isUnchangedPlaceName("  مَسْجِدُ الرَّحْمَنِ  ", "مسجد الرحمن")).toBe(true);
    expect(comparablePlaceName("مسجد   الرحمن")).toBe(comparablePlaceName("مسجد الرحمن"));
  });

  it("still allows meaningful spelling corrections", () => {
    expect(isUnchangedPlaceName("مسجد إبراهيم", "مسجد ابراهيم")).toBe(false);
    expect(isUnchangedPlaceName("مسجد قديم", "مسجد جديد")).toBe(false);
  });

  it("does not treat an empty value as an unchanged name", () => {
    expect(isUnchangedPlaceName("", "")).toBe(false);
  });

  it("uses an explicit display-name override and otherwise keeps the source name", () => {
    expect(effectivePlaceName(" مسجد الحي ", "الاسم الأصلي")).toBe("مسجد الحي");
    expect(effectivePlaceName("  ", "الاسم الأصلي")).toBe("الاسم الأصلي");
    expect(effectivePlaceName(null, "الاسم الأصلي")).toBe("الاسم الأصلي");
  });

  it("rejects a stale name snapshot after an administrator changes the display name", () => {
    expect(isNameSnapshotCurrent("مسجد الحي", " مسجد الحي ")).toBe(true);
    expect(isNameSnapshotCurrent("مسجد الحي", "مسجد الهدى")).toBe(false);
  });
});
