/**
 * Русское склонение по числу. Без него на экране появляется «5 запроса»: в интерфейсе,
 * где числа меняются сами, такие строки собираются только из готовых форм.
 */
export const plural = (count: number, forms: readonly [string, string, string]): string => {
  const abs = Math.abs(Math.trunc(count));
  const tens = abs % 100;
  const ones = abs % 10;

  if (tens >= 11 && tens <= 14) return forms[2];
  if (ones === 1) return forms[0];
  if (ones >= 2 && ones <= 4) return forms[1];

  return forms[2];
};

/** Число вместе со склонённым словом: «5 запросов». */
export const counted = (count: number, forms: readonly [string, string, string]): string =>
  `${String(count)} ${plural(count, forms)}`;
