import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import {
  authTokens,
  favorites,
  InsertPlace,
  InsertUser,
  places,
  reviews,
  sessionRevocations,
  User,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

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

export async function updateUserPassword(userId: number, passwordHash: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function createAuthToken(input: {
  userId: number;
  tokenHash: string;
  type: "email_verification" | "password_reset";
  expiresAt: Date;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.insert(authTokens).values(input);
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

export async function markAuthTokenUsed(tokenId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, tokenId));
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
  return db.select().from(places).where(inArray(places.status, ["approved", "pending"]));
}

export async function getPlaceById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(places).where(and(eq(places.id, id), eq(places.status, "approved"))).limit(1);
  return result[0];
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
