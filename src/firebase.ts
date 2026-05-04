import * as admin from 'firebase-admin';
import { config } from './config';

let inited = false;

function serviceAccountProjectId(sa: admin.ServiceAccount): string | undefined {
  const raw = sa as unknown as { project_id?: string };
  return raw.project_id || sa.projectId;
}

/** Raw JSON string for service account from env (Render-friendly). */
function readServiceAccountJsonString(): string | undefined {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim();
  if (b64) {
    // Частая ошибка: вставили сырой JSON в переменную «B64»
    if (b64.startsWith('{')) {
      throw new Error(
        '[firebase] В FIREBASE_SERVICE_ACCOUNT_JSON_B64 попал сырой JSON, а не base64. ' +
          'Либо перенесите JSON в FIREBASE_SERVICE_ACCOUNT_JSON (одна строка), либо задайте B64 так: ' +
          "`base64 serviceAccount.json | tr -d '\\n'` (macOS) или `base64 -w0 serviceAccount.json` (Linux).",
      );
    }
    let decoded: string;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      throw new Error(
        '[firebase] FIREBASE_SERVICE_ACCOUNT_JSON_B64: невалидный base64. Сгенерируйте: base64 serviceAccount.json | tr -d \'\\n\'',
      );
    }
    const head = decoded.trimStart();
    if (!head.startsWith('{')) {
      throw new Error(
        '[firebase] После декодирования FIREBASE_SERVICE_ACCOUNT_JSON_B64 строка не похожа на JSON (нет «{» в начале). ' +
          'Снова закодируйте **файл** serviceAccount.json в base64, без лишних кавычек и пробелов вокруг.',
      );
    }
    return decoded;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  return raw || undefined;
}

function parseServiceAccountJson(jsonStr: string): admin.ServiceAccount {
  const trimmed = jsonStr.trim();
  const tryParse = (s: string): admin.ServiceAccount => JSON.parse(s) as admin.ServiceAccount;
  try {
    return tryParse(trimmed);
  } catch (e1) {
    // Целиком JSON в кавычках с экранированием («строка внутри строки») — частая ошибка в .env / панели
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const inner = JSON.parse(trimmed) as unknown;
        if (typeof inner === 'string' && inner.trimStart().startsWith('{')) {
          return tryParse(inner);
        }
      } catch {
        // fall through
      }
    }
    const msg = e1 instanceof Error ? e1.message : String(e1);
    throw new Error(
      `[firebase] Не удалось разобрать JSON ключа (${msg}). ` +
        'На Render часто ломается вставка многострочного JSON. Варианты: ' +
        '(1) FIREBASE_SERVICE_ACCOUNT_JSON_B64 = base64 всего serviceAccount.json (одна строка, надёжнее всего); ' +
        '(2) FIREBASE_SERVICE_ACCOUNT_JSON — одна строка, без оборачивания всего значения в кавычки; в private_key только \\n, не настоящие переносы строк.',
    );
  }
}

export function initFirebase(): void {
  if (inited) return;
  const credSource = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim()
    ? 'FIREBASE_SERVICE_ACCOUNT_JSON_B64'
    : process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()
      ? 'FIREBASE_SERVICE_ACCOUNT_JSON'
      : 'application default';
  // eslint-disable-next-line no-console
  console.log('[firebase] credential source:', credSource);

  const jsonStr = readServiceAccountJsonString();
  if (jsonStr) {
    const sa = parseServiceAccountJson(jsonStr);
    const fromKey = serviceAccountProjectId(sa);
    const fromEnv = process.env.FIREBASE_PROJECT_ID?.trim();
    // Firestore Admin SDK должен ходить в тот же проект, что и ключ; иначе PERMISSION_DENIED
    const projectId = fromKey || fromEnv || config.projectId;
    if (fromEnv && fromKey && fromEnv !== fromKey) {
      // eslint-disable-next-line no-console
      console.warn(
        `[firebase] FIREBASE_PROJECT_ID="${fromEnv}" не совпадает с project_id в JSON ключа "${fromKey}". ` +
          `Используется project_id из ключа.`,
      );
    }
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId,
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: config.projectId,
    });
  }
  inited = true;
  // eslint-disable-next-line no-console
  console.log('[firebase] Firestore project:', admin.app().options.projectId);
}

/** Реальный projectId после init (из ключа или env), не «сырой» config.projectId */
export function getActiveFirebaseProjectId(): string {
  initFirebase();
  return String(admin.app().options.projectId ?? '');
}

export function getDb() {
  initFirebase();
  return admin.firestore();
}

export { admin };
