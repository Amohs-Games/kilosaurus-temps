// Règles posées dans la base (server/schema.sql) et fuseau de Paris (server/tz.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, insertRow, at, SCHEMA } from './server-harness.mjs';
import { readFileSync } from 'node:fs';
import { fromSqlite } from '../server/db.js';
import { dayKey, dayStart, nextDayStart, clock, shortDate, localTime, previousDayKey, workDayKey, workDayEnd } from '../server/tz.js';

test('base : un seul compteur en cours', () => {
  const db = makeDb();
  insertRow(db, { id: 'a', start_ms: at('2026-10-01T09:00:00+02:00') });
  assert.throws(() => insertRow(db, { id: 'b', start_ms: at('2026-10-01T10:00:00+02:00') }), /UNIQUE constraint failed: entries\.kind/);
  // Un compteur supprimé ne compte pas.
  db.prepare('UPDATE entries SET deleted_ms = 1 WHERE id = ?').run('a');
  insertRow(db, { id: 'b', start_ms: at('2026-10-01T10:00:00+02:00') });
});

test('base : fin avant le début, plus de 24 h → refusé ; durée nulle permise', () => {
  const db = makeDb();
  const t = at('2026-10-01T09:00:00+02:00');
  assert.throws(() => insertRow(db, { id: 'a', start_ms: t, end_ms: t - 1 }), /CHECK/);
  assert.throws(() => insertRow(db, { id: 'b', start_ms: t, end_ms: t + 24 * 3600000 + 1 }), /CHECK/);
  insertRow(db, { id: 'c', start_ms: t, end_ms: t });
  insertRow(db, { id: 'd', start_ms: t, end_ms: t + 24 * 3600000 });
});

test('base : un bloc a des heures positives (sans plafond : blocs repris), ni début ni fin', () => {
  const db = makeDb();
  insertRow(db, { id: 'a', kind: 'block', start_ms: null, hours: 3.5 });
  assert.throws(() => insertRow(db, { id: 'b', kind: 'block', start_ms: null, hours: 0 }), /CHECK/);
  insertRow(db, { id: 'c', kind: 'block', start_ms: null, hours: 72 });
  assert.throws(() => insertRow(db, { id: 'c2', kind: 'block', start_ms: null, hours: -1 }), /CHECK/);
  assert.throws(() => insertRow(db, { id: 'd', kind: 'block', start_ms: at('2026-10-01T09:00:00+02:00'), hours: 4 }), /CHECK/);
  assert.throws(() => insertRow(db, { id: 'e', kind: 'session', start_ms: null }), /CHECK/);
});

test('accès : batch tout ou rien', async () => {
  const sqlite = makeDb();
  const db = fromSqlite(sqlite);
  const t = at('2026-10-01T09:00:00+02:00');
  const ins = (id) => ({
    sql: 'INSERT INTO entries (id, project, kind, day, start_ms, type, source, created_ms, touched_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [id, 'Fluffy', 'session', '2026-10-01', t, 'Misc', 'app', t, t],
  });
  await assert.rejects(db.batch([ins('a'), ins('b')]), /UNIQUE/);
  assert.equal((await db.all('SELECT * FROM entries')).length, 0, 'rien écrit');
  assert.equal(await db.first('SELECT * FROM entries WHERE id = ?', ['zz']), null);
});

test('fuseau : jour de Paris, début de jour, heure affichée', () => {
  assert.equal(dayKey(at('2026-09-30T23:30:00Z')), '2026-10-01');
  assert.equal(dayStart('2026-10-01'), at('2026-09-30T22:00:00Z'));
  assert.equal(clock(at('2026-10-01T07:05:00Z')), '09:05');
  assert.equal(shortDate(at('2026-10-01T07:05:00Z')), '01/10');
});

test('fuseau : changement d\'heure (25 octobre 2026, jour de 25 h)', () => {
  const start = dayStart('2026-10-25');
  assert.equal(start, at('2026-10-24T22:00:00Z'));
  assert.equal(nextDayStart(start), at('2026-10-25T23:00:00Z'));
  assert.equal(dayStart('2026-03-29'), at('2026-03-28T23:00:00Z'));
});

test('fuseau : jour de travail de 6 h à 6 h, sûr aux changements d\'heure', () => {
  assert.equal(previousDayKey('2026-03-01'), '2026-02-28');
  assert.equal(previousDayKey('2026-10-26'), '2026-10-25');
  assert.equal(localTime('2026-10-08', 6), at('2026-10-08T06:00:00+02:00'));
  assert.equal(workDayKey(at('2026-10-08T05:59:00+02:00')), '2026-10-07');
  assert.equal(workDayKey(at('2026-10-08T06:00:00+02:00')), '2026-10-08');
  assert.equal(workDayKey(at('2026-10-08T23:30:00+02:00')), '2026-10-08');
  // 25 octobre 2026 : retour à l'heure d'hiver à 3 h ; 6 h = 05:00 UTC.
  assert.equal(workDayEnd('2026-10-24'), at('2026-10-25T05:00:00Z'));
  assert.equal(workDayKey(at('2026-10-25T05:30:00+01:00')), '2026-10-24');
  // 29 mars 2026 : passage à l'heure d'été à 2 h ; 6 h = 04:00 UTC.
  assert.equal(workDayEnd('2026-03-28'), at('2026-03-29T04:00:00Z'));
  assert.equal(workDayEnd('2026-10-07'), at('2026-10-08T06:00:00+02:00'));
});

