// Harnais des tests du serveur : une base SQLite en mémoire avec le vrai schéma, une horloge
// réglable, et les règles métier de server/core.js branchées dessus.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fromSqlite } from '../server/db.js';

export const SCHEMA = readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8');
export const at = (iso) => Date.parse(iso);

export function makeDb({ projects = ['Fluffy', 'Studio'], settings = { me: 'Amohs', studio: 'Studio', visible: 4, threshold: 8 } } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  projects.forEach((name, i) => sqlite.prepare('INSERT INTO projects (name, position) VALUES (?, ?)').run(name, i + 1));
  for (const [key, value] of Object.entries(settings)) sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  return sqlite;
}

// Ligne écrite directement dans la base (historique, cas limites), sans passer par l'API.
export function insertRow(sqlite, fields) {
  const t = fields.start_ms ?? at('2026-10-01T08:00:00+02:00');
  const row = Object.assign({
    id: 'x', project: 'Fluffy', kind: 'session', day: '2026-10-01', start_ms: null, end_ms: null, hours: null,
    type: 'Misc', note: '', source: 'app', created_ms: t, touched_ms: t, deleted_ms: null,
  }, fields);
  const cols = Object.keys(row);
  sqlite.prepare(`INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
}

export function makeClock(iso) {
  let t = at(iso);
  return { now: () => t, set: (s) => { t = at(s); }, advance: (minutes) => { t += minutes * 60000; } };
}

export const CODES = { 'code-amohs': { agent: false }, 'code-amohs-claude': { agent: true } };

export async function makeEnv(opts = {}) {
  const { handleRequest } = await import('../server/core.js');
  const sqlite = opts.sqlite || makeDb(opts);
  const clock = opts.clock || makeClock('2026-10-01T09:00:00+02:00');
  const env = { db: fromSqlite(sqlite), now: clock.now, auth: (code) => CODES[code] || null };
  const call = (action, params = {}, code = 'code-amohs') => handleRequest(env, { code, action, ...params });
  const rows = () => sqlite.prepare('SELECT * FROM entries ORDER BY created_ms, rowid').all();
  const row = (id) => sqlite.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  return { sqlite, clock, env, call, rows, row, handleRequest };
}

export function ok(res) {
  assert.equal(res.ok, true, res.error && `${res.error.code}: ${res.error.message}`);
  return res.data;
}

export function fails(res, code, pattern) {
  assert.equal(res.ok, false, 'devait échouer');
  assert.equal(res.error.code, code, res.error.message);
  if (pattern) assert.match(res.error.message, pattern);
}
