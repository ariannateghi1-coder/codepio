import { prisma } from "@/lib/prisma";
import { parseQuery } from "@/lib/api";
import { admin } from "@/lib/handler";
import { assertCan } from "@/lib/authz";
import { z } from "zod";

/**
 * Audit log viewer. Read-only, admin-scoped, paginated.
 *
 * The stored rows contain hashed IPs and structured metadata only — never
 * passwords, tokens or raw addresses — so exposing them here is safe.
 */
const querySchema = z.object({
  action: z.string().trim().max(40).optional(),
  entity: z.string().trim().max(40).optional(),
  userId: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const GET = admin(
  "admin.audit",
  async ({ url, actor }) => {
    assertCan(actor, "audit:read");
    const query = parseQuery(url, querySchema);

    const where = {
      ...(query.action ? { action: query.action as never } : {}),
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          metadata: true,
          createdAt: true,
          user: { select: { username: true, name: true, role: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return { items, total, page: query.page, limit: query.limit };
  },
  { csrf: false }
);
