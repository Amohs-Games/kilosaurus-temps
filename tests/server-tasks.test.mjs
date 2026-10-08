// Tâches (server/core.js) : actions, liste du status, et règle de la tâche du haut.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClock, ok, fails, at } from './server-harness.mjs';

const opsCount = (sqlite) => sqlite.prepare('SELECT COUNT(*) AS n FROM ops').get().n;
const taskRow = (sqlite, id) => sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const snapshot = (sqlite) => JSON.stringify({
  tasks: sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(),
  entries: sqlite.prepare('SELECT * FROM entries ORDER BY id').all(),
  settings: sqlite.prepare('SELECT * FROM settings ORDER BY key').all(),
});
const ids = (s) => s.tasks.map((t) => t.id);

test('addTask sur liste vide, compteur arrêté : le choix devient celui de la tâche, aucune session', async () => {
  const { call, rows, sqlite } = await makeEnv();
  const s = ok(await call('addTask', { id: 'a', description: '  Appel avec Léa ', project: 'Studio', type: 'Social' }));
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Social' });
  assert.equal(rows().length, 0);
  assert.equal(opsCount(sqlite), 1);
  assert.deepEqual(s.tasks, [{ id: 'a', description: 'Appel avec Léa', project: 'Studio', type: 'Social', position: 1, done: null, started: null }]);
});

test('addTask : défaut = le choix ; une deuxième tâche ne change pas le choix', async () => {
  const { call } = await makeEnv();
  ok(await call('select', { project: 'Studio', type: 'Art' }));
  let s = ok(await call('addTask', { id: 'a', description: 'A' }));
  assert.equal(s.tasks[0].project, 'Studio');
  assert.equal(s.tasks[0].type, 'Art');
  s = ok(await call('addTask', { id: 'b', description: 'B', project: 'Fluffy', type: 'Dev' }));
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Art' });
  assert.deepEqual(ids(s), ['a', 'b']);
  assert.deepEqual(s.tasks.map((t) => t.position), [1, 2]);
});

async function twoTasksRunning() {
  const env = await makeEnv();
  const { call, clock } = env;
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }));
  ok(await call('start', { id: 's1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  return env;
}

test('checkTask compteur en marche : bascule à la même seconde sur la tâche suivante', async () => {
  const { call, rows, clock, sqlite } = await twoTasksRunning();
  // Le compteur tourne sur Fluffy·Dev alors que le haut est A (Studio·Social) : pas de bascule au start.
  const before = opsCount(sqlite);
  const s = ok(await call('checkTask', { id: 'A' }));
  const [a, b] = rows();
  assert.equal(a.end_ms, clock.now());
  assert.equal(b.start_ms, clock.now());
  assert.equal(b.end_ms, null);
  assert.equal(b.project, 'Fluffy');
  assert.equal(b.type, 'Art');
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  assert.equal(opsCount(sqlite), before + 1);
  const done = s.tasks.find((t) => t.id === 'A');
  assert.equal(done.done, new Date(clock.now()).toISOString());
  assert.equal(done.started, new Date(at('2026-10-01T06:00:00+02:00')).toISOString());
  assert.deepEqual(ids(s), ['B', 'A']);
});

test('deuxième coche le même jour : started = done de la précédente', async () => {
  const { call, clock } = await twoTasksRunning();
  ok(await call('checkTask', { id: 'A' }));
  clock.advance(45);
  const s = ok(await call('checkTask', { id: 'B' }));
  const a = s.tasks.find((t) => t.id === 'A');
  const b = s.tasks.find((t) => t.id === 'B');
  assert.equal(b.started, a.done);
  assert.equal(b.done, new Date(clock.now()).toISOString());
});

test('coche à 05:30 : jour de travail de la veille, started = 6 h de la veille', async () => {
  const clock = makeClock('2026-10-02T05:30:00+02:00');
  const { call, sqlite } = await makeEnv({ clock });
  ok(await call('addTask', { id: 'A', description: 'A' }));
  ok(await call('checkTask', { id: 'A' }));
  const r = taskRow(sqlite, 'A');
  assert.equal(r.done_day, '2026-10-01');
  assert.equal(r.started_ms, at('2026-10-01T06:00:00+02:00'));
  assert.equal(r.done_ms, clock.now());
});

test('en pause : la pause continue, le choix devient la tâche suivante', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }));
  ok(await call('start', { id: 'w', project: 'Studio', type: 'Social' }));
  clock.advance(10);
  ok(await call('start', { id: 'p', project: 'Studio', type: 'Pause' }));
  clock.advance(5);
  const s = ok(await call('checkTask', { id: 'A' }));
  assert.equal(rows().length, 2);
  assert.equal(s.running.type, 'Pause');
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
});

