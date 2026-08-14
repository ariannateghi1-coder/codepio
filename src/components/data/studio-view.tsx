"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { Plus, RefreshCw, Trash2, Youtube } from "lucide-react";
import { api, errorMessage, fieldErrors } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, CardMedia, CardTitle } from "@/components/ui/card";
import { Field, Input, Switch } from "@/components/ui/field";
import { Pill } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Section } from "@/components/layout/page";
import { useToast } from "@/components/ui/toast";
import { formatDuration, formatNumber, formatRelativeTime } from "@/lib/cn";
import { SUPPORT_TRANSFER_CREDITS, WATCH_RULES } from "@/lib/gamification";

/**
 * Creator studio: videos and campaigns.
 *
 * A campaign can only be created from a video whose duration was fetched from
 * YouTube, because watch verification is measured against that duration — allowing
 * a campaign without it would mean shipping an unverifiable requirement.
 */

type Video = {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  youtubeVideoId: string;
  durationSec: number | null;
  status: string;
  metadataSyncedAt: string | null;
  /** YouTube's kids classification, from the video or its channel. */
  madeForKids: boolean | null;
  _count: { supports: number; campaigns: number };
};

type Campaign = {
  id: string;
  title: string;
  status: string;
  startAt: string;
  endAt: string;
  rewardCredits: number;
  budgetCredits: number;
  spentCredits: number;
  requiredWatchPercent: number;
  video: { title: string; thumbnailUrl: string | null; durationSec: number | null } | null;
  tasks: { type: string; required: boolean }[];
  analytics: {
    started: number;
    completed: number;
    failed: number;
    completionRate: number | null;
    budgetRemaining: number | null;
    /** How many more supports the remaining escrow can pay for. */
    supportsRemaining: number | null;
  };
};

const TASK_LABELS: Record<string, string> = {
  WATCH_VIDEO: "تماشا",
  SUBSCRIBE_CHANNEL: "سابسکرایب",
  LIKE_VIDEO: "لایک",
  COMMENT_VIDEO: "کامنت",
};

