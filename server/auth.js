/**
 * Codes d'accès et blocage.
 *
 * Codes : secrets du Worker nommés CODE_<NOM> ou CODE_<NOM>_<APPAREIL> (un code par appareil, chacun
 * révocable seul). Un nom dont un segment est CLAUDE est un code d'agent. Un code de moins de
 * MIN_CODE_LENGTH caractères est ignoré : l'URL est publique, le code est la seule serrure.
 *
 * Blocage : après MAX_FAILED codes refusés en WINDOW_MS depuis une même adresse IP, cette adresse est
 * refusée pendant LOCKOUT_MS, bons codes compris. Les autres adresses ne sont pas touchées.
 */
const MIN_CODE_LENGTH = 32;
const MAX_FAILED = 10;
const WINDOW_MS = 15 * 60000;
const LOCKOUT_MS = 3600000;

// Comparaison à temps constant (à longueur égale) : la durée ne révèle pas où les codes diffèrent.
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authByCode(secrets, code) {
  if (typeof code !== 'string' || code.length < MIN_CODE_LENGTH) return null;
  for (const [key, value] of Object.entries(secrets)) {
    const m = /^CODE_[A-Z0-9]+((?:_[A-Z0-9]+)*)$/.exec(key);
    if (!m || typeof value !== 'string' || value.length < MIN_CODE_LENGTH) continue;
    if (sameText(value, code)) return { agent: m[1].split('_').includes('CLAUDE') };
  }
  return null;
}

export async function isLocked(db, ip, now) {
  const r = await db.first('SELECT until_ms FROM lockouts WHERE ip = ?', [ip]);
  return !!(r && r.until_ms && r.until_ms > now);
}

export async function recordFailure(db, ip, now) {
  const r = await db.first('SELECT failures, first_ms FROM lockouts WHERE ip = ?', [ip]);
  const fresh = !r || now - r.first_ms > WINDOW_MS;
  const failures = fresh ? 1 : r.failures + 1;
  const locked = failures >= MAX_FAILED;
  await db.batch([{
    sql: `INSERT INTO lockouts (ip, failures, first_ms, until_ms) VALUES (?, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, first_ms = excluded.first_ms, until_ms = excluded.until_ms`,
    params: [ip, locked ? 0 : failures, fresh ? now : r.first_ms, locked ? now + LOCKOUT_MS : null],
  }]);
}
