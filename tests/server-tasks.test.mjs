// Tâches (server/core.js) : actions, liste du status, tâches en cours et tâches des morceaux
// (docs/specs/2026-10-13-taches-paralleles-design.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClock, ok, fails, insertRow } from './server-harness.mjs';

const opsCount = (sqlite) => sqlite.prepare('SELECT COUNT(*) AS n FROM ops').get().n;
const taskRow = (sqlite, id) => sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const snapshot = (sqlite) => JSON.stringify({
  tasks: sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(),
  entries: sqlite.prepare('SELECT * FROM entries ORDER BY id').all(),
  settings: sqlite.prepare('SELECT * FROM settings ORDER BY key').all(),
});
const ids = (s) => s.tasks.map((t) => t.id);
const task = (s, id) => s.tasks.find((t) => t.id === id);
const open = (rows) => rows.find((r) => r.end_ms == null);

// Deux tâches, A (Studio · Social) et B (Fluffy · Art), et un compteur sur Fluffy · Dev depuis 30 min.
async function twoTasksRunning() {
  const env = await makeEnv();
  const { call, clock } = env;
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }));
  ok(await call('start', { id: 's1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  return env;
}

// ---- Liste ----

test('addTask : ni choix ni compteur touchés, aucune tâche active', async () => {
  const { call, rows, sqlite } = await makeEnv();
  ok(await call('select', { project: 'Fluffy', type: 'Dev' }));
  const s = ok(await call('addTask', { id: 'a', description: '  Appel avec Léa ', project: 'Studio', type: 'Social' }));
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Dev' });
  assert.equal(s.activeTask, null);
  assert.equal(rows().length, 0);
  assert.equal(opsCount(sqlite), 2);
  assert.deepEqual(s.tasks, [{ id: 'a', description: 'Appel avec Léa', project: 'Studio', type: 'Social', position: 1, done: null, started: null, spentMs: 0 }]);
});

test('addTask : défaut = le choix', async () => {
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

test('valider, déplacer, supprimer, dévalider une tâche non active : ni choix ni compteur touchés', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  ok(await call('addTask', { id: 'C', description: 'C', project: 'Studio', type: 'Dev' }));
  const runBefore = open(rows());
  let s = ok(await call('checkTask', { id: 'A' }));
  s = ok(await call('moveTask', { id: 'C', before: 'B' }));
  s = ok(await call('deleteTask', { id: 'B' }));
  clock.advance(5);
  s = ok(await call('uncheckTask', { id: 'A' }));
  s = ok(await call('editTask', { id: 'C', type: 'Writing' }));
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Dev' });
  assert.equal(rows().length, 1);
  assert.equal(open(rows()).id, runBefore.id);
  assert.equal(s.activeTask, null);
  assert.deepEqual(ids(s), ['A', 'C']);
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

test('moveTask : nouvel ordre, positions 1..n ; sans changement : aucune entrée ops', async () => {
  const { call, sqlite } = await makeEnv();
  for (const id of ['A', 'B', 'C']) ok(await call('addTask', { id, description: id }));
  let n = opsCount(sqlite);
  let s = ok(await call('moveTask', { id: 'B', before: 'A' }));
  assert.deepEqual(ids(s), ['B', 'A', 'C']);
  assert.deepEqual(s.tasks.map((t) => t.position), [1, 2, 3]);
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

test('moveTask sans changement d’ordre, positions avec trous : rien ne s’écrit', async () => {
  const { call, sqlite } = await makeEnv();
  for (const id of ['A', 'B', 'C']) ok(await call('addTask', { id, description: id }));
  ok(await call('checkTask', { id: 'A' }));
  const n = opsCount(sqlite);
  const before = snapshot(sqlite);
  ok(await call('moveTask', { id: 'C', before: null }));
  assert.equal(opsCount(sqlite), n);
  assert.equal(snapshot(sqlite), before);
});

test('deleteTask : suppression douce, rejouée sans écriture', async () => {
  const { call, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A' }));
  const s = ok(await call('deleteTask', { id: 'A' }));
  assert.deepEqual(s.tasks, []);
  assert.notEqual(taskRow(sqlite, 'A').deleted_ms, null);
  const n = opsCount(sqlite);
  ok(await call('deleteTask', { id: 'A' }));
  assert.equal(opsCount(sqlite), n);
  fails(await call('deleteTask', { id: 'nope' }), 'invalid', /Tâche introuvable/);
});

test('checkTask : jour de travail de la validation ; coche à 05:30 = la veille', async () => {
  const clock = makeClock('2026-10-02T05:30:00+02:00');
  const { call, sqlite } = await makeEnv({ clock });
  ok(await call('addTask', { id: 'A', description: 'A' }));
  ok(await call('checkTask', { id: 'A' }));
  const r = taskRow(sqlite, 'A');
  assert.equal(r.done_day, '2026-10-01');
  assert.equal(r.done_ms, clock.now());
  assert.equal(r.started_ms, null, 'aucun morceau passé dessus : pas de début');
});

test('uncheckTask : la tâche reprend sa place, positions uniques, non active, choix intact', async () => {
  const { call, clock, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }));
  clock.advance(1);
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }));
  clock.advance(1);
  ok(await call('addTask', { id: 'C', description: 'C', project: 'Fluffy', type: 'Dev' }));
  ok(await call('activateTask', { id: 'A' }));
  ok(await call('checkTask', { id: 'A' }));
  ok(await call('select', { project: 'Fluffy', type: 'Misc' }));
  ok(await call('moveTask', { id: 'C', before: 'B' }));
  const n = opsCount(sqlite);
  const s = ok(await call('uncheckTask', { id: 'A' }));
  assert.deepEqual(ids(s), ['A', 'C', 'B']);
  assert.deepEqual(s.tasks.map((t) => t.position), [1, 2, 3]);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Misc' });
  assert.equal(s.activeTask, null);
  const r = taskRow(sqlite, 'A');
  assert.equal(r.done_ms, null);
  assert.equal(r.done_day, null);
  assert.equal(r.started_ms, null);
  assert.equal(opsCount(sqlite), n + 1);
  ok(await call('uncheckTask', { id: 'A' }));
  assert.equal(opsCount(sqlite), n + 1);
});

// ---- Tâches en cours (plusieurs à la fois) ----

const linked = (r) => (r.task_ids ? r.task_ids.split(',') : []);

test('activateTask compteur arrêté : le choix devient la tâche, rien ne se lance ; ▶ part avec elle', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  ok(await call('stop'));
  let s = ok(await call('activateTask', { id: 'A' }));
  assert.deepEqual(s.activeTasks, ['A']);
  assert.equal(s.activeTask, 'A', 'compatibilité : la dernière activée');
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Social' });
  assert.equal(s.running, null);
  clock.advance(5);
  s = ok(await call('start', { id: 's2', project: 'Studio', type: 'Social' }));
  assert.deepEqual(s.running.tasks, ['A']);
  assert.equal(s.running.task, 'A');
  assert.deepEqual(linked(open(rows())), ['A']);
});

test('deux tâches actives une heure : elles se partagent l’heure au calcul, 30 min chacune', async () => {
  const { call, clock } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
  let s = ok(await call('activateTask', { id: 'B' }));
  assert.deepEqual(s.activeTasks, ['A', 'B']);
  assert.deepEqual(s.running.tasks, ['A', 'B']);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' }, 'la dernière activée donne le choix');
  clock.advance(60);
  s = ok(await call('stop'));
  assert.equal(task(s, 'A').spentMs, 30 * 60000);
  assert.equal(task(s, 'B').spentMs, 30 * 60000);
});

test('activer une tâche de plus compteur en marche : nouveau morceau avec la liste, même seconde', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'B' }));
  clock.advance(20);
  ok(await call('activateTask', { id: 'A' }));
  const all = rows();
  const [prev, run] = all.slice(-2);
  assert.equal(prev.end_ms, clock.now());
  assert.deepEqual(linked(prev), ['B']);
  assert.equal(run.start_ms, clock.now());
  assert.deepEqual(linked(run), ['B', 'A']);
  assert.deepEqual([run.project, run.type], ['Studio', 'Social'], 'le compteur suit la tâche activée');
});

