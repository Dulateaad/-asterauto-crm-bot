import * as admin from 'firebase-admin';
import { config } from './config';

let inited = false;

function serviceAccountProjectId(sa: admin.ServiceAccount): string | undefined {
  const raw = sa as unknown as { project_id?: string };
  return raw.project_id || sa.projectId;
}

export function initFirebase(): void {
  if (inited) return;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) as admin.ServiceAccount;
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
