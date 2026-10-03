// Vérifie un fichier de reprise avant de l'envoyer à D1 : il passe les règles de la base
// (server/schema.sql) dans un SQLite local, et son nombre de lignes et ses totaux par projet et par
// type égalent ceux calculés par tools/migrate_d1.py.
//
//   node tools/check_import.mjs reprise.sql
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2] || 'reprise.sql';
const expected = JSON.parse(fs.readFileSync(file.replace(/\.sql$/, '.totaux.json'), 'utf8'));
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
db.exec(fs.readFileSync(file, 'utf8'));

const rows = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
const got = {};
for (const r of db.prepare("SELECT project, type, SUM(CASE WHEN kind = 'block' THEN hours ELSE (end_ms - start_ms) / 3600000.0 END) AS h FROM entries GROUP BY project, type").all()) {
  got[`${r.project}|${r.type}`] = Math.round(r.h * 10000) / 10000;
}
const bad = rows === expected.rows ? [] : [`lignes : ${rows} au lieu de ${expected.rows}`];
for (const key of new Set([...Object.keys(expected.byProjectType), ...Object.keys(got)])) {
  const a = got[key] || 0;
  const b = expected.byProjectType[key] || 0;
  if (Math.abs(a - b) > 0.005) bad.push(`${key} : ${a} h au lieu de ${b} h`);
}
if (bad.length) {
  console.error('ÉCHEC :\n  ' + bad.join('\n  '));
  process.exit(1);
}
console.log(`OK : ${rows} lignes, totaux identiques, règles de la base respectées.`);
console.log(`Après l'envoi, relire : npx wrangler d1 execute kilosaurus-temps --remote --command "SELECT COUNT(*) AS n FROM entries"  (attendu : ${rows})`);
