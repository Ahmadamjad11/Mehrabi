import fs from "node:fs";
import mysql from "mysql2/promise";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
const elements = JSON.parse(fs.readFileSync("/tmp/amman_nodes.json", "utf8")).elements ?? [];
const connection = await mysql.createConnection(databaseUrl);
const [existingRows] = await connection.query("SELECT latitude, longitude FROM places");
const existing = existingRows.map((row) => [Number(row.latitude), Number(row.longitude)]);
let inserted = 0;
for (const element of elements) {
  const tags = element.tags ?? {};
  const latitude = Number(element.lat);
  const longitude = Number(element.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
  if (existing.some(([lat, lon]) => Math.abs(lat - latitude) < 0.00005 && Math.abs(lon - longitude) < 0.00005)) continue;
  const name = tags["name:ar"] || tags.name || `مسجد في عمّان (${element.id})`;
  const nameEn = tags["name:en"] || tags.name || null;
  const address = [tags["addr:street"], tags["addr:suburb"], tags["addr:city"] || "عمّان"].filter(Boolean).join("، ") || null;
  const hours = tags.opening_hours || "مفتوح طوال اليوم";
  const parking = [tags.parking, tags["parking:condition"]].some((v) => ["yes", "public", "surface", "street"].includes(String(v).toLowerCase()));
  await connection.execute(
    `INSERT INTO places (name, nameEn, type, description, address, latitude, longitude, hours, hasAblution, hasParking, status)
     VALUES (?, ?, 'mosque', ?, ?, ?, ?, ?, 0, ?, 'approved')`,
    [name, nameEn, "بيانات الموقع من OpenStreetMap، يرجى التحقق من التفاصيل قبل الاعتماد النهائي.", address, latitude, longitude, hours, parking ? 1 : 0],
  );
  existing.push([latitude, longitude]);
  inserted++;
}
const [[countRow]] = await connection.query("SELECT COUNT(*) AS count FROM places WHERE status='approved'");
console.log(JSON.stringify({ source: "OpenStreetMap", osmElements: elements.length, inserted, approvedPlaces: Number(countRow.count) }));
await connection.end();
