import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { C, SETTINGS_DOC } from '../collections';
import { config } from '../config';
import { getDb } from '../firebase';
import { normalizeBrand } from '../brands';
import type { UserRole } from '../types';

const db = () => getDb();

export type LtbUserDoc = {
  id: string;
  name: string;
  role: UserRole;
  active: boolean;
  /**
   * Для manager: если задано и не пусто — лид только по этим брендам; иначе менеджер в пуле «на все бренды».
   * Для rop / atz (админ зала) / admin: только в профиле; очередь лидов (`getNextManagerTelegramId`) — только manager.
   */
  brands?: string[];
};

export async function getUser(telegramId: number): Promise<LtbUserDoc | null> {
  const ref = db().collection(C.users).doc(String(telegramId));
  const s = await ref.get();
  if (!s.exists) return null;
  return { id: s.id, ...s.data() } as LtbUserDoc;
}

export async function setUser(
  telegramId: number,
  name: string,
  role: UserRole,
  brands?: string[],
): Promise<void> {
  const ref = db().collection(C.users).doc(String(telegramId));
  const now = Timestamp.now();
  const prev = await ref.get();
  const payload: Record<string, unknown> = {
    name,
    role,
    active: true,
    updatedAt: now,
    createdAt: prev.exists ? (prev.data()?.createdAt as Timestamp) : now,
  };
  if (brands !== undefined) {
    if (brands.length === 0) {
      payload.brands = FieldValue.delete();
    } else {
      payload.brands = brands.map((b) => normalizeBrand(b));
    }
  }
  await ref.set(payload, { merge: true });
}

export async function listActiveManagers(): Promise<number[]> {
  const q = await db()
    .collection(C.users)
    .where('role', '==', 'manager')
    .where('active', '==', true)
    .get();
  return q.docs.map((d) => parseInt(d.id, 10));
}

async function listActiveManagerDocs(): Promise<LtbUserDoc[]> {
  const q = await db()
    .collection(C.users)
    .where('role', '==', 'manager')
    .where('active', '==', true)
    .get();
  return q.docs.map((d) => ({ id: d.id, ...d.data() }) as LtbUserDoc);
}

/**
 * Назначение менеджера на лид по бренду.
 * 1) Только менеджеры, у кого в `brands` есть этот бренд (round-robin внутри группы).
 * 2) Иначе — менеджеры без списка брендов («универсальные»).
 * 3) Иначе — все активные менеджеры (как раньше).
 */
export async function getNextManagerTelegramId(leadBrand: string): Promise<number | null> {
  const brand = normalizeBrand(leadBrand);
  const all = await listActiveManagerDocs();
  if (all.length === 0) return null;

  const ids = (list: LtbUserDoc[]) => list.map((u) => parseInt(u.id, 10));

  const explicit = all.filter((u) => {
    const b = u.brands;
    if (!b || b.length === 0) return false;
    return b.some((x) => normalizeBrand(x) === brand);
  });
  const wildcard = all.filter((u) => !u.brands || u.brands.length === 0);

  let pool: number[];
  let rrKey: string;
  if (explicit.length > 0) {
    pool = ids(explicit);
    rrKey = `b:${brand}`;
  } else if (wildcard.length > 0) {
    pool = ids(wildcard);
    rrKey = '_wildcard';
  } else {
    return null;
  }

  const sref = db().collection(C.settings).doc(SETTINGS_DOC);
  const snap = await sref.get();
  const map = ((snap.data()?.lastManagerIdxByBrand as Record<string, number>) || {}) as Record<string, number>;
  let idx = map[rrKey] ?? 0;
  const pick = pool[idx % pool.length]!;
  idx = (idx + 1) % Math.max(1, pool.length);
  await sref.set(
    {
      lastManagerIdxByBrand: { ...map, [rrKey]: idx },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return pick;
}

export function isAdmin(telegramId: number): boolean {
  return config.adminIds.includes(telegramId);
}

export function ropTelegramIdsFromEnv(): number[] {
  return config.ropIds;
}
