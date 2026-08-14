import "server-only";
import { env } from "./env";

/**
 * Transactional email templates.
 *
 * Constraints that shape these, in order of how much they cost to get wrong:
 *
 *  1. Every message ships plain text alongside HTML. Text is not a fallback
 *     afterthought — it is what many clients and all screen readers use, and a
 *     reset link that only exists inside a styled <a> is unreachable there.
 *  2. Layout is inline-styled tables. Gmail strips <style> blocks and no email
 *     client implements flex/grid reliably; this is the one context where
 *     1998-era HTML is correct.
 *  3. RTL is set on the container (dir="rtl"), and the URL itself is wrapped in
 *     dir="ltr" so bidi reordering cannot visually scramble the token.
 *  4. No remote images. An image-blocking client would otherwise render an empty
 *     box where the brand is, and a tracking pixel in a security email is a
 *     privacy problem.
 *
 * Copy rule: these messages must state what happened, what to do, when it
 * expires, and what to do if it was not you. Nothing else.
 */

const BRAND = "آکادمی حمایت";
const ACCENT = "#4f46e5";
const TEXT = "#1f2430";
const MUTED = "#5b6270";
const BORDER = "#e3e6ec";
const CANVAS = "#f4f5f8";

/** Escapes text interpolated into HTML. Names come from user input. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${BRAND}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CANVAS};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
<tr><td style="padding:22px 28px;border-bottom:1px solid ${BORDER};">
<span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;background:${ACCENT};color:#ffffff;border-radius:9px;font-family:Tahoma,Arial,sans-serif;font-size:13px;font-weight:bold;">AS</span>
<span style="font-family:Tahoma,Arial,sans-serif;font-size:15px;font-weight:bold;color:${TEXT};padding-right:10px;vertical-align:middle;">${BRAND}</span>
</td></tr>
<tr><td style="padding:28px;font-family:Tahoma,Arial,sans-serif;font-size:14px;line-height:2;color:${TEXT};">
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid ${BORDER};font-family:Tahoma,Arial,sans-serif;font-size:11px;line-height:1.9;color:${MUTED};">
این پیام به‌صورت خودکار ارسال شده است؛ به آن پاسخ ندهید.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function button(url: string, label: string): string {
  // A table-wrapped anchor: Outlook ignores padding on inline elements, so the
  // clickable area would otherwise collapse to the text bounds.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;">
<tr><td align="center" bgcolor="${ACCENT}" style="border-radius:9px;">
<a href="${url}" style="display:inline-block;padding:13px 28px;font-family:Tahoma,Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:9px;">${label}</a>
</td></tr></table>`;
}

function fallbackLink(url: string): string {
  return `<p style="margin:0 0 4px;font-size:12px;color:${MUTED};">اگر دکمه کار نکرد، این نشانی را در مرورگر باز کنید:</p>
<p style="margin:0 0 6px;font-size:12px;word-break:break-all;" dir="ltr"><a href="${url}" style="color:${ACCENT};">${url}</a></p>`;
}

export type Email = { subject: string; text: string; html: string };

/** Minutes rendered in Persian-friendly wording without a formatting library. */
function minutes(count: number): string {
  return `${count} دقیقه`;
}

export function passwordResetEmail(params: { name: string; url: string; expiresInMinutes: number }): Email {
  const name = esc(params.name);
  const window = minutes(params.expiresInMinutes);

  return {
    subject: `بازیابی رمز عبور — ${BRAND}`,
    text: [
      `سلام ${params.name}،`,
      ``,
      `برای حساب شما در ${BRAND} درخواست بازیابی رمز عبور ثبت شد.`,
      `برای انتخاب رمز جدید این نشانی را باز کنید:`,
      ``,
      params.url,
      ``,
      `این پیوند ${window} اعتبار دارد و فقط یک‌بار قابل استفاده است.`,
      `اگر شما این درخواست را نداده‌اید، این پیام را نادیده بگیرید؛ رمز عبور شما تغییر نمی‌کند.`,
    ].join("\n"),
    html: shell(
      `<p style="margin:0 0 14px;">سلام ${name}،</p>
<p style="margin:0 0 14px;">برای حساب شما در ${BRAND} درخواست بازیابی رمز عبور ثبت شد. برای انتخاب رمز جدید روی دکمه زیر بزنید.</p>
${button(params.url, "انتخاب رمز عبور جدید")}
${fallbackLink(params.url)}
<p style="margin:18px 0 0;font-size:13px;color:${MUTED};">این پیوند <b style="color:${TEXT};">${window}</b> اعتبار دارد و فقط یک‌بار قابل استفاده است.</p>
<p style="margin:8px 0 0;font-size:13px;color:${MUTED};">اگر شما این درخواست را نداده‌اید، این پیام را نادیده بگیرید؛ رمز عبور شما تغییر نمی‌کند.</p>`
    ),
  };
}

/**
 * Sent after a successful reset or change. This is not a courtesy message: it is
 * how a user finds out an attacker changed their password, so it always states
 * that other sessions were closed and what to do next.
 */
export function passwordChangedEmail(params: { name: string }): Email {
  const name = esc(params.name);
  const loginUrl = `${env.NEXT_PUBLIC_APP_URL}/auth/login`;

  return {
    subject: `رمز عبور شما تغییر کرد — ${BRAND}`,
    text: [
      `سلام ${params.name}،`,
      ``,
      `رمز عبور حساب شما در ${BRAND} تغییر کرد و همه نشست‌های دیگر بسته شدند.`,
      ``,
      `اگر این کار را شما انجام نداده‌اید، همین حالا وارد شوید و رمز عبور را عوض کنید:`,
      loginUrl,
    ].join("\n"),
    html: shell(
      `<p style="margin:0 0 14px;">سلام ${name}،</p>
<p style="margin:0 0 14px;">رمز عبور حساب شما در ${BRAND} تغییر کرد و برای امنیت بیشتر، همه نشست‌های دیگر بسته شدند.</p>
<p style="margin:0 0 14px;">اگر این کار را شما انجام نداده‌اید، همین حالا وارد شوید و رمز عبور را عوض کنید.</p>
${button(loginUrl, "ورود به حساب")}`
    ),
  };
}

export function emailVerificationEmail(params: { name: string; url: string; expiresInHours: number }): Email {
  const name = esc(params.name);

  return {
    subject: `تأیید ایمیل — ${BRAND}`,
    text: [
      `سلام ${params.name}،`,
      ``,
      `برای فعال شدن امکان ثبت حمایت، ایمیل خود را تأیید کنید:`,
      ``,
      params.url,
      ``,
      `این پیوند ${params.expiresInHours} ساعت اعتبار دارد.`,
    ].join("\n"),
    html: shell(
      `<p style="margin:0 0 14px;">سلام ${name}،</p>
<p style="margin:0 0 14px;">برای فعال شدن امکان ثبت حمایت، ایمیل خود را تأیید کنید.</p>
${button(params.url, "تأیید ایمیل")}
${fallbackLink(params.url)}
<p style="margin:18px 0 0;font-size:13px;color:${MUTED};">این پیوند ${params.expiresInHours} ساعت اعتبار دارد.</p>`
    ),
  };
}
