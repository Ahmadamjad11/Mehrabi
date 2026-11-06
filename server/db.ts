import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import osmMosqueMapData from "../data/osm_mosque_map_points.json";
import {
  authTokens,
  favorites,
  favoritePlaceKeys,
  InsertPlace,
  InsertUser,
  oauthStateNonces,
  officialMosques,
  osmPlaceOverrides,
  placeNameSuggestions,
  places,
  reviews,
  sessionRevocations,
  users,
} from "../drizzle/schema";
import type { OpeningHoursMode, WeeklyOpeningHours } from "../shared/openingHours";
import { normalizeFavoritePlaceKey, normalizeFavoritePlaceKeys } from "../shared/favoritePlaceKeys";
import { effectivePlaceName, isNameSnapshotCurrent } from "../shared/placeNameSuggestions";
import { ENV } from "./_core/env";
import { AUTH_TOKEN_MAX_ATTEMPTS, canIssueAnotherAuthToken } from "./_core/emailAuthPolicy";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch {
      console.warn("[Database] Failed to connect");
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user");
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result[0];
}

export async function getUserByPhone(phone: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  return result[0];
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0];
}

export async function createEmailUser(input: {
  openId: string;
  name: string;
  phone: string;
  email: string;
  passwordHash: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const result = await db.insert(users).values({
    openId: input.openId,
    name: input.name,
    phone: input.phone,
    email: input.email,
    loginMethod: "email",
    passwordHash: input.passwordHash,
    lastSignedIn: new Date(),
  });
  return Number(result[0].insertId);
}

export async function markUserEmailVerified(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
}

export async function issueAuthTokenWithinLimit(
  input: {
  userId: number;
  tokenHash: string;
  type: "email_verification" | "password_reset";
  expiresAt: Date;
  },
  since: Date,
) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    // Serialize issuance per account so concurrent requests cannot bypass the 15-minute limit.
    const lockedUser = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");
    if (lockedUser.length === 0) return false;
    const recentTokens = await tx
      .select({ id: authTokens.id })
      .from(authTokens)
      .where(and(
        eq(authTokens.userId, input.userId),
        gt(authTokens.createdAt, since),
      ))
      .for("update");
    if (!canIssueAnotherAuthToken(recentTokens.length)) return false;

    await tx
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(authTokens.userId, input.userId), eq(authTokens.type, input.type), isNull(authTokens.usedAt)));
    await tx.insert(authTokens).values(input);
    return true;
  });
}

export async function getActiveAuthToken(tokenHash: string, type: "email_verification" | "password_reset") {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.type, type), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .limit(1);
  return result[0];
}

export async function getLatestActiveAuthTokenForUser(
  userId: number,
  type: "email_verification" | "password_reset",
) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.type, type), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .orderBy(desc(authTokens.createdAt))
    .limit(1);
  return result[0];
}

export async function incrementAuthTokenAttempt(tokenId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const now = new Date();
  const result = await db
    .update(authTokens)
    .set({ attemptCount: sql<number>`${authTokens.attemptCount} + 1` })
    .where(and(
      eq(authTokens.id, tokenId),
      isNull(authTokens.usedAt),
      gt(authTokens.expiresAt, now),
      lt(authTokens.attemptCount, AUTH_TOKEN_MAX_ATTEMPTS),
    ));
  return Number(result[0]?.affectedRows ?? 0) === 1;
}

export async function consumeAuthToken(tokenId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const now = new Date();
  const result = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(
      eq(authTokens.id, tokenId),
      isNull(authTokens.usedAt),
      gt(authTokens.expiresAt, now),
      lte(authTokens.attemptCount, AUTH_TOKEN_MAX_ATTEMPTS),
    ));
  return Number(result[0]?.affectedRows ?? 0) === 1;
}

export async function consumePasswordResetAndUpdatePassword(tokenId: number, userId: number, passwordHash: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const now = new Date();
    const consumed = await tx
      .update(authTokens)
      .set({ usedAt: now })
      .where(and(
        eq(authTokens.id, tokenId),
        eq(authTokens.userId, userId),
        eq(authTokens.type, "password_reset"),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
        lte(authTokens.attemptCount, AUTH_TOKEN_MAX_ATTEMPTS),
      ));
    if (Number(consumed[0]?.affectedRows ?? 0) !== 1) return false;

    const updated = await tx
      .update(users)
      .set({ passwordHash, sessionVersion: sql<number>`${users.sessionVersion} + 1` })
      .where(eq(users.id, userId));
    if (Number(updated[0]?.affectedRows ?? 0) !== 1) {
      throw new Error("Password reset user update failed");
    }
    return true;
  });
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function revokeSessionToken(token: string, expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.insert(sessionRevocations).values({ tokenHash: hashSessionToken(token), expiresAt }).onDuplicateKeyUpdate({ set: { expiresAt } });
}

