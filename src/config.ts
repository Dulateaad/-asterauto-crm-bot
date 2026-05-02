import 'dotenv/config';

function parseIds(s: string | undefined): number[] {
  if (!s?.trim()) return [];
  return s
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

/** projectId из Firebase Console (веб авто-аукциона) */
export const config = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || 'asterauto-d8e74',
  adminIds: parseIds(process.env.BOT_ADMIN_IDS),
  ropIds: parseIds(process.env.ROP_TELEGRAM_IDS),
  slaReminderMinutes: Math.max(1, parseInt(process.env.SLA_REMINDER_MINUTES || '15', 10)),
  slaRopMinutes: Math.max(1, parseInt(process.env.SLA_ROP_MINUTES || '30', 10)),
  pollerIntervalMs: 60_000,
};
