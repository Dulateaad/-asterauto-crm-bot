import 'dotenv/config';

function parseIds(s: string | undefined): number[] {
  if (!s?.trim()) return [];
  return s
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

export const config = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  adminIds: parseIds(process.env.BOT_ADMIN_IDS),
  ropIds: parseIds(process.env.ROP_TELEGRAM_IDS),
  slaReminderMinutes: Math.max(1, parseInt(process.env.SLA_REMINDER_MINUTES || '15', 10)),
  slaRopMinutes: Math.max(1, parseInt(process.env.SLA_ROP_MINUTES || '30', 10)),
  /** Опрос покупателя после самостоятельной заявки из Telegram (минуты) */
  customerSurveyMinutes: Math.max(1, parseInt(process.env.CUSTOMER_SURVEY_MINUTES || '15', 10)),
  /** Интервал фоновых задач (SLA + опрос покупателя), мс. */
  pollerIntervalMs: Math.max(
    30_000,
    parseInt(process.env.BOT_POLLER_INTERVAL_MS || '120000', 10) || 120_000,
  ),
  /** Временно отключить фоновые опросы БД (true/1) — только ручные действия в боте */
  disableBackgroundPoll:
    process.env.BOT_DISABLE_BACKGROUND_POLL === 'true' || process.env.BOT_DISABLE_BACKGROUND_POLL === '1',
};