export async function isSessionRevoked(token: string) {
  const db = await getDb();
  if (!db) return false;
  const result = await db.select({ tokenHash: sessionRevocations.tokenHash }).from(sessionRevocations).where(and(eq(sessionRevocations.tokenHash, hashSessionToken(token)), gt(sessionRevocations.expiresAt, new Date()))).limit(1);
  return result.length > 0;
}

export async function listPlaces(status: "approved" | "pending" | "rejected" | "deleted" = "approved") {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(places).where(eq(places.status, status));
}

export async function listAllPlaces() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(places);
}

export async function listPublicPlaces() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(places).where(eq(places.status, "approved"));
  return rows.map((place) => ({
    ...place,
    name: effectivePlaceName(place.displayName, place.name),
  }));
}

export async function listPublicMapPoints() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: places.id,
      name: places.name,
      displayName: places.displayName,
      type: places.type,
      latitude: places.latitude,
      longitude: places.longitude,
      hoursMode: places.hoursMode,
      weeklyHours: places.weeklyHours,
      isTemporarilyClosed: places.isTemporarilyClosed,
    })
    .from(places)
    .where(and(
      eq(places.status, "approved"),
      isNull(places.sourceKey),
      gte(places.latitude, -90),
      lte(places.latitude, 90),
      gte(places.longitude, -180),
      lte(places.longitude, 180),
    ))
    .orderBy(places.id);
  return rows.map(({ displayName, ...place }) => ({
    ...place,
    name: effectivePlaceName(displayName, place.name),
  }));
}

export async function getPlaceById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(places).where(and(eq(places.id, id), eq(places.status, "approved"))).limit(1);
  const place = result[0];
  return place ? { ...place, name: effectivePlaceName(place.displayName, place.name) } : undefined;
}

export async function createPlace(input: InsertPlace) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const result = await db.insert(places).values(input);
  return Number(result[0].insertId);
}

export async function getFavoritePlaceIds(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ placeId: favorites.placeId }).from(favorites).where(eq(favorites.userId, userId));
  return rows.map((row) => row.placeId);
}

export async function setFavorite(userId: number, placeId: number, enabled: boolean) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  if (enabled) {
    await db.insert(favorites).values({ userId, placeId }).onDuplicateKeyUpdate({ set: { userId } });
  } else {
    await db.delete(favorites).where(and(eq(favorites.userId, userId), eq(favorites.placeId, placeId)));
  }
}

const staticOsmFavoriteKeys = new Set(
  (osmMosqueMapData.features as { osmType: string; osmId: number }[]).map(({ osmType, osmId }) => `osm:${osmType}/${osmId}`),
);

async function getValidFavoritePlaceKeys(values: unknown) {
  const keys = normalizeFavoritePlaceKeys(values);
  const db = await getDb();
  if (!db) return [];

  const communityIds = keys.filter((key) => key.startsWith("community:")).map((key) => Number(key.slice("community:".length)));
  const ministryIds = keys.filter((key) => key.startsWith("ministry:")).map((key) => Number(key.slice("ministry:".length)));
  const communityRows = communityIds.length
    ? await db.select({ id: places.id }).from(places).where(and(
      inArray(places.id, communityIds),
      inArray(places.type, ["mosque", "musalla"]),
      eq(places.status, "approved"),
    ))
    : [];
  const ministryRows = ministryIds.length
    ? await db.select({ id: officialMosques.id }).from(officialMosques).where(and(
      inArray(officialMosques.id, ministryIds),
      eq(officialMosques.displayable, true),
    ))
    : [];
  const validKeys = new Set([
    ...communityRows.map((row) => `community:${row.id}`),
    ...ministryRows.map((row) => `ministry:${row.id}`),
    ...keys.filter((key) => key.startsWith("osm:") && staticOsmFavoriteKeys.has(key)),
  ]);
  return keys.filter((key) => validKeys.has(key));
}

