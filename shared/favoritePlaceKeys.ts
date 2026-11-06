export type FavoriteSyncSnapshot = {
  userId: number;
  keys: string[];
};

export type FavoriteSyncPlan = {
  mergedKeys: string[];
  localAdditions: string[];
};

export const normalizeFavoritePlaceKey = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (/^[1-9]\d{0,9}$/.test(key)) return `community:${key}`;
  if (/^community:[1-9]\d{0,9}$/.test(key)) return key;
  if (/^ministry:[1-9]\d{0,9}$/.test(key)) return key;
  if (/^osm:(?:node|way|relation)\/[1-9]\d{0,19}$/.test(key)) return key;
  return null;
};

export const normalizeFavoritePlaceKeys = (values: unknown): string[] => {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeFavoritePlaceKey).filter((key): key is string => key !== null))].sort();
};

export const planFavoriteSync = (input: {
  localKeys: unknown;
  remoteKeys: unknown;
  snapshot: FavoriteSyncSnapshot | null;
  userId: number;
}): FavoriteSyncPlan => {
  const localKeys = normalizeFavoritePlaceKeys(input.localKeys);
  const remoteKeys = normalizeFavoritePlaceKeys(input.remoteKeys);
  const baselineKeys = new Set(normalizeFavoritePlaceKeys(input.snapshot?.keys));
  const localAdditions = localKeys.filter((key) => !baselineKeys.has(key));
  return {
    mergedKeys: normalizeFavoritePlaceKeys([...remoteKeys, ...localAdditions]),
    localAdditions,
  };
};
