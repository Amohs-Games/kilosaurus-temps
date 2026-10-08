// Règles métier (server/core.js) sur une base SQLite en mémoire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClock, insertRow, ok, fails, at } from './server-harness.mjs';

const H = 3600000;

test('auth : code inconnu ou absent → unauthorized', async () => {
  const { call, env, handleRequest } = await makeEnv();
  fails(await call('status', {}, 'nope'), 'unauthorized');
  fails(await handleRequest(env, { action: 'status' }), 'unauthorized');
});

test('action inconnue → invalid', async () => {
  const { call } = await makeEnv();
  fails(await call('explode'), 'invalid');
});

test('status initial', async () => {
  const { call } = await makeEnv();
  const s = ok(await call('status'));
  assert.equal(s.me, 'Amohs');
  assert.equal(s.agent, false);
  assert.deepEqual(s.projects, ['Fluffy', 'Studio']);
  assert.equal(s.studio, 'Studio');
  assert.equal(s.visible, 4);
  assert.equal(s.threshold, 8);
  assert.equal(s.running, null);
  assert.equal(s.last, null);
  assert.equal(s.undo, null);
  assert.equal(s.serverTime, new Date('2026-10-01T09:00:00+02:00').toISOString());
});

test('start ouvre un compteur', async () => {
  const { call, row, clock } = await makeEnv();
  const s = ok(await call('start', { id: 'a1', project: 'Fluffy', note: 'menus' }));
  assert.equal(s.running.id, 'a1');
  assert.equal(s.running.project, 'Fluffy');
  assert.equal(s.running.start, new Date(clock.now()).toISOString());
  assert.equal(s.running.note, 'menus');
  assert.equal(s.running.hours, null);
  const r = row('a1');
  assert.equal(r.source, 'app');
  assert.equal(r.end_ms, null);
  assert.equal(r.created_ms, clock.now());
});

test('start : projet inconnu, décalage hors liste, id manquant → invalid', async () => {
  const { call } = await makeEnv();
  fails(await call('start', { id: 'a1', project: 'Nope' }), 'invalid');
  fails(await call('start', { id: 'a1', project: 'Fluffy', offsetMinutes: 20 }), 'invalid');
  fails(await call('start', { project: 'Fluffy' }), 'invalid');
});

test('bascule : l\'ancien compteur se ferme à l\'heure du nouveau début', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(90);
  const s = ok(await call('start', { id: 'a2', project: 'Studio' }));
  assert.equal(row('a1').end_ms, clock.now());
  assert.equal(s.running.id, 'a2');
  assert.equal(s.last.id, 'a1');
  assert.equal(s.last.hours, 1.5);
});

test('bascule avec décalage : pas de chevauchement', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(90);
  ok(await call('start', { id: 'a2', project: 'Studio', offsetMinutes: 30 }));
  assert.equal(row('a2').start_ms, row('a1').end_ms);
  assert.equal(row('a1').end_ms - row('a1').start_ms, H);
});

test('décalage qui remonte avant le compteur en cours : ramené à son début (durée nulle)', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  const t0 = clock.now();
  clock.advance(10);
  const s = ok(await call('start', { id: 'a2', project: 'Studio', offsetMinutes: 60 }));
  assert.equal(row('a2').start_ms, t0);
  assert.equal(s.last.hours, 0);
});

test('start rejoué avec le même id : une seule ligne', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(5);
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].end_ms, null);
});

test('stop ferme le compteur ; stop sans compteur ne fait rien', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(45);
  const s = ok(await call('stop'));
  assert.equal(s.running, null);
  assert.equal(s.last.id, 'a1');
  assert.equal(s.last.hours, 0.75);
  clock.advance(5);
  ok(await call('stop'));
  assert.equal(row('a1').end_ms, clock.now() - 5 * 60000);
});

