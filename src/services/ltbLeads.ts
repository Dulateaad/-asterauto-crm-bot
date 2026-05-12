import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { C } from '../collections';
import { getDb } from '../firebase';
import type { LeadStatus, TransferReasonId, TransferTargetId } from '../types';
import { getNextManagerTelegramId } from './ltbUsers';
import { normalizeBrand } from '../brands';

const db = () => getDb();

export type CustomerVisitRating = 'good' | 'ok' | 'bad';
export type CustomerManagerRating = 'yes' | 'partial' | 'no';

export interface LeadDoc {
  fio: string;
  phone: string;
  brand: string;
  payment: 'credit' | 'cash' | 'tradein';
  budget: string;
  status: LeadStatus;
  createdBy: number;
  assignedTo: number;
  comment: string;
  createdAt: Timestamp;
  /** Если нет (старые лиды) — для SLA используется createdAt */
  lastAssignedAt?: Timestamp;
  updatedAt: Timestamp;
  firstContactAt: Timestamp | null;
  meetingAt: Timestamp | null;
  lostReason: string | null;
  sla15Sent: boolean;
  sla30Sent: boolean;
  transferredOutCount: number;
  /** Заявка из Telegram от покупателя — для опроса и рассылок */
  buyerTelegramId?: number;
  /** Опрос «как прошло» ещё не отправлен */
  buyerSurveyVisitPending?: boolean;
  /** Первый вопрос опроса уже отправлен покупателю */
  buyerSurveyVisitSent?: boolean;
  /** Опрос завершён (все шаги или отказ) */
  buyerSurveyComplete?: boolean;
  buyerSurvey?: {
    visit?: CustomerVisitRating;
    manager?: CustomerManagerRating;
    wantOtherBrands?: boolean;
    otherBrands?: string[];
    updatedAt?: Timestamp;
  };
}

export async function createLead(
  data: Omit<
    LeadDoc,
    | 'createdAt'
    | 'updatedAt'
    | 'lastAssignedAt'
    | 'meetingAt'
    | 'lostReason'
    | 'sla15Sent'
    | 'sla30Sent'
    | 'transferredOutCount'
    | 'firstContactAt'
    | 'status'
    | 'assignedTo'
    | 'comment'
    | 'buyerTelegramId'
    | 'buyerSurveyVisitPending'
    | 'buyerSurveyVisitSent'
    | 'buyerSurveyComplete'
    | 'buyerSurvey'
  > & { comment?: string; buyerTelegramId?: number },
  assignTo: number
): Promise<string> {
  const now = Timestamp.now();
  const buyerTg = data.buyerTelegramId;
  const ref = await db().collection(C.leads).add({
    ...data,
    status: 'new' as const,
    assignedTo: assignTo,
    comment: data.comment || '',
    createdAt: now,
    lastAssignedAt: now,
    updatedAt: now,
    firstContactAt: null,
    meetingAt: null,
    lostReason: null,
    sla15Sent: false,
    sla30Sent: false,
    transferredOutCount: 0,
    ...(buyerTg != null && Number.isFinite(buyerTg)
      ? {
          buyerTelegramId: buyerTg,
          buyerSurveyVisitPending: true,
          buyerSurveyVisitSent: false,
          buyerSurveyComplete: false,
          buyerSurvey: {},
        }
      : {}),
  } satisfies LeadDoc);
  return ref.id;
}

export async function countLeadsByBrandSince(since: Timestamp): Promise<Map<string, number>> {
  const q = await db().collection(C.leads).where('createdAt', '>=', since).limit(500).get();
  const m = new Map<string, number>();
  for (const d of q.docs) {
    const b = normalizeBrand(String((d.data() as LeadDoc).brand || '—'));
    m.set(b, (m.get(b) || 0) + 1);
  }
  return m;
}

export async function getLead(id: string) {
  const s = await db().collection(C.leads).doc(id).get();
  if (!s.exists) return null;
  return { id: s.id, ...(s.data() as LeadDoc) };
}

