export function comparablePlaceName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ar-JO")
    .replace(/[\u0640\u064B-\u065F\u0670]/g, "")
    .replace(/[\s\u200E\u200F]+/g, "");
}

export function isUnchangedPlaceName(currentName: string, proposedName: string): boolean {
  const current = comparablePlaceName(currentName.trim());
  const proposed = comparablePlaceName(proposedName.trim());
  return current.length > 0 && current === proposed;
}

export function effectivePlaceName(displayName: string | null | undefined, sourceName: string): string {
  return displayName?.trim() || sourceName;
}

export function isNameSnapshotCurrent(snapshotName: string, currentName: string): boolean {
  return snapshotName.trim() === currentName.trim();
}