export async function getFavoritePlaceKeys(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ favoriteKey: favoritePlaceKeys.favoriteKey })
    .from(favoritePlaceKeys)
    .where(eq(favoritePlaceKeys.userId, userId));
  return normalizeFavoritePlaceKeys(rows.map((row) => row.favoriteKey));
}

export async function mergeFavoritePlaceKeys(userId: number, values: unknown) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const validKeys = await getValidFavoritePlaceKeys(values);
  if (validKeys.length) {
    await db.insert(favoritePlaceKeys)
      .values(validKeys.map((favoriteKey) => ({ userId, favoriteKey })))
      .onDuplicateKeyUpdate({ set: { userId } });
  }
  return getFavoritePlaceKeys(userId);
}

export async function setFavoritePlaceKey(userId: number, value: unknown, enabled: boolean) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const favoriteKey = normalizeFavoritePlaceKey(value);
  if (!favoriteKey) return null;

  if (enabled) {
    const [validKey] = await getValidFavoritePlaceKeys([favoriteKey]);
    if (validKey !== favoriteKey) return null;
    await db.insert(favoritePlaceKeys).values({ userId, favoriteKey }).onDuplicateKeyUpdate({ set: { userId } });
  } else {
    await db.delete(favoritePlaceKeys).where(and(
      eq(favoritePlaceKeys.userId, userId),
      eq(favoritePlaceKeys.favoriteKey, favoriteKey),
    ));
  }
  return getFavoritePlaceKeys(userId);
}

export async function addReview(input: { placeId: number; userId: number; rating: number; comment?: string | null }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.insert(reviews).values({ ...input, status: "visible" });
}

export async function updatePlaceStatus(placeId: number, status: "approved" | "rejected", reviewedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.update(places).set({ status, reviewedBy, reviewedAt: new Date() }).where(eq(places.id, placeId));
}

export async function approveAllPendingPlaces(reviewedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const result = await db.update(places).set({ status: "approved", reviewedBy, reviewedAt: new Date() }).where(eq(places.status, "pending"));
  return Number(result[0]?.affectedRows ?? 0);
}

export async function deletePlace(placeId: number, reviewedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.update(places).set({ status: "deleted", reviewedBy, reviewedAt: new Date() }).where(eq(places.id, placeId));
}

export async function restorePlace(placeId: number, reviewedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.update(places).set({ status: "approved", reviewedBy, reviewedAt: new Date() }).where(eq(places.id, placeId));
}

export async function listReviews() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(reviews);
}

export async function updateReviewStatus(reviewId: number, status: "visible" | "hidden" | "reported") {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.update(reviews).set({ status }).where(eq(reviews.id, reviewId));
}

function searchPattern(value?: string) {
  const search = value?.trim().slice(0, 100);
  return search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : undefined;
}

export async function listAdminOfficialMosques(input: { search?: string; limit: number; offset: number }) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const pattern = searchPattern(input.search);
  const where = pattern
    ? or(
        like(officialMosques.name, pattern),
        like(officialMosques.displayName, pattern),
        like(officialMosques.governorate, pattern),
        like(officialMosques.directorate, pattern),
        like(officialMosques.locality, pattern),
      )
    : undefined;
  const itemsQuery = db.select({
    id: officialMosques.id,
    sourceKey: officialMosques.sourceKey,
    sourceName: officialMosques.name,
    displayName: officialMosques.displayName,
    governorate: officialMosques.governorate,
    directorate: officialMosques.directorate,
    locality: officialMosques.locality,
    latitude: officialMosques.latitude,
    longitude: officialMosques.longitude,
    displayable: officialMosques.displayable,
    isTemporarilyClosed: officialMosques.isTemporarilyClosed,
    updatedAt: officialMosques.updatedAt,
  }).from(officialMosques);
  const totalQuery = db.select({ total: count() }).from(officialMosques);
  const [items, totalRows] = await Promise.all([
    (where ? itemsQuery.where(where) : itemsQuery)
      .orderBy(officialMosques.governorate, officialMosques.directorate, officialMosques.name, officialMosques.id)
      .limit(input.limit)
      .offset(input.offset),
    where ? totalQuery.where(where) : totalQuery,
  ]);
  return { items, total: Number(totalRows[0]?.total ?? 0) };
}

