"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";

/**
 * Theme switcher with three states, including "system" — a two-way toggle would
 * silently override the user's OS preference.
 *
 * The preference is stored in localStorage and applied by the pre-paint script in
 * the root layout, so there is no flash of the wrong theme on load.
 */

type Mode = "light" | "dark" | "system";

function apply(mode: Mode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && prefersDark));
  document.documentElement.dataset.themePreference = mode;
  localStorage.setItem("theme", mode);
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState<Mode>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    setMode(stored === "light" || stored === "dark" ? stored : "system");
    setMounted(true);
  }, []);

  // Track OS changes while the preference is "system".
  useEffect(() => {
    if (mode !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => apply("system");
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [mode]);

  function change(next: Mode) {
    setMode(next);
    apply(next);
  }

  // Render a stable placeholder until mounted, so SSR and client markup match.
  if (!mounted) {
    return <div className={cn("rounded-pill bg-surface-sunken", compact ? "size-11" : "h-11 w-full")} aria-hidden />;
  }

  if (compact) {
    const next: Mode = mode === "dark" ? "light" : mode === "light" ? "system" : "dark";
    const Icon = mode === "dark" ? Moon : mode === "light" ? Sun : Monitor;
    const labels: Record<Mode, string> = { light: "روشن", dark: "تیره", system: "سیستم" };
    return (
      <button
        type="button"
        onClick={() => change(next)}
        aria-label={`تم فعلی: ${labels[mode]} — تغییر به ${labels[next]}`}
        className="grid size-11 place-items-center rounded-lg border border-border text-fg-muted transition-colors hover:bg-surface-sunken hover:text-fg"
      >
        <Icon aria-hidden size={18} />
      </button>
    );
  }

  return (
    <ToggleGroup<Mode>
      label="حالت نمایش"
      size="sm"
      value={mode}
      onChange={change}
      className="w-full"
      options={[
        { value: "light", label: "روشن" },
        { value: "dark", label: "تیره" },
        { value: "system", label: "سیستم" },
      ]}
    />
  );
}
