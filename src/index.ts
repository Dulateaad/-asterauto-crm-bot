import { Markup } from 'telegraf';
import { config } from './config';
import { initDb, databaseUrlHostSummary } from './db';
import { Telegraf, type Context } from 'telegraf';
import {
  getUser,
  isBotAdmin,
  ropTelegramIdsFromEnv,
  setUser,
  listManagersForBrandPick,
  formatTelegramUserLabel,
  formatTelegramShortName,
  listActiveManagersDetailed,
  listManagerTgIdsInDepartment,
  listStaffBroadcastRecipientIds,
  updateUserDepartment,
  normalizeDepartmentId,
  patchUserBrands,
} from './services/ltbUsers';
import {
  createLead,
  getLead,
  listLeadsNeedingSla,
  listLeadsNeedingBuyerSurveyVisit,
  listMyLeads,
  markBuyerSurveyVisitSent,
  markFirstContact,
  patchBuyerSurvey,
  recordTransfer,
  setSlaFlags,
  countToday,
  countLeadsSince,
  countLeadsByBrandSince,
  countLeadsSinceForAssignedPool,
  countLeadsOnLocalCalendarDay,
  countLeadsOnLocalDayForAssignedPool,
  countAllLeads,
  countLeadsAssignedTo,
  slaClockMillis,
  type LeadDoc,
} from './services/ltbLeads';
import { appendBrandsToBuyer, listMarketingRecipientsForBrand, upsertBuyerContact } from './services/ltbBuyerContacts';
import {
  listRecentTransfers,
  listTransfersSince,
  transferReasonLabel,
  transferTargetLabel,
  countTransfersFromPool,
  countTransfersToPool,
  aggregateRecipientCounts,
  countAllTransfers,
  filterTransfersInvolvingPool,
} from './services/ltbTransfers';
import type { Session, TransferReasonId, TransferTargetId, UserRole } from './types';
import { KNOWN_BRANDS, normalizeBrand } from './brands';

import 'dotenv/config';

const BRANDS = KNOWN_BRANDS;

const sessions = new Map<number, Session>();

function sess(uid: number): Session {
  if (!sessions.has(uid)) sessions.set(uid, { key: 'idle', data: {} });
  return sessions.get(uid)!;
}

/** Дата локального календарного дня (как в countToday): daysAgo 0 = сегодня */
function ruLocalDateLabel(daysAgo: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function mainKb(role: string) {
  if (role === 'atz') {
    return Markup.keyboard([
      ['👤 Зарегистрировать клиента', '➕ Добавить клиента'],
      ['🚗 Направить в отдел', '📋 Клиенты за сегодня'],
      ['⚠️ Ожидающие клиенты', '🏠 Главное'],
    ]).resize();
  }
  if (role === 'rop') {
    return Markup.keyboard([
      ['📊 Статистика', '📋 Все лиды'],
      ['⏰ Просроченные', '👥 По менеджерам'],
      ['🔄 Передачи', '⚙️ Настройки'],
      ['🏠 Главное'],
    ]).resize();
  }
  if (role === 'manager' || role === 'admin') {
    if (role === 'admin') {
      return Markup.keyboard([
        ['➕ Добавить клиента', '🔄 Передать клиента'],
        ['📋 Мои лиды', '📊 Моя статистика'],
        ['📤 Передачи (кто кому)', '📊 Сводка'],
        ['📌 Лиды (всего)', '🕓 Напоминания'],
        ['⚙️ Помощь'],
      ]).resize();
    }
    return Markup.keyboard([
      ['➕ Добавить клиента', '🔄 Передать клиента'],
      ['📋 Мои лиды', '📊 Моя статистика'],
      ['🕓 Напоминания', '⚙️ Помощь'],
    ]).resize();
  }
  return Markup.keyboard([['/start']]).resize();
}

function brandKb() {
  return Markup.inlineKeyboard(BRANDS.map((b) => [Markup.button.callback(b, `atz_br:${b}`)]));
}

function atzConfirmKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📤 Назначить по бренду', 'atz_yes:queue')],
    [Markup.button.callback('👤 Выбрать менеджера', 'atz_pick_mgr')],
    [Markup.button.callback('👤 Оставить себе', 'atz_yes:self')],
    [Markup.button.callback('❌ Отмена', 'atz_no')],
  ]);
}

function atzConfirmSummary(s: Session) {
  return (
    `Сводка:\nФИО: ${s.data.fio}\nТел: ${s.data.phone}\nБренд: ${s.data.brand}\n\nКуда отправить лид?`
  );
}

/** Новые лиды без опроса оплаты/бюджета — технические поля для БД */
const DEFAULT_LEAD_PAYMENT = 'cash' as const;

function leadNotifyBody(leadId: string, fio: string, phone: string, brand: string) {
  return `🔔 Новый лид #${leadId}\n` + `ФИО: ${fio}\nТелефон: ${phone}\n` + `Бренд: ${brand}`;
}

function buyConfirmKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📤 Назначить по бренду', 'buy_auto')],
    [Markup.button.callback('👤 Выбрать менеджера', 'buy_pick_mgr')],
    [Markup.button.callback('❌ Отмена', 'buy_no')],
  ]);
}

function buyBrandKb() {
  return Markup.inlineKeyboard(BRANDS.map((b) => [Markup.button.callback(b, `buy_br:${b}`)]));
}

function clientIdleKb() {
  return Markup.keyboard([['🚗 Новая заявка на авто']]).resize();
}

function surveyVisitKb(leadId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('😊 Хорошо', `cs1:${leadId}:good`),
      Markup.button.callback('😐 Нормально', `cs1:${leadId}:ok`),
      Markup.button.callback('☹️ Плохо', `cs1:${leadId}:bad`),
    ],
  ]);
}

function surveyManagerKb(leadId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('👍 Да', `cs2:${leadId}:yes`),
      Markup.button.callback('🤔 Частично', `cs2:${leadId}:partial`),
      Markup.button.callback('👎 Нет', `cs2:${leadId}:no`),
    ],
  ]);
}

function surveyOtherBrandsKb(leadId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Да, интересны', `cs3:${leadId}:yes`),
      Markup.button.callback('❌ Нет', `cs3:${leadId}:no`),
    ],
  ]);
}

function otherBrandsPickKb(leadId: string, selectedIdx: Set<number>) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < BRANDS.length; i += 2) {
    const row: ReturnType<typeof Markup.button.callback>[] = [];
    for (let j = 0; j < 2 && i + j < BRANDS.length; j++) {
      const idx = i + j;
      const b = BRANDS[idx]!;
      const mark = selectedIdx.has(idx) ? '✓ ' : '';
      row.push(Markup.button.callback(`${mark}${b}`, `cs4i:${leadId}:${idx}`));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('✅ Готово', `cs4done:${leadId}`)]);
  return Markup.inlineKeyboard(rows);
}

const REASON: { id: TransferReasonId; label: string }[] = [
  { id: 'high_price', label: '💰 Высокая цена' },
  { id: 'no_stock', label: '🚫 Нет наличия' },
  { id: 'brand_dislike', label: '❌ Не понравился бренд' },
  { id: 'trade_want', label: '🔁 Хочет обмен' },
  { id: 'need_used', label: '🚗 Нужен Б/У' },
];

const TARGET: { id: TransferTargetId; label: string }[] = [
  { id: 'other_brand', label: 'Другой бренд' },
  { id: 'used', label: 'Б/У' },
  { id: 'buyout', label: 'Выкуп' },
  { id: 'finance', label: 'Фин. отдел' },
];

/** Аргументы после /adduser (любой регистр) и @botname; не совпадает с /adduser123 */
function splitAdduserArgs(messageText: string): string[] | null {
  const t = messageText.trim();
  const m = t.match(/^\/adduser(?:@\S+)?(?:$|\s+(.*))$/is);
  if (!m) return null;
  const rest = (m[1] || '').trim();
  if (!rest) return [];
  return rest.split(/\s+/).filter(Boolean);
}

function leadActionsKb(leadId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📞 Связался', `ld_fc:${leadId}`)],
    [Markup.button.callback('✅ Встреча', `ld_mt:${leadId}`), Markup.button.callback('❌ Отказ', `ld_lost:${leadId}`)],
  ]);
}

function parseBrandPickCsv(s: string): Set<number> {
  const set = new Set<number>();
  for (const x of s.split(',').filter(Boolean)) {
    const i = parseInt(x, 10);
    if (!Number.isNaN(i) && i >= 0 && i < BRANDS.length) set.add(i);
  }
  return set;
}

function csvFromBrandPickSet(set: Set<number>): string {
  return Array.from(set)
    .sort((a, b) => a - b)
    .join(',');
}

function brandIndicesFromUserBrands(brands: string[] | undefined): Set<number> {
  const set = new Set<number>();
  if (!brands?.length) return set;
  for (const b of brands) {
    const nb = normalizeBrand(b);
    const idx = BRANDS.findIndex((x) => normalizeBrand(x) === nb);
    if (idx >= 0) set.add(idx);
  }
  return set;
}

function roleRuForPrompt(role: UserRole): string {
  switch (role) {
    case 'manager':
      return 'Менеджер';
    case 'rop':
      return 'РОП';
    case 'atz':
      return 'АТЗ (админ зала)';
    case 'admin':
      return 'Админ';
    default:
      return role;
  }
}

function adminManagerBrandPrompt(tg: number, name: string, selected: Set<number>, role: UserRole): string {
  const sel =
    selected.size === 0
      ? '—'
      : Array.from(selected)
          .sort((a, b) => a - b)
          .map((i) => BRANDS[i]!)
          .join(', ');
  const queueHint =
    role === 'manager'
      ? 'У manager эти бренды участвуют в очереди назначения лидов.'
      : 'У РОП / АТЗ (админ зала) / админа бренды в профиле; в очередь лидов по-прежнему попадают только manager.';
  return (
    `${roleRuForPrompt(role)}: ${name} (${tg})\n\n` +
    `Выберите бренды (можно несколько), затем «Готово».\n` +
    `«Все бренды» — без списка брендов в профиле.\n` +
    `${queueHint}\n\n` +
    `Сейчас выбрано: ${sel}`
  );
}

function sessionPendingUserRole(s: Session): UserRole {
  const r = s.data.pendingRole as string | undefined;
  if (r === 'manager' || r === 'rop' || r === 'atz' || r === 'admin') return r;
  return 'manager';
}

