// Sauvegardes : description des tables, empreinte, journées figées, export (server/backup.js, server/core.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeEnv, insertRow, ok, fails, at } from './server-harness.mjs';
import { TABLES, NOT_EXPORTED, fingerprintSql, fingerprintRows } from '../server/backup.js';
import { freezeDays, FREEZE_DAYS_PER_RUN } from '../server/core.js';

const plainRow = (r) => ({ ...r });

test('sauvegarde : toutes les tables du schéma sont décrites, colonne par colonne', () => {
  const db = makeDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual([...TABLES.map((t) => t.name), ...NOT_EXPORTED].sort(), names);
  for (const t of TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => c.name);
    assert.deepEqual(Object.keys(t.columns), cols, t.name);
  }
});

test('sauvegarde : l\'empreinte JavaScript égale celle de SQLite (accents, emoji, vides, réels)', () => {
  const db = makeDb({ projects: ['Fluffy', 'Héïrfall 🦖'] });
  insertRow(db, { id: 'a', start_ms: at('2026-10-01T09:00:00+02:00'), end_ms: at('2026-10-01T10:30:00+02:00'), note: 'café 🦖 « menus »' });
  insertRow(db, { id: 'b', kind: 'block', start_ms: null, hours: 3.5, deleted_ms: at('2026-10-02T09:00:00+02:00') });
  insertRow(db, { id: 'c', start_ms: at('2026-10-01T11:00:00+02:00') });
  db.prepare('INSERT INTO ops (at_ms, action, summary, source, changes) VALUES (?, ?, ?, ?, ?)').run(1759302000123, 'start', 'Lancement 🦖', 'app', '[{"a":1}]');
  db.prepare("INSERT INTO archive_days VALUES ('2026-10-01', 1759377600999, 3, 1.123456789)").run();
  db.prepare("INSERT INTO archive_entries SELECT '2026-10-01', * FROM entries").run();
  for (const t of TABLES) {
    const fromSql = plainRow(db.prepare(fingerprintSql(t)).get());
    const fromJs = fingerprintRows(t, db.prepare(`SELECT * FROM ${t.name}`).all());
    assert.deepEqual(fromJs, fromSql, t.name);
  }
});

const count = (sqlite, sql) => sqlite.prepare(sql).get().n;

test('figer : un jour fini est copié une fois, à 6 h le lendemain, pas avant', async () => {
  const { call, sqlite, env, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', note: 'avant' }));
  clock.advance(60);
  ok(await call('stop'));
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 4 }));
  clock.set('2026-10-02T05:59:00+02:00');
  assert.deepEqual((await freezeDays({ db: env.db, now: clock.now() })).frozen, []);
  assert.equal(count(sqlite, 'SELECT COUNT(*) n FROM archive_days'), 0);
  clock.set('2026-10-02T06:00:00+02:00');
  const r = await freezeDays({ db: env.db, now: clock.now() });
  assert.deepEqual(r.frozen, ['2026-10-01']);
  assert.equal(r.through, '2026-10-01');
  const day = sqlite.prepare('SELECT * FROM archive_days').get();
  assert.equal(day.row_count, 2);
  assert.equal(day.hours, 5);
  assert.equal(day.archived_ms, clock.now());
  // Rejouer ne double rien ; une correction ensuite ne touche pas l'archive.
  assert.deepEqual((await freezeDays({ db: env.db, now: clock.now() })).frozen, []);
  ok(await call('editEntry', { id: 'a1', note: 'après' }));
  assert.equal(sqlite.prepare("SELECT note FROM archive_entries WHERE id = 'a1'").get().note, 'avant');
  assert.equal(count(sqlite, 'SELECT COUNT(*) n FROM archive_entries'), 2);
});

test('figer : supprimées comprises, sans compter dans le total', async () => {
  const { call, sqlite, env, clock } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 4 }));
  ok(await call('logBlock', { id: 'b2', project: 'Fluffy', hours: 2 }));
  ok(await call('deleteEntry', { id: 'b2' }));
  clock.set('2026-10-02T07:00:00+02:00');
  await freezeDays({ db: env.db, now: clock.now() });
  const day = sqlite.prepare('SELECT * FROM archive_days').get();
  assert.equal(day.row_count, 2);
  assert.equal(day.hours, 4);
  assert.notEqual(sqlite.prepare("SELECT deleted_ms FROM archive_entries WHERE id = 'b2'").get().deleted_ms, null);
});