export function StudioView() {
  const toast = useToast();
  const [videos, setVideos] = useState<Video[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [videoModal, setVideoModal] = useState(false);
  const [campaignModal, setCampaignModal] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [videoData, campaignData] = await Promise.all([
        api.get<{ items: Video[] }>("/api/v1/videos"),
        api.get<{ items: Campaign[] }>("/api/v1/campaigns"),
      ]);
      setVideos(videoData.items);
      setCampaigns(campaignData.items);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncVideo(id: string) {
    try {
      await api.post(`/api/v1/videos/${id}/sync`);
      toast.push({ tone: "success", message: "اطلاعات ویدیو از یوتیوب بروزرسانی شد." });
      await load();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    }
  }

  async function removeVideo(id: string) {
    try {
      await api.delete(`/api/v1/videos/${id}`);
      toast.push({ tone: "success", message: "ویدیو حذف شد." });
      await load();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    }
  }

  async function campaignAction(campaignId: string, action: "PAUSE" | "ACTIVATE" | "END") {
    try {
      await api.patch("/api/v1/campaigns", { campaignId, action });
      toast.push({ tone: "success", message: "وضعیت کمپین بروزرسانی شد." });
      await load();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="skeleton h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <Section
        title="ویدیوها"
        description="اطلاعات هر ویدیو از API یوتیوب دریافت می‌شود؛ مدت‌زمان برای تأیید تماشا لازم است."
        actions={
          <Button size="sm" onClick={() => setVideoModal(true)} icon={<Plus aria-hidden size={15} />}>
            افزودن ویدیو
          </Button>
        }
      >
        {videos.length === 0 ? (
          <EmptyState
            title="ویدیویی ثبت نکرده‌اید"
            description="اولین ویدیوی یوتیوب خود را اضافه کنید تا بتوانید کمپین بسازید."
            action={{ label: "افزودن ویدیو", onClick: () => setVideoModal(true) }}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {videos.map((video) => (
              <Card key={video.id} className="overflow-hidden">
                <CardMedia>
                  <div className="relative aspect-video bg-surface-sunken">
                    {video.thumbnailUrl && (
                      <Image src={video.thumbnailUrl} alt={video.title} fill sizes="33vw" className="object-cover" />
                    )}
                    {video.durationSec != null && (
                      <span className="numeric absolute bottom-2 end-2 rounded-md bg-black/75 px-1.5 py-0.5 text-xs font-bold text-white">
                        {formatDuration(video.durationSec)}
                      </span>
                    )}
                  </div>
                </CardMedia>
                <CardHeader>
                  <CardTitle className="clamp-2 text-sm leading-7">{video.title}</CardTitle>
                </CardHeader>
                <CardBody className="pt-0 text-xs">
                  <span className="numeric">{formatNumber(video._count.supports)}</span> حمایت ·{" "}
                  <span className="numeric">{formatNumber(video._count.campaigns)}</span> کمپین
                  {!video.durationSec && (
                    <Pill tone="warning" className="ms-2">
                      نیازمند همگام‌سازی
                    </Pill>
                  )}
                </CardBody>
                <CardFooter className="flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => setCampaignModal(video.id)} disabled={!video.durationSec}>
                    ساخت کمپین
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => syncVideo(video.id)}
                    icon={<RefreshCw aria-hidden size={14} />}
                    aria-label={`همگام‌سازی ${video.title}`}
                  >
                    همگام‌سازی
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeVideo(video.id)}
                    aria-label={`حذف ${video.title}`}
                    className="ms-auto text-danger"
                    icon={<Trash2 aria-hidden size={14} />}
                  />
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="کمپین‌ها" description="آمار بر اساس نشست‌های واقعی حمایت است.">
        {campaigns.length === 0 ? (
          <EmptyState title="کمپینی ندارید" description="از یکی از ویدیوهای خود کمپین بسازید تا در کاوش دیده شود." />
        ) : (
          <ul className="space-y-3">
            {campaigns.map((campaign) => (
              <li key={campaign.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-bold">{campaign.title}</h3>
                        <Pill tone={campaign.status === "ACTIVE" ? "success" : campaign.status === "PAUSED" ? "warning" : "neutral"}>
                          {campaign.status === "ACTIVE" ? "فعال" : campaign.status === "PAUSED" ? "متوقف" : "پایان‌یافته"}
                        </Pill>
                      </div>
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {campaign.tasks.map((task) => (
                          <li key={task.type}>
                            <Pill className={task.required ? "" : "opacity-70"}>
                              {TASK_LABELS[task.type] ?? task.type}
                              {task.type === "WATCH_VIDEO" && ` ${formatNumber(campaign.requiredWatchPercent)}٪`}
                              {!task.required && " (اختیاری)"}
                            </Pill>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="flex gap-1.5">
                      {campaign.status === "ACTIVE" ? (
                        <Button size="sm" variant="outline" onClick={() => campaignAction(campaign.id, "PAUSE")}>
                          توقف
                        </Button>
                      ) : campaign.status === "PAUSED" ? (
                        <Button size="sm" variant="outline" onClick={() => campaignAction(campaign.id, "ACTIVATE")}>
                          فعال‌سازی
                        </Button>
                      ) : null}
                      {campaign.status !== "ENDED" && (
                        <Button size="sm" variant="ghost" onClick={() => campaignAction(campaign.id, "END")}>
                          پایان
                        </Button>
                      )}
                    </div>
                  </div>

                  <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      { label: "شروع‌شده", value: formatNumber(campaign.analytics.started) },
                      { label: "تکمیل‌شده", value: formatNumber(campaign.analytics.completed) },
                      {
                        label: "نرخ تکمیل",
                        value: campaign.analytics.completionRate === null ? "—" : `${formatNumber(campaign.analytics.completionRate)}٪`,
                      },
                      {
                        // "بی‌نهایت" was wrong: a campaign cannot exist with a zero
                        // budget, so the null branch is unreachable in practice and
                        // an unbounded budget is not a state the economy allows.
                        label: "حمایت باقی‌مانده",
                        value:
                          campaign.analytics.supportsRemaining === null
                            ? "—"
                            : formatNumber(campaign.analytics.supportsRemaining),
                      },
                    ].map((item) => (
                      <div key={item.label} className="rounded-lg bg-surface-sunken p-2.5 text-center">
                        <dt className="text-[0.6875rem] text-fg-subtle">{item.label}</dt>
                        <dd className="numeric mt-0.5 text-sm font-bold">{item.value}</dd>
                      </div>
                    ))}
                  </dl>

                  <p className="mt-3 text-xs text-fg-subtle">پایان {formatRelativeTime(campaign.endAt)}</p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <AddVideoModal open={videoModal} onClose={() => setVideoModal(false)} onDone={load} />
      <CreateCampaignModal
        videoId={campaignModal}
        // Passed so the kids switch starts in the state YouTube already reports,
        // rather than defaulting to off and quietly breaking verification.
        videoMadeForKids={videos.find((v) => v.id === campaignModal)?.madeForKids === true}
        open={campaignModal !== null}
        onClose={() => setCampaignModal(null)}
        onDone={load}
      />
    </div>
  );
}

function AddVideoModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError("");
    setFields({});
    try {
      const result = await api.post<{ warning: string | null }>("/api/v1/videos", {
        youtubeUrl: String(form.get("youtubeUrl") ?? ""),
      });
      toast.push({ tone: result.warning ? "warning" : "success", message: result.warning ?? "ویدیو اضافه شد." });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setFields(fieldErrors(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="افزودن ویدیوی یوتیوب" description="آدرس ویدیو را وارد کنید؛ بقیه اطلاعات از یوتیوب خوانده می‌شود.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert tone="danger" live="alert">
            {error}
          </Alert>
        )}
        <Field
          label="آدرس ویدیو"
          htmlFor="youtubeUrl"
          required
          hint="youtube.com/watch، youtu.be و shorts پشتیبانی می‌شوند."
          error={fields.youtubeUrl}
        >
          <Input
            id="youtubeUrl"
            name="youtubeUrl"
            dir="ltr"
            className="latin"
            placeholder="https://www.youtube.com/watch?v=…"
            required
            invalid={Boolean(fields.youtubeUrl)}
          />
        </Field>
        <Button type="submit" fullWidth loading={loading} icon={<Youtube aria-hidden size={16} />}>
          افزودن ویدیو
        </Button>
      </form>
    </Modal>
  );
}

function CreateCampaignModal({
  videoId,
  videoMadeForKids,
  open,
  onClose,
  onDone,
}: {
  videoId: string | null;
  /** What YouTube reports about this video, used to pre-tick the kids switch. */
  videoMadeForKids: boolean;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [requireSubscribe, setRequireSubscribe] = useState(true);
  const [requireLike, setRequireLike] = useState(true);
  const [askComment, setAskComment] = useState(false);
  const [commentBonusXp, setCommentBonusXp] = useState(5);
  /**
   * Creator declaration that this is kids content.
   *
   * YouTube does not report subscribes and likes on kids content back to a
   * read-only API client, so those tasks cannot be verified for this campaign. The
   * switch waives them instead of failing supporters who really did them.
   */
  const [kidsContent, setKidsContent] = useState(videoMadeForKids);

  // The modal is mounted once and reused for each video, so the prefill has to
  // follow the selection rather than only the first render.
  useEffect(() => {
    setKidsContent(videoMadeForKids);
  }, [videoMadeForKids, videoId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!videoId) return;
    const form = new FormData(event.currentTarget);

    // Task bonuses are XP ONLY (see src/lib/services/reward.ts). The credit a
    // supporter receives is the fixed campaign transfer, so a per-task credit would
    // pay out more than the budget was charged. Required tasks carry no bonus at
    // all — their value is in the base — which is why only the optional comment
    // task has one.
    const tasks = [
      { type: "WATCH_VIDEO" as const, required: true, rewardXp: 0 },
      ...(requireSubscribe ? [{ type: "SUBSCRIBE_CHANNEL" as const, required: true, rewardXp: 0 }] : []),
      ...(requireLike ? [{ type: "LIKE_VIDEO" as const, required: true, rewardXp: 0 }] : []),
      ...(askComment ? [{ type: "COMMENT_VIDEO" as const, required: false, rewardXp: commentBonusXp }] : []),
    ];

    setLoading(true);
    setError("");
    setFields({});
    try {
      await api.post("/api/v1/campaigns", {
        videoId,
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? ""),
        startAt: new Date().toISOString(),
        endAt: new Date(Date.now() + Number(form.get("days") ?? 30) * 86_400_000).toISOString(),
        // No rewardCredits and no requiredWatchPercent: both are platform
        // constants, identical for every campaign, and the API rejects the fields.
        rewardXp: 25,
        budgetCredits: Number(form.get("budgetCredits")),
        maxSupportsPerUser: 1,
        dailyLimit: Number(form.get("dailyLimit") ?? 100),
        // No minAccountAgeHours: the account-age requirement is gone, so there is
        // no field to send and nothing to configure for it below.
        kidsContent,
        tasks,
      });
      toast.push({ tone: "success", message: "کمپین ساخته شد و در کاوش نمایش داده می‌شود." });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setFields(fieldErrors(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="ساخت کمپین" description="مشخص کنید حامیان چه کاری انجام دهند و چه پاداشی بگیرند.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert tone="danger" live="alert">
            {error}
          </Alert>
        )}

        <Field label="عنوان کمپین" htmlFor="title" required error={fields.title}>
          <Input id="title" name="title" required invalid={Boolean(fields.title)} />
        </Field>

        <Field label="توضیح کوتاه" htmlFor="description" error={fields.description}>
          <Input id="description" name="description" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* The watch requirement is not a creator choice: every campaign asks
              for the same share of the video, so there is nothing to select. */}
          <div className="rounded-lg bg-surface-sunken p-3 text-xs leading-6 text-fg-muted">
            حامیان باید <span className="numeric font-bold">{formatNumber(WATCH_RULES.defaultRequiredPercent)}٪</span> از مدت ویدیو را
            تماشا کنند. ویدیو در خود یوتیوب باز می‌شود و زمان لازم روی ساعت سرور اندازه‌گیری می‌شود.
          </div>

          <Field
            label="بودجه کل (اعتبار)"
            htmlFor="budgetCredits"
            required
            hint={`بودجه هنگام ساخت کمپین از موجودی شما کسر و در کمپین نگه داشته می‌شود. هر حمایت ${formatNumber(
              SUPPORT_TRANSFER_CREDITS
            )} اعتبار از آن به حامی پرداخت می‌شود؛ باقی‌مانده با پایان کمپین به شما برمی‌گردد.`}
            error={fields.budgetCredits}
          >
            <Input
              id="budgetCredits"
              name="budgetCredits"
              type="number"
              min={10}
              max={1_000_000}
              defaultValue={100}
              required
              dir="ltr"
              className="latin"
              invalid={Boolean(fields.budgetCredits)}
            />
          </Field>

          <Field label="سقف روزانه" htmlFor="dailyLimit" error={fields.dailyLimit}>
            <Input id="dailyLimit" name="dailyLimit" type="number" min={1} defaultValue={100} dir="ltr" className="latin" />
          </Field>

          <Field label="مدت کمپین (روز)" htmlFor="days">
            <Input id="days" name="days" type="number" min={1} max={365} defaultValue={30} dir="ltr" className="latin" />
          </Field>

          {/*
            A "minimum account age" input used to sit here, and is deliberately gone.
            It read like a mild anti-abuse knob but acted as a hard refusal: a creator
            who typed 30 locked out most of the platform — themselves included — with
            nothing on screen saying that was the consequence. Account age still feeds
            the risk score, where it is weighed against real behaviour instead of
            deciding on its own.
          */}
          <div className="rounded-lg bg-surface-sunken p-3 text-xs leading-6 text-fg-muted">
            همه حساب‌ها می‌توانند از این کمپین حمایت کنند و حساب‌های تازه محدودیتی ندارند. رفتار مشکوک همچنان توسط سامانه
            ضدسوءاستفاده بررسی می‌شود.
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm font-bold">کارهای مورد نیاز</p>
          <p className="text-xs leading-6 text-fg-subtle">
            تماشا همیشه الزامی است. سابسکرایب و لایک فقط برای حامیانی قابل تأیید است که حساب یوتیوب خود را متصل کرده‌اند. اعتبار هر حمایت
            برای همه کمپین‌ها یکسان و ثابت است؛ کار اختیاری فقط XP اضافه می‌کند.
          </p>
          <Switch
            checked={requireSubscribe}
            onChange={setRequireSubscribe}
            label="سابسکرایب کانال"
            description={kidsContent ? "به دلیل محتوای کودکان، بدون بررسی خودکار پذیرفته می‌شود." : "با API رسمی یوتیوب بررسی می‌شود."}
          />
          <Switch
            checked={requireLike}
            onChange={setRequireLike}
            label="لایک ویدیو"
            description={kidsContent ? "به دلیل محتوای کودکان، بدون بررسی خودکار پذیرفته می‌شود." : "با API رسمی یوتیوب بررسی می‌شود."}
          />
          <Switch checked={askComment} onChange={setAskComment} label="کامنت (اختیاری)" description="عدم انجام آن مانع تکمیل حمایت نمی‌شود." />

          {/*
            The kids-content declaration.

            A creator switch rather than an automatic detection: YouTube does not
            report subscribes and likes on kids content back to a read-only client,
            and an absent subscription is indistinguishable from one that was never
            made. The alternative — demanding the creator un-flag their video in
            YouTube Studio — asked them to misdeclare kids content to YouTube just to
            satisfy our checker, which is not ours to require.
          */}
          <div className="rounded-lg bg-surface-sunken p-3">
            <Switch
              checked={kidsContent}
              onChange={setKidsContent}
              label="محتوای کودکان (YouTube Kids)"
              description={
                videoMadeForKids
                  ? "یوتیوب این ویدیو را «ساخته‌شده برای کودکان» گزارش کرده است، پس این گزینه لازم است و خودکار فعال شده."
                  : "اگر ویدیو در یوتیوب با گزینه «ساخته‌شده برای کودکان» منتشر شده است، این را فعال کنید."
              }
              // Not a free choice when YouTube already says so: turning it off would
              // only produce failed tasks for supporters who did the work. The server
              // forces it on regardless, so a toggle here would be a lie.
              disabled={videoMadeForKids}
            />
            {kidsContent && (
              <Alert tone="warning" className="mt-3">
                با فعال بودن این گزینه، سابسکرایب و لایک <span className="font-bold">بررسی خودکار نمی‌شوند</span> و به‌صورت «تأییدنشده»
                رد می‌شوند؛ یوتیوب این دو مورد را برای محتوای کودکان به ما گزارش نمی‌دهد. حامی به‌خاطر آن‌ها ناموفق نمی‌شود، ولی شما هم
                مدرکی برای انجام‌شدنشان نخواهید داشت. تماشا مثل همیشه با ساعت سرور سنجیده می‌شود.
              </Alert>
            )}
          </div>

          {askComment && (
            <Field
              label="پاداش اضافی کامنت (XP)"
              htmlFor="commentBonusXp"
              hint="فقط در صورت انجام و تأیید پرداخت می‌شود. این پاداش XP است، نه اعتبار — اعتبار هر حمایت ثابت است."
            >
              <Input
                id="commentBonusXp"
                type="number"
                min={0}
                max={100}
                value={commentBonusXp}
                onChange={(event) => setCommentBonusXp(Math.max(0, Math.min(100, Number(event.target.value) || 0)))}
                dir="ltr"
                className="latin"
              />
            </Field>
          )}
        </div>

        <Button type="submit" fullWidth loading={loading}>
          ساخت کمپین
        </Button>
      </form>
    </Modal>
  );
}
