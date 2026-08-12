import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Content Security Policy.
 *
 * Scoped to the origins the app actually talks to, nothing more:
 *   frame-src   — 'none'. The watch flow opens the video on YouTube itself in a
 *                 new tab, so the app embeds no third-party frame at all. This is
 *                 strictly tighter than the previous youtube-nocookie allowance.
 *   script-src  — self only. The IFrame Player API is no longer loaded, because
 *                 the video is watched on YouTube rather than in the page.
 *                 'unsafe-inline' is required
 *                 twice over: by the pre-paint theme script in layout.tsx, and
 *                 by the inline bootstrap scripts the App Router streams on
 *                 every response (`self.__next_f.push(...)`), which carry the
 *                 RSC payload React needs to hydrate. Those are generated per
 *                 render, so a static SHA-256 allow-list cannot cover them —
 *                 and because CSP Level 3 makes any hash or nonce *disable*
 *                 'unsafe-inline', a hash here would silently block hydration
 *                 and blank the page. Tightening this needs per-request nonces
 *                 from middleware, which forces every route to render
 *                 dynamically; see the note in middleware.ts.
 *                 'unsafe-eval' is dev-only (React refresh) and never shipped.
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
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-src 'none'",
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
