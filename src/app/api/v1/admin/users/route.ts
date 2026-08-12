import { prisma } from "@/lib/prisma";
import { parseBody, parseQuery } from "@/lib/api";
import { moderator } from "@/lib/handler";
import { admin as adminRoute } from "@/lib/handler";
import { userModerationSchema } from "@/lib/validators";
import { assertCanAssignRole, assertCanSetStatus, assertCan } from "@/lib/authz";
import { NotFoundError } from "@/lib/errors";
import { ledgerKey, recordCredit } from "@/lib/services/ledger";
import { revokeAllSessions } from "@/lib/security";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/services/notifications";
import { z } from "zod";

/**
 * User administration.
 *
 * Privilege boundaries are enforced by src/lib/authz.ts, not by which buttons the
 * UI renders:
 *  - Nobody can act on their own account (no self-ban, no self-promotion).
 *  - You may only act on strictly lower privilege, so ADMIN cannot touch
 *    SUPER_ADMIN and two ADMINs cannot fight.
 *  - Only SUPER_ADMIN can change roles, and never to a level at or above its own.
 * Every action requires a reason and is written to the audit log.
 */
const listSchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(["ALL", "ACTIVE", "SUSPENDED", "BANNED"]).default("ALL"),
  role: z.enum(["ALL", "USER", "MODERATOR", "ADMIN", "SUPER_ADMIN"]).default("ALL"),
  sort: z.enum(["recent", "reputation", "credits", "supports"]).default("recent"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const GET = moderator(
  "admin.users.list",
  async ({ url, actor }) => {
    assertCan(actor, "user:list");
    const query = parseQuery(url, listSchema);

    const where = {
      ...(query.status === "ALL" ? {} : { status: query.status }),
      ...(query.role === "ALL" ? {} : { role: query.role }),
      ...(query.q
        ? {
            OR: [
              { username: { contains: query.q, mode: "insensitive" as const } },
              { name: { contains: query.q, mode: "insensitive" as const } },
              { email: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const orderBy =
      query.sort === "reputation"
        ? [{ reputation: "desc" as const }]
        : query.sort === "credits"
          ? [{ credits: "desc" as const }]
          : query.sort === "supports"
            ? [{ supportsCompleted: "desc" as const }]
            : [{ createdAt: "desc" as const }];

    const [items, total, summary] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          avatarUrl: true,
          role: true,
          status: true,
          youtubeVerified: true,
          credits: true,
          points: true,
          level: true,
          reputation: true,
          trustScore: true,
          rankTier: true,
          supportsCompleted: true,
          supportsAbandoned: true,
          lastActiveAt: true,
          createdAt: true,
          _count: {
            select: {
              supportsGiven: { where: { status: "ACTIVE" } },
              supportsReceived: { where: { status: "ACTIVE" } },
              sessions: { where: { revokedAt: null } },
              abuseSignals: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
      prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
      summary: Object.fromEntries(summary.map((row) => [row.status, row._count._all])),
    };
  },
  { csrf: false }
);

export const POST = moderator(
  "admin.users.moderate",
  async ({ req, actor }) => {
    const data = await parseBody(req, userModerationSchema);

    const target = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { id: true, role: true, status: true, username: true },
    });
    if (!target) throw new NotFoundError("این کاربر پیدا نشد.");

    if (data.action === "SET_STATUS") {
      const status = data.status ?? "ACTIVE";
      assertCanSetStatus(actor, target, status);

      await prisma.user.update({ where: { id: target.id }, data: { status } });
      // A ban/suspension must also kill live sessions, otherwise the account keeps
      // working until its cookie happens to expire.
      if (status === "BANNED" || status === "SUSPENDED") {
        await revokeAllSessions(target.id);
        await prisma.campaign.updateMany({
          where: { creatorId: target.id, status: { in: ["DRAFT", "ACTIVE", "PAUSED"] } },
          data: { status: "ENDED" },
        });
      }

      await writeAudit({
        userId: actor.id,
        action: "ADMIN_ACTION",
        entity: "User",
        entityId: target.id,
        req,
        metadata: { change: "status", from: target.status, to: status, reason: data.reason },
      });
      await notify({
        userId: target.id,
        type: "SECURITY",
        title: status === "ACTIVE" ? "حساب شما فعال شد" : "وضعیت حساب شما تغییر کرد",
        message: data.reason,
      });

      return { message: "وضعیت کاربر بروزرسانی شد." };
    }

    if (data.action === "SET_ROLE") {
      const role = data.role ?? "USER";
      assertCanAssignRole(actor, target, role);
      await prisma.user.update({ where: { id: target.id }, data: { role } });
      // A privilege change must not leave old sessions running with stale rights.
      await revokeAllSessions(target.id);
      await writeAudit({
        userId: actor.id,
        action: "ADMIN_ACTION",
        entity: "User",
        entityId: target.id,
        req,
        metadata: { change: "role", from: target.role, to: role, reason: data.reason },
      });
      return { message: "سطح دسترسی کاربر بروزرسانی شد." };
    }

    // ADJUST_CREDITS
    assertCan(actor, "user:adjust_ledger");
    const amount = data.amount ?? 0;
    if (amount === 0) return { message: "مقدار صفر اعمال نشد." };

    await prisma.$transaction(async (tx) => {
      await recordCredit(tx, {
        userId: target.id,
        type: "ADMIN_ADJUSTMENT",
        amount,
        idempotencyKey: ledgerKey(["admin-adjust", target.id, Date.now()]),
        reason: data.reason,
        metadata: { moderatorId: actor.id },
      });
    });

    await writeAudit({
      userId: actor.id,
      action: "LEDGER_ADJUSTMENT",
      entity: "User",
      entityId: target.id,
      req,
      metadata: { amount, reason: data.reason },
    });

    return { message: "اعتبار کاربر با ثبت در دفتر حساب اصلاح شد." };
  },
  { rateLimit: "adminMutation" }
);

/** Full account detail for the admin drill-down, including the audit trail. */
export const PATCH = adminRoute(
  "admin.users.detail",
  async ({ req }) => {
    const { userId } = await parseBody(req, z.object({ userId: z.string().min(10) }));

    const [user, ledger, signals, sessions, audit] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, username: true, name: true, email: true, role: true, status: true,
          credits: true, points: true, reputation: true, trustScore: true, rankTier: true,
          supportsCompleted: true, supportsAbandoned: true, createdAt: true, lastActiveAt: true,
        },
      }),
      prisma.creditLedger.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, type: true, amount: true, balanceAfter: true, reason: true, createdAt: true },
      }),
      prisma.abuseSignal.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { type: true, severity: true, metadata: true, createdAt: true },
      }),
      prisma.session.findMany({
        where: { userId, revokedAt: null },
        orderBy: { lastSeenAt: "desc" },
        take: 10,
        select: { id: true, userAgent: true, lastSeenAt: true, createdAt: true },
      }),
      prisma.auditLog.findMany({
        where: { OR: [{ userId }, { entityId: userId }] },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { action: true, entity: true, metadata: true, createdAt: true },
      }),
    ]);

    if (!user) throw new NotFoundError("این کاربر پیدا نشد.");
    return { user, ledger, signals, sessions, audit };
  },
  { csrf: false }
);
