import { z } from "zod";
import { TRPCError } from "@trpc/server";
import osmMosqueMapData from "../data/osm_mosque_map_points.json";
import { currentSessionCookie, getSessionCookieName, getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  addReview,
  approveAllPendingPlaces,
  createPlaceNameSuggestion,
  createPlace,
  getDatabaseNameSuggestionTarget,
  getOfficialDisplayNameOverride,
  getOsmNameOverride,
  deletePlace,
  getFavoritePlaceIds,
  getFavoritePlaceKeys,
  getPlaceById,
  listAllPlaces,
  listOfficialMosquePublicOverrides,
  listOfficialMosques,
  listOfficialMosqueMapPoints,
  listOsmPlaceOverrides,
  listPlaces,
  listPublicMapPoints,
  listPublicPlaces,
  listReviews,
  mergeFavoritePlaceKeys,
  restorePlace,
  setFavorite,
  setFavoritePlaceKey,
  updatePlaceStatus,
  updateReviewStatus,
  revokeSessionToken,
  type PlaceNameSuggestionTarget,
} from "./db";
import { getOpeningHoursStatus } from "../shared/openingHours";
import { normalizeFavoritePlaceKey } from "../shared/favoritePlaceKeys";
import { effectivePlaceName, isUnchangedPlaceName } from "../shared/placeNameSuggestions";

const osmNameSuggestionFeatures = osmMosqueMapData.features;

const placeInput = z.object({
  name: z.string().min(2).max(255),
  nameEn: z.string().max(255).optional(),
  type: z.enum(["mosque", "musalla", "station", "mall"]),
  description: z.string().max(2000).optional(),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  hasAblution: z.boolean().default(false),
  hasWomenPrayer: z.boolean().default(false),
  hasParking: z.boolean().default(false),
  photos: z.string().optional(),
});

const placeListInput = z.object({
  search: z.string().optional(),
  openNow: z.boolean().optional(),
  hasAblution: z.boolean().optional(),
  hasWomenPrayer: z.boolean().optional(),
  hasParking: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).default(20),
  offset: z.number().int().min(0).default(0),
});

