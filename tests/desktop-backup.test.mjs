// Copie de bureau (desktop/backup.mjs) contre le vrai server/core.js, dans des dossiers temporaires.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeEnv, ok, SCHEMA } from './server-harness.mjs';
import { runBackup, decodeBackup, backupName, fetchBackup, encodeBackup } from '../desktop/backup.mjs';
import { TABLES } from '../server/backup.js';
import { freezeDays } from '../server/core.js';
import { restoreSql } from '../tools/restore.mjs';

const made = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-backup-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const env = await makeEnv();
  const api = async (action, params = {}) => ok(await env.call(action, params));
  ok(await env.call('start', { id: 'a1', project: 'Fluffy', note: 'café 🦖' }));
  env.clock.advance(30);
  ok(await env.call('stop'));
  ok(await env.call('logBlock', { id: 'b1', project: 'Studio', hours: 4 }));
  return { ...env, api };
}

test('copie : écrite dans les deux dossiers, relue, signalée au serveur', async () => {
  const { api, clock, sqlite } = await setup();
  const dirs = [tmpDir(), tmpDir()];
  const r = await runBackup({ call: api, dirs, now: clock.now(), page: 2 });
  assert.deepEqual(r, { day: '2026-10-01', status: 'done' });
  for (const d of dirs) {
    const doc = decodeBackup(fs.readFileSync(path.join(d, backupName('2026-10-01'))));
    assert.equal(doc.tables.entries.length, sqlite.prepare('SELECT COUNT(*) n FROM entries').get().n);
    assert.equal(doc.workDay, '2026-10-01');
    assert.deepEqual(fs.readdirSync(d), [backupName('2026-10-01')]); // pas de .tmp laissé
  }
  assert.equal((await api('status')).backup.desktopDay, '2026-10-01');
});

test('copie : une copie déjà là n\'est jamais écrasée', async () => {
  const { api, clock } = await setup();
  const dirs = [tmpDir(), tmpDir()];
  const kept = path.join(dirs[0], backupName('2026-10-01'));
  fs.writeFileSync(kept, 'copie précédente');
  const r = await runBackup({ call: api, dirs, now: clock.now() });
  assert.equal(r.status, 'done');
  assert.equal(fs.readFileSync(kept, 'utf8'), 'copie précédente');
  assert.ok(fs.existsSync(path.join(dirs[1], backupName('2026-10-01'))));
});

test('copie : une écriture pendant l\'export → rien n\'est gardé, rien n\'est signalé', async () => {
  const { api, clock } = await setup();
  const dirs = [tmpDir()];
  let tapped = false;
  const racing = async (action, params) => {
    const data = await api(action, params);
    if (action === 'export' && !tapped) { tapped = true; await api('logBlock', { id: 'b9', project: 'Fluffy', hours: 2 }); }
    return data;
  };
  await assert.rejects(runBackup({ call: racing, dirs, now: clock.now() }), /a changé pendant l'export/);
  assert.deepEqual(fs.readdirSync(dirs[0]), []);
  assert.equal((await api('status')).backup.desktopDay, null);
});

test('copie : un dossier indisponible → l\'autre est écrit, pas de signal, puis rattrapage', async () => {
  const { api, clock } = await setup();
  const ok1 = tmpDir();
  const blocker = path.join(tmpDir(), 'pas-un-dossier');
  fs.writeFileSync(blocker, 'x'); // un fichier à la place du dossier : mkdir échoue, comme G: absent
  const logs = [];
  const r = await runBackup({ call: api, dirs: [ok1, path.join(blocker, 'Sauvegardes')], now: clock.now(), log: (l) => logs.push(l) });
  assert.equal(r.status, 'partial');
  assert.ok(fs.existsSync(path.join(ok1, backupName('2026-10-01'))));
  assert.ok(logs.some((l) => /échec/.test(l)));
  assert.equal((await api('status')).backup.desktopDay, null);
  const drive = tmpDir();
  const again = await runBackup({ call: api, dirs: [ok1, drive], now: clock.now() });
  assert.equal(again.status, 'done');
  assert.equal((await api('status')).backup.desktopDay, '2026-10-01');
});

test('copie : aucun dossier configuré → échec, rien n\'est signalé', async () => {
  const { api, clock } = await setup();
  await assert.rejects(runBackup({ call: api, dirs: [], now: clock.now() }), /Aucun dossier de sauvegarde configuré \(backupDirs\)\./);
  assert.equal((await api('status')).backup.desktopDay, null);
});

test('copie : un .tmp laissé par un arrêt brutal est remplacé', async () => {
  const { api, clock } = await setup();
  const d = tmpDir();
  fs.writeFileSync(path.join(d, backupName('2026-10-01') + '.tmp'), 'moitié');
  await runBackup({ call: api, dirs: [d], now: clock.now() });
  assert.deepEqual(fs.readdirSync(d), [backupName('2026-10-01')]);
});

test('copie : avant 6 h, c\'est le jour de travail de la veille', async () => {
  const { api, clock } = await setup();
  clock.set('2026-10-02T05:30:00+02:00');
  const r = await runBackup({ call: api, dirs: [tmpDir()], now: clock.now() });
  assert.equal(r.day, '2026-10-01');
});

test('lecture : un fichier modifié est refusé', async () => {
  const { api, clock } = await setup();
  const d = tmpDir();
  await runBackup({ call: api, dirs: [d], now: clock.now() });
  const doc = decodeBackup(fs.readFileSync(path.join(d, backupName('2026-10-01'))));
  doc.tables.entries[0].note = 'falsifié';
  assert.throws(() => decodeBackup(encodeBackup(doc)), /Empreinte différente pour la table entries/);
});

test('restauration : aller-retour identique, table par table', async () => {
  const { api, call, clock, sqlite, env } = await setup();
  ok(await call('addProject', { name: "L'Atelier 🦖" }));
  ok(await call('logBlock', { id: 'b2', project: 'Fluffy', hours: 2, note: 'ligne 1\nligne 2 ; « guillemets »' }));
  ok(await call('deleteEntry', { id: 'b2' }));
  const s = ok(await call('status'));
  ok(await call('undo', { opId: s.undo.opId }));
  clock.set('2026-10-02T07:00:00+02:00');
  await freezeDays({ db: env.db, now: clock.now() });
  ok(await call('backupDone', { day: '2026-10-01' }));
  // fetchBackup seul : runBackup écrirait encore `backup_desktop` après l'export, et la base
  // d'origine ne serait plus celle qui a été copiée.
  const doc = decodeBackup(encodeBackup(await fetchBackup(api, { page: 3, now: clock.now() })));
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(SCHEMA);
  fresh.exec(restoreSql(doc));
  for (const t of TABLES) {
    const cols = Object.keys(t.columns).join(', ');
    const read = (db) => db.prepare(`SELECT ${cols} FROM ${t.name} ORDER BY rowid`).all().map((r) => ({ ...r }));
    assert.deepEqual(read(fresh), read(sqlite), t.name);
  }
});