export async function listMyLeads(managerTg: number) {
  const q = await db()
    .collection(C.leads)
    .where('assignedTo', '==', managerTg)
    .limit(50)
    .get();
  const rows = q.docs.map((d) => ({ id: d.id, ...(d.data() as LeadDoc) }));
  return rows.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
}

/** Для SLA: от последнего назначения (после передачи — новый отсчёт 15/30 мин). */
export function slaClockMillis(L: LeadDoc & { id?: string }): number {
  const la = (L as LeadDoc).lastAssignedAt;
  return (la ?? L.createdAt).toMillis();
}

export async function listLeadsNeedingSla() {
  const q = await db().collection(C.leads).where('status', '==', 'new').limit(200).get();
  return q.docs
    .map((d) => ({ id: d.id, ...(d.data() as LeadDoc) }))
    .filter((L) => L.firstContactAt == null);
}

export async function markFirstContact(leadId: string) {
  await db()
    .collection(C.leads)
    .doc(leadId)
    .update({
      firstContactAt: FieldValue.serverTimestamp(),
      status: 'contacted',
      updatedAt: FieldValue.serverTimestamp(),
    });
}

export async function setSlaFlags(leadId: string, sla15: boolean, sla30: boolean) {
  const u: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (sla15) u.sla15Sent = true;
  if (sla30) u.sla30Sent = true;
  await db().collection(C.leads).doc(leadId).update(u);
}

export async function updateLeadStatus(leadId: string, status: LeadStatus) {
  await db()
    .collection(C.leads)
    .doc(leadId)
    .update({ status, updatedAt: FieldValue.serverTimestamp() });
}

