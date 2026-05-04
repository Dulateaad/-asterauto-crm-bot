# asterauto-crm-bot

Telegram CRM-бот для **Aster Auto**: лиды, менеджеры, АТЗ, РОП, SLA. Данные в **Firebase** (по умолчанию `asterauto-d8e74`), коллекции с префиксом `ltb*`.

## Стек

Node 18+, TypeScript, Telegraf, firebase-admin (только сервисный аккаунт).

## Быстрый старт

```bash
cp .env.example .env
# Заполнить TELEGRAM_BOT_TOKEN, BOT_ADMIN_IDS, ключ Firebase (см. ниже)
mkdir -p secrets
# Положить serviceAccount.json из Firebase Console → Project settings → Service accounts
npm install
npm run build
npm start
```

Локально удобно: `npm run dev`.

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `FIREBASE_PROJECT_ID` | Должен совпадать с `project_id` в JSON ключа (часто `asterauto-d8e74`) |
| `BOT_WEBHOOK_SECRET` | Опционально: 8+ символов `A-Za-z0-9_-` для проверки webhook-заголовка |
| `BOT_WEBHOOK_PUBLIC_URL` | Опционально: публичный HTTPS URL, если не Render (иначе берётся `RENDER_EXTERNAL_URL`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Путь к JSON ключа (например `./secrets/serviceAccount.json`) |
| или `FIREBASE_SERVICE_ACCOUNT_JSON` | Вся JSON **одной строкой** (на Render многострочная вставка часто даёт `Bad escaped character in JSON`) |
| или `FIREBASE_SERVICE_ACCOUNT_JSON_B64` | Base64 файла ключа (одна строка): macOS `base64 serviceAccount.json \| tr -d '\n'`; Linux `base64 -w0 serviceAccount.json` — предпочтительно на Render |
| `TELEGRAM_BOT_TOKEN` | от @BotFather |
| `BOT_ADMIN_IDS` | Telegram user id через запятую (доступ к `/adduser`) |
| `ROP_TELEGRAM_IDS` | РОП для уведомлений SLA 30 мин |

**Назначение лидов по бренду:** у менеджера в `ltbUsers` можно задать поле **`brands`** (массив, как в боте: `OMODA`, `Changan`, …). Лид уходит **только** в пул менеджеров с этим брендом; если таких нет — в пул **без** `brands` (универсальные). Если подходящего никого нет — бот ответит «Нет менеджеров». Добавление: `/adduser 1850222787 manager Omirserik Nurgali -- Changan`.

## Firestore rules

Бот ходит в Firestore **только через Admin SDK**; для клиентского веба коллекции `ltb*` должны быть закрыты. Фрагмент для вставки в полный `firestore.rules` веб-проекта: [`docs/firestore-ltb.fragment.rules`](docs/firestore-ltb.fragment.rules).

## VPS / Render

После `npm run build`: `node dist/index.js` под **PM2**, **systemd** или **Render**.

**Render:** для webhook нужен **публичный HTTPS**. У **Web Service** Render задаёт **`RENDER_EXTERNAL_URL`** / **`RENDER_EXTERNAL_HOSTNAME`** и **`PORT`**. У **Background Worker** URL **нет** — бот пойдёт в **long polling** и легко словит **409**, если тот же токен где-то ещё активен.

Что сделать: сервис типа **Web Service** (не Worker); либо вручную **`BOT_WEBHOOK_PUBLIC_URL=https://ваш-сервис.onrender.com`**. Если тип Web, но URL пустой, бот пробует `https://$RENDER_SERVICE_NAME.onrender.com`.

Опционально **`BOT_WEBHOOK_SECRET`** (8+ символов, только `A-Za-z0-9_-`) — проверка заголовка от Telegram.

На Render выставьте **`FIREBASE_PROJECT_ID`** так же, как **`project_id`** в JSON (например `asterauto-d8e74`), чтобы не было предупреждения в логах — на работу Firestore это уже не влияет, ключ главнее.

**Ошибка `SyntaxError: Bad escaped character in JSON` при старте:** значение `FIREBASE_SERVICE_ACCOUNT_JSON` в панели повреждено (лишние кавычки, настоящие переносы строк внутри `private_key` вместо `\n`). Используйте **`FIREBASE_SERVICE_ACCOUNT_JSON_B64`** (одна строка base64 скачанного JSON) или вставьте JSON **в одну строку** без оборачивания всего тела в кавычки.

**Firestore `PERMISSION_DENIED` (код 7):** [Google Cloud Console](https://console.cloud.google.com) → проект из JSON ключа → **IAM** → сервисному аккаунту добавьте **Cloud Datastore User** или **Editor**. В Firebase для проекта должен быть создан **Firestore**.

**Локально** (`npm run dev`): `RENDER_EXTERNAL_URL` нет — используется **long polling**; не запускайте параллельно второй процесс с тем же токеном (Render + локально).

## Отдельный Git-репозиторий

Эту папку можно вынести в свой репозиторий (без монорепы):

```bash
cd asterauto-crm-bot
git init
git add .
git commit -m "Initial commit: Aster Auto CRM Telegram bot"
```

Создайте пустой репозиторий на GitHub/GitLab и:

```bash
git remote add origin <url>
git branch -M main
git push -u origin main
```

Каталог `secrets/` в git не коммитить — там только ключи локально/VPS.
