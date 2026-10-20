export const AUTH_TOKEN_MAX_ATTEMPTS = 5;
export const AUTH_TOKEN_MAX_ISSUANCES_PER_WINDOW = 3;
export const AUTH_TOKEN_ISSUANCE_WINDOW_MS = 15 * 60 * 1000;

export function canRecordAuthAttempt(currentAttempts: number) {
  return Number.isInteger(currentAttempts) && currentAttempts >= 0 && currentAttempts < AUTH_TOKEN_MAX_ATTEMPTS;
}

export function canIssueAnotherAuthToken(recentIssuances: number) {
  return Number.isInteger(recentIssuances) && recentIssuances >= 0 && recentIssuances < AUTH_TOKEN_MAX_ISSUANCES_PER_WINDOW;
}
