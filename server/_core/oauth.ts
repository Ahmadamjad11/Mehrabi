import { ONE_YEAR_MS } from "../../shared/const.js";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import {
  consumeOAuthStateNonce,
  createOAuthStateNonce,
  getUserByOpenId,
  revokeSessionToken,
  upsertUser,
} from "../db";
import {
  getSessionCookieName,
  getSessionCookieOptions,
} from "./cookies";
import { ENV } from "./env";
import {
  createOAuthState,
  identifyOAuthPlatform,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  OAUTH_STATE_TTL_MS,
  verifyOAuthState,
} from "./oauthState";
import { sdk } from "./sdk";

function presentedSessionToken(req: Request) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  const cookieHeader = req.headers.cookie ?? "";
  const cookieName = getSessionCookieName(req);
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  return cookie?.slice(cookieName.length + 1);
}

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function clearOAuthStateCookie(req: Request, res: Response) {
  res.clearCookie(OAUTH_STATE_COOKIE, {
    ...getSessionCookieOptions(req),
    path: OAUTH_STATE_COOKIE_PATH,
  });
}

function getFrontendOrigin(req: Request) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto?.split(",")[0])?.trim() || req.protocol;
  const host = req.get("host") || "localhost:8081";
  const configured = process.env.EXPO_WEB_PREVIEW_URL || process.env.EXPO_PACKAGER_PROXY_URL;
  if (/^3000-/.test(host) && configured) return configured.replace(/\/$/, "");
  // Preview's API and web origins use paired 3000/8328 hostnames. Production uses
  // one public origin for both static web and API, so OAuth must not redirect to localhost.
  return `${protocol}://${host.replace(/^3000-/, "8328-")}`;
}

async function syncUser(userInfo: {
  openId?: string | null;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  platform?: string | null;
}) {
  if (!userInfo.openId) {
    throw new Error("openId missing from user info");
  }

  const lastSignedIn = new Date();
  await upsertUser({
    openId: userInfo.openId,
    name: userInfo.name || null,
    email: userInfo.email ?? null,
    loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
    lastSignedIn,
  });
  const saved = await getUserByOpenId(userInfo.openId);
  return (
    saved ?? {
      openId: userInfo.openId,
      name: userInfo.name,
      email: userInfo.email,
      loginMethod: userInfo.loginMethod ?? null,
      lastSignedIn,
    }
  );
}

function buildUserResponse(
  user:
    | Awaited<ReturnType<typeof getUserByOpenId>>
    | {
        openId: string;
        name?: string | null;
        email?: string | null;
        loginMethod?: string | null;
        lastSignedIn?: Date | null;
      },
) {
  return {
    id: (user as any)?.id ?? null,
    openId: user?.openId ?? null,
    name: user?.name ?? null,
    email: user?.email ?? null,
    loginMethod: user?.loginMethod ?? null,
    role: (user as any)?.role ?? "user",
    lastSignedIn: (user?.lastSignedIn ?? new Date()).toISOString(),
  };
}