test('stop avec heure de fin (oubli)', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(12 * 60);
  const s = ok(await call('stop', { endAt: '2026-10-01T18:00:00+02:00' }));
  assert.equal(s.last.hours, 9);
});

test('stop avec heure de fin avant le début, dans le futur ou illisible → invalid', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  fails(await call('stop', { endAt: '2026-10-01T08:00:00+02:00' }), 'invalid');
  fails(await call('stop', { endAt: '2026-10-01T23:00:00+02:00' }), 'invalid');
  fails(await call('stop', { endAt: 'pas une date' }), 'invalid');
});

test('compteur de plus de 24 h : STOP et bascule refusés avec un message clair, l\'heure de fin passe', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.set('2026-10-02T10:00:00+02:00');
  fails(await call('stop'), 'invalid', /24 h/);
  fails(await call('start', { id: 'a2', project: 'Studio' }), 'invalid', /24 h/);
  const s = ok(await call('stop', { endAt: '2026-10-01T18:00:00+02:00' }));
  assert.equal(s.running, null);
});

test('deux lancements simultanés : le second reçoit busy, pas server', async () => {
  const { call, env } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  // Simule une lecture faite avant que l'autre appareil n'écrive : « aucun compteur en cours ».
  const realFirst = env.db.first;
  env.db.first = async (sql, params) => (/end_ms IS NULL AND deleted_ms IS NULL$/.test(sql) ? null : realFirst(sql, params));
  fails(await call('start', { id: 'a2', project: 'Studio' }), 'busy');
});

test('note : modifie le compteur en cours', async () => {
  const { call } = await makeEnv();
  fails(await call('note', { text: 'x' }), 'invalid');
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(await call('note', { text: 'boss final' }));
  assert.equal(s.running.note, 'boss final');
});

test('logBlock : bloc du jour, sans toucher au compteur', async () => {
  const { call, row } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(await call('logBlock', { id: 'b1', project: 'Studio', hours: 8 }));
  const b = row('b1');
  assert.equal(b.kind, 'block');
  assert.equal(b.start_ms, null);
  assert.equal(b.hours, 8);
  assert.equal(s.running.id, 'a1');
  assert.equal(s.last.id, 'b1');
  assert.equal(s.last.date, '2026-10-01');
});

test('logBlock : heures hors liste, date future ou mal formée → invalid ; date passée ok', async () => {
  const { call } = await makeEnv();
  fails(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 5 }), 'invalid');
  fails(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 14 }), 'invalid');
  fails(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-10-02' }), 'invalid');
  fails(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '01/10/2026' }), 'invalid');
  const s = ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-09-14' }));
  assert.equal(s.last.date, '2026-09-14');
});

test('logBlock rejoué : une seule ligne', async () => {
  const { call, rows } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  assert.equal(rows().length, 1);
});

test('hors ligne : l\'heure du tap fait foi, jamais dans le futur', async () => {
  const { call, row } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', offline: true, clientTime: '2026-10-01T08:30:00+02:00' }));
  assert.equal(row('a1').start_ms, at('2026-10-01T08:30:00+02:00'));
  assert.equal(row('a1').source, 'hors ligne');
  ok(await call('start', { id: 'a2', project: 'Studio', offline: true, clientTime: '2026-10-01T11:00:00+02:00' }));
  assert.equal(row('a2').start_ms, at('2026-10-01T09:00:00+02:00'));
});

test('hors ligne : clientTime ignoré sans le drapeau offline', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', clientTime: '2026-10-01T08:30:00+02:00' }));
  assert.equal(row('a1').start_ms, clock.now());
  assert.equal(row('a1').source, 'app');
});

test('hors ligne : un stop plus ancien que le compteur en cours ne le ferme pas', async () => {
  const { call, clock } = await makeEnv({ clock: makeClock('2026-10-01T10:30:00+02:00') });
  ok(await call('start', { id: 'pc', project: 'Fluffy' }));
  clock.advance(30);
  const s = ok(await call('stop', { offline: true, clientTime: '2026-10-01T10:00:00+02:00' }));
  assert.equal(s.running.id, 'pc');
});

