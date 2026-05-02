import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { C, SETTINGS_DOC } from '../collections';
import { config } from '../config';
import { getDb } from '../firebase';
import type { UserRole } from '../types';

const db = () => getDb();

export async function getUser(telegramId: number) {
  const ref = db().collection(C.users).doc(String(telegramId));
  const s = await ref.get();
  if (!s.exists) return null;
  return { id: s.id, ...s.data() } as {
    id: string;
    name: string;
    role: UserRole;
    active: boolean;
  };
}

export async function setUser(
  telegramId: number,
  name: string,
  role: UserRole
): Promise<void> {
  const ref = db().collection(C.users).doc(String(telegramId));
  const now = Timestamp.now();
  const prev = await ref.get();
  await ref.set(
    {
      name,
      role,
      active: true,
      updatedAt: now,
      createdAt: prev.exists ? (prev.data()?.createdAt as Timestamp) : now,
    },
    { merge: true }
  );
}

export async function listActiveManagers(): Promise<number[]> {
  const q = await db()
    .collection(C.users)
    .where('role', '==', 'manager')
    .where('active', '==', true)
    .get();
  return q.docs.map((d) => parseInt(d.id, 10));
}

export async function getNextManagerTelegramId(): Promise<number | null> {
  const managers = await listActiveManagers();
  if (managers.length === 0) return null;
  const sref = db().collection(C.settings).doc(SETTINGS_DOC);
  const snap = await sref.get();
  let idx = (snap.data()?.lastManagerIdx as number) ?? 0;
  const pick = managers[idx % managers.length];
  idx = (idx + 1) % Math.max(1, managers.length);
  await sref.set({ lastManagerIdx: idx, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return pick;
}

export function isAdmin(telegramId: number): boolean {
  return config.adminIds.includes(telegramId);
}

export function ropTelegramIdsFromEnv(): number[] {
  return config.ropIds;
}
