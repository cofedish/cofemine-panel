"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { ServerMap } from "@/components/server-map";
import { fetcher } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Dedicated full-viewport map page. The Map tab on the server detail
 * page also exists, but the live world is the kind of thing you want
 * to leave open in its own browser tab — full screen, no detail-page
 * chrome around it. This is that page.
 */

type Server = { id: string; name: string };

export default function ServerMapPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const { data: server } = useSWR<Server>(
    id ? `/servers/${id}` : null,
    fetcher
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          href={`/servers/${id}`}
          className="btn btn-ghost"
          aria-label={t("server.map.backToServer")}
        >
          <ArrowLeft size={14} /> {server?.name ?? t("server.map.title")}
        </Link>
        <h1 className="heading-lg">{t("server.map.title")}</h1>
        <div className="flex-1" />
        {server && (
          <a
            href={`/servers/${id}/map/embed`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost text-xs"
            title={t("server.map.openInNewTab")}
          >
            {t("server.map.openInNewTab")} <ExternalLink size={12} />
          </a>
        )}
      </div>

      {/* Full-viewport map. The component already has its own internal
          panel layout (toolbar + map + side player list); the dedicated
          page just gives it more vertical real estate than the tab
          version, no other chrome. */}
      <ServerMap serverId={id} fullHeight />
    </div>
  );
}