test('hors ligne : un bloc « aujourd\'hui » rejoué compte pour le jour du tap', async () => {
  const { call } = await makeEnv({ clock: makeClock('2026-10-02T00:30:00+02:00') });
  const s = ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2, offline: true, clientTime: '2026-10-01T23:30:00+02:00' }));
  assert.equal(s.last.date, '2026-10-01');
});

test('jour d\'une session = jour de Paris du début', async () => {
  const { call } = await makeEnv({ clock: makeClock('2026-10-01T00:30:00+02:00') });
  const s = ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(s.running.date, '2026-10-01');
});

test('tapTime : l\'heure du tap (widget) fait foi, source app, jamais dans le futur', async () => {
  const { call, row } = await makeEnv();
  ok(await call('start', { id: 'w1', project: 'Fluffy', tapTime: '2026-10-01T08:59:40+02:00' }));
  assert.equal(row('w1').start_ms, at('2026-10-01T08:59:40+02:00'));
  assert.equal(row('w1').source, 'app');
  ok(await call('stop', { tapTime: '2026-10-01T09:30:00+02:00' }));
  assert.equal(row('w1').end_ms, at('2026-10-01T09:00:00+02:00'));
});

test('logSession : réservé aux codes d\'agent', async () => {
  const { call } = await makeEnv();
  fails(await call('logSession', { id: 's1', project: 'Fluffy', start: '2026-10-01T06:00:00+02:00', end: '2026-10-01T08:00:00+02:00' }), 'invalid');
});

test('logSession : source claude', async () => {
  const { call, row } = await makeEnv();
  const s = ok(await call('logSession', { id: 's1', project: 'Fluffy', start: '2026-09-30T14:00:00+02:00', end: '2026-09-30T17:12:00+02:00', note: 'refacto save' }, 'code-amohs-claude'));
  assert.equal(row('s1').source, 'claude');
  assert.equal(s.agent, true);
  assert.equal(s.last.hours, 3.2);
  assert.equal(s.last.date, '2026-09-30');
});

test('logSession : chevauchement, fin future, plus de 24 h, début ≥ fin → invalid', async () => {
  const { call } = await makeEnv();
  const agent = (p) => call('logSession', p, 'code-amohs-claude');
  ok(await agent({ id: 's1', project: 'Fluffy', start: '2026-09-30T14:00:00+02:00', end: '2026-09-30T17:00:00+02:00' }));
  fails(await agent({ id: 's2', project: 'Studio', start: '2026-09-30T16:00:00+02:00', end: '2026-09-30T18:00:00+02:00' }), 'invalid', /Chevauche/);
  fails(await agent({ id: 's3', project: 'Fluffy', start: '2026-10-01T08:00:00+02:00', end: '2026-10-01T10:00:00+02:00' }), 'invalid');
  fails(await agent({ id: 's4', project: 'Fluffy', start: '2026-09-28T08:00:00+02:00', end: '2026-09-29T09:00:00+02:00' }), 'invalid');
  fails(await agent({ id: 's5', project: 'Fluffy', start: '2026-09-29T10:00:00+02:00', end: '2026-09-29T10:00:00+02:00' }), 'invalid');
  ok(await agent({ id: 's6', project: 'Fluffy', start: '2026-09-30T17:00:00+02:00', end: '2026-09-30T18:00:00+02:00' }));
});

test('logSession : chevauche le compteur en cours → invalid', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'l1', project: 'Fluffy' }));
  clock.advance(120);
  fails(await call('logSession', { id: 's1', project: 'Fluffy', start: '2026-10-01T09:30:00+02:00', end: '2026-10-01T10:00:00+02:00' }, 'code-amohs-claude'), 'invalid');
});