function wantsBrandWizard(role: UserRole | null): boolean {
  return role === 'manager' || role === 'rop' || role === 'atz' || role === 'admin';
}

function adminManagerBrandKb(selected: Set<number>) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < BRANDS.length; i += 3) {
    const chunk: ReturnType<typeof Markup.button.callback>[] = [];
    for (let j = 0; j < 3 && i + j < BRANDS.length; j++) {
      const idx = i + j;
      const b = BRANDS[idx]!;
      const mark = selected.has(idx) ? '✓ ' : '';
      chunk.push(Markup.button.callback(`${mark}${b}`, `adm_b:t:${idx}`));
    }
    rows.push(chunk);
  }
  rows.push([Markup.button.callback('✅ Готово', 'adm_b:done')]);
  rows.push([Markup.button.callback('🌐 Все бренды (универсальный)', 'adm_b:all')]);
  return Markup.inlineKeyboard(rows);
}

async function sendClientEntry(ctx: Context, _uid: number) {
  const intro =
    'Здравствуйте! Оставьте заявку — менеджер выбранного бренда свяжется с вами.\n\n' +
    'Нажимая «Согласен», вы разрешаете обработку контактов и получение в Telegram информационных сообщений (акции, снижение цен) по выбранным маркам.';
  await ctx.reply(intro + '\n\nДля продолжения нажмите кнопку ниже.', {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('✅ Согласен — заполнить заявку', 'buy_consent:yes')],
    ]).reply_markup,
  });
}

async function runCustomerSurveyBot(bot: Telegraf) {
  const ms = config.customerSurveyMinutes * 60 * 1000;
  const rows = await listLeadsNeedingBuyerSurveyVisit(ms);
  for (const L of rows) {
    const chat = L.buyerTelegramId;
    if (chat == null || !Number.isFinite(chat)) continue;
    try {
      const kb = surveyVisitKb(L.id);
      await bot.telegram.sendMessage(
        chat,
        `⏱ Прошло около ${config.customerSurveyMinutes} минут с момента заявки.\n` +
          `Как прошло общение? (бренд: ${L.brand})\n\n` +
          `Оцените первый контакт / консультацию.`,
        { reply_markup: kb.reply_markup },
      );
      await markBuyerSurveyVisitSent(L.id);
    } catch {
      /* пользователь заблокировал бота и т.п. */
    }
  }
}

async function sendMain(ctx: Context, uid: number) {
  try {
    let u = await getUser(uid);
    // Первый вход: ID в BOT_ADMIN_IDS, но ещё нет строки в ltb_users — создаём admin
    if (!u && (await isBotAdmin(uid))) {
      const label =
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
        ctx.from?.username ||
        'Admin';
      await setUser(uid, label, 'admin');
      u = await getUser(uid);
    }
    if (!u) {
      await sendClientEntry(ctx, uid);
      return;
    }
    if (u.role === 'none' || !u.active) {
      await ctx.reply('Учетная запись не активна.');
      return;
    }
    const label =
      u.role === 'atz'
        ? 'АТЗ (админ зала)'
        : u.role === 'rop'
          ? 'РОП'
          : u.role === 'admin'
            ? 'Админ / менеджер'
            : 'Менеджер';
    const mk = mainKb(u.role);
    await ctx.reply(`🏠 Главное меню (${label})`, { reply_markup: mk.reply_markup });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('sendMain / DB:', e);
    const pg = e as { code?: string; message?: string };
    const hint =
      pg.code === 'ECONNREFUSED' || pg.code === 'ENOTFOUND'
        ? 'Не удаётся подключиться к PostgreSQL. Проверьте DATABASE_URL, что Postgres запущен на VPS и порт открыт локально / с Render.'
        : pg.code === '28P01' || pg.code === '28000'
          ? 'Ошибка авторизации к PostgreSQL (логин/пароль в DATABASE_URL).'
          : 'Проверьте DATABASE_URL и что выполнен миграционный скрипт: npm run db:migrate';
    await ctx.reply('Не удалось связаться с базой.\n' + hint);
  }
}

async function sendAdminTransfersReport(ctx: Context, uid: number) {
  if (!(await isBotAdmin(uid))) {
    await ctx.reply('Нет прав.');
    return;
  }
  const rows = await listRecentTransfers(40);
  if (rows.length === 0) {
    await ctx.reply('Пока нет записей о передачах.');
    return;
  }
  const parts: string[] = [`📤 Передачи лидов (последние ${rows.length}):`, ''];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]!;
    const [fromL, toL, leadSnap] = await Promise.all([
      formatTelegramShortName(t.fromTelegramId),
      formatTelegramShortName(t.toTelegramId),
      getLead(t.leadId),
    ]);
    const who = leadSnap?.fio?.trim() || `лид #${t.leadId}`;
    parts.push(
      `${i + 1}. ${who}\n` +
        `   От: ${fromL}\n` +
        `   Кому: ${toL}\n` +
        `   ${transferReasonLabel(t.reason)} → ${transferTargetLabel(t.target)}`,
    );
    if (t.comment.trim()) {
      const c = t.comment.trim();
      parts.push(`   💬 ${c.length > 140 ? `${c.slice(0, 140)}…` : c}`);
    }
    parts.push('');
  }
  const full = parts.join('\n').trim();
  const max = 4000;
  if (full.length <= max) {
    await ctx.reply(full);
    return;
  }
  await ctx.reply(full.slice(0, max) + '\n… (сообщение обрезано из‑за лимита Telegram; повторите /transfers)');
}

async function sendAdminStatsSummary(ctx: Context, uid: number) {
  if (!(await isBotAdmin(uid))) {
    await ctx.reply('Нет прав.');
    return;
  }
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [mapToday, mapWeek, ydayTotal, y2Total, transfers, managers] = await Promise.all([
    countLeadsByBrandSince(todayStart),
    countLeadsByBrandSince(weekStart),
    countLeadsOnLocalCalendarDay(1),
    countLeadsOnLocalCalendarDay(2),
    listTransfersSince(weekStart, 400),
    listActiveManagersDetailed(),
  ]);

  const sortBrandLines = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([b, n]) => `  • ${b}: ${n}`)
      .join('\n') || '  (нет в выборке)';

  const fromCount = new Map<number, number>();
  for (const t of transfers) {
    fromCount.set(t.fromTelegramId, (fromCount.get(t.fromTelegramId) || 0) + 1);
  }
  const fromSorted = [...fromCount.entries()].sort((a, b) => b[1] - a[1]);
  const maxTransferNames = 25;
  const transferLines = await Promise.all(
    fromSorted.slice(0, maxTransferNames).map(async ([tid, cnt]) => {
      const label = await formatTelegramShortName(tid);
      return `  • ${label}: ${cnt}`;
    }),
  );
  const transferBlock = [
    transferLines.join('\n'),
    fromSorted.length > maxTransferNames ? `  … ещё отправителей: ${fromSorted.length - maxTransferNames}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const noTransfer: string[] = [];
  for (const mgr of managers) {
    const tid = parseInt(mgr.id, 10);
    if (!Number.isFinite(tid) || fromCount.has(tid)) continue;
    const name = mgr.name?.trim() || 'Без имени';
    noTransfer.push(`  • ${name} (${tid})`);
  }
  noTransfer.sort();

  const parts: string[] = [
    '📊 Сводка: бренды и передачи',
    '',
    '📅 Всего новых лидов (по дате создания, время сервера):',
    `  • Вчера (${ruLocalDateLabel(1)}): ${ydayTotal}`,
    `  • Позавчера (${ruLocalDateLabel(2)}): ${y2Total}`,
    '',
    'Сегодня (с полуночи, по брендам):',
    sortBrandLines(mapToday),
    '',
    'За 7 дней (агрегация по бренду):',
    sortBrandLines(mapWeek),
    '',
    `📤 Исходящие передачи за 7 дней: всего ${transfers.length}`,
    'Кто передавал:',
    transferBlock || '  (нет передач)',
    '',
    '⚠️ Активные менеджеры без исходящих передач за период:',
    noTransfer.length > 0 ? noTransfer.join('\n') : '  (нет таких или нет активных менеджеров)',
  ];

  const full = parts.join('\n').trim();
  const max = 4000;
  if (full.length <= max) {
    await ctx.reply(full);
    return;
  }
  await ctx.reply(full.slice(0, max));
  await ctx.reply(full.slice(max));
}

/** РОП + departmentId + менеджеры отдела; иначе null (уже ответили в чат). */
async function getRopDepartmentContext(
  ctx: Context,
  uid: number,
): Promise<{ dept: string; pool: Set<number>; mgrIds: number[] } | null> {
  const u = await getUser(uid);
  if (!u || u.role !== 'rop') {
    await ctx.reply('Раздел только для РОП.');
    return null;
  }
  const rawDept = u.departmentId?.trim();
  if (!rawDept) {
    await ctx.reply(
      'У вашей учётной записи не задан отдел.\n' +
        `Попросите админа: /setdept ${uid} <ключ_отдела>\n` +
        'и тем же ключом привязать менеджеров.',
    );
    return null;
  }
  const dept = normalizeDepartmentId(rawDept);
  const mgrIds = await listManagerTgIdsInDepartment(dept);
  if (mgrIds.length === 0) {
    await ctx.reply(
      `Отдел «${dept}»: нет менеджеров с таким departmentId. Админ: /setdept <tg_менеджера> ${dept}`,
    );
    return null;
  }
  return { dept, pool: new Set(mgrIds), mgrIds };
}

async function sendRopDepartmentTransfers(ctx: Context, uid: number) {
  const ctxDept = await getRopDepartmentContext(ctx, uid);
  if (!ctxDept) return;
  const { pool } = ctxDept;
  const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const all = await listTransfersSince(weekStart, 600);
  const rows = filterTransfersInvolvingPool(all, pool).slice(0, 35);
  if (rows.length === 0) {
    await ctx.reply('За 7 дней нет передач с участием менеджеров вашего отдела (в выборке).');
    return;
  }
  const parts: string[] = [
    `📤 Передачи отдела (последние ${rows.length} за 7 дн., где участвует ваш отдел):`,
    '',
  ];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]!;
    const [fromL, toL, leadSnap] = await Promise.all([
      formatTelegramShortName(t.fromTelegramId),
      formatTelegramShortName(t.toTelegramId),
      getLead(t.leadId),
    ]);
    const who = leadSnap?.fio?.trim() || `лид #${t.leadId}`;
    parts.push(
      `${i + 1}. ${who}\n` +
        `   От: ${fromL}\n` +
        `   Кому: ${toL}\n` +
        `   ${transferReasonLabel(t.reason)} → ${transferTargetLabel(t.target)}`,
    );
    if (t.comment.trim()) {
      const c = t.comment.trim();
      parts.push(`   💬 ${c.length > 120 ? `${c.slice(0, 120)}…` : c}`);
    }
    parts.push('');
  }
  const full = parts.join('\n').trim();
  const max = 4000;
  if (full.length <= max) {
    await ctx.reply(full);
    return;
  }
  await ctx.reply(full.slice(0, max) + '\n…');
}

