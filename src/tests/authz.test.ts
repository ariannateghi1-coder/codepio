import { describe, expect, it } from "vitest";
import {
  ROLE_PERMISSIONS,
  assertCan,
  assertCanActOnUser,
  assertCanAssignRole,
  assertCanSetStatus,
  can,
  isStaff,
  type Actor,
} from "@/lib/authz";
import { ForbiddenError } from "@/lib/errors";

/**
 * The authorization matrix is the real boundary; hiding a button is not.
 * These tests pin the privilege-escalation rules explicitly.
 */

const user: Actor = { id: "u1", role: "USER", status: "ACTIVE" };
const moderator: Actor = { id: "m1", role: "MODERATOR", status: "ACTIVE" };
const admin: Actor = { id: "a1", role: "ADMIN", status: "ACTIVE" };
const superAdmin: Actor = { id: "s1", role: "SUPER_ADMIN", status: "ACTIVE" };

describe("permission matrix", () => {
  it("gives a plain user only participation permissions", () => {
    expect(can(user, "support:create")).toBe(true);
    expect(can(user, "campaign:create")).toBe(true);
    expect(can(user, "user:list")).toBe(false);
    expect(can(user, "support:reverse")).toBe(false);
    expect(can(user, "user:change_role")).toBe(false);
  });

  it("gives a moderator moderation but not administration", () => {
    expect(can(moderator, "support:reverse")).toBe(true);
    expect(can(moderator, "report:review")).toBe(true);
    expect(can(moderator, "user:ban")).toBe(false);
    expect(can(moderator, "user:adjust_ledger")).toBe(false);
  });

  it("reserves role changes and settings writes for the super admin", () => {
    expect(can(admin, "user:change_role")).toBe(false);
    expect(can(admin, "settings:write")).toBe(false);
    expect(can(superAdmin, "user:change_role")).toBe(true);
    expect(can(superAdmin, "settings:write")).toBe(true);
  });

  it("keeps each role a superset of the one below it", () => {
    for (const permission of ROLE_PERMISSIONS.USER) {
      expect(ROLE_PERMISSIONS.MODERATOR).toContain(permission);
    }
    for (const permission of ROLE_PERMISSIONS.MODERATOR) {
      expect(ROLE_PERMISSIONS.ADMIN).toContain(permission);
    }
    for (const permission of ROLE_PERMISSIONS.ADMIN) {
      expect(ROLE_PERMISSIONS.SUPER_ADMIN).toContain(permission);
    }
  });

  it("throws ForbiddenError rather than returning false in assertCan", () => {
    expect(() => assertCan(user, "user:ban")).toThrow(ForbiddenError);
    expect(() => assertCan(admin, "user:ban")).not.toThrow();
  });
});

describe("assertCanActOnUser", () => {
  it("blocks acting on your own account", () => {
    expect(() => assertCanActOnUser(admin, { id: admin.id, role: "ADMIN" })).toThrow(ForbiddenError);
  });

  it("blocks acting on an equal privilege level", () => {
    expect(() => assertCanActOnUser(admin, { id: "a2", role: "ADMIN" })).toThrow(ForbiddenError);
  });

  it("blocks acting on a higher privilege level", () => {
    expect(() => assertCanActOnUser(admin, { id: "s1", role: "SUPER_ADMIN" })).toThrow(ForbiddenError);
    expect(() => assertCanActOnUser(moderator, { id: "a1", role: "ADMIN" })).toThrow(ForbiddenError);
  });

  it("allows acting strictly downward", () => {
    expect(() => assertCanActOnUser(admin, { id: "u1", role: "USER" })).not.toThrow();
    expect(() => assertCanActOnUser(superAdmin, { id: "a1", role: "ADMIN" })).not.toThrow();
  });
});

describe("assertCanAssignRole", () => {
  it("refuses any role change from an admin", () => {
    expect(() => assertCanAssignRole(admin, { id: "u1", role: "USER" }, "MODERATOR")).toThrow(ForbiddenError);
  });

  it("refuses granting a level at or above the actor's own", () => {
    expect(() => assertCanAssignRole(superAdmin, { id: "u1", role: "USER" }, "SUPER_ADMIN")).toThrow(ForbiddenError);
  });

  it("allows a super admin to grant a lower level", () => {
    expect(() => assertCanAssignRole(superAdmin, { id: "u1", role: "USER" }, "ADMIN")).not.toThrow();
    expect(() => assertCanAssignRole(superAdmin, { id: "u1", role: "USER" }, "MODERATOR")).not.toThrow();
  });

  it("still refuses self-modification", () => {
    expect(() => assertCanAssignRole(superAdmin, { id: superAdmin.id, role: "SUPER_ADMIN" }, "USER")).toThrow(ForbiddenError);
  });
});

describe("assertCanSetStatus", () => {
  it("lets a moderator suspend but not ban", () => {
    expect(() => assertCanSetStatus(moderator, { id: "u1", role: "USER" }, "SUSPENDED")).not.toThrow();
    expect(() => assertCanSetStatus(moderator, { id: "u1", role: "USER" }, "BANNED")).toThrow(ForbiddenError);
  });

  it("lets an admin ban", () => {
    expect(() => assertCanSetStatus(admin, { id: "u1", role: "USER" }, "BANNED")).not.toThrow();
  });

  it("blocks self-suspension", () => {
    expect(() => assertCanSetStatus(admin, { id: admin.id, role: "ADMIN" }, "SUSPENDED")).toThrow(ForbiddenError);
  });
});

describe("isStaff", () => {
  it("counts moderator and above as staff", () => {
    expect(isStaff("USER")).toBe(false);
    expect(isStaff("MODERATOR")).toBe(true);
    expect(isStaff("ADMIN")).toBe(true);
    expect(isStaff("SUPER_ADMIN")).toBe(true);
  });
});