export async function addNote(leadId: string, line: string) {
  const ref = db().collection(C.leads).doc(leadId);
  const s = await ref.get();
  const cur = (s.data()?.comment as string) || '';
  await ref.update({
    comment: cur ? `${cur}\n${line}` : line,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function recordTransfer(
  leadId: string,
  fromTg: number,
  reason: TransferReasonId,
  target: TransferTargetId,
  comment: string
) {
  const leadRef = db().collection(C.leads).doc(leadId);
  const leadSnap = await leadRef.get();
  if (!leadSnap.exists) throw new Error('NO_LEAD');
  const brand = String((leadSnap.data() as LeadDoc)?.brand || '');
  const newManager = await getNextManagerTelegramId(brand);
  if (!newManager) {
    throw new Error('NO_MANAGERS');
  }
  const prev = (leadSnap.data()?.comment as string) || '';
  const transferNote = `Передача: ${reason} → ${target}. ${comment}`;
  const newComment = prev ? `${prev}\n\n${transferNote}` : transferNote;

  const batch = db().batch();
  batch.update(leadRef, {
    comment: newComment,
    assignedTo: newManager,
    status: 'new',
    transferredOutCount: FieldValue.increment(1),
    lastAssignedAt: FieldValue.serverTimestamp(),
    sla15Sent: false,
    sla30Sent: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const trRef = db().collection(C.transfers).doc();
  batch.set(trRef, {
    leadId,
    fromTelegramId: fromTg,
    reason,
    target,
    comment,
    toTelegramId: newManager,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { newManager };
}

export async function countLeadsSince(since: Timestamp) {
  const q = await db().collection(C.leads).where('createdAt', '>=', since).get();
  return q.size;
}

export async function countToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return countLeadsSince(Timestamp.fromDate(d));
}

/** Границы локального календарного дня (как countToday): daysAgo 0 = сегодня 00:00, 1 = вчера 00:00 */
function localDayStartMidnight(daysAgoFromToday: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgoFromToday);
  return d;
}

export async function countLeadsCreatedBetween(start: Timestamp, endExclusive: Timestamp): Promise<number> {
  const q = await db()
    .collection(C.leads)
    .where('createdAt', '>=', start)
    .where('createdAt', '<', endExclusive)
    .get();
  return q.size;
}

/** Лиды, созданные за полные локальные сутки. daysAgo: 1 = вчера, 2 = позавчера */
export async function countLeadsOnLocalCalendarDay(daysAgo: number): Promise<number> {
  const start = localDayStartMidnight(daysAgo);
  const endExclusive = localDayStartMidnight(daysAgo - 1);
  return countLeadsCreatedBetween(Timestamp.fromDate(start), Timestamp.fromDate(endExclusive));
}

/** Как countLeadsOnLocalCalendarDay, но только лиды, назначенные на менеджеров из пула (лимит скана). */
export async function countLeadsOnLocalDayForAssignedPool(
  assignedTgIds: Set<number>,
  daysAgo: number,
  scanLimit = 800,
): Promise<number> {
  if (assignedTgIds.size === 0) return 0;
  const start = localDayStartMidnight(daysAgo);
  const endExclusive = localDayStartMidnight(daysAgo - 1);
  const q = await db()
    .collection(C.leads)
    .where('createdAt', '>=', Timestamp.fromDate(start))
    .where('createdAt', '<', Timestamp.fromDate(endExclusive))
    .limit(scanLimit)
    .get();
  let n = 0;
  for (const d of q.docs) {
    if (assignedTgIds.has((d.data() as LeadDoc).assignedTo)) n++;
  }
  return n;
}

/** Лиды с createdAt >= since, у которых assignedTo входит в отдел (скан ограничен). */
export async function countLeadsSinceForAssignedPool(
  assignedTgIds: Set<number>,
  since: Timestamp,
  scanLimit = 600,
): Promise<number> {
  if (assignedTgIds.size === 0) return 0;
  const q = await db().collection(C.leads).where('createdAt', '>=', since).limit(scanLimit).get();
  let n = 0;
  for (const d of q.docs) {
    const a = (d.data() as LeadDoc).assignedTo;
    if (assignedTgIds.has(a)) n++;
  }
  return n;
}

export async function countAllLeads(): Promise<number> {
  const snap = await db().collection(C.leads).count().get();
  return snap.data().count;
}

/** Сколько лидов сейчас назначено на менеджера (все статусы). */
export async function countLeadsAssignedTo(managerTg: number): Promise<number> {
  const snap = await db().collection(C.leads).where('assignedTo', '==', managerTg).count().get();
  return snap.data().count;
}

/** Лиды покупателей из Telegram, которым пора отправить первый вопрос опроса. */
export async function listLeadsNeedingBuyerSurveyVisit(
  minAgeMs: number,
): Promise<(LeadDoc & { id: string })[]> {
  const q = await db().collection(C.leads).where('buyerSurveyVisitPending', '==', true).limit(200).get();
  const now = Date.now();
  return q.docs
    .map((d) => ({ id: d.id, ...(d.data() as LeadDoc) }))
    .filter((L) => {
      if (L.buyerSurveyVisitSent) return false;
      if (L.buyerTelegramId == null || !Number.isFinite(L.buyerTelegramId)) return false;
      return now - L.createdAt.toMillis() >= minAgeMs;
    });
}

export async function markBuyerSurveyVisitSent(leadId: string): Promise<void> {
  await db()
    .collection(C.leads)
    .doc(leadId)
    .update({
      buyerSurveyVisitSent: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

export async function patchBuyerSurvey(
  leadId: string,
  patch: Partial<NonNullable<LeadDoc['buyerSurvey']>>,
  options?: { complete?: boolean },
): Promise<void> {
  const ref = db().collection(C.leads).doc(leadId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const cur = (snap.data()?.buyerSurvey as LeadDoc['buyerSurvey']) || {};
  const next = { ...cur, ...patch, updatedAt: Timestamp.now() };
  const u: Record<string, unknown> = {
    buyerSurvey: next,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (options?.complete) {
    u.buyerSurveyVisitPending = false;
    u.buyerSurveyComplete = true;
  }
  await ref.update(u);
}
