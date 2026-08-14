import { prisma } from "@/lib/prisma";
import { parseBody, parseQuery } from "@/lib/api";
import { active } from "@/lib/handler";
import { campaignCreateSchema, campaignUpdateSchema, paginationSchema } from "@/lib/validators";
import { NotFoundError, BusinessRuleError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { debitBudget, endCampaignWithRefund, estimateSupports } from "@/lib/services/budget";
import { ledgerKey, recordCredit } from "@/lib/services/ledger";
import { SUPPORT_TRANSFER_CREDITS, WATCH_RULES } from "@/lib/gamification";

/**
 * Creator campaign management.
 *
 * Ownership is enforced on every mutation by scoping the WHERE clause to
 * creatorId — an id belonging to someone else simply matches nothing (no IDOR),
 * and the check is server-side rather than a hidden button.
 */

export const GET = active(
  "campaigns.mine",
  async ({ url, user }) => {
    const { page, limit } = parseQuery(url, paginationSchema);
    const [items, total] = await Promise.all([
      prisma.campaign.findMany({
        where: { creatorId: user.id },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          video: { select: { id: true, title: true, thumbnailUrl: true, youtubeVideoId: true, durationSec: true } },
          tasks: { orderBy: { sortOrder: "asc" }, select: { type: true, required: true } },
          _count: { select: { supports: true, sessions: true } },
        },
      }),
      prisma.campaign.count({ where: { creatorId: user.id } }),
    ]);

    // Analytics come from real session outcomes, not guesses.
    const campaignIds = items.map((c) => c.id);
    const sessionStats = campaignIds.length
      ? await prisma.supportSession.groupBy({
          by: ["campaignId", "state"],
          where: { campaignId: { in: campaignIds } },
          _count: { _all: true },
        })
      : [];

    const statsByCampaign = new Map<string, { started: number; completed: number; failed: number }>();
    for (const row of sessionStats) {
      const entry = statsByCampaign.get(row.campaignId) ?? { started: 0, completed: 0, failed: 0 };
      entry.started += row._count._all;
      if (row.state === "COMPLETED") entry.completed += row._count._all;
      if (["FAILED", "EXPIRED", "ABANDONED"].includes(row.state)) entry.failed += row._count._all;
      statsByCampaign.set(row.campaignId, entry);
    }

    return {
      items: items.map((campaign) => {
        const stats = statsByCampaign.get(campaign.id) ?? { started: 0, completed: 0, failed: 0 };
        return {
          ...campaign,
          analytics: {
            ...stats,
            completionRate: stats.started === 0 ? null : Math.round((stats.completed / stats.started) * 100),
            budgetRemaining: campaign.budgetCredits > 0 ? campaign.budgetCredits - campaign.spentCredits : null,
            /** How many more supports the remaining escrow can pay for. */
            supportsRemaining:
              campaign.budgetCredits > 0
                ? estimateSupports(campaign.budgetCredits - campaign.spentCredits)
                : null,
          },
        };
      }),
      total,
      page,
      limit,
    };
  },
  { csrf: false }
);

