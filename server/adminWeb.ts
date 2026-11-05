import path from "node:path";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import osmMosqueMapData from "../data/osm_mosque_map_points.json";
import {
  approveAllAdminCommunityPlaces,
  decideAdminPlaceNameSuggestion,
  getAdminPlaceNameSuggestionById,
  getAdminPlaceById,
  listAdminOfficialMosques,
  listAdminModerationPlaces,
  listAdminPlaceNameSuggestions,
  listAdminPlaces,
  listAdminReviews,
  listOfficialMosquePublicOverrides,
  listOsmPlaceOverrides,
  restoreAdminCommunityPlace,
  revokeSessionToken,
  softDeleteAdminCommunityPlace,
  updateAdminCommunityPlaceStatus,
  updateReviewStatus,
  updateCommunityPlaceAdminRecord,
  updateOfficialMosqueAdminRecord,
  upsertOsmPlaceOverride,
} from "./db";
import {
  OPENING_HOURS_MODES,
  validateOpeningHoursConfiguration,
  weeklyOpeningHoursSchema,
  type OpeningHoursMode,
  type WeeklyOpeningHours,
} from "../shared/openingHours";
import { currentSessionCookie, getSessionCookieName, getSessionCookieOptions } from "./_core/cookies";
import { sdk, type AuthenticatedUser } from "./_core/sdk";

type OsmSourceFeature = (typeof osmMosqueMapData.features)[number];

const osmFeatures = osmMosqueMapData.features as OsmSourceFeature[];
const adminCatalogQuerySchema = z.object({
  source: z.enum(["official", "osm", "community", "moderation", "reviews", "name-suggestions"]),
  search: z.string().trim().max(100).optional(),
  status: z.enum(["all", "pending", "approved", "rejected", "deleted", "visible", "reported", "hidden"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const displayNameSchema = z.string().trim().max(255);
const weeklyScheduleInputSchema = weeklyOpeningHoursSchema.nullable();
const catalogEntryInputSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("official"),
    id: z.number().int().positive(),
    displayName: displayNameSchema,
    isTemporarilyClosed: z.boolean(),
  }).strict(),
  z.object({
    source: z.literal("osm"),
    osmKey: z.string().regex(/^(?:node|way|relation)\/\d{1,20}$/),
    displayName: displayNameSchema,
    hoursMode: z.enum(OPENING_HOURS_MODES),
    weeklyHours: weeklyScheduleInputSchema,
    isTemporarilyClosed: z.boolean(),
  }).strict(),
  z.object({
    source: z.literal("community"),
    id: z.number().int().positive(),
    name: displayNameSchema,
    hoursMode: z.enum(OPENING_HOURS_MODES),
    weeklyHours: weeklyScheduleInputSchema,
    isTemporarilyClosed: z.boolean(),
  }).strict(),
]);

const requireAdmin: RequestHandler = (req, res, next) => {
  void sdk.authenticateRequest(req).then((user) => {
    if (user.role !== "admin" || user.isCron) {
      res.status(403).json({ error: "تحتاج إلى صلاحية مدير لفتح لوحة الإدارة." });
      return;
    }
    res.locals.adminUser = user;
    next();
  }).catch(() => {
    res.status(401).json({ error: "انتهت جلسة الإدارة. سجّل الدخول مرة أخرى." });
  });
};

function adminUser(res: Response): AuthenticatedUser {
  return res.locals.adminUser as AuthenticatedUser;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    void handler(req, res).catch((error) => sendError(res, error));
  };
}

function sendError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.issues[0]?.message ?? "البيانات المدخلة غير صالحة." });
    return;
  }
  console.error("[AdminWeb] Request failed", error instanceof Error ? error.message : "unknown error");
  res.status(500).json({ error: "تعذر إكمال العملية الآن. حاول مرة أخرى." });
}

function publicOsmName(feature: OsmSourceFeature) {
  return feature.officialMatch?.officialName
    || feature.osmName?.trim()
    || (feature.kind === "mosque" ? "مسجد" : "مصلى");
}