test('base : journées figées, ni modifiées ni effacées', () => {
  const db = makeDb();
  db.prepare("INSERT INTO archive_days (day, archived_ms, row_count, hours) VALUES ('2026-10-01', 1, 1, 1)").run();
  assert.throws(() => db.prepare('UPDATE archive_days SET row_count = 5').run(), /archive figée/);
  assert.throws(() => db.prepare('DELETE FROM archive_days').run(), /archive figée/);
  insertRow(db, { id: 'a', start_ms: at('2026-10-01T09:00:00+02:00'), end_ms: at('2026-10-01T10:00:00+02:00') });
  db.prepare("INSERT INTO archive_entries SELECT '2026-10-01', * FROM entries").run();
  assert.equal(db.prepare('SELECT id FROM archive_entries').get().id, 'a');
  assert.throws(() => db.prepare("UPDATE archive_entries SET note = 'x'").run(), /archive figée/);
  assert.throws(() => db.prepare('DELETE FROM archive_entries').run(), /archive figée/);
  assert.throws(() => db.prepare("INSERT INTO archive_entries SELECT '2026-10-01', * FROM entries").run(), /UNIQUE/);
  db.exec(SCHEMA); // réappliquer le schéma (mise à jour en ligne) ne casse rien
});

const TASK = {
  id: 't1', description: 'Rigger le bras', project: 'Fluffy', type: 'Misc', position: 1, done_day: null, started_ms: null,
  done_ms: null, source: 'app', created_ms: 1, touched_ms: 1, deleted_ms: null,
};
function insertTask(db, fields = {}, table = 'tasks') {
  const row = { ...TASK, ...fields };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
}

test('base : tâches, une coche porte son jour de travail', () => {
  const db = makeDb();
  insertTask(db);
  insertTask(db, { id: 't2', done_ms: 5, done_day: '2026-10-01' });
  assert.throws(() => insertTask(db, { id: 't3', done_ms: 5 }), /CHECK/);
  assert.throws(() => insertTask(db, { id: 't4', done_day: '2026-10-01' }), /CHECK/);
});

test('base : tâches figées, ni modifiées ni effacées', () => {
  const db = makeDb();
  insertTask(db);
  db.prepare("INSERT INTO archive_tasks SELECT '2026-10-01', * FROM tasks").run();
  assert.equal(db.prepare('SELECT id FROM archive_tasks').get().id, 't1');
  assert.throws(() => db.prepare("UPDATE archive_tasks SET description = 'x'").run(), /archive figée/);
  assert.throws(() => db.prepare('DELETE FROM archive_tasks').run(), /archive figée/);
  db.exec(SCHEMA);
});

test('migrations 2026-10-12 puis 2026-10-13 : une base d’avant arrive à la même forme qu’une base neuve, liens gardés', () => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const migration = (name) => readFileSync(new URL(`../server/migrations/${name}.sql`, import.meta.url), 'utf8');
  // Le schéma d'avant les tâches actives : sans la colonne des tâches.
  const before = SCHEMA.replace(/^[ \t]*task_ids TEXT,[^\n]*\n([ \t]*--[^\n]*\n)*/gm, '');
  assert.ok(!/task_/.test(before), 'schéma d’avant reconstruit');
  const old = new DatabaseSync(':memory:');
  old.exec(before);
  old.exec(migration('2026-10-12-taches-actives'));
  // Une session liée par la première version (une seule tâche) garde sa tâche.
  insertRow(old, { id: 'lie', start_ms: at('2026-10-01T09:00:00+02:00'), end_ms: at('2026-10-01T10:00:00+02:00') });
  old.prepare("UPDATE entries SET task_id = 'T1' WHERE id = 'lie'").run();
  old.exec(migration('2026-10-13-taches-paralleles'));
  old.exec(SCHEMA); // db:schema après les migrations : rien ne casse
  const fresh = makeDb();
  const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => `${c.name}:${c.type}`);
  for (const table of ['entries', 'archive_entries']) {
    assert.deepEqual(cols(old, table), cols(fresh, table), table);
    assert.equal(cols(fresh, table).at(-1), 'task_ids:TEXT', `${table} : task_ids en dernier`);
  }
  assert.equal(old.prepare("SELECT task_ids FROM entries WHERE id = 'lie'").get().task_ids, 'T1');
  assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'entries_task'").get(), undefined);
});