export async function updateOfficialMosqueAdminRecord(input: {
  id: number;
  displayName: string | null;
  isTemporarilyClosed: boolean;
  updatedBy: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const existing = await db.select({ id: officialMosques.id }).from(officialMosques).where(eq(officialMosques.id, input.id)).limit(1);
  if (existing.length === 0) return false;
  const result = await db.update(officialMosques).set({
    displayName: input.displayName,
    isTemporarilyClosed: input.isTemporarilyClosed,
    contentUpdatedBy: input.updatedBy,
  }).where(eq(officialMosques.id, input.id));
  return Number(result[0]?.affectedRows ?? 0) > 0;
}

export async function listOfficialMosquePublicOverrides() {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    sourceKey: officialMosques.sourceKey,
    displayName: officialMosques.displayName,
    hoursMode: officialMosques.hoursMode,
    weeklyHours: officialMosques.weeklyHours,
    isTemporarilyClosed: officialMosques.isTemporarilyClosed,
  }).from(officialMosques).where(or(
    isNotNull(officialMosques.displayName),
    eq(officialMosques.isTemporarilyClosed, true),
  ));
}

export async function listOsmPlaceOverrides() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(osmPlaceOverrides);
}

export async function upsertOsmPlaceOverride(input: {
  osmKey: string;
  displayName: string | null;
  hoursMode: OpeningHoursMode;
  weeklyHours: WeeklyOpeningHours | null;
  isTemporarilyClosed: boolean;
  updatedBy: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.insert(osmPlaceOverrides).values(input).onDuplicateKeyUpdate({
    set: {
      displayName: input.displayName,
      hoursMode: input.hoursMode,
      weeklyHours: input.weeklyHours,
      isTemporarilyClosed: input.isTemporarilyClosed,
      updatedBy: input.updatedBy,
    },
  });
}

export async function listAdminPlaces(input: { search?: string; limit: number; offset: number }) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const pattern = searchPattern(input.search);
  const communityPlaces = and(eq(places.status, "approved"), isNull(places.sourceKey), inArray(places.type, ["mosque", "musalla"]));
  const where = pattern
    ? and(communityPlaces, or(like(places.name, pattern), like(places.displayName, pattern), like(places.address, pattern)))
    : communityPlaces;
  const itemsQuery = db.select().from(places);
  const totalQuery = db.select({ total: count() }).from(places);
  const [items, totalRows] = await Promise.all([
    (where ? itemsQuery.where(where) : itemsQuery)
      .orderBy(desc(places.updatedAt), places.id)
      .limit(input.limit)
      .offset(input.offset),
    where ? totalQuery.where(where) : totalQuery,
  ]);
  return { items, total: Number(totalRows[0]?.total ?? 0) };
}

export async function listAdminModerationPlaces(input: {
  status: "all" | "pending" | "approved" | "rejected" | "deleted";
  search?: string;
  limit: number;
  offset: number;
}) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const base = [
    isNull(places.sourceKey),
    inArray(places.type, ["mosque", "musalla"]),
  ];
  if (input.status !== "all") base.push(eq(places.status, input.status));
  const pattern = searchPattern(input.search);
  const where = pattern
    ? and(...base, or(like(places.name, pattern), like(places.displayName, pattern), like(places.address, pattern), like(places.description, pattern)))
    : and(...base);
  const [items, totalRows] = await Promise.all([
    db.select().from(places).where(where).orderBy(desc(places.createdAt), places.id).limit(input.limit).offset(input.offset),
    db.select({ total: count() }).from(places).where(where),
  ]);
  return { items, total: Number(totalRows[0]?.total ?? 0) };
}

export async function listAdminReviews(input: {
  status: "all" | "visible" | "reported" | "hidden";
  search?: string;
  limit: number;
  offset: number;
}) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const statusFilter = input.status === "all" ? undefined : eq(reviews.status, input.status);
  const pattern = searchPattern(input.search);
  const searchFilter = pattern
    ? or(like(reviews.comment, pattern), like(sql`CAST(${reviews.placeId} AS CHAR)`, pattern), like(sql`CAST(${reviews.id} AS CHAR)`, pattern))
    : undefined;
  const where = statusFilter && searchFilter ? and(statusFilter, searchFilter) : statusFilter ?? searchFilter;
  const itemsQuery = db.select({
    id: reviews.id,
    placeId: reviews.placeId,
    rating: reviews.rating,
    comment: reviews.comment,
    status: reviews.status,
    createdAt: reviews.createdAt,
  }).from(reviews);
  const totalQuery = db.select({ total: count() }).from(reviews);
  const [items, totalRows] = await Promise.all([
    (where ? itemsQuery.where(where) : itemsQuery).orderBy(desc(reviews.createdAt), reviews.id).limit(input.limit).offset(input.offset),
    where ? totalQuery.where(where) : totalQuery,
  ]);
  return { items, total: Number(totalRows[0]?.total ?? 0) };
}

