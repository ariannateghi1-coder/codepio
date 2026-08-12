"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, Unlink, Youtube } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pill, VerificationBadge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@/lib/cn";

/**
 * YouTube connection settings.
 *
 * This screen is where the product's verification honesty becomes concrete: it
 * states exactly what can and cannot be proven for this account right now.
 *
 *  - Channel ownership: proven only through OAuth (channels.list?mine=true).
 *    A typed channel URL is never treated as proof.
 *  - Subscribe / Like: verifiable through the official API while the grant exists.
 *  - Watch: tracked by us, labelled "ثبت‌شده توسط پلتفرم" — no YouTube API reports
 *    how much of a video a specific user watched, so we never claim otherwise.
 *
 * Scopes are read-only, and the tokens stay server-side, encrypted, never logged.
 */

type ChannelStatus = {
  channel: {
    channelId: string;
    channelTitle: string;
    channelUrl: string;
    thumbnailUrl: string | null;
    subscriberCount: number | null;
    verified: boolean;
    verificationMethod: string;
    verifiedAt: string | null;
  } | null;
  oauth: {
    available: boolean;
    connected: boolean;
    state: "CONNECTED" | "EXPIRED" | "REAUTH_REQUIRED" | "DISCONNECTED" | "ERROR";
    lastErrorCode: string | null;
    scopes: string[];
    lastRefreshedAt: string | null;
  };
  capabilities: {
    subscriptionVerification: boolean;
    likeVerification: boolean;
    watchVerification: string;
    commentVerification: boolean;
  };
};

/**
 * Connection-state copy. Each state names the cause and the one action that fixes
 * it — never a status code, and never a generic "something went wrong".
 */
const STATE_COPY: Record<
  ChannelStatus["oauth"]["state"],
  { tone: "info" | "warning" | "danger"; title: string; body: string; action: "connect" | "reconnect" | null } | null
> = {
  CONNECTED: null,
  EXPIRED: {
    tone: "warning",
    title: "دسترسی یوتیوب منقضی شده است",
    body: "تا زمانی که دوباره متصل نشوید، سابسکرایب و لایک قابل بررسی نیستند و ما آن‌ها را «انجام‌شده» ثبت نمی‌کنیم.",
    action: "reconnect",
  },
  REAUTH_REQUIRED: {
    tone: "warning",
    title: "اتصال باید دوباره برقرار شود",
    body: "دسترسی لغو شده یا دیگر معتبر نیست. فقط خود شما می‌توانید با اتصال دوباره این را درست کنید.",
    action: "reconnect",
  },
  DISCONNECTED: {
    tone: "info",
    title: "حساب یوتیوب متصل نیست",
    body: "با اتصال حساب، مالکیت کانال تأیید می‌شود و سابسکرایب و لایک قابل بررسی خودکار می‌شوند.",
    action: "connect",
  },
  ERROR: {
    tone: "danger",
    title: "ارتباط با یوتیوب موقتاً برقرار نشد",
    body: "این مشکل از طرف یوتیوب است، نه حساب شما. چند دقیقه بعد دوباره تلاش کنید؛ حمایت‌های در جریان ناموفق ثبت نمی‌شوند.",
    action: null,
  },
};

