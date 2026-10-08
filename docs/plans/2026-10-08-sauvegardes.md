# Sauvegardes — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Les heures enregistrées ne peuvent plus être perdues : chaque journée finie est figée dans la base, une copie complète et vérifiée quitte Cloudflare chaque jour, et une panne de sauvegarde se voit sur tous les appareils.

**Architecture:** Un cron horaire du Worker copie en SQL (`INSERT … SELECT`) les lignes de chaque jour fini dans des tables d'archive que des triggers rendent intouchables. La mini-fenêtre Electron télécharge toute la base par petites pages (actions `export` / `exportCheck`), vérifie l'empreinte calculée par SQLite, écrit un `.json.gz` daté dans deux dossiers (PC + Google Drive) sans jamais écraser, puis le signale (`backupDone`). `status` expose l'état des sauvegardes ; l'app affiche un bandeau si elles sont en retard.

**Tech Stack:** Cloudflare Workers + D1 (SQLite), Node 24 (`node:test`, `node:sqlite`, `node:zlib`), Electron 44, JavaScript sans framework.

**Spec:** `docs/specs/2026-10-08-sauvegardes-design.md`

## Global Constraints

- Offre gratuite Cloudflare : **10 ms de calcul** par appel du Worker (cron compris) et **50 requêtes D1 par appel**, chaque instruction d'un `batch` comptant pour une.
- Jour de travail : **de 6 h à 6 h** le lendemain, fuseau `Europe/Paris`.
- Au plus **20 jours figés par appel** du cron ; cron `5 * * * *`.
- Pages d'export : **200 lignes** au plus.
- Alerte : copie de bureau de plus de **48 h**, ou jour fini depuis plus de **2 h** et pas figé.
- Fichier : `kilosaurus-temps_aaaa-mm-jj.json.gz` ; jamais écrasé, jamais laissé à moitié écrit.
- Dossiers par défaut : `Documents\PROJECTS\KILOSAURUS\Sauvegardes\` et `G:\Mon Drive\KILOSAURUS\Temps\Sauvegardes\`.
- Le dépôt est **public** : aucune donnée réelle (sauvegarde, SQL de restauration) n'y entre jamais.
- `lockouts` n'est jamais exportée.
- Identifiants et code en anglais, commentaires et messages en français, comme le reste du dépôt.
- Aucune dépendance nouvelle (l'app n'en a aucune ; Node fournit `zlib` et `sqlite`).

## Review Focus

1. Une écriture (un tap sur le téléphone) qui tombe pendant l'export de la mini-fenêtre : la copie doit être jetée et refaite, jamais gardée incohérente. → test dans la tâche 7.
2. Google Drive pas monté au démarrage de Windows (`G:` absent) : la copie PC doit être faite, Drive retentée l'heure suivante, et `backupDone` pas envoyé tant que les deux ne sont pas là. → test dans la tâche 7.
3. Les jours de changement d'heure (29 mars, 25 octobre) : la limite de 6 h ne doit pas glisser d'une heure. → tests dans la tâche 1.
4. Des notes ou des noms de projet avec accents et emoji : l'empreinte JavaScript doit retomber exactement sur celle de SQLite, sinon aucune sauvegarde ne passe jamais. → test dans la tâche 3.
5. Le premier déploiement, avec plus de 20 jours d'historique à figer : le cron doit rester sous 50 requêtes par appel et rattraper le reste aux appels suivants. → test dans la tâche 4.

---

### Task 0: Préalables

**Files:** aucun.

- [ ] **Step 1: Vérifier que l'arbre est propre**

Run: `git status --short`
Expected: rien. Si des fichiers sont modifiés (travail en cours sur le widget, `server/core.js`, `web/logic.js`, les tests, le README), **s'arrêter et demander à l'utilisateur** de les commiter ou de les mettre de côté : ce plan modifie les mêmes fichiers et ne doit pas embarquer ce travail.

- [ ] **Step 2: Vérifier que les tests passent avant de commencer**

Run: `npm test`
Expected: tous verts.

- [ ] **Step 3: Vérifier la sauvegarde manuelle**

La sauvegarde du 2026-10-08 18 h 51 existe : `..\Sauvegardes\kilosaurus-temps_2026-10-08_1851_manuelle.sql` (spec, section 6). Rien d'autre ne touche la base en ligne avant la tâche 11, qui refait une sauvegarde juste avant.

---

### Task 1: Jour de travail (6 h → 6 h) dans `server/tz.js`

**Files:**
- Modify: `server/tz.js` (ajouts en fin de fichier)
- Test: `tests/server-schema.test.mjs` (là où vivent les tests de fuseau)

**Interfaces:**
- Produces:
  - `localTime(key: string, hour: number) → number` — instant (ms UTC) de `hour`:00 heure de Paris le jour `key`.
  - `previousDayKey(key: string) → string`
  - `WORKDAY_HOUR = 6`
  - `workDayKey(ms: number) → string` — jour de travail qui contient `ms` (avant 6 h : la veille).
  - `workDayEnd(key: string) → number` — 6 h le lendemain de `key`.

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/server-schema.test.mjs` (et compléter l'import de `../server/tz.js` avec `localTime, previousDayKey, workDayKey, workDayEnd`) :

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server-schema.test.mjs`
Expected: FAIL — `localTime` (ou un autre) n'est pas exporté.

- [ ] **Step 3: Write minimal implementation**

Ajouter à la fin de `server/tz.js` :

```js
// Instant d'une heure ronde de Paris un jour donné. Sûr aux changements d'heure tant que l'heure
// demandée n'est pas dans le trou de 2 h à 3 h (6 h ne l'est jamais).
export function localTime(key, hour) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  return guess - offsetMs(guess);
}

export function previousDayKey(key) { return dayKey(dayStart(key) - 12 * 3600000); }

// Jour de travail : de 6 h à 6 h le lendemain. Avant 6 h du matin, c'est encore celui de la veille.
export const WORKDAY_HOUR = 6;

