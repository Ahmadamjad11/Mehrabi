// Used only to expire the previous app cookie; it is never accepted as an authenticated session.
export const LEGACY_COOKIE_NAME = "manus_session_146334081328518";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
