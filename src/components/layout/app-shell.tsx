"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Award,
  Bell,
  Compass,
  Heart,
  LayoutDashboard,
  Menu,
  Settings,
  Shield,
  Trophy,
  Users,
  Video,
  X,
} from "lucide-react";
import { cn, formatNumber } from "@/lib/cn";
import { api } from "@/lib/client-api";
import { Avatar } from "@/components/ui/avatar";
import { BadgeAnchor, TierBadge } from "@/components/ui/badge";
import { ThemeToggle } from "./theme-toggle";

/**
 * Application shell.
 *
 * Navigation hierarchy puts Explore first because it is the product core, not a
 * secondary page. The mobile drawer is a real off-canvas panel: it locks body
 * scroll, closes on Esc and on scrim tap, keeps aria-expanded in sync, traps focus
 * while open, and returns focus to the hamburger button on close.
 *
 * The current page is marked with aria-current="page" and styled off that
 * attribute, so the visual state and the accessible state cannot disagree.
 */

type Viewer = {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  credits: number;
  points: number;
  level: number;
  rankTier: string;
  rankTierLabel: string;
};

const PRIMARY_NAV = [
  { href: "/explore", label: "کاوش", icon: Compass },
  { href: "/dashboard", label: "داشبورد", icon: LayoutDashboard },
  { href: "/studio", label: "استودیو", icon: Video },
  { href: "/leaderboard", label: "رتبه‌بندی", icon: Trophy },
  { href: "/members", label: "اعضا", icon: Users },
] as const;

