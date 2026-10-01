import fs from "node:fs";
import mysql from "mysql2/promise";

const sourcePath = process.argv.find((argument) => argument.startsWith("--source="))?.slice("--source=".length) || "/tmp/jordan_muslim_places.json";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
if (!fs.existsSync(sourcePath)) throw new Error(`OSM source file not found: ${sourcePath}`);

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const elements = Array.isArray(source.elements) ? source.elements : [];
const connection = await mysql.createConnection(databaseUrl);
const [existingRows] = await connection.query("SELECT id, name, latitude, longitude, status FROM places");
const existing = existingRows.map((row) => ({
  id: Number(row.id),
  name: String(row.name ?? ""),
  latitude: Number(row.latitude),
  longitude: Number(row.longitude),
  status: String(row.status ?? ""),
}));

const distanceMeters = (a, b) => {
  const earthRadius = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const isMuslimPlace = (tags) => {
  const religion = String(tags.religion ?? "").toLowerCase();
  if (["christian", "jewish", "buddhist", "hindu"].includes(religion)) return false;
  if (["muslim", "islam"].includes(religion)) return true;
  const label = `${tags["name:ar"] ?? ""} ${tags["name:en"] ?? ""} ${tags.name ?? ""}`;
  return /مسجد|مصلى|جامع|mosque|masjid|musalla|musalla/i.test(label);
};

const normalized = [];
let ignoredNonMuslim = 0;
let ignoredInvalid = 0;
for (const element of elements) {
  const tags = element.tags ?? {};
  if (tags.amenity !== "place_of_worship" || !isMuslimPlace(tags)) {
    ignoredNonMuslim++;
    continue;
  }
  const latitude = Number(element.lat ?? element.center?.lat);
  const longitude = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    ignoredInvalid++;
    continue;
  }
  normalized.push({
    osmId: String(element.type ?? "node") + "/" + String(element.id),
    name: String(tags["name:ar"] || tags.name || `مكان صلاة ${element.id}`),
    latitude,
    longitude,
  });
}

const sourceUnique = [];
let sourceDuplicates = 0;
for (const item of normalized) {
  if (sourceUnique.some((other) => distanceMeters(item, other) < 50)) {
    sourceDuplicates++;
    continue;
  }
  sourceUnique.push(item);
}

const additions = sourceUnique.filter((item) => !existing.some((row) => distanceMeters(item, row) < 50));
const byStatus = existing.reduce((result, row) => {
  result[row.status] = (result[row.status] ?? 0) + 1;
  return result;
}, {});

console.log(JSON.stringify({
  mode: "preview-only",
  source: "OpenStreetMap",
  license: "ODbL",
  sourcePath,
  rawElements: elements.length,
  muslimCandidates: normalized.length,
  ignoredNonMuslimOrWrongAmenity: ignoredNonMuslim,
  ignoredInvalidCoordinates: ignoredInvalid,
  duplicateWithinSourceUnder50m: sourceDuplicates,
  existingPlaces: existing.length,
  existingByStatus: byStatus,
  duplicatesAgainstDatabaseUnder50m: sourceUnique.length - additions.length,
  proposedPendingAdditions: additions.length,
  writesPerformed: 0,
  sampleProposedAdditions: additions.slice(0, 10).map(({ osmId, name, latitude, longitude }) => ({ osmId, name, latitude, longitude })),
}, null, 2));

await connection.end();