test('dernier log : le plus récent écrit, reports et compteur en cours exclus', async () => {
  const { call, sqlite, clock } = await makeEnv();
  insertRow(sqlite, { id: 'report-0001', kind: 'block', day: '2026-09-30', hours: 8, source: 'report', touched_ms: at('2026-10-01T08:59:00+02:00') });
  assert.equal(ok(await call('status')).last, null);
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-09-20' }));
  clock.advance(1);
  ok(await call('logBlock', { id: 'b2', project: 'Fluffy', hours: 4, date: '2026-09-10' }));
  clock.advance(1);
  const s = ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(s.last.id, 'b2');
});

test('dernier log : un compteur oublié qu\'on ferme passe devant un bloc saisi entre-temps', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(await call('logBlock', { id: 'b1', project: 'Studio', hours: 2, date: '2026-09-30' }));
  clock.advance(600);
  const s = ok(await call('stop', { endAt: '2026-10-01T17:00:00+02:00' }));
  assert.equal(s.last.id, 'a1');
});

test('addProject : ajouté après le dernier projet', async () => {
  const { call } = await makeEnv();
  const s = ok(await call('addProject', { name: '  Heirfall ' }));
  assert.deepEqual(s.projects, ['Fluffy', 'Studio', 'Heirfall']);
  ok(await call('start', { id: 'a1', project: 'Heirfall' }));
});

test('addProject : noms refusés', async () => {
  const { call } = await makeEnv();
  for (const name of ['', '   ', 'fluffy', '_Secret', 'a/b', 'x'.repeat(31)]) {
    fails(await call('addProject', { name }), 'invalid');
  }
});

test('erreur interne → server, sans faire planter l\'appelant', async () => {
  const { env, handleRequest } = await makeEnv();
  env.db = { ...env.db, all: async () => { throw new Error('boom'); } };
  fails(await handleRequest(env, { code: 'code-amohs', action: 'status' }), 'server');
});

test('type : Misc par défaut, bascule de type sans trou, même type → rien', async () => {
  const { call, rows, clock } = await makeEnv();
  let s = ok(await call('start', { id: 't1', project: 'Fluffy' }));
  assert.equal(s.running.type, 'Misc');
  clock.advance(10);
  ok(await call('start', { id: 't2', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  s = ok(await call('start', { id: 't3', project: 'Fluffy', type: 'Art' }));
  const [, b, c] = rows();
  assert.equal(b.type, 'Dev');
  assert.equal(b.end_ms, c.start_ms);
  assert.equal(s.last.type, 'Dev');
  clock.advance(10);
  s = ok(await call('start', { id: 't4', project: 'Fluffy', type: 'Art' }));
  assert.equal(s.running.id, 't3');
});

test('type : start sans type garde celui du compteur en cours ; inconnu → invalid ; blocs typés', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 't1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(10);
  const s = ok(await call('start', { id: 't2', project: 'Studio' }));
  assert.equal(s.running.type, 'Dev');
  fails(await call('start', { id: 't3', project: 'Fluffy', type: 'Musique' }), 'invalid');
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2, type: 'Writing' }));
  assert.equal(row('b1').type, 'Writing');
});

test('type : anciens noms (Autre, Narration) lus et acceptés comme Misc, Writing', async () => {
  const { call, sqlite, row, clock } = await makeEnv();
  insertRow(sqlite, { id: 'o1', type: 'Autre', start_ms: at('2026-10-01T07:00:00+02:00'), end_ms: at('2026-10-01T07:30:00+02:00') });
  insertRow(sqlite, { id: 'o2', type: 'Narration', start_ms: at('2026-10-01T07:30:00+02:00'), end_ms: at('2026-10-01T08:00:00+02:00') });
  const h = ok(await call('history', { from: '2026-10-01', to: '2026-10-01' }));
  assert.deepEqual(h.rows.map((r) => r.type), ['Misc', 'Writing']);
  const s = ok(await call('start', { id: 'n1', project: 'Fluffy', type: 'Narration' }));
  assert.equal(s.running.type, 'Writing');
  assert.equal(row('n1').type, 'Writing');
  clock.advance(5);
  assert.equal(ok(await call('start', { id: 'n2', project: 'Fluffy', type: 'Writing' })).running.id, 'n1');
});

