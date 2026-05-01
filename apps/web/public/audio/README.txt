Cofemine Panel — фоновая музыка
================================

Сюда складываются музыкальные файлы для проигрывания на заднем фоне
панели. Любой формат, который умеет браузер: mp3, ogg, wav, m4a, flac.

Файлы саундтреков Minecraft (C418, Lena Raine) НЕ распространяются с
проектом — авторские права у композиторов. Покупай Volume Alpha /
Beta на c418.bandcamp.com и клади свои файлы сюда.

КАК ДОБАВИТЬ ТРЕК
-----------------

1. Скопируй mp3 (или ogg/wav/...) в эту папку.

2. Узнай BPM трека. Округлённо для основных:
     Sweden            ~ 88
     Mice on Venus     ~ 91
     Subwoofer Lullaby ~ 76
     Wet Hands         ~ 80
     Otherside         ~ 100
     Pigstep           ~ 124
   Не уверен — прогони через https://tunebat.com или `aubiotrack`.

3. Допиши трек в manifest.json:

     {
       "tracks": [
         { "url": "/audio/sweden.mp3",  "title": "Sweden",       "bpm": 88 },
         { "url": "/audio/pigstep.mp3", "title": "Pigstep",      "bpm": 124 }
       ]
     }

4. Включи музыку в Настройки → Внешний вид → Фоновая музыка.
   Силуэт блоков внизу страницы синхронизируется с битом текущего
   трека. Если manifest.json пустой — анимация работает на запасных
   90 BPM, без звука.

ГДЕ ИМЕННО КЛАСТЬ ФАЙЛЫ
-----------------------

Зависит от того как у тебя запущена панель.

* Локальный dev (pnpm dev):
    apps/web/public/audio/<твой файл>.mp3
  Next.js подхватывает файлы из public/ на лету, ребилд не нужен.

* Docker (docker-compose.yml — dev compose):
  В web-сервисе уже есть bind-mount:
    ${AUDIO_DIR:-./apps/web/public/audio}:/app/apps/web/public/audio:ro
  По умолчанию это та же папка в репе — можно класть сюда. Если
  хочешь хранить треки отдельно от исходников, поставь в .env:
    AUDIO_DIR=/path/to/your/music
  и положи туда manifest.json + файлы.

* Production (docker-compose.prod.yml):
  По умолчанию монтируется хостовая папка /var/lib/cofemine/audio.
  Создай её, положи туда manifest.json и треки, перезапусти контейнер
  web (docker compose restart web). Ребилд образа не нужен — bind-
  mount вступает в силу при старте контейнера.
  Чтобы поменять путь: AUDIO_DIR=/your/path в .env.

Файлы (.mp3/.ogg/.wav/...) в apps/web/public/audio/ занесены в
.gitignore, чтобы случайно не закоммитить в публичный репо.
