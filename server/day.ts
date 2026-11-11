/** Dia local (fuso do Mac do Leo), no formato AAAA-MM-DD. Um treino às 20h em Toronto é do mesmo dia que um às 9h. */
export function localDay(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Segunda-feira (dia local) da semana de uma data. */
export function weekStart(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : new Date(d.getTime());
  const back = (x.getDay() + 6) % 7; // segunda = 0
  x.setDate(x.getDate() - back);
  return localDay(x);
}

/** Soma dias a um AAAA-MM-DD, sem problema com horário de verão. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n, 12));
}