test('choix manuel respecté tant que la tâche du haut ne change pas', async () => {
  const { call, clock } = await twoTasksRunning();
  ok(await call('addTask', { id: 'C', description: 'C', project: 'Studio', type: 'Dev' }));
  ok(await call('checkTask', { id: 'A' }));
  clock.advance(1);
  let s = ok(await call('select', { project: 'Studio' }));
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Art' });
  s = ok(await call('editTask', { id: 'C', description: 'C bis', type: 'Writing' }));
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Art' });
  assert.equal(s.running.project, 'Studio');
});

test('editTask de la tâche du haut : le choix suit et le compteur bascule', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Fluffy', type: 'Dev' }));
  ok(await call('start', { id: 's', project: 'Fluffy', type: 'Dev' }));
  clock.advance(20);
  const s = ok(await call('editTask', { id: 'A', type: 'Art' }));
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  const [a, b] = rows();
  assert.equal(a.end_ms, clock.now());
  assert.equal(b.start_ms, clock.now());
  assert.equal(b.type, 'Art');
});

test('editTask sans changement : aucune entrée ops ; description seule : le choix ne bouge pas', async () => {
  const { call, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Fluffy', type: 'Dev' }));
  const n = opsCount(sqlite);
  ok(await call('editTask', { id: 'A', description: ' A ', project: 'Fluffy' }));
  assert.equal(opsCount(sqlite), n);
  ok(await call('editTask', { id: 'A', description: 'Autre' }));
  assert.equal(opsCount(sqlite), n + 1);
  assert.equal(taskRow(sqlite, 'A').description, 'Autre');
  fails(await call('editTask', { id: 'zzz', description: 'x' }), 'invalid', /Tâche introuvable/);
});

test('moveTask qui met B en haut : bascule sur B ; sans changement : aucune entrée ops', async () => {
  const { call, rows, clock, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }));
  ok(await call('addTask', { id: 'C', description: 'C', project: 'Fluffy', type: 'Dev' }));
  ok(await call('start', { id: 's', project: 'Studio', type: 'Social' }));
  clock.advance(15);
  let n = opsCount(sqlite);
  let s = ok(await call('moveTask', { id: 'B', before: 'A' }));
  assert.deepEqual(ids(s), ['B', 'A', 'C']);
  assert.deepEqual(s.tasks.map((t) => t.position), [1, 2, 3]);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  assert.equal(rows().length, 2);
  assert.equal(rows()[1].type, 'Art');
  assert.equal(opsCount(sqlite), n + 1);
  n = opsCount(sqlite);
  ok(await call('moveTask', { id: 'B', before: 'A' }));
  ok(await call('moveTask', { id: 'C', before: null }));
  assert.equal(opsCount(sqlite), n);
  s = ok(await call('moveTask', { id: 'A', before: null }));
  assert.deepEqual(ids(s), ['B', 'C', 'A']);
  fails(await call('moveTask', { id: 'A', before: 'A' }), 'invalid');
  fails(await call('moveTask', { id: 'A', before: 'nope' }), 'invalid');
});

test('moveTask ne réécrit que les positions qui changent', async () => {
  const { call, sqlite } = await makeEnv();
  for (const id of ['A', 'B', 'C']) ok(await call('addTask', { id, description: id }));
  const touchedA = taskRow(sqlite, 'A').touched_ms;
  ok(await call('moveTask', { id: 'C', before: 'B' }));
  const op = sqlite.prepare('SELECT changes FROM ops ORDER BY id DESC LIMIT 1').get();
  const keys = JSON.parse(op.changes).filter((c) => c.table === 'tasks').map((c) => c.key).sort();
  assert.deepEqual(keys, ['B', 'C']);
  assert.equal(taskRow(sqlite, 'A').touched_ms, touchedA);
});

test('deleteTask de la tâche du haut : la suivante s’applique ; la dernière : rien ne change', async () => {
  const { call, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }));
  let s = ok(await call('deleteTask', { id: 'A' }));
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  assert.deepEqual(ids(s), ['B']);
  assert.notEqual(taskRow(sqlite, 'A').deleted_ms, null);
  const n = opsCount(sqlite);
  ok(await call('deleteTask', { id: 'A' }));
  assert.equal(opsCount(sqlite), n);
  ok(await call('select', { project: 'Studio', type: 'Dev' }));
  s = ok(await call('deleteTask', { id: 'B' }));
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Dev' });
  assert.deepEqual(s.tasks, []);
  fails(await call('deleteTask', { id: 'nope' }), 'invalid', /Tâche introuvable/);
});

test('uncheckTask : la tâche revient à sa place et s’applique si elle redevient en haut', async () => {
  const { call, clock, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }));
  ok(await call('checkTask', { id: 'A' }));
  clock.advance(5);
  const n = opsCount(sqlite);
  let s = ok(await call('uncheckTask', { id: 'A' }));
  assert.deepEqual(ids(s), ['A', 'B']);
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Social' });
  const r = taskRow(sqlite, 'A');
  assert.equal(r.done_ms, null);
  assert.equal(r.done_day, null);
  assert.equal(r.started_ms, null);
  assert.equal(r.position, 1);
  assert.equal(opsCount(sqlite), n + 1);
  ok(await call('uncheckTask', { id: 'A' }));
  assert.equal(opsCount(sqlite), n + 1);
});