export const POST = active(
  "campaigns.create",
  async ({ req, user }) => {
    const data = await parseBody(req, campaignCreateSchema);

    // The video must be the creator's own, active, and have known duration —
    // watch verification is meaningless without a real duration from the API.
    const video = await prisma.video.findFirst({
      where: { id: data.videoId, userId: user.id, status: "ACTIVE" },
      select: { id: true, durationSec: true, madeForKids: true },
    });
    if (!video) throw new NotFoundError("این ویدیو در حساب شما پیدا نشد.");
    if (!video.durationSec) {
      throw new BusinessRuleError("مدت‌زمان این ویدیو از یوتیوب دریافت نشده است؛ ابتدا اطلاعات ویدیو را همگام‌سازی کنید.");
    }

    // Creating the campaign and paying for its budget happen together: a campaign
    // must never exist with a budget nobody was charged for, and credits must
    // never be taken without a campaign to show for it.
    const campaign = await prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          creatorId: user.id,
          videoId: video.id,
          title: data.title,
          description: data.description ?? null,
          startAt: data.startAt,
          endAt: data.endAt,
          status: "ACTIVE",
          // Platform constant, not client input: every campaign requires the same
          // share of the video, and requiredSec is derived server-side per session.
          requiredWatchPercent: WATCH_RULES.defaultRequiredPercent,
          // Fixed platform transfer, not client input: every campaign pays the
          // same amount per support and is charged that same amount.
          rewardCredits: SUPPORT_TRANSFER_CREDITS,
          rewardXp: data.rewardXp,
          budgetCredits: data.budgetCredits,
          maxTotalSupports: data.maxTotalSupports ?? null,
          maxSupportsPerUser: data.maxSupportsPerUser ?? null,
          dailyLimit: data.dailyLimit ?? null,
          minAccountAgeHours: data.minAccountAgeHours,
          // Declared by the creator, and forced on when YouTube itself reports the
          // video as kids content: there the like is provably unverifiable, so
          // running without the waiver would keep failing honest supporters no
          // matter what the creator ticked.
          kidsContent: data.kidsContent || video.madeForKids === true,
          tasks: {
            create: data.tasks.map((task, index) => ({
              type: task.type,
              required: task.required,
              sortOrder: index,
              // Per-task CREDIT rewards are always zero — the whole credit leg is
              // the campaign transfer, so a task-level credit would be paid out of
              // nothing. Only an optional task may add an XP bonus. The validator
              // already rejects a paid required task; this is the belt to that braces.
              rewardCredits: 0,
              rewardXp: task.required ? 0 : task.rewardXp,
            })),
          },
        },
        include: { tasks: true },
      });

      // The budget is funded from the creator's own credits — this is the sink
      // that makes credits worth earning. Throws (rolling back the campaign) when
      // the balance is insufficient.
      await debitBudget(tx, {
        creatorId: user.id,
        campaignId: created.id,
        amount: data.budgetCredits,
        note: "campaign budget funded at creation",
        // The campaign id is freshly generated, so this key is unique per campaign.
        idempotencyKey: ledgerKey(["campaign-budget-initial", created.id]),
      });

      return created;
    });

    await prisma.activity.create({
      data: { userId: user.id, actorId: user.id, type: "CAMPAIGN_CREATED", targetId: campaign.id },
    });
    await writeAudit({ userId: user.id, action: "CREATE", entity: "Campaign", entityId: campaign.id, req });

    return { campaign };
  },
  { rateLimit: "campaignWrite" }
);

