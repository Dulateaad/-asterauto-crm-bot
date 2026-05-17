import { getPool } from '../db';
import { normalizeBrand } from '../brands';

export type BuyerContactDoc = {
  telegramId: number;
  fio: string;
  phone: string;
  brands: string[];
  marketingOptIn: boolean;
  createdAt: Date;
  updatedAt: Date;
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
  const pool = getPool();
  const { rows: prevRows } = await pool.query<{ brands: string[] }>(
    `SELECT brands FROM ltb_buyer_contacts WHERE telegram_id = $1`,
    [input.telegramId],
  );
  const prevBrands = prevRows[0]?.brands || [];
  const mergedBrands = uniqBrands([...prevBrands, ...input.brands]);

  await pool.query(
    `INSERT INTO ltb_buyer_contacts (telegram_id, fio, phone, brands, marketing_opt_in, last_lead_id, updated_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, now())
     ON CONFLICT (telegram_id) DO UPDATE SET
       fio = EXCLUDED.fio,
       phone = EXCLUDED.phone,
       brands = EXCLUDED.brands,
       marketing_opt_in = EXCLUDED.marketing_opt_in,
       last_lead_id = COALESCE(EXCLUDED.last_lead_id, ltb_buyer_contacts.last_lead_id),
       updated_at = now()`,
    [
      input.telegramId,
      input.fio.trim(),
      input.phone.trim(),
      mergedBrands,
      input.marketingOptIn,
      input.lastLeadId ?? null,
    ],
  );
}

export async function appendBrandsToBuyer(telegramId: number, extra: string[]): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ brands: string[] }>(
    `SELECT brands FROM ltb_buyer_contacts WHERE telegram_id = $1`,
    [telegramId],
  );
  const prev = rows[0];
  if (!prev) return;
  const brands = uniqBrands([...(prev.brands || []), ...extra]);
  await pool.query(`UPDATE ltb_buyer_contacts SET brands = $2::text[], updated_at = now() WHERE telegram_id = $1`, [
    telegramId,
    brands,
  ]);
}

/** Все telegram_id покупателей из ltb_buyer_contacts (для рассылки админом). */
export async function listAllBuyerTelegramIds(limit = 3000): Promise<number[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ telegram_id: string }>(
    `SELECT telegram_id FROM ltb_buyer_contacts ORDER BY updated_at DESC NULLS LAST, telegram_id LIMIT $1`,
    [limit],
  );
  return rows.map((r) => parseInt(r.telegram_id, 10)).filter((n) => Number.isFinite(n));
}

export async function listMarketingRecipientsForBrand(brand: string): Promise<number[]> {
  const b = normalizeBrand(brand).toLowerCase();
  const pool = getPool();
  const { rows } = await pool.query<{ telegram_id: string; brands: string[] }>(
    `SELECT telegram_id, brands FROM ltb_buyer_contacts WHERE marketing_opt_in = true LIMIT 500`,
  );
  const out: number[] = [];
  for (const r of rows) {
    const brands = r.brands || [];
    if (brands.some((x) => normalizeBrand(x).toLowerCase() === b)) {
      out.push(parseInt(r.telegram_id, 10));
    }
  }
  return out;
}
