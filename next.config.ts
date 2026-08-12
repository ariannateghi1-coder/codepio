import type { NextConfig } from "next";
import { createHash } from "node:crypto";

const isProd = process.env.NODE_ENV === "production";
const themeScript = `(function(){try{
var stored=localStorage.getItem('theme');
var mode=(stored==='light'||stored==='dark'||stored==='system')?stored:'system';
var dark=mode==='dark'||(mode==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.classList.toggle('dark',dark);
document.documentElement.dataset.themePreference=mode;
}catch(e){}})();`;
const themeScriptHash = createHash("sha256").update(themeScript).digest("base64");

/**
 * Content Security Policy.
 *
 * Scoped to the origins the app actually talks to, nothing more:
 *   frame-src   — youtube-nocookie only, which is why every embed must be built
 *                 through youtubeEmbedUrl(); a youtube.com embed is blocked.
 *   script-src  — self plus the IFrame Player API. 'unsafe-inline' is required by
 *                 the pre-paint theme script; 'unsafe-eval' is dev-only (React
 *                 refresh) and never shipped to production.
 *   connect-src — our own API, Ably (realtime), and the Google APIs the server
 *                 proxies for OAuth token exchange.
 *   img-src     — YouTube thumbnails and Google avatars, plus data: for inline SVG.
 *
 * frame-ancestors 'none' plus X-Frame-Options DENY means this app cannot be
 * embedded anywhere, which removes clickjacking as a class.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob: https://i.ytimg.com https://*.ytimg.com https://*.googleusercontent.com https://yt3.ggpht.com",
  `script-src 'self' 'sha256-${themeScriptHash}'${isProd ? "" : " 'unsafe-eval'"} https://www.youtube.com https://s.ytimg.com`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-src https://www.youtube-nocookie.com",
  "media-src 'self' https://*.googlevideo.com",
  "connect-src 'self' https://*.ably.io https://*.ably-realtime.com wss://*.ably.io wss://*.ably-realtime.com https://www.googleapis.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  images: {
    // Explicit allow-list: user-supplied avatar URLs cannot turn the optimizer
    // into an open image proxy.
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "**.ytimg.com" },
      { protocol: "https", hostname: "**.googleusercontent.com" },
      { protocol: "https", hostname: "yt3.ggpht.com" },
    ],
    formats: ["image/avif", "image/webp"],
  },

  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // API responses must never be cached by a shared cache: they are per-user.
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
