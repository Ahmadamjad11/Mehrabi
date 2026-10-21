import { describe, expect, it } from "vitest";
import {
  AUTH_TOKEN_MAX_ATTEMPTS,
  AUTH_TOKEN_MAX_ISSUANCES_PER_WINDOW,
  AUTH_TOKEN_ISSUANCE_WINDOW_MS,
  canIssueAnotherAuthToken,
  canRecordAuthAttempt,
} from "../server/_core/emailAuthPolicy";

describe("email authentication token limits", () => {
  it("permits at most five OTP attempts for one token", () => {
    for (let attempt = 0; attempt < AUTH_TOKEN_MAX_ATTEMPTS; attempt += 1) {
      expect(canRecordAuthAttempt(attempt)).toBe(true);
    }
    expect(canRecordAuthAttempt(AUTH_TOKEN_MAX_ATTEMPTS)).toBe(false);
    expect(canRecordAuthAttempt(-1)).toBe(false);
    expect(canRecordAuthAttempt(1.5)).toBe(false);
  });

  it("permits at most three token issues per user in a fifteen-minute window", () => {
    expect(AUTH_TOKEN_ISSUANCE_WINDOW_MS).toBe(15 * 60 * 1000);
    for (let issued = 0; issued < AUTH_TOKEN_MAX_ISSUANCES_PER_WINDOW; issued += 1) {
      expect(canIssueAnotherAuthToken(issued)).toBe(true);
    }
    expect(canIssueAnotherAuthToken(AUTH_TOKEN_MAX_ISSUANCES_PER_WINDOW)).toBe(false);
    expect(canIssueAnotherAuthToken(-1)).toBe(false);
  });
});
