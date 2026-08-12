"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Compass, Heart, Search, Sparkles, Trophy, X } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/field";
import { EmptyState, ErrorState, SkeletonCard } from "@/components/ui/states";
import { LoadMore } from "@/components/ui/pagination";
import { ExploreCard, type ExploreCardData } from "./cards";
import { SupportFlow } from "./support-flow";
import { rankTierLabel } from "@/lib/gamification";
import { formatNumber } from "@/lib/cn";
import type { RankTier } from "@prisma/client";

/**
 * Explore feed — the main destination after login, and the page the whole product
 * is judged by.
 *
 * Behaviour worth stating:
 *
 *  • Search is debounced (350ms) and each request supersedes the previous one via
 *    a request-id guard, so a slow earlier response can never overwrite newer
 *    results — the classic async race in a search field.
 *  • Pagination is cursor-based and append-only: "نمایش بیشتر" adds to the list
 *    instead of replacing it, and the server's opaque cursor guarantees no
 *    duplicates across pages. Changing filter or query resets the cursor.
 *  • Loading uses skeleton cards with the real card geometry, so arriving data
 *    does not shift the grid. The first load shows skeletons; a page append shows
 *    its own inline state rather than blanking the list the user is reading.
 *  • Every state is designed: idle, typing, results, no-results, error, exhausted.
 *
 * Mobile: one column, a horizontally scrollable filter bar with a fade mask (no
 * horizontal page overflow), and the search field stays reachable at the top.
 */