test('changer de projet ou d’activité ne désactive rien ; le morceau suivant garde toutes les tâches', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
  ok(await call('activateTask', { id: 'B' }));
  clock.advance(10);
  let s = ok(await call('select', { project: 'Studio', type: 'Dev' }));
  assert.deepEqual(s.activeTasks, ['A', 'B']);
  const run = open(rows());
  assert.deepEqual([run.project, run.type, run.start_ms], ['Studio', 'Dev', clock.now()]);
  assert.deepEqual(linked(run), ['A', 'B']);
  ok(await call('stop'));
  s = ok(await call('start', { id: 'w', project: 'Fluffy', type: 'Writing' }));
  assert.deepEqual(s.activeTasks, ['A', 'B'], 'un start ailleurs (widget) garde les tâches');
  assert.deepEqual(s.running.tasks, ['A', 'B']);
});

test('pause : aucune tâche ; REPRENDRE repart avec toutes ; STOP les garde', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
  ok(await call('activateTask', { id: 'B' }));
  clock.advance(10);
  let s = ok(await call('start', { id: 'p', project: 'Fluffy', type: 'Pause' }));
  assert.deepEqual(s.running.tasks, []);
  assert.deepEqual(s.activeTasks, ['A', 'B']);
  clock.advance(5);
  s = ok(await call('start', { id: 'r', project: 'Fluffy', type: 'Art' }));
  assert.deepEqual(s.running.tasks, ['A', 'B']);
  clock.advance(5);
  s = ok(await call('stop'));
  assert.deepEqual(s.activeTasks, ['A', 'B']);
  assert.equal(task(s, 'A').spentMs, 7.5 * 60000, 'la pause ne compte pas ; 15 min partagées entre A et B');
  assert.equal(rows().filter((r) => linked(r).includes('B')).length, 2);
});

