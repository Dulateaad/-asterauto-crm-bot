/** Синхрон с кнопками визарда в index.ts */
export const KNOWN_BRANDS = [
  'OMODA',
  'JAECOO',
  'LADA',
  'GAC',
  'Changan',
  'JAC',
  'Chery',
  'Jetour',
  'Б/У',
] as const;

export type KnownBrand = (typeof KNOWN_BRANDS)[number];

/** Приводит строку к каноническому виду из списка (регистр не важен). */
export function normalizeBrand(raw: string): string {
  const t = raw.trim();
  for (const b of KNOWN_BRANDS) {
    if (b.toLowerCase() === t.toLowerCase()) return b;
  }
  return t;
}
