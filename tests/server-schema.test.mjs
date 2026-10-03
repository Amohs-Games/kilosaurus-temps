// Règles posées dans la base (server/schema.sql) et fuseau de Paris (server/tz.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, insertRow, at } from './server-harness.mjs';
import { fromSqlite } from '../server/db.js';
import { dayKey, dayStart, nextDayStart, clock, shortDate } from '../server/tz.js';

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

test('base : un bloc a des heures entre 0 et 24, ni début ni fin', () => {
  const db = makeDb();
  insertRow(db, { id: 'a', kind: 'block', start_ms: null, hours: 3.5 });
  assert.throws(() => insertRow(db, { id: 'b', kind: 'block', start_ms: null, hours: 0 }), /CHECK/);
  assert.throws(() => insertRow(db, { id: 'c', kind: 'block', start_ms: null, hours: 25 }), /CHECK/);
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