const nearestInput = placeListInput.extend({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

function filterPublicPlaces(rows: Awaited<ReturnType<typeof listPublicPlaces>>, input: z.infer<typeof placeListInput>) {
  const search = input.search?.trim().toLowerCase();
  return rows.filter((place) => {
    if (search && !`${place.name} ${place.nameEn ?? ""} ${place.address ?? ""}`.toLowerCase().includes(search)) return false;
    if (input.openNow && getOpeningHoursStatus({
      kind: place.type === "mosque" ? "mosque" : "musalla",
      mode: place.hoursMode,
      weeklyHours: place.weeklyHours,
      isTemporarilyClosed: place.isTemporarilyClosed,
    }) !== true) return false;
    if (input.hasAblution && !place.hasAblution) return false;
    if (input.hasWomenPrayer && !place.hasWomenPrayer) return false;
    if (input.hasParking && !place.hasParking) return false;
    return true;
  });
}

function distanceMeters(latitude: number, longitude: number, targetLatitude: number, targetLongitude: number) {
  const earthRadius = 6371000;
  const dLat = ((targetLatitude - latitude) * Math.PI) / 180;
  const dLng = ((targetLongitude - longitude) * Math.PI) / 180;
  const lat1 = (latitude * Math.PI) / 180;
  const lat2 = (targetLatitude * Math.PI) / 180;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function normalizePlaceName(value: string) {
  return value
    .toLocaleLowerCase("ar-JO")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function namesLookSimilar(left: string, right: string) {
  const a = normalizePlaceName(left);
  const b = normalizePlaceName(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aWords = new Set(a.split(" ").filter((word) => word.length > 1));
  const bWords = new Set(b.split(" ").filter((word) => word.length > 1));
  const sharedWords = [...aWords].filter((word) => bWords.has(word)).length;
  return sharedWords >= 2 || (sharedWords === 1 && aWords.size === 1 && bWords.size === 1);
}

async function findDuplicatePlace(input: z.infer<typeof placeInput>) {
  const existingPlaces = await listAllPlaces();
  return existingPlaces
    .filter((place) => place.status === "approved" || place.status === "pending")
    .map((place) => ({ place, distance: distanceMeters(input.latitude, input.longitude, place.latitude, place.longitude) }))
    .sort((a, b) => a.distance - b.distance)
    .find(({ place, distance }) => {
      const currentName = effectivePlaceName(place.displayName, place.name);
      // A very close pin is almost certainly the same physical place, even if
      // two contributors used different spellings for its name.
      if (distance <= 35) return true;
      // At a wider radius require the same type and a similar name to avoid
      // merging two genuinely different mosques in dense neighborhoods.
      return distance <= 120 && place.type === input.type && namesLookSimilar(currentName, input.name);
    });
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      const authHeader = ctx.req.headers.authorization || ctx.req.headers.Authorization;
      const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : currentSessionCookie(ctx.req);
      if (token) await revokeSessionToken(token);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(getSessionCookieName(ctx.req), { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  favorites: router({
    list: protectedProcedure.query(({ ctx }) => getFavoritePlaceKeys(ctx.user.id)),
    merge: protectedProcedure
      .input(z.object({ keys: z.array(z.string().max(64)).max(5000) }))
      .mutation(async ({ ctx, input }) => {
        const normalizedKeys = input.keys.map(normalizeFavoritePlaceKey);
        if (normalizedKeys.includes(null)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "قائمة المفضلات تحتوي على مفتاح غير صالح." });
        }
        return mergeFavoritePlaceKeys(ctx.user.id, normalizedKeys.filter((key): key is string => key !== null));
      }),
    set: protectedProcedure
      .input(z.object({ key: z.string().max(64), enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const key = normalizeFavoritePlaceKey(input.key);
        if (!key || key !== input.key) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح المكان غير صالح." });
        }
        const keys = await setFavoritePlaceKey(ctx.user.id, key, input.enabled);
        if (!keys) throw new TRPCError({ code: "NOT_FOUND", message: "المكان غير موجود أو غير متاح للعامة." });
        return keys;
      }),
  }),
  places: router({
    list: publicProcedure
      .input(placeListInput.optional())
      .query(async ({ input }) => {
        const rows = await listPublicPlaces();
        const normalizedInput = input ?? { limit: 20, offset: 0 };
        const filtered = filterPublicPlaces(rows, normalizedInput);
        const offset = input?.offset ?? 0;
        const limit = input?.limit ?? 20;
        return filtered.slice(offset, offset + limit);
      }),
    mapPoints: publicProcedure.query(() => listPublicMapPoints()),
    nearest: publicProcedure.input(nearestInput).mutation(async ({ input }) => {
      const rows = filterPublicPlaces(await listPublicPlaces(), input);
      return rows
        .map((place) => ({ place, distance: distanceMeters(input.latitude, input.longitude, place.latitude, place.longitude) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(input.offset, input.offset + input.limit)
        .map(({ place }) => place);
    }),
    byId: publicProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getPlaceById(input.id)),
    submit: protectedProcedure.input(placeInput).mutation(async ({ ctx, input }) => {
      const duplicate = await findDuplicatePlace(input);
      if (duplicate) {
        const statusText = duplicate.place.status === "pending" ? "قيد المراجعة" : "مضاف بالفعل";
        throw new TRPCError({
          code: "CONFLICT",
          message: `هذا المكان ${statusText}: «${effectivePlaceName(duplicate.place.displayName, duplicate.place.name)}»، ويبعد حوالي ${Math.max(1, Math.round(duplicate.distance))} متر. لم يتم إنشاء نسخة مكررة.`,
        });
      }
      return createPlace({
        ...input,
        hours: "غير محددة",
        hoursMode: input.type === "mosque" ? "prayer_times" : "unknown",
        weeklyHours: null,
        isTemporarilyClosed: false,
        status: "pending",
        createdBy: ctx.user.id,
      });
    }),
    favoriteIds: protectedProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(({ ctx, input }) => {
        if (input.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن قراءة مفضلات حساب آخر." });
        }
        return getFavoritePlaceIds(ctx.user.id);
      }),
    setFavorite: protectedProcedure
      .input(z.object({ placeId: z.number().int().positive(), enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        if (input.enabled && !(await getPlaceById(input.placeId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "المكان غير موجود أو غير معتمد." });
        }
        return setFavorite(ctx.user.id, input.placeId, input.enabled);
      }),
    review: protectedProcedure
      .input(z.object({ placeId: z.number().int().positive(), rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }))
      .mutation(async ({ ctx, input }) => {
        if (!(await getPlaceById(input.placeId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "لا يمكن تقييم مكان غير موجود أو غير معتمد." });
        }
        return addReview({ ...input, userId: ctx.user.id });
      }),
    suggestName: protectedProcedure
      .input(z.discriminatedUnion("source", [
        z.object({ source: z.literal("community"), placeId: z.number().int().positive(), suggestedName: z.string().trim().min(2).max(255) }).strict(),
        z.object({ source: z.literal("official"), placeId: z.number().int().positive(), suggestedName: z.string().trim().min(2).max(255) }).strict(),
        z.object({ source: z.literal("osm"), osmKey: z.string().regex(/^(?:node|way|relation)\/\d{1,20}$/), suggestedName: z.string().trim().min(2).max(255) }).strict(),
      ]))
      .mutation(async ({ ctx, input }) => {
        let target: PlaceNameSuggestionTarget | null = null;
        if (input.source === "community" || input.source === "official") {
          target = await getDatabaseNameSuggestionTarget(input.source, input.placeId);
        } else {
          const feature = osmNameSuggestionFeatures.find((item) => `${item.osmType}/${item.osmId}` === input.osmKey);
          if (!feature || (feature.kind !== "mosque" && feature.kind !== "musalla")) {
            throw new TRPCError({ code: "NOT_FOUND", message: "المكان غير موجود في مصدر الخريطة الحالي." });
          }
          const [osmOverride, officialOverride] = await Promise.all([
            getOsmNameOverride(input.osmKey),
            feature.officialMatch ? getOfficialDisplayNameOverride(feature.officialMatch.sourceKey) : Promise.resolve(null),
          ]);
          const matchedOfficialName = feature.officialMatch
            ? officialOverride?.trim() || feature.officialMatch.officialName
            : null;
          target = {
            source: "osm" as const,
            sourceKey: input.osmKey,
            currentName: osmOverride?.trim() || matchedOfficialName || feature.osmName?.trim() || (feature.kind === "mosque" ? "مسجد" : "مصلى"),
            targetKind: feature.kind as "mosque" | "musalla",
            targetArea: null,
            targetLatitude: feature.latitude,
            targetLongitude: feature.longitude,
            targetUrl: feature.osmUrl,
          };
        }

        if (!target) {
          throw new TRPCError({ code: "NOT_FOUND", message: "المكان غير موجود أو لم يعد معتمدًا على الخريطة." });
        }
        if (isUnchangedPlaceName(target.currentName, input.suggestedName)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "الاسم المقترح مطابق للاسم الحالي. أدخل تصحيحًا مختلفًا." });
        }
        const created = await createPlaceNameSuggestion({
          userId: ctx.user.id,
          target,
          suggestedName: input.suggestedName,
        });
        if (!created) {
          throw new TRPCError({ code: "CONFLICT", message: "لديك اقتراح قيد المراجعة لهذا المكان بالفعل." });
        }
        return { success: true, status: "pending" as const };
      }),
  }),
  officialMosques: router({
    list: publicProcedure
      .input(
        z.object({
          search: z.string().max(100).optional(),
          limit: z.number().int().min(1).max(100).default(25),
          offset: z.number().int().min(0).max(10000).default(0),
        }).optional(),
      )
      .query(({ input }) => listOfficialMosques(input ?? { limit: 25, offset: 0 })),
    mapPoints: publicProcedure.query(() => listOfficialMosqueMapPoints()),
    displayOverrides: publicProcedure.query(() => listOfficialMosquePublicOverrides()),
  }),
  osmOverrides: router({
    list: publicProcedure.query(() => listOsmPlaceOverrides()),
  }),
  admin: router({
    pendingPlaces: adminProcedure.query(() => listPlaces("pending")),
    allPlaces: adminProcedure.query(() => listAllPlaces()),
    approveAllPendingPlaces: adminProcedure.mutation(({ ctx }) => approveAllPendingPlaces(ctx.user.id)),
    reviews: adminProcedure.query(() => listReviews()),
    setPlaceStatus: adminProcedure.input(z.object({ placeId: z.number().int().positive(), status: z.enum(["approved", "rejected"]) })).mutation(({ ctx, input }) =>
      updatePlaceStatus(input.placeId, input.status, ctx.user.id),
    ),
    deletePlace: adminProcedure.input(z.object({ placeId: z.number().int().positive() })).mutation(({ ctx, input }) => deletePlace(input.placeId, ctx.user.id)),
    restorePlace: adminProcedure.input(z.object({ placeId: z.number().int().positive() })).mutation(({ ctx, input }) => restorePlace(input.placeId, ctx.user.id)),
    setReviewStatus: adminProcedure.input(z.object({ reviewId: z.number().int().positive(), status: z.enum(["visible", "hidden", "reported"]) })).mutation(({ input }) => updateReviewStatus(input.reviewId, input.status)),
  }),
});

export type AppRouter = typeof appRouter;
