import { SkeletonCard } from "@/components/ui/states";
import { AppShell } from "@/components/layout/app-shell";

/**
 * Route-level loading UI. Renders the same grid geometry as the real feed, so the
 * transition to loaded content shifts nothing.
 */
export default function Loading() {
  return (
    <AppShell>
      <div className="explore-hero mb-7 overflow-hidden rounded-2xl px-5 py-8 sm:px-8 sm:py-10" aria-hidden>
        <div className="skeleton h-5 w-28 rounded-pill opacity-70" />
        <div className="skeleton mt-5 h-10 w-full max-w-xl" />
        <div className="skeleton mt-3 h-5 w-full max-w-2xl" />
        <div className="skeleton mt-2 h-5 w-3/4 max-w-xl" />
        <div className="mt-7 flex gap-2">
          <div className="skeleton h-8 w-24 rounded-pill" />
          <div className="skeleton h-8 w-24 rounded-pill" />
          <div className="skeleton h-8 w-24 rounded-pill" />
        </div>
      </div>
      <div className="mb-6 space-y-3">
        <div className="skeleton h-12 w-full rounded-xl" />
        <div className="skeleton h-9 w-full max-w-3xl rounded-pill" />
      </div>
      <div className="explore-grid">
        {Array.from({ length: 6 }).map((_, index) => (
          <SkeletonCard key={index} />
        ))}
      </div>
    </AppShell>
  );
}
