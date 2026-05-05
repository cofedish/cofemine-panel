# Cofemine Panel — интеграция клиентских сборок (.mrpack)

Документ для AI-агента, реализующего поддержку Cofemine-сборок в **лаунчере** и/или
на **сайте**. Описывает контракт публичного API панели и формат сборки.

---

## TL;DR

- Каждый сервер на панели = одна клиентская сборка.
- У сервера может быть включён **публичный токен** (32 hex-символа).
  Без токена публичной ссылки нет.
- Публичный URL сборки: `https://<panel>/api/p/<token>.mrpack`.
- Без авторизации, без cookies, без CORS — это статичный binary stream.
- Содержимое — стандартный Modrinth `.mrpack` (ZIP) +
  дополнительный человекочитаемый `manifest.json` в корне.
- Чтобы дать пользователю выбор из нескольких сборок — лаунчер/сайт
  держит список `{id, displayName, mrpackUrl, ...}` в собственном конфиге;
  multi-pack индекса на стороне панели **сейчас нет** (см. «Recommended additions»).

Базовый домен в примерах: `https://panel.cofemine.ru`. В коде использовать
переменную окружения, не хардкодить.

---

## 1. Authentication model

| URL prefix              | Auth                          |
|-------------------------|-------------------------------|
| `/api/p/*`              | **none** (публичная зона)     |
| `/api/auth/*` whitelist | `/auth/login`, `/auth/setup-status`, `/auth/setup`, `/auth/forgot-password`, `/auth/reset-password` |
| любые другие `/api/*`   | session cookie (httpOnly)     |

`/api/p/*` whitelist'нут в API auth-gate (`apps/api/src/main.ts`).
Лаунчеру не нужно ничего знать о cookie-аутентификации панели.

---

## 2. Endpoint contract

### 2.1 GET `/api/p/<token>.mrpack`

Скачать клиентскую сборку.

| Field            | Value                                              |
|------------------|----------------------------------------------------|
| Method           | `GET`                                              |
| Path             | `/api/p/<token>.mrpack`                            |
| Token format     | `[a-f0-9]{32}` (32 hex), case-insensitive          |
| Auth             | none                                               |
| Cache            | панель не выставляет `Cache-Control` / `ETag`      |

**Success response**

| Header                 | Value                                         |
|------------------------|-----------------------------------------------|
| `Content-Type`         | `application/zip`                             |
| `Content-Disposition`  | `attachment; filename="<packName>.mrpack"`    |
| `Transfer-Encoding`    | `chunked` (Content-Length НЕ выставляется)    |

Тело — ZIP в формате Modrinth `.mrpack` (см. §3).

**Error responses**

| Status | Body                          | Когда                                    |
|--------|-------------------------------|------------------------------------------|
| 404    | `{"error":"Not found"}`       | токен не матчит regex / не найден в БД   |
| 5xx    | `{"error":"<message>"}`       | агент недоступен / ошибка при сборке ZIP |

**Тайминг**

- Time-to-first-byte: 1–3 секунды (агент начинает стримить ZIP по мере того,
  как archiver добавляет файлы).
- Total time: зависит от размера сборки + скорости загрузки CF-модов через
  прокси (auto-detect клиентских модов стримится с CDN при сборке).

**Идемпотентность.** Каждый запрос пересобирает ZIP с нуля. Контент может
немного отличаться между запросами (timestamp в `manifest.builtAt`,
`modrinth.index.json.versionId`).

### 2.2 (нет других публичных endpoints)

Метаданных без скачивания binary — нет. См. §6 «Recommended additions».

---

## 3. .mrpack file layout

ZIP-архив. В корне:

```
<pack>.mrpack
├── modrinth.index.json   # spec-manifest, парсят лаунчеры
├── manifest.json         # panel-specific, человекочитаемый
├── overrides/            # для обеих сторон
│   ├── config/
│   ├── resourcepacks/
│   ├── kubejs/           (если был)
│   └── defaultconfigs/   (если был)
├── client-overrides/     # только клиент
│   └── mods/             # Iris, Sodium, Xaero, шейдеры, JEI extras
└── server-overrides/     # только сервер
    └── mods/             # серверные моды (по умолчанию)
```

### 3.1 `modrinth.index.json`

