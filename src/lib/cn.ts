import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges conditional class names and resolves Tailwind conflicts predictably. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Persian-locale number formatting for display figures. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat("fa-IR").format(value);
}

/** Compact form for large counts (12.3K), still locale-aware. */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat("fa-IR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("fa-IR").format(Math.round(value))}٪`;
}

/** Seconds → m:ss / h:mm:ss, always LTR so it isn't mirrored inside RTL text. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (v: number) => String(v).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "۳ روز پیش" style relative time, computed without a date library. */
export function formatRelativeTime(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat("fa-IR", { numeric: "auto" });

  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (absolute >= seconds) return formatter.format(Math.round(diffSeconds / seconds), unit);
  }
  return formatter.format(diffSeconds, "second");
}

export function formatDate(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(date);
}

export function formatDateTime(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Groups a list by a date key, for date-grouped notification lists. */
export function groupByDay<T>(items: T[], getDate: (item: T) => Date | string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const raw = getDate(item);
    const date = typeof raw === "string" ? new Date(raw) : raw;
    const key = date.toISOString().slice(0, 10);
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  return [...groups.entries()].map(([key, entries]) => ({
    key,
    label: key === today ? "امروز" : key === yesterday ? "دیروز" : formatDate(new Date(key)),
    items: entries,
  }));
}
