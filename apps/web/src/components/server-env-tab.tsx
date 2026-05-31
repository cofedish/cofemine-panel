"use client";
import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { Loader2, Save } from "lucide-react";
import { api, ApiError, fetcher } from "@/lib/api";
import { EnvForm } from "@/components/env-form";
import { useDialog } from "@/components/dialog-provider";
import { useT } from "@/lib/i18n";

/**
 * Environment variable editor for an existing server. Reuses the same
 * EnvForm the new-server wizard uses — same grouping, same search, same
 * field types. Save → PATCH /servers/:id with the full env object,
 * panel-internal sentinels (those starting with __COFEMINE_) included
 * so the operator can manually flip install-time proxy, decouple-after-
 * boot, etc. when the watchdog can't figure it out on its own.
 *
 * Local-only dirty tracking: changes don't ship until "Save" is clicked,
 * so an accidental click on a toggle doesn't immediately reprovision
 * the container.
 */
export function ServerEnvTab({ serverId }: { serverId: string }): JSX.Element {
  const { t } = useT();
  const dialog = useDialog();
  const { data: server } = useSWR<{
    type: string;
    env: Record<string, string>;
  }>(`/servers/${serverId}`, fetcher);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed draft from server data once it arrives. Don't reseed on every
  // SWR revalidate — that would clobber the user's in-progress edits.
  useEffect(() => {
    if (server && !dirty) setDraft(server.env);
  }, [server?.env, dirty]);

  function onChange(next: Record<string, string>): void {
    setDraft(next);
    setDirty(true);
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await api.patch(`/servers/${serverId}`, { env: draft });
      mutate(`/servers/${serverId}`);
      setDirty(false);
      dialog.toast({ tone: "success", message: t("common.saved") });
    } catch (e) {
      dialog.alert({
        tone: "danger",
        title: t("common.error"),
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  function discard(): void {
    if (!server) return;
    setDraft(server.env);
    setDirty(false);
  }

  if (!server) {
    return (
      <div className="tile p-10 text-center text-ink-muted">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="tile p-4 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium">{t("server.env.title")}</h3>
          <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
            {t("server.env.intro")}
          </p>
        </div>
        <button
          className="btn btn-ghost"
          onClick={discard}
          disabled={!dirty || saving}
        >
          {t("server.env.discard")}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          {t("common.save")}
        </button>
      </div>

      <EnvForm
        env={draft}
        onChange={onChange}
        currentType={server.type}
      />
    </div>
  );
}
