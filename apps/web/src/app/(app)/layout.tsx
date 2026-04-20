import type { ReactNode } from "react";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { AuthGate } from "@/components/auth-gate";
import { PageFade } from "@/components/motion";

export default function AppLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <AuthGate>
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col">
          <Topbar />
          <main className="flex-1 px-6 py-8 max-w-[1400px] w-full mx-auto">
            <PageFade>{children}</PageFade>
          </main>
        </div>
      </div>
    </AuthGate>
  );
}
