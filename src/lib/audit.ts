import "server-only";
import type { AuditAction, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { getClientIp, hashIp } from "./http";

/**
 * Audit log.
 *
 * Every security- or money-relevant action is recorded: who, what, on which
 * entity, from which (hashed) network, and with structured metadata.
 *
 * Never stored: passwords, session tokens, CSRF tokens, OAuth
 * tokens, raw IPs. The metadata argument is typed as JSON, and callers pass
 * identifiers and outcomes rather than payloads.
 */

export type AuditInput = {
  userId?: string | null;
  action: AuditAction;
  entity?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  req?: Request;
};

export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        ipHash: input.req ? hashIp(getClientIp(input.req)) : null,
        userAgent: input.req?.headers.get("user-agent")?.slice(0, 300) ?? null,
        metadata: input.metadata,
      },
    });
  } catch (e) {
    // An audit failure must not break the user's operation, but it must be
    // loud in the logs — a silently missing audit trail is a security problem.
    logger.error("failed to write audit log", { action: input.action, entity: input.entity, error: e });
  }
}

/** Transaction-scoped variant, so the audit row commits with the change it describes. */
export async function writeAuditTx(
  tx: Prisma.TransactionClient,
  input: Omit<AuditInput, "req"> & { ipHash?: string | null; userAgent?: string | null }
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: input.userId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      ipHash: input.ipHash ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      metadata: input.metadata,
    },
  });
}
