import pg from 'pg';

let pool: pg.Pool | null = null;

export function initDb(): void {
  if (pool) return;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('[db] DATABASE_URL обязателен (PostgreSQL, напр. postgresql://user:pass@host:5432/asterauto_bot)');
  }
  pool = new pg.Pool({
    connectionString: url,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  // eslint-disable-next-line no-console
  console.log('[db] PostgreSQL pool создан');
}

export function getPool(): pg.Pool {
  initDb();
  return pool!;
}

/** Для лога старта (без пароля). */
export function databaseUrlHostSummary(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return '(нет DATABASE_URL)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(DATABASE_URL не разобрать как URL)';
  }
}
