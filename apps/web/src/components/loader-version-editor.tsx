"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { Wrench, Loader2, Check } from "lucide-react";
import { api, ApiError, fetcher } from "@/lib/api";
import { useDialog } from "./dialog-provider";
import { useT } from "@/lib/i18n";

/**
 * Row + dialog for overriding the server's modloader version.
 *
 * Why this exists: itzg can override the loader version baked into a
 * CurseForge / Modrinth pack manifest (CF needs CF_OVERRIDE_LOADER_VERSION
 * + NEOFORGE_VERSION etc.; Modrinth respects NEOFORGE_VERSION on its own).
 * Without a UI for this, fixing a "pack ships NeoForge 21.1.50, but I
 * need 21.1.95 for mod X" required hand-editing env in the DB.
 *
 * Loader detection:
 *   - Native-loader server types (FORGE / NEOFORGE / FABRIC / QUILT)
 *     map 1:1 to the loader, so we lock the picker to that loader.
 *   - Modpack types (CURSEFORGE / MODRINTH) keep an env hint
 *     (__COFEMINE_PACK_LOADER) when the wizard could derive one;
 *     otherwise the user has to pick the loader explicitly the first
 *     time they open the dialog.
 *   - Vanilla / Paper / Purpur / Spigot / Bukkit don't have a loader
 *     version concept — the row just isn't rendered for them.
 */

type CurrentOverride = {
  loader: "neoforge" | "forge" | "fabric" | "quilt" | null;
  version: string | null;
};

type LoaderVersion = { version: string; stable: boolean };

type ServerLite = {
  id: string;
  type: string;
  version: string;
  env: Record<string, string>;
};

const LOADERS = [
  { id: "neoforge", label: "NeoForge" },
  { id: "forge", label: "Forge" },
  { id: "fabric", label: "Fabric" },
  { id: "quilt", label: "Quilt" },
] as const;
type LoaderId = (typeof LOADERS)[number]["id"];

/** Returns the locked loader for native-loader server types, or null
 *  for modpack / non-loader types where the user has to pick. */
function lockedLoaderFor(type: string): LoaderId | null {
  switch (type) {
    case "FORGE":
      return "forge";
    case "NEOFORGE":
      return "neoforge";
    case "FABRIC":
      return "fabric";
    case "QUILT":
      return "quilt";
    default:
      return null;
  }
}

function supportsLoaderOverride(type: string): boolean {
  switch (type) {
    case "FORGE":
    case "NEOFORGE":
    case "FABRIC":
    case "QUILT":
    case "MODRINTH":
    case "CURSEFORGE":
      return true;
    default:
      return false;
  }
}

