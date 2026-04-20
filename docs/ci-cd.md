# CI/CD — автодеплой на сервер

Схема: каждый push в `main` → GitHub Actions собирает три образа (`api`, `agent`, `web`) → пушит в GHCR → подключается по SSH к серверу → делает `git pull && docker compose pull && docker compose up -d` → проверяет `/health`.

Один раз нужно настроить:
1. SSH-ключ для деплоя.
2. GitHub Secrets.
3. Первичную инициализацию сервера (Docker, clone, `.env`).

## 1. SSH-ключ для деплоя

На **локальной машине** (Git Bash на Windows):

```bash
ssh-keygen -t ed25519 -C "cofemine-deploy" -f ~/.ssh/cofemine_deploy -N ""
```

Создаются два файла:
- `~/.ssh/cofemine_deploy` — **приватный** ключ (в GitHub Secrets)
- `~/.ssh/cofemine_deploy.pub` — **публичный** ключ (на сервер)

Положите публичный ключ в `authorized_keys` сервера. Если у вас уже есть парольный доступ:

```bash
ssh-copy-id -i ~/.ssh/cofemine_deploy.pub cofedish@37.195.210.6
```

Или вручную:

```bash
cat ~/.ssh/cofemine_deploy.pub | ssh cofedish@37.195.210.6 \
  "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh"
```

Проверьте, что ключ работает:

```bash
ssh -i ~/.ssh/cofemine_deploy cofedish@37.195.210.6 "echo ok"
```

## 2. GitHub Secrets

На странице репозитория: **Settings → Secrets and variables → Actions → New repository secret**. Добавьте:

| Имя | Значение |
|---|---|
| `DEPLOY_HOST` | `37.195.210.6` |
| `DEPLOY_USER` | `cofedish` |
| `DEPLOY_PATH` | `/home/cofedish/Desktop/Projects/cofemine-panel` |
| `DEPLOY_SSH_KEY` | **содержимое** файла `~/.ssh/cofemine_deploy` целиком, включая строки `-----BEGIN OPENSSH PRIVATE KEY-----` и `-----END OPENSSH PRIVATE KEY-----` |
| `DEPLOY_PORT` | *(опционально)* если SSH не на 22 |

GHCR отдельно настраивать **не нужно** — workflow использует встроенный `GITHUB_TOKEN`, у него уже есть права `packages: write`.

## 3. Первичная настройка сервера

Залогиньтесь на сервер:

```bash
ssh cofedish@37.195.210.6
```

### 3.1. Docker + Compose v2

Если ещё не установлены:

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# разлогинитесь и зайдите снова, чтобы группа docker применилась
```

Проверка:
```bash
docker --version
docker compose version
```

### 3.2. Клонирование репо

```bash
mkdir -p ~/Desktop/Projects
cd ~/Desktop/Projects
git clone https://github.com/cofedish/cofemine-panel.git
cd cofemine-panel
```

### 3.3. `.env` с секретами

Компоуз требует ряд переменных. Сгенерируйте их один раз:

```bash
cat > .env <<EOF
# Postgres
POSTGRES_USER=cofemine
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
POSTGRES_DB=cofemine

# Panel
JWT_SECRET=$(openssl rand -base64 48 | tr -d '/+=')
SECRETS_KEY=$(openssl rand -base64 32)
AGENT_TOKEN=$(openssl rand -base64 32 | tr -d '/+=')

# URLs (замените на свой домен/IP когда поднимете reverse proxy)
WEB_ORIGIN=http://37.195.210.6:3000
API_PUBLIC_URL=http://37.195.210.6:3000/api
WEB_PORT=3000

# Optional: bootstrap owner — если заполнено, панель создаст этого пользователя
# при первом запуске автоматически. Иначе зайдите на /setup в UI.
BOOTSTRAP_OWNER_EMAIL=
BOOTSTRAP_OWNER_USERNAME=
BOOTSTRAP_OWNER_PASSWORD=
EOF

chmod 600 .env
```

**Важно:** `.env` не должен попадать в git. `.gitignore` его уже исключает, но проверьте `git status` перед commit'ами с сервера.

### 3.4. Первый запуск вручную

Чтобы проверить, что всё поднимается, **до** первого push'а через CI:

```bash
# Образы публичные — pull без логина
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

Откройте `http://37.195.210.6:3000`. При первом заходе увидите экран first-run setup (создание OWNER-аккаунта).

## 4. Первый push → авто-деплой

С этого момента любой `git push` в `main` запускает workflow:

1. CI собирает три образа и пушит в `ghcr.io/cofedish/cofemine-panel/{api,agent,web}:latest` (плюс тег `sha-<короткий-sha>` для возможности отката).
2. CI заходит по SSH на сервер, делает `git reset --hard origin/main` (чтобы compose-файл был актуален), `docker compose pull`, `docker compose up -d`.
3. Ждёт до 50 секунд, что API ответит `200` на `/health`. Если нет — печатает последние 200 строк логов api и фейлит деплой.

Статус деплоя — во вкладке **Actions** репозитория.

## 5. Откат

Если последний деплой сломал прод:

```bash
ssh cofedish@37.195.210.6
cd ~/Desktop/Projects/cofemine-panel

# Смотрим доступные теги в GHCR
docker images | grep cofemine-panel

# Запускаем предыдущий SHA
API_IMAGE=ghcr.io/cofedish/cofemine-panel/api:sha-ABCDEFG \
AGENT_IMAGE=ghcr.io/cofedish/cofemine-panel/agent:sha-ABCDEFG \
WEB_IMAGE=ghcr.io/cofedish/cofemine-panel/web:sha-ABCDEFG \
docker compose -f docker-compose.prod.yml up -d
```

Эти переменные перекрывают `latest` в compose-файле.

## 6. Reverse proxy (опционально, рекомендуется)

Когда будете вешать домен и HTTPS — вытащите `web` из прямого публичного `ports:` и заверните через Caddy. Пример `Caddyfile`:

```
panel.example.com {
  reverse_proxy localhost:3000
}
```

Потом в `.env`:
```
WEB_ORIGIN=https://panel.example.com
API_PUBLIC_URL=https://panel.example.com/api
```

## Troubleshooting

- **CI фейлится на `appleboy/ssh-action`** — 99% случаев это неверный формат `DEPLOY_SSH_KEY`. Скопируйте файл целиком, с переводами строк, с обоими `BEGIN`/`END`.
- **`permission denied` при `docker compose`** — пользователь не в группе `docker`. `sudo usermod -aG docker cofedish` и перелогиньтесь.
- **`Cannot connect to the Docker daemon`** — `sudo systemctl start docker` и `enable` для автостарта.
- **Порт 3000 закрыт извне** — откройте файрвол: `sudo ufw allow 3000/tcp` (либо настройте через вашу панель VPS).
- **Образы не пулятся с GHCR** — если GHCR приватный (он у вас публичный, но на будущее), нужно сделать `docker login ghcr.io` на сервере с PAT.