export async function updateAdminCommunityPlaceStatus(input: {
  id: number;
  status: "approved" | "rejected";
  reviewedBy: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const currentStatus = input.status === "approved" ? inArray(places.status, ["pending", "rejected"]) : eq(places.status, "pending");
  const result = await db.update(places).set({
    status: input.status,
    reviewedBy: input.reviewedBy,
    reviewedAt: new Date(),
  }).where(and(
    eq(places.id, input.id),
    isNull(places.sourceKey),
    inArray(places.type, ["mosque", "musalla"]),
    currentStatus,
  ));
  return Number(result[0]?.affectedRows ?? 0) > 0;
}

export async function softDeleteAdminCommunityPlace(id: number, reviewedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const result = await db.update(places).set({ status: "deleted", reviewedBy, reviewedAt: new Date() }).where(and(
    eq(places.id, id),
    isNull(places.sourceKey),
    inArray(places.type, ["mosque", "musalla"]),
    inArray(places.status, ["approved", "rejected"]),
  ));
  return Number(result[0]?.affectedRows ?? 0) > 0;
}

export async function restoreAdminCommunityPlace(id: number, reviewedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const result = await db.update(places).set({ status: "approved", reviewedBy, reviewedAt: new Date() }).where(and(
    eq(places.id, id),
    isNull(places.sourceKey),
    inArray(places.type, ["mosque", "musalla"]),
    eq(places.status, "deleted"),
  ));
  return Number(result[0]?.affectedRows ?? 0) > 0;
}

export async function approveAllAdminCommunityPlaces(reviewedBy: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const result = await db.update(places).set({ status: "approved", reviewedBy, reviewedAt: new Date() }).where(and(
    isNull(places.sourceKey),
    inArray(places.type, ["mosque", "musalla"]),
    eq(places.status, "pending"),
  ));
  return Number(result[0]?.affectedRows ?? 0);
}

export async function getAdminPlaceById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(places).where(and(
    eq(places.id, id),
    eq(places.status, "approved"),
    isNull(places.sourceKey),
    inArray(places.type, ["mosque", "musalla"]),
  )).limit(1);
  return rows[0];
}

export async function updateCommunityPlaceAdminRecord(input: {
  id: number;
  displayName: string | null;
  hoursMode: OpeningHoursMode;
  weeklyHours: WeeklyOpeningHours | null;
  isTemporarilyClosed: boolean;
  updatedBy: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const result = await db.update(places).set({
    displayName: input.displayName,
    hoursMode: input.hoursMode,
    weeklyHours: input.weeklyHours,
    isTemporarilyClosed: input.isTemporarilyClosed,
    contentUpdatedBy: input.updatedBy,
  }).where(and(
    eq(places.id, input.id),
    eq(places.status, "approved"),
    isNull(places.sourceKey),
    inArray(places.type, ["mosque", "musalla"]),
  ));
  return Number(result[0]?.affectedRows ?? 0) > 0;
}

export async function listOfficialMosques(input: {
  search?: string;
  limit: number;
  offset: number;
}) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };

  const search = input.search?.trim().slice(0, 100);
  const pattern = search
    ? `%${search.replace(/[\\%_]/g, "\\$&")}%`
    : undefined;
  const displayable = eq(officialMosques.displayable, true);
  const where = pattern
    ? and(
        displayable,
        or(
          like(officialMosques.name, pattern),
          like(officialMosques.displayName, pattern),
          like(officialMosques.governorate, pattern),
          like(officialMosques.directorate, pattern),
          like(officialMosques.locality, pattern),
        ),
      )
    : displayable;

  const [items, totalRows] = await Promise.all([
    db
      .select()
      .from(officialMosques)
      .where(where)
      .orderBy(officialMosques.governorate, officialMosques.directorate, officialMosques.name, officialMosques.id)
      .limit(input.limit)
      .offset(input.offset),
    db.select({ total: count() }).from(officialMosques).where(where),
  ]);
  return { items, total: Number(totalRows[0]?.total ?? 0) };
}

