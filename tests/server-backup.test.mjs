// Sauvegardes : description des tables, empreinte, journées figées, export (server/backup.js, server/core.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeEnv, insertRow, ok, fails, at } from './server-harness.mjs';
import { TABLES, NOT_EXPORTED, fingerprintSql, fingerprintRows } from '../server/backup.js';

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
