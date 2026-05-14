import { getPool } from '../db';
import type { TransferReasonId, TransferTargetId } from '../types';

export type TransferDoc = {
  leadId: string;
  fromTelegramId: number;
  toTelegramId: number;
  reason: TransferReasonId;
  target: TransferTargetId;
  comment: string;
  createdAt: Date;
};

type TransferRow = {
  id: string;
  lead_id: string;
  from_telegram_id: string;
  to_telegram_id: string;
  reason: string;
  target: string;
  comment: string;
  created_at: Date;
};

function rowToTransfer(r: TransferRow): TransferDoc & { id: string } {
  return {
    id: String(r.id),
    leadId: r.lead_id,
    fromTelegramId: Number(r.from_telegram_id),
    toTelegramId: Number(r.to_telegram_id),
    reason: r.reason as TransferReasonId,
    target: r.target as TransferTargetId,
    comment: r.comment,
    createdAt: r.created_at,
  };
}

const REASON_LABEL: Record<TransferReasonId, string> = {
  high_price: 'Высокая цена',
  no_stock: 'Нет наличия',
  brand_dislike: 'Не понравился бренд',
  credit_fail: 'Не прошёл кредит',
  trade_want: 'Хочет обмен',
  need_used: 'Нужен Б/У',
};

const TARGET_LABEL: Record<TransferTargetId, string> = {
  other_brand: 'Другой бренд',
  used: 'Б/У',
  buyout: 'Выкуп',
  finance: 'Фин. отдел',
};

export function transferReasonLabel(id: TransferReasonId): string {
  return REASON_LABEL[id] || id;
}

export function transferTargetLabel(id: TransferTargetId): string {
  return TARGET_LABEL[id] || id;
}

export async function listRecentTransfers(limit = 40): Promise<(TransferDoc & { id: string })[]> {
  const pool = getPool();
  const { rows } = await pool.query<TransferRow>(
    `SELECT * FROM ltb_transfers ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToTransfer);
}

export async function listTransfersSince(since: Date, limit = 400): Promise<(TransferDoc & { id: string })[]> {
  const pool = getPool();
  const { rows } = await pool.query<TransferRow>(
    `SELECT * FROM ltb_transfers WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2`,
    [since, limit],
  );
  return rows.map(rowToTransfer);
}

export function countTransfersFromPool(rows: (TransferDoc & { id: string })[], fromIds: Set<number>): number {
  return rows.reduce((acc, t) => acc + (fromIds.has(t.fromTelegramId) ? 1 : 0), 0);
}

export function countTransfersToPool(rows: (TransferDoc & { id: string })[], toIds: Set<number>): number {
  return rows.reduce((acc, t) => acc + (toIds.has(t.toTelegramId) ? 1 : 0), 0);
}

export async function aggregateRecipientCounts(limit = 500): Promise<Map<number, number>> {
  const pool = getPool();
  const { rows } = await pool.query<{ to_telegram_id: string; c: string }>(
    `SELECT to_telegram_id::text, COUNT(*)::text AS c FROM (
       SELECT to_telegram_id FROM ltb_transfers ORDER BY created_at DESC LIMIT $1
     ) t
     GROUP BY to_telegram_id`,
    [limit],
  );
  const m = new Map<number, number>();
  for (const r of rows) {
    m.set(parseInt(r.to_telegram_id, 10), parseInt(r.c, 10));
  }
  return m;
}

export async function countAllTransfers(): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ltb_transfers`);
  return parseInt(rows[0]?.c || '0', 10);
}

export function filterTransfersInvolvingPool(
  rows: (TransferDoc & { id: string })[],
  pool: Set<number>,
): (TransferDoc & { id: string })[] {
  return rows.filter((t) => pool.has(t.fromTelegramId) || pool.has(t.toTelegramId));
}
