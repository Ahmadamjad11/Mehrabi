import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicAppUrl, isSmtpConfigured } from "../server/_core/email";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public auth URL configuration", () => {
  it("prefers the current managed API origin over the frontend URL", () => {
    vi.stubEnv("PUBLIC_API_URL", "");
    vi.stubEnv("EXPO_PUBLIC_API_BASE_URL", "https://3000-preview.example.test/api");
    vi.stubEnv("PUBLIC_APP_URL", "https://app.example.test");

    expect(getPublicAppUrl()).toBe("https://3000-preview.example.test");
  });

  it("rejects insecure public auth links", () => {
    vi.stubEnv("PUBLIC_API_URL", "http://api.example.test");
    vi.stubEnv("EXPO_PUBLIC_API_BASE_URL", "https://3000-preview.example.test");

    expect(() => getPublicAppUrl()).toThrow("Public API URL must use HTTPS");
  });

  it("allows HTTP only for a loopback development API", () => {
    vi.stubEnv("PUBLIC_API_URL", "http://localhost:3000/api");

    expect(getPublicAppUrl()).toBe("http://localhost:3000");
  });

  it("fails closed when no public API origin is configured", () => {
    for (const key of [
      "PUBLIC_API_URL",
      "EXPO_PUBLIC_API_BASE_URL",
      "PUBLIC_APP_URL",
      "EXPO_PUBLIC_APP_URL",
      "VITE_PUBLIC_APP_URL",
    ]) {
      vi.stubEnv(key, "");
    }

    expect(() => getPublicAppUrl()).toThrow("Public API URL is not configured");
  });
});

describe("SMTP registration gate", () => {
  it("stays disabled when SMTP credentials are absent", () => {
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_USER", "");
    vi.stubEnv("SMTP_PASSWORD", "");
    vi.stubEnv("SMTP_PORT", "587");

    expect(isSmtpConfigured()).toBe(false);
  });

  it("enables verification only when credentials and a valid port are configured", () => {
    vi.stubEnv("SMTP_HOST", "mail.example.test");
    vi.stubEnv("SMTP_USER", "sender@example.test");
    vi.stubEnv("SMTP_PASSWORD", "test-password");
    vi.stubEnv("SMTP_PORT", "465");

    expect(isSmtpConfigured()).toBe(true);

    vi.stubEnv("SMTP_PORT", "70000");
    expect(isSmtpConfigured()).toBe(false);
  });
});
