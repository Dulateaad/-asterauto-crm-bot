import * as admin from 'firebase-admin';
import { config } from './config';

let inited = false;

export function initFirebase(): void {
  if (inited) return;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) as admin.ServiceAccount;
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.projectId || config.projectId,
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: config.projectId,
    });
  }
  inited = true;
}

export function getDb() {
  initFirebase();
  return admin.firestore();
}

export { admin };
