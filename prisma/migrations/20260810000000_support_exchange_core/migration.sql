-- Academy Support — Support Exchange core schema.
--
-- Replaces the previous initial migration: the data model was restructured around
-- the verified support loop (sessions, tasks, watch accounting with explicit
-- heartbeat sequencing) and the four separate economies (credits, XP, reputation,
-- trust), so a patch migration on the old shape was not meaningful.
--
-- Generated with: prisma migrate diff --from-empty --to-schema-datamodel

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED', 'BANNED');

-- CreateEnum
CREATE TYPE "RankTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'ELITE');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'REMOVED');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('WATCH_VIDEO', 'SUBSCRIBE_CHANNEL', 'LIKE_VIDEO', 'COMMENT_VIDEO');

-- CreateEnum
CREATE TYPE "SupportSessionState" AS ENUM ('STARTED', 'VIDEO_OPENED', 'WATCHING', 'WATCH_THRESHOLD_REACHED', 'VERIFYING', 'COMPLETED', 'FAILED', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "SupportTaskState" AS ENUM ('PENDING', 'IN_PROGRESS', 'SATISFIED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('YOUTUBE_API', 'PLATFORM_OBSERVED', 'SELF_REPORTED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "VerificationResult" AS ENUM ('PASSED', 'FAILED', 'INCONCLUSIVE', 'PENDING');

-- CreateEnum
CREATE TYPE "RewardState" AS ENUM ('NONE', 'PENDING_REVIEW', 'CONFIRMED', 'DENIED', 'REVERSED');

-- CreateEnum
CREATE TYPE "CreditEntryType" AS ENUM ('SUPPORT_COMPLETED', 'SUPPORT_RECEIVED', 'MUTUAL_BONUS', 'CAMPAIGN_BONUS', 'REFERRAL', 'BADGE_REWARD', 'ADMIN_ADJUSTMENT', 'CAMPAIGN_BUDGET_SPEND', 'REVERSAL', 'PENALTY');

-- CreateEnum
CREATE TYPE "XpEntryType" AS ENUM ('SUPPORT_COMPLETED', 'SUPPORT_RECEIVED', 'MUTUAL_BONUS', 'STREAK', 'BADGE_REWARD', 'REFERRAL', 'ADMIN_ADJUSTMENT', 'REVERSAL', 'PENALTY');

-- CreateEnum
CREATE TYPE "ReputationEventType" AS ENUM ('SUPPORT_VERIFIED', 'SUPPORT_PARTIAL', 'SUPPORT_REVERSED', 'ABUSE_SIGNAL', 'REPORT_UPHELD', 'REPORT_DISMISSED', 'CAMPAIGN_COMPLETED', 'ACCOUNT_AGE', 'CHANNEL_VERIFIED', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AbuseSignalType" AS ENUM ('IMPOSSIBLE_WATCH_SPEED', 'SEEK_JUMP_ABUSE', 'HEARTBEAT_ANOMALY', 'HEARTBEAT_REPLAY', 'BACKGROUND_WATCH', 'SUPPORT_VELOCITY', 'RECIPROCAL_LOOP', 'FARMING_RING', 'PAIR_FARMING', 'SELF_SUPPORT_ATTEMPT', 'REFERRAL_ABUSE', 'DUPLICATE_DEVICE', 'SUBSCRIPTION_CHURN', 'CLIENT_TAMPERING');

-- CreateEnum
CREATE TYPE "YoutubeConnectionState" AS ENUM ('CONNECTED', 'EXPIRED', 'REAUTH_REQUIRED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "LeaderboardPeriod" AS ENUM ('WEEKLY', 'MONTHLY', 'ALL_TIME');

-- CreateEnum
CREATE TYPE "LeaderboardMode" AS ENUM ('TOP_SUPPORTERS', 'TOP_CREATORS', 'HIGHEST_REPUTATION', 'RISING');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SUPPORT_RECEIVED', 'SUPPORT_BACK_AVAILABLE', 'SUPPORT_MUTUAL', 'SUPPORT_VERIFIED', 'SUPPORT_REVERSED', 'REWARD_PENDING', 'NEW_VIDEO', 'CAMPAIGN_UPDATE', 'ANNOUNCEMENT', 'MENTION', 'SECURITY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('SUPPORT_CREATED', 'SUPPORT_RECEIVED', 'MUTUAL_SUPPORT', 'SUPPORT_REVERSED', 'VIDEO_ADDED', 'CAMPAIGN_CREATED', 'BADGE_EARNED', 'LEVEL_UP', 'RANK_UP', 'CAMPAIGN_JOINED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('USER', 'VIDEO', 'SUPPORT', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'SUPPORT', 'SUPPORT_REVERSAL', 'NOTIFICATION', 'ADMIN_ACTION', 'SECURITY', 'LEDGER_ADJUSTMENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "country" TEXT,
    "language" TEXT NOT NULL DEFAULT 'fa',
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "youtubeVerified" BOOLEAN NOT NULL DEFAULT false,
    "points" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "reputation" INTEGER NOT NULL DEFAULT 100,
    "trustScore" INTEGER NOT NULL DEFAULT 50,
    "rankTier" "RankTier" NOT NULL DEFAULT 'BRONZE',
    "supportsCompleted" INTEGER NOT NULL DEFAULT 0,
    "supportsAbandoned" INTEGER NOT NULL DEFAULT 0,
    "currentStreakDays" INTEGER NOT NULL DEFAULT 0,
    "longestStreakDays" INTEGER NOT NULL DEFAULT 0,
    "lastStreakDay" TIMESTAMP(3),
    "referralCode" TEXT NOT NULL,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YoutubeConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelTitle" TEXT NOT NULL,
    "channelUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "subscriberCount" INTEGER,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verificationMethod" "VerificationMethod" NOT NULL DEFAULT 'SELF_REPORTED',
    "verifiedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YoutubeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YoutubeAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "channelId" TEXT,
    "scope" TEXT NOT NULL,
    "accessTokenCipher" TEXT NOT NULL,
    "refreshTokenCipher" TEXT,
    "accessTokenExpires" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "state" "YoutubeConnectionState" NOT NULL DEFAULT 'CONNECTED',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YoutubeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "youtubeVideoId" TEXT NOT NULL,
    "youtubeUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "durationSec" INTEGER,
    "metadataSyncedAt" TIMESTAMP(3),
    "status" "VideoStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT,
    "videoId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "rewardCredits" INTEGER NOT NULL DEFAULT 10,
    "rewardXp" INTEGER NOT NULL DEFAULT 25,
    "budgetCredits" INTEGER NOT NULL DEFAULT 0,
    "spentCredits" INTEGER NOT NULL DEFAULT 0,
    "maxTotalSupports" INTEGER,
    "maxSupportsPerUser" INTEGER,
    "dailyLimit" INTEGER,
    "minAccountAgeHours" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "requiredWatchPercent" INTEGER NOT NULL DEFAULT 90,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTask" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "rewardCredits" INTEGER NOT NULL DEFAULT 0,
    "rewardXp" INTEGER NOT NULL DEFAULT 0,
    "timeoutSec" INTEGER NOT NULL DEFAULT 3600,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CampaignTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "supporterId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "videoId" TEXT,
    "state" "SupportSessionState" NOT NULL DEFAULT 'STARTED',
    "rewardState" "RewardState" NOT NULL DEFAULT 'NONE',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskReasons" JSONB,
    "clientNonce" TEXT,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "supportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTask" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "campaignTaskId" TEXT,
    "type" "TaskType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "state" "SupportTaskState" NOT NULL DEFAULT 'PENDING',
    "method" "VerificationMethod" NOT NULL DEFAULT 'UNVERIFIED',
    "satisfiedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "videoId" TEXT,
    "durationSec" INTEGER NOT NULL,
    "requiredSec" INTEGER NOT NULL,
    "accumulatedSec" INTEGER NOT NULL DEFAULT 0,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "playerState" TEXT NOT NULL DEFAULT 'IDLE',
    "heartbeats" INTEGER NOT NULL DEFAULT 0,
    "maxRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "seekCount" INTEGER NOT NULL DEFAULT 0,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "lastPosition" INTEGER NOT NULL DEFAULT 0,
    "rejectedBeats" INTEGER NOT NULL DEFAULT 0,
    "hiddenSec" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WatchSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportVerification" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "taskType" "TaskType" NOT NULL,
    "method" "VerificationMethod" NOT NULL,
    "result" "VerificationResult" NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CreditEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "sessionId" TEXT,
    "campaignId" TEXT,
    "supportId" TEXT,
    "reversalOfId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XpLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "XpEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "sessionId" TEXT,
    "supportId" TEXT,
    "reversalOfId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReputationEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ReputationEventType" NOT NULL,
    "delta" INTEGER NOT NULL,
    "valueAfter" INTEGER NOT NULL,
    "sessionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReputationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbuseSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "type" "AbuseSignalType" NOT NULL,
    "severity" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbuseSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportPair" (
    "supporterId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "supportCount" INTEGER NOT NULL DEFAULT 0,
    "reciprocalCount" INTEGER NOT NULL DEFAULT 0,
    "lastSupportAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportPair_pkey" PRIMARY KEY ("supporterId","receiverId")
);

-- CreateTable
CREATE TABLE "Support" (
    "id" TEXT NOT NULL,
    "supporterId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "videoId" TEXT,
    "status" "SupportStatus" NOT NULL DEFAULT 'ACTIVE',
    "creditsAwarded" INTEGER NOT NULL DEFAULT 0,
    "xpAwarded" INTEGER NOT NULL DEFAULT 0,
    "mutual" BOOLEAN NOT NULL DEFAULT false,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Support_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardSnapshot" (
    "id" TEXT NOT NULL,
    "period" "LeaderboardPeriod" NOT NULL,
    "mode" "LeaderboardMode" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "supports" INTEGER NOT NULL DEFAULT 0,
    "reputation" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "requirements" JSONB NOT NULL,
    "rewardCredits" INTEGER NOT NULL DEFAULT 0,
    "rewardXp" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("userId","badgeId")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" "ActivityType" NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ipHash" TEXT,
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "severity" INTEGER NOT NULL DEFAULT 1,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_points_idx" ON "User"("points" DESC);

-- CreateIndex
CREATE INDEX "User_credits_idx" ON "User"("credits" DESC);

-- CreateIndex
CREATE INDEX "User_reputation_idx" ON "User"("reputation" DESC);

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_status_createdAt_idx" ON "User"("status", "createdAt");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_email_idx" ON "PasswordResetToken"("email");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_expiresAt_idx" ON "EmailVerificationToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "YoutubeConnection_userId_key" ON "YoutubeConnection"("userId");

-- CreateIndex
CREATE INDEX "YoutubeConnection_channelId_idx" ON "YoutubeConnection"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "YoutubeAccount_userId_key" ON "YoutubeAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "YoutubeAccount_googleSub_key" ON "YoutubeAccount"("googleSub");

-- CreateIndex
CREATE INDEX "YoutubeAccount_state_idx" ON "YoutubeAccount"("state");

-- CreateIndex
CREATE INDEX "Video_youtubeVideoId_idx" ON "Video"("youtubeVideoId");

-- CreateIndex
CREATE INDEX "Video_userId_status_idx" ON "Video"("userId", "status");

-- CreateIndex
CREATE INDEX "Video_status_createdAt_idx" ON "Video"("status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Video_userId_youtubeVideoId_key" ON "Video"("userId", "youtubeVideoId");

-- CreateIndex
CREATE INDEX "Campaign_status_startAt_endAt_idx" ON "Campaign"("status", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "Campaign_creatorId_status_idx" ON "Campaign"("creatorId", "status");

-- CreateIndex
CREATE INDEX "Campaign_status_priority_createdAt_idx" ON "Campaign"("status", "priority" DESC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignTask_campaignId_sortOrder_idx" ON "CampaignTask"("campaignId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTask_campaignId_type_key" ON "CampaignTask"("campaignId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSession_supportId_key" ON "SupportSession"("supportId");

-- CreateIndex
CREATE INDEX "SupportSession_supporterId_state_idx" ON "SupportSession"("supporterId", "state");

-- CreateIndex
CREATE INDEX "SupportSession_campaignId_state_idx" ON "SupportSession"("campaignId", "state");

-- CreateIndex
CREATE INDEX "SupportSession_creatorId_createdAt_idx" ON "SupportSession"("creatorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SupportSession_state_expiresAt_idx" ON "SupportSession"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "SupportTask_sessionId_state_idx" ON "SupportTask"("sessionId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTask_sessionId_type_key" ON "SupportTask"("sessionId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "WatchSession_sessionId_key" ON "WatchSession"("sessionId");

-- CreateIndex
CREATE INDEX "WatchSession_lastHeartbeatAt_idx" ON "WatchSession"("lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "SupportVerification_sessionId_taskType_idx" ON "SupportVerification"("sessionId", "taskType");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_reversalOfId_key" ON "CreditLedger"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CreditLedger_userId_type_createdAt_idx" ON "CreditLedger"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_createdAt_idx" ON "CreditLedger"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "XpLedger_reversalOfId_key" ON "XpLedger"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "XpLedger_idempotencyKey_key" ON "XpLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "XpLedger_userId_createdAt_idx" ON "XpLedger"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "XpLedger_createdAt_idx" ON "XpLedger"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReputationEvent_idempotencyKey_key" ON "ReputationEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReputationEvent_userId_createdAt_idx" ON "ReputationEvent"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AbuseSignal_userId_createdAt_idx" ON "AbuseSignal"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AbuseSignal_type_createdAt_idx" ON "AbuseSignal"("type", "createdAt");

-- CreateIndex
CREATE INDEX "SupportPair_receiverId_idx" ON "SupportPair"("receiverId");

-- CreateIndex
CREATE INDEX "SupportPair_lastSupportAt_idx" ON "SupportPair"("lastSupportAt");

-- CreateIndex
CREATE INDEX "Support_receiverId_status_createdAt_idx" ON "Support"("receiverId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Support_supporterId_status_createdAt_idx" ON "Support"("supporterId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Support_campaignId_status_idx" ON "Support"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Support_status_createdAt_idx" ON "Support"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Support_supporterId_receiverId_campaignId_key" ON "Support"("supporterId", "receiverId", "campaignId");

-- CreateIndex
CREATE INDEX "LeaderboardSnapshot_period_mode_periodStart_rank_idx" ON "LeaderboardSnapshot"("period", "mode", "periodStart", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardSnapshot_period_mode_periodStart_userId_key" ON "LeaderboardSnapshot"("period", "mode", "periodStart", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_code_key" ON "Badge"("code");

-- CreateIndex
CREATE INDEX "UserBadge_userId_earnedAt_idx" ON "UserBadge"("userId", "earnedAt");

-- CreateIndex
CREATE INDEX "Activity_userId_createdAt_idx" ON "Activity"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Activity_userId_type_createdAt_idx" ON "Activity"("userId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referredId_key" ON "Referral"("referredId");

-- CreateIndex
CREATE INDEX "Referral_code_idx" ON "Referral"("code");

-- CreateIndex
CREATE INDEX "Referral_referrerId_idx" ON "Referral"("referrerId");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterId_targetType_targetId_status_key" ON "Report"("reporterId", "targetType", "targetId", "status");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "RateLimit_expiresAt_idx" ON "RateLimit"("expiresAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YoutubeConnection" ADD CONSTRAINT "YoutubeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YoutubeAccount" ADD CONSTRAINT "YoutubeAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTask" ADD CONSTRAINT "CampaignTask_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_supporterId_fkey" FOREIGN KEY ("supporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTask" ADD CONSTRAINT "SupportTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTask" ADD CONSTRAINT "SupportTask_campaignTaskId_fkey" FOREIGN KEY ("campaignTaskId") REFERENCES "CampaignTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchSession" ADD CONSTRAINT "WatchSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportVerification" ADD CONSTRAINT "SupportVerification_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "CreditLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XpLedger" ADD CONSTRAINT "XpLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XpLedger" ADD CONSTRAINT "XpLedger_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XpLedger" ADD CONSTRAINT "XpLedger_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "XpLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReputationEvent" ADD CONSTRAINT "ReputationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseSignal" ADD CONSTRAINT "AbuseSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseSignal" ADD CONSTRAINT "AbuseSignal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportPair" ADD CONSTRAINT "SupportPair_supporterId_fkey" FOREIGN KEY ("supporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportPair" ADD CONSTRAINT "SupportPair_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Support" ADD CONSTRAINT "Support_supporterId_fkey" FOREIGN KEY ("supporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Support" ADD CONSTRAINT "Support_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Support" ADD CONSTRAINT "Support_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Support" ADD CONSTRAINT "Support_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardSnapshot" ADD CONSTRAINT "LeaderboardSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

