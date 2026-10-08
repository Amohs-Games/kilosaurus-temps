/**
 * Copie de bureau des sauvegardes, sans Electron (testée par tests/desktop-backup.test.mjs) :
 * télécharge toute la base par pages, vérifie l'empreinte calculée par le serveur, écrit un
 * fichier daté par jour de travail dans chaque dossier, sans jamais écraser, puis le signale.
 * Appelée toutes les heures par main.js ; aussi utilisée par tools/restore.mjs pour relire un fichier.
 *
 *   call(action, params) → Promise<data> : appel à l'API, lève une Error si la réponse n'est pas ok.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { TABLES, fingerprintRows } from '../server/backup.js';
import { workDayKey } from '../server/tz.js';

export const FORMAT = 'kilosaurus-temps-backup';
export const PAGE = 200;

export function backupName(day) { return `kilosaurus-temps_${day}.json.gz`; }

export function encodeBackup(doc) { return gzipSync(Buffer.from(JSON.stringify(doc), 'utf8')); }

// Relit un fichier et vérifie que chaque table redonne l'empreinte enregistrée avec elle.
export function decodeBackup(buffer) {
  const doc = JSON.parse(gunzipSync(buffer).toString('utf8'));
  if (!doc || doc.format !== FORMAT || doc.version !== 1) throw new Error('Fichier de sauvegarde inconnu.');
  for (const t of TABLES) {
    if (!isDeepStrictEqual(fingerprintRows(t, doc.tables[t.name] || []), doc.check[t.name])) {
      throw new Error(`Empreinte différente pour la table ${t.name}.`);
    }
  }
  return doc;
}

// Empreinte avant, toutes les pages, empreinte après : si la base a bougé entre les deux, ou si
// une page manque, rien n'est gardé.
export async function fetchBackup(call, { page = PAGE, now = Date.now() } = {}) {
  const before = (await call('exportCheck')).tables;
  const tables = {};
  for (const t of TABLES) {
    const rows = [];
    let after = 0;
    for (;;) {
      const res = await call('export', { table: t.name, after, limit: page });
      rows.push(...res.rows);
      if (res.next === null) break;
      after = res.next;
    }
    tables[t.name] = rows;
  }
  const after = (await call('exportCheck')).tables;
  if (!isDeepStrictEqual(before, after)) throw new Error('La base a changé pendant l\'export : nouvel essai plus tard.');
  for (const t of TABLES) {
    if (!isDeepStrictEqual(fingerprintRows(t, tables[t.name]), before[t.name])) throw new Error(`Export incomplet pour la table ${t.name}.`);
  }
  return { format: FORMAT, version: 1, exportedAt: new Date(now).toISOString(), workDay: workDayKey(now), check: before, tables };
}

// Écrit à côté (.tmp), relit et vérifie, puis renomme. Un nom déjà pris n'est jamais remplacé.
export function writeCopy(dir, name, buffer) {
  const final = path.join(dir, name);
  if (fs.existsSync(final)) return 'exists';
  fs.mkdirSync(dir, { recursive: true });
  const tmp = final + '.tmp';
  fs.rmSync(tmp, { force: true });
  try {
    // fsync avant le renommage : sans lui, une coupure juste après peut laisser le nom final
    // sur un fichier incomplet, et les passages suivants le croiraient bon.
    const fd = fs.openSync(tmp, 'w');
    try {
      let done = 0;
      while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const back = fs.readFileSync(tmp);
    if (!back.equals(buffer)) throw new Error('Relecture différente de ce qui a été écrit.');
    decodeBackup(back);
    if (fs.existsSync(final)) { fs.rmSync(tmp, { force: true }); return 'exists'; }
    fs.renameSync(tmp, final);
    return 'written';
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export async function runBackup({ call, dirs, now = Date.now(), page = PAGE, log = () => {} }) {
  if (!Array.isArray(dirs) || dirs.length === 0) throw new Error('Aucun dossier de sauvegarde configuré (backupDirs).');
  const day = workDayKey(now);
  const name = backupName(day);
  const missing = dirs.filter((d) => !fs.existsSync(path.join(d, name)));
  if (missing.length) {
    const buffer = encodeBackup(await fetchBackup(call, { page, now }));
    for (const dir of missing) {
      try { log(`${dir} : ${writeCopy(dir, name, buffer)}`); }
      catch (e) { log(`${dir} : échec (${e.message})`); }
    }
  }
  if (!dirs.every((d) => fs.existsSync(path.join(d, name)))) return { day, status: 'partial' };
  const s = await call('status');
  if (!s.backup || s.backup.desktopDay !== day) await call('backupDone', { day });
  return { day, status: 'done' };
}
