import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { C } from '../collections';
import { getDb } from '../firebase';
import { normalizeBrand } from '../brands';

const db = () => getDb();

export type BuyerContactDoc = {
  telegramId: number;
  fio: string;
  phone: string;
  /** Интересующие бренды (для рассылок) */
  brands: string[];
  marketingOptIn: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastLeadId?: string;
};

function uniqBrands(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const b = normalizeBrand(raw);
    if (!b) continue;
    const k = b.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

export async function upsertBuyerContact(input: {
  telegramId: number;
  fio: string;
  phone: string;
  brands: string[];
  marketingOptIn: boolean;
  lastLeadId?: string;
}): Promise<void> {
  const id = String(input.telegramId);
  const ref = db().collection(C.buyerContacts).doc(id);
  const now = Timestamp.now();
  const snap = await ref.get();
  const prev = snap.exists ? (snap.data() as BuyerContactDoc) : null;
  const mergedBrands = uniqBrands([...(prev?.brands || []), ...input.brands]);
  const payload: Record<string, unknown> = {
    telegramId: input.telegramId,
    fio: input.fio.trim(),
    phone: input.phone.trim(),
    brands: mergedBrands,
    marketingOptIn: input.marketingOptIn,
    updatedAt: now,
    ...(input.lastLeadId ? { lastLeadId: input.lastLeadId } : {}),
  };
  if (!prev) {
    payload.createdAt = now;
  }
  await ref.set(payload, { merge: true });
}

export async function appendBrandsToBuyer(telegramId: number, extra: string[]): Promise<void> {
  const id = String(telegramId);
  const ref = db().collection(C.buyerContacts).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const prev = snap.data() as BuyerContactDoc;
  const brands = uniqBrands([...(prev.brands || []), ...extra]);
  await ref.update({ brands, updatedAt: FieldValue.serverTimestamp() });
}

/** Подписчики с opt-in и брендом в списке (для /notify_brand). */
export async function listMarketingRecipientsForBrand(brand: string): Promise<number[]> {
  const b = normalizeBrand(brand);
  const q = await db().collection(C.buyerContacts).where('marketingOptIn', '==', true).limit(500).get();
  const out: number[] = [];
  for (const d of q.docs) {
    const row = d.data() as BuyerContactDoc;
    const brands = row.brands || [];
    if (brands.some((x) => normalizeBrand(x).toLowerCase() === b.toLowerCase())) {
      out.push(row.telegramId);
    }
  }
  return out;
}
