-- Add a dedicated account-age signal without rewriting enum history.
ALTER TYPE "AbuseSignalType" ADD VALUE IF NOT EXISTS 'ACCOUNT_TOO_NEW';