export function registerOAuthRoutes(app: Express) {
  app.post("/api/oauth/start", async (req: Request, res: Response) => {
    const redirectUri = typeof req.body?.redirectUri === "string" ? req.body.redirectUri : "";
    if (!redirectUri || redirectUri.length > 1024) {
      res.status(400).json({ error: "A valid OAuth callback URI is required" });
      return;
    }

    let platform: "web" | "native";
    try {
      platform = identifyOAuthPlatform(req, redirectUri);
    } catch {
      res.status(400).json({ error: "OAuth callback URI is not approved" });
      return;
    }

    const appId = ENV.appId;
    const portalValue = process.env.MANUS_OAUTH_PORTAL_URL ?? process.env.VITE_OAUTH_PORTAL_URL ?? "";
    if (!appId || !portalValue || !ENV.cookieSecret) {
      res.status(503).json({ error: "Manus OAuth is not configured" });
      return;
    }

    try {
      const portal = new URL(portalValue);
      if (portal.protocol !== "https:" && !(portal.protocol === "http:" && ["localhost", "127.0.0.1"].includes(portal.hostname))) {
        throw new Error("OAuth portal must use HTTPS");
      }

      const { state, nonce, expiresAt } = createOAuthState(redirectUri, platform, ENV.cookieSecret);
      await createOAuthStateNonce(nonce, platform, expiresAt);

      if (platform === "web") {
        res.cookie(OAUTH_STATE_COOKIE, nonce, {
          ...getSessionCookieOptions(req),
          path: OAUTH_STATE_COOKIE_PATH,
          maxAge: OAUTH_STATE_TTL_MS,
        });
      }

      const loginUrl = new URL(`${portalValue.replace(/\/$/, "")}/app-auth`);
      loginUrl.searchParams.set("appId", appId);
      loginUrl.searchParams.set("redirectUri", redirectUri);
      loginUrl.searchParams.set("state", state);
      loginUrl.searchParams.set("responseType", "code");
      res.json({ loginUrl: loginUrl.toString(), state });
    } catch {
      console.error("[OAuth] Start failed");
      res.status(503).json({ error: "Unable to start OAuth" });
    }
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || code.length > 4096 || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    let verifiedState: ReturnType<typeof verifyOAuthState>;
    try {
      verifiedState = verifyOAuthState(state, "web", req, ENV.cookieSecret);
    } catch {
      res.status(400).json({ error: "Invalid or expired OAuth state" });
      return;
    }

    const cookieNonce = parseCookieHeader(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!cookieNonce || cookieNonce !== verifiedState.nonce) {
      res.status(400).json({ error: "OAuth state does not match the initiating browser" });
      return;
    }
    if (!(await consumeOAuthStateNonce(verifiedState.nonce, "web"))) {
      clearOAuthStateCookie(req, res);
      res.status(400).json({ error: "OAuth state has already been used or expired" });
      return;
    }
    clearOAuthStateCookie(req, res);

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      await syncUser(userInfo);
      const sessionToken = await sdk.createSessionToken(userInfo.openId!, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(getSessionCookieName(req), sessionToken, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      // Redirect to the paired Expo web origin. The session cookie remains host-only on
      // the API origin and is sent back by credentialed API requests.
      const frontendUrl = getFrontendOrigin(req);
      res.redirect(302, frontendUrl);
    } catch {
      console.error("[OAuth] Callback failed");
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });

  app.post("/api/oauth/mobile", async (req: Request, res: Response) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const state = typeof req.body?.state === "string" ? req.body.state : "";

    if (!code || code.length > 4096 || !state || state.length > 4096) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const verifiedState = verifyOAuthState(state, "native", req, ENV.cookieSecret);
      if (!(await consumeOAuthStateNonce(verifiedState.nonce, "native"))) {
        res.status(400).json({ error: "OAuth state has already been used or expired" });
        return;
      }

      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      const user = await syncUser(userInfo);

      const sessionToken = await sdk.createSessionToken(userInfo.openId!, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      res.json({
        app_session_id: sessionToken,
        user: buildUserResponse(user),
      });
    } catch {
      console.error("[OAuth] Mobile exchange failed");
      res.status(500).json({ error: "OAuth mobile exchange failed" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    void (async () => {
      const token = presentedSessionToken(req);
      if (token) await revokeSessionToken(token);
      const cookieOptions = getSessionCookieOptions(req);
      res.clearCookie(getSessionCookieName(req), {
        ...cookieOptions,
        maxAge: -1,
      });
      res.json({ success: true });
    })().catch(() => res.status(503).json({ error: "Unable to revoke session" }));
  });

  // Get current authenticated user - works with both cookie (web) and Bearer token (mobile)
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    try {
      const user = await sdk.authenticateRequest(req);
      res.json({ user: buildUserResponse(user) });
    } catch {
      console.error("[Auth] /api/auth/me failed");
      res.status(401).json({ error: "Not authenticated", user: null });
    }
  });

  // Establish session cookie from Bearer token
  // Used by iframe preview: frontend receives token via postMessage, then calls this endpoint
  // to get a proper Set-Cookie response from the backend (3000-xxx domain)
  app.post("/api/auth/session", async (req: Request, res: Response) => {
    try {
      // Authenticate using Bearer token from Authorization header
      const user = await sdk.authenticateRequest(req);

      // Get the token from the Authorization header to set as cookie
      const authHeader = req.headers.authorization || req.headers.Authorization;
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        res.status(400).json({ error: "Bearer token required" });
        return;
      }
      const token = authHeader.slice("Bearer ".length).trim();

      // Set cookie for this domain (3000-xxx)
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(getSessionCookieName(req), token, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      res.json({ success: true, user: buildUserResponse(user) });
    } catch {
      console.error("[Auth] /api/auth/session failed");
      res.status(401).json({ error: "Invalid token" });
    }
  });
}
