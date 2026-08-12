import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/api";
import { authed } from "@/lib/handler";
import { revokeAllSessions, revokeSession } from "@/lib/security";
import { describeDevice } from "@/lib/http";
import { NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";

/**
 * Session manager: lists the viewer's own active sessions and lets them revoke
 * one or all others. Ownership is enforced in the query (userId is always the
 * viewer's), so an id from another account simply doesn't match — no IDOR.
 */
export const GET = authed(
  "auth.sessions.list",
  async ({ user, sessionId }) => {
    const sessions = await prisma.session.findMany({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    });

    return {
      items: sessions.map((session) => ({
        id: session.id,
        device: describeDevice(session.userAgent),
        current: session.id === sessionId,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      })),
    };
  },
  { csrf: false }
);

const deleteSchema = z.object({ sessionId: z.string().min(10).optional(), all: z.boolean().optional() });

export const DELETE = authed("auth.sessions.revoke", async ({ req, user, sessionId }) => {
  const body = await parseBody(req, deleteSchema);

  if (body.all) {
    await revokeAllSessions(user.id, sessionId);
    await writeAudit({ userId: user.id, action: "SECURITY", entity: "Session", req, metadata: { scope: "ALL_OTHERS" } });
    return { message: "سایر نشست‌ها بسته شدند." };
  }

  if (!body.sessionId) throw new NotFoundError("نشست مشخص نشده است.");
  const revoked = await revokeSession(user.id, body.sessionId);
  if (!revoked) throw new NotFoundError("این نشست پیدا نشد.");

  await writeAudit({ userId: user.id, action: "SECURITY", entity: "Session", entityId: body.sessionId, req });
  return { message: "نشست بسته شد." };
});