function catalogOsmRows(overrides: Awaited<ReturnType<typeof listOsmPlaceOverrides>>, officialOverrides: Awaited<ReturnType<typeof listOfficialMosquePublicOverrides>>) {
  const overrideByKey = new Map(overrides.map((item) => [item.osmKey, item]));
  const officialNameByKey = new Map(officialOverrides.map((item) => [item.sourceKey, item.displayName]));
  return osmFeatures.map((feature) => {
    const osmKey = `${feature.osmType}/${feature.osmId}`;
    const override = overrideByKey.get(osmKey);
    const officialName = feature.officialMatch
      ? officialNameByKey.get(feature.officialMatch.sourceKey)?.trim() || feature.officialMatch.officialName
      : null;
    return {
      source: "osm" as const,
      osmKey,
      id: osmKey,
      kind: feature.kind,
      sourceName: feature.osmName?.trim() || "",
      effectiveName: override?.displayName?.trim() || officialName || publicOsmName(feature),
      displayName: override?.displayName ?? "",
      matchedOfficialName: officialName,
      area: "",
      latitude: feature.latitude,
      longitude: feature.longitude,
      osmUrl: feature.osmUrl,
      hoursMode: override?.hoursMode ?? (feature.kind === "mosque" ? "prayer_times" : "unknown"),
      weeklyHours: override?.weeklyHours ?? null,
      isTemporarilyClosed: override?.isTemporarilyClosed ?? false,
      updatedAt: override?.updatedAt?.toISOString() ?? null,
    };
  });
}