test('status.types et status.today', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('logBlock', { id: 'y', project: 'Fluffy', hours: 2, date: '2026-09-30' }));
  ok(await call('start', { id: 'a', project: 'Fluffy', type: 'Dev' }));
  clock.advance(60);
  const s = ok(await call('start', { id: 'b', project: 'Fluffy', type: 'Art' }));
  assert.deepEqual(s.types.map((t) => t.name), ['Misc', 'Market', 'Social', 'Production', 'Art', 'Concept', 'TechArt', 'UI', 'Dev', 'Gameplay', 'Tooling', 'Debug', 'Writing', 'Sound', 'Pause']);
  assert.deepEqual(s.today.map((r) => r.id), ['a', 'b']);
  assert.equal(s.today[1].end, null);
});

test('status.today : une session d\'hier encore en cours en fait partie', async () => {
  const { call, clock } = await makeEnv({ clock: makeClock('2026-09-30T22:00:00+02:00') });
  ok(await call('start', { id: 'n', project: 'Fluffy' }));
  clock.set('2026-10-01T01:00:00+02:00');
  assert.deepEqual(ok(await call('status')).today.map((r) => r.id), ['n']);
});

test('history : lignes de la période, bornes incluses ; dates invalides ou plus de 62 jours → invalid', async () => {
  const { call } = await makeEnv();
  ok(await call('logBlock', { id: 'd28', project: 'Fluffy', hours: 2, date: '2026-09-28' }));
  ok(await call('logBlock', { id: 'd29', project: 'Fluffy', hours: 4, date: '2026-09-29', type: 'Dev' }));
  ok(await call('logBlock', { id: 'd30', project: 'Studio', hours: 6, date: '2026-09-30' }));
  const h = ok(await call('history', { from: '2026-09-29', to: '2026-09-30' }));
  assert.deepEqual(h.rows.map((r) => r.id), ['d29', 'd30']);
  assert.equal(h.rows[0].type, 'Dev');
  assert.equal(h.from, '2026-09-29');
  fails(await call('history', { from: '2026-10-01', to: '2026-09-01' }), 'invalid');
  fails(await call('history', { from: '2026-01-01', to: '2026-03-15' }), 'invalid');
  fails(await call('history', { from: 'hier', to: '2026-10-01' }), 'invalid');
  ok(await call('history', { from: '2026-08-01', to: '2026-10-01' }));
});

test('pause : un morceau de type Pause, puis reprise sur la tâche', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'w1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(60);
  let s = ok(await call('start', { id: 'p1', project: 'Fluffy', type: 'Pause' }));
  assert.equal(s.running.type, 'Pause');
  assert.equal(s.last.type, 'Dev');
  clock.advance(15);
  s = ok(await call('start', { id: 'w2', project: 'Fluffy', type: 'Dev' }));
  assert.equal(s.running.type, 'Dev');
  assert.deepEqual(rows().map((r) => [r.type, r.end_ms == null ? null : (r.end_ms - r.start_ms) / H]), [['Dev', 1], ['Pause', 0.25], ['Dev', null]]);
});

test('journal : chaque écriture laisse une action annulable, résumée en clair', async () => {
  const { call } = await makeEnv();
  const s = ok(await call('start', { id: 'a1', project: 'Fluffy', type: 'Writing' }));
  assert.equal(typeof s.undo.opId, 'number');
  assert.equal(s.undo.summary, 'Lancement Fluffy · Writing à 09:00');
  assert.equal(ok(await call('status')).undo.opId, s.undo.opId, 'une lecture n\'écrit rien au journal');
});

