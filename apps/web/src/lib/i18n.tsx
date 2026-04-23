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

  "theme.label": "Theme",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system": "System",
  "theme.mode": "Mode",
  "theme.accent": "Accent",

  "menu.settings": "Settings",
  "menu.signOut": "Sign out",

  "nav.dashboard": "Dashboard",
  "nav.infrastructure": "Infrastructure",
  "nav.integrations": "Integrations",
  "nav.administration": "Administration",

  "dashboard.title": "Dashboard",
  "dashboard.subtitle": "A live view of every Minecraft server you operate.",
  "dashboard.newServer": "New server",
  "dashboard.stats.servers": "Servers",
  "dashboard.stats.running": "Running",
  "dashboard.stats.nodes": "Nodes online",
  "dashboard.stats.players": "Total players",
  "dashboard.stats.noneYet": "none yet",
  "dashboard.stats.idle": "{n} idle",
  "dashboard.stats.runningNote": "{n} running",
  "dashboard.stats.dockerHosts": "Docker hosts",
  "dashboard.stats.liveAcrossServers": "live across servers",
  "dashboard.yourServers": "Your servers",
  "dashboard.total": "{n} total",
  "dashboard.empty": "Empty",
  "dashboard.startFirst.title": "Start your first server",
  "dashboard.startFirst.body":
    "Pick a type (Vanilla, Paper, Fabric, Forge…), choose a version, and we'll bring up a fresh Minecraft container for you.",
  "dashboard.createServer": "Create server",

  "tile.players": "Players",
  "tile.memory": "Memory",
  "tile.port": "Port",
  "tile.node": "Node",
  "tile.lastStart": "Last start {ago}",
  "tile.lastStartLabel": "Last start",
  "tile.neverStarted": "never started",

  "server.tabs.overview": "Overview",
  "server.tabs.console": "Console",
  "server.tabs.files": "Files",
  "server.tabs.properties": "Properties",
  "server.tabs.backups": "Backups",
  "server.tabs.schedules": "Schedules",
  "server.tabs.content": "Mods & Plugins",
  "server.tabs.diagnostics": "Diagnostics",
  "server.hero.serverType": "Server type",
  "server.hero.version": "Version",
  "server.hero.cpu": "CPU",
  "server.hero.memoryLimit": "{mb} MB limit",
  "server.overview.runtime": "Runtime configuration",
  "server.overview.memoryLimit": "Memory limit",
  "server.overview.cpuLimit": "CPU limit",
  "server.overview.unlimited": "unlimited",
  "server.overview.ports": "Ports",
  "server.overview.env": "Env vars",
  "server.overview.envNone": "none",
  "server.overview.players": "Players online",
  "server.overview.noPlayers": "No players online right now.",
  "server.overview.rconHint":
    "Player list is fetched from the server via RCON. Start the server to see players here.",
  "server.icon.title": "Server icon",
  "server.icon.body":
    "Shown next to the MOTD in the in-game server list. Upload any image — we'll crop to a square and save as a 64×64 PNG.",
  "server.icon.save": "Save icon",
  "server.icon.saving": "Saving…",
  "server.icon.remove": "Remove saved icon",
  "server.icon.saved": "Icon saved.",
  "server.icon.removed": "Icon removed.",

  "content.tabs.installed": "Installed",
  "content.tabs.browse": "Browse & install",
  "content.installed.filter": "Filter…",
  "content.installed.loading": "Loading…",
  "content.browse.searchPlaceholder": "Search {provider} {kind}s…",
  "content.browse.mcVersion": "MC version (e.g. 1.21.1)",
  "content.browse.anyLoader": "any loader",
  "content.browse.kind.mod": "mod",
  "content.browse.kind.modpack": "modpack",
  "content.browse.kind.plugin": "plugin",
  "content.browse.kind.datapack": "datapack",
  "content.browse.searching": "Searching…",
  "content.browse.results": "{n} result(s){more}",
  "content.browse.loadMore": "Load more",
  "content.browse.loadingMore": "Loading…",
  "content.browse.noMatch": "Nothing matches. Try a different query.",
  "content.browse.noResults": "No results available.",
  "content.browse.cfKeyMissing":
    "CurseForge requires an API key. Go to Integrations and paste one in. Without a key, CurseForge mods can still be installed manually by uploading the JAR to the mods/ folder in the File manager.",
  "content.install": "Install",
  "content.installing": "Installing…",
  "content.modpack.installed":
    "{name} installed. Restart the server to apply.",
  "content.mod.installed":
    "{name} installed. Restart the server to load it.",
  "content.failures.desc":
    "{n} mod(s) the pack couldn't fetch automatically — the mod authors disabled third-party downloads. Skip failures & retry adds them to CF_EXCLUDE_MODS so itzg installs the rest. After that, use Find on Modrinth per mod to drop in open-source replacements.",
  "content.skipRetry": "Skip failures & retry",
  "content.skipRetry.applying": "Applying…",
  "content.tryModrinthAll": "Try Modrinth for all",
  "content.tryModrinthAll.busy": "Searching Modrinth…",
  "content.findOnModrinth": "Find on Modrinth",
  "content.curseforge": "CurseForge",
  "content.installRepairFailed":
    "Install succeeded but repair failed: {msg}",

  "diagnostics.title": "Crash reports",
  "diagnostics.subtitle":
    "Generated by the game when the server throws an uncaught error. Stored in /data/crash-reports and JVM hs_err_pid*.log files at the root.",
  "diagnostics.kind.mc": "MC crash",
  "diagnostics.kind.jvm": "JVM crash",
  "diagnostics.suspects": "suspects:",
  "diagnostics.time": "Time",
  "diagnostics.description": "Description",
  "diagnostics.exception": "Exception",
  "diagnostics.suspectPackages": "Suspect packages",
  "diagnostics.fullReport": "Full report",
  "diagnostics.loadingReport": "Loading report…",

  "infra.title": "Infrastructure",
  "infra.subtitle":
    "Docker hosts (nodes) that run your Minecraft server containers. Each node runs its own agent; the panel talks to them over a shared secret.",
  "infra.addNode": "Add node",
  "infra.online": "{n} / {total} online",

  "admin.tabs.users": "Users",
  "admin.tabs.audit": "Audit log",
  "admin.users.title": "Panel users",
  "admin.users.invite": "Invite user",
  "admin.users.table.user": "User",
  "admin.users.table.email": "Email",
  "admin.users.table.role": "Role",
  "admin.users.table.joined": "Joined",

  "time.secondsAgo": "{n}s ago",
  "time.minutesAgo": "{n}m ago",
  "time.hoursAgo": "{n}h ago",
  "time.daysAgo": "{n}d ago",

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

  "auth.login.title": "Sign in",
  "auth.login.subtitle": "Welcome back. Enter your credentials to continue.",
  "auth.login.usernameOrEmail": "Username or email",
  "auth.login.password": "Password",
  "auth.login.submit": "Sign in",
  "auth.login.submitting": "Signing in…",
  "auth.login.failed": "Login failed",
  "auth.shell.title": "Minecraft servers, without the yak-shaving.",
  "auth.shell.subtitle":
    "Create, scale, and operate containers for Paper, Vanilla, Fabric, Forge and friends — with live consoles, backups, and mod installers built in.",
  "auth.shell.quote":
    "Spin up Paper 1.21 in under a minute; the panel handles EULA, RCON and volumes for you.",
  "auth.shell.cite": "Cofemine docs",
  "auth.shell.footer": "Self-hosted · Docker-first",

  "setup.title": "First-run setup",
  "setup.subtitle": "Create the OWNER account. Runs once.",
  "setup.email": "Email",
  "setup.username": "Username",
  "setup.password": "Password",
  "setup.passwordHint": "min 8 characters",
  "setup.submit": "Create owner account",
  "setup.submitting": "Creating…",
  "setup.failed": "Setup failed",
  "setup.shell.title": "Welcome.",
  "setup.shell.subtitle":
    "Let's create the first account. This person becomes the OWNER and can invite others later.",
  "setup.shell.quote":
    "Roles are enforced at the API layer, audited in the panel, and default to least-privilege.",
  "setup.shell.cite": "Security model",

  "wizard.title": "New server",
  "wizard.back": "Back",
  "wizard.next": "Next",
  "wizard.create": "Create server",
  "wizard.creating": "Creating…",
  "wizard.step.basics": "Basics",
  "wizard.step.source": "Source",
  "wizard.step.resources": "Resources",
  "wizard.step.review": "Review",
  "wizard.name": "Server name",
  "wizard.description": "Description (optional)",
  "wizard.type": "Server type",
  "wizard.version": "Minecraft version",
  "wizard.source": "Source",
  "wizard.source.plain": "Plain",
  "wizard.source.modrinth": "Modrinth pack",
  "wizard.source.curseforge": "CurseForge pack",
  "wizard.modpack.search": "Search packs…",
  "wizard.modpack.picked": "Picked",
  "wizard.modpack.clear": "Clear",
  "wizard.resources.memory": "Memory",
  "wizard.resources.cpu": "CPU limit",
  "wizard.resources.cpuHint": "cores (empty = no limit)",
  "wizard.resources.port": "Host port",
  "wizard.eula": "Accept Minecraft EULA",
  "wizard.eulaDesc":
    "By checking this you agree to the Minecraft EULA. Required to boot the server.",
  "wizard.env": "Extra environment variables",
  "wizard.review.intro":
    "Double-check the summary — after creation the container starts automatically if EULA is accepted.",
  "wizard.icon": "Server icon",
  "wizard.iconHint": "Optional — auto-resized to 64×64 PNG.",
  "wizard.source.plainDesc":
    "Pick a server type (Vanilla, Paper, Fabric, Forge…) and an MC version. Fast and minimal.",
  "wizard.source.modrinthDesc":
    "Search modpacks on modrinth.com. The runtime auto-detects loader + version from the pack.",
  "wizard.source.curseforgeDesc":
    "Search modpacks on curseforge.com. Requires a CurseForge API key in Integrations.",
  "wizard.source.meta.plain": "8 types",
  "wizard.source.meta.modrinth": "auto-detected",
  "wizard.source.meta.curseforgeOk": "auto-detected",
  "wizard.source.meta.curseforgeMissing": "needs API key",
  "wizard.source.cfDisabledHint":
    "Configure a CurseForge API key first.",
  "wizard.source.selected": "Selected",

  "settings.title": "Settings",
  "settings.subtitle":
    "Customize how the panel looks and behaves for your account.",
  "settings.appearance": "Appearance",
  "settings.profile": "Profile",
  "settings.avatar": "Profile avatar",
  "settings.avatarHint": "Auto-resized to 128×128 PNG before upload.",
  "settings.saveAvatar": "Save avatar",
  "settings.removeAvatar": "Remove avatar",
  "settings.avatarSaved": "Avatar saved.",
  "settings.avatarRemoved": "Avatar removed.",
  "settings.account": "Account",
  "settings.about": "About",
  "settings.aboutText":
    "Cofemine Panel v0.1.0 — self-hosted, Docker-first Minecraft control panel.",
  "settings.username": "Username",
  "settings.email": "Email",
  "settings.role": "Role",
  "settings.theme.mode": "Mode",
  "settings.theme.accent": "Accent",

  "integrations.title": "Integrations",
  "integrations.subtitle":
    "Providers the panel uses to search and install mods / packs. Modrinth is free and always on; CurseForge needs an API key.",
  "integrations.modrinth.desc":
    "Public API — enabled by default. No credentials required.",
  "integrations.curseforge.desc":
    "Requires a CurseForge Studios API key. Without a key, users can still upload JAR files manually.",
  "integrations.apiKey": "API key",
  "integrations.apiKeyPlaceholder":
    "cf-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "integrations.apiKeySaved":
    "Saved encrypted in the database — not readable after save.",
  "integrations.save": "Save",
  "integrations.saving": "Saving…",
  "integrations.remove": "Remove",
  "integrations.enabled": "Enabled",
  "integrations.disabled": "Disabled",
  "integrations.getKey": "Get a key",

  "proxy.title": "Download proxy",
  "proxy.tagline": "Optional SOCKS / HTTP proxy for modpack install",
  "proxy.subtitle":
    "Optional proxy routed *only* through the Java HTTP client that downloads mod jars during install. The MC server itself keeps its direct connection — not routed through this proxy.",
  "proxy.cardDesc":
    "Use when forgecdn.net / Modrinth CDN is unreliable from your region. Enable per-server via the Retry banner; direct connections are default.",
  "proxy.detailsIntro":
    "Stored encrypted in the panel database. Applied to a server's install phase only when you opt-in that server (Retry via proxy button).",
  "proxy.enable": "Enable (available to be used by servers)",
  "proxy.protocol": "Protocol",
  "proxy.host": "Host",
  "proxy.port": "Port",
  "proxy.username": "Username",
  "proxy.password": "Password",
  "proxy.optional": "optional",
  "proxy.passwordStored": "stored",
  "proxy.notConfigured": "Not configured",
  "proxy.configuredButOff": "Configured — off",
  "proxy.helperNote":
    "When this proxy is enabled AND a server is marked to use it, JAVA_TOOL_OPTIONS is injected with the matching JVM flags (SOCKS or HTTP). The MC server's own HTTP traffic goes through these flags too while the flag is on — turn it off after install succeeds to keep MC direct.",
  "proxy.useOnServer": "Retry install via proxy",
  "proxy.disableOnServer": "Stop using proxy for this server",
  "proxy.toggle.busy": "Switching…",
  "proxy.toggle.needConfigTitle": "Download proxy is not configured",
  "proxy.toggle.needConfigBody":
    "Set up host, port and (optionally) credentials in Integrations → Download proxy, enable it, then come back and try again.",
  "proxy.enabledOnServer":
    "Install is currently routed through the download proxy. After the server boots, turn it off so MC's own connections stay direct.",

  "backups.create": "Create backup",
  "backups.creating": "Creating…",
  "backups.restore": "Restore",
  "backups.delete": "Delete",
  "backups.empty": "No backups yet. Click Create backup to snapshot /data.",
  "backups.name": "Name",
  "backups.size": "Size",
  "backups.status": "Status",
  "backups.created": "Created",
  "backups.finished": "Finished",

  "schedules.title": "Schedules",
  "schedules.subtitle":
    "Cron-driven actions: restarts, backups, and command runs.",
  "schedules.add": "Add schedule",
  "schedules.name": "Name",
  "schedules.cron": "Cron",
  "schedules.action": "Action",
  "schedules.nextRun": "Next run",
  "schedules.enabled": "Enabled",
  "schedules.empty": "No schedules yet.",

  "properties.title": "server.properties",
  "properties.subtitle":
    "Typed editor with inline hints. Changes are written back to the file and require a restart to take effect.",
  "properties.save": "Save properties",
  "properties.saving": "Saving…",
  "properties.saved": "Properties saved.",
  "properties.filter": "Filter…",

  "files.title": "File manager",
  "files.subtitle": "Browse and edit /data on disk.",
  "files.empty": "This folder is empty.",
  "files.open": "Open",
  "files.save": "Save",
  "files.saving": "Saving…",
  "files.truncated":
    "File is too large to preview in the browser. Use SSH or the agent API to edit.",
  "files.back": "Back",

  "console.title": "Console",
  "console.connected": "connected",
  "console.disconnected": "disconnected",
  "console.waiting": "Waiting for output…",
  "console.send": "Send",
  "console.placeholder": "say Hello, world",

  "activity.title": "Activity log",
  "activity.empty": "No events yet.",
  "activity.actor": "Actor",
  "activity.action": "Action",
  "activity.resource": "Resource",
  "activity.when": "When",
  "activity.ip": "IP",

  "pageHeader.admin": "Administration",
  "pageHeader.adminSub":
    "Manage panel users and review activity. Server-specific logs live on each server's page.",
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

  "theme.label": "Тема",
  "theme.light": "Светлая",
  "theme.dark": "Тёмная",
  "theme.system": "Системная",
  "theme.mode": "Режим",
  "theme.accent": "Акцент",

  "menu.settings": "Настройки",
  "menu.signOut": "Выйти",

  "nav.dashboard": "Панель",
  "nav.infrastructure": "Инфраструктура",
  "nav.integrations": "Интеграции",
  "nav.administration": "Администрирование",

  "dashboard.title": "Панель",
  "dashboard.subtitle": "Живой обзор всех ваших Minecraft-серверов.",
  "dashboard.newServer": "Новый сервер",
  "dashboard.stats.servers": "Серверы",
  "dashboard.stats.running": "Работает",
  "dashboard.stats.nodes": "Ноды онлайн",
  "dashboard.stats.players": "Всего игроков",
  "dashboard.stats.noneYet": "пока нет",
  "dashboard.stats.idle": "{n} не запущено",
  "dashboard.stats.runningNote": "{n} работает",
  "dashboard.stats.dockerHosts": "Docker-хосты",
  "dashboard.stats.liveAcrossServers": "на всех серверах",
  "dashboard.yourServers": "Ваши серверы",
  "dashboard.total": "всего {n}",
  "dashboard.empty": "Пусто",
  "dashboard.startFirst.title": "Запустите первый сервер",
  "dashboard.startFirst.body":
    "Выберите тип (Vanilla, Paper, Fabric, Forge…), версию, и мы поднимем для вас свежий Minecraft-контейнер.",
  "dashboard.createServer": "Создать сервер",

  "tile.players": "Игроки",
  "tile.memory": "Память",
  "tile.port": "Порт",
  "tile.node": "Нода",
  "tile.lastStart": "Последний запуск {ago}",
  "tile.lastStartLabel": "Последний запуск",
  "tile.neverStarted": "ещё не запускался",

  "server.tabs.overview": "Обзор",
  "server.tabs.console": "Консоль",
  "server.tabs.files": "Файлы",
  "server.tabs.properties": "Свойства",
  "server.tabs.backups": "Бэкапы",
  "server.tabs.schedules": "Расписания",
  "server.tabs.content": "Моды и плагины",
  "server.tabs.diagnostics": "Диагностика",
  "server.hero.serverType": "Тип сервера",
  "server.hero.version": "Версия",
  "server.hero.cpu": "CPU",
  "server.hero.memoryLimit": "Лимит {mb} MB",
  "server.overview.runtime": "Конфигурация рантайма",
  "server.overview.memoryLimit": "Лимит памяти",
  "server.overview.cpuLimit": "Лимит CPU",
  "server.overview.unlimited": "без лимита",
  "server.overview.ports": "Порты",
  "server.overview.env": "Переменные окружения",
  "server.overview.envNone": "нет",
  "server.overview.players": "Игроки онлайн",
  "server.overview.noPlayers": "Сейчас никого нет онлайн.",
  "server.overview.rconHint":
    "Список игроков получается с сервера через RCON. Запустите сервер, чтобы увидеть игроков.",
  "server.icon.title": "Иконка сервера",
  "server.icon.body":
    "Показывается рядом с MOTD в игровом списке серверов. Загрузите любое изображение — обрежем до квадрата и сохраним как 64×64 PNG.",
  "server.icon.save": "Сохранить иконку",
  "server.icon.saving": "Сохранение…",
  "server.icon.remove": "Удалить сохранённую иконку",
  "server.icon.saved": "Иконка сохранена.",
  "server.icon.removed": "Иконка удалена.",

  "content.tabs.installed": "Установлено",
  "content.tabs.browse": "Обзор и установка",
  "content.installed.filter": "Фильтр…",
  "content.installed.loading": "Загрузка…",
  "content.browse.searchPlaceholder": "Поиск {kind} на {provider}…",
  "content.browse.mcVersion": "Версия MC (например 1.21.1)",
  "content.browse.anyLoader": "любой загрузчик",
  "content.browse.kind.mod": "мод",
  "content.browse.kind.modpack": "сборка",
  "content.browse.kind.plugin": "плагин",
  "content.browse.kind.datapack": "датапак",
  "content.browse.searching": "Ищу…",
  "content.browse.results": "{n} результатов{more}",
  "content.browse.loadMore": "Загрузить ещё",
  "content.browse.loadingMore": "Загрузка…",
  "content.browse.noMatch": "Ничего не найдено. Попробуйте другой запрос.",
  "content.browse.noResults": "Результатов нет.",
  "content.browse.cfKeyMissing":
    "CurseForge требует API-ключ. Зайдите во вкладку «Интеграции» и вставьте его. Без ключа моды CurseForge можно устанавливать вручную через Файловый менеджер в папку mods/.",
  "content.install": "Установить",
  "content.installing": "Установка…",
  "content.modpack.installed":
    "{name} установлено. Перезапустите сервер, чтобы применить.",
  "content.mod.installed":
    "{name} установлено. Перезапустите сервер, чтобы загрузить.",
  "content.failures.desc":
    "{n} мод(ов) не удалось скачать автоматически — авторы модов запретили сторонние загрузки. «Пропустить упавшие» добавляет их в CF_EXCLUDE_MODS, чтобы itzg установил остальные. После этого используйте «Найти на Modrinth» для каждого мода, чтобы подобрать open-source замену.",
  "content.skipRetry": "Пропустить упавшие",
  "content.skipRetry.applying": "Применяю…",
  "content.tryModrinthAll": "Искать все на Modrinth",
  "content.tryModrinthAll.busy": "Ищу на Modrinth…",
  "content.findOnModrinth": "Найти на Modrinth",
  "content.curseforge": "CurseForge",
  "content.installRepairFailed":
    "Установка прошла, но пересборка упала: {msg}",

  "diagnostics.title": "Отчёты о крэшах",
  "diagnostics.subtitle":
    "Генерируются игрой при необработанной ошибке. Лежат в /data/crash-reports и JVM hs_err_pid*.log в корне.",
  "diagnostics.kind.mc": "Крэш MC",
  "diagnostics.kind.jvm": "Крэш JVM",
  "diagnostics.suspects": "подозреваемые:",
  "diagnostics.time": "Время",
  "diagnostics.description": "Описание",
  "diagnostics.exception": "Исключение",
  "diagnostics.suspectPackages": "Подозрительные пакеты",
  "diagnostics.fullReport": "Полный отчёт",
  "diagnostics.loadingReport": "Загружаю отчёт…",

  "infra.title": "Инфраструктура",
  "infra.subtitle":
    "Docker-хосты (ноды), на которых крутятся контейнеры Minecraft. На каждой ноде свой агент; панель общается с ними по общему секрету.",
  "infra.addNode": "Добавить ноду",
  "infra.online": "{n} / {total} онлайн",

  "admin.tabs.users": "Пользователи",
  "admin.tabs.audit": "Лог действий",
  "admin.users.title": "Пользователи панели",
  "admin.users.invite": "Пригласить",
  "admin.users.table.user": "Пользователь",
  "admin.users.table.email": "Email",
  "admin.users.table.role": "Роль",
  "admin.users.table.joined": "Присоединился",

  "time.secondsAgo": "{n}с назад",
  "time.minutesAgo": "{n}м назад",
  "time.hoursAgo": "{n}ч назад",
  "time.daysAgo": "{n}д назад",

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

  "auth.login.title": "Вход",
  "auth.login.subtitle": "С возвращением. Введите данные для входа.",
  "auth.login.usernameOrEmail": "Логин или email",
  "auth.login.password": "Пароль",
  "auth.login.submit": "Войти",
  "auth.login.submitting": "Вход…",
  "auth.login.failed": "Ошибка входа",
  "auth.shell.title": "Minecraft-серверы без лишней возни.",
  "auth.shell.subtitle":
    "Создавайте, масштабируйте и администрируйте контейнеры Paper, Vanilla, Fabric, Forge и других — с живой консолью, бэкапами и установщиком модов из коробки.",
  "auth.shell.quote":
    "Поднимите Paper 1.21 меньше чем за минуту — панель сама подпишет EULA, включит RCON и примонтирует тома.",
  "auth.shell.cite": "Документация Cofemine",
  "auth.shell.footer": "Self-hosted · Docker-first",

  "setup.title": "Первичная настройка",
  "setup.subtitle":
    "Создание аккаунта владельца. Запускается один раз.",
  "setup.email": "Email",
  "setup.username": "Логин",
  "setup.password": "Пароль",
  "setup.passwordHint": "минимум 8 символов",
  "setup.submit": "Создать аккаунт владельца",
  "setup.submitting": "Создаю…",
  "setup.failed": "Не удалось завершить настройку",
  "setup.shell.title": "Добро пожаловать.",
  "setup.shell.subtitle":
    "Давайте создадим первый аккаунт. Этот пользователь станет OWNER и сможет приглашать остальных.",
  "setup.shell.quote":
    "Роли проверяются на уровне API, пишутся в аудит и по умолчанию минимальны.",
  "setup.shell.cite": "Модель безопасности",

  "wizard.title": "Новый сервер",
  "wizard.back": "Назад",
  "wizard.next": "Далее",
  "wizard.create": "Создать сервер",
  "wizard.creating": "Создаю…",
  "wizard.step.basics": "Основное",
  "wizard.step.source": "Источник",
  "wizard.step.resources": "Ресурсы",
  "wizard.step.review": "Обзор",
  "wizard.name": "Имя сервера",
  "wizard.description": "Описание (необязательно)",
  "wizard.type": "Тип сервера",
  "wizard.version": "Версия Minecraft",
  "wizard.source": "Источник",
  "wizard.source.plain": "Обычный",
  "wizard.source.modrinth": "Сборка Modrinth",
  "wizard.source.curseforge": "Сборка CurseForge",
  "wizard.modpack.search": "Поиск сборок…",
  "wizard.modpack.picked": "Выбрано",
  "wizard.modpack.clear": "Очистить",
  "wizard.resources.memory": "Память",
  "wizard.resources.cpu": "Лимит CPU",
  "wizard.resources.cpuHint": "ядер (пусто = без лимита)",
  "wizard.resources.port": "Порт хоста",
  "wizard.eula": "Принять Minecraft EULA",
  "wizard.eulaDesc":
    "Отметка подтверждает согласие с Minecraft EULA. Обязательно для запуска сервера.",
  "wizard.env": "Дополнительные переменные окружения",
  "wizard.review.intro":
    "Проверьте данные — после создания контейнер стартует автоматически, если EULA принята.",
  "wizard.icon": "Иконка сервера",
  "wizard.iconHint": "Необязательно — автоматически масштабируется до 64×64 PNG.",
  "wizard.source.plainDesc":
    "Выберите тип сервера (Vanilla, Paper, Fabric, Forge…) и версию MC. Быстро и минимально.",
  "wizard.source.modrinthDesc":
    "Поиск сборок на modrinth.com. Загрузчик и версия определяются из сборки автоматически.",
  "wizard.source.curseforgeDesc":
    "Поиск сборок на curseforge.com. Нужен API-ключ CurseForge (см. Интеграции).",
  "wizard.source.meta.plain": "8 типов",
  "wizard.source.meta.modrinth": "автоопределение",
  "wizard.source.meta.curseforgeOk": "автоопределение",
  "wizard.source.meta.curseforgeMissing": "нужен API-ключ",
  "wizard.source.cfDisabledHint":
    "Сначала настройте API-ключ CurseForge.",
  "wizard.source.selected": "Выбрано",

  "settings.title": "Настройки",
  "settings.subtitle":
    "Настройте внешний вид и поведение панели под свой аккаунт.",
  "settings.appearance": "Внешний вид",
  "settings.profile": "Профиль",
  "settings.avatar": "Аватар профиля",
  "settings.avatarHint":
    "Автоматически масштабируется до 128×128 PNG перед загрузкой.",
  "settings.saveAvatar": "Сохранить аватар",
  "settings.removeAvatar": "Удалить аватар",
  "settings.avatarSaved": "Аватар сохранён.",
  "settings.avatarRemoved": "Аватар удалён.",
  "settings.account": "Аккаунт",
  "settings.about": "О панели",
  "settings.aboutText":
    "Cofemine Panel v0.1.0 — self-hosted, Docker-first панель Minecraft.",
  "settings.username": "Логин",
  "settings.email": "Email",
  "settings.role": "Роль",
  "settings.theme.mode": "Режим",
  "settings.theme.accent": "Акцент",

  "integrations.title": "Интеграции",
  "integrations.subtitle":
    "Провайдеры, через которые панель ищет и ставит моды и сборки. Modrinth бесплатный и всегда включён; для CurseForge нужен API-ключ.",
  "integrations.modrinth.desc":
    "Публичный API — включён по умолчанию. Не требует авторизации.",
  "integrations.curseforge.desc":
    "Требуется API-ключ CurseForge Studios. Без ключа можно вручную загружать JAR-файлы.",
  "integrations.apiKey": "API-ключ",
  "integrations.apiKeyPlaceholder":
    "cf-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "integrations.apiKeySaved":
    "Сохранён в БД зашифрованным — после сохранения не читается.",
  "integrations.save": "Сохранить",
  "integrations.saving": "Сохраняю…",
  "integrations.remove": "Удалить",
  "integrations.enabled": "Включено",
  "integrations.disabled": "Выключено",
  "integrations.getKey": "Получить ключ",

  "proxy.title": "Прокси для скачиваний",
  "proxy.tagline": "SOCKS / HTTP прокси для установки модпаков",
  "proxy.subtitle":
    "Опциональный прокси, через который ходит Java-клиент при скачивании jar'ов на фазе установки. Сам MC-сервер напрямую, через этот прокси не ходит.",
  "proxy.cardDesc":
    "Пригодится если forgecdn.net / CDN Modrinth плохо отдают из вашего региона. Включается на сервере кнопкой «Повторить через прокси»; по умолчанию — напрямую.",
  "proxy.detailsIntro":
    "Настройки шифруются в БД. Применяются к фазе установки конкретного сервера только если вы явно включили прокси на нём (кнопка «Повторить через прокси»).",
  "proxy.enable": "Включено (доступно серверам)",
  "proxy.protocol": "Протокол",
  "proxy.host": "Хост",
  "proxy.port": "Порт",
  "proxy.username": "Логин",
  "proxy.password": "Пароль",
  "proxy.optional": "необязательно",
  "proxy.passwordStored": "сохранён",
  "proxy.notConfigured": "Не настроен",
  "proxy.configuredButOff": "Настроен — выключен",
  "proxy.helperNote":
    "Когда прокси включён + конкретный сервер помечен его использовать — в JAVA_TOOL_OPTIONS пробрасываются соответствующие JVM-флаги (SOCKS или HTTP). Пока флаг включён, собственный HTTP-трафик MC-сервера тоже идёт через эти флаги — выключайте после завершения установки.",
  "proxy.useOnServer": "Повторить установку через прокси",
  "proxy.disableOnServer": "Отключить прокси для сервера",
  "proxy.toggle.busy": "Переключаю…",
  "proxy.toggle.needConfigTitle": "Прокси не настроен",
  "proxy.toggle.needConfigBody":
    "Зайдите в «Интеграции → Прокси для скачиваний», заполните хост, порт и (при необходимости) учётку, включите — и возвращайтесь.",
  "proxy.enabledOnServer":
    "Установка сейчас идёт через прокси. Как только сервер поднимется — выключите прокси для него, чтобы MC ходил напрямую.",

  "backups.create": "Создать бэкап",
  "backups.creating": "Создаю…",
  "backups.restore": "Восстановить",
  "backups.delete": "Удалить",
  "backups.empty":
    "Бэкапов пока нет. Нажмите «Создать бэкап», чтобы сделать снимок /data.",
  "backups.name": "Имя",
  "backups.size": "Размер",
  "backups.status": "Статус",
  "backups.created": "Создан",
  "backups.finished": "Завершён",

  "schedules.title": "Расписания",
  "schedules.subtitle":
    "Cron-задачи: перезапуски, бэкапы и запуск команд.",
  "schedules.add": "Добавить задание",
  "schedules.name": "Имя",
  "schedules.cron": "Cron",
  "schedules.action": "Действие",
  "schedules.nextRun": "Следующий запуск",
  "schedules.enabled": "Включено",
  "schedules.empty": "Расписаний пока нет.",

  "properties.title": "server.properties",
  "properties.subtitle":
    "Типизированный редактор с подсказками. Изменения пишутся в файл и применяются после перезапуска.",
  "properties.save": "Сохранить",
  "properties.saving": "Сохраняю…",
  "properties.saved": "Свойства сохранены.",
  "properties.filter": "Фильтр…",

  "files.title": "Файловый менеджер",
  "files.subtitle": "Просмотр и редактирование /data на диске.",
  "files.empty": "Папка пуста.",
  "files.open": "Открыть",
  "files.save": "Сохранить",
  "files.saving": "Сохраняю…",
  "files.truncated":
    "Файл слишком большой, чтобы показать в браузере. Используйте SSH или API агента.",
  "files.back": "Назад",

  "console.title": "Консоль",
  "console.connected": "подключено",
  "console.disconnected": "отключено",
  "console.waiting": "Жду вывод…",
  "console.send": "Отправить",
  "console.placeholder": "say Hello, world",

  "activity.title": "Лог действий",
  "activity.empty": "Событий пока нет.",
  "activity.actor": "Кто",
  "activity.action": "Действие",
  "activity.resource": "Ресурс",
  "activity.when": "Когда",
  "activity.ip": "IP",

  "pageHeader.admin": "Администрирование",
  "pageHeader.adminSub":
    "Управление пользователями панели и просмотр активности. Логи конкретных серверов — на странице сервера.",
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