async function sendRopManagersBoard(ctx: Context, uid: number) {
  const ctxDept = await getRopDepartmentContext(ctx, uid);
  if (!ctxDept) return;
  const { dept, mgrIds, pool } = ctxDept;
  const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const xferWeek = await listTransfersSince(weekStart, 600);
  const outM = new Map<number, number>();
  const inM = new Map<number, number>();
  for (const t of xferWeek) {
    if (pool.has(t.fromTelegramId)) {
      outM.set(t.fromTelegramId, (outM.get(t.fromTelegramId) || 0) + 1);
    }
    if (pool.has(t.toTelegramId)) {
      inM.set(t.toTelegramId, (inM.get(t.toTelegramId) || 0) + 1);
    }
  }
  const assigned = await Promise.all(mgrIds.map((id) => countLeadsAssignedTo(id)));
  const names = await Promise.all(mgrIds.map((id) => formatTelegramShortName(id)));
  const lines = [
    `👥 Отдел «${dept}» — по менеджерам`,
    '',
    'За 7 дней (передачи, где участвует менеджер отдела):',
    '«В работе» — сколько лидов сейчас назначено на менеджера.',
    '',
  ];
  for (let i = 0; i < mgrIds.length; i++) {
    const id = mgrIds[i]!;
    lines.push(
      `  • ${names[i]}:\n` +
        `    отдал: ${outM.get(id) || 0}  |  принял: ${inM.get(id) || 0}  |  в работе: ${assigned[i]}`,
    );
  }
  await ctx.reply(lines.join('\n'));
}

async function sendRopDepartmentStats(ctx: Context, uid: number) {
  const ctxDept = await getRopDepartmentContext(ctx, uid);
  if (!ctxDept) return;
  const { dept, pool, mgrIds } = ctxDept;
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [leadsToday, leadsYday, leadsY2, leadsWeek, xferWeek] = await Promise.all([
    countLeadsSinceForAssignedPool(pool, todayStart, 600),
    countLeadsOnLocalDayForAssignedPool(pool, 1, 800),
    countLeadsOnLocalDayForAssignedPool(pool, 2, 800),
    countLeadsSinceForAssignedPool(pool, weekStart, 600),
    listTransfersSince(weekStart, 600),
  ]);
  const xferToday = xferWeek.filter((t) => t.createdAt.getTime() >= todayMs);
  const outToday = countTransfersFromPool(xferToday, pool);
  const inToday = countTransfersToPool(xferToday, pool);
  const outWeek = countTransfersFromPool(xferWeek, pool);
  const inWeek = countTransfersToPool(xferWeek, pool);

  const outM = new Map<number, number>();
  const inM = new Map<number, number>();
  for (const t of xferWeek) {
    if (pool.has(t.fromTelegramId)) {
      outM.set(t.fromTelegramId, (outM.get(t.fromTelegramId) || 0) + 1);
    }
    if (pool.has(t.toTelegramId)) {
      inM.set(t.toTelegramId, (inM.get(t.toTelegramId) || 0) + 1);
    }
  }
  const assigned = await Promise.all(mgrIds.map((id) => countLeadsAssignedTo(id)));
  const names = await Promise.all(mgrIds.map((id) => formatTelegramShortName(id)));

  const lines = [
    `📊 Отдел: ${dept}`,
    `Менеджеров в отделе: ${mgrIds.length}`,
    '',
    'Новые лиды на команду по дням (назначение на менеджеров отдела):',
    `  • Сегодня: ${leadsToday}`,
    `  • Вчера (${ruLocalDateLabel(1)}): ${leadsYday}`,
    `  • Позавчера (${ruLocalDateLabel(2)}): ${leadsY2}`,
    `  • Передач из отдела: ${outToday}`,
    `  • Передач в отдел: ${inToday}`,
    '',
    'За 7 дней:',
    `  • Новых лидов на команду: ${leadsWeek}`,
    `  • Передач из отдела: ${outWeek}`,
    `  • Передач в отдел: ${inWeek}`,
    '',
    '👥 По менеджерам (7 дн. передачи; «в работе» — лиды на менеджере сейчас):',
  ];
  for (let i = 0; i < mgrIds.length; i++) {
    const id = mgrIds[i]!;
    lines.push(
      `  • ${names[i]}: отдал ${outM.get(id) || 0}, принял ${inM.get(id) || 0}, в работе ${assigned[i]}`,
    );
  }
  lines.push(
    '',
    'Пояснение: передачи — журнал за 7 дней (до 600 записей в выборке). Подробный список: кнопка «🔄 Передачи».',
  );
  await ctx.reply(lines.join('\n'));
}

