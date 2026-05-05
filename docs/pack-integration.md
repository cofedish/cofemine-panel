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

### 2.2 GET `/api/p/<token>.json`

Метаданные одной сборки без скачивания binary. Дёшево, без обращения к
агенту.

```json
{
  "id": "cmopj53e7000599ihe0bgqk3r",
  "displayName": "Main pack",
  "versionName": "Main pack",
  "minecraft": "1.21.1",
  "loader": "neoforge",
  "loaderVersion": "21.1.228",
  "mrpackUrl": "https://panel.cofemine.ru/api/p/abcd...mrpack",
  "metadataUrl": "https://panel.cofemine.ru/api/p/abcd...json",
  "updatedAt": "2026-05-05T12:00:00.000Z"
}
```

| Header                | Value                                             |
|-----------------------|---------------------------------------------------|
| `Content-Type`        | `application/json`                                |
| `Cache-Control`       | `no-store`                                        |

`404` с `{"error":"Not found"}` если токен невалиден или отозван.

### 2.3 GET `/api/p/index.json`

Листинг всех сборок с включённым публичным токеном на этой панели.

```json
{
  "packs": [
    {
      "id": "cmopj53e7000599ihe0bgqk3r",
      "displayName": "Main pack",
      "versionName": "Main pack",
      "minecraft": "1.21.1",
      "loader": "neoforge",
      "loaderVersion": "21.1.228",
      "mrpackUrl": "https://panel.cofemine.ru/api/p/abcd...mrpack",
      "metadataUrl": "https://panel.cofemine.ru/api/p/abcd...json",
      "updatedAt": "2026-05-05T12:00:00.000Z"
    },
    {
      "id": "...",
      "displayName": "Tech-only pack",
      "minecraft": "1.20.1",
      "loader": "fabric",
      "loaderVersion": "0.16.5",
      "mrpackUrl": "https://panel.cofemine.ru/api/p/efgh...mrpack",
      "metadataUrl": "https://panel.cofemine.ru/api/p/efgh...json",
      "updatedAt": "2026-04-30T18:42:11.000Z"
    }
  ],
  "generatedAt": "2026-05-05T12:00:00.000Z"
}
```

Auth — нет. Кто знает URL панели — может перечислить публичные сборки.
Если сервер не должен фигурировать в листинге — у него не должен быть
включён публичный токен (или его нужно отозвать через Client Pack →
«Disable»).

`displayName` берётся из `server.name`. URL'ы (mrpackUrl / metadataUrl)
строятся от `Host` запроса с учётом `X-Forwarded-*`, так что лаунчер
получает сразу готовые ссылки на тот же домен, через который пришёл.

---

## 3. .mrpack file layout

ZIP-архив. В корне:

```
<pack>.mrpack
├── modrinth.index.json   # spec-manifest, парсят лаунчеры
├── manifest.json         # panel-specific, человекочитаемый
└── overrides/            # всё содержимое сборки
    ├── mods/             # ВСЕ jar'ы (server + client + auto-detected)
    ├── config/
    ├── resourcepacks/
    ├── kubejs/           (если был)
    └── defaultconfigs/   (если был)
```

Никакого `client-overrides/` / `server-overrides/` нет — всё лежит в
`overrides/`. Это совместимо с HMCL, Prism, Modrinth App, ATLauncher
без условий.

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

### 3.3 Что лежит в `overrides/`

| Подкаталог            | Что содержит                                                           |
|-----------------------|------------------------------------------------------------------------|
| `overrides/mods/`     | все jar'ы: серверные моды + клиентские (Iris/Sodium/Xaero/шейдеры) + auto-detected client-only моды из CF cache |
| `overrides/config/`   | `/data/config/` сервера                                                |
| `overrides/resourcepacks/` | `/data/resourcepacks/` сервера                                    |
| `overrides/kubejs/`   | `/data/kubejs/` (если был)                                             |
| `overrides/defaultconfigs/` | `/data/defaultconfigs/` (если был)                               |

При установке: развернуть всё содержимое `overrides/` поверх инстанса.

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

## 6. Possible future additions (panel side)

В текущей версии для интеграции достаточно §2.1–2.3. Но если потребуется,
есть смысл добавить:

### 6.1 Расширить `/api/p/<token>.json` полями
- `modCount: number` — посчитать файлы в `/data/mods` + `/data/.cofemine-client/mods`.
- `approxSizeBytes: number` — сумма размеров всех файлов, включаемых в ZIP.
- `contentHash: "sha256:..."` — детерминированный fingerprint
  (sorted list of `<filename>:<size>` для server + client mods + configs).
  Позволит лаунчеру дёшево обнаруживать обновления без скачивания binary.

Сейчас этих полей нет — они требуют обращения к агенту, что замедляет
metadata-запрос.

### 6.2 `HEAD /api/p/<token>.mrpack` с `ETag`

Возвращать `ETag: "<contentHash>"` + `Last-Modified`. После этого лаунчер
может делать conditional GET с `If-None-Match` → `304 Not Modified`,
если ничего не изменилось.

### 6.3 Гейт на `/api/p/index.json`

Если нужно прятать листинг от случайных посетителей — добавить опциональный
shared secret через header `X-Index-Token` (читать из конфига панели).
Лаунчер хранит секрет в собственной конфигурации.

---

## 7. Edge cases

| Случай | Поведение |
|--------|-----------|
| Сервер ни разу не запускался | `/data/config/`, `/data/resourcepacks/` отсутствуют → `overrides/` без них. Сборка валидна, просто худее. |
| Сервер не имеет CF-кэша | Auto-detected client-only моды отсутствуют → `overrides/mods/` содержит только серверные моды + то, что юзер вручную залил во вкладку Client Mods. |
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

UPDATE
  manual refresh now; conditional GET после §6.2.

ERRORS
  404 → invalid/revoked token
  5xx → retry 3 раза с backoff, потом fail
```

Этого достаточно, чтобы реализовать клиентскую интеграцию end-to-end.
