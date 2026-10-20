import "dotenv/config";
import { count, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  officialMosques,
  places,
  type InsertOfficialMosque,
  type InsertPlace,
  type OfficialMosqueSourceRef,
} from "../drizzle/schema";

type OfficialMosqueInput = Omit<
  InsertOfficialMosque,
  "latitude" | "longitude" | "mapUrl" | "locality"
> & {
  sourceKey: string;
  name: string;
  governorate: string;
  directorate: string;
  locality: string | null;
  latitude: number | null;
  longitude: number | null;
  mapUrl: string | null;
  dataYear: number;
  sourceLicense: string;
  sourceRefs: OfficialMosqueSourceRef[];
};

type Archive = {
  metadata: { organizationId: string; license: string; collectedOn: string; excludedRecordsCount: number };
  recordsCount: number;
  records: OfficialMosqueInput[];
  excludedRecords: (OfficialMosqueInput & { exclusionReason: string })[];
};

async function main() {
  const archivePath = resolve(process.cwd(), "data/official_mosques.json");
  const archive = JSON.parse(await readFile(archivePath, "utf8")) as Archive;
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) throw new Error("DATABASE_URL is required for the official mosque import");
  if (archive.records.length !== archive.recordsCount) {
    throw new Error("Archive record count does not match its metadata");
  }
  if (archive.excludedRecords.length !== archive.metadata.excludedRecordsCount) {
    throw new Error("Excluded archive record count does not match its metadata");
  }
  if (!archive.metadata.organizationId || !archive.metadata.license) {
    throw new Error("Official source metadata is incomplete");
  }

  const seenKeys = new Set<string>();
  const excludedSourceKeys = new Set(archive.excludedRecords.map((record) => record.sourceKey));
  const allRecords = [...archive.records, ...archive.excludedRecords];
  for (const record of allRecords) {
    if (!/^[a-f0-9]{64}$/i.test(record.sourceKey) || seenKeys.has(record.sourceKey)) {
      throw new Error("Archive contains an invalid or duplicate source key");
    }
    seenKeys.add(record.sourceKey);
    if (
      !record.name.trim() ||
      !record.governorate.trim() ||
      !record.directorate.trim() ||
      record.sourceRefs.length === 0
    ) {
      throw new Error("Archive contains a mosque record missing its name, area or source reference");
    }
    if ((record.latitude === null) !== (record.longitude === null)) {
      throw new Error(`Archive record ${record.sourceKey} has incomplete coordinates`);
    }
    if (record.latitude !== null && record.longitude !== null) {
      if (
        !Number.isFinite(record.latitude) ||
        !Number.isFinite(record.longitude) ||
        record.latitude < 29 ||
        record.latitude > 33.5 ||
        record.longitude < 34.5 ||
        record.longitude > 39.5
      ) {
        throw new Error(`Archive record ${record.sourceKey} has coordinates outside Jordan`);
      }
    }
    if (record.mapUrl && !record.mapUrl.startsWith("https://")) {
      throw new Error(`Archive record ${record.sourceKey} has a non-HTTPS map URL`);
    }
  }
  if (archive.excludedRecords.some((record) => !record.exclusionReason.trim())) {
    throw new Error("Every excluded archive record must have an exclusion reason");
  }
  if ([...excludedSourceKeys].some((sourceKey) => !seenKeys.has(sourceKey))) {
    throw new Error("Excluded record keys were not validated");
  }

  const database = drizzle(databaseUrl);
  const batchSize = 100;
  let officialRowsSubmitted = 0;
  let mappedRowsSubmitted = 0;

  try {
    for (let offset = 0; offset < archive.records.length; offset += batchSize) {
      const batch = archive.records.slice(offset, offset + batchSize);
      await database.insert(officialMosques).values(batch.map((record) => ({ ...record, displayable: true }))).onDuplicateKeyUpdate({
        // Deliberately preserve an already imported record and any later human corrections.
        set: { sourceKey: sql`${officialMosques.sourceKey}` },
      });
      officialRowsSubmitted += batch.length;
    }

    const excludedRecords = archive.excludedRecords.map(({ exclusionReason: _reason, ...record }) => ({
      ...record,
      displayable: false,
    }));
    if (excludedRecords.length > 0) {
      await database.insert(officialMosques).values(excludedRecords).onDuplicateKeyUpdate({
        set: { displayable: false },
      });
      officialRowsSubmitted += excludedRecords.length;
    }

    const mappedPlaces: InsertPlace[] = archive.records
      .filter((record) => record.latitude !== null && record.longitude !== null)
      .map((record) => ({
        sourceKey: record.sourceKey,
        sourceUrl: record.sourceRefs[0]?.resourcePage ?? null,
        name: record.name,
        type: "mosque",
        description:
          "موقع وارد في بيانات وزارة الأوقاف الأردنية؛ لا تتوفر في المصدر معلومات موثقة عن الخدمات أو ساعات العمل.",
        address: [record.directorate, record.locality].filter(Boolean).join("، ") || record.governorate,
        latitude: record.latitude!,
        longitude: record.longitude!,
        hours: null,
        hasAblution: false,
        hasWomenPrayer: false,
        hasParking: false,
        status: "approved",
      }));

    for (let offset = 0; offset < mappedPlaces.length; offset += batchSize) {
      const batch = mappedPlaces.slice(offset, offset + batchSize);
      await database.insert(places).values(batch).onDuplicateKeyUpdate({
        // Preserve reviews, moderation, and other edits to a previously imported point.
        set: { sourceKey: sql`${places.sourceKey}` },
      });
      mappedRowsSubmitted += batch.length;
    }

    const [officialTotal] = await database.select({ total: count() }).from(officialMosques);
    const [displayableOfficialTotal] = await database
      .select({ total: count() })
      .from(officialMosques)
      .where(eq(officialMosques.displayable, true));
    const [mappedTotal] = await database
      .select({ total: count() })
      .from(places)
      .where(isNotNull(places.sourceKey));

    console.log(
      JSON.stringify(
        {
          sourceOrganization: archive.metadata.organizationId,
          sourceLicense: archive.metadata.license,
          collectedOn: archive.metadata.collectedOn,
          distinctOfficialRecordsSubmitted: officialRowsSubmitted,
          officialRecordsInDatabase: Number(officialTotal?.total ?? 0),
          displayableOfficialRecordsInDatabase: Number(displayableOfficialTotal?.total ?? 0),
          coordinateBackedPlacesSubmitted: mappedRowsSubmitted,
          coordinateBackedPlacesInDatabase: Number(mappedTotal?.total ?? 0),
        },
        null,
        2,
      ),
    );
  } finally {
    await database.$client.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
