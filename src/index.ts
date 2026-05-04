import { Markup } from 'telegraf';
import { config } from './config';
import { initFirebase, getActiveFirebaseProjectId } from './firebase';
import { Telegraf, type Context } from 'telegraf';
import { Timestamp } from 'firebase-admin/firestore';
import { getUser, isAdmin, ropTelegramIdsFromEnv, setUser, getNextManagerTelegramId } from './services/ltbUsers';
import {
  createLead,
  getLead,
  listLeadsNeedingSla,
  listMyLeads,
  markFirstContact,
  recordTransfer,
  setSlaFlags,
  countToday,
} from './services/ltbLeads';
import type { Session, TransferReasonId, TransferTargetId, UserRole } from './types';

import 'dotenv/config';

const BRANDS = [
  'OMODA',
  'JAECOO',
  'LADA',
  'GAC',
  'Changan',
  'JAC',
  'Chery',
  'Jetour',
  'Б/У',
] as const;

const sessions = new Map<number, Session>();

function sess(uid: number): Session {
  if (!sessions.has(uid)) sessions.set(uid, { key: 'idle', data: {} });
  return sessions.get(uid)!;
}

function mainKb(role: string) {
  if (role === 'atz') {
    return Markup.keyboard([
      ['👤 Зарегистрировать клиента'],
      ['🚗 Направить в отдел', '📋 Клиенты за сегодня'],
      ['⚠️ Ожидающие', '🏠 Главное'],
    ]).resize();
  }
  if (role === 'rop') {
    return Markup.keyboard([
      ['📊 Статистика', '📋 Все лиды'],
      ['⏰ Просроченные', '👥 По менеджерам'],
      ['🏠 Главное'],
    ]).resize();
  }
  if (role === 'manager' || role === 'admin') {
    return Markup.keyboard([
      ['➕ Новый клиент', '🔄 Передать клиента'],
      ['📋 Мои лиды', '📊 Моя статистика'],
      ['🕓 Напоминания', '⚙️ Помощь'],
    ]).resize();
  }
  return Markup.keyboard([['/start']]).resize();
}

function brandKb() {
  return Markup.inlineKeyboard(
    BRANDS.map((b) => [Markup.button.callback(b, `atz_br:${b}`)])
  );
}

function payKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💳 Кредит', 'atz_pay:credit')],
    [Markup.button.callback('💵 Наличные', 'atz_pay:cash')],
    [Markup.button.callback('🔁 Trade-in', 'atz_pay:tradein')],
  ]);
}

const REASON: { id: TransferReasonId; label: string }[] = [
  { id: 'high_price', label: '💰 Высокая цена' },
  { id: 'no_stock', label: '🚫 Нет наличия' },
  { id: 'brand_dislike', label: '❌ Не понравился бренд' },
  { id: 'credit_fail', label: '📉 Не прошел кредит' },
  { id: 'trade_want', label: '🔁 Хочет обмен' },
  { id: 'need_used', label: '🚗 Нужен Б/У' },
];

const TARGET: { id: TransferTargetId; label: string }[] = [
  { id: 'other_brand', label: 'Другой бренд' },
  { id: 'used', label: 'Б/У' },
  { id: 'buyout', label: 'Выкуп' },
  { id: 'finance', label: 'Фин. отдел' },
];

function leadActionsKb(leadId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📞 Связался', `ld_fc:${leadId}`)],
    [Markup.button.callback('✅ Встреча', `ld_mt:${leadId}`), Markup.button.callback('❌ Отказ', `ld_lost:${leadId}`)],
  ]);
}

