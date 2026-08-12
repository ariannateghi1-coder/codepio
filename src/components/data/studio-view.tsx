"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { Plus, RefreshCw, Trash2, Youtube } from "lucide-react";
import { api, errorMessage, fieldErrors } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, CardMedia, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Switch } from "@/components/ui/field";
import { Pill } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Section } from "@/components/layout/page";
import { useToast } from "@/components/ui/toast";
import { formatDuration, formatNumber, formatRelativeTime } from "@/lib/cn";

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
  analytics: { started: number; completed: number; failed: number; completionRate: number | null; budgetRemaining: number | null };
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
                        label: "بودجه باقی‌مانده",
                        value:
                          campaign.analytics.budgetRemaining === null
                            ? "بی‌نهایت"
                            : formatNumber(campaign.analytics.budgetRemaining),
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
  open,
  onClose,
  onDone,
}: {
  videoId: string | null;
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
  const [commentBonus, setCommentBonus] = useState(2);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!videoId) return;
    const form = new FormData(event.currentTarget);

    // Canonical reward model (see src/lib/services/reward.ts): the campaign's own
    // rewardCredits covers ALL required tasks, so required tasks carry no reward of
    // their own — the API rejects it if they do. Only an optional task may add a
    // bonus, which is why the comment task is the only one with a reward here.
    const tasks = [
      { type: "WATCH_VIDEO" as const, required: true, rewardCredits: 0, rewardXp: 0 },
      ...(requireSubscribe ? [{ type: "SUBSCRIBE_CHANNEL" as const, required: true, rewardCredits: 0, rewardXp: 0 }] : []),
      ...(requireLike ? [{ type: "LIKE_VIDEO" as const, required: true, rewardCredits: 0, rewardXp: 0 }] : []),
      ...(askComment
        ? [{ type: "COMMENT_VIDEO" as const, required: false, rewardCredits: commentBonus, rewardXp: commentBonus * 2 }]
        : []),
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
        requiredWatchPercent: Number(form.get("requiredWatchPercent") ?? 90),
        rewardCredits: Number(form.get("rewardCredits") ?? 10),
        rewardXp: 25,
        budgetCredits: Number(form.get("budgetCredits")),
        maxSupportsPerUser: 1,
        dailyLimit: Number(form.get("dailyLimit") ?? 100),
        minAccountAgeHours: Number(form.get("minAccountAgeHours") ?? 0),
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
          <Field label="درصد تماشای لازم" htmlFor="requiredWatchPercent" error={fields.requiredWatchPercent}>
            <Select id="requiredWatchPercent" name="requiredWatchPercent" defaultValue="90">
              {[50, 60, 70, 80, 90, 100].map((value) => (
                <option key={value} value={value}>
                  {value}٪
                </option>
              ))}
            </Select>
          </Field>

          <Field label="پاداش هر حمایت (اعتبار)" htmlFor="rewardCredits" error={fields.rewardCredits}>
            <Input id="rewardCredits" name="rewardCredits" type="number" min={1} max={200} defaultValue={10} dir="ltr" className="latin" />
          </Field>

          <Field
            label="بودجه کل (اعتبار)"
            htmlFor="budgetCredits"
            required
            hint="بودجه هنگام ساخت کمپین از موجودی اعتبار شما کسر می‌شود."
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

          <Field
            label="حداقل سن حساب (ساعت)"
            htmlFor="minAccountAgeHours"
            hint="برای کاهش سوءاستفاده حساب‌های تازه"
            error={fields.minAccountAgeHours}
          >
            <Input id="minAccountAgeHours" name="minAccountAgeHours" type="number" min={0} max={720} defaultValue={0} dir="ltr" className="latin" />
          </Field>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm font-bold">کارهای مورد نیاز</p>
          <p className="text-xs leading-6 text-fg-subtle">
            تماشا همیشه الزامی است. سابسکرایب و لایک فقط برای حامیانی قابل تأیید است که حساب یوتیوب خود را متصل کرده‌اند. پاداش کارهای الزامی
            داخل «پاداش هر حمایت» است؛ فقط کار اختیاری پاداش جداگانه می‌گیرد.
          </p>
          <Switch checked={requireSubscribe} onChange={setRequireSubscribe} label="سابسکرایب کانال" description="با API رسمی یوتیوب بررسی می‌شود." />
          <Switch checked={requireLike} onChange={setRequireLike} label="لایک ویدیو" description="با API رسمی یوتیوب بررسی می‌شود." />
          <Switch checked={askComment} onChange={setAskComment} label="کامنت (اختیاری)" description="عدم انجام آن مانع تکمیل حمایت نمی‌شود." />

          {askComment && (
            <Field label="پاداش اضافی کامنت (اعتبار)" htmlFor="commentBonus" hint="فقط در صورت انجام و تأیید پرداخت می‌شود.">
              <Input
                id="commentBonus"
                type="number"
                min={0}
                max={50}
                value={commentBonus}
                onChange={(event) => setCommentBonus(Math.max(0, Math.min(50, Number(event.target.value) || 0)))}
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
