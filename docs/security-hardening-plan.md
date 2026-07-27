# План устранения уязвимостей и харденинга

Составлен по результатам аудита (июль 2026). Каждый пункт: **где** (файл:строка), **что сделать**, **объём** (S/M/L), **как проверить**.

**Статус (обновлено):** реализовано в коде — 0.1, 1.1, 1.3 (шаг 1), 1.4, 1.5, 1.6,
2.1–2.5, 3.2–3.6, 4.1–4.8, 5.1. Не сделано и остаётся за оператором/на потом:

- **0.2** — ротация секретов в проде (действие оператора, не код).
- **1.2** — ротация CA после деплоя 1.1: старый ключ лежал в MC-контейнерах,
  считать скомпрометированным. Сгенерировать новый CA в UI. Пересоздавать
  MC-контейнеры для *удаления ключа* больше не нужно — агент затирает `ca.key`
  в legacy-томе на каждом старте (см. `seedCaVolumes`), — но новые контейнеры
  всё равно стоит пересоздать, чтобы они перешли на pub-том.
- **1.3 шаг 2** — allowlist доменов в squid: нужен реальный `access_log` за неделю.
- **3.1** — агент оставлен root'ом осознанно (docker не умеет выдавать
  capability non-root `USER`, а `chown` в fix-permissions без CAP_CHOWN падает);
  вместо этого `cap_drop: ALL` + минимальный add-back + `no-new-privileges`.
  Подробности — в `docs/security.md`.
- **3.2 (часть)** — `CapDrop: ["ALL"]` для MC-контейнеров не добавлен: требует
  теста на живом сервере (gosu/chown в itzg). Добавлены `no-new-privileges` и
  `PidsLimit`.
- **3.7** — rootless Docker / socket-proxy: отдельный проект.
- **5.2** — регресс-тесты: в репозитории нет тест-раннера.

Найдено и закрыто по итогам ревью (сверх плана):

- SSRF + traversal в `POST /servers/:id/client-mods/download` — цепочка до RCE
  на хосте (запись как root рядом с `docker.sock`). Закрыто на call-site.
- Миграционный разрыв CA: ключ переехал в отдельный том, legacy-том теперь
  public-only с затиранием `ca.key` — фикс действует и на уже созданные
  контейнеры, без их пересоздания.
- Name Constraints не применяются JVM (анкер строится как
  `new TrustAnchor(cert, null)`) — формулировки в `docs/security.md` и коде
  исправлены; реальный контроль — конфайнмент ключа.
- `GET /templates` без гейта отдавал `env` в открытом виде.
- Traversal при создании бэкапа (`name` → `<name>.tar.gz`).
- Lockout-DoS в троттлинге логина: бакет аккаунта теперь скоупится по IP.
- `rcon.password` утекал через properties и файловый менеджер при `server.view`.
- Контентные GET интеграций (`/modrinth/*`, `/curseforge/*`) закрыты под
  `server.edit` — VIEWER мог выжечь квоту CF.
- `serverId` валидируется как компонент пути.
- Опциональный `MCNET_CIDR` ограничивает клиентов squid (соседи по caddy_net).

Найдено и закрыто во втором раунде ревью (фронтенд, зависимости, планировщик,
публичная поверхность):

- **Stored XSS в описаниях модов** — самописный regex-санитайзер пропускал 7 из
  10 нагрузок (`<img src=x/onerror>`, `<svg/onload>`, `<base>`, `<form>`,
  `javascript:` без кавычек). Заменён на DOMPurify с allowlist и вставкой
  **узлами** (без повторной сериализации → нет mXSS); `dangerouslySetInnerHTML`
  в приложении больше нет. Добавлен CSP в `next.config.mjs` и проверка схемы
  URL из метаданных реестров.
- **Цепочка поставки** — `--frozen-lockfile=false` убран из CI и трёх
  Dockerfile; каждый Dockerfile теперь копирует все манифесты воркспейса.
  Обновлены `tar`, `adm-zip`, `nodemailer`, `next`, `undici`, `ws`:
  critical 2 → 0, high 40 → 36 (остаток — Fastify 4 и Next 14, лечится только
  мажорной миграцией).
- **Планировщик** — cron строго 5 полей (6 = секунды в croner), парсинг croner'ом
  при сохранении, `protect: true` против наложения запусков, `createdById` +
  перепроверка прав перед каждым запуском, аудит каждого запуска.
- **Публичная поверхность** — листинг `/p/index.json` стал opt-in
  (`publicPackListed`, по умолчанию выключен) с переключателем в UI;
  отдельные рейт-лимиты на `/p/*`; в nginx-зеркале добавлены `limit_req`/
  `limit_conn` и разрешены только GET/HEAD.
