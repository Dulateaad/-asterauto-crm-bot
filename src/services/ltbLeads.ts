import { getPool } from '../db';
import type { LeadStatus, TransferReasonId, TransferTargetId } from '../types';
import { getNextManagerTelegramId } from './ltbUsers';
import { normalizeBrand } from '../brands';

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
  createdAt: Date;
  lastAssignedAt?: Date;
  updatedAt: Date;
  firstContactAt: Date | null;
  meetingAt: Date | null;
  lostReason: string | null;
  sla15Sent: boolean;
  sla30Sent: boolean;
  transferredOutCount: number;
  buyerTelegramId?: number;
  buyerSurveyVisitPending?: boolean;
  buyerSurveyVisitSent?: boolean;
  buyerSurveyComplete?: boolean;
  buyerSurvey?: {
    visit?: CustomerVisitRating;
    manager?: CustomerManagerRating;
    wantOtherBrands?: boolean;
    otherBrands?: string[];
    updatedAt?: string;
  };
}

type LeadRow = {
  id: string;
  fio: string;
  phone: string;
  brand: string;
  payment: string;
  budget: string;
  status: string;
  created_by: string;
  assigned_to: string;
  comment: string;
  created_at: Date;
  updated_at: Date;
  last_assigned_at: Date;
  first_contact_at: Date | null;
  meeting_at: Date | null;
  lost_reason: string | null;
  sla15_sent: boolean;
  sla30_sent: boolean;
  transferred_out_count: number | string;
  buyer_telegram_id: string | null;
  buyer_survey_visit_pending: boolean;
  buyer_survey_visit_sent: boolean;
  buyer_survey_complete: boolean;
  buyer_survey: Record<string, unknown>;
};

function rowToLead(r: LeadRow): LeadDoc & { id: string } {
  const buyerSurveyRaw = r.buyer_survey && typeof r.buyer_survey === 'object' ? r.buyer_survey : {};
  const buyerSurvey =
    Object.keys(buyerSurveyRaw).length > 0 ? (buyerSurveyRaw as LeadDoc['buyerSurvey']) : undefined;
  const base: LeadDoc & { id: string } = {
    id: r.id,
    fio: r.fio,
    phone: r.phone,
    brand: r.brand,
    payment: r.payment as LeadDoc['payment'],
    budget: r.budget,
    status: r.status as LeadStatus,
    createdBy: Number(r.created_by),
    assignedTo: Number(r.assigned_to),
    comment: r.comment,
    createdAt: r.created_at,
    lastAssignedAt: r.last_assigned_at,
    updatedAt: r.updated_at,
    firstContactAt: r.first_contact_at,
    meetingAt: r.meeting_at,
    lostReason: r.lost_reason,
    sla15Sent: r.sla15_sent,
    sla30Sent: r.sla30_sent,
    transferredOutCount: Number(r.transferred_out_count) || 0,
  };
  if (r.buyer_telegram_id != null) {
    const bt = Number(r.buyer_telegram_id);
    if (Number.isFinite(bt)) {
      base.buyerTelegramId = bt;
      base.buyerSurveyVisitPending = r.buyer_survey_visit_pending;
      base.buyerSurveyVisitSent = r.buyer_survey_visit_sent;
      base.buyerSurveyComplete = r.buyer_survey_complete;
      if (buyerSurvey) base.buyerSurvey = buyerSurvey;
    }
  }
  return base;
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
  assignTo: number,
): Promise<string> {
  const pool = getPool();
  const buyerTg = data.buyerTelegramId;
  const hasBuyer = buyerTg != null && Number.isFinite(buyerTg);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ltb_leads (
       fio, phone, brand, payment, budget, status, created_by, assigned_to, comment,
       first_contact_at, meeting_at, lost_reason,
       buyer_telegram_id, buyer_survey_visit_pending, buyer_survey_visit_sent, buyer_survey_complete, buyer_survey
     ) VALUES (
       $1, $2, $3, $4, $5, 'new', $6, $7, $8,
       NULL, NULL, NULL,
       $9, $10, $11, $12, $13::jsonb
     ) RETURNING id`,
    [
      data.fio,
      data.phone,
      data.brand,
      data.payment,
      data.budget || '',
      data.createdBy,
      assignTo,
      data.comment || '',
      hasBuyer ? buyerTg : null,
      hasBuyer,
      false,
      false,
      '{}',
    ],
  );
  return rows[0]!.id;
}

export async function countLeadsByBrandSince(since: Date): Promise<Map<string, number>> {
  const pool = getPool();
  const { rows } = await pool.query<{ brand: string; c: string }>(
    `SELECT brand, COUNT(*)::text AS c FROM ltb_leads WHERE created_at >= $1 GROUP BY brand`,
    [since],
  );
  const m = new Map<string, number>();
  for (const r of rows) {
    m.set(normalizeBrand(String(r.brand || '—')), parseInt(r.c, 10));
  }
  return m;
}

export async function getLead(id: string) {
  const pool = getPool();
  const { rows } = await pool.query<LeadRow>(`SELECT * FROM ltb_leads WHERE id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  return rowToLead(r);
}

