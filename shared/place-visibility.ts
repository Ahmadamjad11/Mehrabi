export function filterApprovedPlaces<T extends { status?: string | null }>(places: readonly T[]): T[] {
  return places.filter((place) => place.status === "approved");
}
