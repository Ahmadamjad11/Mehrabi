import nodemailer from "nodemailer";

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

export function getPublicAppUrl() {
  const configured = [
    process.env.PUBLIC_API_URL,
    process.env.EXPO_PUBLIC_API_BASE_URL,
    process.env.PUBLIC_APP_URL,
    process.env.EXPO_PUBLIC_APP_URL,
    process.env.VITE_PUBLIC_APP_URL,
  ].find((value) => value?.trim());

  if (!configured) {
    throw new Error("Public API URL is not configured");
  }

  const url = new URL(configured);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("Public API URL must use HTTPS");
  }

  return url.origin;
}

export function isSmtpConfigured() {
  const port = Number(process.env.SMTP_PORT || "587");
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASSWORD &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535,
  );
}

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  const port = Number(process.env.SMTP_PORT || "587");

  if (!host || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP production secrets are not configured");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass: password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
  });
}

async function sendSystemEmail(input: { to: string; subject: string; text: string; html: string }) {
  const user = process.env.SMTP_USER;
  const from = process.env.SMTP_FROM?.trim();
  if (!user) throw new Error("SMTP production sender is not configured");
  console.log(`[Email] Sending message through SMTP on port ${Number(process.env.SMTP_PORT || "587")}`);
  const result = await getTransporter().sendMail({
    from: `مِحرابي <${user}>`,
    replyTo: from && from.includes("@") ? from : user,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  console.log(`[Email] SMTP accepted=${result.accepted.length} rejected=${result.rejected.length}`);
}

export async function sendVerificationEmail(input: { to: string; name: string; token: string }) {
  const name = escapeHtml(input.name || "مستخدم محرابي");
  const url = `${getPublicAppUrl()}/api/auth/verify-email?token=${encodeURIComponent(input.token)}`;
  await sendSystemEmail({
    to: input.to,
    subject: "أكد بريدك الإلكتروني في محرابي",
    text: `مرحبًا ${input.name || "بك"}، افتح الرابط التالي لتأكيد بريدك الإلكتروني: ${url}`,
    html: `<!doctype html><html lang="ar" dir="rtl"><body style="font-family:Arial,sans-serif;background:#f7f9fa;padding:32px;color:#122033"><div style="max-width:560px;margin:auto;background:#fff;border-radius:18px;padding:32px"><h1 style="color:#102d4a">محرابي</h1><p>مرحبًا ${name}،</p><p>اضغط الزر التالي لتأكيد بريدك الإلكتروني وتفعيل حسابك:</p><p><a href="${url}" style="display:inline-block;background:#102d4a;color:#fff;padding:13px 22px;border-radius:9px;text-decoration:none">تأكيد البريد الإلكتروني</a></p><p style="color:#788595;font-size:13px">ينتهي هذا الرابط خلال 24 ساعة. إذا لم تنشئ حسابًا في محرابي فتجاهل هذه الرسالة.</p></div></body></html>`,
  });
}

export async function sendPasswordResetEmail(input: { to: string; name: string; token: string }) {
  const name = escapeHtml(input.name || "مستخدم محرابي");
  const url = `${getPublicAppUrl()}/api/auth/reset-password?token=${encodeURIComponent(input.token)}`;
  await sendSystemEmail({
    to: input.to,
    subject: "استعادة كلمة المرور في محرابي",
    text: `مرحبًا ${input.name || "بك"}، افتح الرابط التالي لتعيين كلمة مرور جديدة: ${url}`,
    html: `<!doctype html><html lang="ar" dir="rtl"><body style="font-family:Arial,sans-serif;background:#f7f9fa;padding:32px;color:#122033"><div style="max-width:560px;margin:auto;background:#fff;border-radius:18px;padding:32px"><h1 style="color:#102d4a">محرابي</h1><p>مرحبًا ${name}،</p><p>يمكنك تعيين كلمة مرور جديدة من خلال الزر التالي:</p><p><a href="${url}" style="display:inline-block;background:#102d4a;color:#fff;padding:13px 22px;border-radius:9px;text-decoration:none">تعيين كلمة مرور جديدة</a></p><p style="color:#788595;font-size:13px">ينتهي رابط الاستعادة خلال ساعة واحدة. إذا لم تطلب الاستعادة فتجاهل هذه الرسالة.</p></div></body></html>`,
  });
}

export async function sendVerificationOtpEmail(input: { to: string; name: string; code: string }) {
  const name = escapeHtml(input.name || "مستخدم محرابي");
  await sendSystemEmail({
    to: input.to,
    subject: "رمز تأكيد بريدك في محرابي",
    text: `مرحبًا ${input.name || "بك"}، رمز تأكيد بريدك في محرابي هو: ${input.code}. ينتهي خلال 10 دقائق.`,
    html: `<!doctype html><html lang="ar" dir="rtl"><body style="font-family:Arial,sans-serif;background:#f7f9fa;padding:32px;color:#122033"><div style="max-width:560px;margin:auto;background:#fff;border-radius:18px;padding:32px;text-align:center"><h1 style="color:#102d4a">محرابي</h1><p>مرحبًا ${name}،</p><p>استخدم رمز التحقق التالي داخل التطبيق:</p><div style="font-size:32px;letter-spacing:8px;font-weight:800;color:#102d4a;background:#f0f7f7;padding:18px;border-radius:12px">${input.code}</div><p style="color:#788595;font-size:13px">ينتهي الرمز خلال 10 دقائق.</p></div></body></html>`,
  });
}