const FILTERS = [
  { value: "for_you", label: "برای شما", hint: "ترکیبی از پیشنهاد، تازه‌ها و کشف" },
  { value: "new", label: "تازه‌ها" },
  { value: "trending", label: "پرطرفدار" },
  { value: "top_creators", label: "سازندگان برتر" },
  { value: "highest_reward", label: "بیشترین پاداش" },
  { value: "ending_soon", label: "در حال پایان" },
  { value: "most_trusted", label: "معتبرترین" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

type FeedResponse = {
  items: ExploreCardData[];
  nextCursor: string | null;
  poolSize: number;
};

export function ExploreFeed() {
  const [filter, setFilter] = useState<Filter>("for_you");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<ExploreCardData[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [poolSize, setPoolSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState("");
  const [activeCampaign, setActiveCampaign] = useState<string | null>(null);

  // Monotonic request id: only the newest in-flight request may write state.
  const requestId = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  const fetchPage = useCallback(
    async (nextCursor: string | null, mode: "replace" | "append") => {
      const id = ++requestId.current;
      if (mode === "replace") setLoading(true);
      else setAppending(true);
      setError("");

      const params = new URLSearchParams({ filter, limit: "12" });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (nextCursor) params.set("cursor", nextCursor);

      try {
        const data = await api.get<FeedResponse>(`/api/v1/explore?${params.toString()}`);
        if (id !== requestId.current) return; // Superseded.
        setItems((previous) => {
          if (mode === "replace") return data.items;
          // Belt and braces: the cursor already prevents duplicates, but a
          // concurrent insert upstream shouldn't be able to render one twice.
          const seen = new Set(previous.map((item) => item.campaignId));
          return [...previous, ...data.items.filter((item) => !seen.has(item.campaignId))];
        });
        setCursor(data.nextCursor);
        setPoolSize(data.poolSize);
      } catch (e) {
        if (id !== requestId.current) return;
        setError(errorMessage(e));
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setAppending(false);
        }
      }
    },
    [filter, debouncedQuery]
  );

  // Filter/query change starts a fresh feed from the top.
  useEffect(() => {
    setCursor(null);
    void fetchPage(null, "replace");
  }, [fetchPage]);

  const status = useMemo(() => {
    if (loading) return "در حال جست‌وجو…";
    if (debouncedQuery) return `${formatNumber(poolSize)} نتیجه برای «${debouncedQuery}»`;
    if (poolSize > 0) return `${formatNumber(poolSize)} کمپین فعال`;
    return null;
  }, [loading, debouncedQuery, poolSize]);

  return (
    <div>
      <header className="explore-hero relative mb-7 overflow-hidden rounded-2xl px-5 py-8 sm:px-8 sm:py-10">
        <div className="relative z-10 max-w-3xl">
          <p className="inline-flex items-center gap-2 text-xs font-bold text-accent">
            <Compass aria-hidden size={15} />
            کشف امروز
          </p>
          <h1 className="mt-4 max-w-2xl text-3xl font-black leading-[1.45] tracking-tight sm:text-4xl">
            یک ویدیو پیدا کن که ارزش حمایت دارد.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-8 text-fg-muted sm:text-base">
            پیشنهادها را با دلیل ببین، قبل از شروع زمان و کارها را بسنج، حمایت واقعی انجام بده و مسیر رشدت را بساز.
          </p>
          <ol className="mt-7 flex snap-x gap-2 overflow-x-auto pb-1 text-xs font-semibold no-scrollbar" aria-label="مسیر حمایت">
            {[
              ["۱", "کشف"],
              ["۲", "انتخاب"],
              ["۳", "حمایت"],
              ["۴", "رشد"],
            ].map(([step, label], index) => (
              <li key={step} className="flex shrink-0 snap-start items-center gap-2">
                <span className="grid size-7 place-items-center rounded-pill bg-accent text-xs font-black text-fg-onAccent">{step}</span>
                <span>{label}</span>
                {index < 3 && <ArrowLeft aria-hidden size={13} className="mx-1 text-fg-subtle" />}
              </li>
            ))}
          </ol>
        </div>
        <Sparkles aria-hidden className="explore-hero-mark absolute -bottom-8 -start-5 size-40 text-accent sm:size-56" />
      </header>

      <section aria-labelledby="explore-results-title">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold text-accent">پیشنهادهای قابل توضیح</p>
            <h2 id="explore-results-title" className="mt-1 text-xl font-black sm:text-2xl">برای حمایت بعدی آماده‌ای؟</h2>
          </div>
          <div className="hidden items-center gap-4 text-xs text-fg-subtle sm:flex" aria-label="راهنمای امتیازها">
            <span className="inline-flex items-center gap-1.5"><Heart aria-hidden size={13} className="text-accent" /> اعتبار: امکان حمایت</span>
            <span className="inline-flex items-center gap-1.5"><Sparkles aria-hidden size={13} className="text-info" /> XP: پیشرفت سطح</span>
            <span className="inline-flex items-center gap-1.5"><Trophy aria-hidden size={13} className="text-warning" /> شهرت: اعتماد جامعه</span>
          </div>
        </div>

        <div className="mb-6 flex flex-col gap-3">
        <div className="relative">
          <Search aria-hidden size={17} className="pointer-events-none absolute inset-y-0 start-3 my-auto text-fg-subtle" />
          <Input
            id="explore-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="جست‌وجوی سازنده، عنوان ویدیو یا کمپین"
            aria-label="جست‌وجو در کاوش"
            className="ps-10 pe-10"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="پاک کردن جست‌وجو"
              className="absolute inset-y-0 end-2 my-auto grid size-8 place-items-center rounded-pill text-fg-subtle transition-colors hover:bg-surface-sunken hover:text-fg"
            >
              <X aria-hidden size={15} />
            </button>
          )}
        </div>

        {/* scroll-fade-x prevents the "is there more?" ambiguity on mobile
            without adding arrows that would need their own touch targets. */}
        <div className="scroll-fade-x -mx-1 px-1">
          <ToggleGroup<Filter> label="فیلتر کاوش" options={[...FILTERS]} value={filter} onChange={setFilter} size="sm" />
        </div>

        {status && (
          <p role="status" aria-live="polite" className="numeric text-xs text-fg-subtle">
            {status}
          </p>
        )}
      </div>

      {error && items.length === 0 ? (
        <ErrorState message={error} onRetry={() => void fetchPage(null, "replace")} />
      ) : loading ? (
        <div className="explore-grid">
          {Array.from({ length: 6 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          variant={debouncedQuery ? "no-results" : "empty"}
          title={debouncedQuery ? "نتیجه‌ای پیدا نشد" : "الان کمپین فعالی نیست"}
          description={
            debouncedQuery
              ? "عبارت دیگری را امتحان کنید، یا فیلتر را روی «تازه‌ها» بگذارید."
              : "به‌زودی سر بزنید، یا خودتان اولین کمپین را بسازید: ویدیوی خود را اضافه کنید و از جامعه حمایت بگیرید."
          }
          action={
            debouncedQuery
              ? { label: "پاک کردن جست‌وجو", onClick: () => setQuery("") }
              : { label: "ساخت کمپین", href: "/studio" }
          }
        />
      ) : (
        <>
          <div className="explore-grid">
            {items.map((item) => (
              <ExploreCard
                key={item.campaignId}
                data={item}
                tierLabel={rankTierLabel(item.creator.rankTier as RankTier)}
                onStart={setActiveCampaign}
              />
            ))}
            {/* Appending shows extra skeletons in place, so the list the user is
                already reading never blanks out. */}
            {appending && Array.from({ length: 3 }).map((_, index) => <SkeletonCard key={`more-${index}`} />)}
          </div>

          {/* A failed append is reported without discarding what already loaded. */}
          {error && (
            <p role="alert" className="mt-4 text-center text-xs font-semibold text-danger">
              {error}
            </p>
          )}

          <LoadMore
            className="mt-8"
            loading={appending}
            exhausted={cursor === null}
            loadedCount={items.length}
            onClick={() => void fetchPage(cursor, "append")}
          />
        </>
      )}

      </section>

      <SupportFlow
        campaignId={activeCampaign}
        open={activeCampaign !== null}
        onClose={() => setActiveCampaign(null)}
        onCompleted={() => void fetchPage(null, "replace")}
      />
    </div>
  );
}