test('activateTask : deux fois = une seule écriture ; 10 au plus ; une tâche validée refusée', async () => {
  const { call, sqlite } = await makeEnv();
  for (let i = 0; i < 11; i += 1) ok(await call('addTask', { id: `t${i}`, description: `t${i}` }));
  ok(await call('activateTask', { id: 't0' }));
  const n = opsCount(sqlite);
  ok(await call('activateTask', { id: 't0' }));
  assert.equal(opsCount(sqlite), n);
  for (let i = 1; i < 10; i += 1) ok(await call('activateTask', { id: `t${i}` }));
  fails(await call('activateTask', { id: 't10' }), 'invalid', /10 tâches en cours au plus/);
  ok(await call('checkTask', { id: 't0' }));
  fails(await call('activateTask', { id: 't0' }), 'invalid', /déjà validée/);
  fails(await call('activateTask', { id: 'nope' }), 'invalid', /Tâche introuvable/);
  ok(await call('activateTask', { id: 't10' }));
});

test('valider une tâche active compteur en marche : elle sort de la liste, le compteur continue avec les autres', async () => {
  const { call, rows, clock, sqlite } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
  const startA = clock.now();
  ok(await call('activateTask', { id: 'B' }));
  clock.advance(40);
  const n = opsCount(sqlite);
  const s = ok(await call('checkTask', { id: 'A' }));
  assert.equal(opsCount(sqlite), n + 1, 'une seule entrée de journal');
  assert.deepEqual(s.activeTasks, ['B']);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  const run = open(rows());
  assert.deepEqual([run.project, run.type, run.start_ms], ['Fluffy', 'Art', clock.now()]);
  assert.deepEqual(linked(run), ['B']);
  const done = task(s, 'A');
  assert.equal(done.done, new Date(clock.now()).toISOString());
  assert.equal(done.started, new Date(startA).toISOString());
  assert.equal(done.spentMs, 20 * 60000, '40 min partagées avec B');
});

test('deactivateTask { id } : retire celle-là ; sans id : toutes ; le choix reste ; rien à retirer : aucune écriture', async () => {
  const { call, rows, clock, sqlite } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
  ok(await call('activateTask', { id: 'B' }));
  clock.advance(10);
  let s = ok(await call('deactivateTask', { id: 'A' }));
  assert.deepEqual(s.activeTasks, ['B']);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  assert.deepEqual(linked(open(rows())), ['B']);
  assert.equal(open(rows()).start_ms, clock.now());
  const n = opsCount(sqlite);
  ok(await call('deactivateTask', { id: 'A' }));
  assert.equal(opsCount(sqlite), n);
  clock.advance(5);
  s = ok(await call('deactivateTask'));
  assert.deepEqual(s.activeTasks, []);
  assert.deepEqual(linked(open(rows())), []);
  ok(await call('deactivateTask'));
  assert.equal(opsCount(sqlite), n + 1);
});

test('editTask d’une tâche active : le projet ne bouge rien ; une autre activité ouvre un morceau avec les nouvelles activités', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Fluffy', type: 'Dev' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Dev' }));
  ok(await call('activateTask', { id: 'A' }));
  ok(await call('activateTask', { id: 'B' }));
  ok(await call('start', { id: 's', project: 'Fluffy', type: 'Dev' }));
  clock.advance(20);
  let s = ok(await call('editTask', { id: 'A', project: 'Studio' }));
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Dev' });
  assert.equal(rows().length, 1);
  s = ok(await call('editTask', { id: 'A', type: 'Art' }));
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Dev' }, 'le choix ne bouge pas');
  assert.deepEqual(s.activeTasks, ['A', 'B']);
  const [prev, run] = rows();
  assert.equal(prev.end_ms, clock.now());
  assert.equal(prev.task_types, 'Dev,Dev', 'le passé garde ses activités');
  assert.deepEqual([run.type, run.task_types, run.start_ms], ['Dev', 'Art,Dev', clock.now()]);
});

