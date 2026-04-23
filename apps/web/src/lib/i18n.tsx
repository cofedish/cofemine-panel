"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Dead-simple i18n: a nested string dictionary, a `useT()` hook, and a
 * language toggle persisted in localStorage. No pluralisation rules, no
 * date formatters — we just need panel strings in ru/en.
 *
 * Keys are namespaced by feature (server.*, content.*, common.*) so we
 * can find the relevant translation without scanning the whole dict.
 */
export type Lang = "en" | "ru";

type Dict = Record<string, string>;

const en: Dict = {
  "common.ok": "OK",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.save": "Save",
  "common.close": "Close",
  "common.retry": "Retry",
  "common.yes": "Yes",
  "common.no": "No",
  "common.loading": "Loading…",
  "common.done": "Done",
  "common.error": "Error",
  "common.success": "Success",
  "common.warning": "Warning",
  "common.refresh": "Refresh",
  "common.download": "Download",

  "lang.label": "Language",
  "lang.en": "English",
  "lang.ru": "Русский",

  "server.start": "Start",
  "server.stop": "Stop",
  "server.restart": "Restart",
  "server.kill": "Kill",
  "server.clone": "Clone",
  "server.repair": "Repair",
  "server.delete": "Delete",
  "server.deleteConfirm.title": "Delete server?",
  "server.deleteConfirm.body":
    "Server \"{name}\" will be stopped and completely removed. This is irreversible.",
  "server.repairConfirm.title": "Rebuild the container?",
  "server.repairConfirm.body":
    "Reprovision the container with current integration keys. The world and /data are preserved — only the container itself is recreated.",
  "server.repair.doneChanged":
    "Container rebuilt with updated env. You can start the server now.",
  "server.repair.doneUnchanged":
    "Container rebuilt. No env changes were needed.",

  "content.installedBadge": "Installed",
  "content.installConfirm.delete.title": "Delete file?",
  "content.installConfirm.delete.body": "Delete {name}?",
  "content.installed.empty": "No {type} installed yet.",
  "content.installed.noMatch": "No {type} match \"{q}\".",
  "content.failures.title": "Failed CurseForge downloads",
  "content.failures.noIds.title": "No mod IDs available",
  "content.failures.noIds.body":
    "No CurseForge mod IDs could be parsed from the logs. Use \"Find on Modrinth\" per mod instead.",
  "content.skipConfirm.title": "Skip failing mods?",
  "content.skipConfirm.body":
    "Add {n} mod ID(s) to CF_EXCLUDE_MODS and rebuild the container. The pack will install without the failing mods. The world and /data are preserved.",
  "content.skipDone":
    "Done. {n} mod(s) will be skipped on next start. Press Start to retry the install.",
  "content.autoConfirm.title": "Search Modrinth for all?",
  "content.autoConfirm.body":
    "Search Modrinth for {n} failing mod(s) and auto-install the best match for each. Failed mods that resolve will be added to CF_EXCLUDE_MODS so the pack stops retrying them. The world and /data are preserved.",
  "content.autoSummary.title": "Modrinth auto-install",
  "content.autoSummary.installed": "Installed: {n}",
  "content.autoSummary.noMatch": "No match on Modrinth: {n}",
  "content.autoSummary.errors": "Errors: {n}",
  "content.autoSummary.installedStatus":
    "{n} mod(s) installed from Modrinth. Start the server to retry.",
  "content.autoSummary.nothingInstalled": "No Modrinth replacements installed.",

  "diagnostics.deleteConfirm.title": "Delete crash report?",
  "diagnostics.deleteConfirm.body": "Delete {name}?",
  "diagnostics.empty":
    "No crash reports. The server hasn't crashed — or someone already cleaned them up.",

  "files.deleteConfirm.title": "Delete file?",
  "files.deleteConfirm.body": "Delete {path}?",

  "backups.restoreConfirm.title": "Restore from backup?",
  "backups.restoreConfirm.body":
    "Restore server data from this backup? Current /data will be overwritten.",
  "backups.deleteConfirm.title": "Delete backup?",
  "backups.deleteConfirm.body": "Delete backup \"{name}\"? This is irreversible.",

  "admin.removeUserConfirm.title": "Remove user?",
  "admin.removeUserConfirm.body":
    "Remove {username} from the panel? This deletes their account.",

  "infra.removeNodeConfirm.title": "Remove node?",
  "infra.removeNodeConfirm.body": "Remove node \"{name}\"?",
  "infra.removeIntegrationConfirm.title": "Remove key?",
  "infra.removeIntegrationConfirm.body":
    "Remove this integration key? The key will be cleared from the database.",
};

