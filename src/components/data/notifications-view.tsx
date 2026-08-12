"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Dot, Pill } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { formatRelativeTime, groupByDay } from "@/lib/cn";

/**
 * Notification centre.
 *
 * Grouped by day, unread items visually distinct, mark-one and mark-all, and
 * cursor-based "load more" — histories grow without bound, so deep OFFSET paging
 * would get slower over time.
 *
 * Realtime: the app subscribes on the shell; this view refetches on mount and
 * after each mutation, so the unread badge and the list can't disagree.
 */

type Notification = {
  id: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  createdAt: string;
  actor: { username: string; name: string; avatarUrl: string | null } | null;
};

const TYPE_LABELS: Record<string, string> = {
  SUPPORT_RECEIVED: "حمایت دریافتی",
  SUPPORT_MUTUAL: "حمایت متقابل",
  SUPPORT_VERIFIED: "تأیید حمایت",
  SUPPORT_REVERSED: "برگشت حمایت",
  REWARD_PENDING: "پاداش در انتظار",
  CAMPAIGN_UPDATE: "کمپین",
  ANNOUNCEMENT: "اطلاعیه",
  SECURITY: "امنیت",
  SYSTEM: "سیستم",
};

export function NotificationsView() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ items: Notification[]; unread: number; nextCursor: string | null }>(
        "/api/v1/notifications?limit=20"
      );
      setItems(data.items);
      setUnread(data.unread);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const data = await api.get<{ items: Notification[]; nextCursor: string | null }>(
        `/api/v1/notifications?limit=20&cursor=${cursor}`
      );
      setItems((current) => [...current, ...data.items]);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function markOne(id: string) {
    // Optimistic, then reconciled with the server's authoritative unread count.
    setItems((current) => current.map((item) => (item.id === id ? { ...item, read: true } : item)));
    try {
      const result = await api.patch<{ unread: number }>("/api/v1/notifications", { id });
      setUnread(result.unread);
    } catch {
      void load();
    }
  }

  async function markAll() {
    setItems((current) => current.map((item) => ({ ...item, read: true })));
    try {
      const result = await api.patch<{ unread: number }>("/api/v1/notifications", { all: true });
      setUnread(result.unread);
    } catch {
      void load();
    }
  }

  if (error && items.length === 0) return <ErrorState message={error} onRetry={load} />;

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="skeleton h-20 rounded-xl" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="اعلانی ندارید"
        description="حمایت‌های دریافتی، تأییدها و رویدادهای امنیتی حساب شما اینجا نمایش داده می‌شوند."
        action={{ label: "رفتن به کاوش", href: "/explore" }}
      />
    );
  }

  const groups = groupByDay(items, (item) => item.createdAt);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p role="status" className="text-sm text-fg-muted">
          {unread > 0 ? (
            <span className="inline-flex items-center gap-2">
              <Dot />
              <span className="numeric font-bold text-fg">{unread}</span> خوانده‌نشده
            </span>
          ) : (
            "همه اعلان‌ها خوانده شده‌اند"
          )}
        </p>
        <Button variant="outline" size="sm" onClick={markAll} disabled={unread === 0} icon={<CheckCheck aria-hidden size={15} />}>
          خواندن همه
        </Button>
      </div>

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.key}>
            <h2 className="mb-2 text-xs font-bold text-fg-subtle">{group.label}</h2>
            <ul className="space-y-2">
              {group.items.map((item) => (
                <li key={item.id}>
                  <Card className={item.read ? "p-3" : "border-accent/30 bg-accent-soft p-3"}>
                    <div className="flex items-start gap-3">
                      {item.actor ? (
                        <Avatar src={item.actor.avatarUrl} name={item.actor.name} size="sm" />
                      ) : (
                        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-fg-subtle">
                          <Bell size={16} />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-bold">{item.title}</p>
                          <Pill>{TYPE_LABELS[item.type] ?? item.type}</Pill>
                          {!item.read && <Dot />}
                        </div>
                        <p className="mt-1 text-sm leading-7 text-fg-muted">{item.message}</p>
                        <time className="mt-1.5 block text-xs text-fg-subtle" dateTime={item.createdAt}>
                          {formatRelativeTime(item.createdAt)}
                        </time>
                      </div>
                      {!item.read && (
                        <Button variant="ghost" size="sm" onClick={() => markOne(item.id)}>
                          خواندم
                        </Button>
                      )}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {cursor && (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" onClick={loadMore} loading={loadingMore}>
            نمایش بیشتر
          </Button>
        </div>
      )}
    </div>
  );
}