async function sendMain(ctx: Context, uid: number) {
  try {
    let u = await getUser(uid);
    // Первый вход: ID в BOT_ADMIN_IDS, но ещё нет документа в ltbUsers — создаём admin
    if (!u && isAdmin(uid)) {
      const label =
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
        ctx.from?.username ||
        'Admin';
      await setUser(uid, label, 'admin');
      u = await getUser(uid);
    }
    if (!u) {
      await ctx.reply('Вас нет в системе. Попросите администратора добавить вас (/adduser в боте у админа).');
      return;
    }
    if (u.role === 'none' || !u.active) {
      await ctx.reply('Учетная запись не активна.');
      return;
    }
    const label =
      u.role === 'atz'
        ? 'АТЗ'
        : u.role === 'rop'
          ? 'РОП'
          : u.role === 'admin'
            ? 'Админ / менеджер'
            : 'Менеджер';
    const mk = mainKb(u.role);
    await ctx.reply(`🏠 Главное меню (${label})`, { reply_markup: mk.reply_markup });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('sendMain / Firestore:', e);
    const grpc = e as { code?: number; details?: string };
    const isDenied = grpc.code === 7 || String(grpc.details || '').includes('PERMISSION_DENIED');
    const hint = isDenied
      ? 'Доступ к Firestore запрещён (IAM). В Google Cloud Console → IAM для проекта ключа выдайте этому сервисному аккаунту роль «Cloud Datastore User» или «Editor». Убедитесь, что в Firebase для этого проекта включён Firestore, а JSON ключ скачан из того же проекта.'
      : 'На Render проверьте FIREBASE_SERVICE_ACCOUNT_JSON (полный JSON) и что Firestore включён в Firebase Console.';
    await ctx.reply('Не удалось связаться с базой.\n' + hint);
  }
}

async function runSlaBot(bot: Telegraf) {
  const rows = await listLeadsNeedingSla();
  const now = Date.now();
  const t15 = config.slaReminderMinutes * 60 * 1000;
  const t30 = config.slaRopMinutes * 60 * 1000;
  for (const L of rows) {
    const created = (L as { createdAt: Timestamp }).createdAt.toMillis();
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
      for (const rid of rop) {
        try {
          await bot.telegram.sendMessage(
            rid,
            `⚠️ Просроченный лид\nМенеджер: ${(L as { assignedTo: number }).assignedTo}\nКлиент: ${(L as { fio: string }).fio}\nОжидание: ${Math.round(age / 60000)} мин\n#${L.id}`,
          );
        } catch { /* */ }
      }
      await setSlaFlags(L.id, (L as { sla15Sent?: boolean }).sla15Sent || false, true);
    }
  }
}