export function workDayKey(ms) {
  const key = dayKey(ms);
  return ms < localTime(key, WORKDAY_HOUR) ? previousDayKey(key) : key;
}

export function workDayEnd(key) { return localTime(dayKey(nextDayStart(dayStart(key))), WORKDAY_HOUR); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server-schema.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tz.js tests/server-schema.test.mjs
git commit -m "feat(serveur) : jour de travail de 6 h à 6 h (fuseau de Paris)"
```

---

### Task 2: Tables d'archive figées (`server/schema.sql`)

**Files:**
- Modify: `server/schema.sql` (ajout avant la table `lockouts`)
- Test: `tests/server-schema.test.mjs`

**Interfaces:**
- Produces: tables `archive_days (day, archived_ms, row_count, hours)` et `archive_entries (archived_day, <toutes les colonnes d'entries dans le même ordre>)`, clé `(archived_day, id)` ; `UPDATE` et `DELETE` refusés avec le message `archive figée`.

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/server-schema.test.mjs` (importer `SCHEMA` depuis `./server-harness.mjs`) :

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server-schema.test.mjs`
Expected: FAIL — `no such table: archive_days`.

- [ ] **Step 3: Write minimal implementation**

Dans `server/schema.sql`, avant le bloc `-- Codes refusés par adresse IP…`, ajouter :

```sql
-- Journées figées (sauvegardes) : chaque jour fini (6 h passées le lendemain) est copié ici par le
-- cron du Worker. Jamais modifié ni effacé : les triggers refusent UPDATE et DELETE. Une correction
-- faite ensuite dans l'app ne touche que `entries` ; la version d'origine reste ici.
CREATE TABLE IF NOT EXISTS archive_days (
  day TEXT PRIMARY KEY,
  archived_ms INTEGER NOT NULL,
  row_count INTEGER NOT NULL,        -- lignes copiées, supprimées comprises
  hours REAL NOT NULL                -- total du jour (sessions terminées et blocs non supprimés)
);

-- Mêmes colonnes qu'`entries`, dans le même ordre, précédées du jour figé.
CREATE TABLE IF NOT EXISTS archive_entries (
  archived_day TEXT NOT NULL,
  id TEXT NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  hours REAL,
  type TEXT NOT NULL,
  note TEXT NOT NULL,
  source TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  touched_ms INTEGER NOT NULL,
  deleted_ms INTEGER,
  PRIMARY KEY (archived_day, id)
);

CREATE TRIGGER IF NOT EXISTS archive_days_no_update BEFORE UPDATE ON archive_days BEGIN SELECT RAISE(ABORT, 'archive figée'); END;
CREATE TRIGGER IF NOT EXISTS archive_days_no_delete BEFORE DELETE ON archive_days BEGIN SELECT RAISE(ABORT, 'archive figée'); END;
CREATE TRIGGER IF NOT EXISTS archive_entries_no_update BEFORE UPDATE ON archive_entries BEGIN SELECT RAISE(ABORT, 'archive figée'); END;
CREATE TRIGGER IF NOT EXISTS archive_entries_no_delete BEFORE DELETE ON archive_entries BEGIN SELECT RAISE(ABORT, 'archive figée'); END;
```

Compléter aussi le commentaire de la table `settings` : `key TEXT PRIMARY KEY, -- me, studio, visible, threshold, archive_through, backup_desktop`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (tous les fichiers).

- [ ] **Step 5: Commit**

```bash
git add server/schema.sql tests/server-schema.test.mjs
git commit -m "feat(base) : tables d'archive des journées figées, protégées par triggers"
```

---

### Task 3: Description des tables et empreinte (`server/backup.js`)

**Files:**
- Create: `server/backup.js`
- Test: `tests/server-backup.test.mjs` (nouveau)

**Interfaces:**
- Produces:
  - `TABLES: Array<{ name: string, columns: Record<string, 'text'|'int'|'real'> }>` — toutes les tables exportées, colonnes dans l'ordre du schéma.
  - `NOT_EXPORTED = ['lockouts']`
  - `fingerprintSql(table) → string` — un `SELECT` d'une ligne : `n` et, par colonne, `"<col>:null"` plus `"<col>:hi"`/`"<col>:lo"` (int), `"<col>:c"` (real) ou `"<col>:len"` (text).
  - `fingerprintRows(table, rows) → object` — le même objet, calculé en JavaScript.

- [ ] **Step 1: Write the failing test**

Créer `tests/server-backup.test.mjs` :

```js
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

test('sauvegarde : l’empreinte JavaScript égale celle de SQLite (accents, emoji, vides, réels)', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server-backup.test.mjs`
Expected: FAIL — `Cannot find module '../server/backup.js'`.

- [ ] **Step 3: Write minimal implementation**

Créer `server/backup.js` :

```js
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

// Toutes les tables de server/schema.sql sauf NOT_EXPORTED, colonnes dans l'ordre du schéma (testé).
export const TABLES = [
  { name: 'projects', columns: { name: 'text', position: 'int' } },
  { name: 'settings', columns: { key: 'text', value: 'text' } },
  { name: 'entries', columns: ENTRY_COLUMNS },
  { name: 'ops', columns: { id: 'int', at_ms: 'int', action: 'text', summary: 'text', source: 'text', changes: 'text', undone_ms: 'int' } },
  { name: 'archive_days', columns: { day: 'text', archived_ms: 'int', row_count: 'int', hours: 'real' } },
  { name: 'archive_entries', columns: { archived_day: 'text', ...ENTRY_COLUMNS } },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server-backup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/backup.js tests/server-backup.test.mjs
git commit -m "feat(serveur) : liste des tables exportées et empreinte vérifiable"
```

---

### Task 4: Figer les journées finies (`freezeDays`)

**Files:**
- Modify: `server/core.js` (imports, constantes, nouvelle section `// ---- Journées figées ----` avant `// ---- Actions ----`)
- Test: `tests/server-backup.test.mjs`

**Interfaces:**
- Consumes: `workDayKey`, `previousDayKey` (tâche 1) ; tables d'archive (tâche 2).
- Produces:
  - `export const FREEZE_DAYS_PER_RUN = 20`
  - `export async function freezeDays({ db, now }) → { frozen: string[], through: string }`
  - helper interne `settingWrite(key, value) → { sql, params }` (réutilisé tâche 6)
  - réglage `settings.archive_through` : dernier jour traité (`'0000-00-00'` si absent, constante `NEVER`).

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/server-backup.test.mjs` (et `import { freezeDays, FREEZE_DAYS_PER_RUN } from '../server/core.js';`) :

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server-backup.test.mjs`
Expected: FAIL — `freezeDays` n'est pas exporté.

- [ ] **Step 3: Write minimal implementation**

Dans `server/core.js` :

1. Remplacer la ligne d'import de `./tz.js` par :

```js
import { dayKey, dayStart, nextDayStart, clock, shortDate, previousDayKey, workDayKey, workDayEnd } from './tz.js';
import { TABLES, fingerprintSql } from './backup.js';
```

2. Après `const WRITE_ACTIONS = …`, ajouter :

```js
// Sauvegardes. Un appel de Worker a droit à 50 requêtes D1 sur l'offre gratuite (chaque instruction
// d'un batch compte) : figer un jour en coûte 2, d'où 20 jours au plus par appel.
export const FREEZE_DAYS_PER_RUN = 20;
const FREEZE_GRACE_MS = 2 * 3600000; // un jour fini depuis plus de 2 h et pas figé déclenche l'alerte
const EXPORT_PAGE = 200;             // un appel de Worker a 10 ms de calcul : des pages courtes
const NEVER = '0000-00-00';
```

3. Juste avant `// ---- Actions ----`, ajouter :

```js
// ---- Journées figées ----

function settingWrite(key, value) {
  return { sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', params: [key, value] };
}

// Les lignes d'un jour (supprimées comprises) copiées dans l'archive, et son résumé : une seule
// transaction. Tout se passe dans la base : le coût pour le Worker ne grandit pas avec l'historique.
function freezeStatements(day, nowMs) {
  const cols = ENTRY_COLUMNS.join(', ');
  return [
    { sql: `INSERT INTO archive_entries (archived_day, ${cols}) SELECT day, ${cols} FROM entries WHERE day = ?`, params: [day] },
    {
      sql: `INSERT INTO archive_days (day, archived_ms, row_count, hours)
            SELECT ?, ?, COUNT(*), COALESCE(SUM(CASE WHEN deleted_ms IS NOT NULL THEN 0 WHEN kind = 'block' THEN hours
              WHEN end_ms IS NULL THEN 0 ELSE (end_ms - start_ms) / 3600000.0 END), 0)
            FROM entries WHERE day = ?`,
      params: [day, nowMs, day],
    },
  ];
}

// Fige chaque jour fini (6 h passées le lendemain) pas encore figé, du plus ancien au plus récent.
// `archive_through` retient le dernier jour traité : on ne relit que ce qui vient après. Une ligne
// ajoutée plus tard sur un jour déjà traité reste dans `entries`, le journal et les copies de bureau.
// Appelé par le cron du Worker (server/worker.js).
export async function freezeDays({ db, now }) {
  const through = (await settings(db)).archive_through || NEVER;
  const lastFinished = previousDayKey(workDayKey(now));
  if (through >= lastFinished) return { frozen: [], through };
  const days = (await db.all(
    'SELECT DISTINCT day FROM entries WHERE day > ? AND day <= ? ORDER BY day LIMIT ?',
    [through, lastFinished, FREEZE_DAYS_PER_RUN],
  )).map((r) => r.day);
  const already = new Set((await db.all('SELECT day FROM archive_days WHERE day > ? AND day <= ?', [through, lastFinished])).map((r) => r.day));
  const frozen = [];
  for (const day of days) {
    if (already.has(day)) continue;
    await db.batch(freezeStatements(day, now));
    frozen.push(day);
  }
  const next = days.length < FREEZE_DAYS_PER_RUN ? lastFinished : days[days.length - 1];
  await db.batch([settingWrite('archive_through', next)]);
  return { frozen, through: next };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/core.js tests/server-backup.test.mjs
git commit -m "feat(serveur) : les journées finies sont figées dans l'archive"
```

---

### Task 5: Cron du Worker

**Files:**
- Modify: `server/worker.js` (import + gestionnaire `scheduled`)
- Modify: `wrangler.toml` (déclencheur)
- Test: `tests/server-worker.test.mjs`

**Interfaces:**
- Consumes: `freezeDays({ db, now })` (tâche 4).
- Produces: `worker.scheduled(event, env, ctx)` — fige les jours avec `now = event.scheduledTime`.

- [ ] **Step 1: Write the failing test**

Dans `tests/server-worker.test.mjs`, changer l'import du harnais en `import { makeDb, insertRow } from './server-harness.mjs';` et ajouter :

```js
test('cron : fige les jours finis, à l’heure du déclenchement', async () => {
  const sqlite = makeDb();
  insertRow(sqlite, { id: 'a', day: '2026-10-01', start_ms: T0, end_ms: T0 + 3600000 });
  const env = { ...makeWorkerEnv(), DB: d1Shim(sqlite) };
  const waits = [];
  await worker.scheduled({ cron: '5 * * * *', scheduledTime: Date.parse('2026-10-02T07:05:00+02:00') }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM archive_days').get().n, 1);
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key = 'archive_through'").get().value, '2026-10-01');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server-worker.test.mjs`
Expected: FAIL — `worker.scheduled is not a function`.

- [ ] **Step 3: Write minimal implementation**

Dans `server/worker.js`, remplacer `import { handleRequest } from './core.js';` par :

```js
import { handleRequest, freezeDays } from './core.js';
```

et ajouter dans l'objet exporté par défaut, après `fetch` :

```js
  // Cron (wrangler.toml, toutes les heures) : fige les journées finies. Une erreur fait échouer
  // l'exécution, visible dans les journaux du Worker ; l'heure suivante reprend où on en était.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(freezeDays({ db: fromD1(env.DB), now: event.scheduledTime }));
  },
```

Dans `wrangler.toml`, ajouter à la fin :

```toml

# Journées figées (sauvegardes) : toutes les heures à la 5e minute (server/worker.js, scheduled).
[triggers]
crons = ["5 * * * *"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/worker.js wrangler.toml tests/server-worker.test.mjs
git commit -m "feat(worker) : cron horaire qui fige les journées finies"
```

---

### Task 6: Actions `export`, `exportCheck`, `backupDone`, `archivedDay` et `status.backup`

**Files:**
- Modify: `server/core.js` (fonction `backupState`, `status`, nouvelles actions en fin de l'objet `actions`)
- Test: `tests/server-backup.test.mjs`

**Interfaces:**
- Consumes: `TABLES`, `fingerprintSql` (tâche 3) ; `settingWrite`, `NEVER`, `FREEZE_GRACE_MS`, `EXPORT_PAGE`, `freezeDays` (tâche 4) ; `workDayEnd` (tâche 1).
- Produces (API) :
  - `export { table, after?, limit? }` → `{ table, rows, next }` (`next` : curseur `rowid` de la page suivante, `null` à la fin).
  - `exportCheck` → `{ tables: { [name]: empreinte } }`.
  - `backupDone { day }` → état (`status`) ; écrit `settings.backup_desktop = {"day","at_ms"}` hors journal.
  - `archivedDay { day }` → `{ day, archivedAt, rows }` (lignes au format `toApi` + `deleted: boolean`).
  - `status.backup` → `{ desktopDay: string|null, desktopAt: iso|null, unfrozenSince: string|null }`.

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/server-backup.test.mjs` :

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server-backup.test.mjs`
Expected: FAIL — `Action inconnue : export`.

- [ ] **Step 3: Write minimal implementation**

Dans `server/core.js` :

1. Juste avant `async function status(ctx) {`, ajouter :

```js
// État des sauvegardes, pour le bandeau d'alerte : dernière copie de bureau complète, et premier
// jour fini depuis plus de 2 h pas encore figé. Une seule ligne lue (index sur day).
async function backupState(db, cfg, nowMs) {
  const next = await db.first('SELECT day FROM entries WHERE day > ? ORDER BY day LIMIT 1', [cfg.archive_through || NEVER]);
  let desktop = null;
  try { desktop = cfg.backup_desktop ? JSON.parse(cfg.backup_desktop) : null; } catch (e) { desktop = null; }
  return {
    desktopDay: desktop ? desktop.day : null,
    desktopAt: desktop ? iso(desktop.at_ms) : null,
    unfrozenSince: next && workDayEnd(next.day) + FREEZE_GRACE_MS <= nowMs ? next.day : null,
  };
}
```

2. Dans `status`, après le `Promise.all`, ajouter `const backup = await backupState(db, cfg, ctx.now);` et, dans l'objet renvoyé, après `undo: …`, la ligne `backup,`.

3. À la fin de l'objet `actions` (après `history`), ajouter :

```js
  // ---- Sauvegardes ----

  // Une page d'une table, dans l'ordre de stockage (rowid) : la mini-fenêtre enchaîne les pages
  // jusqu'à `next: null`. Des pages courtes : un appel de Worker n'a que 10 ms de calcul.
  async export(ctx, p) {
    const table = TABLES.find((t) => t.name === p.table);
    if (!table) fail('Table inconnue : ' + p.table);
    const after = p.after === undefined || p.after === null ? 0 : Number(p.after);
    if (!Number.isInteger(after) || after < 0) fail('Curseur de page non valide.');
    const limit = p.limit === undefined || p.limit === null ? EXPORT_PAGE : Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_PAGE) fail(`Taille de page : 1 à ${EXPORT_PAGE}.`);
    const cols = Object.keys(table.columns).join(', ');
    const rows = await ctx.db.all(`SELECT rowid AS _rowid, ${cols} FROM ${table.name} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [after, limit]);
    return {
      table: table.name,
      rows: rows.map(({ _rowid, ...row }) => row),
      next: rows.length === limit ? rows[rows.length - 1]._rowid : null,
    };
  },

  // L'empreinte de chaque table, calculée par la base (server/backup.js).
  async exportCheck(ctx) {
    const tables = {};
    for (const t of TABLES) tables[t.name] = { ...(await ctx.db.first(fingerprintSql(t))) };
    return { tables };
  },

  // La mini-fenêtre a rangé la copie du jour dans tous ses dossiers. Un réglage, hors du journal :
  // ce n'est pas une action que l'agent devrait pouvoir annuler.
  async backupDone(ctx, p) {
    if (typeof p.day !== 'string' || !DAY_KEY.test(p.day)) fail('Jour attendu au format aaaa-mm-jj.');
    await ctx.db.batch([settingWrite('backup_desktop', JSON.stringify({ day: p.day, at_ms: ctx.now }))]);
  },

  // Les lignes d'un jour figé, telles qu'elles étaient à 6 h le lendemain.
  async archivedDay(ctx, p) {
    if (typeof p.day !== 'string' || !DAY_KEY.test(p.day)) fail('Jour attendu au format aaaa-mm-jj.');
    const info = await ctx.db.first('SELECT archived_ms FROM archive_days WHERE day = ?', [p.day]);
    const rows = await ctx.db.all('SELECT * FROM archive_entries WHERE archived_day = ? ORDER BY start_ms IS NULL, start_ms, created_ms', [p.day]);
    return {
      day: p.day,
      archivedAt: info ? iso(info.archived_ms) : null,
      rows: rows.map((r) => ({ ...toApi(r), deleted: r.deleted_ms != null })),
    };
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (dont le test existant `status initial`).

- [ ] **Step 5: Commit**

```bash
git add server/core.js tests/server-backup.test.mjs
git commit -m "feat(api) : export par pages, empreinte, copie de bureau signalée, journée figée lisible"
```

---

### Task 7: Copie de bureau sans Electron (`desktop/backup.mjs`)

**Files:**
- Create: `desktop/backup.mjs`
- Test: `tests/desktop-backup.test.mjs` (nouveau)

**Interfaces:**
- Consumes: `TABLES`, `fingerprintRows` (tâche 3) ; `workDayKey` (tâche 1) ; actions `export`, `exportCheck`, `status`, `backupDone` (tâche 6).
- Produces:
  - `FORMAT = 'kilosaurus-temps-backup'`, `PAGE = 200`
  - `backupName(day) → string`
  - `fetchBackup(call, { page?, now? }) → Promise<doc>` ; `doc = { format, version: 1, exportedAt, workDay, check, tables }`
  - `encodeBackup(doc) → Buffer` (gzip) ; `decodeBackup(buffer) → doc` (vérifie format et empreinte, lève sinon)
  - `writeCopy(dir, name, buffer) → 'written' | 'exists'`
  - `runBackup({ call, dirs, now?, page?, log? }) → Promise<{ day, status: 'done' | 'partial' }>`
  - `call(action, params) → Promise<data>` : lève une `Error` si la réponse n'est pas `ok`.

- [ ] **Step 1: Write the failing test**

Créer `tests/desktop-backup.test.mjs` :

```js
// Copie de bureau (desktop/backup.mjs) contre le vrai server/core.js, dans des dossiers temporaires.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEnv, ok } from './server-harness.mjs';
import { runBackup, decodeBackup, backupName } from '../desktop/backup.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kt-backup-'));

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

test('copie : une copie déjà là n’est jamais écrasée', async () => {
  const { api, clock } = await setup();
  const dirs = [tmpDir(), tmpDir()];
  const kept = path.join(dirs[0], backupName('2026-10-01'));
  fs.writeFileSync(kept, 'copie précédente');
  const r = await runBackup({ call: api, dirs, now: clock.now() });
  assert.equal(r.status, 'done');
  assert.equal(fs.readFileSync(kept, 'utf8'), 'copie précédente');
  assert.ok(fs.existsSync(path.join(dirs[1], backupName('2026-10-01'))));
});

test('copie : une écriture pendant l’export → rien n’est gardé, rien n’est signalé', async () => {
  const { api, clock } = await setup();
  const dirs = [tmpDir()];
  let tapped = false;
  const racing = async (action, params) => {
    const data = await api(action, params);
    if (action === 'export' && !tapped) { tapped = true; await api('logBlock', { id: 'b9', project: 'Fluffy', hours: 2 }); }
    return data;
  };
  await assert.rejects(runBackup({ call: racing, dirs, now: clock.now() }), /a changé pendant l’export/);
  assert.deepEqual(fs.readdirSync(dirs[0]), []);
  assert.equal((await api('status')).backup.desktopDay, null);
});

test('copie : un dossier indisponible → l’autre est écrit, pas de signal, puis rattrapage', async () => {
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

test('copie : un .tmp laissé par un arrêt brutal est remplacé', async () => {
  const { api, clock } = await setup();
  const d = tmpDir();
  fs.writeFileSync(path.join(d, backupName('2026-10-01') + '.tmp'), 'moitié');
  await runBackup({ call: api, dirs: [d], now: clock.now() });
  assert.deepEqual(fs.readdirSync(d), [backupName('2026-10-01')]);
});

test('copie : avant 6 h, c’est le jour de travail de la veille', async () => {
  const { api, clock } = await setup();
  clock.set('2026-10-02T05:30:00+02:00');
  const r = await runBackup({ call: api, dirs: [tmpDir()], now: clock.now() });
  assert.equal(r.day, '2026-10-01');
});

test('lecture : un fichier modifié est refusé', async () => {
  const { api, clock } = await setup();
  const d = tmpDir();
  await runBackup({ call: api, dirs: [d], now: clock.now() });
  const { encodeBackup } = await import('../desktop/backup.mjs');
  const doc = decodeBackup(fs.readFileSync(path.join(d, backupName('2026-10-01'))));
  doc.tables.entries[0].note = 'falsifié';
  assert.throws(() => decodeBackup(encodeBackup(doc)), /Empreinte différente pour la table entries/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/desktop-backup.test.mjs`
Expected: FAIL — `Cannot find module '../desktop/backup.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Créer `desktop/backup.mjs` :

```js
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
  if (!isDeepStrictEqual(before, after)) throw new Error('La base a changé pendant l’export : nouvel essai plus tard.');
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
  fs.writeFileSync(tmp, buffer);
  const back = fs.readFileSync(tmp);
  if (!back.equals(buffer)) { fs.rmSync(tmp, { force: true }); throw new Error('Relecture différente de ce qui a été écrit.'); }
  decodeBackup(back);
  if (fs.existsSync(final)) { fs.rmSync(tmp, { force: true }); return 'exists'; }
  fs.renameSync(tmp, final);
  return 'written';
}

export async function runBackup({ call, dirs, now = Date.now(), page = PAGE, log = () => {} }) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS. Si `npm test` ne prend pas le nouveau fichier : le motif `tests/*.test.mjs` le couvre déjà, vérifier le nom.

- [ ] **Step 5: Commit**

```bash
git add desktop/backup.mjs tests/desktop-backup.test.mjs
git commit -m "feat(bureau) : copie quotidienne vérifiée, jamais écrasée, dans plusieurs dossiers"
```

---

### Task 8: Restauration (`tools/restore.mjs`) et aller-retour

**Files:**
- Create: `tools/restore.mjs`
- Modify: `.gitignore`
- Test: `tests/desktop-backup.test.mjs`

**Interfaces:**
- Consumes: `fetchBackup`, `encodeBackup`, `decodeBackup` (tâche 7) ; `TABLES` (tâche 3) ; `freezeDays` (tâche 4).
- Produces: `restoreSql(doc) → string` ; CLI `node tools/restore.mjs <sauvegarde.json.gz> <sortie.sql>`.

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/desktop-backup.test.mjs` (imports en tête : `import { DatabaseSync } from 'node:sqlite';`, `SCHEMA` depuis `./server-harness.mjs`, `fetchBackup, encodeBackup` ajoutés à l'import de `../desktop/backup.mjs`, `import { TABLES } from '../server/backup.js';`, `import { freezeDays } from '../server/core.js';`, `import { restoreSql } from '../tools/restore.mjs';`) :

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/desktop-backup.test.mjs`
Expected: FAIL — `Cannot find module '../tools/restore.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Créer `tools/restore.mjs` :

```js
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

// Les lignes dans l'ordre de l'export (celui de la base d'origine) : mêmes rowid, même ordre.
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
```

Dans `.gitignore`, sous `reprise*.json`, ajouter :

```
# SQL de restauration d'une sauvegarde (données réelles).
restore*.sql
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/restore.mjs tests/desktop-backup.test.mjs .gitignore
git commit -m "feat(outils) : restauration d'une sauvegarde de bureau, aller-retour testé"
```

---

### Task 9: Bandeau d'alerte dans l'app

**Files:**
- Modify: `web/logic.js` (fonction `backupWarnings` + export dans `api`)
- Modify: `web/app.js` (`renderView`, nouvelle fonction `backupBanner`)
- Modify: `web/style.css` (classe `.banner-warn`)
- Test: `tests/logic.test.js`

**Interfaces:**
- Consumes: `status.backup` (tâche 6).
- Produces: `KTLogic.backupWarnings(backup, nowMs) → string[]`.

- [ ] **Step 1: Write the failing test**

Ajouter à `tests/logic.test.js` :

```js
test('alertes de sauvegarde', () => {
  const now = Date.parse('2026-10-08T12:00:00+02:00');
  assert.deepEqual(L.backupWarnings(undefined, now), []); // état d'une version sans sauvegardes
  assert.deepEqual(L.backupWarnings({ desktopAt: '2026-10-07T07:00:00.000Z', unfrozenSince: null }, now), []);
  assert.deepEqual(L.backupWarnings({ desktopAt: null, unfrozenSince: null }, now), ['Aucune sauvegarde sur le PC pour l’instant.']);
  assert.deepEqual(L.backupWarnings({ desktopAt: '2026-10-05T07:00:00.000Z', unfrozenSince: '2026-10-03' }, now), [
    'Pas de sauvegarde sur le PC depuis 3 jours.',
    'Journées non figées depuis le 03/10.',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logic.test.js`
Expected: FAIL — `L.backupWarnings is not a function`.

- [ ] **Step 3: Write minimal implementation**

Dans `web/logic.js`, avant `var api = {`, ajouter :

```js
  // Bandeau d'alerte : la copie du PC manque ou a plus de 48 h, ou une journée finie n'a pas été
  // figée (status.backup). Rien si le serveur ne donne pas encore cet état.
  var BACKUP_LATE_MS = 48 * 3600000;
  function backupWarnings(backup, nowMs) {
    if (!backup) return [];
    var out = [];
    if (!backup.desktopAt) out.push('Aucune sauvegarde sur le PC pour l’instant.');
    else {
      var age = nowMs - Date.parse(backup.desktopAt);
      if (age > BACKUP_LATE_MS) out.push('Pas de sauvegarde sur le PC depuis ' + Math.floor(age / 86400000) + ' jours.');
    }
    if (backup.unfrozenSince) {
      var p = backup.unfrozenSince.split('-');
      out.push('Journées non figées depuis le ' + p[2] + '/' + p[1] + '.');
    }
    return out;
  }
```

et ajouter `backupWarnings: backupWarnings,` à la dernière ligne de l'objet `api` (après `recapMatches: recapMatches,`).

Dans `web/app.js`, dans `renderView`, remplacer `app.innerHTML = header(s) + hero(s) +` par :

```js
    app.innerHTML = header(s) + backupBanner(s) + hero(s) +
```

et ajouter après la fonction `section(…)` :

```js
  // Sauvegardes en retard : visible partout, ne se ferme pas, disparaît quand elles repassent.
  function backupBanner(s) {
    var w = L.backupWarnings(s.backup, Date.now());
    return w.length ? '<div class="banner-warn" role="alert">' + w.map(esc).join('<br>') + '</div>' : '';
  }
```

Dans `web/style.css`, après la règle `.top { … }`, ajouter :

```css
.banner-warn { margin: 6px 0 10px; padding: 10px 12px; border-radius: 12px; background: var(--warn); color: #17171b; font-size: 14px; font-weight: 600; line-height: 1.35; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Vérifier à l'œil**

Run: `npm run dev`, ouvrir `http://localhost:8787/?dev-code=code-amohs`.
Expected: le bandeau « Aucune sauvegarde sur le PC pour l’instant. » sous la barre du haut, lisible en thème clair et sombre ; `?mini=1` l'affiche aussi. Arrêter le serveur.

- [ ] **Step 6: Commit**

```bash
git add web/logic.js web/app.js web/style.css tests/logic.test.js
git commit -m "feat(app) : bandeau quand les sauvegardes sont en retard"
```

---

### Task 10: La mini-fenêtre lance la copie

**Files:**
- Modify: `desktop/main.js` (réglage `backupDirs`, fonction `backupTick`, minuteries au lancement)

**Interfaces:**
- Consumes: `runBackup` (tâche 7) ; code de l'appareil dans le `localStorage` de la page (`kt.code`) ; API `SITE + 'api'`.

- [ ] **Step 1: Ajouter le réglage des dossiers**

Dans `loadSettings`, remplacer la ligne `return Object.assign({ locked: false, onTop: true, autostart: true, height: 360 }, saved);` par :

```js
  return Object.assign({
    locked: false, onTop: true, autostart: true, height: 360,
    // Sauvegardes : une copie par jour de travail dans chacun de ces dossiers (desktop/backup.mjs).
    backupDirs: [
      path.join(app.getPath('documents'), 'PROJECTS', 'KILOSAURUS', 'Sauvegardes'),
      'G:\\Mon Drive\\KILOSAURUS\\Temps\\Sauvegardes',
    ],
  }, saved);
```

- [ ] **Step 2: Ajouter la copie horaire**

Après la constante `RETRY_LOAD_MS`, ajouter :

```js
const BACKUP_FIRST_MS = 60 * 1000;      // laisse le réseau et Google Drive arriver au démarrage
const BACKUP_EVERY_MS = 60 * 60 * 1000;
```

Après la fonction `loadSite`, ajouter :

```js
// Sauvegarde : au lancement puis toutes les heures, jusqu'à ce que la copie du jour de travail soit
// dans tous les dossiers. Le code est celui que la page a gardé (code PC). Tout est noté dans
// desktop.log ; une panne se voit aussi dans l'app (bandeau), sur tous les appareils.
let backupRunning = false;
async function backupTick() {
  if (backupRunning || !win) return;
  backupRunning = true;
  try {
    const code = await win.webContents.executeJavaScript("localStorage.getItem('kt.code')");
    if (!code) { log('sauvegarde : pas de code, se connecter dans la mini-fenêtre'); return; }
    const { runBackup } = await import('./backup.mjs');
    const call = async (action, params = {}) => {
      const res = await fetch(SITE + 'api', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ code, action, ...params }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error.code + ' : ' + body.error.message);
      return body.data;
    };
    const r = await runBackup({ call, dirs: settings.backupDirs, log: (line) => log('sauvegarde ' + line) });
    log('sauvegarde ' + r.day + ' : ' + (r.status === 'done' ? 'complète' : 'incomplète, nouvel essai dans 1 h'));
  } catch (e) {
    log('sauvegarde ratée : ' + (e && e.message || e));
  } finally {
    backupRunning = false;
  }
}
```

Dans `app.whenReady().then(…)`, après `createTray();`, ajouter :

```js
    setTimeout(backupTick, BACKUP_FIRST_MS);
    setInterval(backupTick, BACKUP_EVERY_MS);
```

Compléter le commentaire d'en-tête du fichier, après la ligne sur `window.json` :

```js
// Sauvegardes : une copie vérifiée de toute la base par jour de travail, dans les dossiers
// `backupDirs` de window.json (PC et Google Drive), au lancement puis toutes les heures.
```

- [ ] **Step 3: Vérifier que rien d'autre ne casse**

Run: `npm test`
Expected: PASS (main.js n'est pas testé ; la logique l'est dans la tâche 7).

- [ ] **Step 4: Commit**

```bash
git add desktop/main.js
git commit -m "feat(bureau) : la mini-fenêtre fait la copie du jour au lancement puis toutes les heures"
```

La vérification en vrai se fait à la tâche 11, une fois le serveur déployé.

---

### Task 11: Documentation, mise en service et vérification en vrai

**Files:**
- Modify: `README.md`
- Modify: `claude/kilosaurus-temps/SKILL.md`

- [ ] **Step 1: README — remplacer la puce « Sauvegarde »**

Dans la section « Utilisation », remplacer les deux lignes de la puce `- **Sauvegarde** : D1 peut remettre la base…` par :

```markdown
- **Sauvegardes** : trois filets, tous automatiques.
  - Chaque journée finie est **figée** dans la base à 6 h le lendemain (cron du Worker, toutes les
    heures) : une copie de ses lignes que la base refuse de modifier ou d'effacer. Lecture : action
    `archivedDay`.
  - La **mini-fenêtre de bureau** range chaque jour une copie complète et vérifiée dans
    `Documents\PROJECTS\KILOSAURUS\Sauvegardes\` et `G:\Mon Drive\KILOSAURUS\Temps\Sauvegardes\`
    (`kilosaurus-temps_aaaa-mm-jj.json.gz`, jamais écrasés ; dossiers réglables dans `window.json`,
    clé `backupDirs`). Le détail est dans `desktop.log`.
  - D1 peut remettre la base à n'importe quelle minute des 7 derniers jours :
    `npx wrangler d1 time-travel restore kilosaurus-temps --timestamp <date ISO>`.

  Un bandeau orange s'affiche sur tous les appareils si la copie du PC manque ou a plus de 48 h,
  ou si une journée finie n'a pas été figée.
```

- [ ] **Step 2: README — section de restauration**

Avant `## Mettre à jour`, ajouter :

```markdown
## Restaurer une sauvegarde

1. `node tools/restore.mjs "<dossier>\kilosaurus-temps_aaaa-mm-jj.json.gz" restore.sql` : vérifie
   l'empreinte du fichier, écrit le SQL et affiche le nombre de lignes par table.
2. `npx wrangler d1 create kilosaurus-temps-restauree --location weur`
3. `npx wrangler d1 execute kilosaurus-temps-restauree --remote --file server/schema.sql`
4. `npx wrangler d1 execute kilosaurus-temps-restauree --remote --file restore.sql`
5. Relire les comptes et les comparer à ceux de l'étape 1 :
   `npx wrangler d1 execute kilosaurus-temps-restauree --remote --command "SELECT COUNT(*) FROM entries"`.
6. Mettre `database_name` et `database_id` de la nouvelle base dans `wrangler.toml`, puis
   `npm run deploy`.

`restore.sql` contient les heures réelles : il n'est jamais commité (`.gitignore`).

**Avant toute modification du schéma**, une sauvegarde à la main :
`npx wrangler d1 export kilosaurus-temps --remote --output ..\Sauvegardes\kilosaurus-temps_<date>_manuelle.sql`.
```

Et dans « Mettre à jour », compléter la puce **La base** par : `Les tables et triggers ajoutés au schéma s'appliquent avec npm run db:schema (création seulement).`

- [ ] **Step 3: Skill de l'agent**

Dans `claude/kilosaurus-temps/SKILL.md`, dans le tableau des actions, après la ligne `history`, ajouter :

```markdown
| `archivedDay` | `day` (`aaaa-mm-jj`) | Les lignes d'un jour figé, telles qu'elles étaient à 6 h le lendemain (supprimées comprises, `deleted: true`). Pour retrouver une version d'origine. Ne modifie rien. |
```

- [ ] **Step 4: Commit de la documentation**

```bash
git add README.md claude/kilosaurus-temps/SKILL.md
git commit -m "docs : sauvegardes et restauration"
```

- [ ] **Step 5: Sauvegarde manuelle juste avant la mise en service**

```bash
STAMP=$(date +%Y-%m-%d_%H%M)
npx wrangler d1 export kilosaurus-temps --remote --output "../Sauvegardes/kilosaurus-temps_${STAMP}_avant-sauvegardes.sql"
cp -n "../Sauvegardes/kilosaurus-temps_${STAMP}_avant-sauvegardes.sql" "/g/Mon Drive/KILOSAURUS/Temps/Sauvegardes/"
sha256sum "../Sauvegardes/kilosaurus-temps_${STAMP}_avant-sauvegardes.sql" "/g/Mon Drive/KILOSAURUS/Temps/Sauvegardes/kilosaurus-temps_${STAMP}_avant-sauvegardes.sql"
```

Expected: deux empreintes identiques.

- [ ] **Step 6: Essayer le schéma en local (même moteur que D1)**

```bash
npx wrangler d1 execute kilosaurus-temps --local --file server/schema.sql
npx wrangler d1 execute kilosaurus-temps --local --command "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
npx wrangler d1 execute kilosaurus-temps --local --command "INSERT INTO archive_days VALUES ('2000-01-01', 0, 0, 0)"
npx wrangler d1 execute kilosaurus-temps --local --command "DELETE FROM archive_days"
```

Expected: 4 triggers (`archive_days_no_delete`, `archive_days_no_update`, `archive_entries_no_delete`, `archive_entries_no_update`) ; la dernière commande échoue avec `archive figée`. **Si wrangler refuse les triggers, s'arrêter** et le signaler : ne rien appliquer en ligne.

- [ ] **Step 7: Appliquer le schéma en ligne et vérifier**

```bash
npm run db:schema
npx wrangler d1 execute kilosaurus-temps --remote --command "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
```

Expected: les 4 triggers.

- [ ] **Step 8: Déployer**

Run: `npm run deploy`
Expected: le résumé de wrangler liste le déclencheur `schedule: 5 * * * *`.

- [ ] **Step 9: Vérifier le cron (après la prochaine minute 5, puis jusqu'à 3 heures pour le rattrapage)**

```bash
npx wrangler d1 execute kilosaurus-temps --remote --command "SELECT COUNT(*) AS jours, MIN(day), MAX(day) FROM archive_days"
npx wrangler d1 execute kilosaurus-temps --remote --command "SELECT value FROM settings WHERE key = 'archive_through'"
```

Expected: le nombre de jours augmente à chaque heure (20 au plus) ; à la fin, `archive_through` = la veille du jour de travail en cours, et `MAX(day)` = le dernier jour fini qui a des lignes.

- [ ] **Step 10: Vérifier la mini-fenêtre**

Relancer la mini-fenêtre **depuis un terminal hors de VS Code** (`ELECTRON_RUN_AS_NODE` l'empêche sinon) : icône près de l'horloge → Quitter, puis `cd desktop && npm start`. Attendre 2 minutes.

```powershell
Get-Content "$env:APPDATA\kilosaurus-temps-desktop\desktop.log" -Tail 6
Get-ChildItem "$env:USERPROFILE\Documents\PROJECTS\KILOSAURUS\Sauvegardes", "G:\Mon Drive\KILOSAURUS\Temps\Sauvegardes"
```

Expected: `sauvegarde … : written` pour les deux dossiers puis `sauvegarde <jour> : complète` ; un `kilosaurus-temps_<jour>.json.gz` dans chaque dossier ; dans l'app, le bandeau a disparu (une fois le rattrapage du cron fini).

- [ ] **Step 11: Exercice de restauration sur la vraie copie**

```bash
node tools/restore.mjs "../Sauvegardes/kilosaurus-temps_<jour>.json.gz" ../Sauvegardes/restore-essai.sql
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync('server/schema.sql','utf8'));db.exec(fs.readFileSync('../Sauvegardes/restore-essai.sql','utf8'));for(const t of ['projects','settings','entries','ops','archive_days','archive_entries'])console.log(t,db.prepare('SELECT COUNT(*) n FROM '+t).get().n)"
npx wrangler d1 execute kilosaurus-temps --remote --command "SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM settings) s, (SELECT COUNT(*) FROM entries) e, (SELECT COUNT(*) FROM ops) o, (SELECT COUNT(*) FROM archive_days) d, (SELECT COUNT(*) FROM archive_entries) a"
rm ../Sauvegardes/restore-essai.sql
```

Expected: mêmes comptes des deux côtés (à une écriture près si un appareil a tapé entre-temps).

- [ ] **Step 12: Skill installé sur la machine**

La copie du skill dans `~/.claude/skills/kilosaurus-temps/` ne se met pas à jour seule : la remplacer par `claude/kilosaurus-temps/SKILL.md` (README, « Loguer depuis un agent »), avec l'accord de l'utilisateur.
