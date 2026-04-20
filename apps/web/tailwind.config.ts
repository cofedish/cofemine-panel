import type { Config } from "tailwindcss";

/** Helper to wire a CSS var into Tailwind's alpha-aware color system. */
const v = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: v("--bg-base"),
        surface: {
          1: v("--bg-surface-1"),
          2: v("--bg-surface-2"),
          3: v("--bg-surface-3"),
        },
        line: {
          DEFAULT: v("--border"),
          strong: v("--border-strong"),
        },
        ink: {
          DEFAULT: v("--fg-primary"),
          secondary: v("--fg-secondary"),
          muted: v("--fg-muted"),
        },
        accent: {
          DEFAULT: v("--accent"),
          hover: v("--accent-hover"),
          soft: v("--accent-soft"),
          ink: v("--accent-ink"),
        },
        danger: {
          DEFAULT: v("--danger"),
          soft: v("--danger-soft"),
        },
        success: {
          DEFAULT: v("--success"),
          soft: v("--success-soft"),
        },
        warning: v("--warning"),
      },
      borderRadius: {
        DEFAULT: "0.625rem",
        lg: "0.875rem",
        xl: "1rem",
        "2xl": "1.25rem",
      },
      boxShadow: {
        soft: "var(--shadow-1)",
        lift: "var(--shadow-2)",
        hover: "var(--shadow-lift)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        display: [
          '"Plus Jakarta Sans"',
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      ringColor: {
        DEFAULT: v("--ring"),
      },
      keyframes: {
        "subtle-bob": {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-2px)" },
        },
      },
      animation: {
        "subtle-bob": "subtle-bob 3.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
