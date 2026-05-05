import { Timestamp } from 'firebase-admin/firestore';

export type UserRole =
  | 'manager' // менеджер продаж, очередь лидов по брендам
  | 'atz' // АТЗ — администратор торгового зала (приём клиентов, регистрация лидов)
  | 'rop' // руководитель отдела продаж
  | 'admin' // админ бота / полный доступ
  | 'none';

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'meeting'
  | 'transferred'
  | 'won'
  | 'lost';

export type TransferReasonId =
  | 'high_price'
  | 'no_stock'
  | 'brand_dislike'
  | 'credit_fail'
  | 'trade_want'
  | 'need_used';

export type TransferTargetId =
  | 'other_brand'
  | 'used'
  | 'buyout'
  | 'finance';

export type WizardKey =
  | 'idle'
  | 'atz_fio'
  | 'atz_phone'
  | 'atz_brand'
  | 'atz_payment'
  | 'atz_budget'
  | 'atz_confirm'
  /** Покупатель из Telegram: согласие → те же шаги что у АТЗ */
  | 'buyer_consent'
  | 'buyer_fio'
  | 'buyer_phone'
  | 'buyer_brand'
  | 'buyer_payment'
  | 'buyer_budget'
  | 'buyer_confirm'
  | 'tr_pick'
  | 'tr_reason'
  | 'tr_target'
  | 'tr_comment'
  | 'note_lead'
  | 'status_lead'
  /** Админ выбирает бренды после /adduser без «--» (manager, rop, atz, admin) */
  | 'admin_mgr_brands';

export interface Session {
  key: WizardKey;
  data: Record<string, string | number | boolean | undefined>;
}
