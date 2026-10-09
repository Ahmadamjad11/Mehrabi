import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { currentSessionCookie, getSessionCookieName, getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  addReview,
  createPlace,
  deletePlace,
  getFavoritePlaceIds,
  getPlaceById,
  listAllPlaces,
  listPlaces,
  listPublicPlaces,
  listReviews,
  restorePlace,
  setFavorite,
  updatePlaceStatus,
  updateReviewStatus,
  revokeSessionToken,
} from "./db";

const placeInput = z.object({
  name: z.string().min(2).max(255),
  nameEn: z.string().max(255).optional(),
  type: z.enum(["mosque", "musalla", "station", "mall"]),
  description: z.string().max(2000).optional(),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  hours: z.string().max(255).optional(),
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
    if (input.openNow && !place.hours?.includes("مفتوح") && !place.hours?.toLowerCase().includes("open")) return false;
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
      // A very close pin is almost certainly the same physical place, even if
      // two contributors used different spellings for its name.
      if (distance <= 35) return true;
      // At a wider radius require the same type and a similar name to avoid
      // merging two genuinely different mosques in dense neighborhoods.
      return distance <= 120 && place.type === input.type && namesLookSimilar(place.name, input.name);
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
          message: `هذا المكان ${statusText}: «${duplicate.place.name}»، ويبعد حوالي ${Math.max(1, Math.round(duplicate.distance))} متر. لم يتم إنشاء نسخة مكررة.`,
        });
      }
      return createPlace({ ...input, status: "pending", createdBy: ctx.user.id });
    }),
    favoriteIds: protectedProcedure.query(({ ctx }) => getFavoritePlaceIds(ctx.user.id)),
    setFavorite: protectedProcedure
      .input(z.object({ placeId: z.number().int().positive(), enabled: z.boolean() }))
      .mutation(({ ctx, input }) => setFavorite(ctx.user.id, input.placeId, input.enabled)),
    review: protectedProcedure
      .input(z.object({ placeId: z.number().int().positive(), rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }))
      .mutation(({ ctx, input }) => addReview({ ...input, userId: ctx.user.id })),
  }),
  admin: router({
    pendingPlaces: adminProcedure.query(() => listPlaces("pending")),
    allPlaces: adminProcedure.query(() => listAllPlaces()),
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
