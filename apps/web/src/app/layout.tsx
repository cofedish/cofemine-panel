import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { DialogProvider } from "@/components/dialog-provider";
import { I18nProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Cofemine Panel",
  description:
    "Self-hosted, Docker-first control panel for Minecraft servers — live console, backups, Modrinth & CurseForge installers.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
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
