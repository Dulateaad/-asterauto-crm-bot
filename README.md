# asterauto-crm-bot

Telegram CRM-бот для **Aster Auto**: лиды, менеджеры, АТЗ, РОП, SLA. Данные в **Firebase** проекта `asterautoauction`, коллекции с префиксом `ltb*` (не пересекаются с `cars` / `users` веба).

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
| `FIREBASE_PROJECT_ID` | `asterautoauction` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Путь к JSON ключа (например `./secrets/serviceAccount.json`) |
| или `FIREBASE_SERVICE_ACCOUNT_JSON` | Вся JSON-строка (часто на VPS) |
| `TELEGRAM_BOT_TOKEN` | от @BotFather |
| `BOT_ADMIN_IDS` | Telegram user id через запятую (доступ к `/adduser`) |
| `ROP_TELEGRAM_IDS` | РОП для уведомлений SLA 30 мин |

## Firestore rules

Бот ходит в Firestore **только через Admin SDK**; для клиентского веба коллекции `ltb*` должны быть закрыты. Фрагмент для вставки в полный `firestore.rules` веб-проекта: [`docs/firestore-ltb.fragment.rules`](docs/firestore-ltb.fragment.rules).

## VPS

После `npm run build`: `node dist/index.js` под **PM2** или **systemd**. Рабочая директория — корень этого репозитория, `.env` или переменные в панели хостинга.

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