export function registerAdminWebRoutes(app: Express) {
  const router = express.Router();

  router.get("/session", requireAdmin, (_req, res) => {
    const user = adminUser(res);
    res.setHeader("Cache-Control", "no-store");
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });

  router.get("/catalog", requireAdmin, asyncRoute(async (req, res) => {
    const query = adminCatalogQuerySchema.parse(req.query);
    res.setHeader("Cache-Control", "no-store");
    if (query.source === "moderation") {
      const result = await listAdminModerationPlaces({
        status: query.status === "all" || query.status === "approved" || query.status === "rejected" || query.status === "deleted" ? query.status : "pending",
        search: query.search,
        limit: query.limit,
        offset: query.offset,
      });
      res.json({ total: result.total, items: result.items.map((item) => ({
        source: "moderation", id: item.id, sourceName: item.name, effectiveName: item.displayName?.trim() || item.name,
        kind: item.type, area: item.address ?? "", latitude: item.latitude, longitude: item.longitude,
        status: item.status, createdAt: item.createdAt.toISOString(),
      })) });
      return;
    }
    if (query.source === "reviews") {
      const result = await listAdminReviews({
        status: query.status === "all" || query.status === "visible" || query.status === "reported" || query.status === "hidden" ? query.status : "reported",
        search: query.search,
        limit: query.limit,
        offset: query.offset,
      });
      res.json({ total: result.total, items: result.items.map((item) => ({
        source: "reviews", id: item.id, placeId: item.placeId, rating: item.rating,
        comment: item.comment, status: item.status, createdAt: item.createdAt.toISOString(),
      })) });
      return;
    }
    if (query.source === "name-suggestions") {
      const result = await listAdminPlaceNameSuggestions({
        status: query.status === "all" || query.status === "approved" || query.status === "rejected" ? query.status : "pending",
        search: query.search,
        limit: query.limit,
        offset: query.offset,
      });
      res.json({
        ...result,
        items: result.items.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          reviewedAt: item.reviewedAt?.toISOString() ?? null,
        })),
      });
      return;
    }
    if (query.source === "official") {
      const result = await listAdminOfficialMosques(query);
      res.json({
        ...result,
        items: result.items.map((item) => ({
          source: "official",
          id: item.id,
          sourceKey: item.sourceKey,
          sourceName: item.sourceName,
          effectiveName: item.displayName?.trim() || item.sourceName,
          displayName: item.displayName ?? "",
          kind: "mosque",
          area: [item.governorate, item.directorate, item.locality].filter(Boolean).join("، "),
          latitude: item.latitude,
          longitude: item.longitude,
          displayable: item.displayable,
          hoursMode: "prayer_times",
          weeklyHours: null,
          isTemporarilyClosed: item.isTemporarilyClosed,
          updatedAt: item.updatedAt.toISOString(),
        })),
      });
      return;
    }
    if (query.source === "community") {
      const result = await listAdminPlaces(query);
      res.json({
        ...result,
        items: result.items.map((item) => ({
          source: "community",
          id: item.id,
          sourceName: item.name,
          effectiveName: item.displayName?.trim() || item.name,
          displayName: item.displayName ?? "",
          kind: item.type === "mosque" ? "mosque" : "musalla",
          area: item.address ?? "",
          latitude: item.latitude,
          longitude: item.longitude,
          status: item.status,
          hoursMode: item.hoursMode,
          weeklyHours: item.weeklyHours,
          isTemporarilyClosed: item.isTemporarilyClosed,
          updatedAt: item.updatedAt.toISOString(),
        })),
      });
      return;
    }

    const [overrides, officialOverrides] = await Promise.all([
      listOsmPlaceOverrides(),
      listOfficialMosquePublicOverrides(),
    ]);
    const term = query.search?.toLocaleLowerCase();
    const allRows = catalogOsmRows(overrides, officialOverrides).filter((item) => !term
      || [item.effectiveName, item.sourceName, item.matchedOfficialName, item.osmKey]
        .some((value) => value?.toLocaleLowerCase().includes(term)));
    res.json({ total: allRows.length, items: allRows.slice(query.offset, query.offset + query.limit) });
  }));

  router.post("/catalog/save", requireAdmin, asyncRoute(async (req, res) => {
    const input = catalogEntryInputSchema.parse(req.body);
    const updatedBy = adminUser(res).id;
    const displayName = "displayName" in input && input.displayName.trim() ? input.displayName.trim() : null;

    if (input.source === "official") {
      const saved = await updateOfficialMosqueAdminRecord({
        id: input.id,
        displayName,
        isTemporarilyClosed: input.isTemporarilyClosed,
        updatedBy,
      });
      if (!saved) {
        res.status(404).json({ error: "سجل المسجد الرسمي غير موجود." });
        return;
      }
      res.json({ success: true });
      return;
    }

    if (input.source === "osm") {
      const feature = osmFeatures.find((item) => `${item.osmType}/${item.osmId}` === input.osmKey);
      if (!feature) {
        res.status(404).json({ error: "عنصر OSM غير موجود في مصدر الخريطة الحالي." });
        return;
      }
      if (feature.kind !== "mosque" && feature.kind !== "musalla") {
        res.status(400).json({ error: "نوع عنصر OSM غير صالح لإعداد ساعات العمل." });
        return;
      }
      const weeklyHours = input.weeklyHours as WeeklyOpeningHours | null;
      const hoursError = validateOpeningHoursConfiguration({
        kind: feature.kind,
        mode: input.hoursMode as OpeningHoursMode,
        weeklyHours,
      });
      if (hoursError) {
        res.status(400).json({ error: hoursError });
        return;
      }
      await upsertOsmPlaceOverride({
        osmKey: input.osmKey,
        displayName,
        hoursMode: input.hoursMode,
        weeklyHours,
        isTemporarilyClosed: input.isTemporarilyClosed,
        updatedBy,
      });
      res.json({ success: true });
      return;
    }

    const place = await getAdminPlaceById(input.id);
    if (!place || place.sourceKey) {
      res.status(404).json({ error: "المكان المجتمعي غير موجود." });
      return;
    }
    const kind = place.type === "mosque" ? "mosque" : "musalla";
    const weeklyHours = input.weeklyHours as WeeklyOpeningHours | null;
    const hoursError = validateOpeningHoursConfiguration({ kind, mode: input.hoursMode, weeklyHours });
    if (hoursError) {
      res.status(400).json({ error: hoursError });
      return;
    }
    const saved = await updateCommunityPlaceAdminRecord({
      id: input.id,
      displayName: input.name.trim() || null,
      hoursMode: input.hoursMode,
      weeklyHours,
      isTemporarilyClosed: input.isTemporarilyClosed,
      updatedBy,
    });
    if (!saved) {
      res.status(404).json({ error: "المكان المجتمعي غير موجود." });
      return;
    }
    res.json({ success: true });
  }));

  router.post("/moderation/place-status", requireAdmin, asyncRoute(async (req, res) => {
    const input = z.object({ id: z.number().int().positive(), status: z.enum(["approved", "rejected"]) }).strict().parse(req.body);
    const saved = await updateAdminCommunityPlaceStatus({ id: input.id, status: input.status, reviewedBy: adminUser(res).id });
    if (!saved) {
      res.status(404).json({ error: "المكان غير موجود أو لم تعد هذه الحالة متاحة." });
      return;
    }
    res.json({ success: true });
  }));

  router.post("/moderation/place-delete", requireAdmin, asyncRoute(async (req, res) => {
    const input = z.object({ id: z.number().int().positive() }).strict().parse(req.body);
    const saved = await softDeleteAdminCommunityPlace(input.id, adminUser(res).id);
    if (!saved) {
      res.status(404).json({ error: "المكان غير موجود أو لا يمكن نقله إلى المحذوفات." });
      return;
    }
    res.json({ success: true });
  }));

  router.post("/moderation/place-restore", requireAdmin, asyncRoute(async (req, res) => {
    const input = z.object({ id: z.number().int().positive() }).strict().parse(req.body);
    const saved = await restoreAdminCommunityPlace(input.id, adminUser(res).id);
    if (!saved) {
      res.status(404).json({ error: "المكان غير موجود في المحذوفات." });
      return;
    }
    res.json({ success: true });
  }));

  router.post("/moderation/approve-all", requireAdmin, asyncRoute(async (_req, res) => {
    const count = await approveAllAdminCommunityPlaces(adminUser(res).id);
    res.json({ success: true, count });
  }));

  router.post("/moderation/review-status", requireAdmin, asyncRoute(async (req, res) => {
    const input = z.object({ id: z.number().int().positive(), status: z.enum(["visible", "hidden", "reported"]) }).strict().parse(req.body);
    await updateReviewStatus(input.id, input.status);
    res.json({ success: true });
  }));

  router.post("/name-suggestions/decision", requireAdmin, asyncRoute(async (req, res) => {
    const input = z.object({ id: z.number().int().positive(), status: z.enum(["approved", "rejected"]) }).strict().parse(req.body);
    const suggestion = await getAdminPlaceNameSuggestionById(input.id);
    if (!suggestion || suggestion.status !== "pending") {
      res.status(409).json({ error: "لم يعد اقتراح الاسم معلّقًا للمراجعة." });
      return;
    }
    let osmSource: {
      kind: "mosque" | "musalla";
      osmName?: string;
      officialSourceKey?: string;
      officialName?: string;
    } | undefined;
    if (input.status === "approved" && suggestion.source === "osm") {
      const feature = osmFeatures.find((item) => `${item.osmType}/${item.osmId}` === suggestion.sourceKey);
      if (!feature || feature.kind !== suggestion.targetKind) {
        res.status(409).json({ error: "لم يعد معلم OSM المقترح موجودًا في مصدر الخريطة الحالي." });
        return;
      }
      osmSource = {
        kind: feature.kind,
        osmName: feature.osmName?.trim() || undefined,
        officialSourceKey: feature.officialMatch?.sourceKey,
        officialName: feature.officialMatch?.officialName,
      };
    }
    const result = await decideAdminPlaceNameSuggestion({
      id: input.id,
      status: input.status,
      reviewedBy: adminUser(res).id,
      ...(osmSource ? { osmSource } : {}),
    });
    if (result === "not_pending") {
      res.status(409).json({ error: "تمت مراجعة هذا الاقتراح من قبل مدير آخر." });
      return;
    }
    if (result === "target_missing") {
      res.status(409).json({ error: "تعذر تطبيق الاقتراح لأن المكان لم يعد متاحًا أو معتمدًا." });
      return;
    }
    if (result === "target_changed") {
      res.status(409).json({ error: "تغير الاسم المعروض منذ إرسال الاقتراح. راجع الاسم الحالي قبل اتخاذ القرار." });
      return;
    }
    res.json({ success: true, status: input.status });
  }));

  router.post("/logout", requireAdmin, asyncRoute(async (req, res) => {
    const token = currentSessionCookie(req);
    if (token) await revokeSessionToken(token);
    res.clearCookie(getSessionCookieName(req), { ...getSessionCookieOptions(req), maxAge: -1 });
    res.json({ success: true });
  }));

  app.use("/api/admin", router);

  const adminUiDirectory = path.join(process.cwd(), "server", "admin-ui");
  app.use("/admin-assets", express.static(path.join(adminUiDirectory, "assets"), {
    etag: true,
    maxAge: 0,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  }));
  const sendAdminPage: RequestHandler = (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.sendFile(path.join(adminUiDirectory, "index.html"));
  };
  app.get(["/admin", "/admin.html"], sendAdminPage);
}
