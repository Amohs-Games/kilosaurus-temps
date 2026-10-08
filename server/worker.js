/**
 * Worker Cloudflare : l'API (POST /api) et l'app web (fichiers de web/, servis par le binding ASSETS).
 * Les données sont dans D1 (binding DB) ; les codes d'accès sont des secrets du Worker (server/auth.js).
 * Protocole : corps JSON en text/plain (pas de requête préalable CORS), réponse { ok, data } ou
 * { ok: false, error: { code, message } }.
 */
import { handleRequest, freezeDays } from './core.js';
import { authByCode, isLocked, recordFailure } from './auth.js';
import { fromD1 } from './db.js';

// L'APK sert l'app depuis sa propre origine (app.kilosaurus.local) : l'API accepte toute origine,
// le code reste la serrure.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const LOCKED = { ok: false, error: { code: 'locked', message: 'Accès bloqué : trop de codes refusés depuis cette adresse. Réessaie dans une heure.' } };

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

export async function handleApi(request, env, now = Date.now()) {
  const db = fromD1(env.DB);
  const ip = request.headers.get('CF-Connecting-IP') || 'inconnue';
  if (await isLocked(db, ip, now)) return json(LOCKED);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return json({ ok: false, error: { code: 'invalid', message: 'Corps JSON non valide.' } });
  }
  let refused = false;
  const auth = (code) => {
    const who = authByCode(env, code);
    if (!who) refused = true;
    return who;
  };
  const res = await handleRequest({ db, now: () => now, auth }, body);
  if (refused) await recordFailure(db, ip, now);
  return json(res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method === 'POST') return handleApi(request, env);
      return json({ ok: true, data: { service: 'kilosaurus-temps' } });
    }
    return env.ASSETS.fetch(request);
  },

  // Cron (wrangler.toml, toutes les heures) : fige les journées finies. Une erreur fait échouer
  // l'exécution, visible dans les journaux du Worker ; l'heure suivante reprend où on en était.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(freezeDays({ db: fromD1(env.DB), now: event.scheduledTime }));
  },
};
