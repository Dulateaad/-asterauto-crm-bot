import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { C } from '../collections';
import { getDb } from '../firebase';
import type { LeadStatus, TransferReasonId, TransferTargetId } from '../types';
import { getNextManagerTelegramId } from './ltbUsers';

const db = () => getDb();

export interface LeadDoc {
  fio: string;
  phone: string;
  brand: string;
  payment: 'credit' | 'cash' | 'tradein';
  budget: string;
  status: LeadStatus;
  createdBy: number;
  assignedTo: number;
  comment: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  firstContactAt: Timestamp | null;
  meetingAt: Timestamp | null;
  lostReason: string | null;
  sla15Sent: boolean;
  sla30Sent: boolean;
  transferredOutCount: number;
}

export async function createLead(
  data: Omit<LeadDoc, 'createdAt' | 'updatedAt' | 'meetingAt' | 'lostReason' | 'sla15Sent' | 'sla30Sent' | 'transferredOutCount' | 'firstContactAt' | 'status' | 'assignedTo' | 'comment'> & { comment?: string },
  assignTo: number
): Promise<string> {
  const now = Timestamp.now();
  const ref = await db().collection(C.leads).add({
    ...data,
    status: 'new' as const,
    assignedTo: assignTo,
    comment: data.comment || '',
    createdAt: now,
    updatedAt: now,
    firstContactAt: null,
    meetingAt: null,
    lostReason: null,
    sla15Sent: false,
    sla30Sent: false,
    transferredOutCount: 0,
  } satisfies LeadDoc);
  return ref.id;
}

export async function getLead(id: string) {
  const s = await db().collection(C.leads).doc(id).get();
  if (!s.exists) return null;
  return { id: s.id, ...(s.data() as LeadDoc) };
}

export async function listMyLeads(managerTg: number) {
  const q = await db()
    .collection(C.leads)
    .where('assignedTo', '==', managerTg)
    .limit(50)
    .get();
  const rows = q.docs.map((d) => ({ id: d.id, ...(d.data() as LeadDoc) }));
  return rows.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
}

export async function listLeadsNeedingSla() {
  const q = await db().collection(C.leads).where('status', '==', 'new').limit(200).get();
  return q.docs
    .map((d) => ({ id: d.id, ...(d.data() as LeadDoc) }))
    .filter((L) => L.firstContactAt == null);
}

export async function markFirstContact(leadId: string) {
  await db()
    .collection(C.leads)
    .doc(leadId)
    .update({
      firstContactAt: FieldValue.serverTimestamp(),
      status: 'contacted',
      updatedAt: FieldValue.serverTimestamp(),
    });
}

export async function setSlaFlags(leadId: string, sla15: boolean, sla30: boolean) {
  const u: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (sla15) u.sla15Sent = true;
  if (sla30) u.sla30Sent = true;
  await db().collection(C.leads).doc(leadId).update(u);
}

export async function updateLeadStatus(leadId: string, status: LeadStatus) {
  await db()
    .collection(C.leads)
    .doc(leadId)
    .update({ status, updatedAt: FieldValue.serverTimestamp() });
}

export async function addNote(leadId: string, line: string) {
  const ref = db().collection(C.leads).doc(leadId);
  const s = await ref.get();
  const cur = (s.data()?.comment as string) || '';
  await ref.update({
    comment: cur ? `${cur}\n${line}` : line,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function recordTransfer(
  leadId: string,
  fromTg: number,
  reason: TransferReasonId,
  target: TransferTargetId,
  comment: string
) {
  const leadRef = db().collection(C.leads).doc(leadId);
  const leadSnap = await leadRef.get();
  if (!leadSnap.exists) throw new Error('NO_LEAD');
  const brand = String((leadSnap.data() as LeadDoc)?.brand || '');
  const newManager = await getNextManagerTelegramId(brand);
  if (!newManager) {
    throw new Error('NO_MANAGERS');
  }
  const prev = (leadSnap.data()?.comment as string) || '';
  const transferNote = `Передача: ${reason} → ${target}. ${comment}`;
  const newComment = prev ? `${prev}\n\n${transferNote}` : transferNote;

  const batch = db().batch();
  batch.update(leadRef, {
    comment: newComment,
    assignedTo: newManager,
    status: 'transferred',
    transferredOutCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const trRef = db().collection(C.transfers).doc();
  batch.set(trRef, {
    leadId,
    fromTelegramId: fromTg,
    reason,
    target,
    comment,
    toTelegramId: newManager,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { newManager };
}

export async function countLeadsSince(since: Timestamp) {
  const q = await db().collection(C.leads).where('createdAt', '>=', since).get();
  return q.size;
}

export async function countToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return countLeadsSince(Timestamp.fromDate(d));
}
