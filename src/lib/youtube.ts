/**
 * YouTube URL parsing and video-id validation.
 *
 * Deliberately strict: only the exact hosts YouTube actually serves are accepted,
 * matched against an allow-list rather than a `endsWith("youtube.com")` test —
 * that older check accepted `evil-youtube.com` and `youtube.com.attacker.net`.
 *
 * This module is isomorphic (no server-only imports) so both the client form and
 * the API route validate identically.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** Hosts allowed for watch/shorts/embed links. */
const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** Hosts allowed for the short link form. */
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

export function isValidYoutubeVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

export function isValidYoutubeChannelId(value: string): boolean {
  return CHANNEL_ID.test(value);
}

/**
 * Extracts a video id from any supported YouTube URL form, or null.
 * Supported: /watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/.
 */
export function extractYoutubeVideoId(raw: string): string | null {
  if (!raw || raw.length > 2048) return null;

  // A bare id is accepted so users can paste just the id.
  if (VIDEO_ID.test(raw.trim())) return raw.trim();

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase();

  if (SHORT_HOSTS.has(host)) {
    return normalize(url.pathname.split("/")[1] ?? "");
  }

  if (!WATCH_HOSTS.has(host)) return null;

  if (url.pathname === "/watch") return normalize(url.searchParams.get("v") ?? "");

  const match = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
  if (match) return normalize(match[2]);

  return null;
}

function normalize(candidate: string): string | null {
  const value = candidate.trim();
  return VIDEO_ID.test(value) ? value : null;
}

/**
 * Extracts a channel id from a channel URL. Handle URLs (/@name, /c/name,
 * /user/name) do NOT contain the canonical id, so they resolve to null and the
 * caller must look them up via the API rather than guessing.
 */
export function extractYoutubeChannelId(raw: string): string | null {
  if (CHANNEL_ID.test(raw.trim())) return raw.trim();
  try {
    const url = new URL(raw.trim());
    if (!WATCH_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Canonical watch URL, used for display and outbound links. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Privacy-preserving embed origin. youtube-nocookie.com is what the CSP
 * frame-src allows, so an embed built any other way is blocked by design.
 */
export function youtubeEmbedUrl(videoId: string, opts?: { origin?: string; enableJsApi?: boolean }): string {
  const params = new URLSearchParams({
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
  });
  if (opts?.enableJsApi) params.set("enablejsapi", "1");
  if (opts?.origin) params.set("origin", opts.origin);
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

export function youtubeThumbnailUrl(videoId: string, quality: "default" | "mq" | "hq" | "maxres" = "hq"): string {
  const file = quality === "default" ? "default" : quality === "mq" ? "mqdefault" : quality === "hq" ? "hqdefault" : "maxresdefault";
  return `https://i.ytimg.com/vi/${videoId}/${file}.jpg`;
}

/** ISO-8601 duration (PT1H2M3S) → seconds. Returns null for unparsable input. */
export function parseIsoDuration(iso: string): number | null {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return null;
  const [, d, h, m, s] = match;
  const seconds = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (v: number) => String(v).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
