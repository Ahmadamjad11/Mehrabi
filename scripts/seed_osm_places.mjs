import fs from "node:fs";
import mysql from "mysql2/promise";

const sourcePath = process.argv.find((argument) => argument.startsWith("--source="))?.slice("--source=".length) || "/tmp/jordan_muslim_places.json";
const confirmed = process.argv.includes("--confirm-import");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
if (!confirmed) throw new Error("Refusing to write OSM records. Run the dry preview first, then add --confirm-import after approval.");
if (!fs.existsSync(sourcePath)) throw new Error(`OSM source file not found: ${sourcePath}`);

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const elements = Array.isArray(source.elements) ? source.elements : [];
const connection = await mysql.createConnection(databaseUrl);
const [existingRows] = await connection.query("SELECT latitude, longitude FROM places");
const existing = existingRows.map((row) => ({ latitude: Number(row.latitude), longitude: Number(row.longitude) }));
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
  return /مسجد|مصلى|جامع|mosque|masjid|musalla/i.test(`${tags["name:ar"] ?? ""} ${tags["name:en"] ?? ""} ${tags.name ?? ""}`);
};
let inserted = 0;
for (const element of elements) {
  const tags = element.tags ?? {};
  if (tags.amenity !== "place_of_worship" || !isMuslimPlace(tags)) continue;
  const latitude = Number(element.lat ?? element.center?.lat);
  const longitude = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
  const candidate = { latitude, longitude };
  if (existing.some((place) => distanceMeters(candidate, place) < 50)) continue;
  const name = tags["name:ar"] || tags.name || `مكان صلاة ${element.id}`;
  const nameEn = tags["name:en"] || tags.name || null;
  const address = [tags["addr:street"], tags["addr:suburb"], tags["addr:city"] || "الأردن"].filter(Boolean).join("، ") || null;
  const hours = tags.opening_hours || "غير معروفة";
  const parking = [tags.parking, tags["parking:condition"]].some((value) => ["yes", "public", "surface", "street"].includes(String(value).toLowerCase()));
  await connection.execute(
    `INSERT INTO places (name, nameEn, type, description, address, latitude, longitude, hours, hasAblution, hasParking, status)
     VALUES (?, ?, 'mosque', ?, ?, ?, ?, ?, 0, ?, 'pending')`,
    [name, nameEn, "مصدر OpenStreetMap (ODbL)؛ يحتاج إلى مراجعة الإدارة قبل النشر.", address, latitude, longitude, hours, parking ? 1 : 0],
  );
  existing.push(candidate);
  inserted++;
}
console.log(JSON.stringify({ source: "OpenStreetMap", license: "ODbL", insertedPending: inserted }));
await connection.end();
