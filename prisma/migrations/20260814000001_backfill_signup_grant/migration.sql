-- Backfills the signup grant for accounts that existed before it was introduced.
--
-- This is a SEPARATE migration from the one adding SIGNUP_GRANT on purpose:
-- PostgreSQL refuses to use a newly added enum value inside the same transaction
-- that added it ("unsafe use of new value of enum type"), and Prisma wraps each
-- migration file in one transaction. Splitting them is what makes both applicable.
--
-- Written as ledger entries rather than a bare UPDATE on User.credits, because the
-- ledger is the source of truth and User.credits is only a cache of it. A direct
-- balance update would make auditUserBalances() report drift forever.
--
-- Idempotent twice over: the INSERT skips users who already hold a SIGNUP_GRANT
-- entry, and CreditLedger.idempotencyKey is UNIQUE, so re-running is a no-op.

-- 1. One grant entry per user that does not already have one.
--    balanceAfter is the post-grant balance, matching what recordCredit() writes.
INSERT INTO "CreditLedger" ("id", "userId", "type", "amount", "balanceAfter", "idempotencyKey", "reason", "createdAt")
SELECT
  -- 25-char cuid-shaped id; only needs to be unique and stable within this insert.
  'c' || substr(md5('signup-grant:' || u."id"), 1, 24),
  u."id",
  'SIGNUP_GRANT'::"CreditEntryType",
  50,
  u."credits" + 50,
  'signup-grant:' || u."id",
  'one-time signup grant (backfill)',
  NOW()
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "CreditLedger" l
  WHERE l."userId" = u."id" AND l."type" = 'SIGNUP_GRANT'::"CreditEntryType"
);

-- 2. Move the cached balance to match the ledger, for exactly the users granted
--    in step 1. Scoped by the entry's creation so a re-run cannot double-credit.
UPDATE "User" u
SET "credits" = u."credits" + 50
WHERE EXISTS (
  SELECT 1 FROM "CreditLedger" l
  WHERE l."userId" = u."id"
    AND l."type" = 'SIGNUP_GRANT'::"CreditEntryType"
    AND l."reason" = 'one-time signup grant (backfill)'
    AND l."balanceAfter" = u."credits" + 50
);
