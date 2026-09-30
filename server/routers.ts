import { z } from "zod";
import { getSessionCookieName, getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  addReview,
  createPlace,
  getFavoritePlaceIds,
  getPlaceById,
  listPlaces,
  listPublicPlaces,
  setFavorite,
  updatePlaceStatus,
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
  hasParking: z.boolean().default(false),
  photos: z.string().optional(),
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(getSessionCookieName(ctx.req), { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  places: router({
    list: publicProcedure
      .input(z.object({ search: z.string().optional(), openNow: z.boolean().optional(), hasAblution: z.boolean().optional(), hasParking: z.boolean().optional(), limit: z.number().int().min(1).max(20).default(20), offset: z.number().int().min(0).default(0) }).optional())
      .query(async ({ input }) => {
        const rows = await listPublicPlaces();
        const search = input?.search?.trim().toLowerCase();
        const filtered = rows.filter((place) => {
          if (search && !`${place.name} ${place.nameEn ?? ""} ${place.address ?? ""}`.toLowerCase().includes(search)) return false;
          if (input?.openNow && place.status !== "approved") return false;
          if (input?.hasAblution && !place.hasAblution) return false;
          if (input?.hasParking && !place.hasParking) return false;
          return true;
        });
        const offset = input?.offset ?? 0;
        const limit = input?.limit ?? 20;
        return filtered.slice(offset, offset + limit);
      }),
    byId: publicProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getPlaceById(input.id)),
    submit: protectedProcedure.input(placeInput).mutation(({ ctx, input }) =>
      createPlace({ ...input, status: "pending", createdBy: ctx.user.id }),
    ),
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
    setPlaceStatus: adminProcedure.input(z.object({ placeId: z.number().int().positive(), status: z.enum(["approved", "rejected"]) })).mutation(({ ctx, input }) =>
      updatePlaceStatus(input.placeId, input.status, ctx.user.id),
    ),
  }),
});

export type AppRouter = typeof appRouter;
