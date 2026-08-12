import type { Config } from "tailwindcss";

/**
 * Tailwind is bound to the CSS custom properties in globals.css, so there is one
 * source of truth for the design system and no component can invent a colour.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-vazirmatn)", "Vazirmatn", "Segoe UI", "Tahoma", "sans-serif"],
        latin: ["Segoe UI", "Inter", "system-ui", "sans-serif"],
      },
      colors: {
        bg: { DEFAULT: "hsl(var(--bg))", subtle: "hsl(var(--bg-subtle))" },
        surface: {
          DEFAULT: "hsl(var(--surface))",
          raised: "hsl(var(--surface-raised))",
          sunken: "hsl(var(--surface-sunken))",
        },
        fg: {
          DEFAULT: "hsl(var(--fg))",
          muted: "hsl(var(--fg-muted))",
          subtle: "hsl(var(--fg-subtle))",
          onAccent: "hsl(var(--fg-on-accent))",
        },
        border: { DEFAULT: "hsl(var(--border))", strong: "hsl(var(--border-strong))" },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          hover: "hsl(var(--accent-hover))",
          soft: "hsl(var(--accent-soft))",
        },
        success: { DEFAULT: "hsl(var(--success))", soft: "hsl(var(--success-soft))" },
        warning: { DEFAULT: "hsl(var(--warning))", soft: "hsl(var(--warning-soft))" },
        danger: { DEFAULT: "hsl(var(--danger))", soft: "hsl(var(--danger-soft))" },
        info: { DEFAULT: "hsl(var(--info))", soft: "hsl(var(--info-soft))" },
        tier: {
          bronze: "hsl(var(--tier-bronze))",
          silver: "hsl(var(--tier-silver))",
          gold: "hsl(var(--tier-gold))",
          platinum: "hsl(var(--tier-platinum))",
          diamond: "hsl(var(--tier-diamond))",
          elite: "hsl(var(--tier-elite))",
        },
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        e1: "var(--shadow-1)",
        e2: "var(--shadow-2)",
        e3: "var(--shadow-3)",
      },
      transitionTimingFunction: {
        standard: "var(--ease-standard)",
        out: "var(--ease-out)",
        in: "var(--ease-in)",
        spring: "var(--ease-spring)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
        slow: "var(--duration-slow)",
      },
      maxWidth: { content: "1400px" },
      screens: { xs: "390px" },
    },
  },
  plugins: [],
};

export default config;
