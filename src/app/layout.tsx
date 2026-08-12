import type { Metadata, Viewport } from "next";
import { Vazirmatn } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import { env } from "@/lib/env";
import "./globals.css";

/**
 * Root layout.
 *
 * The font is self-hosted through next/font with `display: swap`, so text renders
 * immediately in a fallback and never leaves a blank page; the CSS variable it
 * exposes is the same one the design tokens reference.
 *
 * The theme script runs before paint to avoid a flash of the wrong theme. Its
 * exact bytes are allow-listed by SHA-256 in next.config.ts; script-src does not
 * permit arbitrary inline JavaScript. Inline styles remain required by Next and
 * the component styling stack, so style-src documents that narrower exception.
 */

const vazirmatn = Vazirmatn({
  subsets: ["arabic", "latin"],
  display: "swap",
  variable: "--font-vazirmatn",
});

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
  title: {
    default: "آکادمی حمایت — کشف، حمایت واقعی، رشد",
    template: "%s | آکادمی حمایت",
  },
  description:
    "آکادمی حمایت یک اکوسیستم حمایت متقابل و قابل اعتماد برای سازندگان یوتیوب است: محتوا را کشف کنید، حمایت واقعی و تأییدشده انجام دهید، اعتبار بسازید و دیده شوید.",
  applicationName: "آکادمی حمایت",
  keywords: ["حمایت یوتیوب", "رشد کانال", "جامعه سازندگان", "اعتبار", "کمپین حمایت"],
  openGraph: {
    type: "website",
    locale: "fa_IR",
    siteName: "آکادمی حمایت",
    title: "آکادمی حمایت — کشف، حمایت واقعی، رشد",
    description: "کشف محتوا، حمایت تأییدشده، اعتبار واقعی.",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
  alternates: { canonical: "/" },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1119" },
  ],
  width: "device-width",
  initialScale: 1,
  // Zoom stays available: locking it out is an accessibility failure.
  maximumScale: 5,
};

const themeScript = `(function(){try{
var stored=localStorage.getItem('theme');
var mode=(stored==='light'||stored==='dark'||stored==='system')?stored:'system';
var dark=mode==='dark'||(mode==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.classList.toggle('dark',dark);
document.documentElement.dataset.themePreference=mode;
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className={vazirmatn.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {/* Skip link: first tab stop, so keyboard users can bypass the nav. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-[200] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-fg-onAccent"
        >
          پرش به محتوای اصلی
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
