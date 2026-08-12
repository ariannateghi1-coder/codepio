import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { ExploreFeed } from "@/components/data/explore-feed";

export const metadata: Metadata = {
  title: "کاوش",
  description: "سازندگان را کشف کنید، حمایت واقعی انجام دهید و اعتبار بسازید.",
};

/**
 * Explore — the product core and the primary destination after login.
 *
 * Rendered as a Server Component shell around a client feed: the shell is static
 * and cached, while the feed owns filtering, search and the support flow, so the
 * page paints immediately and only the list re-fetches.
 */
export default function ExplorePage() {
  return (
    <AppShell>
      <ExploreFeed />
    </AppShell>
  );
}
