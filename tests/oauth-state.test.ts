import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { APP_NATIVE_OAUTH_SCHEME } from "../shared/oauth";
import {
  createOAuthState,
  identifyOAuthPlatform,
  OAUTH_STATE_TTL_MS,
  verifyOAuthState,
  webOAuthCallbackUri,
} from "../server/_core/oauthState";

const SECRET = "oauth-state-test-key-not-used-outside-tests";

function request(host = "3000-sandbox.example.test", protocol = "https") {
  return {
    protocol: "http",
    headers: {
      "x-forwarded-proto": protocol,
      "x-forwarded-host": host,
    },
    get: () => host,
  } as unknown as Request;
}

describe("OAuth state", () => {
  it("binds a web callback to the initiating API origin", () => {
    const req = request();
    const redirectUri = webOAuthCallbackUri(req);
    expect(identifyOAuthPlatform(req, redirectUri)).toBe("web");

    const { state, nonce } = createOAuthState(redirectUri, "web", SECRET, 1000);
    const verified = verifyOAuthState(state, "web", req, SECRET, 1000);
    expect(verified.nonce).toBe(nonce);
    expect(verified.redirectUri).toBe(redirectUri);
  });

  it("rejects web state presented from a different origin", () => {
    const originalRequest = request("3000-first.example.test");
    const { state } = createOAuthState(webOAuthCallbackUri(originalRequest), "web", SECRET, 1000);
    expect(() => verifyOAuthState(state, "web", request("3000-second.example.test"), SECRET, 1000)).toThrow();
  });

  it("rejects tampered state and an unexpected platform", () => {
    const req = request();
    const { state } = createOAuthState(webOAuthCallbackUri(req), "web", SECRET, 1000);
    const payload = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
    payload.redirectUri = "https://attacker.example/collect";
    const tampered = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(() => verifyOAuthState(tampered, "web", req, SECRET, 1000)).toThrow();
    expect(() => verifyOAuthState(state, "native", req, SECRET, 1000)).toThrow();
  });

  it("rejects state after its ten-minute lifetime", () => {
    const req = request();
    const { state } = createOAuthState(webOAuthCallbackUri(req), "web", SECRET, 1000);
    expect(() => verifyOAuthState(state, "web", req, SECRET, 1001 + OAUTH_STATE_TTL_MS)).toThrow();
  });

  it("accepts only the fixed native deep-link callback", () => {
    const req = request();
    const approvedUri = `${APP_NATIVE_OAUTH_SCHEME}://oauth/callback`;
    expect(identifyOAuthPlatform(req, approvedUri)).toBe("native");
    expect(() => identifyOAuthPlatform(req, "https://attacker.example/callback")).toThrow();
    const { state } = createOAuthState(approvedUri, "native", SECRET, 1000);
    expect(verifyOAuthState(state, "native", req, SECRET, 1000).redirectUri).toBe(approvedUri);
  });
});
