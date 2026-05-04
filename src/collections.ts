/**
 * Префикс Firestore: данные бота не смешиваются с cars, users, buyerCarRequests веб-приложения.
 * Правила: только Admin SDK; клиентам веба доступ закрыт (см. docs/firestore-ltb.fragment.rules).
 */
export const C = {
  users: 'ltbUsers',
  leads: 'ltbLeads',
  transfers: 'ltbTransfers',
  settings: 'ltbSettings',
  /** Покупатели из Telegram: контакты и согласие на рассылки по брендам */
  buyerContacts: 'ltbBuyerContacts',
} as const;

export const SETTINGS_DOC = 'app';
