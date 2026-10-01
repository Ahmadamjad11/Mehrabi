import {
  boolean,
  double,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  passwordHash: varchar("passwordHash", { length: 255 }),
  emailVerifiedAt: timestamp("emailVerifiedAt"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const authTokens = mysqlTable("auth_tokens", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(),
  type: mysqlEnum("type", ["email_verification", "password_reset"]).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const sessionRevocations = mysqlTable("session_revocations", {
  tokenHash: varchar("tokenHash", { length: 128 }).primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const places = mysqlTable("places", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  nameEn: varchar("nameEn", { length: 255 }),
  type: mysqlEnum("type", ["mosque", "musalla", "station", "mall"]).default("mosque").notNull(),
  description: text("description"),
  address: varchar("address", { length: 500 }),
  latitude: double("latitude").notNull(),
  longitude: double("longitude").notNull(),
  hours: varchar("hours", { length: 255 }).default("مفتوح طوال اليوم"),
  hasAblution: boolean("hasAblution").default(false).notNull(),
  hasWomenPrayer: boolean("hasWomenPrayer").default(false).notNull(),
  hasParking: boolean("hasParking").default(false).notNull(),
  photos: text("photos"),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "deleted"]).default("pending").notNull(),
  createdBy: int("createdBy"),
  reviewedBy: int("reviewedBy"),
  reviewedAt: timestamp("reviewedAt"),
  averageRating: double("averageRating").default(0).notNull(),
  ratingsCount: int("ratingsCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const favorites = mysqlTable(
  "favorites",
  {
    userId: int("userId").notNull(),
    placeId: int("placeId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.userId, table.placeId] }) }),
);

export const reviews = mysqlTable("reviews", {
  id: int("id").autoincrement().primaryKey(),
  placeId: int("placeId").notNull(),
  userId: int("userId").notNull(),
  rating: int("rating").notNull(),
  comment: text("comment"),
  status: mysqlEnum("status", ["visible", "reported", "hidden"]).default("visible").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type AuthToken = typeof authTokens.$inferSelect;
export type SessionRevocation = typeof sessionRevocations.$inferSelect;
export type Place = typeof places.$inferSelect;
export type InsertPlace = typeof places.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type Favorite = typeof favorites.$inferSelect;