// ---- Activités d'un morceau ----

test('un morceau garde l’activité de chacune de ses tâches, dans leur ordre ; le temps n’y est pas divisé', async () => {
  const { call, rows } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
  let s = ok(await call('activateTask', { id: 'B' }));
  assert.deepEqual(s.running.taskTypes, ['Social', 'Art']);
  assert.equal(open(rows()).task_types, 'Social,Art');
  assert.equal(open(rows()).end_ms, null);
  s = ok(await call('start', { id: 'p', project: 'Fluffy', type: 'Pause' }));
  assert.deepEqual(s.running.taskTypes, [], 'une pause n’a pas de tâche');
  assert.equal(open(rows()).task_types, null);
  s = ok(await call('deactivateTask', { id: 'A' }));
  s = ok(await call('start', { id: 'r', project: 'Fluffy', type: 'Art' }));
  assert.deepEqual(s.running.taskTypes, ['Art']);
});

test('history renvoie l’activité de chaque tâche de chaque morceau', async () => {
  const { call, clock } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
  ok(await call('activateTask', { id: 'B' }));
  clock.advance(30);
  ok(await call('stop'));
  const h = ok(await call('history', { from: '2026-10-01', to: '2026-10-01' }));
  assert.deepEqual(h.rows.map((r) => r.taskTypes), [[], ['Social'], ['Social', 'Art']]);
});

test('deleteTask d’une tâche active : elle sort de la liste, le compteur continue avec les autres', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
  ok(await call('activateTask', { id: 'B' }));
  clock.advance(10);
  const s = ok(await call('deleteTask', { id: 'B' }));
  assert.deepEqual(s.activeTasks, ['A']);
  assert.deepEqual(linked(open(rows())), ['A']);
  assert.equal(open(rows()).start_ms, clock.now());
});

