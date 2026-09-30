import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { favorites, InsertPlace, InsertUser, places, reviews, User, users } from "../drizzle/schema";
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