/** Менеджер / админ: личные цифры + общие по базе и передачи с именами. */
async function sendStaffStatsBoard(ctx: Context, viewerUid: number) {
  const u = await getUser(viewerUid);
  if (!u || !u.active || (u.role !== 'manager' && u.role !== 'admin')) {
    await ctx.reply('Кнопка доступна менеджерам и админу.');
    return;
  }
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [mine, todayAll, leadsYday, leadsY2, totalLeads, totalTransfers, weekTransfers] = await Promise.all([
    listMyLeads(viewerUid).then((rows) => rows.length),
    countToday(),
    countLeadsOnLocalCalendarDay(1),
    countLeadsOnLocalCalendarDay(2),
    countAllLeads(),
    countAllTransfers(),
    listTransfersSince(weekStart, 500),
  ]);

  const xferToday = weekTransfers.filter((t) => t.createdAt.getTime() >= todayMs);
  const fromCounts = new Map<number, number>();
  const toCounts = new Map<number, number>();
  for (const t of weekTransfers) {
    fromCounts.set(t.fromTelegramId, (fromCounts.get(t.fromTelegramId) || 0) + 1);
    toCounts.set(t.toTelegramId, (toCounts.get(t.toTelegramId) || 0) + 1);
  }
  const topFrom = [...fromCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topTo = [...toCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  const linesFrom = await Promise.all(
    topFrom.map(async ([id, c]) => `  • ${await formatTelegramShortName(id)}: ${c}`),
  );
  const linesTo = await Promise.all(
    topTo.map(async ([id, c]) => `  • ${await formatTelegramShortName(id)}: ${c}`),
  );

  const parts = [
    '📊 Моя статистика + общая',
    '',
    '👤 Личное:',
    `  • У вас в работе (в списке «Мои лиды»): ${mine}`,
    '',
    '🌐 Общее по базе (все лиды и передачи, с начала учёта):',
    '📅 Новые лиды по календарным дням (дата создания, время сервера бота):',
    `  • Сегодня: ${todayAll}`,
    `  • Вчера (${ruLocalDateLabel(1)}): ${leadsYday}`,
    `  • Позавчера (${ruLocalDateLabel(2)}): ${leadsY2}`,
    `  • Лидов всего: ${totalLeads}`,
    `  • Передач всего: ${totalTransfers}`,
    '',
    'За 7 дней (по журналу, до 500 последних записей):',
    `  • Передач в выборке: ${weekTransfers.length}`,
    `  • Передач сегодня (из этой выборки): ${xferToday.length}`,
    '',
    'Кто чаще передавал (7 дн., топ по имени):',
    linesFrom.length ? linesFrom.join('\n') : '  —',
    '',
    'Кому чаще передавали (7 дн., топ по имени):',
    linesTo.length ? linesTo.join('\n') : '  —',
    '',
    'Это не «с сегодняшнего дня»: берутся реальные данные из PostgreSQL.',
  ];

  const full = parts.join('\n');
  const max = 4000;
  if (full.length <= max) {
    await ctx.reply(full);
    return;
  }
  await ctx.reply(full.slice(0, max));
  await ctx.reply(full.slice(max));
}

async function sendAdminLeadsDigest(ctx: Context, uid: number) {
  if (!(await isBotAdmin(uid))) {
    await ctx.reply('Нет прав.');
    return;
  }
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [todayCount, ydayCount, y2Count, total, weekTransfers, recMap] = await Promise.all([
    countLeadsSince(todayStart),
    countLeadsOnLocalCalendarDay(1),
    countLeadsOnLocalCalendarDay(2),
    countAllLeads(),
    listTransfersSince(weekStart, 500),
    aggregateRecipientCounts(400),
  ]);
  const topRecv = [...recMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topLines = await Promise.all(
    topRecv.map(async ([tgId, cnt]) => {
      const nm = await formatTelegramShortName(tgId);
      return `  • ${nm}: ${cnt} раз (в последних передачах)`;
    }),
  );
  const parts = [
    '📌 Сводка лидов (админ)',
    '',
    '📅 Лиды по дням (создание, время сервера):',
    `  • Сегодня: ${todayCount}`,
    `  • Вчера (${ruLocalDateLabel(1)}): ${ydayCount}`,
    `  • Позавчера (${ruLocalDateLabel(2)}): ${y2Count}`,
    `  • Всего в базе: ${total}`,
    '',
    `Передач за 7 дней (в выборке): ${weekTransfers.length}`,
    'Кому чаще всего передавали (по последним записям в журнале):',
    topLines.length ? topLines.join('\n') : '  —',
    '',
    'Фильтр по месяцам — в следующих версиях.',
  ];
  let full = parts.join('\n');
  const max = 4000;
  if (full.length > max) full = full.slice(0, max) + '…';
  await ctx.reply(full);
}

async function runSlaBot(bot: Telegraf) {
  const rows = await listLeadsNeedingSla();
  const now = Date.now();
  const t15 = config.slaReminderMinutes * 60 * 1000;
  const t30 = config.slaRopMinutes * 60 * 1000;
  for (const L of rows) {
    const created = slaClockMillis(L as LeadDoc & { id: string });
    const age = now - created;
    if (age >= t15 && !(L as { sla15Sent?: boolean }).sla15Sent) {
      try {
        await bot.telegram.sendMessage(
          (L as { assignedTo: number }).assignedTo,
          `⏰ Напоминание: обработайте клиента\nЛид: ${(L as { fio: string }).fio}\n/lead_${L.id}`,
        );
        await setSlaFlags(L.id, true, false);
      } catch { /* */ }
    }
    if (age >= t30 && !(L as { sla30Sent?: boolean }).sla30Sent) {
      const rop = ropTelegramIdsFromEnv();
      const mgrLabel = await formatTelegramUserLabel((L as { assignedTo: number }).assignedTo);
      for (const rid of rop) {
        try {
          await bot.telegram.sendMessage(
            rid,
            `⚠️ Просроченный лид\nОтветственный: ${mgrLabel}\nКлиент: ${(L as { fio: string }).fio}\nОжидание: ${Math.round(age / 60000)} мин\n#${L.id}`,
          );
        } catch { /* */ }
      }
      await setSlaFlags(L.id, (L as { sla15Sent?: boolean }).sla15Sent || false, true);
    }
  }
}

function parseRole(s: string): UserRole | null {
  const m = s.toLowerCase().trim().replace(/\s+/g, ' ');
  if (m === 'manager' || m === 'менеджер') return 'manager';
  /** АТЗ — администратор торгового зала (приём, запись клиента) */
  if (m === 'atz' || m === 'атз') return 'atz';
  if (
    m === 'админ зала' ||
    m === 'админзала' ||
    m === 'администратор зала' ||
    m === 'администратор торгового зала' ||
    m === 'admin zala' ||
    m === 'hall' ||
    m === 'reception'
  ) {
    return 'atz';
  }
  if (m === 'rop' || m === 'роп') return 'rop';
  if (m === 'admin' || m === 'админ') return 'admin';
  return null;
}

/** parts[0] = telegram id, далее роль (одно или два слова, напр. «админ зала»), затем ФИО и опционально -- бренды */
function parseAdduserLine(parts: string[]): { tg: number; role: UserRole | null; tail: string[] } | null {
  if (parts.length < 3) return null;
  const tg = parseInt(parts[0]!, 10);
  if (Number.isNaN(tg)) return null;
  const afterId = parts.slice(1);
  const r1 = parseRole(afterId[0]!);
  if (r1) return { tg, role: r1, tail: afterId.slice(1) };
  if (afterId.length >= 3) {
    const r2 = parseRole(`${afterId[0]} ${afterId[1]}`);
    if (r2) return { tg, role: r2, tail: afterId.slice(2) };
  }
  return { tg, role: null, tail: afterId.slice(1) };
}

/** Публичный HTTPS для webhook. У Background Worker на Render нет URL — только Web Service или BOT_WEBHOOK_PUBLIC_URL. */
function resolveWebhookPublicBase(): string | undefined {
  const manual = process.env.BOT_WEBHOOK_PUBLIC_URL?.replace(/\/$/, '').trim();
  if (manual) return manual;

  const ext = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, '').trim();
  if (ext) return ext;

  const host = process.env.RENDER_EXTERNAL_HOSTNAME?.trim();
  if (host) return `https://${host}`;

  const svcType = process.env.RENDER_SERVICE_TYPE?.trim();
  // У web / private service иногда только имя; URL вида https://<name>.onrender.com
  if (process.env.RENDER === 'true' && (svcType === 'web' || svcType === 'pserv')) {
    const name = process.env.RENDER_SERVICE_NAME?.trim();
    if (name) return `https://${name}.onrender.com`;
  }

  return undefined;
}

async function main() {
  initDb();
  if (!config.token) {
    throw new Error('TELEGRAM_BOT_TOKEN обязателен');
  }
  const bot = new Telegraf(config.token);

  bot.catch((err, ctx) => {
    // eslint-disable-next-line no-console
    console.error('telegraf', err);
    void ctx?.reply?.('Ошибка бота. Проверьте логи на сервере и нажмите /start снова.');
  });

  bot.start(async (ctx) => {
    try {
      const uid = ctx.from?.id;
      if (!uid) return;
      await sendMain(ctx, uid);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('/start handler:', e);
      try {
        await ctx.reply('Ошибка при обработке /start. Смотрите логи на сервере (Render → Logs).');
      } catch { /* */ }
    }
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'Покупатель: /start — заявка на авто, бренд и контакты; позже — короткий опрос и рассылки по согласию.\n\n' +
        'РОП:\n«📊 Статистика» — сводка по отделу + по менеджерам (нужен /setdept).\n' +
        '«🔄 Передачи» — кто кому передал лидов в отделе (7 дн.).\n' +
        '«👥 По менеджерам» — отдал / принял / в работе по каждому.\n' +
        '/rop_transfers — то же, что кнопка передач.\n\n' +
        'Админ:\n/addadmin <id> <ФИО> — назначить админа (роль в базе)\n' +
        '/adduser <id> <роль> <ФИО> — бренды кнопками (manager, rop, atz, admin, админ зала)\n' +
        '/adduser <id> <роль> <имя> -- Changan — бренды текстом\n' +
        '/notify_brand OMODA Текст — рассылка подписчикам бренда (только из бота)\n' +
        '/transfers — кто передал лид и кому (только админ)\n' +
        '/stats — лиды по брендам (сегодня / 7 дней) и передачи за 7 дней (только админ)\n' +
        '/admin_digest — лиды сегодня / всего + кому чаще передавали (только админ)\n' +
        '/broadcast Текст — сообщение всем manager, РОП и АТЗ (только админ)\n' +
        '/setdept <telegram_id> <отдел> — привязка РОП и менеджеров к отделу (slug, напр. changan)\n' +
        '/editmgr <telegram_id> — сменить бренды у существующего менеджера (кнопками)\n' +
        'Кнопки «📤 Передачи», «📊 Сводка», «📌 Лиды (всего)» в меню админа\n' +
        '/lead_<id> — в разработке',
    ),
  );

  bot.command('transfers', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    await sendAdminTransfersReport(ctx, uid);
  });

  bot.command('rop_transfers', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const u = await getUser(uid);
    if (!u || u.role !== 'rop') {
      return ctx.reply('Команда только для РОП.');
    }
    await sendRopDepartmentTransfers(ctx, uid);
  });

  bot.command('admin_digest', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    await sendAdminLeadsDigest(ctx, uid);
  });

  const handleBroadcast = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!uid || !(await isBotAdmin(uid))) {
      return ctx.reply('Нет прав.');
    }
    const raw = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') || '';
    const m = raw.trim().match(/^\/broadcast(?:@\S+)?\s+([\s\S]+)$/is);
    const body = m?.[1]?.trim();
    if (!body) {
      return ctx.reply('Формат: /broadcast Текст сообщения для manager, РОП и АТЗ.');
    }
    const ids = await listStaffBroadcastRecipientIds();
    let ok = 0;
    for (const tid of ids) {
      if (tid === uid) continue;
      try {
        await ctx.telegram.sendMessage(tid, `📣 Сообщение от администрации:\n\n${body}`);
        ok++;
      } catch {
        /* */
      }
    }
    return ctx.reply(`Готово: доставлено ${ok} из ${ids.length} (вы себе не дублируем).`);
  };
  bot.hears(/^\/broadcast(?:@\S+)?(?:\s+(.+))?$/is, handleBroadcast);
  bot.command('broadcast', handleBroadcast);

  const handleSetdept = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!uid || !(await isBotAdmin(uid))) {
      return ctx.reply('Нет прав.');
    }
    const raw = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') || '';
    const m = raw.trim().match(/^\/setdept(?:@\S+)?\s+(\d+)\s+(\S+)/i);
    if (!m) {
      return ctx.reply('Формат: /setdept 123456789 changan\nСнять отдел: /setdept 123456789 -');
    }
    const tg = parseInt(m[1]!, 10);
    const token = m[2]!;
    if (Number.isNaN(tg)) return ctx.reply('Неверный telegram id.');
    const target = await getUser(tg);
    if (!target) return ctx.reply('Пользователь не в базе. Сначала /adduser.');
    try {
      if (token === '-' || token.toLowerCase() === 'none') {
        await updateUserDepartment(tg, null);
        return ctx.reply(`Ок. У ${tg} отдел снят.`);
      }
      await updateUserDepartment(tg, token);
      return ctx.reply(`Ок. Пользователь ${tg} (${target.role}) → отдел «${normalizeDepartmentId(token)}».`);
    } catch {
      return ctx.reply('Не удалось сохранить. Проверьте подключение к PostgreSQL.');
    }
  };
  bot.hears(/^\/setdept(?:@\S+)?(?:\s+(.+))?$/is, handleSetdept);
  bot.command('setdept', handleSetdept);

  bot.command('stats', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    await sendAdminStatsSummary(ctx, uid);
  });

  const handleNotifyBrand = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!uid || !(await isBotAdmin(uid))) {
      return ctx.reply('Нет прав.');
    }
    const raw = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') || '';
    const m = raw.trim().match(/^\/notify_brand(?:@\S+)?\s+(\S+)\s+([\s\S]+)$/i);
    if (!m) {
      return ctx.reply('Формат: /notify_brand OMODA Текст сообщения для клиентов');
    }
    const brand = m[1]!;
    const body = m[2]!.trim();
    if (!body) return ctx.reply('Добавьте текст после названия бренда.');
    const ids = await listMarketingRecipientsForBrand(brand);
    if (ids.length === 0) {
      return ctx.reply(`Нет подписчиков с opt-in и брендом «${brand}» (или лимит выборки).`);
    }
    let ok = 0;
    for (const tid of ids) {
      try {
        await ctx.telegram.sendMessage(tid, `📢 ${brand}\n\n${body}`);
        ok++;
      } catch {
        /* */
      }
    }
    return ctx.reply(`Готово: доставлено ${ok} из ${ids.length}.`);
  };

  bot.hears(/^\/notify_brand(?:@\S+)?(?:\s+(.+))?$/is, handleNotifyBrand);
  bot.command('notify_brand', handleNotifyBrand);

  const handleAdduser = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!uid || !(await isBotAdmin(uid))) {
      return ctx.reply('Нет прав.');
    }
    const raw = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') || '';
    const parts = splitAdduserArgs(raw);
    const parsed = parts ? parseAdduserLine(parts) : null;
    if (!parts || !parsed) {
      return ctx.reply(
        'Формат: /adduser 123456789 rop Иван Фамилия\n' +
          'или /adduser 123456789 админ зала Иван Фамилия\n' +
          '→ откроется выбор брендов (manager, rop, atz, admin).\n' +
          'Роль atz можно указать как: atz | атз | админ зала\n' +
          'Или сразу текстом: /adduser 123 rop Иван -- Changan OMODA\n' +
          `Бренды: ${KNOWN_BRANDS.join(', ')}`,
      );
    }
    const { tg, role, tail } = parsed;
    if (!role) {
      return ctx.reply(
        'Неверная роль. Допустимо: manager | менеджер | rop | роп | atz | атз | admin | админ | админ зала',
      );
    }
    const dashIdx = tail.findIndex((p, i) => i >= 1 && p === '--');
    let name: string;
    let brands: string[] | undefined;
    if (dashIdx >= 1) {
      name = tail.slice(0, dashIdx).join(' ').trim();
      const after = tail.slice(dashIdx + 1).filter(Boolean);
      brands = after.length > 0 ? after : undefined;
    } else {
      name = tail.join(' ').trim();
      brands = undefined;
    }
    if (Number.isNaN(tg)) return ctx.reply('Неверные данные');
    if (!name) {
      return ctx.reply('Укажите ФИО после роли. Пример: /adduser 123 atz Иван Иванов');
    }

    const useBrandWizard = wantsBrandWizard(role) && (!brands || brands.length === 0);
    if (useBrandWizard) {
      if (!name) {
        return ctx.reply('Укажите имя: /adduser <telegram_id> <роль> <ФИО>');
      }
      const s = sess(uid);
      s.key = 'admin_mgr_brands';
      s.data.pendingMgrTg = tg;
      s.data.pendingMgrName = name;
      s.data.pendingRole = role;
      s.data.adminBrandPick = '';
      s.data.editBrandsOnly = false;
      const selected = new Set<number>();
      // eslint-disable-next-line no-console
      console.log('[adduser] brand wizard', { tg, name, role, uid });
      await ctx.reply(
        adminManagerBrandPrompt(tg, name, selected, role) +
          '\n\n⚠️ Пользователь попадёт в базу только после «Готово» или «Все бренды».',
        {
          reply_markup: adminManagerBrandKb(selected).reply_markup,
        },
      );
      return;
    }

    await setUser(tg, name, role, brands);
    const bNote = brands?.length ? `\nБренды в профиле: ${brands.join(', ')}` : '';
    const hint = brands?.length
      ? '\n\nПодсказка: чтобы в следующий раз выбрать бренды кнопками, не добавляйте в конце «-- …».'
      : '';
    await ctx.reply(`Ок. Пользователь ${tg} — ${role}, ${name}${bNote}${hint}`);
  };

  /** Флаг `s`: перенос строки между id и ролью — одно сообщение в Telegram */
  bot.hears(/^\/adduser(?:@\S+)?(?:$|\s+(.*))$/is, handleAdduser);
  bot.command('adduser', handleAdduser);

  const handleAddadmin = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!uid || !(await isBotAdmin(uid))) {
      return ctx.reply('Нет прав.');
    }
    const raw = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') || '';
    const m = raw.trim().match(/^\/addadmin(?:@\S+)?\s+(\d+)\s+(.+)$/is);
    if (!m) {
      return ctx.reply(
        'Формат: /addadmin 123456789 Иван Иванов\n' +
          'Назначает роль admin: полное меню и все админ-команды. Пользователь может ещё не быть в базе — запись создаётся.',
      );
    }
    const tg = parseInt(m[1]!, 10);
    const name = m[2]!.trim();
    if (Number.isNaN(tg) || !name) {
      return ctx.reply('Проверьте числовой telegram id и ФИО после него.');
    }
    await setUser(tg, name, 'admin');
    return ctx.reply(
      `Ок. Пользователь ${tg} — admin, ${name}.\nПусть откроет бота и нажмёт /start.`,
    );
  };
  bot.hears(/^\/addadmin(?:@\S+)?(?:\s+(.+))?$/is, handleAddadmin);
  bot.command('addadmin', handleAddadmin);

  const handleEditmgr = async (ctx: Context) => {
    const uid = ctx.from?.id;
    if (!uid || !(await isBotAdmin(uid))) {
      return ctx.reply('Нет прав.');
    }
    const raw = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') || '';
    const m = raw.trim().match(/^\/editmgr(?:@\S+)?\s+(\d+)\s*$/i);
    if (!m) {
      return ctx.reply('Формат: /editmgr 123456789\nОткроется выбор брендов для существующего менеджера.');
    }
    const tg = parseInt(m[1]!, 10);
    if (Number.isNaN(tg)) return ctx.reply('Неверный id.');
    const target = await getUser(tg);
    if (!target || target.role !== 'manager') {
      return ctx.reply('Нужен пользователь с ролью manager. Сначала /adduser … manager …');
    }
    const s = sess(uid);
    s.key = 'admin_mgr_brands';
    s.data.pendingMgrTg = tg;
    s.data.pendingMgrName = target.name;
    s.data.pendingRole = 'manager';
    s.data.editBrandsOnly = true;
    const selected = brandIndicesFromUserBrands(target.brands);
    s.data.adminBrandPick = csvFromBrandPickSet(selected);
    const pr: UserRole = 'manager';
    await ctx.reply(
      `✏️ Редактирование брендов менеджера ${target.name} (${tg}).\n` +
        'Текущие бренды в профиле: ' +
        (target.brands?.length ? target.brands.join(', ') : 'не заданы (участвует во всех брендах)') +
        '.\n\n' +
        adminManagerBrandPrompt(tg, target.name, selected, pr) +
        '\n\nСохранится после «Готово» или «Все бренды».',
      { reply_markup: adminManagerBrandKb(selected).reply_markup },
    );
  };
  bot.hears(/^\/editmgr(?:@\S+)?(?:\s+(.+))?$/is, handleEditmgr);
  bot.command('editmgr', handleEditmgr);

  bot.on('callback_query', async (ctx) => {
    const q = ctx.callbackQuery;
    if (!q || !('data' in q) || !q.data) return;
    const d = q.data;
    const uid = ctx.from?.id;
    if (!uid) return;
    try {
      if (d.startsWith('adm_b:')) {
        if (!(await isBotAdmin(uid))) {
          await ctx.answerCbQuery('Нет прав', { show_alert: true });
          return;
        }
        const s = sess(uid);
        if (s.key !== 'admin_mgr_brands') {
          await ctx.answerCbQuery('Сначала /adduser … или /editmgr <id>', {
            show_alert: true,
          });
          return;
        }
        const tg = Number(s.data.pendingMgrTg);
        const name = String(s.data.pendingMgrName || '');
        if (!Number.isFinite(tg) || !name) {
          await ctx.answerCbQuery('Сессия сброшена. Начните /adduser или /editmgr', { show_alert: true });
          s.key = 'idle';
          s.data = {};
          return;
        }
        const csv = String(s.data.adminBrandPick || '');
        const selected = parseBrandPickCsv(csv);

        const pr = sessionPendingUserRole(s);
        if (d.startsWith('adm_b:t:')) {
          const idx = parseInt(d.replace('adm_b:t:', ''), 10);
          if (!Number.isFinite(idx) || idx < 0 || idx >= BRANDS.length) {
            await ctx.answerCbQuery();
            return;
          }
          if (selected.has(idx)) selected.delete(idx);
          else selected.add(idx);
          s.data.adminBrandPick = csvFromBrandPickSet(selected);
          await ctx.answerCbQuery();
          return ctx.editMessageText(adminManagerBrandPrompt(tg, name, selected, pr), {
            reply_markup: adminManagerBrandKb(selected).reply_markup,
          });
        }
        const editOnly = Boolean(s.data.editBrandsOnly);
        if (d === 'adm_b:all') {
          try {
            if (editOnly) await patchUserBrands(tg, 'all');
            else await setUser(tg, name, pr, []);
          } catch {
            await ctx.answerCbQuery('Ошибка сохранения', { show_alert: true });
            return;
          }
          s.key = 'idle';
          s.data = {};
          await ctx.answerCbQuery();
          return ctx.editMessageText(
            editOnly
              ? `✅ Бренды сброшены: ${tg} — ${name}\nТеперь как «все бренды» (универсальный менеджер).`
              : `✅ Ок. ${tg} — ${pr}, ${name}\nБренды в профиле не заданы (как «все» для manager).`,
          );
        }
        if (d === 'adm_b:done') {
          if (selected.size === 0) {
            await ctx.answerCbQuery('Отметьте хотя бы один бренд или нажмите «Все бренды»', { show_alert: true });
            return;
          }
          const list = Array.from(selected)
            .sort((a, b) => a - b)
            .map((i) => BRANDS[i]!);
          try {
            if (editOnly) await patchUserBrands(tg, list);
            else await setUser(tg, name, pr, list);
          } catch {
            await ctx.answerCbQuery('Ошибка сохранения', { show_alert: true });
            return;
          }
          s.key = 'idle';
          s.data = {};
          await ctx.answerCbQuery();
          return ctx.editMessageText(
            editOnly
              ? `✅ Бренды обновлены: ${name} (${tg})\n${list.join(', ')}`
              : `✅ Ок. ${tg} — ${pr}, ${name}\nБренды в профиле: ${list.join(', ')}`,
          );
        }
        await ctx.answerCbQuery();
        return;
      }

      if (d === 'buy_consent:yes') {
        await ctx.answerCbQuery();
        const s = sess(uid);
        if (await getUser(uid)) {
          return ctx.reply('Вы сотрудник — откройте меню через /start.');
        }
        s.key = 'buyer_fio';
        s.data = {};
        try {
          return await ctx.editMessageText('Шаг 1/3. Введите **ФИО** одним сообщением в этот чат.', {
            parse_mode: 'Markdown',
          });
        } catch {
          return ctx.reply('Шаг 1/3. Введите ФИО одним сообщением:');
        }
      }

      if (d.startsWith('buy_br:')) {
        const s = sess(uid);
        if (s.key !== 'buyer_brand') {
          await ctx.answerCbQuery();
          return;
        }
        s.data.brand = d.replace('buy_br:', '');
        s.key = 'buyer_confirm';
        await ctx.answerCbQuery();
        return ctx.editMessageText(
          `Сводка:\nФИО: ${s.data.fio}\nТел: ${s.data.phone}\nБренд: ${s.data.brand}\n\nКак назначить менеджера?`,
          { reply_markup: buyConfirmKb().reply_markup },
        );
      }
      if (d === 'buy_no') {
        const s = sess(uid);
        if (s.key !== 'buyer_confirm' && s.key !== 'buyer_pick_manager') {
          await ctx.answerCbQuery();
          return;
        }
        s.key = 'idle';
        s.data = {};
        await ctx.answerCbQuery();
        return ctx.editMessageText('Заявка отменена. Если понадобится — /start.');
      }
      if (d === 'buy_pick_mgr') {
        const s = sess(uid);
        if (s.key !== 'buyer_confirm') {
          await ctx.answerCbQuery();
          return;
        }
        if (await getUser(uid)) {
          await ctx.answerCbQuery('Для сотрудников — кнопка «➕ Добавить клиента».', { show_alert: true });
          return;
        }
        await ctx.answerCbQuery();
        const list = await listManagersForBrandPick(String(s.data.brand));
        if (list.length === 0) {
          return ctx.editMessageText('Нет доступных менеджеров по этому бренду. Попробуйте автоназначение или позже.');
        }
        s.key = 'buyer_pick_manager';
        const rows = list.slice(0, 28).map((mgr) => [
          Markup.button.callback(`${(mgr.name?.trim() || 'Менеджер').slice(0, 36)}`, `buy_m:${mgr.id}`),
        ]);
        rows.push([Markup.button.callback('◀️ Назад', 'buy_mgr_back')]);
        return ctx.editMessageText(
          `Выберите менеджера (бренд: ${s.data.brand}):\n\n«Назад» — к выбору способа назначения.`,
          { reply_markup: Markup.inlineKeyboard(rows).reply_markup },
        );
      }
      if (d === 'buy_mgr_back') {
        const s = sess(uid);
        if (s.key !== 'buyer_pick_manager') {
          await ctx.answerCbQuery();
          return;
        }
        await ctx.answerCbQuery();
        s.key = 'buyer_confirm';
        return ctx.editMessageText(
          `Сводка:\nФИО: ${s.data.fio}\nТел: ${s.data.phone}\nБренд: ${s.data.brand}\n\nКак назначить менеджера?`,
          { reply_markup: buyConfirmKb().reply_markup },
        );
      }
      const buyM = d.match(/^buy_m:(\d+)$/);
      if (buyM) {
        const s = sess(uid);
        if (s.key !== 'buyer_pick_manager') {
          await ctx.answerCbQuery();
          return;
        }
        if (await getUser(uid)) {
          await ctx.answerCbQuery();
          return;
        }
        await ctx.answerCbQuery();
        const m = parseInt(buyM[1]!, 10);
        const mgr = await getUser(m);
        if (!mgr || mgr.role !== 'manager' || !mgr.active) {
          return ctx.editMessageText('Менеджер недоступен. Нажмите «Назад».');
        }
        const poolIds = new Set((await listManagersForBrandPick(String(s.data.brand))).map((x) => parseInt(x.id, 10)));
        if (!poolIds.has(m)) {
          return ctx.editMessageText('Менеджер не из пула по бренду. Нажмите «Назад».');
        }
        const fio = String(s.data.fio);
        const phone = String(s.data.phone);
        const brand = String(s.data.brand);
        const leadId = await createLead(
          {
            fio,
            phone,
            brand,
            payment: DEFAULT_LEAD_PAYMENT,
            budget: '',
            createdBy: uid,
            buyerTelegramId: uid,
          },
          m,
        );
        await upsertBuyerContact({
          telegramId: uid,
          fio,
          phone,
          brands: [brand],
          marketingOptIn: true,
          lastLeadId: leadId,
        });
        s.key = 'idle';
        s.data = {};
        const label = await formatTelegramShortName(m);
        await ctx.editMessageText(
          `✅ Заявка #${leadId} отправлена.\nОтветственный: ${label}\n` +
            `Через ~${config.customerSurveyMinutes} мин напишем короткий опрос.`,
        );
        const mgrText = `${leadNotifyBody(leadId, fio, phone, brand)}\n(онлайн Telegram)`;
        try {
          await ctx.telegram.sendMessage(m, mgrText, { reply_markup: leadActionsKb(leadId).reply_markup });
        } catch {
          /* */
        }
        try {
          await ctx.reply('Можно оформить ещё одну заявку:', { reply_markup: clientIdleKb().reply_markup });
        } catch {
          /* */
        }
        return;
      }
      if (d === 'buy_yes' || d === 'buy_auto') {
        const s = sess(uid);
        if (s.key !== 'buyer_confirm') {
          await ctx.answerCbQuery();
          return;
        }
        if (await getUser(uid)) {
          await ctx.answerCbQuery('Для сотрудников — кнопка «➕ Добавить клиента».', { show_alert: true });
          return;
        }
        await ctx.answerCbQuery();
        const brand = String(s.data.brand);
        const list = await listManagersForBrandPick(brand);
        if (list.length === 0) {
          return ctx.editMessageText('Сейчас нет доступных менеджеров по этому бренду. Попробуйте «Выбрать менеджера» или позже.');
        }
        if (list.length > 1) {
          s.key = 'buyer_pick_manager';
          const rows = list.slice(0, 28).map((mgr) => [
            Markup.button.callback(`${(mgr.name?.trim() || 'Менеджер').slice(0, 36)}`, `buy_m:${mgr.id}`),
          ]);
          rows.push([Markup.button.callback('◀️ Назад', 'buy_mgr_back')]);
          return ctx.editMessageText(
            `На бренд «${brand}» несколько менеджеров — выберите ответственного:`,
            { reply_markup: Markup.inlineKeyboard(rows).reply_markup },
          );
        }
        const m = parseInt(list[0]!.id, 10);
        const fio = String(s.data.fio);
        const phone = String(s.data.phone);
        const leadId = await createLead(
          {
            fio,
            phone,
            brand,
            payment: DEFAULT_LEAD_PAYMENT,
            budget: '',
            createdBy: uid,
            buyerTelegramId: uid,
          },
          m,
        );
        await upsertBuyerContact({
          telegramId: uid,
          fio,
          phone,
          brands: [brand],
          marketingOptIn: true,
          lastLeadId: leadId,
        });
        s.key = 'idle';
        s.data = {};
        const label = await formatTelegramShortName(m);
        await ctx.editMessageText(
          `✅ Заявка #${leadId} отправлена (автоочередь).\nОтветственный: ${label}\n` +
            `Через ~${config.customerSurveyMinutes} мин напишем короткий опрос.`,
        );
        const mgrText = `${leadNotifyBody(leadId, fio, phone, brand)}\n(онлайн Telegram)`;
        try {
          await ctx.telegram.sendMessage(m, mgrText, { reply_markup: leadActionsKb(leadId).reply_markup });
        } catch {
          /* */
        }
        try {
          await ctx.reply('Можно оформить ещё одну заявку:', { reply_markup: clientIdleKb().reply_markup });
        } catch {
          /* */
        }
        return;
      }

      const cs1 = d.match(/^cs1:([a-zA-Z0-9]+):(good|ok|bad)$/);
      if (cs1) {
        await ctx.answerCbQuery();
        const leadId = cs1[1]!;
        const rating = cs1[2] as 'good' | 'ok' | 'bad';
        const L = await getLead(leadId);
        if (!L || L.buyerTelegramId !== uid) {
          try {
            return await ctx.editMessageText('Нет доступа к этому опросу.');
          } catch {
            return;
          }
        }
        await patchBuyerSurvey(leadId, { visit: rating });
        if (rating === 'bad') {
          await patchBuyerSurvey(leadId, {}, { complete: true });
          return ctx.editMessageText('Спасибо за откровенность. Если что-то изменится — снова /start.');
        }
        return ctx.editMessageText('Довольны ли общением с менеджером?', {
          reply_markup: surveyManagerKb(leadId).reply_markup,
        });
      }

      const cs2 = d.match(/^cs2:([a-zA-Z0-9]+):(yes|partial|no)$/);
      if (cs2) {
        await ctx.answerCbQuery();
        const leadId = cs2[1]!;
        const man = cs2[2] as 'yes' | 'partial' | 'no';
        const L = await getLead(leadId);
        if (!L || L.buyerTelegramId !== uid) {
          try {
            return await ctx.editMessageText('Нет доступа.');
          } catch {
            return;
          }
        }
        await patchBuyerSurvey(leadId, { manager: man });
        if (man === 'no') {
          await patchBuyerSurvey(leadId, {}, { complete: true });
          return ctx.editMessageText('Поняли вас. Спасибо! При необходимости — /start.');
        }
        return ctx.editMessageText('Хотите получать предложения и по другим брендам (в рамках этого бота)?', {
          reply_markup: surveyOtherBrandsKb(leadId).reply_markup,
        });
      }

      const cs3 = d.match(/^cs3:([a-zA-Z0-9]+):(yes|no)$/);
      if (cs3) {
        await ctx.answerCbQuery();
        const leadId = cs3[1]!;
        const yn = cs3[2] as 'yes' | 'no';
        const L = await getLead(leadId);
        if (!L || L.buyerTelegramId !== uid) {
          try {
            return await ctx.editMessageText('Нет доступа.');
          } catch {
            return;
          }
        }
        if (yn === 'no') {
          await patchBuyerSurvey(leadId, { wantOtherBrands: false }, { complete: true });
          return ctx.editMessageText('Спасибо! Хорошего дня. Новая заявка — /start.');
        }
        await patchBuyerSurvey(leadId, { wantOtherBrands: true });
        const pick = new Set<number>();
        const s = sess(uid);
        s.data.csPickLeadId = leadId;
        s.data.csPickCsv = '';
        return ctx.editMessageText('Отметьте интересующие бренды (можно несколько), затем «Готово».', {
          reply_markup: otherBrandsPickKb(leadId, pick).reply_markup,
        });
      }

      const cs4i = d.match(/^cs4i:([a-zA-Z0-9]+):(\d+)$/);
      if (cs4i) {
        await ctx.answerCbQuery();
        const leadId = cs4i[1]!;
        const idx = parseInt(cs4i[2]!, 10);
        const L = await getLead(leadId);
        if (!L || L.buyerTelegramId !== uid) {
          try {
            return await ctx.editMessageText('Нет доступа.');
          } catch {
            return;
          }
        }
        if (String(sess(uid).data.csPickLeadId) !== leadId) {
          try {
            return await ctx.editMessageText('Сессия сбросилась. Нажмите /start.');
          } catch {
            return;
          }
        }
        if (!Number.isFinite(idx) || idx < 0 || idx >= BRANDS.length) return;
        const csv = String(sess(uid).data.csPickCsv || '');
        const set = parseBrandPickCsv(csv);
        if (set.has(idx)) set.delete(idx);
        else set.add(idx);
        sess(uid).data.csPickCsv = csvFromBrandPickSet(set);
        return ctx.editMessageText('Отметьте интересующие бренды (можно несколько), затем «Готово».', {
          reply_markup: otherBrandsPickKb(leadId, set).reply_markup,
        });
      }

      const cs4done = d.match(/^cs4done:([a-zA-Z0-9]+)$/);
      if (cs4done) {
        await ctx.answerCbQuery();
        const leadId = cs4done[1]!;
        const L = await getLead(leadId);
        if (!L || L.buyerTelegramId !== uid || String(sess(uid).data.csPickLeadId) !== leadId) {
          try {
            return await ctx.editMessageText('Нет доступа или сессия сброшена.');
          } catch {
            return;
          }
        }
        const set = parseBrandPickCsv(String(sess(uid).data.csPickCsv || ''));
        const extra = Array.from(set)
          .sort((a, b) => a - b)
          .map((i) => BRANDS[i]!)
          .filter((b) => b !== L.brand);
        await patchBuyerSurvey(leadId, { otherBrands: extra.length ? extra : undefined }, { complete: true });
        if (extra.length) {
          await appendBrandsToBuyer(uid, extra);
          await upsertBuyerContact({
            telegramId: uid,
            fio: L.fio,
            phone: L.phone,
            brands: [L.brand, ...extra],
            marketingOptIn: true,
            lastLeadId: leadId,
          });
        }
        sess(uid).data.csPickLeadId = undefined;
        sess(uid).data.csPickCsv = undefined;
        return ctx.editMessageText(
          extra.length
            ? `Сохранили интерес к брендам: ${extra.join(', ')}. Будем присылать акции и новости в Telegram. Спасибо!`
            : 'Спасибо! Если передумаете по брендам — /start.',
        );
      }

      await ctx.answerCbQuery();

      if (d.startsWith('atz_br:')) {
        const s = sess(uid);
        if (s.key !== 'atz_brand') return;
        s.data.brand = d.replace('atz_br:', '');
        s.key = 'atz_confirm';
        return ctx.editMessageText(atzConfirmSummary(s), { reply_markup: atzConfirmKb().reply_markup });
      }
      if (d === 'atz_no') {
        const s = sess(uid);
        if (s.key !== 'atz_confirm' && s.key !== 'atz_pick_manager') return;
        sess(uid).key = 'idle';
        sess(uid).data = {};
        return ctx.editMessageText('Отмена.');
      }
      if (d === 'atz_pick_mgr') {
        const s = sess(uid);
        if (s.key !== 'atz_confirm') return;
        const u = await getUser(uid);
        if (!u || (u.role !== 'atz' && u.role !== 'admin' && u.role !== 'manager')) {
          return ctx.editMessageText('Нет прав (нужен АТЗ, менеджер или админ).');
        }
        const list = await listManagersForBrandPick(String(s.data.brand));
        if (list.length === 0) {
          return ctx.editMessageText('Нет доступных менеджеров для этого бренда. Добавьте manager через /adduser.');
        }
        s.key = 'atz_pick_manager';
        const rows = list.slice(0, 28).map((mgr) => [
          Markup.button.callback(`${(mgr.name?.trim() || 'Менеджер').slice(0, 36)}`, `atz_m:${mgr.id}`),
        ]);
        rows.push([Markup.button.callback('◀️ Назад', 'atz_mgr_back')]);
        return ctx.editMessageText(
          `Выберите ответственного менеджера (бренд: ${s.data.brand}):\n\n` +
            `«Назад» — к автоназначению или другим вариантам.`,
          { reply_markup: Markup.inlineKeyboard(rows).reply_markup },
        );
      }
      if (d === 'atz_mgr_back') {
        const s = sess(uid);
        if (s.key !== 'atz_pick_manager') return;
        s.key = 'atz_confirm';
        return ctx.editMessageText(atzConfirmSummary(s), { reply_markup: atzConfirmKb().reply_markup });
      }
      const atzM = d.match(/^atz_m:(\d+)$/);
      if (atzM) {
        const s = sess(uid);
        if (s.key !== 'atz_pick_manager') return;
        const u = await getUser(uid);
        if (!u || (u.role !== 'atz' && u.role !== 'admin' && u.role !== 'manager')) {
          return ctx.editMessageText('Нет прав.');
        }
        const m = parseInt(atzM[1]!, 10);
        if (!Number.isFinite(m)) return;
        const mgr = await getUser(m);
        if (!mgr || mgr.role !== 'manager' || !mgr.active) {
          return ctx.editMessageText('Менеджер недоступен. Нажмите «Назад» и выберите снова.');
        }
        const poolIds = new Set((await listManagersForBrandPick(String(s.data.brand))).map((x) => parseInt(x.id, 10)));
        if (!poolIds.has(m)) {
          return ctx.editMessageText('Менеджер не из пула по этому бренду. Нажмите «Назад».');
        }
        const fio = String(s.data.fio);
        const phone = String(s.data.phone);
        const brand = String(s.data.brand);
        const leadId = await createLead(
          {
            fio,
            phone,
            brand,
            payment: DEFAULT_LEAD_PAYMENT,
            budget: '',
            createdBy: uid,
          },
          m,
        );
        sess(uid).key = 'idle';
        sess(uid).data = {};
        const label = await formatTelegramShortName(m);
        await ctx.editMessageText(`✅ Клиент зарегистрирован, лид #${leadId}.\nОтветственный: ${label}`);
        const text = leadNotifyBody(leadId, fio, phone, brand);
        if (m !== uid) {
          try {
            const kb = leadActionsKb(leadId);
            await ctx.telegram.sendMessage(m, text, { reply_markup: kb.reply_markup });
          } catch {
            /* */
          }
        } else {
          try {
            await ctx.reply(text, { reply_markup: leadActionsKb(leadId).reply_markup });
          } catch {
            /* */
          }
        }
        return;
      }
      if (d === 'atz_yes' || d === 'atz_yes:queue' || d === 'atz_yes:self') {
        const s = sess(uid);
        if (s.key !== 'atz_confirm') return;
        const keepSelf = d === 'atz_yes:self';
        const u = await getUser(uid);
        if (!u || (u.role !== 'atz' && u.role !== 'admin' && u.role !== 'manager')) {
          return ctx.editMessageText('Нет прав (нужен АТЗ, менеджер или админ).');
        }
        let m: number | null = null;
        if (keepSelf) {
          m = uid;
        } else {
          const brand = String(s.data.brand);
          const list = await listManagersForBrandPick(brand);
          if (list.length === 0) {
            return ctx.editMessageText('Нет менеджеров в системе. Добавьте manager через /adduser.');
          }
          if (list.length === 1) {
            m = parseInt(list[0]!.id, 10);
          } else {
            s.key = 'atz_pick_manager';
            const rows = list.slice(0, 28).map((mgr) => [
              Markup.button.callback(`${(mgr.name?.trim() || 'Менеджер').slice(0, 36)}`, `atz_m:${mgr.id}`),
            ]);
            rows.push([Markup.button.callback('◀️ Назад', 'atz_mgr_back')]);
            return ctx.editMessageText(
              `На бренд «${brand}» несколько менеджеров — выберите ответственного:`,
              { reply_markup: Markup.inlineKeyboard(rows).reply_markup },
            );
          }
        }
        if (!m) {
          return ctx.editMessageText('Нет менеджеров в системе. Добавьте manager через /adduser.');
        }
        const fio = String(s.data.fio);
        const phone = String(s.data.phone);
        const brand = String(s.data.brand);
        const leadId = await createLead(
          {
            fio,
            phone,
            brand,
            payment: DEFAULT_LEAD_PAYMENT,
            budget: '',
            createdBy: uid,
          },
          m,
        );
        sess(uid).key = 'idle';
        sess(uid).data = {};
        const label = await formatTelegramShortName(m);
        const assignLabel = keepSelf ? 'закреплён за вами' : `ответственный: ${label}`;
        await ctx.editMessageText(`✅ Клиент зарегистрирован, лид #${leadId}. ${assignLabel}.`);
        const text = leadNotifyBody(leadId, fio, phone, brand);
        if (m !== uid) {
          try {
            const kb = leadActionsKb(leadId);
            await ctx.telegram.sendMessage(m, text, { reply_markup: kb.reply_markup });
          } catch {
            /* */
          }
        } else {
          try {
            await ctx.reply(text, { reply_markup: leadActionsKb(leadId).reply_markup });
          } catch {
            /* */
          }
        }
        return;
      }

      if (d.startsWith('ld_fc:')) {
        const id = d.replace('ld_fc:', '');
        const L = await getLead(id);
        if (!L || (L.assignedTo !== uid && (await getUser(uid))?.role !== 'rop')) {
          return ctx.editMessageText('Нет доступа');
        }
        await markFirstContact(id);
        return ctx.editMessageText('Зафиксировано: связался. ✅');
      }
      if (d.startsWith('ld_mt:')) {
        return ctx.editMessageText('Статус «встреча» — в следующей итерации. Пока — используйте заметки у РОП.');
      }
      if (d.startsWith('ld_lost:')) {
        return ctx.editMessageText('Укажите отказ: напишите менеджеру или админу (MVP: без формы).');
      }
      if (d.startsWith('tr_pick:')) {
        const leadId = d.replace('tr_pick:', '');
        const L = await getLead(leadId);
        if (!L || L.assignedTo !== uid) {
          return ctx.editMessageText('Нет доступа к этому лиду');
        }
        const s = sess(uid);
        s.data.leadId = leadId;
        s.key = 'tr_reason';
        return ctx.editMessageText('Причина передачи:', {
          reply_markup: Markup.inlineKeyboard(REASON.map((r) => [Markup.button.callback(r.label, `tr_re:${r.id}`)]))
            .reply_markup,
        });
      }
      if (d.startsWith('tr_re:')) {
        const reason = d.replace('tr_re:', '') as TransferReasonId;
        sess(uid).data.reason = reason;
        sess(uid).key = 'tr_target';
        return ctx.editMessageText('Куда передать:', {
          reply_markup: Markup.inlineKeyboard(TARGET.map((t) => [Markup.button.callback(t.label, `tr_tg:${t.id}`)]))
            .reply_markup,
        });
      }
      if (d.startsWith('tr_tg:')) {
        const target = d.replace('tr_tg:', '') as TransferTargetId;
        const s = sess(uid);
        s.data.target = target;
        s.key = 'tr_comment';
        return ctx.editMessageText('Комментарий одним сообщением:');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Ошибка';
      await ctx.reply(msg);
    }
  });

  bot.on('text', async (ctx) => {
    const text = (ctx.message?.text || '').trim();
    const uid = ctx.from?.id;
    if (!uid) return;
    if (text.startsWith('/')) return;
    const s = sess(uid);

    if (s.key === 'atz_fio') {
      s.data.fio = text;
      s.key = 'atz_phone';
      return ctx.reply('Введите телефон (+7…):');
    }
    if (s.key === 'atz_phone') {
      s.data.phone = text;
      s.key = 'atz_brand';
      return ctx.reply('Бренд — выберите кнопку:', { reply_markup: brandKb().reply_markup });
    }
    if (s.key === 'buyer_fio') {
      if (await getUser(uid)) return ctx.reply('Вы вошли как сотрудник — меню /start.');
      s.data.fio = text;
      s.key = 'buyer_phone';
      return ctx.reply('Шаг 2/3. Введите телефон (+7…):');
    }
    if (s.key === 'buyer_phone') {
      if (await getUser(uid)) return ctx.reply('Вы вошли как сотрудник — меню /start.');
      s.data.phone = text;
      s.key = 'buyer_brand';
      return ctx.reply('Шаг 3/3. Выберите бренд:', { reply_markup: buyBrandKb().reply_markup });
    }
    if (s.key === 'tr_comment') {
      s.data.comment = text;
      s.key = 'idle';
      try {
        const r = await recordTransfer(
          String(s.data.leadId),
          uid,
          s.data.reason as TransferReasonId,
          s.data.target as TransferTargetId,
          text,
        );
        const newLabel = await formatTelegramShortName(r.newManager);
        await ctx.reply(`✅ Клиент передан. Ответственный: ${newLabel}`);
        const fromName = await formatTelegramShortName(uid);
        const msg =
          `🔄 Вам передан лид #${s.data.leadId}\n` + `От: ${fromName}\n` + `Комментарий: ${text}`;
        try {
          const kb = leadActionsKb(String(s.data.leadId));
          await ctx.telegram.sendMessage(r.newManager, msg, { reply_markup: kb.reply_markup });
        } catch { /* */ }
      } catch (e) {
        await ctx.reply(e === 'object' && e && (e as { message?: string }).message === 'NO_MANAGERS' ? 'Нет менеджеров' : 'Ошибка передачи');
      }
      return;
    }

    // «Добавить клиента» / «Зарегистрировать» — одна воронка (ФИО → телефон → …).
    if (
      text === '👤 Зарегистрировать клиента' ||
      text === '➕ Новый клиент' ||
      text === '➕ Добавить клиента'
    ) {
      const u = await getUser(uid);
      if (!u || (u.role !== 'atz' && u.role !== 'admin' && u.role !== 'manager')) {
        return ctx.reply('Нет прав.');
      }
      s.key = 'atz_fio';
      s.data = {};
      return ctx.reply('Введите ФИО клиента:');
    }
    if (text === '🚗 Новая заявка на авто') {
      const u = await getUser(uid);
      if (u) return ctx.reply('Сотрудникам: оформление — «➕ Добавить клиента» или «Зарегистрировать клиента».');
      return sendClientEntry(ctx, uid);
    }
    if (text === '🔄 Передать клиента') {
      const u = await getUser(uid);
      if (!u || (u.role !== 'manager' && u.role !== 'admin')) return ctx.reply('Нет прав.');
      const list = await listMyLeads(uid);
      if (list.length === 0) return ctx.reply('Нет лидов');
      s.key = 'tr_pick';
      {
        const pick = Markup.inlineKeyboard(
          list.slice(0, 10).map((L) => [Markup.button.callback(`${L.fio} · ${L.brand}`, `tr_pick:${L.id}`)]),
        );
        return ctx.reply('Выберите клиента:', { reply_markup: pick.reply_markup });
      }
    }
    if (text === '📋 Мои лиды') {
      const list = await listMyLeads(uid);
      if (list.length === 0) return ctx.reply('Пока пусто');
      const body = list
        .map((L, i) => `${i + 1}. ${L.fio} — ${L.status} (${L.brand}) #${L.id}`)
        .join('\n');
      return ctx.reply(body);
    }
    if (text === '📊 Статистика') {
      const u = await getUser(uid);
      if (u?.role === 'rop') return sendRopDepartmentStats(ctx, uid);
      return;
    }
    if (text === '📊 Моя статистика') {
      return sendStaffStatsBoard(ctx, uid);
    }
    if (text === '📋 Клиенты за сегодня' && (await getUser(uid))?.role === 'atz') {
      return ctx.reply(`Сегодня: ${await countToday()} заявок (все ltb-лиды).`);
    }
    if (text === '🚗 Направить в отдел') {
      if ((await getUser(uid))?.role !== 'atz') return;
      return ctx.reply(
        'Оформите клиента через «Зарегистрировать клиента» или «➕ Добавить клиента». В конце можно: автоназначение по очереди, выбрать менеджера вручную или оставить лид себе.',
      );
    }
    if (text === '⚠️ Ожидающие клиенты' || text === '⚠️ Ожидающие') {
      if ((await getUser(uid))?.role !== 'atz') return;
      return ctx.reply(
        'Список ожидающих клиентов — в следующей версии. Пока используйте «Клиенты за сегодня» и лиды у менеджеров.',
      );
    }
    if (text === '👥 По менеджерам') {
      if ((await getUser(uid))?.role !== 'rop') return;
      return sendRopManagersBoard(ctx, uid);
    }
    if (text === '📋 Все лиды' || text === '⏰ Просроченные') {
      if ((await getUser(uid))?.role !== 'rop') return;
      return ctx.reply('Раздел в разработке.');
    }
    if (text === '🔄 Передачи') {
      if ((await getUser(uid))?.role !== 'rop') return;
      return sendRopDepartmentTransfers(ctx, uid);
    }
    if (text === '⚙️ Настройки') {
      if ((await getUser(uid))?.role !== 'rop') return;
      return ctx.reply('Отдел задаёт админ: /setdept. Остальное — в разработке.');
    }
    if (text === '📤 Передачи (кто кому)') {
      if (!(await isBotAdmin(uid))) return;
      return sendAdminTransfersReport(ctx, uid);
    }
    if (text === '📊 Сводка') {
      if (!(await isBotAdmin(uid))) return;
      return sendAdminStatsSummary(ctx, uid);
    }
    if (text === '📌 Лиды (всего)') {
      if (!(await isBotAdmin(uid))) return;
      return sendAdminLeadsDigest(ctx, uid);
    }
    if (text === '🕓 Напоминания') {
      const u = await getUser(uid);
      if (!u || (u.role !== 'manager' && u.role !== 'admin')) return;
      return ctx.reply(
        'Персональные напоминания — в следующей версии. Напоминания менеджеру по SLA и эскалация РОП уже работают в фоне.',
      );
    }
    if (text === '⚙️ Помощь' || text === '/help') {
      return ctx.reply('Помощь: @админ, README в репозитории asterauto-crm-bot');
    }
    if (text === '🏠 Главное' || text === 'Главное' || text === 'Главное') {
      return sendMain(ctx, uid);
    }
  });

  if (config.disableBackgroundPoll) {
    // eslint-disable-next-line no-console
    console.warn('[bot] BOT_DISABLE_BACKGROUND_POLL: фоновые опросы БД отключены (SLA и опрос покупателя).');
  } else {
    setInterval(() => {
      runSlaBot(bot).catch(() => null);
      runCustomerSurveyBot(bot).catch(() => null);
    }, config.pollerIntervalMs);
    // eslint-disable-next-line no-console
    console.log('[bot] фоновый poller каждые', config.pollerIntervalMs, 'мс');
  }

  const me = await bot.telegram.getMe();
  // eslint-disable-next-line no-console
  console.log('Telegram:', '@' + (me.username || '?'), '| DB:', databaseUrlHostSummary());

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  const webhookDomain = resolveWebhookPublicBase();

  if (process.env.RENDER === 'true' && !webhookDomain) {
    // eslint-disable-next-line no-console
    console.error(
      '[render] Нет публичного URL для webhook (пусты RENDER_EXTERNAL_URL / RENDER_EXTERNAL_HOSTNAME). ' +
        'Создайте сервис типа Web Service (не Background Worker) или задайте BOT_WEBHOOK_PUBLIC_URL=https://ваш-сервис.onrender.com',
    );
  }

  if (webhookDomain) {
    const port = Number(process.env.PORT);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error('Webhook: нужна переменная PORT (на Render Web Service задаётся автоматически).');
    }
    let secretToken = (process.env.BOT_WEBHOOK_SECRET || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 256);
    if (secretToken.length < 8) secretToken = '';

    await bot.launch({
      dropPendingUpdates: true,
      webhook: {
        domain: webhookDomain,
        port,
        host: '0.0.0.0',
        ...(secretToken ? { secretToken } : {}),
      },
    });
    // eslint-disable-next-line no-console
    console.log('[mode] webhook →', webhookDomain);
  } else {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    // eslint-disable-next-line no-console
    console.log('[mode] long polling. Для Render без 409 нужен Web Service + webhook или переменная BOT_WEBHOOK_PUBLIC_URL.');
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
