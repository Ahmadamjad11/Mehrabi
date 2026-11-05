import {
  boolean,
  double,
  int,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import type { WeeklyOpeningHours } from "../shared/openingHours";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }).unique(),
  phone: varchar("phone", { length: 32 }).unique(),
  loginMethod: varchar("loginMethod", { length: 64 }),
  passwordHash: varchar("passwordHash", { length: 255 }),
  sessionVersion: int("sessionVersion").default(0).notNull(),
  emailVerifiedAt: timestamp("emailVerifiedAt"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const authTokens = mysqlTable(
  "auth_tokens",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 128 }).notNull().unique(),
    type: mysqlEnum("type", ["email_verification", "password_reset"]).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    usedAt: timestamp("usedAt"),
    attemptCount: int("attemptCount").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({ userIndex: index("auth_tokens_user_idx").on(table.userId) }),
);

export const sessionRevocations = mysqlTable("session_revocations", {
  tokenHash: varchar("tokenHash", { length: 128 }).primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const oauthStateNonces = mysqlTable(
  "oauth_state_nonces",
  {
    nonce: varchar("nonce", { length: 64 }).primaryKey(),
    platform: mysqlEnum("platform", ["web", "native"]).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({ expiresAtIndex: index("oauth_state_expires_at_idx").on(table.expiresAt) }),
);

export const places = mysqlTable("places", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  displayName: varchar("displayName", { length: 255 }),
  nameEn: varchar("nameEn", { length: 255 }),
  type: mysqlEnum("type", ["mosque", "musalla", "station", "mall"]).default("mosque").notNull(),
  description: text("description"),
  address: varchar("address", { length: 500 }),
  latitude: double("latitude").notNull(),
  longitude: double("longitude").notNull(),
  hours: varchar("hours", { length: 255 }).default("مفتوح طوال اليوم"),
  hoursMode: mysqlEnum("hoursMode", ["prayer_times", "weekly", "unknown"]).default("unknown").notNull(),
  weeklyHours: json("weeklyHours").$type<WeeklyOpeningHours | null>(),
  isTemporarilyClosed: boolean("isTemporarilyClosed").default(false).notNull(),
  hasAblution: boolean("hasAblution").default(false).notNull(),
  hasWomenPrayer: boolean("hasWomenPrayer").default(false).notNull(),
  hasParking: boolean("hasParking").default(false).notNull(),
  photos: text("photos"),
  sourceKey: varchar("sourceKey", { length: 64 }).unique(),
  sourceUrl: varchar("sourceUrl", { length: 500 }),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "deleted"]).default("pending").notNull(),
  createdBy: int("createdBy"),
  reviewedBy: int("reviewedBy"),
  reviewedAt: timestamp("reviewedAt"),
  averageRating: double("averageRating").default(0).notNull(),
  ratingsCount: int("ratingsCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  contentUpdatedBy: int("contentUpdatedBy").references(() => users.id, { onDelete: "set null" }),
});

export type OfficialMosqueSourceRef = {
  packageId: string;
  resourceId: string;
  resourceTitle: string;
  row: string;
  resourcePage: string;
  downloadUrl: string;
};

export const officialMosques = mysqlTable(
  "official_mosques",
  {
    id: int("id").autoincrement().primaryKey(),
    sourceKey: varchar("sourceKey", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    displayName: varchar("displayName", { length: 255 }),
    governorate: varchar("governorate", { length: 80 }).notNull(),
    directorate: varchar("directorate", { length: 255 }).notNull(),
    locality: varchar("locality", { length: 500 }),
    latitude: double("latitude"),
    longitude: double("longitude"),
    mapUrl: varchar("mapUrl", { length: 500 }),
    dataYear: int("dataYear").notNull(),
    sourceLicense: varchar("sourceLicense", { length: 160 }).notNull(),
    sourceRefs: json("sourceRefs").$type<OfficialMosqueSourceRef[]>().notNull(),
    displayable: boolean("displayable").default(true).notNull(),
    hoursMode: mysqlEnum("hoursMode", ["prayer_times", "weekly", "unknown"]).default("prayer_times").notNull(),
    weeklyHours: json("weeklyHours").$type<WeeklyOpeningHours | null>(),
    isTemporarilyClosed: boolean("isTemporarilyClosed").default(false).notNull(),
    contentUpdatedBy: int("contentUpdatedBy").references(() => users.id, { onDelete: "set null" }),
    importedAt: timestamp("importedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    sourceKeyUnique: uniqueIndex("official_mosques_source_key_uq").on(table.sourceKey),
      nameIndex: index("official_mosques_name_idx").on(table.name),
      governorateIndex: index("official_mosques_governorate_idx").on(table.governorate),
    }),
  );

export const osmPlaceOverrides = mysqlTable("osm_place_overrides", {
  osmKey: varchar("osmKey", { length: 40 }).primaryKey(),
  displayName: varchar("displayName", { length: 255 }),
  hoursMode: mysqlEnum("hoursMode", ["prayer_times", "weekly", "unknown"]).default("unknown").notNull(),
  weeklyHours: json("weeklyHours").$type<WeeklyOpeningHours | null>(),
  isTemporarilyClosed: boolean("isTemporarilyClosed").default(false).notNull(),
  updatedBy: int("updatedBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const favorites = mysqlTable(
  "favorites",
  {
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    placeId: int("placeId").notNull().references(() => places.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.placeId] }),
    placeIndex: index("favorites_place_idx").on(table.placeId),
  }),
);

export const reviews = mysqlTable(
  "reviews",
  {
    id: int("id").autoincrement().primaryKey(),
    placeId: int("placeId").notNull().references(() => places.id, { onDelete: "cascade" }),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    rating: int("rating").notNull(),
    comment: text("comment"),
    status: mysqlEnum("status", ["visible", "reported", "hidden"]).default("visible").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    placeIndex: index("reviews_place_idx").on(table.placeId),
    userIndex: index("reviews_user_idx").on(table.userId),
  }),
);

