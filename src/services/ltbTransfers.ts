import { getDb } from '../firebase';
import { C } from '../collections';
import { Timestamp } from 'firebase-admin/firestore';
import type { TransferReasonId, TransferTargetId } from '../types';

const db = () => getDb();

export type TransferDoc = {
  leadId: string;
  fromTelegramId: number;
  toTelegramId: number;
  reason: TransferReasonId;
  target: TransferTargetId;
  comment: string;
  createdAt: Timestamp;
};

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
  const q = await db().collection(C.transfers).orderBy('createdAt', 'desc').limit(limit).get();
  return q.docs.map((d) => ({ id: d.id, ...(d.data() as TransferDoc) }));
}

export async function listTransfersSince(
  since: Timestamp,
  limit = 400,
): Promise<(TransferDoc & { id: string })[]> {
  const q = await db()
    .collection(C.transfers)
    .where('createdAt', '>=', since)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return q.docs.map((d) => ({ id: d.id, ...(d.data() as TransferDoc) }));
}

export function countTransfersFromPool(rows: (TransferDoc & { id: string })[], fromIds: Set<number>): number {
  return rows.reduce((acc, t) => acc + (fromIds.has(t.fromTelegramId) ? 1 : 0), 0);
}

export function countTransfersToPool(rows: (TransferDoc & { id: string })[], toIds: Set<number>): number {
  return rows.reduce((acc, t) => acc + (toIds.has(t.toTelegramId) ? 1 : 0), 0);
}

/** Сколько раз лид попадал к получателю (по последним limit передачам, новые сверху). */
export async function aggregateRecipientCounts(limit = 500): Promise<Map<number, number>> {
  const q = await db().collection(C.transfers).orderBy('createdAt', 'desc').limit(limit).get();
  const m = new Map<number, number>();
  for (const d of q.docs) {
    const to = (d.data() as TransferDoc).toTelegramId;
    m.set(to, (m.get(to) || 0) + 1);
  }
  return m;
}
