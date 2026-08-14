/**
 * Production bootstrap seed: badge catalogue + super-admin only.
 *
 * prisma/seed.ts also inserts sample creators, videos and campaigns, which is
 * fine for a dev database but is junk in a live one. This reuses the same
 * definitions so the badge rows stay identical to the app's source of truth.
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword, referralCode } from "../src/lib/security";
import { BADGE_DEFINITIONS, BADGE_REQUIREMENTS, REPUTATION } from "../src/lib/gamification";

const prisma = new PrismaClient();

async function main() {
  for (const definition of BADGE_DEFINITIONS) {
    const requirement = BADGE_REQUIREMENTS[definition.code];
    const payload = {
      name: definition.name,
      description: definition.description,
      icon: definition.icon,
      requirements: requirement,
      rewardCredits: 0,
      rewardXp: definition.xp,
    };
    await prisma.badge.upsert({
      where: { code: definition.code },
      update: payload,
      create: { code: definition.code, ...payload },
    });
  }
  console.log(`badges upserted: ${BADGE_DEFINITIONS.length}`);

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) throw new Error("ADMIN_PASSWORD is required");

  const admin = await prisma.user.upsert({
    where: { email: "admin@codepio.local" },
    update: { role: "SUPER_ADMIN", status: "ACTIVE" },
    create: {
      email: "admin@codepio.local",
      username: "admin",
      name: "مدیر",
      passwordHash: await hashPassword(adminPassword),
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      reputation: REPUTATION.MAX / 2,
      trustScore: 90,
      referralCode: referralCode("admin"),
    },
  });
  console.log(`admin ready: ${admin.email} (${admin.role})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
