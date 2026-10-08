// Fuseau Europe/Paris, par Intl (disponible dans les Workers comme dans Node). Tout est en
// millisecondes UTC ; un jour est une clé 'aaaa-mm-jj'.
const TZ = 'Europe/Paris';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parts(ms) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value;
  return p;
}

// Écart entre l'heure de Paris et UTC à cet instant (1 h ou 2 h).
function offsetMs(ms) {
  const p = parts(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

export function dayKey(ms) { return dayFmt.format(new Date(ms)); }

export function dayStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - offsetMs(guess);
}

// Début du jour suivant, sûr aux changements d'heure (jour de 23 ou 25 h).
export function nextDayStart(dayStartMs) { return dayStart(dayKey(dayStartMs + 36 * 3600000)); }

export function clock(ms) { const p = parts(ms); return `${p.hour}:${p.minute}`; }

export function shortDate(ms) { const p = parts(ms); return `${p.day}/${p.month}`; }

// Instant d'une heure ronde de Paris un jour donné. Sûr aux changements d'heure tant que l'heure
// demandée n'est pas dans le trou de 2 h à 3 h (6 h ne l'est jamais).
export function localTime(key, hour) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  return guess - offsetMs(guess);
}

export function previousDayKey(key) { return dayKey(dayStart(key) - 12 * 3600000); }

// Jour de travail : de 6 h à 6 h le lendemain. Avant 6 h du matin, c'est encore celui de la veille.
export const WORKDAY_HOUR = 6;

export function workDayKey(ms) {
  const key = dayKey(ms);
  return ms < localTime(key, WORKDAY_HOUR) ? previousDayKey(key) : key;
}

export function workDayEnd(key) { return localTime(dayKey(nextDayStart(dayStart(key))), WORKDAY_HOUR); }