export async function listMyLeads(managerTg: number) {
  const pool = getPool();
  const { rows } = await pool.query<LeadRow>(
    `SELECT * FROM ltb_leads WHERE assigned_to = $1 ORDER BY created_at DESC LIMIT 50`,
    [managerTg],
  );
  return rows.map(rowToLead);
}

export function slaClockMillis(L: LeadDoc & { id?: string }): number {
  const la = L.lastAssignedAt;
  const t = la ?? L.createdAt;
  return t instanceof Date ? t.getTime() : new Date(t as string).getTime();
}

export async function listLeadsNeedingSla() {
  const pool = getPool();
  const { rows } = await pool.query<LeadRow>(
    `SELECT * FROM ltb_leads WHERE status = 'new' AND first_contact_at IS NULL LIMIT 200`,
  );
  return rows.map(rowToLead);
}

export async function markFirstContact(leadId: string) {
  const pool = getPool();
  await pool.query(
    `UPDATE ltb_leads SET first_contact_at = now(), status = 'contacted', updated_at = now() WHERE id = $1`,
    [leadId],
  );
}

export async function setSlaFlags(leadId: string, sla15: boolean, sla30: boolean) {
  const pool = getPool();
  if (sla15 && sla30) {
    await pool.query(
      `UPDATE ltb_leads SET sla15_sent = true, sla30_sent = true, updated_at = now() WHERE id = $1`,
      [leadId],
    );
  } else if (sla15) {
    await pool.query(`UPDATE ltb_leads SET sla15_sent = true, updated_at = now() WHERE id = $1`, [leadId]);
  } else if (sla30) {
    await pool.query(`UPDATE ltb_leads SET sla30_sent = true, updated_at = now() WHERE id = $1`, [leadId]);
  } else {
    await pool.query(`UPDATE ltb_leads SET updated_at = now() WHERE id = $1`, [leadId]);
  }
}

export async function updateLeadStatus(leadId: string, status: LeadStatus) {
  const pool = getPool();
  await pool.query(`UPDATE ltb_leads SET status = $2, updated_at = now() WHERE id = $1`, [leadId, status]);
}

export async function addNote(leadId: string, line: string) {
  const pool = getPool();
  await pool.query(
    `UPDATE ltb_leads SET comment = CASE WHEN comment = '' THEN $2 ELSE comment || E'\\n' || $2 END, updated_at = now() WHERE id = $1`,
    [leadId, line],
  );
}

export async function recordTransfer(
  leadId: string,
  fromTg: number,
  reason: TransferReasonId,
  target: TransferTargetId,
  comment: string,
) {
  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: leadRows } = await c.query<LeadRow>(`SELECT * FROM ltb_leads WHERE id = $1 FOR UPDATE`, [leadId]);
    const leadSnap = leadRows[0];
    if (!leadSnap) throw new Error('NO_LEAD');
    const brand = String(leadSnap.brand || '');
    const newManager = await getNextManagerTelegramId(brand, c);
    if (!newManager) {
      throw new Error('NO_MANAGERS');
    }
    const prev = leadSnap.comment || '';
    const transferNote = `Передача: ${reason} → ${target}. ${comment}`;
    const newComment = prev ? `${prev}\n\n${transferNote}` : transferNote;

    await c.query(
      `UPDATE ltb_leads SET
         comment = $2,
         assigned_to = $3,
         status = 'new',
         transferred_out_count = transferred_out_count + 1,
         last_assigned_at = now(),
         sla15_sent = false,
         sla30_sent = false,
         updated_at = now()
       WHERE id = $1`,
      [leadId, newComment, newManager],
    );
    await c.query(
      `INSERT INTO ltb_transfers (lead_id, from_telegram_id, to_telegram_id, reason, target, comment)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [leadId, fromTg, newManager, reason, target, comment],
    );
    await c.query('COMMIT');
    return { newManager };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function countLeadsSince(since: Date) {
  const pool = getPool();
  const { rows } = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM ltb_leads WHERE created_at >= $1`,
    [since],
  );
  return parseInt(rows[0]?.c || '0', 10);
}

