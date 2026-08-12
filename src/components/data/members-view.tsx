"use client";

import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { MemberCard } from "./cards";
import { formatNumber } from "@/lib/cn";

/**
 * Member directory.
 *
 * Search is debounced and resets pagination, so typing never fires a request per
 * keystroke and never leaves the user stranded on page 5 of a different query.
 * Pagination is page-number based here (the dataset is bounded and users expect
 * to jump), while feed-style lists use cursors.
 */

type Member = {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  level: number;
  reputation: number;
  rankTier: string;
  rankTierLabel: string;
  youtubeVerified: boolean;
  _count: { supportsGiven: number; supportsReceived: number };
};

const SORTS = [
  { value: "reputation", label: "اعتبار" },
  { value: "supports", label: "فعال‌ترین" },
  { value: "recent", label: "تازه‌واردها" },
] as const;

type Sort = (typeof SORTS)[number]["value"];

export function MembersView() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<Sort>("reputation");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Member[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
    const params = new URLSearchParams({ sort, page: String(page), limit: "12" });
    if (debounced) params.set("q", debounced);
    try {
      const data = await api.get<{ items: Member[]; total: number }>(`/api/v1/users?${params.toString()}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [sort, page, debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / 12));

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search aria-hidden size={17} className="pointer-events-none absolute inset-y-0 start-3 my-auto text-fg-subtle" />
          <Input
            id="member-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="جست‌وجوی نام یا نام کاربری"
            aria-label="جست‌وجوی اعضا"
            className="ps-10"
          />
        </div>
        <ToggleGroup<Sort> label="ترتیب" options={[...SORTS]} value={sort} onChange={setSort} size="sm" />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton h-56 rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          variant={debounced ? "no-results" : "empty"}
          title={debounced ? "عضوی پیدا نشد" : "هنوز عضوی نیست"}
          description={debounced ? "عبارت دیگری را امتحان کنید." : "با فعال شدن اعضا، این فهرست پر می‌شود."}
          action={debounced ? { label: "پاک کردن جست‌وجو", onClick: () => setQuery("") } : undefined}
        />
      ) : (
        <>
          <p role="status" className="mb-3 text-xs text-fg-subtle">
            <span className="numeric">{formatNumber(total)}</span> عضو
          </p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((member) => (
              <MemberCard key={member.id} user={member} />
            ))}
          </div>

          {totalPages > 1 && (
            <nav aria-label="صفحه‌بندی" className="mt-6 flex items-center justify-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                قبلی
              </Button>
              <span className="numeric text-sm text-fg-muted">
                {formatNumber(page)} از {formatNumber(totalPages)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                بعدی
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
