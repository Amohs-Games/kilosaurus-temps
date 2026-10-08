// Annuler, supprimer, corriger (server/core.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, ok, fails } from './server-harness.mjs';

const undo = async (call) => {
  const s = ok(await call('status'));
  return call('undo', { opId: s.undo.opId });
};

test('annuler un lancement : comme s\'il n\'avait pas eu lieu, l\'id reste pris', async () => {
  const { call, row, rows } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(await undo(call));
  assert.equal(s.running, null);
  assert.equal(s.undo, null);
  assert.ok(row('a1').deleted_ms);
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(rows().length, 1, 'une requête rejouée après l\'annulation ne recrée rien');
  assert.equal(ok(await call('status')).running, null);
});

test('annuler une bascule : l\'ancien compteur repart, le nouveau disparaît', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(30);
  ok(await call('start', { id: 'a2', project: 'Studio' }));
  const s = ok(await undo(call));
  assert.equal(s.running.id, 'a1');
  assert.equal(row('a1').end_ms, null);
  assert.ok(row('a2').deleted_ms);
});

test('annuler un arrêt : le compteur repart', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(30);
  ok(await call('stop'));
  assert.equal(ok(await undo(call)).running.id, 'a1');
});

test('annulations en chaîne : on remonte une action à la fois', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(30);
  ok(await call('stop'));
  ok(await call('logBlock', { id: 'b1', project: 'Studio', hours: 2 }));
  let s = ok(await undo(call));
  assert.deepEqual(s.today.map((r) => r.id), ['a1']);
  assert.match(s.undo.summary, /^Arrêt Fluffy/);
  s = ok(await undo(call));
  assert.equal(s.running.id, 'a1');
  s = ok(await undo(call));
  assert.equal(s.running, null);
  assert.deepEqual(s.today, []);
  assert.equal(s.undo, null);
});

test('annuler : seulement la dernière action ; une annulation rejouée ne fait rien', async () => {
  const { call, clock } = await makeEnv();
  const first = ok(await call('start', { id: 'a1', project: 'Fluffy' })).undo.opId;
  clock.advance(10);
  const second = ok(await call('stop')).undo.opId;
  fails(await call('undo', { opId: first }), 'invalid', /autre action/);
  ok(await call('undo', { opId: second }));
  const s = ok(await call('undo', { opId: second }));
  assert.equal(s.running.id, 'a1', 'pas annulé deux fois');
  fails(await call('undo', { opId: 999 }), 'invalid');
  fails(await call('undo', {}), 'invalid');
});

test('annuler après une nouvelle action : la nouvelle d\'abord, puis la précédente non annulée', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  ok(await call('logBlock', { id: 'b2', project: 'Fluffy', hours: 4 }));
  ok(await undo(call));
  clock.advance(1);
  ok(await call('logBlock', { id: 'b3', project: 'Fluffy', hours: 6 }));
  let s = ok(await undo(call));
  assert.deepEqual(s.today.map((r) => r.id), ['b1']);
  s = ok(await undo(call));
  assert.deepEqual(s.today, []);
});

test('annuler : refusé si la ligne a changé depuis', async () => {
  const { call, sqlite } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  sqlite.prepare("UPDATE entries SET note = 'à la main' WHERE id = 'a1'").run();
  fails(await undo(call), 'invalid', /a changé/);
});

test('annuler une note, un nouveau projet', async () => {
  const { call } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', note: 'avant' }));
  ok(await call('note', { text: 'après' }));
  assert.equal(ok(await undo(call)).running.note, 'avant');
  ok(await call('addProject', { name: 'Heirfall' }));
  assert.deepEqual(ok(await undo(call)).projects, ['Fluffy', 'Studio']);
});

test('supprimer un bloc ; annuler le fait revenir', async () => {
  const { call } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 4 }));
  let s = ok(await call('deleteEntry', { id: 'b1' }));
  assert.deepEqual(s.today, []);
  assert.match(s.undo.summary, /^Suppression bloc 4 h Fluffy/);
  assert.deepEqual(ok(await call('history', { from: '2026-10-01', to: '2026-10-01' })).rows, []);
  s = ok(await undo(call));
  assert.deepEqual(s.today.map((r) => r.id), ['b1']);
});

test('supprimer le compteur en cours : il s\'arrête sans rien compter', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  const s = ok(await call('deleteEntry', { id: 'a1' }));
  assert.equal(s.running, null);
  assert.deepEqual(s.today, []);
  assert.equal(ok(await undo(call)).running.id, 'a1');
});

test('supprimer : ligne inconnue → invalid ; déjà supprimée → rien', async () => {
  const { call } = await makeEnv();
  fails(await call('deleteEntry', { id: 'zz' }), 'invalid');
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 4 }));
  const op = ok(await call('deleteEntry', { id: 'b1' })).undo.opId;
  assert.equal(ok(await call('deleteEntry', { id: 'b1' })).undo.opId, op, 'pas de seconde entrée au journal');
});