export async function listOfficialMosqueMapPoints() {
  const db = await getDb();
  if (!db) return { items: [], totalDisplayable: 0 };

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: officialMosques.id,
        name: officialMosques.name,
        sourceName: officialMosques.name,
        sourceKey: officialMosques.sourceKey,
        latitude: officialMosques.latitude,
        longitude: officialMosques.longitude,
        displayName: officialMosques.displayName,
        hoursMode: officialMosques.hoursMode,
        weeklyHours: officialMosques.weeklyHours,
        isTemporarilyClosed: officialMosques.isTemporarilyClosed,
      })
      .from(officialMosques)
      .where(and(
        eq(officialMosques.displayable, true),
        isNotNull(officialMosques.latitude),
        isNotNull(officialMosques.longitude),
      ))
      .orderBy(officialMosques.governorate, officialMosques.directorate, officialMosques.name, officialMosques.id),
    db.select({ total: count() }).from(officialMosques).where(eq(officialMosques.displayable, true)),
  ]);

  const items = rows.flatMap((row) => {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return [];
    }
    return [{
      id: row.id,
      sourceKey: row.sourceKey,
      name: row.displayName?.trim() || row.name,
      sourceName: row.sourceName,
      latitude,
      longitude,
      hoursMode: row.hoursMode,
      weeklyHours: row.weeklyHours,
      isTemporarilyClosed: row.isTemporarilyClosed,
    }];
  });

  return { items, totalDisplayable: Number(totalRows[0]?.total ?? 0) };
}

export async function createOAuthStateNonce(
  nonce: string,
  platform: "web" | "native",
  expiresAt: Date,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database is not available for OAuth state");

  await db.delete(oauthStateNonces).where(lt(oauthStateNonces.expiresAt, new Date()));
  await db.insert(oauthStateNonces).values({ nonce, platform, expiresAt });
}

export async function consumeOAuthStateNonce(
  nonce: string,
  platform: "web" | "native",
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database is not available for OAuth state");

  // DELETE is atomic, so two concurrent callbacks cannot both consume the same nonce.
  const result = await db
    .delete(oauthStateNonces)
    .where(
      and(
        eq(oauthStateNonces.nonce, nonce),
        eq(oauthStateNonces.platform, platform),
        gt(oauthStateNonces.expiresAt, new Date()),
      ),
    );
  return result[0].affectedRows === 1;
}

export type PlaceNameSuggestionSource = "community" | "official" | "osm";
export type PlaceNameSuggestionTarget = {
  source: PlaceNameSuggestionSource;
  sourceKey: string;
  currentName: string;
  targetKind: "mosque" | "musalla";
  targetArea: string | null;
  targetLatitude: number | null;
  targetLongitude: number | null;
  targetUrl: string | null;
};

export async function getDatabaseNameSuggestionTarget(source: "community" | "official", id: number): Promise<PlaceNameSuggestionTarget | null> {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");

  if (source === "community") {
    const rows = await db.select({
      id: places.id,
      name: places.name,
      displayName: places.displayName,
      type: places.type,
      address: places.address,
      latitude: places.latitude,
      longitude: places.longitude,
    }).from(places).where(and(
      eq(places.id, id),
      eq(places.status, "approved"),
      isNull(places.sourceKey),
      inArray(places.type, ["mosque", "musalla"]),
    )).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      source,
      sourceKey: String(row.id),
      currentName: effectivePlaceName(row.displayName, row.name),
      targetKind: row.type === "mosque" ? "mosque" : "musalla",
      targetArea: row.address,
      targetLatitude: row.latitude,
      targetLongitude: row.longitude,
      targetUrl: null,
    };
  }

  const rows = await db.select({
    id: officialMosques.id,
    name: officialMosques.name,
    displayName: officialMosques.displayName,
    governorate: officialMosques.governorate,
    directorate: officialMosques.directorate,
    locality: officialMosques.locality,
    latitude: officialMosques.latitude,
    longitude: officialMosques.longitude,
  }).from(officialMosques).where(and(
    eq(officialMosques.id, id),
    eq(officialMosques.displayable, true),
    isNotNull(officialMosques.latitude),
    isNotNull(officialMosques.longitude),
  )).limit(1);
  const row = rows[0];
  if (!row) return null;
  const latitude = row.latitude === null ? null : Number(row.latitude);
  const longitude = row.longitude === null ? null : Number(row.longitude);
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    source,
    sourceKey: String(row.id),
    currentName: row.displayName?.trim() || row.name,
    targetKind: "mosque",
    targetArea: [row.governorate, row.directorate, row.locality].filter(Boolean).join("، "),
    targetLatitude: latitude,
    targetLongitude: longitude,
    targetUrl: null,
  };
}