- `MCNET_CIDR` добавлен в `.env.example`.

Найдено и закрыто в третьем раунде ревью:

- **Планировщик, обходы фиксов**: удаление пользователя теперь выключает его
  расписания (FK `SetNull` иначе превращал «автор удалён» в «легаси» → запуск);
  `PATCH /schedules/:id` получил аудит и переназначение автора (иначе OPERATOR
  переписывал расписание ADMIN'а и наследовал его права); `payload` стал
  типизированным (`{keep: 0.5}` → `slice(0)` удалял **всю** историю бэкапов);
  `restartScheduler` сериализован (гонка оставляла живые Cron без ссылок);
  `assertCronParses` проверяет `nextRun() !== null`; `@daily`-шорткаты снова
  принимаются (была регрессия); аудит пишется и при неудачном запуске.
- **Зависимости**: `pnpm.overrides` закрыли 17 high в транзитивных пакетах
  (`protobufjs` — code injection, приезжает в агент через dockerode),
  `nodemailer` доведён до 9. Итог: **critical 0, high 40 → 10**, и остаток —
  только Next 14→15 и Fastify 4→5.
- **Публичное зеркало nginx**: `real_ip` за Caddy (иначе лимиты ключевались на
  IP Caddy — один бюджет на всех), лимиты подняты под реальную нагрузку
  (ванильный запуск тянет ~2600 объектов), ключ кэша для неизменяемых артефактов
  переведён на `$uri` (без query).
- **Мелкое**: аватар валидируется как data-URL (маячок деанонимизации),
  `.dockerignore` закрывает `**/.env`, `appleboy/ssh-action` пришпилен по SHA
  (ему передаётся прод-ключ), gost сверяется по контрольной сумме, семафор и
  общий dispatcher на сборку `.mrpack`, файловый менеджер восстанавливает
  замаскированный `rcon.password` при записи.

## Разделение агента и Docker-сокета (в работе)

Цель: убрать `docker.sock` из процесса, где исторически находились баги
(файловый менеджер, распаковка архивов, загрузки контента, прокси), оставив
сокет только в маленьком сервисе, который ревьюится целиком за один присест.

**Сделано — `apps/docker-shim` (единственный держатель сокета):**

- `src/docker.ts` — единственный экземпляр dockerode во всём стеке.
- `src/containers.ts` — адресация **только по `serverId`** через label-lookup
  `cofemine.serverId`. Эндпоинта, принимающего container id/name/filter, нет:
  радиус поражения скомпрометированного агента = множество MC-контейнеров,
  которые этот сервис сам и создал. Плюс проекция `inspect` — наружу не уходят
  bind-пути хоста, полный env (RCON-пароль, CF-ключ) и digest образа.
- `src/runtime/` — `ItzgRuntimeProvider` **переехал сюда**. Это ключевой пункт:
  если бы шим принимал `HostConfig`, RCE в агенте давало бы контейнер с
  `Binds: ["/:/host"]`, то есть тот же root на хосте, и разделение не окупалось
  бы. Теперь по проводу идёт только `ServerSpec`, а образ, монтирования,
  capabilities, сеть, `no-new-privileges` и `PidsLimit` решаются здесь.
- `src/ca-volumes.ts` + `src/maven-cache.ts` — засев CA-томов и пересоздание
  сайдкара (обе операции = «создать контейнер с bind'ами», то есть ровно тот
  примитив, который нельзя оставлять агенту).
- `src/servers.ts` — bind-путь установщика выводится из `serverId` и
  собственного `DATA_ROOT`, образ установщика ограничен allowlist'ом префиксов.
- `src/main.ts` — вся HTTP-поверхность, ~250 строк, отдельный `SHIM_TOKEN`
  (не `AGENT_TOKEN`, чтобы утечка одного не давала второго), `bodyLimit` 2 МБ.

Типизируется и собирается (`tsc` → `dist`), Dockerfile есть.

**Не сделано — миграция агента (без неё выигрыша нет: агент всё ещё монтирует
сокет).** Инвентарь:

1. `apps/agent/src/docker.ts` → HTTP-клиент шима (типизированный, ~15 операций).
2. `docker-pull.ts`, `runtime/*` — удалить (переехали в шим).
3. `utils/exec.ts` → `POST /mc/:id/exec`.
4. `ws/console.ts` (3 вызова) → `GET /mc/:id/logs/stream` + exec.
5. `routes/proxy.ts` (2 вызова) → `GET /mc/:id` (`networkIp` уже в проекции).
6. `routes/install.ts` (`updateContainerEnv`) → `POST /mc/:id/env`.
7. `routes/maven-cache.ts` → `POST /infra/ca` + `GET /infra/maven-cache`.
8. `routes/servers.ts` — ~40 мест. Файл 4700 строк и содержит NUL-байт, поэтому
   Grep по нему молчит: править через `grep -a`/Read, опираясь на `tsc` как на
   сеть безопасности (смена формы экспортируемого символа ловит все места).
9. Убрать `dockerode` из зависимостей агента.
10. Оба compose: сервис `docker-shim` с сокетом и **только** на
    `cofemine_internal`; агент теряет `docker.sock`, получает `SHIM_URL` +
    `SHIM_TOKEN`. CI-матрица: пятый образ. `.env.example`: `SHIM_TOKEN`.
11. Обновить `CLAUDE.md`, `.claude/rules/deploy-and-compose.md`,
    `.claude/skills/{node-agent,project-architecture,deployment-and-operations}`
    — сейчас они утверждают «только агент монтирует docker.sock».

Промежуточное состояние (часть вызовов через шим, часть напрямую) смысла не
имеет и деплоиться не должно: сокет остаётся у агента до пункта 10.

Остаётся открытым и требует решения:

- **Нет CRUD для `Membership`.** После ужесточения RBAC роли OPERATOR/VIEWER
  не имеют доступа к серверам через панель вообще — строки можно завести только
  напрямую в БД. Нужен эндпоинт, если эти роли используются.
- **`TRUST_PROXY`** оставлен на CIDR-пресетах. Счётчик хопов надёжнее, но
  неверное число сваливает все клиенты в один бакет рейт-лимита — задокументировано
  в `.env.example`, менять только с проверкой `req.ip` в аудите.
- **SAN-каверза Name Constraints**: squid копирует SAN оригинального сертификата
  в лист; если у CDN за Cloudflare есть SAN вне permitted-набора, лист станет
  невалидным для OpenSSL-клиентов (Java продолжит работать). Проверить на стенде.
- **Fastify 4 → 5 и Next 14 → 15**: оставшиеся high-адвайзори лечатся только
  мажорной миграцией, это отдельная задача с регрессионным прогоном.
- **Листинг публичных пакетов выключен по умолчанию** — после деплоя уже
  опубликованные паки исчезнут из `/p/index.json`, пока владелец не включит
  галочку во вкладке Client Pack. Это намеренно, но заметно пользователям.
- **Схема БД**: добавлены `Schedule.createdById` и `Server.publicPackListed` —
  оба nullable/с дефолтом, `db push` применит их без потери данных.
- **iframe карты — крупнейший оставшийся вектор XSS.** `allow-same-origin` +
  `allow-scripts` на своём же origin изоляции не даёт, а BlueMap — сторонний мод,
  чей webroot пишется файловым менеджером и любым модом. Не чинится атрибутом:
  без `allow-same-origin` origin становится opaque, cookie `SameSite=Lax` не
  отправляется и карта отваливается на 401. Нужен отдельный origin + токен
  вместо cookie. Подробности — в `docs/security.md`.
- **Лимита на количество расписаний на сервер нет** — не добавлял.
- **`nginx -t` для нового шаблона не прогнан в контейнере**: Docker-демон на
  машине разработки отключился посреди работы. Подстановка проверена статически
  (`envsubst` затрагивает только `${NGINX_REAL_IP_BLOCK}`, `${request_time}`
  в `log_format` остаётся нетронутым). Прогнать `nginx -t` до деплоя.

---

## 0. Ограничения, которые определяют порядок работ

Прочитать до начала — они меняют последовательность:

1. **Push в `main` = автодеплой в прод, без тестового гейта** (`.github/workflows/deploy.yml`). Любая правка ниже — это изменение продакшена. Работать в ветке, мержить осознанно.
2. **Часть правок требует пересоздания MC-контейнеров** (спека контейнера строится один раз при create). Их надо выкатывать **одной волной**, чтобы пользователь пересоздавал серверы один раз, а не пять. См. «Волна B».
3. **Агент запускается из скомпилированного `dist/`** (`node dist/main.js`) — правки в `apps/agent/src` требуют пересборки образа. `dist/` в рабочем дереве устаревший, не читать как référence.
4. **В prod-compose нет `${VAR:?}`-гардов** — забытая переменная молча станет пустой строкой.
5. `services/*/entrypoint.sh` обязаны остаться в LF (`.gitattributes`).

### Волны деплоя

| Волна | Содержимое | Требует пересоздания MC-контейнеров |
|---|---|---|
| **A** | CI-гейт, правки только в API (фаза 2), squid/nginx конфиги | Нет (squid/nginx — пересоздание только сайдкара) |
| **B** | Разделение CA + ротация + хардненинг спеки контейнера + RCON + запрет `UID/GID` | **Да, один раз на всё** |
| **C** | Снижение прав агента (non-root), rootless/socket-proxy | Нет (но требует простоя агента) |

---

## Фаза 0 — подготовка

### 0.1 Гейт в CI перед рискованными правками — S
**Где:** `.github/workflows/deploy.yml` (сейчас job `build` сразу пушит образы, проверок нет).
**Что:** добавить job `check` (`pnpm -r exec tsc --noEmit`) как `needs` для `build`. Без него любая опечатка в правках ниже уезжает в прод.
**Проверка:** намеренно сломать тип → пайплайн падает до пуша образов.

### 0.2 Ротация секретов — S
**Где:** `.env` (dev), секреты прода.
**Что:** в dev-`.env` лежат заведомо слабые значения (`JWT_SECRET=local-dev-...`, `AGENT_TOKEN=local-dev-agent-token`, `BOOTSTRAP_OWNER_PASSWORD=admin1234`). Убедиться, что в проде **другие**, сгенерированные (`openssl rand -base64 32`). Файл не в git — это хорошо, но проверить, что и в истории его нет: `git log --all --full-history -- .env`.
**Проверка:** `git log` пуст; прод-значения отличаются от примеров.

---

## Фаза 1 — критично: CA и кэширующий прокси

### 1.1 Приватный ключ CA убрать из MC-контейнеров — M ⚠️ КРИТИЧНО
**Где:**
- `apps/agent/src/routes/maven-cache.ts:41` (`CA_VOLUME_NAME`), `:60-62` (`reseedCaWrapper`), `:161-176` (запись cert+key)
- `apps/agent/src/runtime/itzg-provider.ts:249-251` (bind тома в MC-контейнер)

**Проблема:** `ca.key` пишется в том `cofemine_maven_cache_ca`, и **этот же том** монтируется в каждый MC-контейнер. `import.sh` читает только `ca.crt` и `.ready` (`maven-cache.ts:92-93`) — ключ там не нужен вообще.

**Что сделать — разделить на два тома:**

| Том | Содержимое | Кто монтирует |
|---|---|---|
| `cofemine_maven_cache_ca` (существующий) | `ca.crt` + `ca.key` | только `maven-cache` → `/etc/cofemine/ca` (уже так в compose) |
| `cofemine_maven_cache_ca_pub` (новый) | `ca.crt` + `.ready` + `import.sh` | MC-контейнеры → `/cofemine-ca` |

Правки:
1. `maven-cache.ts`: добавить `export const CA_PUB_VOLUME_NAME = "cofemine_maven_cache_ca_pub"`.
2. `reseedCaWrapper()` — писать `import.sh` в **pub**-том.
3. В `/maven-cache/recreate`: cert+key → приватный том; cert + `.ready` + `import.sh` → pub-том. Ключ в pub не писать никогда.
4. `itzg-provider.ts:250` — биндить `CA_PUB_VOLUME_NAME`.
5. Обновить комментарии `maven-cache.ts:32-34` и `apps/api/src/integrations/maven-ca.ts:42-43` — сейчас они утверждают, что ключ не попадает в MC-контейнеры, и это неправда.

**Проверка:** `docker exec <mc-container> ls -la /cofemine-ca` → только `ca.crt`, `.ready`, `import.sh`. Сервер стартует, CA импортируется (лог `[cofemine-ca] imported into ...`).

### 1.2 Ротация CA после 1.1 — S ⚠️ обязательно
Старый ключ надо считать **скомпрометированным** — он лежал в контейнерах с чужим мод-кодом. После деплоя 1.1: сгенерировать новый CA в UI (Integrations → CA generate), затем пересоздать все MC-контейнеры. Если оператор ставил старый CA в браузер — удалить его из доверенных.

### 1.3 Закрыть squid как открытый прокси — S/M ⚠️
**Где:** `services/maven-cache/squid.conf.template:65-67` (единственное правило — `http_access allow all`; нет `Safe_ports`, `SSL_ports`, `to_localhost`).

**Проблема:** squid на `:8081` доступен всей `cofemine_mcnet`, и агент сам раздаёт MC-контейнерам `HTTPS_PROXY=http://maven-cache:8081`. Мод может сходить на `169.254.169.254` (облачные IAM-креды) или во внутреннюю сеть. В дефолте `MAVEN_CACHE_UPSTREAM` пуст → squid ходит напрямую.

**Делать в два шага — не ломать установки:**

**Шаг 1 (нулевой функциональный риск, делать сразу):**
```squid
acl SSL_ports port 443
acl Safe_ports port 80 443
acl CONNECT method CONNECT
acl to_metadata dst 169.254.0.0/16
acl to_private  dst 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8

http_access deny to_metadata
http_access deny to_private
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow all          # пока оставить
```

**Шаг 2 (после наблюдения):** сузить до allowlist доменов.
> ⚠️ **Осторожно:** MC-контейнер ходит через squid **всем** HTTPS-трафиком (кроме `NO_PROXY`). Жёсткий allowlist только CDN-доменов сломает установку модов, размещённых где-то ещё (GitHub-релизы, зеркала CF). Сначала неделю посмотреть `access_log` (`squid.conf.template:89`), собрать реальный список `dstdomain`, и только потом `http_access allow cdn_domains` + `http_access deny all`.

**Проверка:** из MC-контейнера `curl -x http://maven-cache:8081 http://169.254.169.254/` → 403. Установка модпака по-прежнему проходит.

### 1.4 Убрать Mojang из MITM-списка — S
**Где:** `services/maven-cache/squid.conf.template:49-50` (`.mojang.com`, `.minecraft.net` в `mitm_domains`).
**Проблема:** единственное, что уводит auth-трафик от прокси — клиентский `NO_PROXY` (`itzg-provider.ts:114-127`), а недоверенный мод его игнорирует и может прогнать сессионные токены через squid, где они расшифруются и попадут в `access_log`.
**Что:** удалить обе строки — тогда Mojang попадает под `ssl_bump splice all` (`:63`) и проходит без расшифровки. Кэшировать там нечего.
**Проверка:** вход игрока работает; в `access_log` для `sessionserver.mojang.com` виден `CONNECT`, а не `GET` с путём.

### 1.5 Включить проверку сертификатов upstream в nginx — S
**Где:** `services/maven-cache/nginx.conf` — во всех `location`-блоках есть `proxy_ssl_server_name on` + `proxy_ssl_name`, но нет `proxy_ssl_verify` (дефолт — **off**).
**Проблема:** nginx примет любой сертификат от upstream → отравление кэша (`proxy_cache_valid ... 180d`) отравленным `*-installer.jar`, который mc-image-helper затем **выполняет** → RCE на всех серверах.
**Что:** добавить в `http`-блок (наследуется в `location`):
```nginx
proxy_ssl_verify on;
proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
proxy_ssl_verify_depth 3;
```
Убедиться, что в образе есть `ca-certificates` (`services/maven-cache/Dockerfile`).
> Для сравнения: squid апстримы **проверяет** (`squid.conf.template:38`) — дыра только в nginx.

**Проверка:** прогрев кэша по каждому `location` проходит; при подмене cert — 502 вместо тихого кэширования.

### 1.6 Сузить и укоротить сам CA — S
**Где:** `apps/api/src/integrations/maven-ca.ts:123-154`.
**Что:** срок 10 лет → 90–180 дней с ротацией; добавить X.509 **Name Constraints** (`permittedSubtrees` = только CDN-домены), чтобы даже утёкший ключ не подделывал `*.mojang.com` и произвольные сайты. Мелочь: `notAfter` считается в локальном времени — перевести в UTC.
**Проверка:** `openssl x509 -text` показывает Name Constraints и новый срок; MITM по CDN работает, по постороннему домену — нет.

---

## Фаза 2 — авторизация и утечки данных в API

### 2.1 Глобальная роль перестаёт быть «полом» прав на каждом сервере — M ⚠️
**Где:** `apps/api/src/auth/rbac.ts:34-38`.
**Проблема:** `roles = [user.role]` + максимум с membership → глобальный `OPERATOR` получает `server.control`/`server.edit` на **любом** сервере, `VIEWER` — `server.view` на любом. При этом список серверов их прячет (`servers/routes.ts:108-111`) — прямое противоречие, доказывающее непреднамеренность.
**Эксплойт:** `POST /servers/<чужой-id>/command` — произвольная консольная команда = контроль над чужим сервером.
**Что:** глобальная роль работает как per-server грант **только** для OWNER/ADMIN. Для OPERATOR/VIEWER эффективная роль берётся из membership; нет membership → 403.
```ts
const globalCounts = user.role === "OWNER" || user.role === "ADMIN";
const roles: Role[] = globalCounts ? [user.role] : [];
if (membership) roles.push(membership.role as Role);
if (roles.length === 0) throw forbidden;
```
**Проверка:** регресс-тест — глобальный OPERATOR без membership получает 403 на `/servers/<чужой>/command` и на `GET /servers/<чужой>`; OWNER по-прежнему проходит. Проверить, что UI операторов не сломался (им нужны membership-строки).

### 2.2 `clone` требует `server.create` — S
**Где:** `apps/api/src/servers/routes.ts:315-317` — гейт `server.view`, хотя маршрут создаёт новый сервер и контейнер (`:356-378`).
**Что:** добавить `requireGlobalPermission("server.create")` (OWNER/ADMIN) + оставить `assertServerPermission(..., "server.view")` на источник.
**Проверка:** VIEWER/OPERATOR → 403; ADMIN → 201.

### 2.3 Санитизировать subpath в map-proxy — M ⚠️
**Где:** `apps/api/src/servers/map-routes.ts:152` — `subpath` из wildcard подставляется в URL агента без проверки, запрос уходит с `Authorization: Bearer <agent token>` (`:160`).
**Проблема:** Fastify декодирует `%2e%2e` → `..`, WHATWG-URL нормализует — можно выйти из `/proxy/<port>/` на другие маршруты агента (файловый менеджер — GET) от имени привилегированного токена ноды.
**Что:** отклонять `..`, `%2e`, backslash в subpath; после сборки URL проверить, что `new URL(target).pathname` начинается с `/servers/<serverId>/proxy/<port>/`.
**Проверка:** `GET /servers/X/map/%2e%2e%2f%2e%2e%2fservers/Y/files?path=/` → 400, а не содержимое чужого сервера.

### 2.4 Перестать возвращать секреты в ответах — M ⚠️
**Где:**
- `apps/api/src/servers/routes.ts:157` — `return { ...server }` с `include: { node: true, template: true }`
- `routes.ts:1495` (`/export` → `env: s.env`), `routes.ts:836-840` (ответ смены загрузчика → `env: next`)
- источник: `apps/api/src/servers/service.ts:111-114` — `CF_API_KEY` кладётся в `server.env` и персистится (`:252`)

**Проблема:** отдаётся расшифрованный CurseForge-ключ, а также весь `node` (включая `tokenHash` и внутренний host). Это **нарушение собственной конвенции проекта** (`.claude/rules/api-conventions.md`: «Responses leak-protect via explicit Prisma `select`... Never return whole Prisma models containing `password`, `tokenHash`...»).
**Что:**
1. Заменить spread на явный `select`/проекцию, как уже сделано в списке (`routes.ts:128-140`).
2. Вырезать секретные ключи из `env` перед отдачей (общий хелпер `redactEnv()`: `CF_API_KEY`, `*_KEY`, `*_TOKEN`, `*_PASSWORD`, `RCON_PASSWORD`).
3. Стратегически: не хранить `CF_API_KEY` в `server.env`, а инъектить в спеку при provision/reprovision — тогда его нечего утекать.

**Проверка:** `GET /servers/:id` не содержит `CF_API_KEY`, `tokenHash`, `node.host`.

### 2.5 Закрыть GET-маршруты интеграций — S
**Где:** `apps/api/src/integrations/routes.ts:112` (`GET /`), `:422` (download-proxy), `:474` (maven-cache status), `:512` (CA), `:575` (SMTP) — `integration.manage` стоит только на мутациях.
**Что:** добавить `preHandler: requireGlobalPermission("integration.manage")`.
> Пароли и приватный ключ там уже маскируются (`read*ForDisplay`), так что это раскрытие конфигурации, а не секретов — отсюда приоритет ниже.

**Проверка:** VIEWER → 403 на всех пяти.

---

## Фаза 3 — снижение прав на хост (основной запрос)

### 3.1 Агент не от root — M
**Где:** `apps/agent/Dockerfile:25-30` (нет `USER`).
**Проблема:** root-в-контейнере + `docker.sock` — худшая пара.
**Что:** `USER node` в стадии `runner`; агенту нужен доступ к сокету → добавить пользователя в группу-владельца сокета (gid docker-группы **хоста**, обычно 999/998) через `group_add` в compose:
```yaml
agent:
  user: "node"
  group_add:
    - "${DOCKER_GID:-999}"
```
Добавить `DOCKER_GID` в `.env.example` и **в оба** compose-файла (в prod нет `${VAR:?}`-гардов — забудешь, станет пустой строкой).
> Важно: агент пишет в `DATA_ROOT`/`BACKUP_ROOT` и делает `chown` на 1000:1000 (`servers.ts:848-871`). Под non-root `chown` чужих файлов упадёт — проверить, что `fix-permissions` и install-modloader ещё работают, иначе оставить `CAP_CHOWN`.

**Проверка:** `docker exec cofemine-agent-1 id` → не uid 0; создание/старт/бэкап сервера работают.

### 3.2 Харденинг спеки MC-контейнеров — S
**Где:** `apps/agent/src/runtime/itzg-provider.ts:252-271` (`hostConfig`).
**Что:** добавить
```ts
SecurityOpt: ["no-new-privileges"],
PidsLimit: 512,
```
Затем **опционально и с тестом** — `CapDrop: ["ALL"]` с возвратом того, что нужно itzg для `gosu`/`chown`: `CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`, `FOWNER`.
> `no-new-privileges` не мешает `gosu` (тот понижает привилегии, а не повышает), но проверить на тестовом сервере до массового пересоздания.

**Проверка:** сервер стартует, модпак ставится; `docker inspect` показывает флаги.

### 3.3 Запретить `UID`/`GID`/`RUN_AS_ROOT` в env сервера — S ⚠️
**Где:** `apps/agent/src/runtime/itzg-provider.ts:181` (`...spec.env` разворачивается как есть; вырезаются только `__COFEMINE_*` на `:210-212`).
**Проблема:** itzg уважает эти переменные — любой с `server.edit` делает JVM root'ом внутри контейнера. Это то, что обесценивает права `0600` на CA-ключе и вообще ломает изоляцию.
**Что:** денилист рядом с существующей чисткой `__COFEMINE_*`:
```ts
const FORBIDDEN_ENV = new Set(["UID", "GID", "RUN_AS_ROOT", "SKIP_SUDO"]);
for (const k of Object.keys(envMap)) if (FORBIDDEN_ENV.has(k)) delete envMap[k];
```
Плюс валидация на стороне API, чтобы пользователь видел ошибку, а не тихое игнорирование.
**Проверка:** попытка задать `UID=0` в env-табе → отклонена; `docker exec <mc> id` → uid 1000.

### 3.4 Случайный RCON-пароль — S
**Где:** `apps/agent/src/runtime/itzg-provider.ts:178` — `RCON_PASSWORD: \`rcon-${spec.id}\``.
**Проблема:** на общей `cofemine_mcnet` один скомпрометированный сервер зайдёт по RCON в другой, зная его UUID (а UUID виден в API-ответах).
**Что:** генерировать случайный пароль при создании сервера, хранить в `Server` (шифровано через `encryptSecret`) и передавать в спеке. Учесть: консоль и `/players` используют `rcon-cli` **внутри** контейнера (`utils/exec.ts`), он берёт пароль из env — то есть смена пароля прозрачна для этих путей.
**Проверка:** два сервера, с первого `rcon-cli -H <ip второго>` с предсказуемым паролем → отказ.

### 3.5 Сравнение токена агента за константное время — S
**Где:** `apps/agent/src/main.ts:33` — `auth.slice(7) !== config.AGENT_TOKEN`.
**Что:** `crypto.timingSafeEqual` на буферах равной длины (сначала сравнить длины). Правка в единственном глобальном preHandler — по конвенции агента per-route auth не добавлять.

### 3.6 Пути и SSRF в маршрутах агента — M
**Где:**
- `apps/agent/src/routes/backups.ts:51` — `tar.extract({ file: body.path })` по произвольному абсолютному пути
- `backups.ts:58` — `fs.rm(q.path)` по произвольному пути
- `apps/agent/src/routes/install.ts:55` — `downloadTo(url, ...)` по произвольному URL

**Проблема:** нарушает и конвенцию агента («любой путь из запроса — через `safeResolve`»), и `docs/security.md`, где написано, что все файловые маршруты покрыты. В связке с 2.3 это опаснее.
**Что:** прогнать оба пути через `safeResolve(config.AGENT_BACKUP_ROOT, ...)`; для скачиваний — allowlist схем (`https:`) и блок RFC1918/link-local/loopback перед запросом (и после редиректов — `maxRedirections: 5` уводит куда угодно).
**Проверка:** `POST /backups/x/restore` с `path=/etc/passwd` → 400.

### 3.7 Стратегическое: убрать root-эквивалентность сокета — L
Порядок предпочтения:
1. **Rootless Docker / Podman** — единственный вариант, при котором компрометация сокета ≠ root на хосте. Для self-hosted панели реалистично; требует миграции данных и проверки bind-mount путей (`DATA_ROOT` должен остаться идентичным на хосте и в агенте).
2. **Socket-proxy** (`tecnativa/docker-socket-proxy`) — агент ходит по TCP, прокси открывает только `containers`/`images`/`networks`/`volumes`/`exec`, режет `/info`, swarm, plugins.
   > Честная оговорка: агенту нужны `create` + `start` + `exec`, а это и есть «ключи от королевства» — socket-proxy не фильтрует **тело** запроса и не запретит `Privileged: true` или bind `/:/host` в `create`. Это defense-in-depth, а не барьер. Настоящий барьер — только п.1.
3. **Снять агент с `cofemine_mcnet`** — сейчас любой MC-контейнер достаёт `agent:4100`. Требует вынести map-proxy-путь в отдельный слушатель/сайдкар, т.к. проксирование карт — единственная причина этого подключения.

---

## Фаза 4 — остальной харденинг

- **4.1 `trustProxy`** — `apps/api/src/main.ts:35`: `true` → конкретный хоп/CIDR Caddy. Сейчас `X-Forwarded-For` подменяем → сброс rate-limit и подделка IP в audit-логе (`audit/service.ts:21`). **S**
- **4.2 Анти-brute-force на логине** — `apps/api/src/auth/routes.ts:53-66`: отдельный лимитер per-username + per-IP, экспоненциальный backoff/lockout. Сейчас только глобальные 600/мин, и те обходятся через 4.1. **S**
- **4.3 Зафиксировать алгоритм JWT** — `apps/api/src/auth/jwt.ts:16-21`: `{ algorithms: ["HS256"], issuer: "cofemine-panel" }`. Сейчас не эксплуатируется (строковый секрет ⇒ HMAC-only), но это дешёвый defense-in-depth. **S**
- **4.4 Валидация секретов в конфиге** — `apps/api/src/config.ts:9,11`: `JWT_SECRET` `min(16)` → `min(32)`; `SECRETS_KEY` `min(1)` → проверка base64→32 байта (сейчас реальная проверка в `crypto.ts` и падает при импорте, а не при валидации конфига); отбраковка очевидных дефолтов (`change-me`, `REPLACE_WITH`). **S**
- **4.5 CSP** — `apps/api/src/main.ts:54` (`contentSecurityPolicy: false`) на сервисе, который проксирует чужой HTML (BlueMap/dynmap). Включить ограничительную политику либо отдавать карту с отдельного origin — под это уже есть выделенный процесс `map-proxy-main.ts`. **M**
- **4.6 Публичные pack-URL из `Host`** — `apps/api/src/servers/public-pack-routes.ts:63-67`: строить из `config.API_PUBLIC_URL`, а не из заголовка клиента. **S**
- **4.7 First-run setup (TOFU)** — `apps/api/src/auth/routes.ts:34-51`: кто первым позвал `/auth/setup`, тот OWNER. Привязать к bootstrap-токену из env либо хотя бы задокументировать как известный риск окна установки. **S**
- **4.8 Argument injection в gost** — `services/maven-cache/entrypoint.sh:54,78`: `${FORWARD_FLAG}` используется без кавычек; host прокси не валидируется (`apps/api/src/integrations/routes.ts:78-82`, схема допускает пробелы). Закавычить/собрать массивом + валидировать host по charset. Admin-only, отсюда низкий приоритет. **S**

---

## Фаза 5 — документация и регрессии

### 5.1 Привести `docs/security.md` в соответствие с кодом — S ⚠️
Сейчас документ содержит **два неверных утверждения**, на которые люди будут опираться:
- «All file read/write/delete endpoints go through [safeResolve]» — неправда, см. 3.6.
- (в коде) «private key... never given to MC containers» — неправда до выполнения 1.1.

Также добавить раздел о модели доверия Docker-сокета (root-эквивалентность) и о том, что MITM-CA существует и что он делает.

### 5.2 Регресс-тесты на границы авторизации — M
Тестов в проекте нет вообще. Минимум, что стоит закрыть после фазы 2, — табличный тест на `assertServerPermission` (матрица роль × membership × permission) и smoke-тест на traversal в map-proxy. Это дешевле, чем повторно ловить 2.1 глазами.

---

## Сводный порядок

```
Ветка → 0.1 CI-гейт → 0.2 секреты
  │
  ├─ Волна A (без пересоздания контейнеров)
  │    2.1 RBAC → 2.2 clone → 2.3 map-proxy → 2.4 утечки → 2.5 GET-интеграции
  │    1.3 шаг1 squid → 1.4 Mojang → 1.5 nginx verify
  │    4.1–4.4 (дешёвые)
  │
  ├─ Волна B (одно пересоздание MC-контейнеров на всё)
  │    1.1 разделение CA → 3.2 хардненинг спеки → 3.3 денилист env → 3.4 RCON
  │    → деплой → 1.2 ротация CA → пересоздать все MC-контейнеры
  │
  ├─ Волна C
  │    3.1 non-root агент → 3.5 timingSafeEqual → 3.6 пути/SSRF
  │    → 3.7 rootless/socket-proxy (отдельный проект)
  │
  └─ 1.6 CA constraints, 1.3 шаг2 (после анализа логов), 4.5–4.8, 5.1, 5.2
```

**Если время только на один вечер:** 1.1 + 1.2 (ключ CA), 2.1 (RBAC), 2.3 (traversal), 3.3 (денилист env). Это закрывает всё, что даёт межсерверную компрометацию.
