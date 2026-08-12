import type { Role, UserStatus } from "@prisma/client";
import { ForbiddenError } from "./errors";

/**
 * Authorization matrix — the single server-side source of truth for "who may do
 * what". Hiding a button in the UI is not authorization; every mutation route
 * calls into this module.
 */

export const PERMISSIONS = [
  // Content & own account
  "content:publish",
  "campaign:create",
  "campaign:manage_own",
  "support:create",
  "report:create",
  // Moderation scope
  "report:review",
  "support:reverse",
  "user:warn",
  "user:suspend",
  "content:hide",
  "abuse:review",
  // Admin scope
  "user:list",
  "user:ban",
  "user:adjust_ledger",
  "campaign:manage_any",
  "notification:broadcast",
  "settings:read",
  // Super-admin scope
  "user:change_role",
  "settings:write",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const USER_PERMISSIONS: Permission[] = [
  "content:publish",
  "campaign:create",
  "campaign:manage_own",
  "support:create",
  "report:create",
];

const MODERATOR_PERMISSIONS: Permission[] = [
  ...USER_PERMISSIONS,
  "report:review",
  "support:reverse",
  "user:warn",
  "user:suspend",
  "content:hide",
  "abuse:review",
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...MODERATOR_PERMISSIONS,
  "user:list",
  "user:ban",
  "user:adjust_ledger",
  "campaign:manage_any",
  "notification:broadcast",
  "settings:read",
  "audit:read",
];

const SUPER_ADMIN_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  "user:change_role",
  "settings:write",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  USER: USER_PERMISSIONS,
  MODERATOR: MODERATOR_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  SUPER_ADMIN: SUPER_ADMIN_PERMISSIONS,
};

/** Privilege ordering, used for "can this actor act on that target" checks. */
export const ROLE_RANK: Record<Role, number> = {
  USER: 0,
  MODERATOR: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

export type Actor = { id: string; role: Role; status: UserStatus };

export function can(actor: Pick<Actor, "role">, permission: Permission): boolean {
  return ROLE_PERMISSIONS[actor.role].includes(permission);
}

export function assertCan(actor: Pick<Actor, "role">, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new ForbiddenError("برای انجام این عملیات دسترسی لازم را ندارید.", { permission });
  }
}

/**
 * Privilege-escalation guard for actions targeting another account.
 *
 * Rules:
 *  - Nobody may moderate themselves (an admin can't ban/demote their own account
 *    and lock the platform out, and can't suspend themselves to dodge review).
 *  - You may only act on accounts of strictly LOWER privilege than your own, so
 *    an ADMIN cannot ban or demote a SUPER_ADMIN, and two ADMINs cannot fight.
 */
export function assertCanActOnUser(actor: Actor, target: { id: string; role: Role }): void {
  if (actor.id === target.id) {
    throw new ForbiddenError("امکان اعمال این تغییر روی حساب خودتان وجود ندارد.");
  }
  if (ROLE_RANK[actor.role] <= ROLE_RANK[target.role]) {
    throw new ForbiddenError("امکان اعمال تغییر روی کاربری با سطح دسترسی برابر یا بالاتر وجود ندارد.");
  }
}

/**
 * Role assignment guard. Only SUPER_ADMIN may change roles at all, and even then
 * not to a level at or above their own — which keeps "create a second
 * SUPER_ADMIN and get demoted by them" out of reach and preserves a single
 * accountable owner.
 */
export function assertCanAssignRole(actor: Actor, target: { id: string; role: Role }, nextRole: Role): void {
  assertCan(actor, "user:change_role");
  assertCanActOnUser(actor, target);
  if (ROLE_RANK[nextRole] >= ROLE_RANK[actor.role]) {
    throw new ForbiddenError("نمی‌توانید سطح دسترسی برابر یا بالاتر از خودتان اعطا کنید.");
  }
}

/** Status transitions a moderator may perform vs. those reserved for admins. */
export function assertCanSetStatus(actor: Actor, target: { id: string; role: Role }, nextStatus: UserStatus): void {
  assertCanActOnUser(actor, target);
  if (nextStatus === "BANNED") assertCan(actor, "user:ban");
  else assertCan(actor, "user:suspend");
}

export function isStaff(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.MODERATOR;
}
