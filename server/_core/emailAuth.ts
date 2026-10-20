import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  consumeAuthToken,
  consumePasswordResetAndUpdatePassword,
  createEmailUser,
  issueAuthTokenWithinLimit,
  getActiveAuthToken,
  getLatestActiveAuthTokenForUser,
  getUserByEmail,
  getUserByPhone,
  getUserById,
  incrementAuthTokenAttempt,
  markUserEmailVerified,
  upsertUser,
} from "../db";
import { ONE_YEAR_MS } from "../../shared/const.js";
import { getSessionCookieName, getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { isSmtpConfigured, sendPasswordResetEmail, sendVerificationOtpEmail } from "./email";
import { AUTH_TOKEN_ISSUANCE_WINDOW_MS } from "./emailAuthPolicy";

const scryptAsync = promisify(scrypt);
const PASSWORD_MIN_LENGTH = 8;
const VERIFICATION_TOKEN_TTL_MS = 10 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(7).max(32),
  email: z.string().trim().email().max(320),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(128),
});
const loginSchema = z.object({ identifier: z.string().trim().min(3).max(320), password: z.string().min(1).max(128) });
const forgotSchema = z.object({ email: z.string().trim().email().max(320) });
const verifyOtpSchema = z.object({ email: z.string().trim().email().max(320), code: z.string().regex(/^\d{6}$/) });
const resetSchema = z.object({ token: z.string().min(32).max(256), password: z.string().min(PASSWORD_MIN_LENGTH).max(128) });

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string) {
  return phone.trim().replace(/[\s()-]/g, "");
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, encodedKey] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !encodedKey) return false;
  try {
    const expected = Buffer.from(encodedKey, "hex");
    const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function createRawToken() {
  return randomBytes(32).toString("hex");
}

function createOtpCode() {
  return String(randomInt(100000, 1000000));
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenHashMatches(token: string, expectedHash: string) {
  const candidate = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function emailOpenId(email: string) {
  return `email_${createHash("sha256").update(email).digest("hex").slice(0, 56)}`;
}

function userResponse(user: NonNullable<Awaited<ReturnType<typeof getUserById>>>) {
  return {
    id: user.id,
    openId: user.openId,
    name: user.name,
    email: user.email,
    loginMethod: user.loginMethod,
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
    lastSignedIn: user.lastSignedIn.toISOString(),
  };
}

async function establishSession(req: Request, res: Response, user: NonNullable<Awaited<ReturnType<typeof getUserById>>>) {
  const sessionToken = await sdk.createSessionToken(user.openId, {
    name: user.name || "",
    expiresInMs: ONE_YEAR_MS,
  });
  const cookieOptions = getSessionCookieOptions(req);
  res.cookie(getSessionCookieName(req), sessionToken, {
    ...cookieOptions,
    maxAge: ONE_YEAR_MS,
  });
  const isNative = req.headers["x-client-platform"] === "native";
  res.json({
    ...(isNative ? { app_session_id: sessionToken } : {}),
    user: userResponse(user),
  });
}

function htmlPage(title: string, message: string, status = 200, form?: string) {
  return { status, body: `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f7f9fa;color:#122033;font-family:Arial,sans-serif;padding:24px}.card{max-width:520px;margin:8vh auto;background:#fff;border-radius:20px;padding:32px;box-shadow:0 10px 30px rgba(16,45,74,.08)}h1{color:#102d4a;margin-top:0}p{line-height:1.8;color:#526475}input{box-sizing:border-box;width:100%;padding:13px;border:1px solid #dfe7ec;border-radius:10px;margin:7px 0 14px;font-size:16px}button{width:100%;padding:13px;border:0;border-radius:10px;background:#102d4a;color:#fff;font-size:16px;cursor:pointer}.brand{color:#5aafa7;font-weight:700}</style></head><body><main class="card"><div class="brand">محرابي</div><h1>${title}</h1><p>${message}</p>${form ?? ""}</main></body></html>` };
}

async function issueVerificationEmail(user: NonNullable<Awaited<ReturnType<typeof getUserById>>>) {
  if (!user.email) throw new Error("Email is required");
  const rawToken = createOtpCode();
  const issued = await issueAuthTokenWithinLimit({
    userId: user.id,
    tokenHash: hashToken(rawToken),
    type: "email_verification",
    expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
  }, new Date(Date.now() - AUTH_TOKEN_ISSUANCE_WINDOW_MS));
  if (!issued) return false;
  await sendVerificationOtpEmail({ to: user.email, name: user.name || "مستخدم مِحرابي", code: rawToken });
  return true;
}

async function issueResetEmail(user: NonNullable<Awaited<ReturnType<typeof getUserById>>>) {
  if (!user.email) return false;
  const rawToken = createRawToken();
  const issued = await issueAuthTokenWithinLimit({
    userId: user.id,
    tokenHash: hashToken(rawToken),
    type: "password_reset",
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  }, new Date(Date.now() - AUTH_TOKEN_ISSUANCE_WINDOW_MS));
  if (!issued) return false;
  await sendPasswordResetEmail({ to: user.email, name: user.name || "مستخدم محرابي", token: rawToken });
  return true;
}

async function resetPassword(token: string, password: string) {
  const authToken = await getActiveAuthToken(hashToken(token), "password_reset");
  if (!authToken) return false;
  const user = await getUserById(authToken.userId);
  if (!user || !user.passwordHash) return false;
  return consumePasswordResetAndUpdatePassword(authToken.id, user.id, await hashPassword(password));
}

function getQueryToken(req: Request) {
  return typeof req.query.token === "string" ? req.query.token : "";
}

export function registerEmailAuthRoutes(app: Express) {
  app.post("/api/auth/email/register", async (req, res) => {
    console.log("[EmailAuth] Registration request received");
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "الاسم ورقم الهاتف والبريد وكلمة المرور غير صالحة" });
      return;
    }
    if (!isSmtpConfigured()) {
      res.status(503).json({ error: "التسجيل بالبريد غير متاح حاليًا؛ استخدم تسجيل الدخول عبر Manus.", code: "EMAIL_AUTH_UNAVAILABLE" });
      return;
    }
    const email = normalizeEmail(parsed.data.email);
    const phone = normalizePhone(parsed.data.phone);
    try {
      const existing = await getUserByEmail(email);
      const existingPhone = await getUserByPhone(phone);
      if (existing || existingPhone) {
        res.status(409).json({ error: existingPhone ? "رقم الهاتف مستخدم في حساب آخر" : "البريد الإلكتروني مستخدم في حساب آخر" });
        return;
      }
      const userId = await createEmailUser({
        openId: emailOpenId(email),
        name: parsed.data.name,
        phone,
        email,
        passwordHash: await hashPassword(parsed.data.password),
      });
      const user = await getUserById(userId);
      if (!user) throw new Error("Created user was not found");
      if (!(await issueVerificationEmail(user))) {
        res.status(429).json({ error: "تجاوزت الحد المسموح لرسائل التحقق. حاول لاحقًا." });
        return;
      }
      res.status(202).json({ success: true, verificationRequired: true });
    } catch (error) {
      console.error("[EmailAuth] Registration failed", error instanceof Error ? error.message : "unknown error");
      res.status(500).json({ error: "تعذر إنشاء الحساب حاليًا. حاول مرة أخرى لاحقًا." });
    }
  });

  app.post("/api/auth/email/login", async (req, res) => {
    console.log("[EmailAuth] Login request received");
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "البريد/الهاتف أو كلمة المرور غير صالحة" });
      return;
    }
    const identifier = parsed.data.identifier;
    const user = identifier.includes("@")
      ? await getUserByEmail(normalizeEmail(identifier))
      : await getUserByPhone(normalizePhone(identifier));
    if (!user?.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      res.status(401).json({ error: "البريد أو كلمة المرور غير صحيحة" });
      return;
    }
    if (!user.emailVerifiedAt) {
      res.status(403).json({ error: "أكد بريدك الإلكتروني قبل تسجيل الدخول.", code: "EMAIL_NOT_VERIFIED" });
      return;
    }
    await upsertUser({ openId: user.openId, lastSignedIn: new Date() });
    const currentUser = (await getUserById(user.id)) ?? user;
    await establishSession(req, res, currentUser);
  });

  app.post("/api/auth/email/forgot-password", async (req, res) => {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "أدخل بريدًا إلكترونيًا صالحًا" });
      return;
    }
    if (!isSmtpConfigured()) {
      res.json({ success: true, message: "إذا كان البريد مسجلًا لدينا فستصلك رسالة الاستعادة قريبًا." });
      return;
    }
    try {
      const user = await getUserByEmail(normalizeEmail(parsed.data.email));
      if (user?.passwordHash && user.email) await issueResetEmail(user);
    } catch (error) {
      console.error("[EmailAuth] Password reset email delivery failed", error instanceof Error ? error.message : "unknown error");
    }
    res.json({ success: true, message: "إذا كان البريد مسجلًا لدينا فستصلك رسالة الاستعادة قريبًا." });
  });

  app.post("/api/auth/email/resend-verification", async (req, res) => {
    console.log("[EmailAuth] Verification resend request received");
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "أدخل بريدًا إلكترونيًا صالحًا" });
      return;
    }
    if (!isSmtpConfigured()) {
      res.status(503).json({ error: "إرسال رسائل التحقق غير مهيأ حاليًا.", code: "EMAIL_AUTH_UNAVAILABLE" });
      return;
    }
    try {
      const user = await getUserByEmail(normalizeEmail(parsed.data.email));
      if (user?.passwordHash && user.email && !user.emailVerifiedAt) await issueVerificationEmail(user);
    } catch (error) {
      console.error("[EmailAuth] Verification email delivery failed", error instanceof Error ? error.message : "unknown error");
    }
    res.json({ success: true, message: "إذا كان الحساب غير مؤكد فستصلك رسالة تأكيد جديدة قريبًا." });
  });

  app.post("/api/auth/email/verify-otp", async (req, res) => {
    const parsed = verifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "أدخل رمز التحقق المكوّن من 6 أرقام" });
      return;
    }
    const user = await getUserByEmail(normalizeEmail(parsed.data.email));
    const authToken = user ? await getLatestActiveAuthTokenForUser(user.id, "email_verification") : undefined;
    if (!user || !authToken) {
      res.status(400).json({ error: "رمز التحقق غير صحيح أو منتهي" });
      return;
    }
    if (!(await incrementAuthTokenAttempt(authToken.id))) {
      res.status(429).json({ error: "استُنفدت محاولات هذا الرمز؛ اطلب رمزًا جديدًا.", code: "OTP_RATE_LIMITED" });
      return;
    }
    if (!tokenHashMatches(parsed.data.code, authToken.tokenHash)) {
      res.status(400).json({ error: "رمز التحقق غير صحيح أو منتهي" });
      return;
    }
    if (!(await consumeAuthToken(authToken.id))) {
      res.status(400).json({ error: "رمز التحقق غير صحيح أو منتهي" });
      return;
    }
    await markUserEmailVerified(user.id);
    const currentUser = (await getUserById(user.id)) ?? user;
    await establishSession(req, res, currentUser);
  });

  app.post("/api/auth/email/reset-password", async (req, res) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "كلمة المرور أو الرابط غير صالح" });
      return;
    }
    try {
      const changed = await resetPassword(parsed.data.token, parsed.data.password);
      if (!changed) {
        res.status(400).json({ error: "رابط الاستعادة منتهي أو مستخدم" });
        return;
      }
      res.json({ success: true, message: "تم تغيير كلمة المرور بنجاح" });
    } catch {
      console.error("[EmailAuth] Password reset failed");
      res.status(500).json({ error: "تعذر تغيير كلمة المرور حاليًا. حاول مرة أخرى لاحقًا." });
    }
  });

  app.get("/api/auth/verify-email", async (req, res) => {
    const token = getQueryToken(req);
    const authToken = token ? await getActiveAuthToken(hashToken(token), "email_verification") : undefined;
    if (!authToken) {
      const page = htmlPage("تعذر تأكيد البريد", "رابط التأكيد منتهي أو مستخدم. اطلب رسالة جديدة من التطبيق.", 400);
      res.status(page.status).type("html").send(page.body);
      return;
    }
    const user = await getUserById(authToken.userId);
    if (!user) {
      const page = htmlPage("تعذر تأكيد البريد", "لم يعد الحساب موجودًا.", 400);
      res.status(page.status).type("html").send(page.body);
      return;
    }
    if (!(await consumeAuthToken(authToken.id))) {
      const page = htmlPage("تعذر تأكيد البريد", "رابط التأكيد منتهي أو مستخدم. اطلب رسالة جديدة من التطبيق.", 400);
      res.status(page.status).type("html").send(page.body);
      return;
    }
    await markUserEmailVerified(user.id);
    const page = htmlPage("تم تأكيد بريدك", "أصبح حسابك جاهزًا. ارجع إلى تطبيق محرابي وسجّل الدخول.");
    res.status(page.status).type("html").send(page.body);
  });

  app.get("/api/auth/reset-password", async (req, res) => {
    const token = getQueryToken(req);
    const authToken = token ? await getActiveAuthToken(hashToken(token), "password_reset") : undefined;
    if (!authToken) {
      const page = htmlPage("تعذر استعادة كلمة المرور", "رابط الاستعادة منتهي أو مستخدم.", 400);
      res.status(page.status).type("html").send(page.body);
      return;
    }
    const escapedToken = token.replace(/[&<>'"]/g, "");
    const form = `<form method="post" action="/api/auth/reset-password"><input type="hidden" name="token" value="${escapedToken}"><label>كلمة المرور الجديدة</label><input name="password" type="password" minlength="8" required autocomplete="new-password"><label>تأكيد كلمة المرور</label><input name="passwordConfirmation" type="password" minlength="8" required autocomplete="new-password"><button type="submit">حفظ كلمة المرور</button></form>`;
    const page = htmlPage("تعيين كلمة مرور جديدة", "اختر كلمة مرور لا تقل عن 8 أحرف.", 200, form);
    res.status(page.status).type("html").send(page.body);
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const confirmation = typeof req.body?.passwordConfirmation === "string" ? req.body.passwordConfirmation : "";
    if (password.length < PASSWORD_MIN_LENGTH || password !== confirmation) {
      const page = htmlPage("تعذر تغيير كلمة المرور", "تأكد من أن كلمتي المرور متطابقتان وتحتويان على 8 أحرف على الأقل.", 400);
      res.status(page.status).type("html").send(page.body);
      return;
    }
    let changed: boolean;
    try {
      changed = await resetPassword(token, password);
    } catch {
      console.error("[EmailAuth] Password reset form failed");
      const page = htmlPage("تعذر تغيير كلمة المرور", "تعذر إكمال العملية الآن. حاول مرة أخرى لاحقًا.", 500);
      res.status(page.status).type("html").send(page.body);
      return;
    }
    const page = changed
      ? htmlPage("تم تغيير كلمة المرور", "يمكنك الآن العودة إلى تطبيق محرابي وتسجيل الدخول.")
      : htmlPage("تعذر تغيير كلمة المرور", "رابط الاستعادة منتهي أو مستخدم.", 400);
    res.status(page.status).type("html").send(page.body);
  });
}