Стандарт Modrinth (https://docs.modrinth.com/docs/modpacks/format_definition/).
Лаунчеры (Prism, Modrinth App, ATLauncher) читают именно этот файл.

```json
{
  "formatVersion": 1,
  "game": "minecraft",
  "versionId": "2026-05-05",
  "name": "MyPack",
  "summary": "Exported by Cofemine Panel",
  "files": [],
  "dependencies": {
    "minecraft": "1.21.1",
    "neoforge": "21.1.228"
  }
}
```

Поле `files` всегда пустое — Cofemine кладёт всё содержимое в `overrides/`
(а не ссылается на CDN). Это значит: лаунчеру не нужен сетевой доступ к
Modrinth/CF при установке, всё уже внутри ZIP.

`dependencies` ключи: `minecraft` (всегда), плюс один из:
- `neoforge`
- `forge`
- `fabric-loader`
- `quilt-loader`

Если loader не определён (vanilla-сборка) — будет только `minecraft`.

### 3.2 `manifest.json` (panel-specific)

```json
{
  "versionName": "MyPack",
  "minecraft": "1.21.1",
  "loader": "neoforge",
  "loaderVersion": "21.1.228",
  "builtAt": "2026-05-05T12:00:00.000Z",
  "builtBy": "Cofemine Panel"
}
```

Поле `loader` нормализовано: `"neoforge"`, `"forge"`, `"fabric"`,
`"quilt"`, либо `null` для vanilla.

Используй **этот** файл в UI лаунчера (он проще `modrinth.index.json`),
но для технической установки опирайся на `modrinth.index.json` — он
является спекой.

### 3.3 Что лежит в `overrides/`, `client-overrides/`, `server-overrides/`

| Папка               | Что содержит                                                           |
|---------------------|------------------------------------------------------------------------|
| `overrides/`        | `config/`, `resourcepacks/`, `kubejs/`, `defaultconfigs/` — общее      |
| `client-overrides/` | моды, помеченные как client-only (по `sides.json` или autodetect из CF cache) |
| `server-overrides/` | серверные моды по умолчанию                                            |

При **клиентской** установке: разворачивать `overrides/` + `client-overrides/`
поверх инстанса. `server-overrides/` **игнорировать**.

---

## 4. Launcher integration recipe

### 4.1 Конфиг лаунчера

Лаунчер хранит список доступных сборок как массив объектов. Минимум:

```jsonc
{
  "packs": [
    {
      "id": "main",
      "displayName": "Main pack",
      "mrpackUrl": "https://panel.cofemine.ru/api/p/abcd1234abcd1234abcd1234abcd1234.mrpack",

      // Опционально — продублировать metadata, чтобы UI показывал
      // версию MC / loader без скачивания .mrpack:
      "minecraft": "1.21.1",
      "loader": "neoforge",
      "loaderVersion": "21.1.228",
      "iconUrl": null
    }
  ]
}
```

`displayName`, `iconUrl`, `minecraft`, `loader`, `loaderVersion` — это копия
для UI; **источник истины** — `manifest.json` внутри скачанного `.mrpack`.
После первой установки лаунчер обязан перечитать manifest и обновить запись.

### 4.2 Поток установки

```
1. User выбирает pack из списка.
2. GET <mrpackUrl> → temp file (с прогресс-баром на байты, без Content-Length —
   используй tracking прочитанных байт).
3. Распаковать ZIP в staging dir.
4. Прочитать modrinth.index.json:
   - mc = dependencies.minecraft
   - loader, loaderVersion = первый ключ кроме "minecraft"
5. Создать / обновить инстанс Minecraft с этой версией MC + loader
   (используй ту же логику что у лаунчера для импорта обычного .mrpack).
6. Скопировать в инстанс:
   - <staging>/overrides/*           → <instance>/
   - <staging>/client-overrides/*    → <instance>/  (overrides/ имеют приоритет, потом client-overrides/ их переопределяет)
   - <staging>/server-overrides/*    → ПРОПУСТИТЬ
7. Удалить staging.
8. Сохранить metadata (версия, builtAt, hash файла) в state лаунчера.
```

### 4.3 Update detection

Панель **сейчас не выставляет** `ETag` / `Last-Modified` — каждый запрос
пересобирает ZIP, и его байты отличаются (timestamp в manifest).

Стратегии:
- **Manual refresh.** Кнопка «Проверить обновления» в UI лаунчера → скачать
  заново, сравнить SHA-256 от `modrinth.index.json` (детерминированной части)
  с сохранённым. Если другой — переустановить.
- **По расписанию.** Раз в день / на старте лаунчера — то же самое в
  фоне.
- **Когда панель добавит metadata-endpoint** (см. §6) — сравнивать
  без скачивания binary.

### 4.4 Deep-link (опционально)

Modrinth App регистрирует протокол `modrinth://`. Сайт / лаунчер могут
отдать кнопку:

```html
<a href="modrinth://import?url=https%3A%2F%2Fpanel.cofemine.ru%2Fapi%2Fp%2F...mrpack">
  Открыть в Modrinth App
</a>
```

Prism / ATLauncher регистрируют `.mrpack` как mime-type — обычная ссылка
с `download` → пользователь жмёт двойным кликом, лаунчер импортирует.

### 4.5 Cancel / errors

- HTTP 404 → токен отозван / сборка удалена. UI: «Сборка больше недоступна,
  спросите у админа».
- HTTP 5xx → агент / прокси упали. Retry с экспоненциальным backoff (3
  попытки, 5/15/45 сек), потом — показать ошибку.
- Tcp reset / timeout посреди download → клиент должен поддерживать resume
  через `Range`. Панель **сейчас Range не поддерживает** (стрим on-the-fly).
  Лаунчер должен начать с нуля.

---

## 5. Website embed recipe

Простейший вариант — статика:

```jsx
const PACKS = [
  {
    id: "main",
    name: "Main pack",
    mrpackUrl: "https://panel.cofemine.ru/api/p/<token>.mrpack",
    mc: "1.21.1",
    loader: "NeoForge 21.1.228",
  },
];

return PACKS.map((p) => (
  <a key={p.id} href={p.mrpackUrl} download>
    {p.name} — MC {p.mc}, {p.loader}
  </a>
));
```

Дополнительные кнопки (опционально):

```jsx
// "Открыть в Modrinth App"
<a href={`modrinth://import?url=${encodeURIComponent(p.mrpackUrl)}`}>
  Modrinth App
</a>
```

Можно прокинуть pre-fetch checks: `HEAD <mrpackUrl>` → если `200`, кнопка
активна; иначе показать «временно недоступно». В одном RTT, без скачивания
тела.

---

## 6. Recommended additions (panel side)

Чтобы интеграция была удобнее, на панель стоит добавить эндпоинты ниже.
Если AI-агент видит, что без них клиентский UX страдает — пусть
запросит / реализует:

### 6.1 `GET /api/p/<token>.json`

Metadata-only (без binary), для прогрева UI лаунчера.

```json
{
  "versionName": "MyPack",
  "minecraft": "1.21.1",
  "loader": "neoforge",
  "loaderVersion": "21.1.228",
  "modCount": 142,
  "approxSizeBytes": 187654321,
  "builtAt": "2026-05-05T12:00:00.000Z",
  "contentHash": "sha256:..."
}
```

`contentHash` — SHA-256 от детерминированного фингерпринта (sorted list of
`<filename>:<size>` для server mods + client mods + configs). Лаунчер
сохраняет его и сравнивает на «есть ли апдейт» без скачивания.

### 6.2 `HEAD /api/p/<token>.mrpack`

Должен возвращать `ETag: "<contentHash>"` + `Last-Modified`. После этого
лаунчер может делать conditional GET с `If-None-Match` → `304 Not Modified`,
если ничего не изменилось.

### 6.3 `GET /api/packs/public-index.json`

Multi-pack листинг — список всех серверов с активным `publicPackToken`,
с metadata (как §6.1) + URL. Опционально гейтить по `X-Index-Token` header
(один shared secret), чтобы не индексировать всю панель публично.

```json
{
  "packs": [
    {
      "id": "<server-id>",
      "displayName": "Main",
      "mrpackUrl": "https://panel.cofemine.ru/api/p/<token>.mrpack",
      "metadata": { /* §6.1 shape */ }
    }
  ],
  "generatedAt": "2026-05-05T12:00:00.000Z"
}
```

Это позволит лаунчеру и сайту брать список сборок одним запросом, без
ручного конфига.

---

## 7. Edge cases

| Случай | Поведение |
|--------|-----------|
| Сервер ни разу не запускался | `/data/config/`, `/data/resourcepacks/` отсутствуют → `overrides/` без них. Сборка валидна, просто худее. |
| Сервер не имеет CF-кэша | Auto-detected client-only моды отсутствуют → `client-overrides/mods/` будет содержать только то, что юзер вручную залил во вкладке Client Mods. |
| Owner отозвал токен | `/api/p/<old>.mrpack` → `404`. Лаунчер видит 404, помечает запись как «invalid». |
| Owner ротировал токен | старый токен не работает, новый — работает. UI лаунчера должен дать пользователю место, куда вставить новый URL (или пере-импорт сборки). |
| Размер 200–500 MB | Лаунчер обязан показывать прогресс и иметь cancel. |
| Прокси на стороне панели | Transparent для клиента: панель сама проксирует CF-загрузки через свой SOCKS, лаунчеру ничего настраивать не надо. |
| Параллельные скачивания одной сборки | Каждый запрос пересобирает ZIP отдельно. Безопасно, но лучше не давить — на каждый byte идёт стрим из агента. |

---

## 8. Quick reference (для AI-агента)

```
ENVIRONMENT
  PANEL_BASE_URL=https://panel.cofemine.ru

STORAGE (в лаунчере / на сайте)
  packs: Array<{
    id: string,
    displayName: string,
    mrpackUrl: string,           // https://<panel>/api/p/<token>.mrpack
    minecraft?: string,           // cached from manifest.json
    loader?: "neoforge"|"forge"|"fabric"|"quilt"|null,
    loaderVersion?: string,
    contentHash?: string,         // когда §6.1 будет, для update detection
  }>

DOWNLOAD
  GET <mrpackUrl> → ZIP (application/zip)
  Парсить:
    - read modrinth.index.json (spec)
    - read manifest.json (UI hints)

INSTALL (в инстанс)
  copy overrides/ → instance/
  copy client-overrides/ → instance/  (override-friendly)
  skip server-overrides/

UPDATE
  manual refresh now; conditional GET после §6.2.

ERRORS
  404 → invalid/revoked token
  5xx → retry 3 раза с backoff, потом fail
```

Этого достаточно, чтобы реализовать клиентскую интеграцию end-to-end.