test('corriger une session : fin, début (le jour suit), projet, type, note', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(await call('stop'));
  clock.advance(60);
  let s = ok(await call('editEntry', { id: 'a1', end: '2026-10-01T10:30:00+02:00' }));
  assert.equal(s.last.hours, 1.5);
  assert.match(s.undo.summary, /^Correction Fluffy/);
  s = ok(await call('editEntry', { id: 'a1', start: '2026-09-30T23:30:00+02:00', project: 'Studio', type: 'Dev', note: 'nuit' }));
  assert.equal(s.last.date, '2026-09-30');
  assert.equal(s.last.project, 'Studio');
  assert.equal(s.last.type, 'Dev');
  assert.equal(s.last.note, 'nuit');
  assert.equal(s.last.hours, 11);
});

test('corriger : chevauchement, fin avant début, futur, plus de 24 h refusés', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(await call('start', { id: 'a2', project: 'Studio' }));
  clock.advance(60);
  ok(await call('stop'));
  fails(await call('editEntry', { id: 'a1', end: '2026-10-01T10:30:00+02:00' }), 'invalid', /Chevauche/);
  fails(await call('editEntry', { id: 'a2', end: '2026-10-01T09:30:00+02:00' }), 'invalid');
  fails(await call('editEntry', { id: 'a2', end: '2026-10-01T23:00:00+02:00' }), 'invalid');
  fails(await call('editEntry', { id: 'a1', start: '2026-09-30T08:00:00+02:00' }), 'invalid', /24 h/);
  fails(await call('editEntry', { id: 'a2', hours: 4 }), 'invalid');
  fails(await call('editEntry', { id: 'zz', note: 'x' }), 'invalid');
});

test('corriger le compteur en cours : le début oui, la fin non (c\'est STOP)', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  const s = ok(await call('editEntry', { id: 'a1', start: '2026-10-01T08:30:00+02:00' }));
  assert.equal(s.running.start, new Date('2026-10-01T08:30:00+02:00').toISOString());
  fails(await call('editEntry', { id: 'a1', end: '2026-10-01T09:30:00+02:00' }), 'invalid', /STOP/);
});

test('corriger un bloc : ses heures (2 à 12), jamais un début', async () => {
  const { call } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8 }));
  fails(await call('editEntry', { id: 'b1', hours: 7 }), 'invalid');
  fails(await call('editEntry', { id: 'b1', start: '2026-10-01T08:00:00+02:00' }), 'invalid');
  assert.equal(ok(await call('editEntry', { id: 'b1', hours: 6 })).last.hours, 6);
  assert.equal(ok(await undo(call)).last.hours, 8);
});

test('corriger sans rien changer : aucune entrée au journal', async () => {
  const { call } = await makeEnv();
  const op = ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, note: 'x' })).undo.opId;
  assert.equal(ok(await call('editEntry', { id: 'b1', hours: 8, note: 'x', project: 'Fluffy' })).undo.opId, op);
});

// Journal généralisé : tâches et réglages s'annulent comme les entrées.
test('annuler une écriture de tâche et de réglages : tâche supprimée, réglage rétabli, réglage neuf retiré', async () => {
  const { commit, change } = await import('../server/core.js');
  const { call, sqlite, env, clock } = await makeEnv();
  const task = {
    id: 't1', description: 'Rigger', project: 'Fluffy', type: 'Misc', position: 1, done_day: null, started_ms: null,
    done_ms: null, source: 'app', created_ms: clock.now(), touched_ms: clock.now(), deleted_ms: null,
  };
  const ctx = { db: env.db, now: clock.now(), agent: false, offline: false };
  await commit(ctx, 'test', 'Écritures mêlées', [
    change(null, task, 'tasks'),
    change({ key: 'me', value: 'Amohs' }, { key: 'me', value: 'Autre' }, 'settings'),
    change(null, { key: 'neuf', value: '1' }, 'settings'),
  ]);
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key = 'me'").get().value, 'Autre');
  ok(await undo(call));
  assert.ok(sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get('t1').deleted_ms, 'tâche marquée supprimée');
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key = 'me'").get().value, 'Amohs');
  assert.equal(sqlite.prepare("SELECT * FROM settings WHERE key = 'neuf'").get(), undefined);
});

test('annuler refusé si la tâche a changé entre-temps', async () => {
  const { commit, change } = await import('../server/core.js');
  const { call, sqlite, env, clock } = await makeEnv();
  const task = {
    id: 't1', description: 'Rigger', project: 'Fluffy', type: 'Misc', position: 1, done_day: null, started_ms: null,
    done_ms: null, source: 'app', created_ms: clock.now(), touched_ms: clock.now(), deleted_ms: null,
  };
  await commit({ db: env.db, now: clock.now(), agent: false, offline: false }, 'test', 'Tâche', [change(null, task, 'tasks')]);
  sqlite.prepare("UPDATE tasks SET description = 'Autre' WHERE id = 't1'").run();
  fails(await undo(call), 'invalid', /a changé depuis/);
});