test('lecture de l\'état : aucune requête ne parcourt toute la table (D1 compte les lignes lues)', async () => {
  const { dayKey } = await import('../server/tz.js');
  const { call, sqlite, env } = await makeEnv();
  const ins = sqlite.prepare('INSERT INTO entries (id, project, kind, day, start_ms, end_ms, type, source, created_ms, touched_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const base = at('2025-01-01T09:00:00+01:00');
  for (let i = 0; i < 3000; i++) {
    const s = base + i * 3 * H;
    ins.run('old' + i, 'Fluffy', 'session', dayKey(s), s, s + H, 'Misc', 'app', s, s);
  }
  sqlite.exec('ANALYZE');
  const seen = [];
  const all = env.db.all;
  env.db.all = async (sql, params) => { seen.push([sql, params || []]); return all(sql, params); };
  ok(await call('status'));
  const reads = seen.filter(([sql]) => /FROM entries/.test(sql));
  assert.ok(reads.length > 0);
  for (const [sql, params] of reads) {
    const plan = sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((r) => r.detail).join(' | ');
    // Ni balayage complet, ni plage ouverte sur le début (qui relit toutes les sessions passées).
    assert.doesNotMatch(plan, /SCAN entries(?! USING)|\(start_ms<\?\)/, plan);
  }
});

test('status.today : un compteur oublié de plus de 24 h en fait toujours partie', async () => {
  const { call, clock } = await makeEnv({ clock: makeClock('2026-09-29T20:00:00+02:00') });
  ok(await call('start', { id: 'f', project: 'Fluffy' }));
  clock.set('2026-10-01T09:00:00+02:00');
  assert.deepEqual(ok(await call('status')).today.map((r) => r.id), ['f']);
});

test('oubli : une heure de fin à plus de 24 h du début est refusée avec un message qui le dit', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.set('2026-10-03T09:00:00+02:00');
  fails(await call('stop', { endAt: '2026-10-02T10:00:00+02:00' }), 'invalid', /au plus 24 h après le début/);
});

test('caractères de contrôle : refusés dans les notes et les noms de projet, \n et \t permis dans les notes', async () => {
  const { call } = await makeEnv();
  fails(await call('logBlock', { id: 'c1', project: 'Fluffy', hours: 2, note: 'a\u0000b' }), 'invalid', /caractère de contrôle/);
  ok(await call('logBlock', { id: 'c2', project: 'Fluffy', hours: 2, note: 'ligne 1\n\tligne 2\r\n' }));
  fails(await call('addProject', { name: 'Pro\u0000jet' }), 'invalid', /contrôle/);
  fails(await call('editEntry', { id: 'c2', note: 'x\u0001y' }), 'invalid', /caractère de contrôle/);
});

// ---- Le choix partagé (projet, activité) ----

const opsCount = (sqlite) => sqlite.prepare('SELECT COUNT(*) AS n FROM ops').get().n;

test('choix : par défaut le premier projet et Misc ; après start puis stop, le dernier travaillé', async () => {
  const { call, clock } = await makeEnv();
  assert.deepEqual(ok(await call('status')).choice, { project: 'Fluffy', type: 'Misc' });
  ok(await call('start', { id: 'a1', project: 'Studio', type: 'Dev' }));
  clock.advance(10);
  const s = ok(await call('stop'));
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Dev' });
});

