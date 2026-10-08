/**
 * Sauvegardes : la liste des tables exportées et leur empreinte. Partagé par le Worker (actions
 * `export`, `exportCheck`), la mini-fenêtre de bureau (desktop/backup.mjs) et la restauration
 * (tools/restore.mjs). Sans dépendance : tourne dans le Worker comme dans Node.
 *
 * L'empreinte d'une table : le nombre de lignes et, par colonne, le nombre de vides et une somme.
 * La base la calcule en SQL, la mini-fenêtre la recalcule sur ce qu'elle a reçu : une page perdue
 * ou une écriture tombée pendant l'export ne passe pas. Les sommes restent entières et petites
 * (millisecondes coupées en milliers et en reste, heures tronquées au centième, textes comptés en
 * caractères) pour que JavaScript retombe exactement sur SQLite, sans arrondi ni dépassement.
 */
const ENTRY_COLUMNS = {
  id: 'text', project: 'text', kind: 'text', day: 'text', start_ms: 'int', end_ms: 'int', hours: 'real',
  type: 'text', note: 'text', source: 'text', created_ms: 'int', touched_ms: 'int', deleted_ms: 'int',
};

const TASK_COLUMNS = {
  id: 'text', description: 'text', project: 'text', type: 'text', position: 'int', done_day: 'text', started_ms: 'int',
  done_ms: 'int', source: 'text', created_ms: 'int', touched_ms: 'int', deleted_ms: 'int',
};

// Toutes les tables de server/schema.sql sauf NOT_EXPORTED, colonnes dans l'ordre du schéma (testé).
export const TABLES = [
  { name: 'projects', columns: { name: 'text', position: 'int' } },
  { name: 'settings', columns: { key: 'text', value: 'text' } },
  { name: 'entries', columns: ENTRY_COLUMNS },
  { name: 'ops', columns: { id: 'int', at_ms: 'int', action: 'text', summary: 'text', source: 'text', changes: 'text', undone_ms: 'int' } },
  { name: 'archive_days', columns: { day: 'text', archived_ms: 'int', row_count: 'int', hours: 'real' } },
  { name: 'archive_entries', columns: { archived_day: 'text', ...ENTRY_COLUMNS } },
  { name: 'tasks', columns: TASK_COLUMNS },
  { name: 'archive_tasks', columns: { archived_day: 'text', ...TASK_COLUMNS } },
];

// Codes refusés par adresse : sans valeur à garder.
export const NOT_EXPORTED = ['lockouts'];

export function fingerprintSql(table) {
  const parts = ['COUNT(*) AS n'];
  for (const [c, kind] of Object.entries(table.columns)) {
    parts.push(`COALESCE(SUM(${c} IS NULL), 0) AS "${c}:null"`);
    if (kind === 'int') parts.push(`COALESCE(SUM(${c} / 1000), 0) AS "${c}:hi"`, `COALESCE(SUM(${c} % 1000), 0) AS "${c}:lo"`);
    else if (kind === 'real') parts.push(`COALESCE(SUM(CAST(${c} * 100 AS INTEGER)), 0) AS "${c}:c"`);
    else parts.push(`COALESCE(SUM(LENGTH(${c})), 0) AS "${c}:len"`);
  }
  return `SELECT ${parts.join(', ')} FROM ${table.name}`;
}

export function fingerprintRows(table, rows) {
  const out = { n: rows.length };
  for (const [c, kind] of Object.entries(table.columns)) {
    let nulls = 0;
    let a = 0;
    let b = 0;
    for (const row of rows) {
      const v = row[c];
      if (v === null || v === undefined) { nulls++; continue; }
      if (kind === 'int') { a += Math.trunc(v / 1000); b += v % 1000; }
      else if (kind === 'real') a += Math.trunc(v * 100);
      else a += [...String(v)].length; // LENGTH de SQLite compte les caractères, pas les unités UTF-16
    }
    out[`${c}:null`] = nulls;
    if (kind === 'int') { out[`${c}:hi`] = a; out[`${c}:lo`] = b; }
    else if (kind === 'real') out[`${c}:c`] = a;
    else out[`${c}:len`] = a;
  }
  return out;
}