export const PATCH = active(
  "campaigns.update",
  async ({ req, user }) => {
    const data = await parseBody(req, campaignUpdateSchema);

    const campaign = await prisma.campaign.findFirst({
      where: { id: data.campaignId, creatorId: user.id },
      select: { id: true, status: true, startAt: true, endAt: true, spentCredits: true, budgetCredits: true },
    });
    if (!campaign) throw new NotFoundError("این کمپین پیدا نشد.");

    const now = new Date();
    if (data.action === "ACTIVATE") {
      if (campaign.status === "ENDED") throw new BusinessRuleError("کمپین پایان‌یافته قابل فعال‌سازی دوباره نیست.");
      if (campaign.endAt <= now) throw new BusinessRuleError("زمان این کمپین گذشته است؛ ابتدا تاریخ پایان را ویرایش کنید.");
      if (campaign.budgetCredits <= campaign.spentCredits) throw new BusinessRuleError("بودجه باقی‌مانده‌ای برای فعال‌سازی کمپین وجود ندارد.");
    }
    if (data.action === "PAUSE" && campaign.status !== "ACTIVE") {
      throw new BusinessRuleError("فقط کمپین فعال را می‌توان متوقف کرد.");
    }
    if (data.action === "EDIT" && campaign.status === "ENDED") {
      throw new BusinessRuleError("کمپین پایان‌یافته قابل ویرایش نیست.");
    }
    if (data.action === "EDIT" && data.endAt !== undefined && data.endAt <= now) {
      throw new BusinessRuleError("تاریخ پایان جدید باید در آینده باشد.");
    }

    // Ending refunds the unspent budget, so it runs through its own atomic path
    // rather than being folded into a generic status patch.
    if (data.action === "END") {
      const { refunded } = await endCampaignWithRefund({ campaignId: campaign.id, creatorId: user.id });
      await writeAudit({
        userId: user.id,
        action: "UPDATE",
        entity: "Campaign",
        entityId: campaign.id,
        req,
        metadata: { action: "END", refunded },
      });
      const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      return { campaign: updated, refunded };
    }

    const patch: Record<string, unknown> = {};
    if (data.action === "ACTIVATE") patch.status = "ACTIVE";
    if (data.action === "PAUSE") patch.status = "PAUSED";
    if (data.action === "EDIT") {
      if (data.title !== undefined) patch.title = data.title;
      if (data.description !== undefined) patch.description = data.description;
      if (data.endAt !== undefined) patch.endAt = data.endAt;
      if (data.dailyLimit !== undefined) patch.dailyLimit = data.dailyLimit;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<Array<{ budgetCredits: number; spentCredits: number; status: string }>>`
        SELECT "budgetCredits", "spentCredits", "status"
        FROM public."Campaign"
        WHERE "id" = ${campaign.id} AND "creatorId" = ${user.id}
        FOR UPDATE
      `;
      const locked = lockedRows[0];
      if (!locked) throw new NotFoundError("این کمپین پیدا نشد.");
      if (locked.status === "ENDED") throw new BusinessRuleError("کمپین پایان‌یافته قابل تغییر نیست.");

      if (data.action === "EDIT" && data.budgetCredits !== undefined) {
        // Budget can be raised (escrowing only the delta) or lowered, but never
        // below what is already spent — the remaining budget would read negative.
        if (data.budgetCredits < locked.spentCredits) {
          throw new BusinessRuleError("بودجه جدید نمی‌تواند کمتر از مقدار مصرف‌شده باشد.");
        }
        const delta = data.budgetCredits - locked.budgetCredits;

        // Both idempotency keys below identify the TRANSITION (from → to), not the
        // delta size. A key built from the delta alone repeats — 100→150, 150→100,
        // 100→150 yields the same "50" twice — and the ledger would treat the
        // second charge as an applied replay, raising the budget without taking
        // the credits. Since the row is held FOR UPDATE and the transition is read
        // from the locked row, the same transition cannot interleave with itself.
        if (delta > 0) {
          await debitBudget(tx, {
            creatorId: user.id,
            campaignId: campaign.id,
            amount: delta,
            note: "campaign budget increased",
            idempotencyKey: ledgerKey([
              "campaign-budget-increase",
              campaign.id,
              locked.budgetCredits,
              data.budgetCredits,
            ]),
          });
        } else if (delta < 0) {
          // Lowering returns the difference from escrow: the creator reserved
          // credits for exposure they are choosing not to use.
          const refund = await recordCredit(tx, {
            userId: user.id,
            type: "CAMPAIGN_BUDGET_SPEND",
            amount: -delta,
            idempotencyKey: ledgerKey([
              "campaign-budget-decrease",
              campaign.id,
              locked.budgetCredits,
              data.budgetCredits,
            ]),
            campaignId: campaign.id,
            reason: "campaign budget decreased",
          });
          // Mirror image of the debit guard: if the refund did not actually apply,
          // lowering the budget anyway would silently destroy the difference.
          if (!refund.applied) {
            throw new BusinessRuleError(
              "این تغییر بودجه قبلاً ثبت شده است. صفحه را تازه کنید و در صورت نیاز دوباره تلاش کنید.",
              { rule: "BUDGET_REFUND_REPLAYED" }
            );
          }
        }
        patch.budgetCredits = data.budgetCredits;
      }

      return tx.campaign.update({ where: { id: campaign.id }, data: patch });
    });

    await writeAudit({ userId: user.id, action: "UPDATE", entity: "Campaign", entityId: campaign.id, req, metadata: { action: data.action } });

    return { campaign: updated };
  },
  { rateLimit: "campaignWrite" }
);