const ru: Dict = {
  "common.ok": "ОК",
  "common.cancel": "Отмена",
  "common.delete": "Удалить",
  "common.save": "Сохранить",
  "common.close": "Закрыть",
  "common.retry": "Повторить",
  "common.yes": "Да",
  "common.no": "Нет",
  "common.loading": "Загрузка…",
  "common.done": "Готово",
  "common.error": "Ошибка",
  "common.success": "Успех",
  "common.warning": "Внимание",
  "common.refresh": "Обновить",
  "common.download": "Скачать",

  "lang.label": "Язык",
  "lang.en": "English",
  "lang.ru": "Русский",

  "server.start": "Запустить",
  "server.stop": "Остановить",
  "server.restart": "Перезапустить",
  "server.kill": "Убить",
  "server.clone": "Клонировать",
  "server.repair": "Починить",
  "server.delete": "Удалить",
  "server.deleteConfirm.title": "Удалить сервер?",
  "server.deleteConfirm.body":
    "Сервер «{name}» будет остановлен и полностью удалён. Это действие необратимо.",
  "server.repairConfirm.title": "Пересобрать контейнер?",
  "server.repairConfirm.body":
    "Пересоздать контейнер с текущими ключами интеграций. Мир и /data сохраняются — пересоздаётся только сам контейнер.",
  "server.repair.doneChanged":
    "Контейнер пересобран с обновлённым окружением. Можно запускать сервер.",
  "server.repair.doneUnchanged":
    "Контейнер пересобран. Изменений окружения не потребовалось.",

  "content.installedBadge": "Установлено",
  "content.installConfirm.delete.title": "Удалить файл?",
  "content.installConfirm.delete.body": "Удалить {name}?",
  "content.installed.empty": "Пока нет установленных {type}.",
  "content.installed.noMatch": "{type}, подходящих под «{q}», нет.",
  "content.failures.title": "Не удалось скачать моды CurseForge",
  "content.failures.noIds.title": "ID модов не найдены",
  "content.failures.noIds.body":
    "Не удалось извлечь ID модов CurseForge из логов. Используйте кнопку «Найти на Modrinth» для каждого мода.",
  "content.skipConfirm.title": "Пропустить упавшие моды?",
  "content.skipConfirm.body":
    "Добавить {n} ID в CF_EXCLUDE_MODS и пересобрать контейнер. Сборка установится без проблемных модов. Мир и /data сохраняются.",
  "content.skipDone":
    "Готово. {n} мод(ов) будут пропущены при следующем старте. Нажмите «Запустить» для повторной попытки.",
  "content.autoConfirm.title": "Искать замены на Modrinth?",
  "content.autoConfirm.body":
    "Искать на Modrinth {n} упавших мод(ов) и автоматически установить лучшее совпадение. Найденные моды попадут в CF_EXCLUDE_MODS, чтобы сборка перестала их пытаться скачать. Мир и /data сохраняются.",
  "content.autoSummary.title": "Автоустановка с Modrinth",
  "content.autoSummary.installed": "Установлено: {n}",
  "content.autoSummary.noMatch": "Не найдено на Modrinth: {n}",
  "content.autoSummary.errors": "Ошибок: {n}",
  "content.autoSummary.installedStatus":
    "{n} мод(ов) установлено с Modrinth. Запустите сервер для повтора.",
  "content.autoSummary.nothingInstalled":
    "Замен на Modrinth не установлено.",

  "diagnostics.deleteConfirm.title": "Удалить отчёт о крэше?",
  "diagnostics.deleteConfirm.body": "Удалить {name}?",
  "diagnostics.empty":
    "Отчётов о крэшах нет. Сервер не падал — или их уже почистили.",

  "files.deleteConfirm.title": "Удалить файл?",
  "files.deleteConfirm.body": "Удалить {path}?",

  "backups.restoreConfirm.title": "Восстановить из бэкапа?",
  "backups.restoreConfirm.body":
    "Восстановить данные сервера из этого бэкапа? Текущий /data будет перезаписан.",
  "backups.deleteConfirm.title": "Удалить бэкап?",
  "backups.deleteConfirm.body":
    "Удалить бэкап «{name}»? Это действие необратимо.",

  "admin.removeUserConfirm.title": "Удалить пользователя?",
  "admin.removeUserConfirm.body":
    "Удалить {username} из панели? Аккаунт будет удалён.",

  "infra.removeNodeConfirm.title": "Удалить ноду?",
  "infra.removeNodeConfirm.body": "Удалить ноду «{name}»?",
  "infra.removeIntegrationConfirm.title": "Удалить ключ?",
  "infra.removeIntegrationConfirm.body":
    "Удалить этот ключ интеграции? Он будет удалён из базы.",
};

const DICTS: Record<Lang, Dict> = { en, ru };

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const LangContext = createContext<Ctx | null>(null);

export function I18nProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    const saved = (typeof localStorage !== "undefined" &&
      (localStorage.getItem("cofemine-lang") as Lang | null)) as Lang | null;
    if (saved && (saved === "en" || saved === "ru")) {
      setLangState(saved);
      return;
    }
    // Auto-detect from navigator language on first visit.
    if (typeof navigator !== "undefined") {
      const n = navigator.language.toLowerCase();
      if (n.startsWith("ru")) setLangState("ru");
    }
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("cofemine-lang", l);
    } catch {}
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = DICTS[lang];
      const raw = dict[key] ?? DICTS.en[key] ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, k) =>
        k in vars ? String(vars[k]) : `{${k}}`
      );
    },
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useT(): Ctx {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useT must be used inside <I18nProvider>");
  return ctx;
}