export const placeNameSuggestions = mysqlTable(
  "place_name_suggestions",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    source: mysqlEnum("source", ["community", "official", "osm"]).notNull(),
    sourceKey: varchar("sourceKey", { length: 255 }).notNull(),
    targetKind: mysqlEnum("targetKind", ["mosque", "musalla"]).notNull(),
    currentName: varchar("currentName", { length: 255 }).notNull(),
    suggestedName: varchar("suggestedName", { length: 255 }).notNull(),
    targetArea: varchar("targetArea", { length: 500 }),
    targetLatitude: double("targetLatitude"),
    targetLongitude: double("targetLongitude"),
    targetUrl: varchar("targetUrl", { length: 500 }),
    status: mysqlEnum("status", ["pending", "approved", "rejected"]).default("pending").notNull(),
    activeRequestKey: varchar("activeRequestKey", { length: 64 }),
    reviewedBy: int("reviewedBy").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    activeRequestUnique: uniqueIndex("place_name_suggestions_active_uq").on(table.activeRequestKey),
    statusCreatedIndex: index("place_name_suggestions_status_created_idx").on(table.status, table.createdAt),
    targetIndex: index("place_name_suggestions_target_idx").on(table.source, table.sourceKey),
  }),
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type AuthToken = typeof authTokens.$inferSelect;
export type SessionRevocation = typeof sessionRevocations.$inferSelect;
export type Place = typeof places.$inferSelect;
export type InsertPlace = typeof places.$inferInsert;
export type OfficialMosque = typeof officialMosques.$inferSelect;
export type InsertOfficialMosque = typeof officialMosques.$inferInsert;
export type OsmPlaceOverride = typeof osmPlaceOverrides.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Favorite = typeof favorites.$inferSelect;
export type PlaceNameSuggestion = typeof placeNameSuggestions.$inferSelect;
