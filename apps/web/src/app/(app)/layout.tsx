import type { ReactNode } from "react";
import { TopNav } from "@/components/top-nav";
import { AuthGate } from "@/components/auth-gate";
import { PageFade } from "@/components/motion";

export default function AppLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <AuthGate>
      <div className="min-h-screen flex flex-col">
        <TopNav />
        <main className="flex-1 w-full max-w-[1400px] mx-auto px-6 py-10">
          <PageFade>{children}</PageFade>
        </main>
        <footer className="border-t border-line py-4">
          <div className="max-w-[1400px] mx-auto px-6 text-xs text-ink-muted flex items-center justify-between">
            <span>Cofemine Panel · v0.1.0</span>
            <span>Self-hosted · Docker-first</span>
          </div>
        </footer>
      </div>
    </AuthGate>
  );
}
