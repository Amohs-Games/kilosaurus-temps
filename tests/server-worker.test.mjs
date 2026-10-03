// Worker (server/worker.js) : codes, blocage par adresse, routage, à travers l'API D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './server-harness.mjs';
import { d1Shim } from './d1-shim.mjs';
import { authByCode } from '../server/auth.js';
import worker, { handleApi } from '../server/worker.js';

const PC = 'p'.repeat(40);
const AGENT = 'c'.repeat(40);
const T0 = Date.parse('2026-10-01T09:00:00+02:00');

function makeWorkerEnv() {
  return {
    DB: d1Shim(makeDb()),
    ASSETS: { fetch: async (req) => new Response('fichier ' + new URL(req.url).pathname) },
    CODE_AMOHS_PC: PC,
    CODE_AMOHS_CLAUDE: AGENT,
    CODE_AMOHS_COURT: 'trop-court',
  };
}

function apiRequest(body, ip = '1.2.3.4') {
  return new Request('https://temps.example/api', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('codes : 32 caractères au moins, segment CLAUDE = agent, le reste ignoré', () => {
  const env = makeWorkerEnv();
  assert.deepEqual(authByCode(env, PC), { agent: false });
  assert.deepEqual(authByCode(env, AGENT), { agent: true });
  assert.equal(authByCode(env, 'trop-court'), null);
  assert.equal(authByCode(env, 'x'.repeat(40)), null);
  assert.equal(authByCode(env, undefined), null);
});

test('API : état avec un bon code, en-têtes CORS, pas de cache', async () => {
  const res = await handleApi(apiRequest({ code: PC, action: 'status' }), makeWorkerEnv(), T0);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.me, 'Amohs');
});

test('API : corps illisible → invalid', async () => {
  const body = await (await handleApi(apiRequest('pas du json'), makeWorkerEnv(), T0)).json();
  assert.equal(body.error.code, 'invalid');
});

test('blocage : 10 codes refusés depuis une adresse la bloquent une heure, elle seule', async () => {
  const env = makeWorkerEnv();
  for (let i = 0; i < 10; i++) {
    const body = await (await handleApi(apiRequest({ code: 'mauvais', action: 'status' }), env, T0 + i * 1000)).json();
    assert.equal(body.error.code, 'unauthorized');
  }
  const blocked = await (await handleApi(apiRequest({ code: PC, action: 'status' }), env, T0 + 20000)).json();
  assert.equal(blocked.error.code, 'locked');
  const other = await (await handleApi(apiRequest({ code: PC, action: 'status' }, '5.6.7.8'), env, T0 + 20000)).json();
  assert.equal(other.ok, true, 'une autre adresse n\'est pas bloquée');
  const later = await (await handleApi(apiRequest({ code: PC, action: 'status' }), env, T0 + 3600000 + 30000)).json();
  assert.equal(later.ok, true, 'débloquée après une heure');
});

test('blocage : des refus espacés de plus de 15 min ne s\'additionnent pas', async () => {
  const env = makeWorkerEnv();
  for (let i = 0; i < 12; i++) await handleApi(apiRequest({ code: 'mauvais', action: 'status' }), env, T0 + i * 16 * 60000);
  const body = await (await handleApi(apiRequest({ code: PC, action: 'status' }), env, T0 + 12 * 16 * 60000)).json();
  assert.equal(body.ok, true);
});

test('routage : /api en GET répond, OPTIONS sans corps, le reste va aux fichiers', async () => {
  const env = makeWorkerEnv();
  const get = await (await worker.fetch(new Request('https://temps.example/api'), env)).json();
  assert.equal(get.data.service, 'kilosaurus-temps');
  const options = await worker.fetch(new Request('https://temps.example/api', { method: 'OPTIONS' }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(await (await worker.fetch(new Request('https://temps.example/app.js'), env)).text(), 'fichier /app.js');
});

test('routage : une écriture passe de bout en bout', async () => {
  const env = makeWorkerEnv();
  const res = await worker.fetch(apiRequest({ code: PC, action: 'start', id: 'a1', project: 'Fluffy' }), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.running.id, 'a1');
});