export function LoaderVersionRow({
  server,
}: {
  server: ServerLite;
}): JSX.Element | null {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const { data: current } = useSWR<CurrentOverride>(
    supportsLoaderOverride(server.type)
      ? `/servers/${server.id}/loader-version`
      : null,
    fetcher
  );
  if (!supportsLoaderOverride(server.type)) return null;
  const display = current?.version
    ? `${current.loader ?? "?"} ${current.version}`
    : t("loaderVersion.usingPackDefault");
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs">{display}</span>
        <button
          className="btn btn-ghost text-xs"
          onClick={() => setOpen(true)}
        >
          <Wrench size={12} /> {t("loaderVersion.change")}
        </button>
      </div>
      {open && (
        <LoaderVersionDialog
          server={server}
          current={current ?? { loader: null, version: null }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function LoaderVersionDialog({
  server,
  current,
  onClose,
}: {
  server: ServerLite;
  current: CurrentOverride;
  onClose: () => void;
}): JSX.Element {
  const { t } = useT();
  const dialog = useDialog();
  const locked = lockedLoaderFor(server.type);
  const [loader, setLoader] = useState<LoaderId>(
    locked ?? current.loader ?? "neoforge"
  );
  const [version, setVersion] = useState<string>(current.version ?? "");
  const [busy, setBusy] = useState(false);
  const [includeUnstable, setIncludeUnstable] = useState(false);

  // server.version is the literal value the user picked at create time:
  // either a real MC version like "1.21.1" or itzg's "LATEST" sentinel
  // (which means "newest stable Mojang release at boot time"). The
  // loader-versions API needs an actual numeric MC version to filter
  // NeoForge / Forge builds, so we resolve "LATEST" to Mojang's current
  // latest release via /meta/mc-versions and let the user override the
  // resolved value if they want to force a specific MC version.
  const isRealMcVersion = /^1\.\d+(\.\d+)?$/.test(server.version);
  const { data: mcMeta } = useSWR<{
    latest: { release: string; snapshot: string };
  }>(
    !isRealMcVersion ? "/meta/mc-versions?include=release" : null,
    fetcher
  );
  const resolvedMcDefault = isRealMcVersion
    ? server.version
    : mcMeta?.latest?.release ?? "1.21.1";
  const [mcVersion, setMcVersion] = useState<string>(resolvedMcDefault);
  // Keep mcVersion in sync with the resolved default until the user
  // edits it manually — without this, the dropdown stays empty for a
  // tick after Mojang's manifest comes back.
  useEffect(() => {
    setMcVersion(resolvedMcDefault);
  }, [resolvedMcDefault]);

  const { data, isLoading, error } = useSWR<{ versions: LoaderVersion[] }>(
    /^1\.\d+(\.\d+)?$/.test(mcVersion)
      ? `/meta/loader-versions?loader=${loader}&mcVersion=${encodeURIComponent(mcVersion)}`
      : null,
    fetcher
  );

  // When the loader changes, reset to "no specific selection" so the
  // dropdown's first-option fallback below kicks in instead of leaving
  // the previous loader's version dangling. The submit-disable logic
  // also depends on this — empty version = no save.
  useEffect(() => {
    if (current.loader === loader && current.version) {
      setVersion(current.version);
    } else {
      setVersion("");
    }
  }, [loader]);

  const filtered = useMemo(() => {
    const all = data?.versions ?? [];
    return includeUnstable ? all : all.filter((v) => v.stable);
  }, [data, includeUnstable]);

  const [progress, setProgress] = useState<string>("");

  async function save(): Promise<void> {
    if (!version) return;
    setBusy(true);
    setProgress(t("loaderVersion.starting"));
    try {
      await api.post(`/servers/${server.id}/loader-version`, {
        loader,
        version,
        mcVersion,
      });
      // Backend kicked off install in background. Poll status until
      // it transitions to done or failed. Cap total wait at 5 minutes
      // so a wedged installer doesn't trap the user in the dialog.
      const startedAt = Date.now();
      const POLL_MS = 2_000;
      const TIMEOUT_MS = 5 * 60_000;
      let finalMessage = "";
      while (Date.now() - startedAt < TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        let status: {
          state?: string;
          message?: string;
          finishedAt?: number | null;
        };
        try {
          status = await api.get(
            `/servers/${server.id}/loader-version-status`
          );
        } catch {
          // Treat poll errors as transient — keep trying within timeout.
          continue;
        }
        if (status.state === "running") {
          setProgress(status.message ?? t("loaderVersion.installing"));
          continue;
        }
        if (status.state === "done") {
          finalMessage = status.message ?? "";
          break;
        }
        if (status.state === "failed") {
          throw new Error(
            status.message ?? "Installer failed without a message"
          );
        }
        // state === "idle" — somehow the job disappeared. Treat as
        // success since no error was reported, but break out.
        break;
      }
      mutate(`/servers/${server.id}/loader-version`);
      mutate(`/servers/${server.id}`);
      dialog.toast({
        tone: "success",
        message:
          finalMessage ||
          t("loaderVersion.saved", { loader, version }),
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
      setProgress("");
    }
  }

  async function clearOverride(): Promise<void> {
    setBusy(true);
    try {
      await api.post(`/servers/${server.id}/loader-version`, {
        loader: null,
        version: null,
      });
      mutate(`/servers/${server.id}/loader-version`);
      mutate(`/servers/${server.id}`);
      dialog.toast({
        tone: "success",
        message: t("loaderVersion.cleared"),
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
        className="tile p-6 w-full max-w-md space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 className="heading-md">{t("loaderVersion.dialogTitle")}</h3>
          <p className="text-xs text-ink-muted mt-1">
            {t("loaderVersion.dialogSubtitle", {
              mc: isRealMcVersion ? server.version : resolvedMcDefault,
            })}
          </p>
          {!isRealMcVersion && (
            <p className="text-[11px] text-ink-muted mt-1">
              {t("loaderVersion.mcResolvedNote", {
                stored: server.version,
                resolved: resolvedMcDefault,
              })}
            </p>
          )}
        </header>

        <div>
          <label className="text-xs font-medium block mb-1.5">
            {t("loaderVersion.mcVersion")}
          </label>
          <input
            className="input !py-1.5 text-sm w-32 font-mono"
            value={mcVersion}
            onChange={(e) => setMcVersion(e.target.value.trim())}
            placeholder="1.21.1"
          />
          <p className="text-[11px] text-ink-muted mt-1">
            {t("loaderVersion.mcVersionHint")}
          </p>
        </div>

        {locked === null && (
          <div>
            <label className="text-xs font-medium block mb-1.5">
              {t("loaderVersion.loader")}
            </label>
            <div className="flex gap-1 flex-wrap">
              {LOADERS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLoader(l.id)}
                  className={
                    loader === l.id
                      ? "chip chip-accent"
                      : "chip chip-muted hover:bg-surface-2"
                  }
                >
                  {l.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-ink-muted mt-1.5">
              {t("loaderVersion.loaderHint")}
            </p>
          </div>
        )}

        <div>
          <label className="text-xs font-medium block mb-1.5">
            {t("loaderVersion.version")}
          </label>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 size={14} className="animate-spin" />
              {t("common.loading")}
            </div>
          ) : error || filtered.length === 0 ? (
            <p className="text-xs text-ink-muted">
              {t("loaderVersion.noVersions", { loader, mc: mcVersion })}
            </p>
          ) : (
            <select
              className="select w-full !text-sm"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            >
              <option value="">{t("loaderVersion.pickVersion")}</option>
              {filtered.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                  {!v.stable ? " (unstable)" : ""}
                </option>
              ))}
            </select>
          )}
          <label className="inline-flex items-center gap-2 mt-2 text-[11px] text-ink-muted">
            <input
              type="checkbox"
              checked={includeUnstable}
              onChange={(e) => setIncludeUnstable(e.target.checked)}
            />
            {t("loaderVersion.showUnstable")}
          </label>
        </div>

        <p className="text-[11px] text-ink-muted leading-relaxed">
          {t("loaderVersion.repairWarning")}
        </p>
        {busy && progress && (
          <div className="text-xs text-ink-muted flex items-center gap-2 bg-surface-2 rounded-md p-2">
            <Loader2 size={12} className="animate-spin shrink-0" />
            <span>{progress}</span>
          </div>
        )}

        <footer className="flex items-center gap-2 justify-end">
          {current.version && (
            <button
              className="btn btn-ghost text-xs mr-auto"
              onClick={() => void clearOverride()}
              disabled={busy}
            >
              {t("loaderVersion.clearOverride")}
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={busy || !version}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {t("loaderVersion.applyAndRebuild")}
          </button>
        </footer>
      </div>
    </div>
  );
}