test('choix : sans réglage, le compteur en cours hors pause prime sur le dernier travaillé', async () => {
  const { call, sqlite, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', type: 'Dev' }));
  sqlite.prepare("DELETE FROM settings WHERE key LIKE 'choice_%'").run();
  clock.advance(10);
  ok(await call('start', { id: 'p1', project: 'Studio', type: 'Pause' }));
  sqlite.prepare("DELETE FROM settings WHERE key LIKE 'choice_%'").run();
  assert.deepEqual(ok(await call('status')).choice, { project: 'Fluffy', type: 'Dev' });
});

test('select à l’arrêt : change le choix, n’ouvre aucune session, une entrée ops', async () => {
  const { call, rows, sqlite } = await makeEnv();
  const s = ok(await call('select', { project: 'Studio', type: 'Art' }));
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Art' });
  assert.equal(rows().length, 0);
  assert.equal(s.running, null);
  assert.equal(opsCount(sqlite), 1);
});

test('select : un seul paramètre complète avec le choix actuel', async () => {
  const { call } = await makeEnv();
  ok(await call('select', { project: 'Studio', type: 'Art' }));
  assert.deepEqual(ok(await call('select', { type: 'Dev' })).choice, { project: 'Studio', type: 'Dev' });
  assert.deepEqual(ok(await call('select', { project: 'Fluffy' })).choice, { project: 'Fluffy', type: 'Dev' });
});

test('select compteur en marche : bascule à la même seconde', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  const s = ok(await call('select', { project: 'Studio' }));
  const [a, b] = rows();
  assert.equal(a.end_ms, clock.now());
  assert.equal(b.start_ms, clock.now());
  assert.equal(b.end_ms, null);
  assert.equal(b.project, 'Studio');
  assert.equal(b.type, 'Dev');
  assert.equal(s.running.project, 'Studio');
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Dev' });
});

test('select en pause : la pause continue, seul le choix change', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'w1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(60);
  ok(await call('start', { id: 'p1', project: 'Fluffy', type: 'Pause' }));
  clock.advance(5);
  const s = ok(await call('select', { project: 'Studio', type: 'Art' }));
  assert.equal(rows().length, 2);
  assert.equal(s.running.id, 'p1');
  assert.equal(s.running.end, null);
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Art' });
});

test('select : Pause ou projet inconnu → invalid ; identique au choix → aucune entrée ops', async () => {
  const { call, sqlite } = await makeEnv();
  fails(await call('select', { type: 'Pause' }), 'invalid', /Pause n’est pas une activité à choisir\./);
  fails(await call('select', { project: 'Nope' }), 'invalid');
  fails(await call('select', { type: 'Nope' }), 'invalid');
  ok(await call('select', { project: 'Studio' }));
  assert.equal(opsCount(sqlite), 1);
  ok(await call('select', { project: 'Studio' }));
  assert.equal(opsCount(sqlite), 1);
});

test('select : compteur déjà sur le choix visé → pas de bascule', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(5);
  ok(await call('select', { project: 'Fluffy', type: 'Dev' }));
  assert.equal(rows().length, 1);
});

test('start en Pause ne change pas le choix ; un start normal le change', async () => {
  const { call } = await makeEnv();
  ok(await call('start', { id: 'w1', project: 'Studio', type: 'Dev' }));
  const s = ok(await call('start', { id: 'p1', project: 'Fluffy', type: 'Pause' }));
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Dev' });
  assert.deepEqual(ok(await call('start', { id: 'w2', project: 'Fluffy', type: 'Art' })).choice, { project: 'Fluffy', type: 'Art' });
});

test('undo d’un select avec bascule : sessions et choix reviennent', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  const s = ok(await call('select', { project: 'Studio' }));
  assert.equal(rows().length, 2);
  const u = ok(await call('undo', { opId: s.undo.opId }));
  assert.deepEqual(u.choice, { project: 'Fluffy', type: 'Dev' });
  assert.equal(u.running.id, 'a1');
  assert.equal(u.running.end, null);
  assert.equal(rows().filter((r) => r.deleted_ms == null).length, 1);
});

test('select avec compteur oublié (25 h) : le choix change, sans bascule ni erreur', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(25 * 60);
  const s = ok(await call('select', { project: 'Studio' }));
  assert.equal(rows().length, 1);
  assert.equal(s.running.id, 'a1');
  assert.equal(s.running.end, null);
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Dev' });
});