test('figer : 20 jours au plus par appel, sous 50 requêtes, le reste au suivant', async () => {
  const { sqlite, env } = await makeEnv();
  for (let i = 1; i <= 25; i++) {
    const d = `2026-09-${String(i).padStart(2, '0')}`;
    const t = at(`${d}T09:00:00+02:00`);
    insertRow(sqlite, { id: 'r' + i, day: d, start_ms: t, end_ms: t + 3600000 });
  }
  let queries = 0;
  const db = {
    all: (s, p) => { queries++; return env.db.all(s, p); },
    first: (s, p) => { queries++; return env.db.first(s, p); },
    batch: (stmts) => { queries += stmts.length; return env.db.batch(stmts); },
  };
  const now = at('2026-10-01T09:00:00+02:00');
  const first = await freezeDays({ db, now });
  assert.equal(first.frozen.length, FREEZE_DAYS_PER_RUN);
  assert.equal(first.through, '2026-09-20');
  assert.ok(queries <= 50, `${queries} requêtes`);
  const second = await freezeDays({ db: env.db, now });
  assert.deepEqual(second.frozen, ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
  assert.equal(second.through, '2026-09-30');
  assert.equal(count(sqlite, 'SELECT COUNT(*) n FROM archive_days'), 25);
});

test('export : pages sans trou ni doublon, tables et tailles contrôlées', async () => {
  const { call, sqlite } = await makeEnv();
  for (let i = 1; i <= 5; i++) ok(await call('logBlock', { id: 'b' + i, project: 'Fluffy', hours: 2 }));
  const ids = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const page = ok(await call('export', { table: 'entries', after, limit: 2 }));
    pages++;
    ids.push(...page.rows.map((r) => r.id));
    assert.equal(page.rows[0] && page.rows[0]._rowid, undefined);
    if (page.next === null) break;
    after = page.next;
  }
  assert.deepEqual(ids, ['b1', 'b2', 'b3', 'b4', 'b5']);
  assert.equal(pages, 3);
  const check = ok(await call('exportCheck')).tables;
  assert.deepEqual(check.entries, fingerprintRows(TABLES.find((t) => t.name === 'entries'), sqlite.prepare('SELECT * FROM entries').all()));
  fails(await call('export', { table: 'lockouts' }), 'invalid');
  fails(await call('export', { table: 'nope' }), 'invalid');
  fails(await call('export', { table: 'entries', limit: 201 }), 'invalid');
  fails(await call('export', { table: 'entries', after: -1 }), 'invalid');
});

test('backupDone : noté hors journal, visible dans status', async () => {
  const { call, sqlite, clock } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  const before = ok(await call('status'));
  assert.deepEqual(before.backup, { desktopDay: null, desktopAt: null, unfrozenSince: null });
  const s = ok(await call('backupDone', { day: '2026-10-01' }));
  assert.equal(s.backup.desktopDay, '2026-10-01');
  assert.equal(s.backup.desktopAt, new Date(clock.now()).toISOString());
  assert.deepEqual(s.undo, before.undo); // pas une action annulable
  assert.equal(count(sqlite, 'SELECT COUNT(*) n FROM ops'), 1);
  fails(await call('backupDone', { day: '01/10/2026' }), 'invalid');
});

test('status : jour fini depuis plus de 2 h et pas figé → signalé, puis plus après le cron', async () => {
  const { call, env, clock } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  clock.set('2026-10-02T07:59:00+02:00');
  assert.equal(ok(await call('status')).backup.unfrozenSince, null);
  clock.set('2026-10-02T08:00:00+02:00');
  assert.equal(ok(await call('status')).backup.unfrozenSince, '2026-10-01');
  await freezeDays({ db: env.db, now: clock.now() });
  assert.equal(ok(await call('status')).backup.unfrozenSince, null);
});

test('archivedDay : les lignes figées, supprimées signalées', async () => {
  const { call, env, clock } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 4 }));
  ok(await call('logBlock', { id: 'b2', project: 'Fluffy', hours: 2 }));
  ok(await call('deleteEntry', { id: 'b2' }));
  clock.set('2026-10-02T07:00:00+02:00');
  await freezeDays({ db: env.db, now: clock.now() });
  const a = ok(await call('archivedDay', { day: '2026-10-01' }));
  assert.equal(a.archivedAt, new Date(clock.now()).toISOString());
  assert.deepEqual(a.rows.map((r) => [r.id, r.hours, r.deleted]), [['b1', 4, false], ['b2', 2, true]]);
  const none = ok(await call('archivedDay', { day: '2026-09-01' }));
  assert.equal(none.archivedAt, null);
  assert.deepEqual(none.rows, []);
  fails(await call('archivedDay', { day: 'hier' }), 'invalid');
});
