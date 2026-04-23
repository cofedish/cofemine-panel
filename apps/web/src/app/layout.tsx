import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Press_Start_2P } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { DialogProvider } from "@/components/dialog-provider";
import { I18nProvider } from "@/lib/i18n";

// Press Start 2P — the canonical pixel font, close to Minecraft's title
// look. Exposed as --font-pixel so .font-pixel (see globals.css) picks it
// up anywhere in the app.
const pixelFont = Press_Start_2P({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-pixel",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CofePanel",
  description:
    "Self-hosted, Docker-first control panel for Minecraft servers — live console, backups, Modrinth & CurseForge installers.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={pixelFont.variable}
    >
      <body>
        <ThemeProvider>
          <I18nProvider>
            <DialogProvider>{children}</DialogProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