const SECONDARY_NAV = [
  { href: "/support/history", label: "تاریخچه حمایت", icon: Heart },
  { href: "/badges", label: "نشان‌ها", icon: Award },
  { href: "/notifications", label: "اعلان‌ها", icon: Bell },
  { href: "/settings", label: "تنظیمات", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [unread, setUnread] = useState(0);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ user: Viewer; unreadNotifications: number }>("/api/v1/auth/me")
      .then((data) => {
        if (cancelled) return;
        setViewer(data.user);
        setUnread(data.unreadNotifications);
      })
      .catch(() => {
        if (!cancelled) setViewer(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    hamburgerRef.current?.focus();
  }, []);

  // Route change closes the drawer; a stale open panel after navigation is a bug.
  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      // Focus trap: cycle within the drawer while it is modal.
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();

    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen, closeDrawer]);

  const isStaff = viewer ? ["MODERATOR", "ADMIN", "SUPER_ADMIN"].includes(viewer.role) : false;

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <>
      <nav aria-label="ناوبری اصلی" className="flex flex-col gap-1">
        {PRIMARY_NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={isActive(href) ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors duration-fast",
              "text-fg-muted hover:bg-surface-sunken hover:text-fg",
              "aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent"
            )}
          >
            <Icon aria-hidden size={18} />
            {label}
          </Link>
        ))}
      </nav>

      <hr className="divider my-3" />

      <nav aria-label="ناوبری فرعی" className="flex flex-col gap-1">
        {SECONDARY_NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={isActive(href) ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-fast",
              "text-fg-muted hover:bg-surface-sunken hover:text-fg",
              "aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent"
            )}
          >
            <Icon aria-hidden size={17} />
            <span className="flex-1">{label}</span>
            {href === "/notifications" && unread > 0 && (
              <span className="numeric rounded-pill bg-danger px-1.5 text-[0.625rem] font-bold text-white">
                {formatNumber(unread)}
              </span>
            )}
          </Link>
        ))}

        {isStaff && (
          <Link
            href="/admin"
            onClick={onNavigate}
            aria-current={isActive("/admin") ? "page" : undefined}
            className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold text-fg-muted transition-colors hover:bg-surface-sunken hover:text-fg aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent"
          >
            <Shield aria-hidden size={17} />
            مدیریت
          </Link>
        )}
      </nav>
    </>
  );

  const ViewerCard = () =>
    viewer ? (
      <Link
        href={`/members/${viewer.username}`}
        className="flex items-center gap-3 rounded-lg border border-border bg-surface-sunken p-2.5 transition-colors hover:border-border-strong"
      >
        <Avatar src={viewer.avatarUrl} name={viewer.name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate-1 text-sm font-bold text-fg">{viewer.name}</p>
          <p className="truncate-1 latin text-xs text-fg-subtle" dir="ltr">
            @{viewer.username}
          </p>
        </div>
        <TierBadge tier={viewer.rankTier} label={viewer.rankTierLabel} />
      </Link>
    ) : (
      <Link
        href="/auth/login"
        className="flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-bold text-fg-onAccent"
      >
        ورود / ثبت‌نام
      </Link>
    );

  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar: sticky, so it stays put while the feed scrolls. */}
      <aside className="fixed inset-y-0 end-0 z-30 hidden w-72 flex-col border-s border-border bg-surface p-4 lg:flex">
        <Link href="/explore" className="mb-6 flex items-center gap-3 rounded-lg p-1.5 transition-colors hover:bg-surface-sunken">
          <span aria-hidden className="grid size-10 place-items-center rounded-lg bg-accent text-sm font-black text-fg-onAccent">
            AS
          </span>
          <span>
            <b className="block text-sm">آکادمی حمایت</b>
            <span className="text-xs text-fg-subtle">اکوسیستم حمایت واقعی</span>
          </span>
        </Link>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavList />
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4">
          {viewer && (
            <dl className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-lg bg-surface-sunken p-2">
                <dt className="text-[0.6875rem] text-fg-subtle">اعتبار</dt>
                <dd className="numeric text-sm font-bold text-fg">{formatNumber(viewer.credits)}</dd>
              </div>
              <div className="rounded-lg bg-surface-sunken p-2">
                <dt className="text-[0.6875rem] text-fg-subtle">سطح</dt>
                <dd className="numeric text-sm font-bold text-fg">{formatNumber(viewer.level)}</dd>
              </div>
            </dl>
          )}
          <ThemeToggle />
          <ViewerCard />
        </div>
      </aside>

      {/* Mobile drawer + scrim */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="scrim" onClick={closeDrawer} aria-hidden />
          <div
            ref={drawerRef}
            id="app-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="منوی ناوبری"
            className="animate-drawer relative ms-auto flex h-full w-[min(86vw,20rem)] flex-col border-s border-border bg-surface p-4"
          >
            <div className="mb-4 flex items-center justify-between">
              <b className="text-sm">آکادمی حمایت</b>
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="بستن منو"
                className="grid size-10 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-sunken"
              >
                <X aria-hidden size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <NavList onNavigate={closeDrawer} />
            </div>
            <div className="mt-4 space-y-3 border-t border-border pt-4">
              <ThemeToggle />
              <ViewerCard />
            </div>
          </div>
        </div>
      )}

      {/* Header (banner landmark) */}
      <header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur-lg lg:me-72">
        <div className="mx-auto flex h-16 max-w-content items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <button
              ref={hamburgerRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="باز کردن منو"
              aria-expanded={drawerOpen}
              aria-controls="app-drawer"
              className="grid size-11 place-items-center rounded-lg border border-border text-fg-muted transition-colors hover:bg-surface-sunken lg:hidden"
            >
              <Menu aria-hidden size={20} />
            </button>
            <Link href="/explore" className="flex items-center gap-2 lg:hidden">
              <span aria-hidden className="grid size-8 place-items-center rounded-md bg-accent text-xs font-black text-fg-onAccent">
                AS
              </span>
            </Link>
          </div>

          <div className="flex items-center gap-2">
            {viewer && (
              <span className="hidden items-center gap-1.5 rounded-pill bg-accent-soft px-3 py-1.5 text-xs font-bold text-accent sm:inline-flex">
                <span className="numeric">{formatNumber(viewer.credits)}</span>
                اعتبار
              </span>
            )}
            <Link
              href="/notifications"
              aria-label={unread > 0 ? `اعلان‌ها، ${formatNumber(unread)} خوانده‌نشده` : "اعلان‌ها"}
              className="grid size-11 place-items-center rounded-lg border border-border text-fg-muted transition-colors hover:bg-surface-sunken"
            >
              <BadgeAnchor count={unread}>
                <Bell aria-hidden size={19} />
              </BadgeAnchor>
            </Link>
            <ThemeToggle compact />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-content px-4 pb-28 pt-6 sm:px-6 lg:me-72 lg:pb-12">
        {children}
      </main>

      {/* Mobile bottom navigation: the five primary destinations. */}
      <nav
        aria-label="ناوبری پایین"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-lg lg:hidden"
      >
        {PRIMARY_NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? "page" : undefined}
            className="flex min-h-16 flex-col items-center justify-center gap-1 text-[0.6875rem] font-semibold text-fg-subtle transition-colors aria-[current=page]:text-accent"
          >
            <Icon aria-hidden size={20} />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
