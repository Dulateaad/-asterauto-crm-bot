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
| или `FIREBASE_SERVICE_ACCOUNT_JSON` | Вся JSON-строка (часто на VPS) |
| `TELEGRAM_BOT_TOKEN` | от @BotFather |
| `BOT_ADMIN_IDS` | Telegram user id через запятую (доступ к `/adduser`) |
| `ROP_TELEGRAM_IDS` | РОП для уведомлений SLA 30 мин |

## Firestore rules

Бот ходит в Firestore **только через Admin SDK**; для клиентского веба коллекции `ltb*` должны быть закрыты. Фрагмент для вставки в полный `firestore.rules` веб-проекта: [`docs/firestore-ltb.fragment.rules`](docs/firestore-ltb.fragment.rules).

## VPS / Render

После `npm run build`: `node dist/index.js` под **PM2**, **systemd** или **Render**.

**Render:** автоматически задаются **`RENDER_EXTERNAL_URL`** и **`PORT`**. Бот включает **webhook** (Telegram шлёт обновления POST на ваш сервис) — нет `getUpdates`, поэтому нет типичной ошибки **409** из‑за второго polling.

Опционально **`BOT_WEBHOOK_SECRET`** (8+ символов, только `A-Za-z0-9_-`) — проверка заголовка от Telegram.

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
