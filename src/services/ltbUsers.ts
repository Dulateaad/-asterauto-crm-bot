import type { PoolClient } from 'pg';
import { SETTINGS_DOC } from '../collections';
import { config } from '../config';
import { getPool } from '../db';
import { normalizeBrand } from '../brands';
import type { UserRole } from '../types';

export type LtbUserDoc = {
  id: string;
  name: string;
  role: UserRole;
  active: boolean;
  departmentId?: string;
  brands?: string[];
};

type UserRow = {
  telegram_id: string;
  name: string;
  role: string;
  active: boolean;
  department_id: string | null;
  brands: string[] | null;
};

function rowToUser(r: UserRow): LtbUserDoc {
  const id = String(r.telegram_id);
  const brands = r.brands;
  return {
    id,
    name: r.name,
    role: r.role as UserRole,
    active: r.active,
    ...(r.department_id ? { departmentId: r.department_id } : {}),
    ...(brands != null && brands.length > 0 ? { brands } : {}),
  };
}

export function normalizeDepartmentId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);
}

export async function getUser(telegramId: number): Promise<LtbUserDoc | null> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `SELECT telegram_id, name, role, active, department_id, brands FROM ltb_users WHERE telegram_id = $1`,
    [telegramId],
  );
  const r = rows[0];
  return r ? rowToUser(r) : null;
}

export async function setUser(
  telegramId: number,
  name: string,
  role: UserRole,
  brands?: string[],
): Promise<void> {
  const pool = getPool();
  if (brands === undefined) {
    await pool.query(
      `INSERT INTO ltb_users (telegram_id, name, role, active, updated_at)
       VALUES ($1, $2, $3, true, now())
       ON CONFLICT (telegram_id) DO UPDATE SET
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         active = true,
         updated_at = now()`,
      [telegramId, name, role],
    );
    return;
  }
  const bnorm = brands.length === 0 ? null : brands.map((b) => normalizeBrand(b));
  await pool.query(
    `INSERT INTO ltb_users (telegram_id, name, role, active, brands, updated_at)
     VALUES ($1, $2, $3, true, $4, now())
     ON CONFLICT (telegram_id) DO UPDATE SET
       name = EXCLUDED.name,
       role = EXCLUDED.role,
       active = true,
       brands = EXCLUDED.brands,
       updated_at = now()`,
    [telegramId, name, role, bnorm],
  );
}

export async function listActiveManagers(): Promise<number[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ telegram_id: string }>(
    `SELECT telegram_id FROM ltb_users WHERE role = 'manager' AND active = true ORDER BY telegram_id`,
  );
  return rows.map((r) => parseInt(r.telegram_id, 10));
}

export async function listActiveManagersDetailed(): Promise<LtbUserDoc[]> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `SELECT telegram_id, name, role, active, department_id, brands
     FROM ltb_users WHERE role = 'manager' AND active = true ORDER BY telegram_id`,
  );
  return rows.map(rowToUser);
}

async function listActiveManagersDetailedTx(c: PoolClient): Promise<LtbUserDoc[]> {
  const { rows } = await c.query<UserRow>(
    `SELECT telegram_id, name, role, active, department_id, brands
     FROM ltb_users WHERE role = 'manager' AND active = true ORDER BY telegram_id`,
  );
  return rows.map(rowToUser);
}

/**
 * Назначение менеджера на лид по бренду (round-robin в ltb_settings).
 * Если передан `client`, вызывать только внутри уже открытой транзакции (BEGIN).
 */