test('ancien réglage d’une seule tâche : lu, puis remplacé par la liste à la première écriture', async () => {
  const { call, sqlite } = await twoTasksRunning();
  sqlite.prepare("INSERT INTO settings (key, value) VALUES ('active_task', 'A')").run();
  let s = ok(await call('status'));
  assert.deepEqual(s.activeTasks, ['A']);
  s = ok(await call('activateTask', { id: 'B' }));
  assert.deepEqual(s.activeTasks, ['A', 'B']);
  const cfg = Object.fromEntries(sqlite.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  assert.equal(cfg.active_task, undefined);
  assert.equal(cfg.active_tasks, '["A","B"]');
});

test('des réglages qui visent une tâche validée ou supprimée l’ignorent : status et start aussi', async () => {
  const { call, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Fluffy', type: 'Dev' }));
  ok(await call('addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Dev' }));
  ok(await call('checkTask', { id: 'A' }));
  sqlite.prepare("INSERT INTO settings (key, value) VALUES ('active_tasks', '[\"A\",\"B\",\"zz\"]')").run();
  let s = ok(await call('status'));
  assert.deepEqual(s.activeTasks, ['B']);
  s = ok(await call('start', { id: 's', project: 'Fluffy', type: 'Dev' }));
  assert.deepEqual(s.running.tasks, ['B']);
});

test('un id de tâche avec une virgule est refusé', async () => {
  const { call } = await makeEnv();
  fails(await call('addTask', { id: 'a,b', description: 'x' }), 'invalid', /virgule/);
});

test('un morceau lié avant l’enregistrement des activités prend sa propre activité pour chaque tâche', async () => {
  const { call, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Fluffy', type: 'Art' }));
  insertRow(sqlite, { id: 'vieux', start_ms: Date.parse('2026-10-01T08:00:00+02:00'), end_ms: Date.parse('2026-10-01T08:30:00+02:00'), type: 'Dev' });
  sqlite.prepare("UPDATE entries SET task_ids = 'A' WHERE id = 'vieux'").run();
  const h = ok(await call('history', { from: '2026-10-01', to: '2026-10-01' }));
  assert.deepEqual(h.rows[0].taskTypes, ['Dev']);
});

// ---- Temps d'une tâche ----

test('spentMs : morceaux terminés qui la contiennent ; le morceau en cours n’y est pas ; corriger ou supprimer un morceau le corrige', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('addTask', { id: 'A', description: 'A', project: 'Fluffy', type: 'Dev' }));
  ok(await call('activateTask', { id: 'A' }));
  ok(await call('start', { id: 's1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  let s = ok(await call('stop'));
  assert.equal(task(s, 'A').spentMs, 30 * 60000);
  clock.advance(60);
  ok(await call('start', { id: 's2', project: 'Fluffy', type: 'Dev' }));
  clock.advance(15);
  s = ok(await call('status'));
  assert.equal(task(s, 'A').spentMs, 30 * 60000, 'le morceau en cours n’est pas compté');
  s = ok(await call('stop'));
  assert.equal(task(s, 'A').spentMs, 45 * 60000);
  const first = rows()[0];
  s = ok(await call('editEntry', { id: first.id, end: new Date(first.start_ms + 20 * 60000).toISOString() }));
  assert.equal(task(s, 'A').spentMs, 35 * 60000);
  s = ok(await call('deleteEntry', { id: 's2' }));
  assert.equal(task(s, 'A').spentMs, 20 * 60000);
});

// ---- Annulation, hors ligne, compteur oublié ----

for (const [label, action, params] of [
  ['activation', 'activateTask', { id: 'B' }],
  ['validation', 'checkTask', { id: 'B' }],
  ['désactivation d’une tâche', 'deactivateTask', { id: 'B' }],
  ['désactivation de toutes', 'deactivateTask', {}],
]) {
  test(`undo d’une ${label} remet tâches, compteur et réglages exactement`, async () => {
    const { call, clock, sqlite } = await twoTasksRunning();
    ok(await call('activateTask', { id: 'A' }));
    if (action !== 'activateTask') ok(await call('activateTask', { id: 'B' }));
    clock.advance(5);
    const before = JSON.parse(snapshot(sqlite));
    const s = ok(await call(action, params));
    ok(await call('undo', { opId: s.undo.opId }));
    const restored = JSON.parse(snapshot(sqlite));
    // La session ouverte par la bascule reste en base, marquée supprimée (son id reste pris).
    assert.deepEqual(restored.tasks, before.tasks);
    assert.deepEqual(restored.settings, before.settings);
    assert.deepEqual(restored.entries.filter((e) => e.deleted_ms == null), before.entries);
  });
}

test('idempotence : rejouer checkTask ou addTask n’écrit rien une seconde fois', async () => {
  const { call, rows, clock, sqlite } = await twoTasksRunning();
  ok(await call('activateTask', { id: 'A' }));
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

test('hors ligne : activateTask bascule à l’heure du tap', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  clock.advance(30);
  const tap = new Date(clock.now() - 10 * 60000).toISOString();
  ok(await call('activateTask', { id: 'B', offline: true, clientTime: tap }));
  assert.equal(rows()[0].end_ms, Date.parse(tap));
  assert.equal(rows()[1].start_ms, Date.parse(tap));
  assert.deepEqual(linked(rows()[1]), ['B']);
});

test('compteur oublié (> 24 h) : l’activation réussit, pas de bascule, le choix change', async () => {
  const { call, rows, clock } = await twoTasksRunning();
  clock.advance(25 * 60);
  const s = ok(await call('activateTask', { id: 'B' }));
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].end_ms, null);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  assert.deepEqual(s.activeTasks, ['B']);
});

// ---- Validation et lecture ----

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

test('status initial : tasks est vide, aucune tâche active', async () => {
  const { call } = await makeEnv();
  const s = ok(await call('status'));
  assert.deepEqual(s.tasks, []);
  assert.equal(s.activeTask, null);
});

test('liste limitée à 30 tâches à faire : addTask et uncheckTask refusent au-delà', async () => {
  const { call, sqlite } = await makeEnv();
  ok(await call('addTask', { id: 'first', description: 'première' }));
  ok(await call('checkTask', { id: 'first' }));
  for (let i = 0; i < 30; i += 1) ok(await call('addTask', { id: `t${i}`, description: `t${i}` }));
  const frozen = snapshot(sqlite);
  const n = opsCount(sqlite);
  fails(await call('addTask', { id: 'extra', description: 'de trop' }), 'invalid', /Liste pleine : 30 tâches à faire au plus\./);
  fails(await call('uncheckTask', { id: 'first' }), 'invalid', /Liste pleine : 30 tâches à faire au plus\./);
  assert.equal(snapshot(sqlite), frozen);
  assert.equal(opsCount(sqlite), n);
  ok(await call('checkTask', { id: 't0' }));
  ok(await call('addTask', { id: 'extra', description: 'de trop' }));
});
