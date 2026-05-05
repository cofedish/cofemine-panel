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

  "motion.title": "Motion",
  "motion.subtitle":
    "Decorative animations — drifting blocks on the login screen, breathing logos, staggered card mounts. Auto follows the OS reduce-motion setting.",
  "motion.auto": "Auto",
  "motion.on": "On",
  "motion.off": "Off",

  "music.title": "Background music",
  "music.subtitle":
    "Plays soundtracks while you use the panel. The skyline at the bottom of the page pulses in sync with the current track's beat.",
  "music.on": "On",
  "music.off": "Off",
  "music.volume": "Volume",
  "music.next": "Skip track",
  "music.nowPlaying": "Now playing:",
  "music.loading": "Loading…",
  "music.tracksAvailable": "{n} track(s) available — turn on to start.",
  "music.gestureNeeded": "Click to enable music",
  "music.transport.play": "Play",
  "music.transport.pause": "Pause",
  "music.transport.paused": "Paused",
  "music.transport.muted": "Music off",
  "music.picker.open": "Track list",
  "music.picker.title": "Background music",
  "music.volume.mute": "Mute",
  "music.volume.unmute": "Unmute",
  "music.noTracksHint":
    "No tracks configured, or /audio/manifest.json returned 404.\nLikely cause on prod: the AUDIO_DIR bind-mount in docker-compose.prod.yml points to a directory that doesn't exist on the host, so an empty volume hides the in-image manifest. Fix: drop your mp3/ogg files into apps/web/public/audio/ next to the compose file (or set AUDIO_DIR in .env to where they really live), then `docker compose up -d --force-recreate web`.",

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
  "server.tabs.map": "Map",
  "server.map.title": "Live map",
  "server.map.backToServer": "Back to server",
  "server.map.openInNewTab": "Open in new tab",
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
  "server.overview.loaderVersion": "Loader version",
  "server.detach.button": "Detach from source",
  "server.detach.hint":
    "Convert this modpack server into a plain native-loader install. mc-image-helper stops running on every restart, the pack is no longer enforced. Mods + worlds untouched.",
  "server.detach.confirmTitle": "Detach from modpack source?",
  "server.detach.confirmBody":
    "Strips the CF / Modrinth env so subsequent restarts skip the pack installer entirely. You can edit /data/mods freely after this. Pack version updates from the original author won't apply anymore — that's the point. /data/world is untouched.",
  "server.detach.ok": "Detach",
  "server.detach.done": "Detached. Server is now {type} {loader}.",
  "server.fixPerms.button": "Fix permissions",
  "server.fixPerms.hint":
    "chown -R 1000:1000 on /data/libraries + run scripts. Useful when an earlier loader install left root-owned files that itzg can't overwrite.",
  "server.fixPerms.done": "Permissions repaired ({n} paths chowned).",
  "modVersion.button": "Change version",
  "modVersion.title": "Pick version — {name}",
  "modVersion.subtitle": "Filtered to MC {mc} / {loader}.",
  "modVersion.currentlyInstalled": "Installed: {v}.",
  "modVersion.installed": "installed",
  "modVersion.noCompatible":
    "No published versions match MC {mc} / {loader}. Toggle below to see every version (compatibility is YOUR problem from there).",
  "modVersion.showAll": "Show all versions, ignore MC / loader filters",
  "modVersion.distributionBlocked":
    "third-party download disabled by author",
  "modVersion.swapNote":
    "We delete the old jar first, then download the new one. The next server start picks it up — no rebuild needed.",
  "modVersion.apply": "Apply swap",
  "modVersion.swapped": "Swapped {name}. Restart the server to load the new version.",
  "loaderVersion.usingPackDefault": "(using pack default)",
  "loaderVersion.change": "Change",
  "loaderVersion.dialogTitle": "Override loader version",
  "loaderVersion.dialogSubtitle":
    "Pin a specific NeoForge / Forge / Fabric / Quilt version for this server. The container will rebuild and the next start will run on the chosen version. MC: {mc}",
  "loaderVersion.mcResolvedNote":
    "Server is configured as MC \"{stored}\" — assuming {resolved} for filtering loader builds. Edit below if it's wrong.",
  "loaderVersion.mcVersion": "Minecraft version",
  "loaderVersion.mcVersionHint":
    "Used to filter the loader-version dropdown. Defaults to the server's stored version, or the latest Mojang release when stored as \"LATEST\".",
  "loaderVersion.loader": "Loader",
  "loaderVersion.loaderHint":
    "On modpack servers we can't always tell which loader the pack uses — pick the one your pack ships.",
  "loaderVersion.version": "Version",
  "loaderVersion.pickVersion": "— pick version —",
  "loaderVersion.showUnstable": "Show unstable (beta / rc / pre)",
  "loaderVersion.noVersions":
    "No published {loader} versions found for MC {mc}. Try a different MC version.",
  "loaderVersion.upstreamError":
    "Couldn't reach the {loader} maven: {msg}. Check the download-proxy config in Integrations.",
  "loaderVersion.repairWarning":
    "Saving rebuilds the container so the new loader version takes effect on the next start. Existing world data is unaffected.",
  "loaderVersion.applyAndRebuild": "Apply & rebuild",
  "loaderVersion.clearOverride": "Clear override",
  "loaderVersion.saved": "Loader pinned to {loader} {version}. Rebuilding…",
  "loaderVersion.starting": "Sending to agent…",
  "loaderVersion.installing": "Installing modloader (downloading installer + running it in a temp container, can take 1–2 min)…",
  "loaderVersion.cleared": "Override cleared. Falling back to pack / image default.",
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
  "content.browse.lockedPrefix": "Filtered to:",
  "content.browse.serverInstallableOnly": "server-installable only",
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
  "content.exclusions.applied":
    "Exclusion list saved ({n} mod(s) skipped). Container is rebuilding.",
  "content.tabs.exclusions": "Exclusions",
  "content.tabs.client": "Client pack",
  "content.tabs.clientHint":
    "Manage client-only mods (shaders, minimaps, Iris/Sodium) and export the whole pack as .mrpack for friends.",
  "clientMods.title": "Client-only mods",
  "clientMods.intro":
    "Drop jars here that should ship to your friends but NOT to the server (Iris, Sodium, Xaero, shaders, JEI client extras…). They stay in /data/.cofemine-client/ — itzg's mod scanner can't see them, the server JVM never loads them.",
  "clientMods.upload": "Upload jars",
  "clientMods.kind.mods": "Mods",
  "clientMods.kind.shaderpacks": "Shaderpacks",
  "clientMods.kind.resourcepacks": "Resource packs",
  "clientMods.uploadKind.mods": "Upload mod jars",
  "clientMods.uploadKind.shaderpacks": "Upload shaderpacks",
  "clientMods.uploadKind.resourcepacks": "Upload resource packs",
  "clientMods.uploading": "Uploading {i}/{n}: {name}",
  "clientMods.skipNotJar": "Skipped {name} — not a .jar / .zip",
  "clientMods.skipTooBig": "Skipped {name} — over 100 MB",
  "clientMods.exportMrpack": "Download .mrpack",
  "clientMods.exportTooltip":
    "Server mods + your client mods bundled into a Modrinth-format pack. Friends import it in Prism Launcher / Modrinth App with one click.",
  "clientMods.empty.title": "No client-only mods uploaded yet.",
  "clientMods.empty.body":
    "Drop in shaders, miniмap mods, Iris, Sodium — anything you want a friend's client to have. The server's own /data/mods isn't touched.",
  "clientMods.confirmRemove.title": "Remove from client pack?",
  "clientMods.confirmRemove.body":
    "Delete {name} from the client-mods staging area. Friends downloading the .mrpack after this won't get it.",
  "clientMods.autoDetected.title":
    "Pack ships {n} client-only mods that aren't on the server",
  "clientMods.autoDetected.body":
    "These were excluded from the server install (Iris, Sodium, Mouse Tweaks, Xaero, etc.) but are needed on the client. Download them to ship with the .mrpack.",
  "clientMods.autoDetected.downloadAll": "Download all",
  "clientMods.autoDetected.more": "and {n} more…",
  "clientMods.autoDownloading": "Downloading {n} client mods…",
  "clientMods.autoAllOk": "Downloaded all {n} client mods.",
  "clientMods.autoSomeFail": "Downloaded {ok}/{n}; some failed (check logs).",
  "clientMods.publicLink.title": "Public download link",
  "clientMods.publicLink.intro":
    "Share this URL with friends. They paste it into Prism / Modrinth App / ATLauncher and the client pack downloads with no panel account needed.",
  "clientMods.publicLink.enable": "Enable public link",
  "clientMods.publicLink.rotate": "Rotate (invalidate old URL)",
  "clientMods.publicLink.disable": "Disable",
  "clientMods.publicLink.copy": "Copy",
  "clientMods.publicLink.copied": "Copied!",
  "clientMods.publicLink.confirmRotate.title": "Rotate the public link?",
  "clientMods.publicLink.confirmRotate.body":
    "The current URL stops working immediately. Anyone who already downloaded the pack keeps it; future downloads need the new URL.",
  "clientMods.publicLink.confirmDisable.title": "Disable the public link?",
  "clientMods.publicLink.confirmDisable.body":
    "Friends with the URL won't be able to download the pack anymore. You can re-enable it later — the new URL will be different.",
  "content.exclusions.intro":
    "These mod IDs are skipped on the next pack install and repair. Remove an entry to bring the mod back next time.",
  "content.exclusions.empty.title": "No mods are excluded.",
  "content.exclusions.empty.body":
    "Delete a mod from the Mods tab and it lands here automatically — the pack installer skips it on every repair so it doesn't come back.",
  "content.exclusions.remove": "Remove from exclusions",
  "content.exclusions.confirmRemove.title": "Remove from exclusions?",
  "content.exclusions.confirmRemove.body":
    "The mod will be downloaded again on the next pack install or repair.",
  "content.exclusions.confirmRemove.ok": "Remove",
  "content.installConfirm.deleteAndExclude.title": "Delete and exclude?",
  "content.installConfirm.deleteAndExclude.body":
    "Delete {name} from disk AND add it to the pack's exclusion list. itzg's installer won't bring it back on repair.",
  "content.installConfirm.deleteAndExclude.ok": "Delete + exclude",
  "content.installConfirm.deleteNoModId.body":
    "Delete {name}? Note: we couldn't resolve a CurseForge modId for this jar, so it's NOT added to the exclusion list — itzg may re-download it on the next repair.",

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
  "infra.adding": "Adding…",
  "infra.addNode.body":
    "Register a remote Docker host. The agent on that host must be reachable over HTTPS with the shared token.",
  "infra.online": "{n} / {total} online",
  "infra.field.name": "Display name",
  "infra.field.host": "Agent URL",
  "infra.field.token": "Shared token",
  "infra.field.token.hint": "Set in AGENT_TOKEN on the remote agent",
  "infra.stat.servers": "Servers",
  "infra.stat.lastSeen": "Last seen",
  "infra.health.check": "Health",
  "infra.health.checking": "Checking…",
  "infra.health.ok": "Agent reachable · v{version}",
  "infra.health.fail": "Agent unreachable: {msg}",
  "infra.rename.title": "Rename node",
  "infra.rename.body":
    "New display name (2–48 characters). Only the panel label changes; the agent host and token stay the same.",
  "infra.rename.invalid": "Name must be 2–48 characters.",
  "infra.empty.title": "No nodes registered",
  "infra.empty.body":
    "A node is a Docker host with the cofemine agent running on it. The default compose auto-registers the local agent on first boot.",
  "infra.addAnother.title": "Add another node",
  "infra.addAnother.body":
    "Spread your servers across several Docker hosts — local + remote, dev + prod.",

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
    "Server \"{name}\" will be stopped, its container removed, and ALL of its data — worlds, configs, mods, backups inside the data dir — wiped from disk. This cannot be undone.\nType the server name below to confirm:",
  "server.deleteConfirm.mismatch":
    "Type \"{name}\" exactly to confirm deletion.",
  "server.deleteConfirm.done": "Server \"{name}\" deleted.",
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
  "admin.resetPassword.title": "Reset password",
  "admin.resetPassword.body":
    "Reset password for {username}? Pick how to deliver the new password.",
  "admin.resetPassword.sendLink": "Email a reset link",
  "admin.resetPassword.setManually": "Type a new password",
  "admin.resetPassword.setPrompt":
    "New password (min 8 characters). The user's other sessions will be signed out.",
  "admin.resetPassword.tooShort":
    "Password must be at least 8 characters.",
  "admin.resetPassword.directDone":
    "Password updated. The user must sign in again with the new one.",
  "admin.resetPassword.sentMail":
    "Reset email sent to {email}. The link below is also valid as a fallback.",
  "admin.resetPassword.notMailed":
    "SMTP isn't configured — copy this one-shot link to the user yourself:",

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
  "auth.login.forgot": "Forgot password?",

  "auth.forgot.title": "Reset password",
  "auth.forgot.subtitle":
    "Enter the username or email tied to your account. If we find a match, a reset link goes out shortly.",
  "auth.forgot.submit": "Send reset link",
  "auth.forgot.submitting": "Sending…",
  "auth.forgot.sent":
    "If that account exists, a reset link has been sent. Check your inbox (and spam folder) — the link is valid for 1 hour.",
  "auth.forgot.backToLogin": "Back to sign in",

  "auth.reset.title": "Set a new password",
  "auth.reset.subtitle":
    "Pick a new password. All your active panel sessions will be signed out.",
  "auth.reset.newPassword": "New password",
  "auth.reset.confirmPassword": "Confirm new password",
  "auth.reset.mismatch": "Passwords do not match.",
  "auth.reset.submit": "Set new password",
  "auth.reset.submitting": "Saving…",
  "auth.reset.success":
    "Password updated. Redirecting to sign in…",
  "auth.reset.invalidTitle": "Reset link invalid",
  "auth.reset.missingToken":
    "This page needs a token from a reset email. Request a new link below.",
  "auth.reset.requestNew": "Request a new link",
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
  "wizard.modpack.use": "Use this pack",
  "wizard.modpack.changeVersion": "Change version",
  "wizard.modpack.selected": "Selected pack",
  "wizard.packVersion": "Pack version",
  "wizard.packVersion.latest": "Latest (newest published)",
  "wizard.packVersion.blocked": "auto-download disabled",
  "wizard.packVersion.blockedHint":
    "The pack author disabled third-party distribution on CurseForge for this version. The container won't be able to fetch it automatically. Pick a different version, or use a Modrinth alternative.",
  "wizard.packVersion.hint":
    "Pin a specific pack version if the author recently broke compat. \"Latest\" lets itzg pick the newest upload — fine for most packs but risky when a brand-new version ships a mod that depends on an MC release you're not running.",
  "wizard.resources.memory": "Memory",
  "wizard.resources.java": "Java version",
  "wizard.resources.javaAuto": "Auto (recommended)",
  "wizard.resources.javaHint":
    "Pick the Java major version the server runs on. Auto uses whatever the itzg image ships with; if your modpack/plugins crash with native errors (SIGSEGV / async-profiler / language provider mismatch), pin to the version your MC release expects.",
  "wizard.resources.cpu": "CPU limit",
  "wizard.resources.cpuHint": "cores (empty = no limit)",
  "wizard.resources.port": "Host port",
  "wizard.eula": "Accept Minecraft EULA",
  "wizard.dynmap.label": "Install live web map (Dynmap or BlueMap)",
  "wizard.dynmap.hint":
    "Resolves the right map jar (Dynmap on Paper-family, BlueMap on Forge / NeoForge / Fabric) before the server's first boot and bakes its download URL into the server's env. itzg downloads it on every start, alongside the modpack's own mods, so the file is always there. Server creation takes a moment longer while we look up the compatible version.",
  "wizard.decouple.label":
    "Detach from the modpack source after first boot",
  "wizard.decouple.hint":
    "Recommended. After the pack installs successfully on first boot, the server flips to a plain native-loader install (NeoForge / Forge / Fabric / Quilt). Subsequent restarts skip mc-image-helper entirely — no more pack reinstalls fighting your custom mod additions, version overrides, or deletions. The mods initially installed stay on disk untouched. You lose pack-version updates from the source (intentional — that's what you wanted).",
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
  "proxy.tagline": "Automatic fallback for modpack install downloads",
  "proxy.subtitle":
    "Auto-fallback proxy. On Start, the panel first tries to download mods directly. If the download aborts with a CDN timeout, it automatically reprovisions the container with JVM proxy flags and retries once. As soon as the server boots, it reprovisions back to a clean direct container — the MC server itself is never routed through the proxy.",
  "proxy.cardDesc":
    "Set once and forget. Direct is tried first; the panel falls back to this proxy only if the install aborts, then flips back off after boot.",
  "proxy.detailsIntro":
    "Stored encrypted. Used automatically by the install-watchdog on every modpack server — no per-server toggle.",
  "proxy.enable": "Enable automatic fallback",
  "proxy.autoActive":
    "The install-watchdog has routed the current run through the download proxy. It will automatically switch back to direct once the server boots.",
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
    "How it works: the watchdog polls each modpack server every 15s while it's starting. If install aborts with a network timeout and this proxy is configured + enabled, the watchdog reprovisions the container with matching JVM flags (SOCKS or HTTP) and restarts. Once the MC server prints its boot marker, the watchdog reprovisions back to a clean container so MC's own HTTP traffic goes direct. One proxy attempt per install session.",

  "smtp.title": "Outgoing email (SMTP)",
  "smtp.tagline": "Used by password reset and future invites",
  "smtp.subtitle":
    "Set this up so the panel can email password reset links and (later) invitations. Without it, owner-initiated resets fall back to copy-paste links.",
  "smtp.cardDesc":
    "Configure once. The forgot-password flow needs this; admin-driven resets work without it but require copying the link manually.",
  "smtp.detailsIntro":
    "All fields except password are stored in plaintext (encrypted with the panel's SECRETS_KEY). Use the test below to verify before relying on it.",
  "smtp.enable": "Enable email delivery",
  "smtp.host": "Host",
  "smtp.port": "Port",
  "smtp.secure": "Encryption",
  "smtp.user": "Auth username",
  "smtp.password": "Auth password",
  "smtp.from": "From address",
  "smtp.panelUrl": "Panel base URL",
  "smtp.notConfigured": "Not configured",
  "smtp.configuredButOff": "Configured — off",
  "smtp.testTitle": "Send a test email",
  "smtp.testSend": "Send test",
  "smtp.testSending": "Sending…",
  "smtp.testSent": "Test email queued to {to}.",
  "smtp.helperNote":
    "Panel base URL is used to build links inside outgoing emails (e.g. /reset-password?token=…). Use the public URL users will hit, not the internal Docker host.",

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

  "motion.title": "Анимации",
  "motion.subtitle":
    "Декоративная анимация — летящие блоки на логине, дышащие логотипы, плавные появления карточек. «Авто» уважает системную настройку «уменьшить движение».",
  "motion.auto": "Авто",
  "motion.on": "Включены",
  "motion.off": "Выключены",

  "music.title": "Фоновая музыка",
  "music.subtitle":
    "Играет саундтреки во время работы панели. Силуэт блоков внизу страницы пульсирует в такт текущему треку.",
  "music.on": "Включена",
  "music.off": "Выключена",
  "music.volume": "Громкость",
  "music.next": "Следующий трек",
  "music.nowPlaying": "Сейчас играет:",
  "music.loading": "Загрузка…",
  "music.tracksAvailable": "Треков в манифесте: {n}. Включи, чтобы запустить.",
  "music.gestureNeeded": "Нажми, чтобы включить музыку",
  "music.transport.play": "Играть",
  "music.transport.pause": "Пауза",
  "music.transport.paused": "На паузе",
  "music.transport.muted": "Музыка выкл.",
  "music.picker.open": "Список треков",
  "music.picker.title": "Фоновая музыка",
  "music.volume.mute": "Заглушить",
  "music.volume.unmute": "Включить звук",
  "music.noTracksHint":
    "Треки не настроены или /audio/manifest.json отдаёт 404.\nЧастая причина на проде: AUDIO_DIR в docker-compose.prod.yml указывает на несуществующую папку на хосте, Docker монтирует поверх каталога образа пустой volume и manifest.json «исчезает». Решение: положи mp3/ogg в apps/web/public/audio/ рядом с compose-файлом (или укажи AUDIO_DIR=/реальный/путь в .env) и пересоздай контейнер: `docker compose up -d --force-recreate web`.",

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
  "server.tabs.map": "Карта",
  "server.map.title": "Живая карта",
  "server.map.backToServer": "К серверу",
  "server.map.openInNewTab": "Открыть в новой вкладке",
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
  "server.overview.loaderVersion": "Версия лоадера",
  "server.detach.button": "Отвязать от источника",
  "server.detach.hint":
    "Превратить modpack-сервер в обычную нативную установку лоадера. mc-image-helper больше не запускается, сборка не навязывается. Моды и мир не трогаются.",
  "server.detach.confirmTitle": "Отвязать от источника?",
  "server.detach.confirmBody":
    "Убираем CF/Modrinth env, на следующих запусках установщик пакета не вызывается. Сможешь свободно редактировать /data/mods. Обновлений сборки от автора больше не будет (это и есть смысл отвязки). Мир не трогается.",
  "server.detach.ok": "Отвязать",
  "server.detach.done": "Отвязано. Сервер теперь {type} {loader}.",
  "server.fixPerms.button": "Починить права",
  "server.fixPerms.hint":
    "chown -R 1000:1000 на /data/libraries + run-скрипты. Полезно когда предыдущий запуск установщика оставил root-owned файлы, которые itzg не может перезаписать.",
  "server.fixPerms.done": "Права починены ({n} путей перевыделены).",
  "modVersion.button": "Сменить версию",
  "modVersion.title": "Выбор версии — {name}",
  "modVersion.subtitle": "Фильтр: MC {mc} / {loader}.",
  "modVersion.currentlyInstalled": "Установлено: {v}.",
  "modVersion.installed": "установлено",
  "modVersion.noCompatible":
    "Нет совместимых версий для MC {mc} / {loader}. Можно показать все версии — но за совместимость дальше отвечаешь сам.",
  "modVersion.showAll": "Показать все версии, без фильтра MC / лоадера",
  "modVersion.distributionBlocked":
    "автор отключил сторонние загрузки",
  "modVersion.swapNote":
    "Сначала удаляем старый jar, потом качаем новый. На следующем старте сервер подхватит новую версию — пересборка не нужна.",
  "modVersion.apply": "Заменить",
  "modVersion.swapped": "Версия {name} обновлена. Перезапусти сервер чтобы применить.",
  "loaderVersion.usingPackDefault": "(как в сборке)",
  "loaderVersion.change": "Изменить",
  "loaderVersion.dialogTitle": "Переопределить версию лоадера",
  "loaderVersion.dialogSubtitle":
    "Зафиксировать конкретную версию NeoForge / Forge / Fabric / Quilt. Контейнер пересоберётся и следующий старт пойдёт на выбранной версии. MC: {mc}",
  "loaderVersion.mcResolvedNote":
    "Сервер сконфигурирован как MC «{stored}» — для фильтрации сборок лоадера используем {resolved}. Поправь ниже, если неверно.",
  "loaderVersion.mcVersion": "Версия Minecraft",
  "loaderVersion.mcVersionHint":
    "Используется для фильтра версий лоадера. По умолчанию — версия сервера, либо последний релиз Mojang, если в сервере записано «LATEST».",
  "loaderVersion.loader": "Лоадер",
  "loaderVersion.loaderHint":
    "Для сборок мы не всегда знаем точный лоадер — выбери тот, на котором собрана твоя сборка.",
  "loaderVersion.version": "Версия",
  "loaderVersion.pickVersion": "— выбрать версию —",
  "loaderVersion.showUnstable": "Показать нестабильные (beta / rc / pre)",
  "loaderVersion.noVersions":
    "Не нашли опубликованные версии {loader} под MC {mc}. Попробуй другую версию MC.",
  "loaderVersion.upstreamError":
    "Не удалось дотянуться до мавена {loader}: {msg}. Проверь настройки download-proxy в Integrations.",
  "loaderVersion.repairWarning":
    "Сохранение пересоберёт контейнер, новая версия лоадера применится на следующем старте. Данные мира не трогаются.",
  "loaderVersion.applyAndRebuild": "Применить и пересобрать",
  "loaderVersion.clearOverride": "Сбросить",
  "loaderVersion.saved": "Лоадер закреплён за {loader} {version}. Пересобираю…",
  "loaderVersion.starting": "Отправляю агенту…",
  "loaderVersion.installing": "Установка лоадера (качаю инсталлер + запускаю во временном контейнере, занимает 1–2 мин)…",
  "loaderVersion.cleared": "Override сброшен. Возвращаемся к версии из сборки / образа.",
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
  "content.browse.lockedPrefix": "Фильтрация:",
  "content.browse.serverInstallableOnly": "только моды для сервера",
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
  "content.exclusions.applied":
    "Список исключений сохранён ({n} мод(а) пропущено). Контейнер пересобирается.",
  "content.tabs.exclusions": "Исключения",
  "content.tabs.client": "Клиентская сборка",
  "content.tabs.clientHint":
    "Управление клиентскими модами (шейдеры, миникарты, Iris/Sodium) и экспорт всей сборки в .mrpack для друзей.",
  "clientMods.title": "Клиентские моды",
  "clientMods.intro":
    "Закидывай сюда jar'ы, которые должны быть у друзей, но НЕ на сервере (Iris, Sodium, Xaero, шейдеры, JEI client extras…). Лежат в /data/.cofemine-client/ — сервер их не видит и не загружает.",
  "clientMods.upload": "Загрузить jar'ы",
  "clientMods.kind.mods": "Моды",
  "clientMods.kind.shaderpacks": "Шейдеры",
  "clientMods.kind.resourcepacks": "Ресурспаки",
  "clientMods.uploadKind.mods": "Загрузить моды (.jar)",
  "clientMods.uploadKind.shaderpacks": "Загрузить шейдеры (.zip)",
  "clientMods.uploadKind.resourcepacks": "Загрузить ресурспаки (.zip)",
  "clientMods.uploading": "Загрузка {i}/{n}: {name}",
  "clientMods.skipNotJar": "Пропущен {name} — не .jar / .zip",
  "clientMods.skipTooBig": "Пропущен {name} — больше 100 МБ",
  "clientMods.exportMrpack": "Скачать .mrpack",
  "clientMods.exportTooltip":
    "Серверные моды + твои клиентские, упакованные в формат Modrinth. Друг открывает в Prism Launcher / Modrinth App одной кнопкой.",
  "clientMods.empty.title": "Клиентских модов пока нет.",
  "clientMods.empty.body":
    "Загрузи шейдеры, миникарты, Iris, Sodium — всё что хочешь видеть на клиенте у друзей. Серверный /data/mods не трогается.",
  "clientMods.confirmRemove.title": "Убрать из клиентской сборки?",
  "clientMods.confirmRemove.body":
    "Удалить {name} из клиентской папки. Друзья качающие .mrpack после этого его не получат.",
  "clientMods.autoDetected.title":
    "Сборка содержит {n} клиентских модов, которых нет на сервере",
  "clientMods.autoDetected.body":
    "Они были исключены из серверной установки (Iris, Sodium, Mouse Tweaks, Xaero и т.д.), но нужны клиенту. Скачай их, чтобы попали в .mrpack.",
  "clientMods.autoDetected.downloadAll": "Скачать всё",
  "clientMods.autoDetected.more": "и ещё {n}…",
  "clientMods.autoDownloading": "Скачиваю {n} клиентских модов…",
  "clientMods.autoAllOk": "Скачано {n} клиентских модов.",
  "clientMods.autoSomeFail": "Скачано {ok}/{n}; часть не удалась (проверь логи).",
  "clientMods.publicLink.title": "Публичная ссылка на скачивание",
  "clientMods.publicLink.intro":
    "Кидай эту ссылку друзьям. Они вставляют её в Prism / Modrinth App / ATLauncher — клиентская сборка качается без аккаунта в панели.",
  "clientMods.publicLink.enable": "Включить публичную ссылку",
  "clientMods.publicLink.rotate": "Сменить (старая ссылка перестанет работать)",
  "clientMods.publicLink.disable": "Отключить",
  "clientMods.publicLink.copy": "Скопировать",
  "clientMods.publicLink.copied": "Скопировано!",
  "clientMods.publicLink.confirmRotate.title": "Сменить публичную ссылку?",
  "clientMods.publicLink.confirmRotate.body":
    "Текущая ссылка сразу же перестанет работать. У тех, кто уже скачал сборку, ничего не пропадёт — но новые скачивания пойдут только по новой ссылке.",
  "clientMods.publicLink.confirmDisable.title": "Отключить публичную ссылку?",
  "clientMods.publicLink.confirmDisable.body":
    "Друзья со ссылкой больше не смогут качать сборку. Можно снова включить — но ссылка будет другая.",
  "content.exclusions.intro":
    "Эти модификации пропускаются при следующей установке/починке сборки. Убери запись — мод вернётся при следующем запуске установщика.",
  "content.exclusions.empty.title": "Нет исключённых модов.",
  "content.exclusions.empty.body":
    "Удали мод во вкладке Mods — он автоматически попадёт сюда. Установщик сборки будет его пропускать, так что он больше не вернётся.",
  "content.exclusions.remove": "Убрать из исключений",
  "content.exclusions.confirmRemove.title": "Убрать из исключений?",
  "content.exclusions.confirmRemove.body":
    "Мод снова скачается при следующей установке или починке сборки.",
  "content.exclusions.confirmRemove.ok": "Убрать",
  "content.installConfirm.deleteAndExclude.title": "Удалить и исключить?",
  "content.installConfirm.deleteAndExclude.body":
    "Удалить {name} с диска И добавить в список исключений сборки. Установщик itzg не будет его возвращать при починке.",
  "content.installConfirm.deleteAndExclude.ok": "Удалить + исключить",
  "content.installConfirm.deleteNoModId.body":
    "Удалить {name}? Не удалось определить CurseForge modId этого jar'а, поэтому в исключения он НЕ попадёт — установщик может скачать его заново при следующей починке.",

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
  "infra.adding": "Добавляю…",
  "infra.addNode.body":
    "Регистрация удалённого Docker-хоста. Агент на той стороне должен быть доступен по HTTPS с общим секретом.",
  "infra.online": "{n} / {total} онлайн",
  "infra.field.name": "Имя",
  "infra.field.host": "URL агента",
  "infra.field.token": "Общий секрет",
  "infra.field.token.hint": "Задаётся в AGENT_TOKEN на удалённом агенте",
  "infra.stat.servers": "Серверы",
  "infra.stat.lastSeen": "Последний контакт",
  "infra.health.check": "Проверить",
  "infra.health.checking": "Проверяю…",
  "infra.health.ok": "Агент отвечает · v{version}",
  "infra.health.fail": "Агент недоступен: {msg}",
  "infra.rename.title": "Переименовать ноду",
  "infra.rename.body":
    "Новое имя (2–48 символов). Меняется только подпись в панели; адрес агента и секрет остаются прежними.",
  "infra.rename.invalid": "Имя должно быть 2–48 символов.",
  "infra.empty.title": "Нет зарегистрированных нод",
  "infra.empty.body":
    "Нода — это Docker-хост с запущенным агентом cofemine. Дефолтный compose сам регистрирует локального агента при первом запуске.",
  "infra.addAnother.title": "Добавить ещё ноду",
  "infra.addAnother.body":
    "Распределите серверы по нескольким Docker-хостам — локальный + удалённый, dev + prod.",

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
  "server.deleteConfirm.mismatch":
    "Введи «{name}» точь-в-точь, чтобы подтвердить удаление.",
  "server.deleteConfirm.done": "Сервер «{name}» удалён.",
  "server.deleteConfirm.body":
    "Сервер «{name}» будет остановлен, его контейнер снесён, и ВСЕ его данные — миры, конфиги, моды, бэкапы внутри data-папки — удалены с диска. Это действие необратимо.\nВведи имя сервера, чтобы подтвердить:",
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
  "admin.resetPassword.title": "Сбросить пароль",
  "admin.resetPassword.body":
    "Сбросить пароль пользователю {username}? Выберите способ доставки.",
  "admin.resetPassword.sendLink": "Отправить ссылку на email",
  "admin.resetPassword.setManually": "Задать пароль вручную",
  "admin.resetPassword.setPrompt":
    "Новый пароль (минимум 8 символов). Все активные сессии пользователя будут разлогинены.",
  "admin.resetPassword.tooShort":
    "Пароль должен быть минимум 8 символов.",
  "admin.resetPassword.directDone":
    "Пароль обновлён. Пользователю нужно войти с новым.",
  "admin.resetPassword.sentMail":
    "Письмо со сбросом отправлено на {email}. Ссылка ниже работает как запасной вариант.",
  "admin.resetPassword.notMailed":
    "SMTP не настроен — скопируйте одноразовую ссылку и передайте пользователю:",

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
  "auth.login.forgot": "Забыли пароль?",

  "auth.forgot.title": "Сброс пароля",
  "auth.forgot.subtitle":
    "Введите логин или email от своего аккаунта. Если найдём — отправим ссылку на сброс.",
  "auth.forgot.submit": "Отправить ссылку",
  "auth.forgot.submitting": "Отправляю…",
  "auth.forgot.sent":
    "Если такой аккаунт существует, ссылка отправлена. Проверьте почту (включая спам) — ссылка живёт 1 час.",
  "auth.forgot.backToLogin": "Назад ко входу",

  "auth.reset.title": "Новый пароль",
  "auth.reset.subtitle":
    "Введите новый пароль. Все ваши активные сессии будут разлогинены.",
  "auth.reset.newPassword": "Новый пароль",
  "auth.reset.confirmPassword": "Повторите пароль",
  "auth.reset.mismatch": "Пароли не совпадают.",
  "auth.reset.submit": "Установить пароль",
  "auth.reset.submitting": "Сохраняю…",
  "auth.reset.success":
    "Пароль обновлён. Перенаправляю на вход…",
  "auth.reset.invalidTitle": "Ссылка недействительна",
  "auth.reset.missingToken":
    "Эта страница ждёт токен из письма-сброса. Запросите новую ссылку ниже.",
  "auth.reset.requestNew": "Запросить новую ссылку",
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
  "wizard.modpack.use": "Использовать сборку",
  "wizard.modpack.changeVersion": "Сменить версию",
  "wizard.modpack.selected": "Выбранная сборка",
  "wizard.packVersion": "Версия сборки",
  "wizard.packVersion.latest": "Последняя (самая новая)",
  "wizard.packVersion.blocked": "автозагрузка отключена",
  "wizard.packVersion.blockedHint":
    "Автор сборки отключил скачивание сторонними сервисами на CurseForge для этой версии. Контейнер не сможет загрузить её автоматически. Выбери другую версию или возьми аналог с Modrinth.",
  "wizard.packVersion.hint":
    "Закрепите конкретную версию, если автор недавно сломал совместимость. «Последняя» отдаёт решение itzg — подойдёт для большинства паков, но рискованно, если новая версия тянет моды под MC, которую вы не запускаете.",
  "wizard.resources.memory": "Память",
  "wizard.resources.java": "Версия Java",
  "wizard.resources.javaAuto": "Авто (рекомендуется)",
  "wizard.resources.javaHint":
    "Выбери major-версию Java, на которой запустится сервер. «Авто» оставит ту, что в itzg-образе по умолчанию; если сборка/моды падают с native-ошибками (SIGSEGV / async-profiler / language provider mismatch) — зафиксируй версию под свой MC.",
  "wizard.resources.cpu": "Лимит CPU",
  "wizard.resources.cpuHint": "ядер (пусто = без лимита)",
  "wizard.resources.port": "Порт хоста",
  "wizard.eula": "Принять Minecraft EULA",
  "wizard.decouple.label":
    "Отвязать сервер от источника после первого запуска",
  "wizard.decouple.hint":
    "Рекомендуется. После того как сборка успешно установится при первом старте, сервер превратится в обычную нативную установку лоадера (NeoForge / Forge / Fabric / Quilt). На следующих запусках mc-image-helper не запускается вообще — никаких переустановок пакета, борьбы с твоими модами, или конфликтов версий. Установленные сборкой моды остаются на диске нетронутыми. Минус: ты теряешь автообновления пакета от автора (но именно это и нужно когда хочешь свободу).",
  "wizard.dynmap.label": "Установить живую web-карту (Dynmap или BlueMap)",
  "wizard.dynmap.hint":
    "Резолвит совместимую версию jar'а (Dynmap для Paper-семьи, BlueMap для Forge / NeoForge / Fabric) ДО первого запуска сервера и зашивает URL в env. itzg сам качает файл на каждом старте, рядом с модами модпака, файл всегда на месте. Создание сервера займёт чуть дольше — резолв версии через Modrinth API.",
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
  "proxy.tagline": "Автоматический fallback на установке модпаков",
  "proxy.subtitle":
    "Прокси-запаска. На Start панель сначала пробует скачать напрямую. Если установка упала с таймаутом — панель автоматически пересобирает контейнер с JVM-флагами прокси и повторяет запуск. Как только сервер поднялся — пересобирает обратно на прямое подключение. Сам MC-сервер через прокси не ходит.",
  "proxy.cardDesc":
    "Настроил один раз и забыл. Сначала пробуется напрямую, панель сама переключится на прокси только если установка упала, и так же сама вернётся на прямое после загрузки.",
  "proxy.detailsIntro":
    "Шифруется в БД. Используется автоматически watchdog'ом установки на всех модпак-серверах — никаких поштучных переключателей.",
  "proxy.enable": "Включить автоматический fallback",
  "proxy.autoActive":
    "Watchdog установки переключил текущий прогон на прокси. Как только сервер загрузится — автоматически вернёт на прямое подключение.",
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
    "Как это работает: watchdog опрашивает каждый модпак-сервер раз в 15с, пока он стартует. Если установка упала с сетевым таймаутом, а прокси настроен и включён — watchdog пересобирает контейнер с JVM-флагами (SOCKS или HTTP) и перезапускает. Как только MC напечатает маркер загрузки — watchdog пересобирает обратно на чистый контейнер, чтобы MC ходил напрямую. Одна попытка прокси на установку.",

  "smtp.title": "Исходящая почта (SMTP)",
  "smtp.tagline": "Используется для сброса пароля и приглашений",
  "smtp.subtitle":
    "Настройте, чтобы панель могла отправлять ссылки сброса пароля и (позже) приглашения. Без этого админский сброс работает, но ссылку придётся передавать вручную.",
  "smtp.cardDesc":
    "Один раз настроил и забыл. Самостоятельный сброс пароля требует SMTP; админский — нет, но придётся копировать ссылку руками.",
  "smtp.detailsIntro":
    "Все поля кроме пароля хранятся в открытом виде (зашифрованы SECRETS_KEY панели). Перед использованием — отправьте тестовое письмо ниже.",
  "smtp.enable": "Включить отправку email",
  "smtp.host": "Хост",
  "smtp.port": "Порт",
  "smtp.secure": "Шифрование",
  "smtp.user": "Логин для авторизации",
  "smtp.password": "Пароль для авторизации",
  "smtp.from": "Адрес отправителя",
  "smtp.panelUrl": "Базовый URL панели",
  "smtp.notConfigured": "Не настроено",
  "smtp.configuredButOff": "Настроено — выключено",
  "smtp.testTitle": "Отправить тестовое письмо",
  "smtp.testSend": "Отправить тест",
  "smtp.testSending": "Отправляю…",
  "smtp.testSent": "Тестовое письмо поставлено в очередь на {to}.",
  "smtp.helperNote":
    "Базовый URL панели используется для построения ссылок в письмах (например /reset-password?token=…). Указывайте публичный адрес, по которому пользователи реально открывают панель, а не внутренний Docker-хост.",

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