export async function getOsmNameOverride(osmKey: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const rows = await db.select({ displayName: osmPlaceOverrides.displayName })
    .from(osmPlaceOverrides).where(eq(osmPlaceOverrides.osmKey, osmKey)).limit(1);
  return rows[0]?.displayName ?? null;
}

export async function getOfficialDisplayNameOverride(sourceKey: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const rows = await db.select({ displayName: officialMosques.displayName })
    .from(officialMosques).where(eq(officialMosques.sourceKey, sourceKey)).limit(1);
  return rows[0]?.displayName ?? null;
}

export async function createPlaceNameSuggestion(input: {
  userId: number;
  target: PlaceNameSuggestionTarget;
  suggestedName: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const activeRequestKey = createHash("sha256")
    .update(`${input.userId}:${input.target.source}:${input.target.sourceKey}`)
    .digest("hex");
  try {
    await db.insert(placeNameSuggestions).values({
      userId: input.userId,
      source: input.target.source,
      sourceKey: input.target.sourceKey,
      targetKind: input.target.targetKind,
      currentName: input.target.currentName,
      suggestedName: input.suggestedName,
      targetArea: input.target.targetArea,
      targetLatitude: input.target.targetLatitude,
      targetLongitude: input.target.targetLongitude,
      targetUrl: input.target.targetUrl,
      status: "pending",
      activeRequestKey,
    });
    return true;
  } catch (error) {
    const dbError = error as { code?: string; cause?: { code?: string } };
    if (dbError.code === "ER_DUP_ENTRY" || dbError.cause?.code === "ER_DUP_ENTRY") return false;
    throw error;
  }
}

export async function listAdminPlaceNameSuggestions(input: {
  status: "all" | "pending" | "approved" | "rejected";
  search?: string;
  limit: number;
  offset: number;
}) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const filters = [];
  if (input.status !== "all") filters.push(eq(placeNameSuggestions.status, input.status));
  const pattern = searchPattern(input.search);
  if (pattern) filters.push(or(
    like(placeNameSuggestions.currentName, pattern),
    like(placeNameSuggestions.suggestedName, pattern),
    like(placeNameSuggestions.sourceKey, pattern),
    like(placeNameSuggestions.targetArea, pattern),
  ));
  const where = filters.length ? and(...filters) : undefined;
  const selectItems = db.select({
    id: placeNameSuggestions.id,
    source: placeNameSuggestions.source,
    sourceKey: placeNameSuggestions.sourceKey,
    targetKind: placeNameSuggestions.targetKind,
    currentName: placeNameSuggestions.currentName,
    suggestedName: placeNameSuggestions.suggestedName,
    targetArea: placeNameSuggestions.targetArea,
    targetLatitude: placeNameSuggestions.targetLatitude,
    targetLongitude: placeNameSuggestions.targetLongitude,
    targetUrl: placeNameSuggestions.targetUrl,
    status: placeNameSuggestions.status,
    createdAt: placeNameSuggestions.createdAt,
    reviewedAt: placeNameSuggestions.reviewedAt,
  }).from(placeNameSuggestions);
  const totalQuery = db.select({ total: count() }).from(placeNameSuggestions);
  const [items, totalRows] = await Promise.all([
    (where ? selectItems.where(where) : selectItems)
      .orderBy(desc(placeNameSuggestions.createdAt), desc(placeNameSuggestions.id))
      .limit(input.limit)
      .offset(input.offset),
    where ? totalQuery.where(where) : totalQuery,
  ]);
  return { items, total: Number(totalRows[0]?.total ?? 0) };
}

export async function getAdminPlaceNameSuggestionById(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const rows = await db.select().from(placeNameSuggestions)
    .where(eq(placeNameSuggestions.id, id)).limit(1);
  return rows[0];
}

