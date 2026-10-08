// Recharge une sauvegarde de bureau dans une base vide.
//
//   node tools/restore.mjs <kilosaurus-temps_aaaa-mm-jj.json.gz> <sortie.sql>
//
// Vérifie l'empreinte du fichier, puis écrit le SQL à exécuter sur une base créée avec
// server/schema.sql (procédure : README, « Restaurer une sauvegarde »). Le fichier de sortie
// contient les heures réelles : jamais dans le dépôt (.gitignore : restore*.sql). Il n'écrase rien.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TABLES } from '../server/backup.js';
import { decodeBackup } from '../desktop/backup.mjs';

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Nombre non valide : ' + v);
    return String(v);
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Les lignes dans l'ordre de l'export (celui de la base d'origine) : même ordre ; les identifiants
// sont conservés là où ils sont la clé (ops), les autres tables reçoivent des rowid renumérotés.
export function restoreSql(doc) {
  const lines = [`-- Restauration Kilosaurus Temps, export du ${doc.exportedAt}`];
  for (const t of TABLES) {
    const cols = Object.keys(t.columns);
    for (const row of doc.tables[t.name]) {
      lines.push(`INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map((c) => literal(row[c])).join(', ')});`);
    }
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage : node tools/restore.mjs <sauvegarde.json.gz> <sortie.sql>');
    process.exit(1);
  }
  const doc = decodeBackup(fs.readFileSync(input));
  fs.writeFileSync(output, restoreSql(doc), { flag: 'wx' });
  console.log(`Export du ${doc.exportedAt}, empreinte vérifiée.`);
  for (const t of TABLES) console.log(`${t.name} : ${doc.tables[t.name].length} lignes`);
}