export async function countToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return countLeadsSince(d);
}

function localDayStartMidnight(daysAgoFromToday: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgoFromToday);
  return d;
}

export async function countLeadsCreatedBetween(start: Date, endExclusive: Date): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM ltb_leads WHERE created_at >= $1 AND created_at < $2`,
    [start, endExclusive],
  );
  return parseInt(rows[0]?.c || '0', 10);
}

export async function countLeadsOnLocalCalendarDay(daysAgo: number): Promise<number> {
  const start = localDayStartMidnight(daysAgo);
  const endExclusive = localDayStartMidnight(daysAgo - 1);
  return countLeadsCreatedBetween(start, endExclusive);
}

export async function countLeadsOnLocalDayForAssignedPool(
  assignedTgIds: Set<number>,
  daysAgo: number,
  _scanLimit = 800,
): Promise<number> {
  if (assignedTgIds.size === 0) return 0;
  const start = localDayStartMidnight(daysAgo);
  const endExclusive = localDayStartMidnight(daysAgo - 1);
  const pool = getPool();
  const ids = Array.from(assignedTgIds);
  const { rows } = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM ltb_leads
     WHERE created_at >= $1 AND created_at < $2 AND assigned_to = ANY($3::bigint[])`,
    [start, endExclusive, ids],
  );
  return parseInt(rows[0]?.c || '0', 10);
}

export async function countLeadsSinceForAssignedPool(
  assignedTgIds: Set<number>,
  since: Date,
  _scanLimit = 600,
): Promise<number> {
  if (assignedTgIds.size === 0) return 0;
  const pool = getPool();
  const ids = Array.from(assignedTgIds);
  const { rows } = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM ltb_leads WHERE created_at >= $1 AND assigned_to = ANY($2::bigint[])`,
    [since, ids],
  );
  return parseInt(rows[0]?.c || '0', 10);
}

export async function countAllLeads(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ltb_leads`);
  return parseInt(rows[0]?.c || '0', 10);
}

export async function countLeadsAssignedTo(managerTg: number): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM ltb_leads WHERE assigned_to = $1`,
    [managerTg],
  );
  return parseInt(rows[0]?.c || '0', 10);
}

export async function listLeadsNeedingBuyerSurveyVisit(
  minAgeMs: number,
): Promise<(LeadDoc & { id: string })[]> {
  const pool = getPool();
  const { rows } = await pool.query<LeadRow>(
    `SELECT * FROM ltb_leads
     WHERE buyer_survey_visit_pending = true
       AND buyer_survey_visit_sent = false
       AND buyer_telegram_id IS NOT NULL
       AND (EXTRACT(EPOCH FROM (now() - created_at)) * 1000) >= $1
     LIMIT 200`,
    [minAgeMs],
  );
  return rows.map(rowToLead);
}

export async function markBuyerSurveyVisitSent(leadId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE ltb_leads SET buyer_survey_visit_sent = true, updated_at = now() WHERE id = $1`,
    [leadId],
  );
}

export async function patchBuyerSurvey(
  leadId: string,
  patch: Partial<NonNullable<LeadDoc['buyerSurvey']>>,
  options?: { complete?: boolean },
): Promise<void> {
  const pool = getPool();
  const cur = await getLead(leadId);
  if (!cur) return;
  const prev = cur.buyerSurvey || {};
  const next = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await pool.query(
    `UPDATE ltb_leads SET
       buyer_survey = $2::jsonb,
       updated_at = now(),
       buyer_survey_visit_pending = CASE WHEN $3 THEN false ELSE buyer_survey_visit_pending END,
       buyer_survey_complete = CASE WHEN $3 THEN true ELSE buyer_survey_complete END
     WHERE id = $1`,
    [leadId, JSON.stringify(next), options?.complete === true],
  );
}