export async function decideAdminPlaceNameSuggestion(input: {
  id: number;
  status: "approved" | "rejected";
  reviewedBy: number;
  osmSource?: {
    kind: "mosque" | "musalla";
    osmName?: string;
    officialSourceKey?: string;
    officialName?: string;
  };
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(placeNameSuggestions).where(and(
      eq(placeNameSuggestions.id, input.id),
      eq(placeNameSuggestions.status, "pending"),
    )).for("update");
    const suggestion = rows[0];
    if (!suggestion) return "not_pending" as const;

    if (input.status === "approved") {
      if (suggestion.source === "community") {
        const targetId = Number(suggestion.sourceKey);
        if (!Number.isSafeInteger(targetId) || targetId <= 0) return "target_missing" as const;
        const target = await tx.select({ id: places.id, name: places.name, displayName: places.displayName }).from(places).where(and(
          eq(places.id, targetId),
          eq(places.status, "approved"),
          isNull(places.sourceKey),
          inArray(places.type, ["mosque", "musalla"]),
        )).for("update");
        if (target.length === 0) return "target_missing" as const;
        if (!isNameSnapshotCurrent(suggestion.currentName, effectivePlaceName(target[0].displayName, target[0].name))) return "target_changed" as const;
        await tx.update(places).set({ displayName: suggestion.suggestedName, contentUpdatedBy: input.reviewedBy })
          .where(eq(places.id, targetId));
      } else if (suggestion.source === "official") {
        const targetId = Number(suggestion.sourceKey);
        if (!Number.isSafeInteger(targetId) || targetId <= 0) return "target_missing" as const;
        const target = await tx.select({ id: officialMosques.id, name: officialMosques.name, displayName: officialMosques.displayName }).from(officialMosques).where(and(
          eq(officialMosques.id, targetId),
          eq(officialMosques.displayable, true),
          isNotNull(officialMosques.latitude),
          isNotNull(officialMosques.longitude),
        )).for("update");
        if (target.length === 0) return "target_missing" as const;
        if (!isNameSnapshotCurrent(suggestion.currentName, effectivePlaceName(target[0].displayName, target[0].name))) return "target_changed" as const;
        await tx.update(officialMosques).set({ displayName: suggestion.suggestedName, contentUpdatedBy: input.reviewedBy })
          .where(eq(officialMosques.id, targetId));
      } else {
        const osmSource = input.osmSource;
        if (!osmSource || osmSource.kind !== suggestion.targetKind) return "target_missing" as const;
        let matchedOfficialName = osmSource.officialName?.trim() || "";
        if (osmSource.officialSourceKey) {
          const officialRows = await tx.select({ name: officialMosques.name, displayName: officialMosques.displayName })
            .from(officialMosques).where(eq(officialMosques.sourceKey, osmSource.officialSourceKey)).for("update").limit(1);
          if (officialRows[0]) matchedOfficialName = effectivePlaceName(officialRows[0].displayName, officialRows[0].name);
        }
        const overrideRows = await tx.select({ displayName: osmPlaceOverrides.displayName })
          .from(osmPlaceOverrides).where(eq(osmPlaceOverrides.osmKey, suggestion.sourceKey)).for("update").limit(1);
        const sourceName = matchedOfficialName || osmSource.osmName?.trim() || (osmSource.kind === "mosque" ? "مسجد" : "مصلى");
        const currentName = effectivePlaceName(overrideRows[0]?.displayName, sourceName);
        if (!isNameSnapshotCurrent(suggestion.currentName, currentName)) return "target_changed" as const;
        const defaultHoursMode = suggestion.targetKind === "mosque" ? "prayer_times" : "unknown";
        await tx.insert(osmPlaceOverrides).values({
          osmKey: suggestion.sourceKey,
          displayName: suggestion.suggestedName,
          hoursMode: defaultHoursMode,
          weeklyHours: null,
          isTemporarilyClosed: false,
          updatedBy: input.reviewedBy,
        }).onDuplicateKeyUpdate({ set: {
          displayName: suggestion.suggestedName,
          updatedBy: input.reviewedBy,
        } });
      }
    }

    const update = await tx.update(placeNameSuggestions).set({
      status: input.status,
      reviewedBy: input.reviewedBy,
      reviewedAt: new Date(),
      activeRequestKey: null,
    }).where(and(
      eq(placeNameSuggestions.id, input.id),
      eq(placeNameSuggestions.status, "pending"),
    ));
    if (Number(update[0]?.affectedRows ?? 0) !== 1) throw new Error("Name suggestion decision lost its pending state");
    return "saved" as const;
  });
}
