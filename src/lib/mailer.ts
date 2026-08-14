import "server-only";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env, features } from "./env";
import { logger } from "./logger";
import { internalMessage } from "./errors";

/**
 * Outbound email.
 *
 * One transport for the whole process, created lazily and reused: a pooled
 * connection avoids paying the TCP + STARTTLS + AUTH handshake on every message,
 * which matters because the password-reset path sends while a user waits.
 *
 * Failure policy is deliberate: sendMail() never throws. Every caller here is a
 * side effect of an operation that has already succeeded (a token row is written,
 * a password is already changed), so turning a provider outage into a 500 would
 * report failure for work that actually completed — and on the forgot-password
 * route it would additionally leak whether an address exists. Failures are logged
 * loudly and reported through the boolean instead.
 */

let cached: Transporter | null = null;

function transporter(): Transporter | null {
  if (!features.email) return null;
  if (cached) return cached;

  const implicitTls = env.SMTP_PORT === 465;

  cached = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Only 465 is implicit TLS. 587 is STARTTLS: the connection opens in
    // plaintext and is upgraded, so `secure` must be false there — and
    // requireTLS makes the upgrade mandatory, so a server that refuses to
    // upgrade fails loudly instead of silently sending AUTH in the clear.
    secure: implicitTls,
    requireTLS: !implicitTls,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { minVersion: "TLSv1.2" },
  });

  return cached;
}

export type MailInput = {
  to: string;
  subject: string;
  /** Plain-text alternative. Never optional: some clients render only this. */
  text: string;
  html: string;
};

/**
 * Sends one message. Returns whether the provider accepted it.
 *
 * The recipient address is never logged — it is the one piece of PII that would
 * turn a log file into a mailing list.
 */
export async function sendMail(input: MailInput): Promise<boolean> {
  const tx = transporter();
  if (!tx) {
    logger.warn("email is not configured; message dropped", { subject: input.subject });
    return false;
  }

  try {
    const info = await tx.sendMail({
      from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM as string },
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });

    const accepted = info.accepted?.length ?? 0;
    if (accepted === 0) {
      logger.error("email rejected by provider", { subject: input.subject, rejected: info.rejected?.length ?? 0 });
      return false;
    }

    logger.info("email sent", { subject: input.subject, messageId: info.messageId });
    return true;
  } catch (e) {
    logger.error("email send failed", { subject: input.subject, error: internalMessage(e) });
    return false;
  }
}

/**
 * Verifies host, port, TLS and credentials without sending anything.
 * Used by the operational check script, not by the request path — the round trip
 * is far too slow to sit inside a health endpoint.
 */
export async function verifyMailer(): Promise<{ ok: boolean; error?: string }> {
  const tx = transporter();
  if (!tx) return { ok: false, error: "SMTP is not configured" };
  try {
    await tx.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: internalMessage(e) };
  }
}