test('undo d’une coche avec bascule remet la tâche, les deux sessions et le choix', async () => {
  const { call, clock, sqlite } = await twoTasksRunning();
  clock.advance(1);
  const before = snapshot(sqlite);
  const s = ok(await call('checkTask', { id: 'A' }));
  assert.notEqual(snapshot(sqlite), before);
  ok(await call('undo', { opId: s.undo.opId }));
  const restored = JSON.parse(snapshot(sqlite));
  const expected = JSON.parse(before);
  // La session ouverte par la bascule reste en base, marquée supprimée (son id reste pris).
  assert.deepEqual(restored.tasks, expected.tasks);
  assert.deepEqual(restored.settings, expected.settings);
  assert.deepEqual(restored.entries.filter((e) => e.deleted_ms == null), expected.entries);
  const s2 = ok(await call('status'));
  assert.equal(s2.running.id, 's1');
  assert.equal(s2.tasks.find((t) => t.id === 'A').done, null);
});

test('idempotence : rejouer checkTask n’écrit ni ne bascule une seconde fois', async () => {
  const { call, rows, clock, sqlite } = await twoTasksRunning();
  ok(await call('checkTask', { id: 'A' }));
  const n = opsCount(sqlite);
  const count = rows().length;
  clock.advance(1);
  ok(await call('checkTask', { id: 'A' }));
  assert.equal(opsCount(sqlite), n);
  assert.equal(rows().length, count);
  ok(await call('addTask', { id: 'A', description: 'autre texte' }));
  assert.equal(opsCount(sqlite), n);
  assert.equal(taskRow(sqlite, 'A').description, 'A');
});

test('hors ligne : checkTask bascule à l’heure du tap', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  clock.advance(30);
  const tap = new Date(clock.now() - 10 * 60000).toISOString();
  const s = ok(await call('checkTask', { id: 'A', offline: true, clientTime: tap }));
  assert.equal(rows()[0].end_ms, Date.parse(tap));
  assert.equal(rows()[1].start_ms, Date.parse(tap));
  assert.equal(s.tasks.find((t) => t.id === 'A').done, tap);
});

test('compteur oublié (> 24 h) : la coche réussit, pas de bascule, le choix change', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }));
  ok(await call('start', { id: 's', project: 'Studio', type: 'Social' }));
  clock.advance(25 * 60);
  const s = ok(await call('checkTask', { id: 'A' }));
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].end_ms, null);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  assert.notEqual(s.tasks.find((t) => t.id === 'A').done, null);
});

test('validation des tâches', async () => {
  const { call, sqlite } = await makeEnv();
  fails(await call('addTask', { id: 'a', description: '   ' }), 'invalid', /Description vide/);
  fails(await call('addTask', { id: 'a', description: 'x'.repeat(201) }), 'invalid', /trop longue/);
  fails(await call('addTask', { id: 'a', description: 'ok'.repeat(101) }), 'invalid', /trop longue/);
  fails(await call('addTask', { id: 'a', description: 'a\u0000b' }), 'invalid', /contrôle/);
  fails(await call('addTask', { id: 'a', description: 'ok', project: 'Inconnu' }), 'invalid', /Projet inconnu/);
  fails(await call('addTask', { id: 'a', description: 'ok', type: 'Pause' }), 'invalid');
  fails(await call('addTask', { id: 'a', description: 'ok', type: 'Nope' }), 'invalid');
  fails(await call('addTask', { description: 'ok' }), 'invalid');
  assert.equal(opsCount(sqlite), 0);
  ok(await call('addTask', { id: 'a', description: 'x'.repeat(200) }));
  fails(await call('editTask', { id: 'a', type: 'Pause' }), 'invalid');
  fails(await call('editTask', { id: 'a', description: '' }), 'invalid');
  fails(await call('editTask', { id: 'a', project: 'Inconnu' }), 'invalid');
});

test('status.tasks : à faire puis faites du jour ; une coche d’avant 6 h n’apparaît plus mais reste en base', async () => {
  const clock = makeClock('2026-10-01T22:00:00+02:00');
  const { call, sqlite } = await makeEnv({ clock });
  for (const id of ['A', 'B', 'C']) ok(await call('addTask', { id, description: id }));
  ok(await call('checkTask', { id: 'B' }));
  clock.advance(10);
  ok(await call('checkTask', { id: 'A' }));
  let s = ok(await call('status'));
  assert.deepEqual(ids(s), ['C', 'B', 'A']);
  clock.set('2026-10-02T06:00:01+02:00');
  s = ok(await call('status'));
  assert.deepEqual(ids(s), ['C']);
  assert.equal(taskRow(sqlite, 'A').done_day, '2026-10-01');
  assert.notEqual(taskRow(sqlite, 'B'), undefined);
});

test('status initial : tasks est vide', async () => {
  const { call } = await makeEnv();
  assert.deepEqual(ok(await call('status')).tasks, []);
});
