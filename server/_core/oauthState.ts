import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { APP_NATIVE_OAUTH_SCHEME } from "../../shared/oauth.js";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_STATE_COOKIE = "mehrabi_oauth_state";
export const OAUTH_STATE_COOKIE_PATH = "/api/oauth/callback";

export type OAuthPlatform = "web" | "native";

type OAuthStatePayload = {
  redirectUri: string;
  nonce: string;
  platform: OAuthPlatform;
  issuedAt: number;
  signature: string;
};

type RequestOrigin = Pick<Request, "headers" | "protocol" | "get">;

function forwardedValue(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value?.split(",")[0])?.trim();
}

export function getRequestOrigin(req: RequestOrigin): string {
  const protocol = forwardedValue(req.headers["x-forwarded-proto"]) || req.protocol;
  const host = forwardedValue(req.headers["x-forwarded-host"]) || req.get("host");
  if ((protocol !== "http" && protocol !== "https") || !host || /[\s/@?#]/.test(host)) {
    throw new Error("Invalid OAuth request origin");
  }
  const origin = new URL(`${protocol}://${host}`);
  if (origin.origin !== `${protocol}://${host}`) throw new Error("Invalid OAuth request origin");
  return origin.origin;
}

export function webOAuthCallbackUri(req: RequestOrigin): string {
  return `${getRequestOrigin(req)}${OAUTH_STATE_COOKIE_PATH}`;
}

function isNativeRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return url.protocol === `${APP_NATIVE_OAUTH_SCHEME}:` &&
      url.hostname === "oauth" &&
      url.pathname === "/callback" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}

export function identifyOAuthPlatform(req: RequestOrigin, redirectUri: string): OAuthPlatform {
  if (isNativeRedirectUri(redirectUri)) return "native";
  if (redirectUri === webOAuthCallbackUri(req)) return "web";
  throw new Error("OAuth redirect URI is not an approved application callback");
}

function signatureFor(payload: Omit<OAuthStatePayload, "signature">, secret: string): string {
  if (!secret) throw new Error("OAuth state signing key is unavailable");
  const message = [
    "mehrabi-oauth-state-v1",
    payload.redirectUri,
    payload.nonce,
    payload.platform,
    String(payload.issuedAt),
  ].join("\n");
  return createHmac("sha256", secret).update(message).digest("base64url");
}

export function createOAuthState(
  redirectUri: string,
  platform: OAuthPlatform,
  secret: string,
  now = Date.now(),
): { state: string; nonce: string; expiresAt: Date } {
  const unsigned = {
    redirectUri,
    nonce: randomBytes(32).toString("hex"),
    platform,
    issuedAt: now,
  };
  const payload: OAuthStatePayload = {
    ...unsigned,
    signature: signatureFor(unsigned, secret),
  };
  return {
    state: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    nonce: payload.nonce,
    expiresAt: new Date(now + OAUTH_STATE_TTL_MS),
  };
}

export function verifyOAuthState(
  encodedState: string,
  expectedPlatform: OAuthPlatform,
  req: RequestOrigin,
  secret: string,
  now = Date.now(),
): OAuthStatePayload {
  if (!encodedState || encodedState.length > 4096) throw new Error("Invalid OAuth state");

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedState, "base64").toString("utf8"));
  } catch {
    throw new Error("Invalid OAuth state");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid OAuth state");

  const payload = parsed as Partial<OAuthStatePayload>;
  if (
    typeof payload.redirectUri !== "string" ||
    typeof payload.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.nonce) ||
    payload.platform !== expectedPlatform ||
    typeof payload.issuedAt !== "number" ||
    !Number.isSafeInteger(payload.issuedAt) ||
    typeof payload.signature !== "string"
  ) {
    throw new Error("Invalid OAuth state");
  }
  if (payload.issuedAt > now + 30_000 || now - payload.issuedAt > OAUTH_STATE_TTL_MS) {
    throw new Error("Expired OAuth state");
  }

  const unsigned = {
    redirectUri: payload.redirectUri,
    nonce: payload.nonce,
    platform: payload.platform,
    issuedAt: payload.issuedAt,
  };
  const expectedSignature = signatureFor(unsigned, secret);
  const actualSignatureBuffer = Buffer.from(payload.signature, "base64url");
  const expectedSignatureBuffer = Buffer.from(expectedSignature, "base64url");
  if (
    actualSignatureBuffer.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(actualSignatureBuffer, expectedSignatureBuffer)
  ) {
    throw new Error("Invalid OAuth state signature");
  }

  if (expectedPlatform === "web") {
    if (payload.redirectUri !== webOAuthCallbackUri(req)) {
      throw new Error("OAuth web callback does not match the initiating origin");
    }
  } else if (!isNativeRedirectUri(payload.redirectUri)) {
    throw new Error("OAuth native callback is not approved");
  }

  return payload as OAuthStatePayload;
}