export async function getNextManagerTelegramId(leadBrand: string, client?: PoolClient): Promise<number | null> {
  if (client) {
    return pickNextManagerInternal(leadBrand, client);
  }
  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await pickNextManagerInternal(leadBrand, c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function pickNextManagerInternal(leadBrand: string, c: PoolClient): Promise<number | null> {
  const brand = normalizeBrand(leadBrand);
  const all = await listActiveManagersDetailedTx(c);
  if (all.length === 0) return null;

  const ids = (list: LtbUserDoc[]) => list.map((u) => parseInt(u.id, 10));

  const explicit = all.filter((u) => {
    const b = u.brands;
    if (!b || b.length === 0) return false;
    return b.some((x) => normalizeBrand(x) === brand);
  });
  const wildcard = all.filter((u) => !u.brands || u.brands.length === 0);

  let poolIds: number[];
  let rrKey: string;
  if (explicit.length > 0) {
    poolIds = ids(explicit);
    rrKey = `b:${brand}`;
  } else if (wildcard.length > 0) {
    poolIds = ids(wildcard);
    rrKey = '_wildcard';
  } else {
    return null;
  }

  const { rows } = await c.query<{ last_manager_idx_by_brand: Record<string, number> }>(
    `SELECT last_manager_idx_by_brand FROM ltb_settings WHERE id = $1 FOR UPDATE`,
    [SETTINGS_DOC],
  );
  const map = { ...(rows[0]?.last_manager_idx_by_brand || {}) } as Record<string, number>;
  let idx = map[rrKey] ?? 0;
  const pick = poolIds[idx % poolIds.length]!;
  idx = (idx + 1) % Math.max(1, poolIds.length);
  map[rrKey] = idx;
  await c.query(
    `UPDATE ltb_settings SET last_manager_idx_by_brand = $2::jsonb, updated_at = now() WHERE id = $1`,
    [SETTINGS_DOC, JSON.stringify(map)],
  );
  return pick;
}

export async function listManagersForBrandPick(leadBrand: string): Promise<LtbUserDoc[]> {
  const brand = normalizeBrand(leadBrand);
  const all = await listActiveManagersDetailed();
  if (all.length === 0) return [];
  const explicit = all.filter((u) => {
    const b = u.brands;
    if (!b || b.length === 0) return false;
    return b.some((x) => normalizeBrand(x) === brand);
  });
  const wildcard = all.filter((u) => !u.brands || u.brands.length === 0);
  const poolList = explicit.length > 0 ? explicit : wildcard.length > 0 ? wildcard : all;
  return poolList.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
}

export async function formatTelegramUserLabel(telegramId: number): Promise<string> {
  const u = await getUser(telegramId);
  const n = u?.name?.trim();
  if (n) return `${n} (${telegramId})`;
  return String(telegramId);
}

export async function formatTelegramShortName(telegramId: number): Promise<string> {
  const u = await getUser(telegramId);
  const n = u?.name?.trim();
  if (n) return n;
  return `сотрудник ${telegramId}`;
}

export async function updateUserDepartment(telegramId: number, departmentId: string | null): Promise<void> {
  const pool = getPool();
  const chk = await pool.query(`SELECT 1 FROM ltb_users WHERE telegram_id = $1`, [telegramId]);
  if (!chk.rowCount) throw new Error('NO_USER_DOC');
  if (!departmentId) {
    await pool.query(
      `UPDATE ltb_users SET department_id = NULL, updated_at = now() WHERE telegram_id = $1`,
      [telegramId],
    );
    return;
  }
  await pool.query(
    `UPDATE ltb_users SET department_id = $2, updated_at = now() WHERE telegram_id = $1`,
    [telegramId, normalizeDepartmentId(departmentId)],
  );
}

export async function patchUserBrands(telegramId: number, brands: string[] | 'all'): Promise<void> {
  const pool = getPool();
  const chk = await pool.query(`SELECT 1 FROM ltb_users WHERE telegram_id = $1`, [telegramId]);
  if (!chk.rowCount) throw new Error('NO_USER_DOC');
  if (brands === 'all') {
    await pool.query(`UPDATE ltb_users SET brands = NULL, updated_at = now() WHERE telegram_id = $1`, [
      telegramId,
    ]);
    return;
  }
  await pool.query(
    `UPDATE ltb_users SET brands = $2::text[], updated_at = now() WHERE telegram_id = $1`,
    [telegramId, brands.map((b) => normalizeBrand(b))],
  );
}

export async function listManagerTgIdsInDepartment(departmentId: string): Promise<number[]> {
  const norm = normalizeDepartmentId(departmentId);
  if (!norm) return [];
  const pool = getPool();
  const { rows } = await pool.query<{ telegram_id: string }>(
    `SELECT telegram_id FROM ltb_users
     WHERE role = 'manager' AND active = true AND department_id = $1`,
    [norm],
  );
  return rows.map((r) => parseInt(r.telegram_id, 10)).sort((a, b) => a - b);
}

export async function listStaffBroadcastRecipientIds(): Promise<number[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ telegram_id: string }>(
    `SELECT telegram_id FROM ltb_users
     WHERE active = true AND role IN ('manager', 'rop', 'atz') ORDER BY telegram_id`,
  );
  return rows.map((r) => parseInt(r.telegram_id, 10));
}

/** Полные права админа: в .env (BOT_ADMIN_IDS) или роль admin в БД. */
export async function isBotAdmin(telegramId: number): Promise<boolean> {
  if (config.adminIds.includes(telegramId)) return true;
  const u = await getUser(telegramId);
  return u?.role === 'admin';
}

/** Журнал передач по всей компании: админ или РОП. */
export async function canViewAllTransfers(telegramId: number): Promise<boolean> {
  if (await isBotAdmin(telegramId)) return true;
  const u = await getUser(telegramId);
  return u?.role === 'rop';
}

export function ropTelegramIdsFromEnv(): number[] {
  return config.ropIds;
}
