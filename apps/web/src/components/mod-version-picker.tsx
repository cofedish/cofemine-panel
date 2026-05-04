"use client";
import { useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { Loader2, Check, History } from "lucide-react";
import { api, ApiError, fetcher } from "@/lib/api";
import { useDialog } from "./dialog-provider";
import { useT } from "@/lib/i18n";

/**
 * Per-mod version swap dialog.
 *
 * Why this exists: a Curseforge / Modrinth modpack often ships mods at
 * versions whose interdependencies are subtly broken — Mod A requires
 * Create 6.0.10 but the pack pinned Create 6.0.9, so the server fails
 * to boot. Without per-mod versioning the user had to either (a) wait
 * for the pack author to ship a fix, (b) hand-download the right jar,
 * scp it into /data/mods, and pray. This widget lets them pick a
 * specific version per mod without leaving the panel: it lists every
 * version published on the mod's source provider, filters to the
 * server's MC + loader, and atomically swaps the jar (download new,
 * delete old) so the boot loop breaks cleanly on next start.
 *
 * Works on:
 *   - Modrinth-resolved mods: f.modrinth.slug → /modrinth/projects/.../versions
 *   - CurseForge-resolved mods: f.curseforge.modId → /curseforge/projects/.../versions
 *   - Manual uploads / unidentified jars: button is hidden — there's
 *     no source to pick a version from.
 */

type ModrinthMeta = {
  slug: string;
  title: string;
  versionNumber?: string;
};

type CfMeta = {
  modId: number;
  title: string;
};

type FileLike = {
  name: string;
  modrinth?: ModrinthMeta;
  curseforge?: CfMeta;
};

type ModrinthVersion = {
  id: string;
  versionNumber: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  files: Array<{ url: string; filename: string; primary: boolean }>;
};

type CfVersion = {
  id: string;
  versionNumber: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  files: Array<{ url: string; filename: string; primary: boolean }>;
  distributionBlocked?: boolean;
};

type Kind = "mod" | "plugin" | "datapack";

export function ChangeVersionButton({
  serverId,
  file,
  type,
  serverMcVersion,
  serverLoader,
}: {
  serverId: string;
  file: FileLike;
  type: Kind;
  serverMcVersion: string;
  serverLoader: string;
}): JSX.Element | null {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const provider: "modrinth" | "curseforge" | null = file.modrinth
    ? "modrinth"
    : file.curseforge
      ? "curseforge"
      : null;
  if (!provider) return null;
  return (
    <>
      <button
        type="button"
        className="btn-icon btn-ghost !h-8 !w-8"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={t("modVersion.button")}
        title={t("modVersion.button")}
      >
        <History size={14} />
      </button>
      {open && (
        <ModVersionDialog
          serverId={serverId}
          file={file}
          provider={provider}
          type={type}
          serverMcVersion={serverMcVersion}
          serverLoader={serverLoader}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ModVersionDialog({
  serverId,
  file,
  provider,
  type,
  serverMcVersion,
  serverLoader,
  onClose,
}: {
  serverId: string;
  file: FileLike;
  provider: "modrinth" | "curseforge";
  type: Kind;
  serverMcVersion: string;
  serverLoader: string;
  onClose: () => void;
}): JSX.Element {
  const { t } = useT();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const [includeIncompatible, setIncludeIncompatible] = useState(false);
  const [picked, setPicked] = useState<string>("");

  const projectId =
    provider === "modrinth"
      ? file.modrinth!.slug
      : String(file.curseforge!.modId);
  const title =
    file.modrinth?.title ?? file.curseforge?.title ?? file.name;
  const currentVersionLabel = file.modrinth?.versionNumber;

  // server.version is whatever was stored at create-time. For modpack
  // servers created before we stored the pack's real MC, that's the
  // literal string "LATEST" — useless for filtering versions. Resolve
  // by majority-vote across installed mods' Modrinth/CF gameVersions
  // metadata: the most-common 1.X.Y wins. Falls back to whatever
  // server.version had if nothing useful comes back.
  const isRealMcVersion = /^1\.\d+(\.\d+)?$/.test(serverMcVersion);
  const { data: installed } = useSWR<{
    mods: Array<{
      modrinth?: { gameVersions?: string[] };
      curseforge?: { gameVersions?: string[] };
    }>;
  }>(
    !isRealMcVersion ? `/servers/${serverId}/installed-content` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const effectiveMcVersion = useMemo(() => {
    if (isRealMcVersion) return serverMcVersion;
    const counts = new Map<string, number>();
    for (const m of installed?.mods ?? []) {
      const versions = [
        ...(m.modrinth?.gameVersions ?? []),
        ...(m.curseforge?.gameVersions ?? []),
      ];
      for (const v of versions) {
        if (/^1\.\d+(\.\d+)?$/.test(v)) {
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
    }
    let best = serverMcVersion;
    let bestN = 0;
    for (const [v, n] of counts) {
      if (n > bestN) {
        best = v;
        bestN = n;
      }
    }
    return best;
  }, [isRealMcVersion, serverMcVersion, installed]);

  const queryParams = new URLSearchParams();
  if (effectiveMcVersion) queryParams.set("gameVersion", effectiveMcVersion);
  if (serverLoader) queryParams.set("loader", serverLoader);
  const versionsUrl = `/integrations/${provider}/projects/${encodeURIComponent(
    projectId
  )}/versions?${queryParams.toString()}`;

  const { data: versions, isLoading } = useSWR<
    Array<ModrinthVersion | CfVersion>
  >(versionsUrl, fetcher);

  const filtered = useMemo<Array<ModrinthVersion | CfVersion>>(() => {
    if (!versions) return [];
    if (includeIncompatible) return versions;
    return versions.filter((v) => {
      const mcOk = effectiveMcVersion
        ? v.gameVersions.includes(effectiveMcVersion)
        : true;
      const loaderOk = serverLoader
        ? v.loaders.length === 0 || v.loaders.includes(serverLoader)
        : true;
      return mcOk && loaderOk;
    });
  }, [versions, includeIncompatible, effectiveMcVersion, serverLoader]);

  async function swap(): Promise<void> {
    if (!picked) return;
    setBusy(true);
    try {
      // Step 1: delete the old jar first. itzg picks up mod-folder
      // changes on next boot; doing delete first means even if the
      // install half fails, we don't end up with TWO copies of the
      // same mod in /data/mods (which would cause "duplicate mod"
      // load errors that are scarier than a missing mod).
      await api.del(
        `/servers/${serverId}/installed-content?type=${
          type === "mod" ? "mods" : type === "plugin" ? "plugins" : "datapacks"
        }&name=${encodeURIComponent(file.name)}`
      );
      // Step 2: install the chosen version. The install handlers are
      // mounted under /integrations (panel-api wires integrationsRoutes
      // with that prefix), NOT under /servers — getting that wrong is
      // exactly the 404 "Not Found" the user hit on swap.
      const installPath = `/integrations/servers/${serverId}/install/${provider}`;
      const body: Record<string, unknown> = {
        projectId,
        kind: type,
        gameVersion: effectiveMcVersion,
        loader: serverLoader,
      };
      if (provider === "modrinth") body.versionId = picked;
      else body.fileId = Number(picked);
      await api.post(installPath, body);
      mutate(`/servers/${serverId}/installed-content`);
      dialog.toast({
        tone: "success",
        message: t("modVersion.swapped", { name: title }),
      });
      onClose();
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="tile p-6 w-full max-w-lg space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 className="heading-md">{t("modVersion.title", { name: title })}</h3>
          <p className="text-xs text-ink-muted mt-1">
            {t("modVersion.subtitle", {
              mc: effectiveMcVersion,
              loader: serverLoader || "any",
            })}
            {currentVersionLabel && (
              <>
                {" "}
                {t("modVersion.currentlyInstalled", {
                  v: currentVersionLabel,
                })}
              </>
            )}
          </p>
        </header>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-ink-muted py-6 justify-center">
            <Loader2 size={14} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-ink-muted py-4 leading-relaxed">
            {t("modVersion.noCompatible", {
              mc: effectiveMcVersion,
              loader: serverLoader || "any",
            })}
            <label className="inline-flex items-center gap-2 mt-2 block">
              <input
                type="checkbox"
                checked={includeIncompatible}
                onChange={(e) => setIncludeIncompatible(e.target.checked)}
              />
              {t("modVersion.showAll")}
            </label>
          </div>
        ) : (
          <>
            <div className="max-h-80 overflow-y-auto border border-line rounded-md divide-y divide-line">
              {filtered.map((v) => {
                const isCurrent = v.versionNumber === currentVersionLabel;
                const isPicked = picked === v.id;
                const blocked = (v as CfVersion).distributionBlocked;
                return (
                  <button
                    key={v.id}
                    type="button"
                    disabled={blocked}
                    onClick={() => setPicked(v.id)}
                    className={
                      "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors " +
                      (isPicked
                        ? "bg-[rgb(var(--accent-soft))]"
                        : blocked
                          ? "opacity-50 cursor-not-allowed"
                          : "hover:bg-surface-2")
                    }
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {v.versionNumber}
                        {isCurrent && (
                          <span className="ml-2 text-[10px] text-ink-muted">
                            ({t("modVersion.installed")})
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-ink-muted truncate">
                        {v.gameVersions.slice(0, 4).join(", ")}
                        {v.gameVersions.length > 4 ? "…" : ""}
                        {v.loaders.length > 0
                          ? ` · ${v.loaders.slice(0, 3).join(", ")}`
                          : ""}
                        {blocked
                          ? ` · ${t("modVersion.distributionBlocked")}`
                          : ""}
                      </div>
                    </div>
                    {isPicked && <Check size={14} />}
                  </button>
                );
              })}
            </div>
            <label className="inline-flex items-center gap-2 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={includeIncompatible}
                onChange={(e) => setIncludeIncompatible(e.target.checked)}
              />
              {t("modVersion.showAll")}
            </label>
          </>
        )}

        <p className="text-[11px] text-ink-muted leading-relaxed">
          {t("modVersion.swapNote")}
        </p>

        <footer className="flex items-center gap-2 justify-end">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void swap()}
            disabled={busy || !picked}
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )}
            {t("modVersion.apply")}
          </button>
        </footer>
      </div>
    </div>
  );
}