function parseRole(s: string): UserRole | null {
  const m = s.toLowerCase();
  if (m === 'manager' || m === 'менеджер') return 'manager';
  if (m === 'atz' || m === 'атз') return 'atz';
  if (m === 'rop' || m === 'роп') return 'rop';
  if (m === 'admin' || m === 'админ') return 'admin';
  return null;
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
  initFirebase();
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
    ctx.reply('Команды:\n/adduser <telegram_id> <роль: manager|atz|rop|admin> <имя> — только BOT_ADMIN_IDS\n/lead_<id> — открыть карточку (в разработке)'),
  );

  bot.command('adduser', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid || !isAdmin(uid)) {
      return ctx.reply('Нет прав.');
    }
    const parts = (ctx.message?.text || '').split(/\s+/).slice(1);
    if (parts.length < 3) {
      return ctx.reply('Формат: /adduser 123456789 manager Иван');
    }
    const tg = parseInt(parts[0]!, 10);
    const role = parseRole(parts[1]!);
    const name = parts.slice(2).join(' ');
    if (!role || Number.isNaN(tg)) return ctx.reply('Неверные данные');
    await setUser(tg, name, role);
    await ctx.reply(`Ок. Пользователь ${tg} — ${role}, ${name}`);
  });

  bot.on('callback_query', async (ctx) => {
    const q = ctx.callbackQuery;
    if (!q || !('data' in q) || !q.data) return;
    const d = q.data;
    const uid = ctx.from?.id;
    if (!uid) return;
    try {
      await ctx.answerCbQuery();

      if (d.startsWith('atz_br:')) {
        const s = sess(uid);
        if (s.key !== 'atz_brand') return;
        s.data.brand = d.replace('atz_br:', '');
        s.key = 'atz_payment';
        return ctx.editMessageText('Форма оплаты:', { reply_markup: payKb().reply_markup });
      }
      if (d.startsWith('atz_pay:')) {
        const s = sess(uid);
        if (s.key !== 'atz_payment') return;
        const p = d.replace('atz_pay:', '') as 'credit' | 'cash' | 'tradein';
        s.data.payment = p;
        s.key = 'atz_budget';
        return ctx.editMessageText('Введите бюджет (текст или сумма):');
      }
      if (d === 'atz_yes' || d === 'atz_no') {
        const s = sess(uid);
        if (s.key !== 'atz_confirm') return;
        if (d === 'atz_no') {
          sess(uid).key = 'idle';
          return ctx.editMessageText('Отмена.');
        }
        const u = await getUser(uid);
        if (!u || (u.role !== 'atz' && u.role !== 'admin' && u.role !== 'manager')) {
          return ctx.editMessageText('Нет прав (нужен АТЗ, менеджер или админ).');
        }
        const m = await getNextManagerTelegramId();
        if (!m) {
          return ctx.editMessageText('Нет менеджеров в системе. Добавьте manager через /adduser.');
        }
        const leadId = await createLead(
          {
            fio: String(s.data.fio),
            phone: String(s.data.phone),
            brand: String(s.data.brand),
            payment: s.data.payment as 'credit' | 'cash' | 'tradein',
            budget: String(s.data.budget),
            createdBy: uid,
          },
          m,
        );
        sess(uid).key = 'idle';
        await ctx.editMessageText(`✅ Клиент зарегистрирован, лид #${leadId} назначен менеджеру ${m}`);
        const text =
          `🔔 Новый лид #${leadId}\n` +
          `ФИО: ${s.data.fio}\nТелефон: ${s.data.phone}\n` +
          `Бренд: ${s.data.brand}\nБюджет: ${s.data.budget}`;
        try {
          const kb = leadActionsKb(leadId);
          await ctx.telegram.sendMessage(m, text, { reply_markup: kb.reply_markup });
        } catch { /* */ }
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
    if (s.key === 'atz_budget') {
      s.data.budget = text;
      s.key = 'atz_confirm';
      {
        const confirm = Markup.inlineKeyboard([
          [Markup.button.callback('✅ Да', 'atz_yes')],
          [Markup.button.callback('❌ Нет', 'atz_no')],
        ]);
        return ctx.reply(
          `Сводка:\nФИО: ${s.data.fio}\nТел: ${s.data.phone}\nБренд: ${s.data.brand}\n` +
            `Оплата: ${s.data.payment}\nБюджет: ${text}\n\nПередать менеджеру?`,
          { reply_markup: confirm.reply_markup },
        );
      }
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
        await ctx.reply(`✅ Клиент передан. Новый ответственный: ${r.newManager}`);
        const msg = `🔄 Вам передан лид #${s.data.leadId}\nОт: ${uid}\n` + `Комментарий: ${text}`;
        try {
          const kb = leadActionsKb(String(s.data.leadId));
          await ctx.telegram.sendMessage(r.newManager, msg, { reply_markup: kb.reply_markup });
        } catch { /* */ }
      } catch (e) {
        await ctx.reply(e === 'object' && e && (e as { message?: string }).message === 'NO_MANAGERS' ? 'Нет менеджеров' : 'Ошибка передачи');
      }
      return;
    }

    // «Новый клиент» / «Зарегистрировать» — одна воронка (ФИО → телефон → …). Клавиатура с «➕» у manager и admin,
    // но раньше срабатывало только для manager — у admin нажатие молча игнорировалось.
    if (text === '👤 Зарегистрировать клиента' || text === '➕ Новый клиент') {
      const u = await getUser(uid);
      if (!u || (u.role !== 'atz' && u.role !== 'admin' && u.role !== 'manager')) {
        return ctx.reply('Нет прав.');
      }
      s.key = 'atz_fio';
      s.data = {};
      return ctx.reply('Введите ФИО клиента:');
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
    if (text === '📊 Моя статистика' || (text === '📊 Статистика' && (await getUser(uid))?.role === 'rop')) {
      const u = await getUser(uid);
      const n = await countToday();
      if (u?.role === 'rop') {
        return ctx.reply(`Сегодня (все лиды в боте): ${n} нов.`);
      }
      const mine = (await listMyLeads(uid)).length;
      return ctx.reply(`Ваши активные в списке: ${mine}\nСегодня (все): ${n} нов.`);
    }
    if (text === '📋 Клиенты за сегодня' && (await getUser(uid))?.role === 'atz') {
      return ctx.reply(`Сегодня: ${await countToday()} заявок (все ltb-лиды).`);
    }
    if (text === '⚙️ Помощь' || text === '/help') {
      return ctx.reply('Помощь: @админ, README в репозитории asterauto-crm-bot');
    }
    if (text === '🏠 Главное' || text === 'Главное' || text === 'Главное') {
      return sendMain(ctx, uid);
    }
  });

  setInterval(() => {
    runSlaBot(bot).catch(() => null);
  }, config.pollerIntervalMs);

  const me = await bot.telegram.getMe();
  // eslint-disable-next-line no-console
  console.log('Telegram:', '@' + (me.username || '?'), '| Firebase:', getActiveFirebaseProjectId());

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