export function YoutubeSettings({ status: initialStatus }: { status?: string }) {
  const toast = useToast();
  const [data, setData] = useState<ChannelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<ChannelStatus>("/api/v1/youtube/channel"));
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Surface the callback outcome once, in the user's language.
  useEffect(() => {
    if (!initialStatus) return;
    const messages: Record<string, { tone: "success" | "error" | "warning"; message: string }> = {
      connected: { tone: "success", message: "کانال یوتیوب شما متصل و مالکیت آن تأیید شد." },
      denied: { tone: "warning", message: "دسترسی داده نشد؛ اتصال کامل نشد." },
      no_channel: { tone: "error", message: "این حساب گوگل کانال یوتیوب ندارد." },
      state_mismatch: { tone: "error", message: "درخواست اتصال معتبر نبود. دوباره تلاش کنید." },
      invalid: { tone: "error", message: "پاسخ دریافتی از گوگل معتبر نبود." },
    };
    const entry = messages[initialStatus];
    if (entry) toast.push(entry);
  }, [initialStatus, toast]);

  async function connect() {
    setBusy(true);
    try {
      const result = await api.post<{ authorizeUrl: string }>("/api/v1/youtube/oauth/start");
      window.location.href = result.authorizeUrl;
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.delete("/api/v1/youtube/channel");
      toast.push({ tone: "success", message: "اتصال قطع شد." });
      await load();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="skeleton h-64 rounded-xl" />;
  if (!data) return null;

  const stateCopy = STATE_COPY[data.oauth.state];

  return (
    <div className="space-y-4">
      {!data.oauth.available && (
        <Alert tone="info">
          اتصال یوتیوب روی این سرور پیکربندی نشده است. بدون آن، تأیید سابسکرایب و لایک ممکن نیست.
        </Alert>
      )}

      {/* Lifecycle state, stated plainly with the one action that resolves it. */}
      {data.oauth.available && stateCopy && (
        <Alert tone={stateCopy.tone} title={stateCopy.title}>
          {stateCopy.body}
          {stateCopy.action && (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              className="mt-2 inline-flex items-center gap-1 font-bold text-accent disabled:opacity-55"
            >
              <Link2 aria-hidden size={14} />
              {stateCopy.action === "reconnect" ? "اتصال دوباره حساب یوتیوب" : "اتصال حساب یوتیوب"}
            </button>
          )}
        </Alert>
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Youtube aria-hidden size={22} className="text-danger" />
            <div>
              <h2 className="text-sm font-bold">{data.channel?.channelTitle ?? "کانالی متصل نیست"}</h2>
              {data.channel?.subscriberCount != null && (
                <p className="numeric mt-0.5 text-xs text-fg-subtle">
                  {formatNumber(data.channel.subscriberCount)} سابسکرایبر
                </p>
              )}
            </div>
          </div>

          {data.channel ? (
            <div className="flex flex-wrap gap-2">
              {!data.oauth.connected && (
                <Button onClick={connect} loading={busy} disabled={!data.oauth.available} icon={<Link2 aria-hidden size={15} />}>
                  اتصال دوباره
                </Button>
              )}
              <Button variant="outline" onClick={disconnect} loading={busy} icon={<Unlink aria-hidden size={15} />}>
                قطع اتصال
              </Button>
            </div>
          ) : (
            <Button onClick={connect} loading={busy} disabled={!data.oauth.available} icon={<Link2 aria-hidden size={15} />}>
              اتصال حساب یوتیوب
            </Button>
          )}
        </div>

        {data.channel && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <VerificationBadge method={data.channel.verificationMethod} />
            {data.channel.verificationMethod === "SELF_REPORTED" && (
              <span className="text-xs text-fg-subtle">وارد کردن آدرس کانال به‌تنهایی اثبات مالکیت نیست.</span>
            )}
          </div>
        )}
      </Card>

      {/* The capability matrix: what the platform can actually prove. */}
      <Card className="p-5">
        <h2 className="text-sm font-bold">چه چیزی قابل تأیید است؟</h2>
        <ul className="mt-3 space-y-3 text-sm">
          <li className="flex flex-wrap items-center gap-2">
            <span className="min-w-28 font-semibold">تماشا</span>
            <VerificationBadge method="PLATFORM_OBSERVED" />
            <span className="text-xs leading-6 text-fg-subtle">
              توسط ما از رویدادهای پلیر محاسبه می‌شود؛ هیچ API یوتیوب این را گزارش نمی‌دهد.
            </span>
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <span className="min-w-28 font-semibold">سابسکرایب</span>
            <VerificationBadge method={data.capabilities.subscriptionVerification ? "YOUTUBE_API" : "UNVERIFIED"} />
            {!data.capabilities.subscriptionVerification && (
              <span className="text-xs text-fg-subtle">برای تأیید، حساب یوتیوب را متصل کنید.</span>
            )}
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <span className="min-w-28 font-semibold">لایک</span>
            <VerificationBadge method={data.capabilities.likeVerification ? "YOUTUBE_API" : "UNVERIFIED"} />
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <span className="min-w-28 font-semibold">کامنت</span>
            <VerificationBadge method={data.capabilities.commentVerification ? "YOUTUBE_API" : "SELF_REPORTED"} />
            <span className="text-xs text-fg-subtle">اختیاری است و مانع تکمیل حمایت نمی‌شود.</span>
          </li>
        </ul>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-bold">دسترسی‌های درخواستی</h2>
        <p className="mt-1.5 text-sm leading-8 text-fg-muted">
          فقط دسترسی خواندن درخواست می‌شود. ما هیچ‌گاه به کانال شما تغییری نمی‌دهیم و توکن‌ها فقط سمت سرور و به‌صورت رمزنگاری‌شده نگهداری
          می‌شوند.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          <li>
            <Pill>مشاهده اشتراک‌ها (خواندن)</Pill>
          </li>
          <li>
            <Pill>مشاهده وضعیت لایک (خواندن)</Pill>
          </li>
          <li>
            <Pill>شناسه کانال</Pill>
          </li>
        </ul>
      </Card>
    </div>
  );
}
