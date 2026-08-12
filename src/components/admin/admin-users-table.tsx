"use client";

import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";
import { Pill, TierBadge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { formatNumber, formatRelativeTime } from "@/lib/cn";
import { rankTierLabel } from "@/lib/gamification";
import type { RankTier } from "@prisma/client";

/**
 * User administration table.
 *
 * Privilege limits are enforced server-side by src/lib/authz.ts; the UI mirrors
 * them only to avoid offering an action that would be rejected. Every action
 * requires a written reason, which is stored in the audit log alongside the change.
 */

type AdminUser = {
  id: string;
  username: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  status: string;
  youtubeVerified: boolean;
  credits: number;
  points: number;
  level: number;
  reputation: number;
  trustScore: number;
  rankTier: string;
  supportsCompleted: number;
  supportsAbandoned: number;
  lastActiveAt: string | null;
  createdAt: string;
  _count: { supportsGiven: number; supportsReceived: number; sessions: number; abuseSignals: number };
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "فعال",
  PENDING: "در انتظار تأیید",
  SUSPENDED: "معلق",
  BANNED: "مسدود",
};

const ROLE_LABELS: Record<string, string> = {
  USER: "کاربر",
  MODERATOR: "ناظر",
  ADMIN: "مدیر",
  SUPER_ADMIN: "مدیر ارشد",
};

export function AdminUsersTable({ viewerRole }: { viewerRole: string }) {
  const toast = useToast();
  const [items, setItems] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<AdminUser | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(query.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ status, page: String(page), limit: "20" });
    if (debounced) params.set("q", debounced);
    try {
      const data = await api.get<{ items: AdminUser[]; total: number }>(`/api/v1/admin/users?${params.toString()}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [status, page, debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search aria-hidden size={17} className="pointer-events-none absolute inset-y-0 start-3 my-auto text-fg-subtle" />
          <Input
            id="admin-user-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="جست‌وجوی نام، نام کاربری یا ایمیل"
            aria-label="جست‌وجوی کاربران"
            className="ps-10"
          />
        </div>
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="فیلتر وضعیت" className="sm:w-48">
          <option value="ALL">همه وضعیت‌ها</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState variant="no-results" title="کاربری پیدا نشد" description="فیلترها را تغییر دهید." />
      ) : (
        <>
          <p role="status" className="mb-3 text-xs text-fg-subtle">
            <span className="numeric">{formatNumber(total)}</span> کاربر
          </p>

          {/* Data-dense rows rather than a wide table, so it stays usable on mobile. */}
          <ul className="space-y-2">
            {items.map((user) => (
              <li key={user.id}>
                <Card className="p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <Avatar src={user.avatarUrl} name={user.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold">{user.name}</p>
                        <Pill
                          tone={
                            user.status === "ACTIVE"
                              ? "success"
                                : user.status === "SUSPENDED"
                                  ? "warning"
                                  : "danger"
                          }
                        >
                          {STATUS_LABELS[user.status]}
                        </Pill>
                        <Pill tone={user.role === "USER" ? "neutral" : "accent"}>{ROLE_LABELS[user.role]}</Pill>
                        <TierBadge tier={user.rankTier} label={rankTierLabel(user.rankTier as RankTier)} />
                        {user._count.abuseSignals > 0 && (
                          <Pill tone="warning" className="numeric">
                            {formatNumber(user._count.abuseSignals)} سیگنال
                          </Pill>
                        )}
                      </div>
                      <p className="latin truncate-1 mt-0.5 text-xs text-fg-subtle" dir="ltr">
                        @{user.username} · {user.email}
                      </p>
                    </div>

                    <dl className="hidden gap-4 text-center lg:flex">
                      {[
                        { label: "اعتبار", value: user.credits },
                        { label: "کیفیت", value: user.reputation },
                        { label: "حمایت", value: user._count.supportsGiven },
                        { label: "اعتماد", value: user.trustScore },
                      ].map((metric) => (
                        <div key={metric.label}>
                          <dt className="text-[0.625rem] text-fg-subtle">{metric.label}</dt>
                          <dd className="numeric text-sm font-bold">{formatNumber(metric.value)}</dd>
                        </div>
                      ))}
                    </dl>

                    <Button variant="outline" size="sm" onClick={() => setTarget(user)}>
                      اقدام
                    </Button>
                  </div>
                  <p className="mt-2 text-[0.6875rem] text-fg-subtle">
                    عضویت {formatRelativeTime(user.createdAt)}
                    {user.lastActiveAt && ` · آخرین فعالیت ${formatRelativeTime(user.lastActiveAt)}`}
                  </p>
                </Card>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav aria-label="صفحه‌بندی" className="mt-5 flex items-center justify-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                قبلی
              </Button>
              <span className="numeric text-sm text-fg-muted">
                {formatNumber(page)} از {formatNumber(totalPages)}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                بعدی
              </Button>
            </nav>
          )}
        </>
      )}

      <ModerationModal
        user={target}
        viewerRole={viewerRole}
        open={target !== null}
        onClose={() => setTarget(null)}
        onDone={async () => {
          toast.push({ tone: "success", message: "تغییر اعمال شد." });
          await load();
        }}
      />
    </div>
  );
}

function ModerationModal({
  user,
  viewerRole,
  open,
  onClose,
  onDone,
}: {
  user: AdminUser | null;
  viewerRole: string;
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [action, setAction] = useState<"SET_STATUS" | "SET_ROLE" | "ADJUST_CREDITS">("SET_STATUS");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError("");
    try {
      await api.post("/api/v1/admin/users", {
        userId: user.id,
        action,
        reason: String(form.get("reason") ?? ""),
        ...(action === "SET_STATUS" ? { status: String(form.get("status") ?? "") } : {}),
        ...(action === "SET_ROLE" ? { role: String(form.get("role") ?? "") } : {}),
        ...(action === "ADJUST_CREDITS" ? { amount: Number(form.get("amount") ?? 0) } : {}),
      });
      await onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  if (!user) return null;

  return (
    <Modal open={open} onClose={onClose} title={`اقدام روی ${user.name}`} description="ثبت دلیل الزامی است و در گزارش عملیات ذخیره می‌شود.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert tone="danger" live="alert">
            {error}
          </Alert>
        )}

        <Field label="نوع اقدام" htmlFor="action">
          <Select id="action" value={action} onChange={(event) => setAction(event.target.value as typeof action)}>
            <option value="SET_STATUS">تغییر وضعیت</option>
            {/* Role changes are SUPER_ADMIN-only; the server rejects anything else. */}
            {viewerRole === "SUPER_ADMIN" && <option value="SET_ROLE">تغییر سطح دسترسی</option>}
            <option value="ADJUST_CREDITS">اصلاح اعتبار</option>
          </Select>
        </Field>

        {action === "SET_STATUS" && (
          <Field label="وضعیت جدید" htmlFor="status" required>
            <Select id="status" name="status" defaultValue={user.status}>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {action === "SET_ROLE" && (
          <Field label="سطح دسترسی جدید" htmlFor="role" required hint="نمی‌توانید سطحی برابر یا بالاتر از خودتان بدهید.">
            <Select id="role" name="role" defaultValue={user.role}>
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {action === "ADJUST_CREDITS" && (
          <Field label="مقدار اصلاح" htmlFor="amount" required hint="مقدار منفی برای کسر اعتبار">
            <Input id="amount" name="amount" type="number" dir="ltr" className="latin" defaultValue={0} required />
          </Field>
        )}

        <Field label="دلیل" htmlFor="reason" required>
          <Textarea id="reason" name="reason" required minLength={3} />
        </Field>

        <Button type="submit" loading={loading} fullWidth>
          اعمال
        </Button>
      </form>
    </Modal>
  );
}
