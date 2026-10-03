# Kilosaurus Temps v2 — plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes sont des cases à cocher (`- [ ]`).

**Objectif :** remplacer la Google Sheet et l'Apps Script par un Worker Cloudflare et une base D1,
ajouter l'annulation et la fenêtre des sessions, et rendre le widget Android stable.

**Architecture :** un Worker (`server/worker.js`) sert l'API `POST /api` et les fichiers de `web/`.
Les règles métier (`server/core.js`) ne parlent qu'à une petite interface SQL (`all`, `first`,
`batch`) fournie par D1 en production et par `node:sqlite` dans les tests et le serveur de dev.
Chaque écriture enregistre ses changements de lignes et une entrée de journal (`ops`) dans la même
transaction ; l'annulation rejoue l'état d'avant. Les clients gardent le protocole actuel (POST
JSON en `text/plain`) et changent seulement d'adresse.

**Technologies :** Cloudflare Workers + D1 (SQLite), Node 24 (`node:test`, `node:sqlite`),
wrangler 4 (dépendance de dev), JavaScript sans framework côté web, Java sans Gradle côté Android,
Python 3 + openpyxl + tzdata pour la reprise.

**Spec :** `docs/specs/2026-10-03-base-de-donnees-design.md`

Dépôt : `C:\Users\honor\Documents\PROJECTS\KILOSAURUS\TimeTracker`. Toutes les commandes se lancent
depuis sa racine, dans Git Bash. Python s'appelle `py` sur cette machine.

## Contraintes globales

- Node 24 ou plus récent (`node:sqlite` sans option). Vérifié : v24.19.0 installé.
- L'app web et l'APK n'ont aucune dépendance. Seul ajout : `wrangler` en dépendance de dev.
- Protocole inchangé : `POST /api`, `Content-Type: text/plain`, corps `{ code, action, … }`,
  réponse `{ ok, data }` ou `{ ok: false, error: { code, message } }`.
- Codes d'erreur : `unauthorized`, `invalid`, `busy`, `locked`, `server`.
- Heures stockées en millisecondes UTC ; jours `aaaa-mm-jj` au fuseau Europe/Paris.
- Une session : 24 h au plus ; durée nulle permise. Un nouveau bloc : 2 / 4 / 6 / 8 / 10 / 12 h ;
  un bloc repris : 0 à 24 h.
- Codes d'accès : secrets `CODE_<NOM>[_<APPAREIL>]`, 32 caractères au minimum ; segment `CLAUDE` =
  code d'agent.
- Blocage : 10 codes refusés en 15 min depuis une même adresse IP → cette adresse bloquée 1 h.
- Offre gratuite Cloudflare : relecture de l'état toutes les 20 s au plus.
- Textes visibles et commentaires en français, comme le reste du dépôt.
- Les fichiers `.xlsx` et `.sql` de reprise ne sont jamais commités (données réelles).

## Points de vigilance

Les cinq situations les plus susceptibles de casser l'usage réel, et le test qui les couvre :

1. **Annuler une bascule** (un compteur fermé, un autre ouvert) : la restauration doit défaire les
   changements dans l'ordre inverse, sinon deux compteurs tournent un instant et l'index unique
   refuse tout. Test « annuler une bascule » (tâche 3).
2. **Un compteur oublié plus de 24 h**, puis STOP ou une bascule : refus clair qui demande une heure
   de fin, pas une erreur `server`. Test « compteur de plus de 24 h » (tâche 2).
3. **Deux appareils qui lancent en même temps** : l'index unique refuse le second compteur ; le
   client doit recevoir `busy` (il réessaie), pas `server`. Test « deux lancements simultanés »
   (tâche 2).
4. **Un widget réglé avant la v2** garde l'adresse de l'Apps Script dans ses préférences : elle doit
   être remplacée par la nouvelle sans réglage. Vérification manuelle (tâche 8, étape 6).
5. **Corriger une session qui passe minuit** dans la fenêtre des sessions : une fin plus tôt que le
   début tombe le lendemain. Test « correction : fin après minuit » (tâche 6).

S'y ajoute le jour du changement d'heure : début de journée et jour suivant corrects le dernier
dimanche d'octobre. Test « fuseau : changement d'heure » (tâche 1).

---

### Tâche 1 : Schéma de la base, accès SQLite, fuseau

**Fichiers :**
- Créer : `server/package.json`, `server/schema.sql`, `server/db.js`, `server/tz.js`
- Créer : `tests/server-harness.mjs`, `tests/server-schema.test.mjs`
- Modifier : `package.json` (script de test)

**Interfaces :**
- Produit : `fromD1(d1)` et `fromSqlite(db)` → `{ all(sql, params), first(sql, params), batch([{ sql, params }]) }`
  (toutes asynchrones) ; `dayKey(ms)`, `dayStart(key)`, `nextDayStart(dayStartMs)`, `clock(ms)`,
  `shortDate(ms)` ; dans le harnais : `makeDb(opts)`, `insertRow(sqlite, fields)`, `at(iso)`.

- [ ] **Étape 1 : écrire les tests du schéma et du fuseau**

`tests/server-schema.test.mjs` :

```js
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
```

- [ ] **Étape 2 : écrire le harnais**

`tests/server-harness.mjs` :

```js
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
```

- [ ] **Étape 3 : lancer les tests, vérifier qu'ils échouent**

Lancer : `node --test tests/server-schema.test.mjs`
Attendu : ÉCHEC, `Cannot find module '…/server/db.js'` (ou `schema.sql` introuvable).

- [ ] **Étape 4 : écrire le schéma, l'accès et le fuseau**

`server/package.json` :

```json
{ "type": "module" }
```

`server/schema.sql` :

```sql
-- Base de Kilosaurus Temps (Cloudflare D1, SQLite). Appliquer avec :
--   npx wrangler d1 execute kilosaurus-temps --remote --file server/schema.sql
-- Heures en millisecondes UTC ; jours aaaa-mm-jj au fuseau de Paris.

CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  position INTEGER NOT NULL          -- ordre des boutons
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,              -- me, studio, visible, threshold
  value TEXT NOT NULL
);

-- Sessions (début, fin) et blocs (heures sur un jour). Une suppression est douce : deleted_ms.
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,               -- créé par le client : une requête rejouée n'écrit pas deux fois
  project TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'block')),
  day TEXT NOT NULL,                 -- jour du début (session) ou jour déclaré (bloc)
  start_ms INTEGER,
  end_ms INTEGER,                    -- vide : compteur en cours
  hours REAL,                        -- bloc seulement ; la durée d'une session se calcule
  type TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,              -- app, hors ligne, claude, report
  created_ms INTEGER NOT NULL,
  touched_ms INTEGER NOT NULL,       -- dernière écriture : fait le « dernier log »
  deleted_ms INTEGER,
  CHECK (kind <> 'session' OR (start_ms IS NOT NULL AND hours IS NULL)),
  CHECK (kind <> 'block' OR (start_ms IS NULL AND end_ms IS NULL AND hours > 0 AND hours <= 24)),
  CHECK (end_ms IS NULL OR (end_ms >= start_ms AND end_ms - start_ms <= 86400000))
);

-- Un seul compteur en cours, même si deux appareils lancent en même temps.
CREATE UNIQUE INDEX IF NOT EXISTS one_running ON entries (kind)
  WHERE kind = 'session' AND end_ms IS NULL AND deleted_ms IS NULL;
CREATE INDEX IF NOT EXISTS entries_day ON entries (day);
CREATE INDEX IF NOT EXISTS entries_start ON entries (start_ms);
CREATE INDEX IF NOT EXISTS entries_touched ON entries (touched_ms);

-- Journal des écritures, pour annuler : chaque action garde l'état avant / après des lignes touchées.
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,             -- « Lancement Heirfall · Writing à 14:02 »
  source TEXT NOT NULL,
  changes TEXT NOT NULL,             -- JSON : [{ table, key, before, after }]
  undone_ms INTEGER
);

-- Codes refusés par adresse IP (blocage d'une heure après 10 refus en 15 min).
CREATE TABLE IF NOT EXISTS lockouts (
  ip TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  first_ms INTEGER NOT NULL,
  until_ms INTEGER
);
```

`server/db.js` :

```js
// Petite interface SQL commune à D1 (production) et à node:sqlite (tests, serveur de dev). Les
// règles métier n'utilisent qu'elle : les mêmes requêtes tournent dans les deux.
//   all(sql, params)   → toutes les lignes
//   first(sql, params) → la première ligne, ou null
//   batch([{ sql, params }]) → les écritures, en une seule transaction (tout ou rien)

export function fromD1(d1) {
  const prepare = (sql, params = []) => d1.prepare(sql).bind(...params);
  return {
    async all(sql, params) { return (await prepare(sql, params).all()).results; },
    async first(sql, params) { return (await prepare(sql, params).first()) ?? null; },
    async batch(stmts) { if (stmts.length) await d1.batch(stmts.map((s) => prepare(s.sql, s.params))); },
  };
}

export function fromSqlite(db) {
  return {
    async all(sql, params = []) { return db.prepare(sql).all(...params); },
    async first(sql, params = []) { return db.prepare(sql).get(...params) ?? null; },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        for (const s of stmts) db.prepare(s.sql).run(...(s.params || []));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
```

`server/tz.js` :

```js
// Fuseau Europe/Paris, par Intl (disponible dans les Workers comme dans Node). Tout est en
// millisecondes UTC ; un jour est une clé 'aaaa-mm-jj'.
const TZ = 'Europe/Paris';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parts(ms) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value;
  return p;
}

// Écart entre l'heure de Paris et UTC à cet instant (1 h ou 2 h).
function offsetMs(ms) {
  const p = parts(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

export function dayKey(ms) { return dayFmt.format(new Date(ms)); }

export function dayStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - offsetMs(guess);
}

// Début du jour suivant, sûr aux changements d'heure (jour de 23 ou 25 h).
export function nextDayStart(dayStartMs) { return dayStart(dayKey(dayStartMs + 36 * 3600000)); }

export function clock(ms) { const p = parts(ms); return `${p.hour}:${p.minute}`; }

export function shortDate(ms) { const p = parts(ms); return `${p.day}/${p.month}`; }
```

Dans `package.json`, remplacer la ligne `"test"` par :

```json
    "test": "node --test \"tests/*.test.js\" \"tests/*.test.mjs\"",
```

- [ ] **Étape 5 : lancer les tests, vérifier qu'ils passent**

Lancer : `node --test tests/server-schema.test.mjs`
Attendu : 6 tests, tous `ok`.

- [ ] **Étape 6 : commit**

```bash
git add server/package.json server/schema.sql server/db.js server/tz.js tests/server-harness.mjs tests/server-schema.test.mjs package.json
git commit -m "feat(serveur) : schéma D1, accès SQLite commun D1 / node:sqlite, fuseau de Paris"
```

---

### Tâche 2 : Règles métier — état et actions existantes

**Fichiers :**
- Créer : `server/core.js`
- Créer : `tests/server-core.test.mjs`

**Interfaces :**
- Consomme : `fromSqlite`, `dayKey`, `dayStart`, `nextDayStart`, `clock`, `shortDate` (tâche 1).
- Produit : `handleRequest(env, body)` → `Promise<{ ok, data } | { ok: false, error }>` avec
  `env = { db, now: () => ms, auth: (code) => ({ agent }) | null }` ; `isWrite(action)` ;
  `TYPES`, `BLOCK_HOURS`, `toApi(row)`. Dans le module : `actions`, `commit(ctx, action, summary,
  changes)`, `change(before, after)`, `plain(row)`, `writeRow(table, key, row)`, `running(db)`,
  `byId(db, id)`, `undoTarget(db)`, `overlapping(ctx, start, end, exceptId)`, `typeOf(row)`,
  `requireProject`, `requireType`, `requireBlockHours`, `cleanNote`, `parseInstant`, `fail`,
  `AppError`, `MAX_SESSION_MS`, `ACTIVE`, `ENTRY_COLUMNS` (réutilisés par la tâche 3).
- Forme de `status` : `{ me, agent, projects, studio, visible, threshold, running, last, types,
  today, undo: { opId, summary } | null, serverTime, now }`. Forme d'une ligne (`toApi`) :
  `{ id, project, type, date, start, end, hours, note, source }`.

- [ ] **Étape 1 : écrire les tests**

`tests/server-core.test.mjs` :

```js
// Règles métier (server/core.js) sur une base SQLite en mémoire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClock, insertRow, ok, fails, at } from './server-harness.mjs';

const H = 3600000;

test('auth : code inconnu ou absent → unauthorized', async () => {
  const { call } = await makeEnv();
  fails(await call('status', {}, 'nope'), 'unauthorized');
  fails(await call('status', {}, undefined), 'unauthorized');
});

test('action inconnue → invalid', async () => {
  const { call } = await makeEnv();
  fails(await call('explode'), 'invalid');
});

test('status initial', async () => {
  const { call } = await makeEnv();
  const s = ok(await call('status'));
  assert.equal(s.me, 'Amohs');
  assert.equal(s.agent, false);
  assert.deepEqual(s.projects, ['Fluffy', 'Studio']);
  assert.equal(s.studio, 'Studio');
  assert.equal(s.visible, 4);
  assert.equal(s.threshold, 8);
  assert.equal(s.running, null);
  assert.equal(s.last, null);
  assert.equal(s.undo, null);
  assert.equal(s.serverTime, new Date('2026-10-01T09:00:00+02:00').toISOString());
});

test('start ouvre un compteur', async () => {
  const { call, row, clock } = await makeEnv();
  const s = ok(await call('start', { id: 'a1', project: 'Fluffy', note: 'menus' }));
  assert.equal(s.running.id, 'a1');
  assert.equal(s.running.project, 'Fluffy');
  assert.equal(s.running.start, new Date(clock.now()).toISOString());
  assert.equal(s.running.note, 'menus');
  assert.equal(s.running.hours, null);
  const r = row('a1');
  assert.equal(r.source, 'app');
  assert.equal(r.end_ms, null);
  assert.equal(r.created_ms, clock.now());
});

test('start : projet inconnu, décalage hors liste, id manquant → invalid', async () => {
  const { call } = await makeEnv();
  fails(await call('start', { id: 'a1', project: 'Nope' }), 'invalid');
  fails(await call('start', { id: 'a1', project: 'Fluffy', offsetMinutes: 20 }), 'invalid');
  fails(await call('start', { project: 'Fluffy' }), 'invalid');
});

test('bascule : l\'ancien compteur se ferme à l\'heure du nouveau début', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(90);
  const s = ok(await call('start', { id: 'a2', project: 'Studio' }));
  assert.equal(row('a1').end_ms, clock.now());
  assert.equal(s.running.id, 'a2');
  assert.equal(s.last.id, 'a1');
  assert.equal(s.last.hours, 1.5);
});

test('bascule avec décalage : pas de chevauchement', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(90);
  ok(await call('start', { id: 'a2', project: 'Studio', offsetMinutes: 30 }));
  assert.equal(row('a2').start_ms, row('a1').end_ms);
  assert.equal(row('a1').end_ms - row('a1').start_ms, H);
});

test('décalage qui remonte avant le compteur en cours : ramené à son début (durée nulle)', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  const t0 = clock.now();
  clock.advance(10);
  const s = ok(await call('start', { id: 'a2', project: 'Studio', offsetMinutes: 60 }));
  assert.equal(row('a2').start_ms, t0);
  assert.equal(s.last.hours, 0);
});

test('start rejoué avec le même id : une seule ligne', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(5);
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].end_ms, null);
});

test('stop ferme le compteur ; stop sans compteur ne fait rien', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(45);
  const s = ok(await call('stop'));
  assert.equal(s.running, null);
  assert.equal(s.last.id, 'a1');
  assert.equal(s.last.hours, 0.75);
  clock.advance(5);
  ok(await call('stop'));
  assert.equal(row('a1').end_ms, clock.now() - 5 * 60000);
});

test('stop avec heure de fin (oubli)', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(12 * 60);
  const s = ok(await call('stop', { endAt: '2026-10-01T18:00:00+02:00' }));
  assert.equal(s.last.hours, 9);
});

test('stop avec heure de fin avant le début, dans le futur ou illisible → invalid', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  fails(await call('stop', { endAt: '2026-10-01T08:00:00+02:00' }), 'invalid');
  fails(await call('stop', { endAt: '2026-10-01T23:00:00+02:00' }), 'invalid');
  fails(await call('stop', { endAt: 'pas une date' }), 'invalid');
});

test('compteur de plus de 24 h : STOP et bascule refusés avec un message clair, l\'heure de fin passe', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.set('2026-10-02T10:00:00+02:00');
  fails(await call('stop'), 'invalid', /24 h/);
  fails(await call('start', { id: 'a2', project: 'Studio' }), 'invalid', /24 h/);
  const s = ok(await call('stop', { endAt: '2026-10-01T18:00:00+02:00' }));
  assert.equal(s.running, null);
});

test('deux lancements simultanés : le second reçoit busy, pas server', async () => {
  const { call, env } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  // Simule une lecture faite avant que l'autre appareil n'écrive : « aucun compteur en cours ».
  const realFirst = env.db.first;
  env.db.first = async (sql, params) => (/end_ms IS NULL AND deleted_ms IS NULL$/.test(sql) ? null : realFirst(sql, params));
  fails(await call('start', { id: 'a2', project: 'Studio' }), 'busy');
});

test('note : modifie le compteur en cours', async () => {
  const { call } = await makeEnv();
  fails(await call('note', { text: 'x' }), 'invalid');
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(await call('note', { text: 'boss final' }));
  assert.equal(s.running.note, 'boss final');
});

test('logBlock : bloc du jour, sans toucher au compteur', async () => {
  const { call, row } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(await call('logBlock', { id: 'b1', project: 'Studio', hours: 8 }));
  const b = row('b1');
  assert.equal(b.kind, 'block');
  assert.equal(b.start_ms, null);
  assert.equal(b.hours, 8);
  assert.equal(s.running.id, 'a1');
  assert.equal(s.last.id, 'b1');
  assert.equal(s.last.date, '2026-10-01');
});

test('logBlock : heures hors liste, date future ou mal formée → invalid ; date passée ok', async () => {
  const { call } = await makeEnv();
  fails(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 5 }), 'invalid');
  fails(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 14 }), 'invalid');
  fails(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-10-02' }), 'invalid');
  fails(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '01/10/2026' }), 'invalid');
  const s = ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-09-14' }));
  assert.equal(s.last.date, '2026-09-14');
});

test('logBlock rejoué : une seule ligne', async () => {
  const { call, rows } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  assert.equal(rows().length, 1);
});

test('hors ligne : l\'heure du tap fait foi, jamais dans le futur', async () => {
  const { call, row } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', offline: true, clientTime: '2026-10-01T08:30:00+02:00' }));
  assert.equal(row('a1').start_ms, at('2026-10-01T08:30:00+02:00'));
  assert.equal(row('a1').source, 'hors ligne');
  ok(await call('start', { id: 'a2', project: 'Studio', offline: true, clientTime: '2026-10-01T11:00:00+02:00' }));
  assert.equal(row('a2').start_ms, at('2026-10-01T09:00:00+02:00'));
});

test('hors ligne : clientTime ignoré sans le drapeau offline', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', clientTime: '2026-10-01T08:30:00+02:00' }));
  assert.equal(row('a1').start_ms, clock.now());
  assert.equal(row('a1').source, 'app');
});

test('hors ligne : un stop plus ancien que le compteur en cours ne le ferme pas', async () => {
  const { call, clock } = await makeEnv({ clock: makeClock('2026-10-01T10:30:00+02:00') });
  ok(await call('start', { id: 'pc', project: 'Fluffy' }));
  clock.advance(30);
  const s = ok(await call('stop', { offline: true, clientTime: '2026-10-01T10:00:00+02:00' }));
  assert.equal(s.running.id, 'pc');
});

test('hors ligne : un bloc « aujourd\'hui » rejoué compte pour le jour du tap', async () => {
  const { call } = await makeEnv({ clock: makeClock('2026-10-02T00:30:00+02:00') });
  const s = ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2, offline: true, clientTime: '2026-10-01T23:30:00+02:00' }));
  assert.equal(s.last.date, '2026-10-01');
});

test('jour d\'une session = jour de Paris du début', async () => {
  const { call } = await makeEnv({ clock: makeClock('2026-10-01T00:30:00+02:00') });
  const s = ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(s.running.date, '2026-10-01');
});

test('tapTime : l\'heure du tap (widget) fait foi, source app, jamais dans le futur', async () => {
  const { call, row } = await makeEnv();
  ok(await call('start', { id: 'w1', project: 'Fluffy', tapTime: '2026-10-01T08:59:40+02:00' }));
  assert.equal(row('w1').start_ms, at('2026-10-01T08:59:40+02:00'));
  assert.equal(row('w1').source, 'app');
  ok(await call('stop', { tapTime: '2026-10-01T09:30:00+02:00' }));
  assert.equal(row('w1').end_ms, at('2026-10-01T09:00:00+02:00'));
});

test('logSession : réservé aux codes d\'agent', async () => {
  const { call } = await makeEnv();
  fails(await call('logSession', { id: 's1', project: 'Fluffy', start: '2026-10-01T06:00:00+02:00', end: '2026-10-01T08:00:00+02:00' }), 'invalid');
});

test('logSession : source claude', async () => {
  const { call, row } = await makeEnv();
  const s = ok(await call('logSession', { id: 's1', project: 'Fluffy', start: '2026-09-30T14:00:00+02:00', end: '2026-09-30T17:12:00+02:00', note: 'refacto save' }, 'code-amohs-claude'));
  assert.equal(row('s1').source, 'claude');
  assert.equal(s.agent, true);
  assert.equal(s.last.hours, 3.2);
  assert.equal(s.last.date, '2026-09-30');
});

test('logSession : chevauchement, fin future, plus de 24 h, début ≥ fin → invalid', async () => {
  const { call } = await makeEnv();
  const agent = (p) => call('logSession', p, 'code-amohs-claude');
  ok(await agent({ id: 's1', project: 'Fluffy', start: '2026-09-30T14:00:00+02:00', end: '2026-09-30T17:00:00+02:00' }));
  fails(await agent({ id: 's2', project: 'Studio', start: '2026-09-30T16:00:00+02:00', end: '2026-09-30T18:00:00+02:00' }), 'invalid', /Chevauche/);
  fails(await agent({ id: 's3', project: 'Fluffy', start: '2026-10-01T08:00:00+02:00', end: '2026-10-01T10:00:00+02:00' }), 'invalid');
  fails(await agent({ id: 's4', project: 'Fluffy', start: '2026-09-28T08:00:00+02:00', end: '2026-09-29T09:00:00+02:00' }), 'invalid');
  fails(await agent({ id: 's5', project: 'Fluffy', start: '2026-09-29T10:00:00+02:00', end: '2026-09-29T10:00:00+02:00' }), 'invalid');
  ok(await agent({ id: 's6', project: 'Fluffy', start: '2026-09-30T17:00:00+02:00', end: '2026-09-30T18:00:00+02:00' }));
});

test('logSession : chevauche le compteur en cours → invalid', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'l1', project: 'Fluffy' }));
  clock.advance(120);
  fails(await call('logSession', { id: 's1', project: 'Fluffy', start: '2026-10-01T09:30:00+02:00', end: '2026-10-01T10:00:00+02:00' }, 'code-amohs-claude'), 'invalid');
});

test('dernier log : le plus récent écrit, reports et compteur en cours exclus', async () => {
  const { call, sqlite, clock } = await makeEnv();
  insertRow(sqlite, { id: 'report-0001', kind: 'block', day: '2026-09-30', hours: 8, source: 'report', touched_ms: at('2026-10-01T08:59:00+02:00') });
  assert.equal(ok(await call('status')).last, null);
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-09-20' }));
  clock.advance(1);
  ok(await call('logBlock', { id: 'b2', project: 'Fluffy', hours: 4, date: '2026-09-10' }));
  clock.advance(1);
  const s = ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(s.last.id, 'b2');
});

test('dernier log : un compteur oublié qu\'on ferme passe devant un bloc saisi entre-temps', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(await call('logBlock', { id: 'b1', project: 'Studio', hours: 2, date: '2026-09-30' }));
  clock.advance(600);
  const s = ok(await call('stop', { endAt: '2026-10-01T17:00:00+02:00' }));
  assert.equal(s.last.id, 'a1');
});

test('addProject : ajouté après le dernier projet', async () => {
  const { call } = await makeEnv();
  const s = ok(await call('addProject', { name: '  Heirfall ' }));
  assert.deepEqual(s.projects, ['Fluffy', 'Studio', 'Heirfall']);
  ok(await call('start', { id: 'a1', project: 'Heirfall' }));
});

test('addProject : noms refusés', async () => {
  const { call } = await makeEnv();
  for (const name of ['', '   ', 'fluffy', '_Secret', 'a/b', 'x'.repeat(31)]) {
    fails(await call('addProject', { name }), 'invalid');
  }
});

test('erreur interne → server, sans faire planter l\'appelant', async () => {
  const { env, handleRequest } = await makeEnv();
  env.db = { ...env.db, all: async () => { throw new Error('boom'); } };
  fails(await handleRequest(env, { code: 'code-amohs', action: 'status' }), 'server');
});

test('type : Misc par défaut, bascule de type sans trou, même type → rien', async () => {
  const { call, rows, clock } = await makeEnv();
  let s = ok(await call('start', { id: 't1', project: 'Fluffy' }));
  assert.equal(s.running.type, 'Misc');
  clock.advance(10);
  ok(await call('start', { id: 't2', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  s = ok(await call('start', { id: 't3', project: 'Fluffy', type: 'Art' }));
  const [, b, c] = rows();
  assert.equal(b.type, 'Dev');
  assert.equal(b.end_ms, c.start_ms);
  assert.equal(s.last.type, 'Dev');
  clock.advance(10);
  s = ok(await call('start', { id: 't4', project: 'Fluffy', type: 'Art' }));
  assert.equal(s.running.id, 't3');
});

test('type : start sans type garde celui du compteur en cours ; inconnu → invalid ; blocs typés', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 't1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(10);
  const s = ok(await call('start', { id: 't2', project: 'Studio' }));
  assert.equal(s.running.type, 'Dev');
  fails(await call('start', { id: 't3', project: 'Fluffy', type: 'Musique' }), 'invalid');
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2, type: 'Writing' }));
  assert.equal(row('b1').type, 'Writing');
});

test('type : anciens noms (Autre, Narration) lus et acceptés comme Misc, Writing', async () => {
  const { call, sqlite, row, clock } = await makeEnv();
  insertRow(sqlite, { id: 'o1', type: 'Autre', start_ms: at('2026-10-01T07:00:00+02:00'), end_ms: at('2026-10-01T07:30:00+02:00') });
  insertRow(sqlite, { id: 'o2', type: 'Narration', start_ms: at('2026-10-01T07:30:00+02:00'), end_ms: at('2026-10-01T08:00:00+02:00') });
  const h = ok(await call('history', { from: '2026-10-01', to: '2026-10-01' }));
  assert.deepEqual(h.rows.map((r) => r.type), ['Misc', 'Writing']);
  const s = ok(await call('start', { id: 'n1', project: 'Fluffy', type: 'Narration' }));
  assert.equal(s.running.type, 'Writing');
  assert.equal(row('n1').type, 'Writing');
  clock.advance(5);
  assert.equal(ok(await call('start', { id: 'n2', project: 'Fluffy', type: 'Writing' })).running.id, 'n1');
});

test('status.types et status.today', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('logBlock', { id: 'y', project: 'Fluffy', hours: 2, date: '2026-09-30' }));
  ok(await call('start', { id: 'a', project: 'Fluffy', type: 'Dev' }));
  clock.advance(60);
  const s = ok(await call('start', { id: 'b', project: 'Fluffy', type: 'Art' }));
  assert.deepEqual(s.types.map((t) => t.name), ['Misc', 'Writing', 'Sound', 'Market', 'Concept', 'Art', 'TechArt', 'UI', 'Dev', 'Gameplay', 'Tooling', 'Debug', 'Pause']);
  assert.deepEqual(s.today.map((r) => r.id), ['a', 'b']);
  assert.equal(s.today[1].end, null);
});

test('status.today : une session d\'hier encore en cours en fait partie', async () => {
  const { call, clock } = await makeEnv({ clock: makeClock('2026-09-30T22:00:00+02:00') });
  ok(await call('start', { id: 'n', project: 'Fluffy' }));
  clock.set('2026-10-01T01:00:00+02:00');
  assert.deepEqual(ok(await call('status')).today.map((r) => r.id), ['n']);
});

test('history : lignes de la période, bornes incluses ; dates invalides ou plus de 62 jours → invalid', async () => {
  const { call } = await makeEnv();
  ok(await call('logBlock', { id: 'd28', project: 'Fluffy', hours: 2, date: '2026-09-28' }));
  ok(await call('logBlock', { id: 'd29', project: 'Fluffy', hours: 4, date: '2026-09-29', type: 'Dev' }));
  ok(await call('logBlock', { id: 'd30', project: 'Studio', hours: 6, date: '2026-09-30' }));
  const h = ok(await call('history', { from: '2026-09-29', to: '2026-09-30' }));
  assert.deepEqual(h.rows.map((r) => r.id), ['d29', 'd30']);
  assert.equal(h.rows[0].type, 'Dev');
  assert.equal(h.from, '2026-09-29');
  fails(await call('history', { from: '2026-10-01', to: '2026-09-01' }), 'invalid');
  fails(await call('history', { from: '2026-01-01', to: '2026-03-15' }), 'invalid');
  fails(await call('history', { from: 'hier', to: '2026-10-01' }), 'invalid');
  ok(await call('history', { from: '2026-08-01', to: '2026-10-01' }));
});

test('pause : un morceau de type Pause, puis reprise sur la tâche', async () => {
  const { call, rows, clock } = await makeEnv();
  ok(await call('start', { id: 'w1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(60);
  let s = ok(await call('start', { id: 'p1', project: 'Fluffy', type: 'Pause' }));
  assert.equal(s.running.type, 'Pause');
  assert.equal(s.last.type, 'Dev');
  clock.advance(15);
  s = ok(await call('start', { id: 'w2', project: 'Fluffy', type: 'Dev' }));
  assert.equal(s.running.type, 'Dev');
  assert.deepEqual(rows().map((r) => [r.type, r.end_ms == null ? null : (r.end_ms - r.start_ms) / H]), [['Dev', 1], ['Pause', 0.25], ['Dev', null]]);
});

test('journal : chaque écriture laisse une action annulable, résumée en clair', async () => {
  const { call } = await makeEnv();
  const s = ok(await call('start', { id: 'a1', project: 'Fluffy', type: 'Writing' }));
  assert.equal(typeof s.undo.opId, 'number');
  assert.equal(s.undo.summary, 'Lancement Fluffy · Writing à 09:00');
  assert.equal(ok(await call('status')).undo.opId, s.undo.opId, 'une lecture n\'écrit rien au journal');
});
```

- [ ] **Étape 2 : lancer les tests, vérifier qu'ils échouent**

Lancer : `node --test tests/server-core.test.mjs`
Attendu : ÉCHEC, `Cannot find module '…/server/core.js'`.

- [ ] **Étape 3 : écrire `server/core.js`**

```js
/**
 * Règles métier de Kilosaurus Temps. Ne connaît ni D1 ni le Worker : tout passe par `env`.
 *   env.db   — interface SQL (server/db.js) : all, first, batch
 *   env.now  — horloge, () → millisecondes
 *   env.auth — code → { agent } ou null
 *
 * Chaque écriture enregistre ses changements de lignes et une entrée du journal `ops` dans la même
 * transaction : c'est ce qui permet d'annuler (action `undo`).
 */
import { dayKey, dayStart, nextDayStart, clock, shortDate } from './tz.js';

export const BLOCK_HOURS = [2, 4, 6, 8, 10, 12];
const OFFSETS = [0, 15, 30, 60];
export const MAX_SESSION_MS = 24 * 3600000;
const MAX_HISTORY_DAYS = 62;
const FORBIDDEN_NAME = /[\[\]*?\/\\:]/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TOO_LONG = 'Une session ne peut pas dépasser 24 h : indique d’abord l’heure de fin du compteur en cours.';
const WRITE_ACTIONS = ['start', 'stop', 'note', 'logBlock', 'logSession', 'addProject', 'deleteEntry', 'editEntry', 'undo'];

// Types de travail, dans l'ordre d'affichage. Une ligne sans type (historique) vaut Misc.
export const TYPES = [
  // Trois ambiances = trois arcs du cercle des couleurs : Contenu en tons chauds (jaune → rouge),
  // Art en tons nature (vert-jaune → cyan), Code en tons froids (bleu → magenta). Dans un arc, des
  // teintes nettement différentes. Misc, la tâche par défaut, en gris et toujours en premier.
  { name: 'Misc', color: '#8A8F98', family: 'general' },
  { name: 'Writing', color: '#EAB308', family: 'contenu' },
  { name: 'Sound', color: '#F97316', family: 'contenu' },
  { name: 'Market', color: '#EF4444', family: 'contenu' },
  { name: 'Concept', color: '#84CC16', family: 'art' },
  { name: 'Art', color: '#22C55E', family: 'art' },
  { name: 'TechArt', color: '#14B8A6', family: 'art' },
  { name: 'UI', color: '#06B6D4', family: 'art' },
  { name: 'Dev', color: '#3B82F6', family: 'code' },
  { name: 'Gameplay', color: '#6366F1', family: 'code' },
  { name: 'Tooling', color: '#8B5CF6', family: 'code' },
  { name: 'Debug', color: '#D946EF', family: 'code' },
  // Pause : pas une tâche à choisir mais un état du compteur (bouton ⏸) ; le temps compte, marqué pause.
  { name: 'Pause', color: '#94A3B8', family: 'pause' },
];
const TYPE_NAMES = TYPES.map((t) => t.name);
const DEFAULT_TYPE = 'Misc';
// Noms de la première version : encore présents dans l'historique et chez les clients pas à jour.
const LEGACY_TYPES = { Autre: 'Misc', Narration: 'Writing' };

export const ENTRY_COLUMNS = ['id', 'project', 'kind', 'day', 'start_ms', 'end_ms', 'hours', 'type', 'note', 'source', 'created_ms', 'touched_ms', 'deleted_ms'];
export const ACTIVE = 'deleted_ms IS NULL';

export class AppError {
  constructor(code, message) { this.code = code; this.message = message; }
}
export function fail(message) { throw new AppError('invalid', message); }

function canonicalType(name) { return Object.hasOwn(LEGACY_TYPES, name) ? LEGACY_TYPES[name] : name; }
export function typeOf(row) {
  const name = canonicalType(row.type);
  return TYPE_NAMES.includes(name) ? name : DEFAULT_TYPE;
}

// ---- Lecture ----

export function running(db) {
  return db.first(`SELECT * FROM entries WHERE kind = 'session' AND end_ms IS NULL AND ${ACTIVE}`);
}
export function byId(db, id) { return db.first('SELECT * FROM entries WHERE id = ?', [id]); }
function last(db) {
  return db.first(`SELECT * FROM entries WHERE ${ACTIVE} AND source <> 'report' AND NOT (kind = 'session' AND end_ms IS NULL) ORDER BY touched_ms DESC LIMIT 1`);
}
// Lignes qui touchent aujourd'hui : sessions qui chevauchent la journée (en cours comprises), blocs du jour.
function today(db, nowMs) {
  const key = dayKey(nowMs);
  const from = dayStart(key);
  const to = nextDayStart(from);
  return db.all(
    `SELECT * FROM entries WHERE ${ACTIVE} AND ((kind = 'session' AND start_ms < ? AND COALESCE(end_ms, ?) > ?) OR (kind = 'block' AND day = ?))
     ORDER BY day, start_ms IS NULL, start_ms`,
    [to, nowMs, from, key],
  );
}
async function projectNames(db) { return (await db.all('SELECT name FROM projects ORDER BY position')).map((r) => r.name); }
async function settings(db) {
  const out = {};
  for (const r of await db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}
export function undoTarget(db) { return db.first('SELECT id, summary FROM ops WHERE undone_ms IS NULL ORDER BY id DESC LIMIT 1'); }

export function overlapping(ctx, start, end, exceptId) {
  return ctx.db.first(
    `SELECT * FROM entries WHERE ${ACTIVE} AND kind = 'session' AND id <> ? AND start_ms < ? AND COALESCE(end_ms, ?) > ? LIMIT 1`,
    [exceptId || '', end, ctx.now, start],
  );
}

function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

export function toApi(r) {
  if (!r) return null;
  const hours = r.kind === 'block' ? r.hours : (r.end_ms == null ? null : Math.round((r.end_ms - r.start_ms) / 36000) / 100);
  return { id: r.id, project: r.project, type: typeOf(r), date: r.day, start: iso(r.start_ms), end: iso(r.end_ms), hours, note: r.note || '', source: r.source };
}

async function status(ctx) {
  const { db } = ctx;
  const [cfg, projects, run, lastRow, todayRows, undo] = await Promise.all([
    settings(db), projectNames(db), running(db), last(db), today(db, ctx.now), undoTarget(db),
  ]);
  return {
    me: cfg.me || '',
    agent: ctx.agent,
    projects,
    studio: cfg.studio || 'Studio',
    visible: Number(cfg.visible || 4),
    threshold: Number(cfg.threshold || 8),
    running: toApi(run),
    last: toApi(lastRow),
    types: TYPES,
    today: todayRows.map(toApi),
    undo: undo ? { opId: undo.id, summary: undo.summary } : null,
    serverTime: iso(ctx.now),
    now: iso(ctx.now),
  };
}

// ---- Validation ----

export function parseInstant(value, label) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) fail(`${label} : date-heure non valide.`);
  return t;
}
function requireId(p) {
  if (typeof p.id !== 'string' || !p.id || p.id.length > 64) fail('Identifiant de ligne manquant ou trop long.');
  return p.id;
}
export async function requireProject(ctx, name) {
  if (!(await projectNames(ctx.db)).includes(name)) fail('Projet inconnu : ' + name);
  return name;
}
export function cleanNote(text) {
  if (text === undefined || text === null) return '';
  if (typeof text !== 'string') fail('La note doit être du texte.');
  if (text.length > 500) fail('Note trop longue (500 caractères max).');
  return text.trim();
}
export function requireBlockHours(value) {
  const h = Number(value);
  if (!BLOCK_HOURS.includes(h)) fail('Heures autorisées : 2, 4, 6, 8, 10 ou 12.');
  return h;
}
export function requireType(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const name = canonicalType(value);
  if (!TYPE_NAMES.includes(name)) fail(`Type inconnu : ${value}. Types : ${TYPE_NAMES.join(', ')}.`);
  return name;
}

// Heure de l'action : celle du serveur, sauf pour une action rejouée hors ligne (clientTime) ou
// envoyée par le widget, qui affiche son état avant la réponse (tapTime). Jamais dans le futur.
function actionTime(ctx) {
  const claimed = ctx.offline && ctx.clientTime ? ctx.clientTime : ctx.tapTime;
  if (claimed) {
    const t = Date.parse(claimed);
    if (!Number.isNaN(t)) return Math.min(t, ctx.now);
  }
  return ctx.now;
}

export function source(ctx) {
  if (ctx.agent) return 'claude';
  return ctx.offline ? 'hors ligne' : 'app';
}

function newSession(ctx, f) {
  return {
    id: f.id, project: f.project, kind: 'session', day: dayKey(f.start), start_ms: f.start, end_ms: f.end ?? null, hours: null,
    type: f.type, note: f.note || '', source: source(ctx), created_ms: ctx.now, touched_ms: ctx.now, deleted_ms: null,
  };
}
function newBlock(ctx, f) {
  return {
    id: f.id, project: f.project, kind: 'block', day: f.day, start_ms: null, end_ms: null, hours: f.hours,
    type: f.type, note: f.note || '', source: source(ctx), created_ms: ctx.now, touched_ms: ctx.now, deleted_ms: null,
  };
}

// ---- Journal ----

export function plain(row) {
  if (!row) return null;
  const out = {};
  for (const c of ENTRY_COLUMNS) out[c] = row[c] ?? null;
  return out;
}
export function change(before, after) {
  return { table: 'entries', key: (after || before).id, before: plain(before), after: plain(after) };
}

// Écriture d'une ligne dans son état complet (création ou remplacement), ou retrait d'un projet.
export function writeRow(table, key, row) {
  if (table === 'projects') {
    return row
      ? { sql: 'INSERT INTO projects (name, position) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET position = excluded.position', params: [row.name, row.position] }
      : { sql: 'DELETE FROM projects WHERE name = ?', params: [key] };
  }
  const cols = ENTRY_COLUMNS;
  return {
    sql: `INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
          ON CONFLICT(id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`,
    params: cols.map((c) => row[c] ?? null),
  };
}

// Les changements, dans l'ordre où ils s'appliquent, et leur entrée de journal : une seule transaction.
export async function commit(ctx, action, summary, changes) {
  if (!changes.length) return;
  const stmts = changes.map((c) => writeRow(c.table, c.key, c.after));
  stmts.push({
    sql: 'INSERT INTO ops (at_ms, action, summary, source, changes) VALUES (?, ?, ?, ?, ?)',
    params: [ctx.now, action, summary, source(ctx), JSON.stringify(changes)],
  });
  await ctx.db.batch(stmts);
}

// ---- Actions ----

export const actions = {
  async status() {},

  async start(ctx, p) {
    const id = requireId(p);
    const project = await requireProject(ctx, p.project);
    const offset = p.offsetMinutes === undefined ? 0 : Number(p.offsetMinutes);
    if (!OFFSETS.includes(offset)) fail('Décalage autorisé : 0, 15, 30 ou 60 minutes.');
    const note = cleanNote(p.note);
    const run = await running(ctx.db);
    const type = requireType(p.type, run ? typeOf(run) : DEFAULT_TYPE);
    if (await byId(ctx.db, id)) return;
    // Relancer ce qui tourne déjà n'est pas une action.
    if (run && run.project === project && typeOf(run) === type) return;

    let start = actionTime(ctx) - offset * 60000;
    const changes = [];
    if (run) {
      if (start < run.start_ms) start = run.start_ms;
      if (start - run.start_ms > MAX_SESSION_MS) fail(TOO_LONG);
      changes.push(change(run, { ...run, end_ms: start, touched_ms: ctx.now }));
    }
    changes.push(change(null, newSession(ctx, { id, project, start, type, note })));
    await commit(ctx, 'start', `${run ? 'Bascule' : 'Lancement'} ${project} · ${type} à ${clock(start)}`, changes);
  },

  async stop(ctx, p) {
    const run = await running(ctx.db);
    let end;
    if (p.endAt !== undefined && p.endAt !== null) {
      if (!run) fail('Aucun compteur en cours.');
      end = parseInstant(p.endAt, 'Heure de fin');
      if (end <= run.start_ms) fail('La fin doit être après le début.');
      if (end > ctx.now) fail('La fin ne peut pas être dans le futur.');
    } else {
      if (!run) return;
      end = actionTime(ctx);
      // Un stop rejoué hors ligne, plus ancien que le compteur en cours, visait un compteur déjà fermé.
      if (end < run.start_ms) return;
    }
    if (end - run.start_ms > MAX_SESSION_MS) fail(TOO_LONG);
    await commit(ctx, 'stop', `Arrêt ${run.project} · ${typeOf(run)} à ${clock(end)}`, [change(run, { ...run, end_ms: end, touched_ms: ctx.now })]);
  },

  async note(ctx, p) {
    const text = cleanNote(p.text);
    const run = await running(ctx.db);
    if (!run) fail('Aucun compteur en cours.');
    if (run.note === text) return;
    await commit(ctx, 'note', `Note sur ${run.project}`, [change(run, { ...run, note: text })]);
  },

  async logBlock(ctx, p) {
    const id = requireId(p);
    const project = await requireProject(ctx, p.project);
    const hours = requireBlockHours(p.hours);
    const note = cleanNote(p.note);
    const type = requireType(p.type, DEFAULT_TYPE);
    const key = p.date === undefined || p.date === null ? dayKey(actionTime(ctx)) : p.date;
    if (typeof key !== 'string' || !DAY_KEY.test(key)) fail('Date attendue au format aaaa-mm-jj.');
    if (key > dayKey(ctx.now)) fail('La date ne peut pas être dans le futur.');
    if (await byId(ctx.db, id)) return;
    const [, m, d] = key.split('-');
    await commit(ctx, 'logBlock', `Bloc ${hours} h ${project} · ${type} (${d}/${m})`, [change(null, newBlock(ctx, { id, project, day: key, hours, type, note }))]);
  },

  async logSession(ctx, p) {
    if (!ctx.agent) fail('Action réservée aux codes d’agent.');
    const id = requireId(p);
    const project = await requireProject(ctx, p.project);
    const start = parseInstant(p.start, 'Début');
    const end = parseInstant(p.end, 'Fin');
    const note = cleanNote(p.note);
    const type = requireType(p.type, DEFAULT_TYPE);
    if (end <= start) fail('La fin doit être après le début.');
    if (end > ctx.now) fail('La fin ne peut pas être dans le futur.');
    if (end - start > MAX_SESSION_MS) fail('Une session ne peut pas dépasser 24 h.');
    if (await byId(ctx.db, id)) return;
    const o = await overlapping(ctx, start, end);
    if (o) fail(`Chevauche une session existante (${o.project}, ${shortDate(o.start_ms)} ${clock(o.start_ms)}).`);
    await commit(ctx, 'logSession', `Session ${project} · ${type} ${clock(start)} → ${clock(end)}`, [change(null, newSession(ctx, { id, project, start, end, type, note }))]);
  },

  async addProject(ctx, p) {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) fail('Nom de projet vide.');
    if (name.length > 30) fail('Nom de projet trop long (30 caractères max).');
    if (name.charAt(0) === '_') fail('Un nom de projet ne commence pas par « _ ».');
    if (FORBIDDEN_NAME.test(name)) fail('Caractères interdits : [ ] * ? / \\ :');
    const taken = (await projectNames(ctx.db)).some((n) => n.toLowerCase() === name.toLowerCase());
    if (taken) fail('Ce nom est déjà pris : ' + name);
    const { position } = await ctx.db.first('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM projects');
    await commit(ctx, 'addProject', `Projet ${name} créé`, [{ table: 'projects', key: name, before: null, after: { name, position } }]);
  },

  // Lecture seule : renvoie les lignes de la période au lieu de l'état.
  async history(ctx, p) {
    if (typeof p.from !== 'string' || !DAY_KEY.test(p.from) || typeof p.to !== 'string' || !DAY_KEY.test(p.to)) {
      fail('Période attendue : from et to au format aaaa-mm-jj.');
    }
    if (p.from > p.to) fail('La période commence après sa fin.');
    const days = Math.round((dayStart(p.to) - dayStart(p.from)) / 86400000) + 1;
    if (days > MAX_HISTORY_DAYS) fail(`Période de ${MAX_HISTORY_DAYS} jours au plus.`);
    const rows = await ctx.db.all(
      `SELECT * FROM entries WHERE ${ACTIVE} AND day >= ? AND day <= ? ORDER BY day, start_ms IS NULL, start_ms`,
      [p.from, p.to],
    );
    return { from: p.from, to: p.to, rows: rows.map(toApi) };
  },
};

// ---- Entrée ----

export function isWrite(action) { return WRITE_ACTIONS.includes(action); }

export async function handleRequest(env, body) {
  try {
    body = body || {};
    const who = await env.auth(body.code);
    if (!who) return { ok: false, error: { code: 'unauthorized', message: 'Code inconnu.' } };
    const action = Object.hasOwn(actions, body.action) ? actions[body.action] : null;
    if (!action) fail('Action inconnue : ' + body.action);
    const ctx = {
      db: env.db,
      now: env.now(),
      agent: !!who.agent,
      offline: body.offline === true,
      clientTime: body.clientTime,
      tapTime: body.tapTime,
    };
    const data = await action(ctx, body);
    return { ok: true, data: data === undefined ? await status(ctx) : data };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message } };
    const message = String(e && e.message ? e.message : e);
    // Deux appareils qui lancent en même temps : la base refuse le second compteur ; le client réessaie.
    if (/UNIQUE constraint failed: entries\.kind/.test(message)) {
      return { ok: false, error: { code: 'busy', message: 'Deux actions en même temps : réessaie.' } };
    }
    return { ok: false, error: { code: 'server', message } };
  }
}
```

- [ ] **Étape 4 : lancer les tests, vérifier qu'ils passent**

Lancer : `node --test tests/server-core.test.mjs`
Attendu : tous les tests `ok`.

- [ ] **Étape 5 : commit**

```bash
git add server/core.js tests/server-core.test.mjs
git commit -m "feat(serveur) : règles métier sur SQLite, journal des écritures"
```

---

### Tâche 3 : Annuler, supprimer, corriger

**Fichiers :**
- Modifier : `server/core.js` (nouvelles actions dans `actions`, fonctions `describe`, `sameRow`)
- Créer : `tests/server-undo.test.mjs`

**Interfaces :**
- Consomme : `actions`, `commit`, `change`, `plain`, `writeRow`, `byId`, `undoTarget`,
  `overlapping`, `typeOf`, `requireProject`, `requireType`, `requireBlockHours`, `cleanNote`,
  `parseInstant`, `fail`, `MAX_SESSION_MS` (tâche 2).
- Produit : actions `undo({ opId })`, `deleteEntry({ id })`, `editEntry({ id, start?, end?, hours?,
  project?, type?, note? })`, qui renvoient l'état (`status`).

- [ ] **Étape 1 : écrire les tests**

`tests/server-undo.test.mjs` :

```js
// Annuler, supprimer, corriger (server/core.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, ok, fails, at } from './server-harness.mjs';

const H = 3600000;
const undo = async (call) => {
  const s = ok(await call('status'));
  return call('undo', { opId: s.undo.opId });
};

test('annuler un lancement : comme s\'il n\'avait pas eu lieu, l\'id reste pris', async () => {
  const { call, row, rows } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(await undo(call));
  assert.equal(s.running, null);
  assert.equal(s.undo, null);
  assert.ok(row('a1').deleted_ms);
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(rows().length, 1, 'une requête rejouée après l\'annulation ne recrée rien');
  assert.equal(ok(await call('status')).running, null);
});

test('annuler une bascule : l\'ancien compteur repart, le nouveau disparaît', async () => {
  const { call, row, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(30);
  ok(await call('start', { id: 'a2', project: 'Studio' }));
  const s = ok(await undo(call));
  assert.equal(s.running.id, 'a1');
  assert.equal(row('a1').end_ms, null);
  assert.ok(row('a2').deleted_ms);
});

test('annuler un arrêt : le compteur repart', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(30);
  ok(await call('stop'));
  assert.equal(ok(await undo(call)).running.id, 'a1');
});

test('annulations en chaîne : on remonte une action à la fois', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(30);
  ok(await call('stop'));
  ok(await call('logBlock', { id: 'b1', project: 'Studio', hours: 2 }));
  let s = ok(await undo(call));
  assert.deepEqual(s.today.map((r) => r.id), ['a1']);
  assert.match(s.undo.summary, /^Arrêt Fluffy/);
  s = ok(await undo(call));
  assert.equal(s.running.id, 'a1');
  s = ok(await undo(call));
  assert.equal(s.running, null);
  assert.deepEqual(s.today, []);
  assert.equal(s.undo, null);
});

test('annuler : seulement la dernière action ; une annulation rejouée ne fait rien', async () => {
  const { call, clock } = await makeEnv();
  const first = ok(await call('start', { id: 'a1', project: 'Fluffy' })).undo.opId;
  clock.advance(10);
  const second = ok(await call('stop')).undo.opId;
  fails(await call('undo', { opId: first }), 'invalid', /autre action/);
  ok(await call('undo', { opId: second }));
  const s = ok(await call('undo', { opId: second }));
  assert.equal(s.running.id, 'a1', 'pas annulé deux fois');
  fails(await call('undo', { opId: 999 }), 'invalid');
  fails(await call('undo', {}), 'invalid');
});

test('annuler après une nouvelle action : la nouvelle d\'abord, puis la précédente non annulée', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  ok(await call('logBlock', { id: 'b2', project: 'Fluffy', hours: 4 }));
  ok(await undo(call));
  clock.advance(1);
  ok(await call('logBlock', { id: 'b3', project: 'Fluffy', hours: 6 }));
  let s = ok(await undo(call));
  assert.deepEqual(s.today.map((r) => r.id), ['b1']);
  s = ok(await undo(call));
  assert.deepEqual(s.today, []);
});

test('annuler : refusé si la ligne a changé depuis', async () => {
  const { call, sqlite } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  sqlite.prepare("UPDATE entries SET note = 'à la main' WHERE id = 'a1'").run();
  fails(await undo(call), 'invalid', /a changé/);
});

test('annuler une note, un nouveau projet', async () => {
  const { call } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy', note: 'avant' }));
  ok(await call('note', { text: 'après' }));
  assert.equal(ok(await undo(call)).running.note, 'avant');
  ok(await call('addProject', { name: 'Heirfall' }));
  assert.deepEqual(ok(await undo(call)).projects, ['Fluffy', 'Studio']);
});

test('supprimer un bloc ; annuler le fait revenir', async () => {
  const { call } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 4 }));
  let s = ok(await call('deleteEntry', { id: 'b1' }));
  assert.deepEqual(s.today, []);
  assert.match(s.undo.summary, /^Suppression bloc 4 h Fluffy/);
  assert.deepEqual(ok(await call('history', { from: '2026-10-01', to: '2026-10-01' })).rows, []);
  s = ok(await undo(call));
  assert.deepEqual(s.today.map((r) => r.id), ['b1']);
});

test('supprimer le compteur en cours : il s\'arrête sans rien compter', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  const s = ok(await call('deleteEntry', { id: 'a1' }));
  assert.equal(s.running, null);
  assert.deepEqual(s.today, []);
  assert.equal(ok(await undo(call)).running.id, 'a1');
});

test('supprimer : ligne inconnue → invalid ; déjà supprimée → rien', async () => {
  const { call } = await makeEnv();
  fails(await call('deleteEntry', { id: 'zz' }), 'invalid');
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 4 }));
  const op = ok(await call('deleteEntry', { id: 'b1' })).undo.opId;
  assert.equal(ok(await call('deleteEntry', { id: 'b1' })).undo.opId, op, 'pas de seconde entrée au journal');
});

test('corriger une session : fin, début (le jour suit), projet, type, note', async () => {
  const { call, clock } = await makeEnv({ clock: undefined });
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(await call('stop'));
  clock.advance(60);
  let s = ok(await call('editEntry', { id: 'a1', end: '2026-10-01T10:30:00+02:00' }));
  assert.equal(s.last.hours, 1.5);
  assert.match(s.undo.summary, /^Correction Fluffy/);
  s = ok(await call('editEntry', { id: 'a1', start: '2026-09-30T23:30:00+02:00', project: 'Studio', type: 'Dev', note: 'nuit' }));
  assert.equal(s.last.date, '2026-09-30');
  assert.equal(s.last.project, 'Studio');
  assert.equal(s.last.type, 'Dev');
  assert.equal(s.last.note, 'nuit');
  assert.equal(s.last.hours, 11);
});

test('corriger : chevauchement, fin avant début, futur, plus de 24 h refusés', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(await call('start', { id: 'a2', project: 'Studio' }));
  clock.advance(60);
  ok(await call('stop'));
  fails(await call('editEntry', { id: 'a1', end: '2026-10-01T10:30:00+02:00' }), 'invalid', /Chevauche/);
  fails(await call('editEntry', { id: 'a2', end: '2026-10-01T09:30:00+02:00' }), 'invalid');
  fails(await call('editEntry', { id: 'a2', end: '2026-10-01T23:00:00+02:00' }), 'invalid');
  fails(await call('editEntry', { id: 'a1', start: '2026-09-30T08:00:00+02:00' }), 'invalid', /24 h/);
  fails(await call('editEntry', { id: 'a2', hours: 4 }), 'invalid');
  fails(await call('editEntry', { id: 'zz', note: 'x' }), 'invalid');
});

test('corriger le compteur en cours : le début oui, la fin non (c\'est STOP)', async () => {
  const { call, clock } = await makeEnv();
  ok(await call('start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  const s = ok(await call('editEntry', { id: 'a1', start: '2026-10-01T08:30:00+02:00' }));
  assert.equal(s.running.start, new Date('2026-10-01T08:30:00+02:00').toISOString());
  fails(await call('editEntry', { id: 'a1', end: '2026-10-01T09:30:00+02:00' }), 'invalid', /STOP/);
});

test('corriger un bloc : ses heures (2 à 12), jamais un début', async () => {
  const { call } = await makeEnv();
  ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8 }));
  fails(await call('editEntry', { id: 'b1', hours: 7 }), 'invalid');
  fails(await call('editEntry', { id: 'b1', start: '2026-10-01T08:00:00+02:00' }), 'invalid');
  assert.equal(ok(await call('editEntry', { id: 'b1', hours: 6 })).last.hours, 6);
  assert.equal(ok(await undo(call)).last.hours, 8);
});

test('corriger sans rien changer : aucune entrée au journal', async () => {
  const { call } = await makeEnv();
  const op = ok(await call('logBlock', { id: 'b1', project: 'Fluffy', hours: 8, note: 'x' })).undo.opId;
  assert.equal(ok(await call('editEntry', { id: 'b1', hours: 8, note: 'x', project: 'Fluffy' })).undo.opId, op);
});
```

- [ ] **Étape 2 : lancer les tests, vérifier qu'ils échouent**

Lancer : `node --test tests/server-undo.test.mjs`
Attendu : ÉCHEC, `Action inconnue : undo` (et `deleteEntry`, `editEntry`).

- [ ] **Étape 3 : ajouter les actions dans `server/core.js`**

Juste avant le commentaire `// ---- Actions ----`, ajouter :

```js
// Phrase lisible d'une ligne, pour le journal : « Fluffy · Dev 01/10 09:00 → 10:30 », « bloc 4 h Fluffy (01/10) ».
function describe(r) {
  if (r.kind === 'block') {
    const [, m, d] = r.day.split('-');
    return `bloc ${r.hours} h ${r.project} (${d}/${m})`;
  }
  return `${r.project} · ${typeOf(r)} ${shortDate(r.start_ms)} ${clock(r.start_ms)} → ${r.end_ms == null ? 'en cours' : clock(r.end_ms)}`;
}

// La ligne est-elle encore dans l'état laissé par l'action ? (champs de `expected` seulement)
function sameRow(current, expected) {
  if (!current || !expected) return !current && !expected;
  return Object.keys(expected).every((k) => (current[k] ?? null) === (expected[k] ?? null));
}
```

Dans l'objet `actions`, juste avant `// Lecture seule : renvoie les lignes de la période au lieu de l'état.`, ajouter :

```js
  async deleteEntry(ctx, p) {
    const row = typeof p.id === 'string' ? await byId(ctx.db, p.id) : null;
    if (!row) fail('Ligne introuvable.');
    if (row.deleted_ms != null) return;
    await commit(ctx, 'deleteEntry', `Suppression ${describe(row)}`, [change(row, { ...row, deleted_ms: ctx.now, touched_ms: ctx.now })]);
  },

  async editEntry(ctx, p) {
    const row = typeof p.id === 'string' ? await byId(ctx.db, p.id) : null;
    if (!row || row.deleted_ms != null) fail('Ligne introuvable.');
    const next = { ...row };
    if (p.project !== undefined) next.project = await requireProject(ctx, p.project);
    if (p.type !== undefined) next.type = requireType(p.type, typeOf(row));
    if (p.note !== undefined) next.note = cleanNote(p.note);
    if (row.kind === 'block') {
      if (p.start !== undefined || p.end !== undefined) fail('Un bloc n’a ni début ni fin : corrige ses heures.');
      if (p.hours !== undefined) next.hours = requireBlockHours(p.hours);
    } else {
      if (p.hours !== undefined) fail('Pour une session, corrige le début ou la fin.');
      if (p.start !== undefined) next.start_ms = parseInstant(p.start, 'Début');
      if (p.end !== undefined) {
        if (row.end_ms == null) fail('Pour arrêter le compteur en cours, utilise STOP.');
        next.end_ms = parseInstant(p.end, 'Fin');
      }
      const end = next.end_ms ?? ctx.now;
      if (next.start_ms > ctx.now) fail('Le début ne peut pas être dans le futur.');
      if (next.end_ms != null && next.end_ms <= next.start_ms) fail('La fin doit être après le début.');
      if (next.end_ms != null && next.end_ms > ctx.now) fail('La fin ne peut pas être dans le futur.');
      if (end - next.start_ms > MAX_SESSION_MS) fail('Une session ne peut pas dépasser 24 h.');
      next.day = dayKey(next.start_ms);
      if (next.start_ms !== row.start_ms || next.end_ms !== row.end_ms) {
        const o = await overlapping(ctx, next.start_ms, end, row.id);
        if (o) fail(`Chevauche une autre session (${o.project}, ${shortDate(o.start_ms)} ${clock(o.start_ms)}).`);
      }
    }
    if (['project', 'type', 'note', 'hours', 'start_ms', 'end_ms', 'day'].every((f) => next[f] === row[f])) return;
    next.touched_ms = ctx.now;
    await commit(ctx, 'editEntry', `Correction ${describe(next)}`, [change(row, next)]);
  },

  // Annule l'action opId, si c'est la dernière non annulée. Les changements sont défaits dans l'ordre
  // inverse (une bascule : d'abord retirer le nouveau compteur, puis rouvrir l'ancien).
  async undo(ctx, p) {
    const opId = Number(p.opId);
    if (!Number.isInteger(opId)) fail('Action à annuler manquante.');
    const op = await ctx.db.first('SELECT * FROM ops WHERE id = ?', [opId]);
    if (!op) fail('Action introuvable.');
    if (op.undone_ms != null) return; // déjà annulée : une requête rejouée ne fait rien
    const latest = await undoTarget(ctx.db);
    if (!latest || latest.id !== opId) fail('Une autre action a eu lieu entre-temps : rien n’est annulé.');
    const stmts = [];
    for (const c of JSON.parse(op.changes).reverse()) {
      const current = c.table === 'projects'
        ? await ctx.db.first('SELECT name, position FROM projects WHERE name = ?', [c.key])
        : plain(await byId(ctx.db, c.key));
      if (!sameRow(current, c.after)) fail('La ligne a changé depuis : rien n’est annulé.');
      // Une ligne créée par l'action est marquée supprimée : son id reste pris (idempotence).
      const restore = c.table === 'entries' && !c.before ? { ...c.after, deleted_ms: ctx.now } : c.before;
      stmts.push(writeRow(c.table, c.key, restore));
    }
    stmts.push({ sql: 'UPDATE ops SET undone_ms = ? WHERE id = ?', params: [ctx.now, opId] });
    await ctx.db.batch(stmts);
  },

```

- [ ] **Étape 4 : lancer tous les tests du serveur**

Lancer : `node --test tests/server-*.test.mjs`
Attendu : tous `ok` (schéma, règles, annulation).

- [ ] **Étape 5 : commit**

```bash
git add server/core.js tests/server-undo.test.mjs
git commit -m "feat(serveur) : annuler en chaîne, supprimer, corriger n'importe quelle ligne"
```

---

### Tâche 4 : Worker — codes, blocage par adresse, routage

**Fichiers :**
- Créer : `server/auth.js`, `server/worker.js`, `wrangler.toml`, `tests/d1-shim.mjs`, `tests/server-worker.test.mjs`
- Modifier : `package.json` (dépendance de dev wrangler, scripts), `.gitignore`

**Interfaces :**
- Consomme : `handleRequest` (tâche 2), `fromD1` (tâche 1).
- Produit : `authByCode(secrets, code)` → `{ agent } | null` ; `isLocked(db, ip, now)` →
  `Promise<boolean>` ; `recordFailure(db, ip, now)` ; `handleApi(request, env, now)` → `Response` ;
  `export default { fetch(request, env) }`. Côté tests : `d1Shim(sqlite)` imite l'API D1
  (`prepare().bind().all()/first()/run()`, `batch()`).

- [ ] **Étape 1 : écrire l'imitation de D1 et les tests**

`tests/d1-shim.mjs` :

```js
// Imitation minimale de l'API D1 (prepare / bind / all / first / run / batch) sur node:sqlite, pour
// tester le Worker tel qu'il tourne en production, à travers fromD1.
export function d1Shim(sqlite) {
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => statement(sql, p),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => { sqlite.prepare(sql).run(...params); return { success: true }; },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) {
      sqlite.exec('BEGIN');
      try {
        for (const s of list) sqlite.prepare(s.sql).run(...s.params);
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      return list.map(() => ({ success: true }));
    },
  };
}
```

`tests/server-worker.test.mjs` :

```js
// Worker (server/worker.js) : codes, blocage par adresse, routage, à travers l'API D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './server-harness.mjs';
import { d1Shim } from './d1-shim.mjs';
import { authByCode } from '../server/auth.js';
import worker, { handleApi } from '../server/worker.js';

const PC = 'p'.repeat(40);
const AGENT = 'c'.repeat(40);
const T0 = Date.parse('2026-10-01T09:00:00+02:00');

function makeWorkerEnv() {
  return {
    DB: d1Shim(makeDb()),
    ASSETS: { fetch: async (req) => new Response('fichier ' + new URL(req.url).pathname) },
    CODE_AMOHS_PC: PC,
    CODE_AMOHS_CLAUDE: AGENT,
    CODE_AMOHS_COURT: 'trop-court',
  };
}

function apiRequest(body, ip = '1.2.3.4') {
  return new Request('https://temps.example/api', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('codes : 32 caractères au moins, segment CLAUDE = agent, le reste ignoré', () => {
  const env = makeWorkerEnv();
  assert.deepEqual(authByCode(env, PC), { agent: false });
  assert.deepEqual(authByCode(env, AGENT), { agent: true });
  assert.equal(authByCode(env, 'trop-court'), null);
  assert.equal(authByCode(env, 'x'.repeat(40)), null);
  assert.equal(authByCode(env, undefined), null);
});

test('API : état avec un bon code, en-têtes CORS, pas de cache', async () => {
  const res = await handleApi(apiRequest({ code: PC, action: 'status' }), makeWorkerEnv(), T0);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.me, 'Amohs');
});

test('API : corps illisible → invalid', async () => {
  const body = await (await handleApi(apiRequest('pas du json'), makeWorkerEnv(), T0)).json();
  assert.equal(body.error.code, 'invalid');
});

test('blocage : 10 codes refusés depuis une adresse la bloquent une heure, elle seule', async () => {
  const env = makeWorkerEnv();
  for (let i = 0; i < 10; i++) {
    const body = await (await handleApi(apiRequest({ code: 'mauvais', action: 'status' }), env, T0 + i * 1000)).json();
    assert.equal(body.error.code, 'unauthorized');
  }
  const blocked = await (await handleApi(apiRequest({ code: PC, action: 'status' }), env, T0 + 20000)).json();
  assert.equal(blocked.error.code, 'locked');
  const other = await (await handleApi(apiRequest({ code: PC, action: 'status' }, '5.6.7.8'), env, T0 + 20000)).json();
  assert.equal(other.ok, true, 'une autre adresse n\'est pas bloquée');
  const later = await (await handleApi(apiRequest({ code: PC, action: 'status' }), env, T0 + 3600000 + 30000)).json();
  assert.equal(later.ok, true, 'débloquée après une heure');
});

test('blocage : des refus espacés de plus de 15 min ne s\'additionnent pas', async () => {
  const env = makeWorkerEnv();
  for (let i = 0; i < 12; i++) await handleApi(apiRequest({ code: 'mauvais', action: 'status' }), env, T0 + i * 16 * 60000);
  const body = await (await handleApi(apiRequest({ code: PC, action: 'status' }), env, T0 + 12 * 16 * 60000)).json();
  assert.equal(body.ok, true);
});

test('routage : /api en GET répond, OPTIONS sans corps, le reste va aux fichiers', async () => {
  const env = makeWorkerEnv();
  const get = await (await worker.fetch(new Request('https://temps.example/api'), env)).json();
  assert.equal(get.data.service, 'kilosaurus-temps');
  const options = await worker.fetch(new Request('https://temps.example/api', { method: 'OPTIONS' }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(await (await worker.fetch(new Request('https://temps.example/app.js'), env)).text(), 'fichier /app.js');
});

test('routage : une écriture passe de bout en bout', async () => {
  const env = makeWorkerEnv();
  const res = await worker.fetch(apiRequest({ code: PC, action: 'start', id: 'a1', project: 'Fluffy' }), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.running.id, 'a1');
});
```

- [ ] **Étape 2 : lancer les tests, vérifier qu'ils échouent**

Lancer : `node --test tests/server-worker.test.mjs`
Attendu : ÉCHEC, `Cannot find module '…/server/auth.js'`.

- [ ] **Étape 3 : écrire `server/auth.js` et `server/worker.js`**

`server/auth.js` :

```js
/**
 * Codes d'accès et blocage.
 *
 * Codes : secrets du Worker nommés CODE_<NOM> ou CODE_<NOM>_<APPAREIL> (un code par appareil, chacun
 * révocable seul). Un nom dont un segment est CLAUDE est un code d'agent. Un code de moins de
 * MIN_CODE_LENGTH caractères est ignoré : l'URL est publique, le code est la seule serrure.
 *
 * Blocage : après MAX_FAILED codes refusés en WINDOW_MS depuis une même adresse IP, cette adresse est
 * refusée pendant LOCKOUT_MS, bons codes compris. Les autres adresses ne sont pas touchées.
 */
const MIN_CODE_LENGTH = 32;
const MAX_FAILED = 10;
const WINDOW_MS = 15 * 60000;
const LOCKOUT_MS = 3600000;

// Comparaison à temps constant (à longueur égale) : la durée ne révèle pas où les codes diffèrent.
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authByCode(secrets, code) {
  if (typeof code !== 'string' || code.length < MIN_CODE_LENGTH) return null;
  for (const [key, value] of Object.entries(secrets)) {
    const m = /^CODE_[A-Z0-9]+((?:_[A-Z0-9]+)*)$/.exec(key);
    if (!m || typeof value !== 'string' || value.length < MIN_CODE_LENGTH) continue;
    if (sameText(value, code)) return { agent: m[1].split('_').includes('CLAUDE') };
  }
  return null;
}

export async function isLocked(db, ip, now) {
  const r = await db.first('SELECT until_ms FROM lockouts WHERE ip = ?', [ip]);
  return !!(r && r.until_ms && r.until_ms > now);
}

export async function recordFailure(db, ip, now) {
  const r = await db.first('SELECT failures, first_ms FROM lockouts WHERE ip = ?', [ip]);
  const fresh = !r || now - r.first_ms > WINDOW_MS;
  const failures = fresh ? 1 : r.failures + 1;
  const locked = failures >= MAX_FAILED;
  await db.batch([{
    sql: `INSERT INTO lockouts (ip, failures, first_ms, until_ms) VALUES (?, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, first_ms = excluded.first_ms, until_ms = excluded.until_ms`,
    params: [ip, locked ? 0 : failures, fresh ? now : r.first_ms, locked ? now + LOCKOUT_MS : null],
  }]);
}
```

`server/worker.js` :

```js
/**
 * Worker Cloudflare : l'API (POST /api) et l'app web (fichiers de web/, servis par le binding ASSETS).
 * Les données sont dans D1 (binding DB) ; les codes d'accès sont des secrets du Worker (server/auth.js).
 * Protocole : corps JSON en text/plain (pas de requête préalable CORS), réponse { ok, data } ou
 * { ok: false, error: { code, message } }.
 */
import { handleRequest } from './core.js';
import { authByCode, isLocked, recordFailure } from './auth.js';
import { fromD1 } from './db.js';

// L'APK sert l'app depuis sa propre origine (app.kilosaurus.local) : l'API accepte toute origine,
// le code reste la serrure.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const LOCKED = { ok: false, error: { code: 'locked', message: 'Accès bloqué : trop de codes refusés depuis cette adresse. Réessaie dans une heure.' } };

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

export async function handleApi(request, env, now = Date.now()) {
  const db = fromD1(env.DB);
  const ip = request.headers.get('CF-Connecting-IP') || 'inconnue';
  if (await isLocked(db, ip, now)) return json(LOCKED);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return json({ ok: false, error: { code: 'invalid', message: 'Corps JSON non valide.' } });
  }
  let refused = false;
  const auth = (code) => {
    const who = authByCode(env, code);
    if (!who) refused = true;
    return who;
  };
  const res = await handleRequest({ db, now: () => now, auth }, body);
  if (refused) await recordFailure(db, ip, now);
  return json(res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method === 'POST') return handleApi(request, env);
      return json({ ok: true, data: { service: 'kilosaurus-temps' } });
    }
    return env.ASSETS.fetch(request);
  },
};
```

- [ ] **Étape 4 : configuration de déploiement**

`wrangler.toml` (racine du dépôt) :

```toml
# Worker Cloudflare de Kilosaurus Temps : l'API (server/worker.js) et l'app (web/).
#   npx wrangler deploy
name = "kilosaurus-temps"
main = "server/worker.js"
compatibility_date = "2025-09-01"

[assets]
directory = "web"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "kilosaurus-temps"
# Rempli à la bascule (tâche 11) avec l'identifiant affiché par `npx wrangler d1 create`.
database_id = "A_REMPLIR_A_LA_BASCULE"
```

Dans `package.json`, remplacer le bloc `"scripts"` par le suivant, et ajouter `devDependencies` :

```json
  "scripts": {
    "test": "node --test \"tests/*.test.js\" \"tests/*.test.mjs\"",
    "dev": "node tools/dev-server.mjs",
    "deploy": "wrangler deploy",
    "db:schema": "wrangler d1 execute kilosaurus-temps --remote --file server/schema.sql"
  },
  "devDependencies": {
    "wrangler": "^4"
  }
```

Mettre à jour la ligne `"description"` : `"Outils de dev : tests, serveur local, déploiement Cloudflare. L'app elle-même n'a aucune dépendance."`

Dans `.gitignore`, après la ligne `*.xlsx`, ajouter :

```
# Fichiers de reprise de l'historique (données réelles).
reprise*.sql
reprise*.json
# Cache local de wrangler.
.wrangler/
```

Lancer : `npm install`
Attendu : `added … packages`, un `package-lock.json` à la racine.

- [ ] **Étape 5 : lancer les tests, vérifier qu'ils passent**

Lancer : `node --test tests/server-*.test.mjs`
Attendu : tous `ok`.

Lancer : `npx wrangler deploy --dry-run --outdir .wrangler/dry`
Attendu : `--dry-run: exiting now.` sans erreur de configuration (aucune connexion à Cloudflare nécessaire).

- [ ] **Étape 6 : commit**

```bash
git add server/auth.js server/worker.js wrangler.toml tests/d1-shim.mjs tests/server-worker.test.mjs package.json package-lock.json .gitignore
git commit -m "feat(serveur) : Worker Cloudflare, codes par secrets, blocage par adresse IP"
```

---

### Tâche 5 : Serveur de dev et test de bout en bout sur le nouveau serveur

**Fichiers :**
- Créer : `tools/dev-server.mjs`
- Supprimer : `tools/fake-api.js`
- Modifier : `tools/e2e.js`

**Interfaces :**
- Consomme : `handleRequest` (tâche 2), `fromSqlite` (tâche 1), `dayKey` (tâche 1).
- Produit : `node tools/dev-server.mjs [--port N] [--forgot] [--api-url U]`, codes de dev
  `code-amohs` et `code-amohs-claude`, mêmes adresses que l'ancien faux serveur (`/api`,
  `/config.js`, `/__phone`).

- [ ] **Étape 1 : écrire `tools/dev-server.mjs`**

```js
// Serveur de dev : sert web/ et répond sur /api avec le vrai server/core.js sur un SQLite en mémoire.
//
//   node tools/dev-server.mjs [--port 8787] [--forgot] [--api-url <url>]
//
// Codes : code-amohs, code-amohs-claude (agent).
// --forgot : un compteur lancé il y a 9 h (pour voir le garde-fou).
// --api-url <url> : URL d'API donnée à l'app (par défaut /api), pour simuler une mauvaise config.
// Ouvrir http://localhost:8787/?dev-code=code-amohs pour être connecté directement,
// ou /__phone?dev-code=code-amohs pour voir l'app dans un cadre de téléphone (375 px).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fromSqlite } from '../server/db.js';
import { handleRequest } from '../server/core.js';
import { dayKey } from '../server/tz.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8787;
const API_URL = args.includes('--api-url') ? args[args.indexOf('--api-url') + 1] : '/api';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));
['Fluffy', 'Studio', 'Heirfall', 'Proto', 'Jam'].forEach((name, i) => sqlite.prepare('INSERT INTO projects (name, position) VALUES (?, ?)').run(name, i + 1));
for (const [key, value] of Object.entries({ me: 'Amohs', studio: 'Studio', visible: '4', threshold: '8' })) {
  sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
const seed = sqlite.prepare('INSERT INTO entries (id, project, kind, day, start_ms, end_ms, hours, type, note, source, created_ms, touched_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const now = Date.now();
seed.run('seed-1', 'Fluffy', 'block', dayKey(now - 86400000), null, null, 8, 'Misc', '', 'app', now - 3600000, now - 3600000);
if (args.includes('--forgot')) {
  const start = now - 9 * 3600000;
  seed.run('seed-2', 'Fluffy', 'session', dayKey(start), start, null, null, 'Misc', '', 'app', start, start);
}

const CODES = { 'code-amohs': { agent: false }, 'code-amohs-claude': { agent: true } };
const env = { db: fromSqlite(sqlite), now: () => Date.now(), auth: (code) => CODES[code] || null };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const DEV_CONFIG = `window.KT_API_URL = ${JSON.stringify(API_URL)};
(function () {
  var code = new URLSearchParams(location.search).get('dev-code');
  if (code) localStorage.setItem('kt.code', code);
})();`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let out;
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { /* signalé ci-dessous */ }
      out = parsed ? await handleRequest(env, parsed) : { ok: false, error: { code: 'invalid', message: 'Corps JSON non valide.' } };
      if (parsed && (out.ok || out.error.code !== 'unauthorized')) console.log(parsed.action, out.ok ? 'ok' : out.error.message);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__phone') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<body style="margin:0;background:#888"><iframe src="/' + url.search + '" style="width:375px;height:812px;border:0;display:block"></iframe></body>');
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(DEV_CONFIG);
  }
  const file = path.join(WEB, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Serveur de dev : http://localhost:${port}/?dev-code=code-amohs`));
```

- [ ] **Étape 2 : brancher le test de bout en bout dessus**

Dans `tools/e2e.js` :

1. En tête, remplacer `contre le faux serveur` par `contre le serveur de dev (tools/dev-server.mjs)`.
2. Dans `startServer`, remplacer `path.join(ROOT, 'tools', 'fake-api.js')` par
   `path.join(ROOT, 'tools', 'dev-server.mjs')`.
3. Dans « Garde-fou des oublis », remplacer la ligne :
   ```js
   check(s.running === null && s.last?.corrected && Math.abs(s.last.hours - 7) < 0.05, 'serveur : session fermée à l’heure donnée, marquée corrigée');
   ```
   par :
   ```js
   check(s.running === null && Math.abs(s.last.hours - 7) < 0.05, 'serveur : session fermée à l’heure donnée');
   ```
4. Dans « Nouveau projet », remplacer `'serveur : onglet créé'` par `'serveur : projet créé'`, et
   dans « Refus du serveur », `'serveur : aucun onglet en double'` par `'serveur : aucun projet en double'`.

Supprimer `tools/fake-api.js` : `git rm tools/fake-api.js`.

- [ ] **Étape 3 : lancer le bout en bout**

Lancer : `node tools/e2e.js`
Attendu : `Tout est vert.` (Chrome installé au chemin par défaut). L'app web n'a pas encore changé :
ce passage prouve que le nouveau serveur se comporte comme l'ancien pour elle.

- [ ] **Étape 4 : commit**

```bash
git add tools/dev-server.mjs tools/e2e.js
git commit -m "feat(dev) : serveur de dev sur SQLite et le vrai core, bout en bout branché dessus"
```

---

### Tâche 6 : App web — Annuler, fenêtre des sessions, relecture, mesure de latence

**Fichiers :**
- Modifier : `web/logic.js`, `web/app.js`, `web/style.css`, `web/config.js`, `web/sw.js`
- Modifier : `tests/logic.test.js`, `tools/e2e.js`

**Interfaces :**
- Consomme : actions `undo`, `deleteEntry`, `editEntry`, `history`, et `status.undo` (tâches 2–3).
- Produit : `KTLogic.entryEdit(row, form)` → objet des champs changés ou `null` ;
  `KTLogic.isLong(row, thresholdHours, nowMs)` → booléen. Page `?vue=sessions` (fenêtre des
  sessions seule, utilisée par la mini-fenêtre de bureau, tâche 7). Sélecteurs pour l'e2e :
  `[data-act=undo]`, `[data-act=sessions]`, `.sessions .entry`, `[data-act=entryOpen]`,
  `[data-act=entryDelete]`, `[data-act=entrySave]`, `#entry-type`.

- [ ] **Étape 1 : écrire les tests des calculs**

Dans `tests/logic.test.js` :

1. Supprimer les deux tests `correction d'heure : la fin passe minuit si besoin` et
   `correction d'heure : le début passe la veille si besoin` (fonction `editedInstant` retirée).
2. Dans `optimiste : stop, oubli, bloc, correction, nouveau projet`, supprimer les deux lignes :
   ```js
     s = L.applyLocal(s, { action: 'editLast', params: { id: 'b1', field: 'hours', value: 6 }, clientTime: '2026-10-02T08:01:00+02:00' });
     assert.equal(s.last.hours, 6);
   ```
   et renommer le test `optimiste : stop, oubli, bloc, nouveau projet`.
3. Ajouter à la fin :

```js
test('correction : seuls les champs changés partent', () => {
  const row = { id: 'a', project: 'Fluffy', type: 'Dev', note: '', start: '2026-10-01T09:12:37+02:00', end: '2026-10-01T10:30:00+02:00', hours: 1.29 };
  assert.equal(L.entryEdit(row, { start: '09:12', end: '10:30', project: 'Fluffy', type: 'Dev', note: '' }), null, 'les secondes du début ne comptent pas');
  assert.deepEqual(L.entryEdit(row, { start: '09:12', end: '11:00', project: 'Fluffy', type: 'Dev', note: '' }), { end: new Date('2026-10-01T11:00:00+02:00').toISOString() });
  assert.deepEqual(L.entryEdit(row, { start: '08:00', end: '10:30', project: 'Jam', type: 'Art', note: ' boss ' }), {
    project: 'Jam', type: 'Art', note: 'boss', start: new Date('2026-10-01T08:00:00+02:00').toISOString(),
  });
});

test('correction : fin après minuit', () => {
  const row = { id: 'a', project: 'Fluffy', type: 'Dev', note: '', start: '2026-09-30T23:00:00+02:00', end: '2026-09-30T23:30:00+02:00' };
  assert.deepEqual(L.entryEdit(row, { start: '23:00', end: '01:15', project: 'Fluffy', type: 'Dev', note: '' }), { end: new Date('2026-10-01T01:15:00+02:00').toISOString() });
});

test('correction : compteur en cours (pas de fin), bloc (heures)', () => {
  const running = { id: 'r', project: 'Fluffy', type: 'Misc', note: '', start: '2026-10-01T09:00:00+02:00', end: null };
  assert.deepEqual(L.entryEdit(running, { start: '08:30', end: null, project: 'Fluffy', type: 'Misc', note: '' }), { start: new Date('2026-10-01T08:30:00+02:00').toISOString() });
  const block = { id: 'b', project: 'Fluffy', type: 'Misc', note: '', start: null, end: null, hours: 8 };
  assert.deepEqual(L.entryEdit(block, { hours: 6, project: 'Fluffy', type: 'Misc', note: '' }), { hours: 6 });
  assert.equal(L.entryEdit(block, { hours: 8, project: 'Fluffy', type: 'Misc', note: '' }), null);
});

test('session anormalement longue : au-delà du seuil d\'oubli', () => {
  const now = at('2026-10-02T12:00:00+02:00');
  assert.equal(L.isLong(sess('a', 'Dev', '2026-10-01T13:05:00+02:00', '2026-10-02T03:07:00+02:00'), 8, now), true);
  assert.equal(L.isLong(sess('b', 'Dev', '2026-10-01T09:00:00+02:00', '2026-10-01T12:00:00+02:00'), 8, now), false);
  assert.equal(L.isLong({ start: null, hours: 10 }, 8, now), false, 'un bloc n\'est jamais signalé');
});
```

- [ ] **Étape 2 : lancer les tests, vérifier qu'ils échouent**

Lancer : `node --test tests/logic.test.js`
Attendu : ÉCHEC, `L.entryEdit is not a function`.

- [ ] **Étape 3 : modifier `web/logic.js`**

1. Remplacer la fonction `editedInstant` (avec son commentaire) par :

```js
  /**
   * Champs à envoyer pour corriger une ligne depuis la fenêtre des sessions : seulement ceux qui
   * changent. Les heures « HH:MM » se placent le jour du début ; une fin plus tôt que le début passe
   * au lendemain (session qui passe minuit). Une heure inchangée (même HH:MM) n'est pas renvoyée,
   * pour ne pas perdre ses secondes. Renvoie null si rien ne change.
   */
  function entryEdit(row, form) {
    var out = {};
    if (form.project && form.project !== row.project) out.project = form.project;
    if (form.type && form.type !== typeOf(row)) out.type = form.type;
    if (form.note != null && form.note.trim() !== (row.note || '')) out.note = form.note.trim();
    if (row.start) {
      var startChanged = !!form.start && form.start !== clock(row.start);
      var start = startChanged ? atTime(row.start, form.start) : new Date(row.start);
      if (startChanged) out.start = start.toISOString();
      if (row.end && form.end && form.end !== clock(row.end)) {
        var end = atTime(start.toISOString(), form.end);
        if (end <= start) end.setDate(end.getDate() + 1);
        out.end = end.toISOString();
      }
    } else if (form.hours && form.hours !== Number(row.hours)) {
      out.hours = form.hours;
    }
    return Object.keys(out).length ? out : null;
  }

  // Session plus longue que le seuil d'oubli : sans doute un compteur oublié (signalé ⚠).
  function isLong(row, thresholdHours, nowMs) {
    return !!row.start && rowHours(row, nowMs) > (thresholdHours || 8);
  }
```

   `isLong` utilise `rowHours`, défini plus bas dans le fichier : c'est une déclaration de fonction,
   elle est remontée, l'ordre ne pose pas de problème.

2. Dans `applyLocal`, supprimer toute la branche `} else if (item.action === 'editLast') { … }`
   (de `} else if (item.action === 'editLast') {` jusqu'à la ligne
   `if ((s.today || []).some(function (r) { return r.id === s.last.id; })) upsertToday(s, s.last);` comprise).

3. Dans l'objet `api`, remplacer `editedInstant: editedInstant,` par `entryEdit: entryEdit, isLong: isLong,`.

- [ ] **Étape 4 : lancer les tests des calculs**

Lancer : `node --test tests/logic.test.js`
Attendu : tous `ok`.

- [ ] **Étape 5 : modifier `web/app.js`**

1. Constantes, en tête. Remplacer :
   ```js
     var VERSION = '1.13.0';
     var TIMEOUT_MS = 25000; // Apps Script répond parfois en 30 s ; l'écran, lui, a déjà réagi.
   ```
   par :
   ```js
     var VERSION = '2.0.0';
     var TIMEOUT_MS = 10000; // le serveur répond en quelques centaines de ms ; au-delà, c'est le réseau.
     var POLL_MS = 20000;    // relecture de l'état quand la page est visible (compteur lancé ailleurs)
   ```
   Et après la ligne `if (MINI) document.documentElement.classList.add('mini');`, ajouter :
   ```js
     // Fenêtre des sessions seule (?vue=sessions) : ouverte par la mini-fenêtre de bureau dans une
     // deuxième fenêtre. Ailleurs, la même fenêtre s'ouvre par-dessus l'app.
     var VUE_SESSIONS = /[?&]vue=sessions(&|$)/.test(location.search);
   ```

2. Dans `state`, après `recap: null,`, ajouter :
   ```js
       sessions: null,    // fenêtre des sessions : { day, rows, error, open }
       undoing: false,
       latencyMs: null,   // durée du dernier appel, affichée dans le détail de la synchro
   ```

3. `failureMessage` : remplacer la ligne `if (err.kind === 'format') …` par :
   ```js
       if (err.kind === 'format') return 'Réponse inattendue du serveur. Vérifie l’adresse de l’API (config.js).';
   ```

4. `post` : mesurer la durée. Remplacer le début de la fonction jusqu'à `}).then(function (r) {`
   puis `clearTimeout(timer);` par :
   ```js
     function post(body) {
       var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
       var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
       var t0 = Date.now();
       return fetch(API, {
         method: 'POST',
         headers: { 'Content-Type': 'text/plain;charset=utf-8' },
         body: JSON.stringify(body),
         signal: ctrl ? ctrl.signal : undefined,
       }).then(function (r) {
         clearTimeout(timer);
         state.latencyMs = Date.now() - t0;
   ```
   (le reste de `post` est inchangé).

5. Après la fonction `act`, ajouter :
   ```js
     // Action qui demande le réseau (annuler, supprimer, corriger) : envoyée tout de suite, hors de
     // la file, et l'écran attend la réponse du serveur, qui fait foi.
     function direct(body, doneMsg) {
       return post(Object.assign({ code: state.code }, body)).then(function (res) {
         state.undoing = false;
         if (res.ok) {
           setStatus(res.data);
           setSync('ok');
           if (doneMsg) toast(doneMsg);
         } else if (res.error.code === 'unauthorized') {
           return logout('Code refusé. Saisis-le à nouveau.');
         } else {
           toast('Refusé : ' + res.error.message);
           refresh();
         }
         if (state.sessions) loadSessions();
       }).catch(function (err) {
         state.undoing = false;
         rethrowIfBug(err);
         toast('Pas envoyé : ' + failureMessage(err));
         render();
         renderSessions();
       });
     }
   ```

6. `renderView` : après le bloc `if (!s) { … return; }`, ajouter :
   ```js
       if (VUE_SESSIONS) {
         app.innerHTML = state.sessions ? '<section class="sessions-page">' + sessionsHtml() + '</section>' : '';
         return;
       }
   ```

7. `setupView` : remplacer le paragraphe `muted` par :
   ```js
         '<p class="muted">Renseigne l’adresse de l’API dans <b>web/config.js</b> (README, mise en place).</p>' +
   ```

8. `header` : remplacer la ligne du lien « Plus d'infos » par :
   ```js
         // Mini-fenêtre : la version complète s'ouvre dans le navigateur, les sessions dans une deuxième fenêtre.
         (MINI ? '<button class="link small" data-act="sessions">Sessions</button>' +
           '<a class="more-info" data-act="moreInfo" href="./" target="_blank">Plus d’infos ↗</a>' : '') +
   ```

9. `hero` : dans les deux retours (repos et compteur en cours), ajouter `undoButton(s) +` juste
   après `grid(s) +`. Pour le compteur en cours, la fin devient :
   ```js
         grid(s) + undoButton(s) +
         '<button class="link note-text" data-act="note">' + (r.note ? esc(r.note) : '+ note') + '</button>' +
         '</section>';
   ```
   et pour le repos :
   ```js
         grid(s) + undoButton(s) +
         '</section>';
   ```
   Puis ajouter après `hero` :
   ```js
     // Annuler : la dernière action, résumée. Grisé tant qu'une action attend dans la file ou que le
     // serveur ne répond pas (l'action à annuler est celle que le serveur connaît).
     function undoButton(s) {
       if (!s.undo) return '';
       var off = state.queue.length > 0 || state.sync !== 'ok' || state.undoing;
       return '<button class="link undo" data-act="undo"' + (off ? ' disabled' : '') + '>↶ Annuler : ' + esc(s.undo.summary) + '</button>';
     }
   ```

10. `todayView` : après le bouton Récap, ajouter le bouton Sessions :
    ```js
          '<button class="link small" data-act="recap">Récap</button>' +
          '<button class="link small" data-act="sessions">Sessions</button></div>' +
    ```
    (remplace `'<button class="link small" data-act="recap">Récap</button></div>' +`).

11. Fenêtre : dans l'écouteur `close` du dialogue, remplacer
    `dlg.addEventListener('close', function () { state.forgotOpen = false; state.recap = null; });` par :
    ```js
      dlg.addEventListener('close', function () { state.forgotOpen = false; state.recap = null; state.sessions = null; });
    ```

12. `checkForgotten` : en première ligne de la fonction, ajouter `if (VUE_SESSIONS) return;`.

13. Dans `handlers`, remplacer `addProject` :
    ```js
        addProject: function () {
          openDialog('<h2>Nouveau projet</h2>' +
            '<input class="field" id="project-name" type="text" maxlength="30" placeholder="Nom du projet">' +
            '<div class="actions">' + cancelButton() + '<button class="primary" data-act="addProjectSave">Créer</button></div>');
          document.getElementById('project-name').focus();
        },
    ```
    remplacer `sync` :
    ```js
        sync: function () {
          var labels = { ok: 'Tout est synchronisé.', pending: 'En attente de synchro.', error: 'Erreur de synchro.' };
          openDialog('<h2>Synchro</h2><p>' + esc(state.syncMsg || labels[state.sync]) + '</p>' +
            (state.queue.length ? '<p>' + state.queue.length + ' action(s) en attente.</p>' : '') +
            (state.latencyMs != null ? '<p class="muted">Dernière réponse du serveur : ' + state.latencyMs + ' ms.</p>' : '') +
            '<div class="actions">' + cancelButton() + '<button class="primary" data-act="retry">Réessayer</button></div>');
        },
    ```
    et ajouter, avant `recap:` :
    ```js
        undo: function () {
          var s = state.status;
          if (!s.undo || state.queue.length || state.undoing) return;
          state.undoing = true;
          render();
          renderSessions();
          direct({ action: 'undo', opId: s.undo.opId }, 'Annulé : ' + s.undo.summary);
        },

        sessions: function () {
          // Mini-fenêtre : les sessions s'ouvrent dans une deuxième fenêtre (desktop/main.js).
          if (MINI) { window.open('./?vue=sessions', 'sessions'); return; }
          openSessions();
        },
        sessionsClose: function () { if (VUE_SESSIONS) window.close(); else closeDialog(); },
        sessionsPrev: function () { shiftSessions(-1); },
        sessionsNext: function () { shiftSessions(1); },

        entryOpen: function (el) {
          var ss = state.sessions;
          ss.open = ss.open === el.dataset.id ? null : el.dataset.id;
          renderSessions();
        },

        entryDelete: function (el) {
          if (!window.confirm('Supprimer cette ligne ? « Annuler » la fera revenir.')) return;
          state.sessions.open = null;
          direct({ action: 'deleteEntry', id: el.dataset.id }, 'Supprimé.');
        },

        entrySave: function (el) {
          var row = (state.sessions.rows || []).filter(function (r) { return r.id === el.dataset.id; })[0];
          if (!row) return;
          var picked = document.querySelector('#entry-hours .chip.on');
          var params = L.entryEdit(row, {
            start: fieldValue('entry-start'),
            end: fieldValue('entry-end'),
            hours: picked ? Number(picked.dataset.v) : null,
            project: fieldValue('entry-project'),
            type: fieldValue('entry-type'),
            note: fieldValue('entry-note'),
          });
          state.sessions.open = null;
          if (!params) return renderSessions();
          direct(Object.assign({ action: 'editEntry', id: row.id }, params), 'Corrigé.');
        },
    ```

14. Après la section Récap (après la fonction `breakdown`), ajouter la section :

```js
  // ---- Fenêtre des sessions (lecture par `history`, écritures par `direct`) ----

  function fieldValue(id) {
    var el = document.getElementById(id);
    return el && !el.disabled ? el.value : null;
  }

  function openSessions() {
    state.sessions = { day: L.dayKey(new Date()), rows: null, error: '', open: null };
    loadSessions();
  }

  function shiftSessions(n) {
    var p = state.sessions.day.split('-');
    var key = L.dayKey(new Date(+p[0], +p[1] - 1, +p[2] + n, 12));
    if (key > L.dayKey(new Date())) return;
    state.sessions = { day: key, rows: null, error: '', open: null };
    loadSessions();
  }

  function loadSessions() {
    var ss = state.sessions;
    var day = ss.day;
    ss.error = '';
    renderSessions();
    // Seule la réponse du jour encore affiché compte (changement de jour rapide).
    var current = function () { return state.sessions === ss && ss.day === day; };
    post({ code: state.code, action: 'history', from: day, to: day }).then(function (res) {
      if (!current()) return;
      if (res.ok) ss.rows = res.data.rows;
      else ss.error = res.error.message;
      renderSessions();
    }).catch(function (err) {
      rethrowIfBug(err);
      if (!current()) return;
      ss.error = 'Sessions indisponibles : ' + failureMessage(err);
      renderSessions();
    });
  }

  function renderSessions() {
    if (!state.sessions || state.forgotOpen) return;
    if (VUE_SESSIONS) return render();
    openDialog(sessionsHtml());
  }

  function sessionsHtml() {
    var ss = state.sessions;
    var s = state.status;
    var now = Date.now();
    var label = L.dayLabel(ss.day, now);
    var body;
    if (ss.error) body = '<p class="error">' + esc(ss.error) + '</p>';
    else if (!ss.rows) body = '<p class="muted">Chargement…</p>';
    else if (!ss.rows.length) body = '<p class="muted">Rien ce jour-là.</p>';
    else {
      var g = L.aggregate(ss.rows, [ss.day], now);
      var pause = g.byType[L.PAUSE_TYPE] || 0;
      body = '<p class="sessions-total">Total <b>' + hoursLabel(g.total) + '</b>' +
        (pause >= 1 / 60 ? ' · dont ' + Math.round(pause * 60) + ' min de pause' : '') + '</p>' +
        '<div class="entries">' + ss.rows.map(function (r) { return entryHtml(s, r, now); }).join('') + '</div>';
    }
    var isToday = ss.day === L.dayKey(new Date());
    return '<div class="sessions">' +
      '<div class="sessions-head"><h2>Sessions</h2>' + undoButton(s) + '</div>' +
      '<div class="recap-nav"><button class="icon" data-act="sessionsPrev" aria-label="Jour précédent">‹</button>' +
      '<h2>' + esc(label.charAt(0).toUpperCase() + label.slice(1)) + '</h2>' +
      '<button class="icon" data-act="sessionsNext" aria-label="Jour suivant"' + (isToday ? ' disabled' : '') + '>›</button></div>' +
      body + '</div>' +
      '<button class="secondary" data-act="sessionsClose">Fermer</button>';
  }

  function entryHtml(s, r, now) {
    var t = L.typeOf(r);
    var long = L.isLong(r, s.threshold, now);
    var when = r.start ? L.clock(r.start) + ' → ' + (r.end ? L.clock(r.end) : 'en cours') : 'Bloc';
    var open = state.sessions.open === r.id;
    return '<div class="entry' + (open ? ' open' : '') + '">' +
      '<button class="entry-line" data-act="entryOpen" data-id="' + esc(r.id) + '">' +
      '<span class="dot" style="background:' + L.typeColor(s, t) + '"></span>' +
      '<span class="entry-main"><b>' + esc(r.project) + '</b> · ' + esc(t) +
      '<small>' + when + (r.note ? ' · ' + esc(r.note) : '') + '</small></span>' +
      '<span class="entry-hours' + (long ? ' long' : '') + '">' + (long ? '⚠ ' : '') + L.duration(L.rowHours(r, now)) + '</span>' +
      '</button>' + (open ? entryForm(s, r) : '') + '</div>';
  }

  function entryForm(s, r) {
    var option = function (value, current) { return '<option' + (value === current ? ' selected' : '') + '>' + esc(value) + '</option>'; };
    var times = r.start
      ? '<div class="entry-times"><label>Début<input class="field" id="entry-start" type="time" value="' + L.clock(r.start) + '"></label>' +
        '<label>Fin<input class="field" id="entry-end" type="time" value="' + (r.end ? L.clock(r.end) : '') + '"' + (r.end ? '' : ' disabled') + '></label></div>'
      : '<div class="row blocks" id="entry-hours">' + L.BLOCK_HOURS.map(function (h) {
        return '<button class="chip' + (h === Number(r.hours) ? ' on' : '') + '" data-act="pickHours" data-v="' + h + '">' + h + '</button>';
      }).join('') + '</div>';
    return '<div class="entry-form">' + times +
      '<select class="field" id="entry-project">' + s.projects.map(function (p) { return option(p, r.project); }).join('') + '</select>' +
      '<select class="field" id="entry-type">' + L.typesOf(s).map(function (t) { return option(t.name, L.typeOf(r)); }).join('') + '</select>' +
      '<input class="field" id="entry-note" type="text" maxlength="500" placeholder="Note" value="' + esc(r.note) + '">' +
      '<div class="actions"><button class="danger" data-act="entryDelete" data-id="' + esc(r.id) + '">Supprimer</button>' +
      '<button class="primary" data-act="entrySave" data-id="' + esc(r.id) + '">Enregistrer</button></div></div>';
  }
```

15. `WITHOUT_STATUS` : remplacer par
    `var WITHOUT_STATUS = ['close', 'sync', 'retry', 'menu', 'changeCode', 'sessionsClose'];`

16. Formulaire de code : dans l'écouteur `submit`, après `refresh();`, ajouter
    `if (VUE_SESSIONS) openSessions();`.

17. Relecture régulière : après `setInterval(function () { if (state.queue.length) flush(); }, RETRY_MS);`, ajouter :
    ```js
      // Relecture de l'état quand la page est visible : un compteur lancé ailleurs apparaît vite.
      setInterval(function () { if (document.visibilityState === 'visible' && !state.flushing) refresh(); }, POLL_MS);
    ```

18. Démarrage : remplacer la dernière ligne `if (CONFIGURED) refresh();` par :
    ```js
      if (CONFIGURED) refresh();
      if (CONFIGURED && VUE_SESSIONS && state.code) openSessions();
    ```

- [ ] **Étape 6 : styles, adresse de l'API, cache**

À la fin de `web/style.css`, avant le bloc `@media (prefers-reduced-motion: reduce)`, ajouter :

```css
/* Annuler : discret, sous les projets ; le résumé dit ce qui sera défait. */
.undo { font-size: 14px; text-align: left; align-self: flex-start; }
.undo:disabled { opacity: 0.45; text-decoration: none; }

/* Fenêtre des sessions : un jour, une ligne par session ou bloc, un tap ouvre la correction. */
.sessions { display: flex; flex-direction: column; gap: 10px; }
.sessions-head { display: flex; flex-direction: column; gap: 2px; }
.sessions-total { margin: 0; color: var(--muted); }
.entries { display: flex; flex-direction: column; gap: 6px; }
.entry { border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
.entry.open { border-color: var(--fg); }
.entry-line { display: grid; grid-template-columns: 12px 1fr auto; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; text-align: left; }
.entry-line .dot { width: 10px; height: 10px; border-radius: 50%; }
.entry-main { display: flex; flex-direction: column; min-width: 0; }
.entry-main small { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-hours { font-variant-numeric: tabular-nums; font-weight: 600; }
.entry-hours.long { color: var(--warn); }
.entry-form { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; }
.entry-times { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.entry-times label { display: flex; flex-direction: column; gap: 4px; color: var(--muted); font-size: 14px; }
.danger { min-height: 52px; border-radius: 14px; border: 1px solid var(--err); color: var(--err); background: var(--card); font-weight: 600; }
.sessions-page { display: flex; flex-direction: column; gap: 12px; }
```

`web/config.js` :

```js
// Adresse de l'API : le Worker sert l'app et l'API sur la même origine. L'APK, lui, remplace ce
// fichier par l'adresse complète (android/build.sh).
window.KT_API_URL = '/api';
```

`web/sw.js` : remplacer `var CACHE = 'kt-v12';` par `var CACHE = 'kt-v13';`, et le commentaire
d'en-tête par :

```js
// Service worker : l'app s'ouvre même sans réseau, mais affiche toujours la dernière version.
// Réseau d'abord : chaque fichier de l'app est redemandé au serveur ; la copie locale ne sert que
// hors ligne. Les appels à l'API sont des POST : ils ne passent jamais par ici.
```

- [ ] **Étape 7 : scénarios de bout en bout**

Dans `tools/e2e.js`, juste avant `console.log('Bloc');`, ajouter :

```js
  console.log('Annuler');
  await page.click('[data-act="start"][data-p="Fluffy"]');
  await page.waitFor('document.querySelector(".sync-ok") && document.querySelector("[data-act=undo]:not([disabled])")', 'bouton Annuler');
  check(/Lancement Fluffy/.test(await page.evaluate('document.querySelector("[data-act=undo]").textContent')), 'Annuler dit ce qu’il défait');
  await page.click('[data-act="undo"]');
  await page.waitFor('document.querySelector(".hero.idle") && document.querySelector(".sync-ok")', 'lancement annulé');
  check((await api(P, { ...me, action: 'status' })).running === null, 'serveur : le lancement annulé ne laisse rien');

  console.log('Fenêtre des sessions');
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  await page.click('[data-act="start"][data-p="Proto"]');
  await page.waitFor('document.querySelector(".sync-ok") && document.querySelector(".hero-project").textContent.startsWith("Proto · ")', 'lancement Proto');
  await page.click('[data-act="stop"]');
  await page.waitFor('document.querySelector(".hero.idle") && document.querySelector(".sync-ok")', 'arrêt');
  await page.click('[data-act="sessions"]');
  await page.waitFor('document.querySelector("dialog .sessions .entry")', 'liste des sessions');
  await page.shot('03a-sessions');
  const count = await page.evaluate('document.querySelectorAll("dialog .sessions .entry").length');
  await page.click('dialog .sessions .entry:last-child [data-act="entryOpen"]');
  await page.waitFor('document.getElementById("entry-type")', 'correction ouverte');
  await page.evaluate('document.getElementById("entry-type").value = "Debug"');
  await page.click('dialog [data-act="entrySave"]');
  await page.waitFor('/Debug/.test(document.querySelector("dialog .sessions .entry:last-child").textContent)', 'type corrigé');
  let h = await api(P, { ...me, action: 'history', from: todayKey, to: todayKey });
  check(h.rows.filter((r) => r.project === 'Proto').at(-1)?.type === 'Debug', 'serveur : type corrigé');
  await page.evaluate('window.confirm = () => true');
  await page.click('dialog .sessions .entry:last-child [data-act="entryOpen"]');
  await page.click('dialog [data-act="entryDelete"]');
  await page.waitFor(`document.querySelectorAll("dialog .sessions .entry").length === ${count - 1}`, 'session supprimée');
  await page.click('dialog [data-act="undo"]');
  await page.waitFor(`document.querySelectorAll("dialog .sessions .entry").length === ${count}`, 'suppression annulée');
  h = await api(P, { ...me, action: 'history', from: todayKey, to: todayKey });
  check(h.rows.length === count, 'serveur : la session supprimée est revenue');
  await page.click('dialog [data-act="sessionsClose"]');
```

Dans la section « Version compacte », après la vérification du bouton « Plus d'infos », ajouter :

```js
  check(await shown('[data-act=sessions]'), 'mini : bouton Sessions');
```

- [ ] **Étape 8 : lancer tous les tests**

Lancer : `npm test`
Attendu : tous `ok` (calculs web, serveur ; les anciens tests `core.test.js` et `selftest.test.js`
de l'Apps Script passent encore, ils seront retirés après la bascule).

Lancer : `node tools/e2e.js`
Attendu : `Tout est vert.`

Ouvrir `node tools/dev-server.mjs` puis `http://localhost:8787/__phone?dev-code=code-amohs` et
`http://localhost:8787/?vue=sessions&dev-code=code-amohs` : vérifier à l'œil la fenêtre des sessions
(clair et sombre), le bouton Annuler, une ligne signalée ⚠ avec `--forgot`. Arrêter le serveur.

- [ ] **Étape 9 : commit**

```bash
git add web/logic.js web/app.js web/style.css web/config.js web/sw.js tests/logic.test.js tools/e2e.js
git commit -m "feat(app) : Annuler, fenêtre des sessions (supprimer, corriger), relecture toutes les 20 s"
```

---

### Tâche 7 : Mini-fenêtre de bureau — fenêtre des sessions

**Fichiers :**
- Modifier : `desktop/main.js`

**Interfaces :**
- Consomme : la page `?vue=sessions` et le bouton `[data-act=sessions]` de la version compacte
  (tâche 6), qui fait `window.open('./?vue=sessions', 'sessions')`.
- Produit : une deuxième fenêtre Electron sur la page des sessions ; à sa fermeture, la
  mini-fenêtre relit l'état.

- [ ] **Étape 1 : ouvrir les sessions dans une deuxième fenêtre**

Dans `desktop/main.js` :

1. Après `let settings = null;`, ajouter `let sessionsWin = null;`.
2. Remplacer le gestionnaire `setWindowOpenHandler` par :
   ```js
     // « Sessions » ouvre une deuxième fenêtre ; les autres liens (« Plus d'infos ») partent dans
     // Brave, version complète.
     win.webContents.setWindowOpenHandler(({ url }) => {
       if (/[?&]vue=sessions/.test(url)) openSessionsWindow(url);
       else openInBrowser(url.replace(/[?&]mini=1/, ''));
       return { action: 'deny' };
     });
   ```
3. Après la fonction `openInBrowser`, ajouter :
   ```js
   // La fenêtre des sessions : une fenêtre normale, au-dessus si la mini-fenêtre l'est. À sa
   // fermeture, la mini-fenêtre relit l'état (une session supprimée ou corrigée s'y voit tout de suite).
   function openSessionsWindow(url) {
     if (sessionsWin && !sessionsWin.isDestroyed()) {
       sessionsWin.loadURL(url);
       sessionsWin.show();
       sessionsWin.focus();
       return;
     }
     sessionsWin = new BrowserWindow({
       width: 400,
       height: 640,
       title: 'Sessions — Kilosaurus Temps',
       backgroundColor: '#131316',
       icon: fs.existsSync(ICON) ? ICON : LOGO,
       autoHideMenuBar: true,
       alwaysOnTop: settings.onTop,
     });
     sessionsWin.loadURL(url).catch((e) => log('fenêtre des sessions : ' + e.message));
     sessionsWin.on('closed', () => {
       sessionsWin = null;
       if (win) win.webContents.executeJavaScript("window.dispatchEvent(new Event('online'))").catch(() => {});
     });
   }
   ```
4. En tête du fichier, dans le commentaire d'usage, ajouter la ligne :
   `// « Sessions » (barre du haut) ouvre la fenêtre des sessions dans une deuxième fenêtre.`

L'adresse `SITE` change à la bascule (tâche 11), quand l'adresse du Worker est connue.

- [ ] **Étape 2 : vérifier à la main contre le serveur de dev**

Lancer `node tools/dev-server.mjs` dans un terminal. Dans un autre terminal **hors de VS Code**
(VS Code pose `ELECTRON_RUN_AS_NODE`) :

```bash
cd desktop && npx electron . 
```

après avoir remplacé temporairement `SITE` par `'http://localhost:8787/'` et saisi le code
`code-amohs`. Vérifier : le bouton « Sessions » ouvre une deuxième fenêtre avec la liste ; supprimer
une session puis fermer la fenêtre : la mini-fenêtre se met à jour. Remettre `SITE` à sa valeur.

- [ ] **Étape 3 : commit**

```bash
git add desktop/main.js
git commit -m "feat(desktop) : la fenêtre des sessions s'ouvre dans une deuxième fenêtre"
```

---

### Tâche 8 : Widget Android — stable

**Fichiers :**
- Modifier (remplacement complet) : `android/src/com/kilosaurus/temps/Prefs.java`,
  `android/src/com/kilosaurus/temps/WidgetProvider.java`
- Modifier : `android/src/com/kilosaurus/temps/Api.java`, `android/src/com/kilosaurus/temps/MainActivity.java`,
  `android/AndroidManifest.xml`, `android/build.sh`

**Interfaces :**
- Consomme : `status.serverTime`, `status.threshold` (tâche 2), `tapTime` (inchangé côté serveur).
- Produit : `Prefs.saveStatus(JSONObject data, int seqAtSend)`, `Prefs.tapSeq()`,
  `Prefs.serverNow()`, `Prefs.thresholdMs()` ; `Api.DEFAULT_URL` sur une seule ligne (lue par
  `build.sh`).

- [ ] **Étape 1 : reproduire le « compteur qui avance tout seul » (avant toute modification)**

Sur le téléphone, avec l'APK actuel et un compteur lancé depuis le widget :
1. Redémarrer le téléphone ; noter si le chrono du widget affiche une valeur fausse au retour.
2. Arrêter le compteur, régler l'heure du téléphone à 23:58 (Réglages → Date et heure, réglage
   automatique désactivé), attendre minuit : noter si « Aujourd'hui » continue de compter le total
   de la veille.
Noter le résultat dans le message de commit de la tâche (confirmé / non reproduit). Remettre l'heure
automatique. Si le téléphone n'est pas disponible, le noter et passer : la correction couvre les
deux cas.

- [ ] **Étape 2 : remplacer `Prefs.java`**

```java
package com.kilosaurus.temps;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * Réglages et état affiché, stockés sur le téléphone.
 * Le code et l'URL sont propres à l'appareil ; le projet est propre à chaque widget posé.
 * L'état « compteur en cours » et le total du jour sont ceux de la personne, partagés par tous ses
 * widgets. Le widget change cet état lui-même au tap ; la file `queue` porte les actions pas encore
 * confirmées par le serveur, et tant qu'elle n'est pas vide, l'état du serveur ne l'écrase pas.
 *
 * Deux repères évitent de comparer l'horloge du téléphone à celle du serveur :
 *  - tapSeq compte les taps : un état lu avant un tap n'est jamais appliqué après lui ;
 *  - clockOffset est l'écart entre les deux horloges, mesuré à chaque réponse : l'heure d'un tap et
 *    les chronos sont calculés à l'heure du serveur, même si le téléphone avance ou retarde.
 */
final class Prefs {
    private static final long HOUR_MS = 3600000L;
    private final SharedPreferences sp;

    Prefs(Context ctx) {
        sp = ctx.getSharedPreferences("kt", Context.MODE_PRIVATE);
    }

    String code() { return sp.getString("code", ""); }
    String me() { return sp.getString("me", ""); }
    String message() { return sp.getString("message", ""); }

    /** Adresse de l'API. Celle de la v1 (Apps Script), gardée par un widget réglé avant la v2, est remplacée. */
    String url() {
        String u = sp.getString("url", Api.DEFAULT_URL);
        return u.contains("script.google.com") ? Api.DEFAULT_URL : u;
    }

    void setAccess(String code, String url) {
        sp.edit().putString("code", code.trim()).putString("url", url.trim()).apply();
    }

    void setCode(String code) {
        sp.edit().putString("code", code.trim()).apply();
    }

    void setMessage(String message) {
        sp.edit().putString("message", message).apply();
    }

    String widgetProject(int widgetId) { return sp.getString("project_" + widgetId, ""); }

    void setWidgetProject(int widgetId, String project) {
        sp.edit().putString("project_" + widgetId, project).apply();
    }

    void forgetWidget(int widgetId) {
        sp.edit().remove("project_" + widgetId).apply();
    }

    // ---- Repères ----

    int tapSeq() { return sp.getInt("tapSeq", 0); }

    /** Heure du serveur, estimée : l'horloge du téléphone corrigée de l'écart mesuré à la dernière réponse. */
    long serverNow() { return System.currentTimeMillis() + sp.getLong("clockOffset", 0); }

    /** Seuil d'oubli (réglage du serveur, 8 h par défaut). */
    long thresholdMs() { return sp.getLong("thresholdMs", 8 * HOUR_MS); }

    // ---- Compteur en cours ----

    boolean isRunning() { return sp.getLong("runningStart", 0) > 0; }
    String runningProject() { return sp.getString("runningProject", ""); }
    long runningStart() { return sp.getLong("runningStart", 0); }
    String runningType() { return canonicalType(sp.getString("runningType", "Misc")); }

    /** Noms de la première version (Autre, Narration), encore possibles dans un état mémorisé. */
    static String canonicalType(String type) {
        if ("Autre".equals(type)) return "Misc";
        if ("Narration".equals(type)) return "Writing";
        return type;
    }

    /** Lance le compteur affiché, sans attendre le serveur. */
    void startLocal(String project, String type, long at) {
        sp.edit().putString("runningProject", project).putString("runningType", type).putLong("runningStart", at)
            .putInt("tapSeq", tapSeq() + 1).apply();
    }

    /** Arrête le compteur affiché, sans attendre le serveur ; sa part d'aujourd'hui rejoint le total du jour. */
    void stopLocal(long at) {
        long from = Math.max(runningStart(), startOfToday());
        long done = todayDoneMs() + Math.max(0, at - from);
        sp.edit().remove("runningProject").remove("runningType").remove("runningStart")
            .putString("todayKey", todayKey()).putLong("todayDoneMs", done).putInt("tapSeq", tapSeq() + 1).apply();
    }

    // ---- Total du jour ----

    static String todayKey() { return LocalDate.now().toString(); }

    static long startOfToday() {
        return LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli();
    }

    /** Temps du jour hors compteur en cours (sessions terminées découpées à minuit, blocs du jour). */
    long todayDoneMs() {
        return todayKey().equals(sp.getString("todayKey", "")) ? sp.getLong("todayDoneMs", 0) : 0;
    }

    // ---- File des actions pas encore confirmées ----

    JSONArray queue() {
        try { return new JSONArray(sp.getString("queue", "[]")); } catch (JSONException e) { return new JSONArray(); }
    }

    void setQueue(JSONArray q) {
        sp.edit().putString("queue", q.toString()).commit();
    }

    // ---- État renvoyé par le serveur ----

    /**
     * Mémorise l'état renvoyé par l'API. L'écart d'horloge et le seuil d'oubli sont toujours pris. Le
     * compteur et le total du jour ne le sont que si aucune action du widget n'attend et qu'aucun tap
     * n'a eu lieu depuis l'envoi de la requête (seqAtSend) : sinon cet état précède ce que le widget
     * montre, et l'appliquer rallumerait ou éteindrait le compteur à tort.
     */
    void saveStatus(JSONObject data, int seqAtSend) {
        SharedPreferences.Editor e = sp.edit().putString("me", data.optString("me", ""));
        String serverTime = data.optString("serverTime", "");
        if (!serverTime.isEmpty()) {
            try {
                e.putLong("clockOffset", Instant.parse(serverTime).toEpochMilli() - System.currentTimeMillis());
            } catch (RuntimeException ignored) {
                // Heure illisible : l'écart précédent reste.
            }
        }
        if (data.has("threshold")) e.putLong("thresholdMs", Math.round(data.optDouble("threshold", 8) * HOUR_MS));
        if (queue().length() > 0 || tapSeq() != seqAtSend) { e.apply(); return; }
        JSONObject running = data.optJSONObject("running");
        if (running != null) {
            e.putString("runningProject", running.optString("project", ""));
            e.putString("runningType", running.optString("type", "Misc"));
            e.putLong("runningStart", Instant.parse(running.optString("start")).toEpochMilli());
        } else {
            e.remove("runningProject").remove("runningType").remove("runningStart");
        }
        JSONArray today = data.optJSONArray("today");
        if (today != null) e.putString("todayKey", todayKey()).putLong("todayDoneMs", doneMs(today));
        e.apply();
    }

    private static long doneMs(JSONArray today) {
        long midnight = startOfToday();
        String key = todayKey();
        long sum = 0;
        for (int i = 0; i < today.length(); i++) {
            JSONObject r = today.optJSONObject(i);
            if (r == null) continue;
            String start = r.optString("start", "");
            if (start.isEmpty() || "null".equals(start)) {
                if (key.equals(r.optString("date"))) sum += Math.round(r.optDouble("hours", 0) * 3600000);
                continue;
            }
            String end = r.optString("end", "");
            if (end.isEmpty() || "null".equals(end)) continue; // en cours : compté par le chrono
            long a = Math.max(Instant.parse(start).toEpochMilli(), midnight);
            long b = Instant.parse(end).toEpochMilli();
            if (b > a) sum += b - a;
        }
        return sum;
    }
}
```

- [ ] **Étape 3 : remplacer `WidgetProvider.java`**

```java
package com.kilosaurus.temps;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Widget lecture / stop. Le téléphone sert à écrire : ▶ lance le projet du widget en type Writing,
 * ■ arrête le compteur en cours, d'où qu'il vienne.
 *
 * Zéro attente : un tap change l'état affiché (Prefs) et met l'action en file, sans réseau. Un seul
 * envoyeur vide la file derrière, dans l'ordre, chaque action avec l'heure de son tap (tapTime, à
 * l'heure du serveur). Sans réseau, la file attend : nouvel essai toutes les minutes, à chaque tap et
 * à chaque rafraîchissement.
 *
 * Les chronos sont gérés par Android (Chronometer), calés sur le temps écoulé depuis l'allumage du
 * téléphone. Ce repère repart de zéro au redémarrage, et le total « Aujourd'hui » doit repartir de
 * zéro à minuit : le widget se redessine donc au démarrage, à un changement d'heure ou de fuseau, et
 * à minuit (alarme).
 */
public class WidgetProvider extends AppWidgetProvider {
    static final String ACTION_TOGGLE = "com.kilosaurus.temps.TOGGLE";
    static final String ACTION_REFRESH = "com.kilosaurus.temps.REFRESH";
    static final String ACTION_MIDNIGHT = "com.kilosaurus.temps.MIDNIGHT";
    static final String WIDGET_TYPE = "Writing";
    static final long RETRY_MS = 60000;
    private static final int RETRY_REQUEST = 0x7fff0000;
    private static final int MIDNIGHT_REQUEST = 0x7fff0001;
    private static final int OPEN_APP_REQUEST = 0x7ffe0000;

    // LOCK protège la file (lecture-modification-écriture) ; SENDING garantit un seul envoyeur.
    private static final Object LOCK = new Object();
    private static final AtomicBoolean SENDING = new AtomicBoolean(false);

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (ACTION_TOGGLE.equals(action)) {
            int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            toggle(ctx, widgetId);
            background(ctx, () -> send(ctx));
        } else if (ACTION_REFRESH.equals(action) || AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action) || isClockEvent(action)) {
            renderAll(ctx);
            background(ctx, () -> refresh(ctx));
        } else if (ACTION_MIDNIGHT.equals(action)) {
            renderAll(ctx);
        } else {
            super.onReceive(ctx, intent);
        }
    }

    /** Événements qui décalent les repères des chronos : démarrage, heure ou fuseau changés, mise à jour de l'app. */
    private static boolean isClockEvent(String action) {
        return Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_TIME_CHANGED.equals(action)
            || Intent.ACTION_TIMEZONE_CHANGED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
    }

    private void background(Context ctx, Runnable work) {
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try { work.run(); } finally { pending.finish(); }
        }).start();
    }

    @Override
    public void onDeleted(Context ctx, int[] widgetIds) {
        Prefs p = new Prefs(ctx);
        for (int id : widgetIds) p.forgetWidget(id);
    }

    /** Le tap : état affiché changé et action mise en file, tout de suite, sans réseau. */
    private static void toggle(Context ctx, int widgetId) {
        Prefs p = new Prefs(ctx);
        synchronized (LOCK) {
            if (p.code().isEmpty()) {
                p.setMessage("Touche le nom du projet pour régler le widget.");
            } else {
                long now = p.serverNow();
                JSONObject item = new JSONObject();
                try {
                    if (p.isRunning()) {
                        p.stopLocal(now);
                        item.put("action", "stop");
                    } else {
                        String project = p.widgetProject(widgetId);
                        if (project.isEmpty()) {
                            p.setMessage("Touche le nom du projet pour en choisir un.");
                            renderAll(ctx);
                            return;
                        }
                        p.startLocal(project, WIDGET_TYPE, now);
                        item.put("action", "start").put("id", UUID.randomUUID().toString())
                            .put("project", project).put("type", WIDGET_TYPE);
                    }
                    item.put("tapTime", Instant.ofEpochMilli(now).toString());
                } catch (JSONException e) {
                    return;
                }
                JSONArray q = p.queue();
                q.put(item);
                p.setQueue(q);
                p.setMessage("");
            }
        }
        renderAll(ctx);
    }

    /**
     * Vide la file, une action à la fois, dans l'ordre. Une action refusée par le serveur est
     * retirée, puis le widget se recale sur l'état du serveur. Un échec de réseau garde la file et
     * programme un nouvel essai.
     */
    static void send(Context ctx) {
        Prefs p = new Prefs(ctx);
        do {
            if (!SENDING.compareAndSet(false, true)) return; // un autre envoyeur s'en charge
            boolean dropped = false;
            try {
                while (true) {
                    JSONObject item;
                    synchronized (LOCK) {
                        JSONArray q = p.queue();
                        if (q.length() == 0) break;
                        item = q.optJSONObject(0);
                    }
                    JSONObject data;
                    try {
                        JSONObject body = item == null ? null : new JSONObject(item.toString()).put("code", p.code());
                        data = body == null ? null : Api.call(p.url(), body);
                    } catch (Api.ApiException e) {
                        if ("invalid".equals(e.kind) || "server".equals(e.kind)) {
                            data = null;
                            dropped = true;
                        } else {
                            // Réseau, serveur occupé ou bloqué, code refusé : la file attend. Un code
                            // refusé n'est pas renvoyé tout seul : chaque essai compterait comme une
                            // tentative ratée et bloquerait l'adresse du téléphone.
                            int n = p.queue().length();
                            if ("unauthorized".equals(e.kind)) {
                                p.setMessage(describe(e));
                            } else {
                                p.setMessage("Pas de réseau : " + n + " action(s) en attente, envoi automatique.");
                                scheduleRetry(ctx);
                            }
                            renderAll(ctx);
                            return;
                        }
                    } catch (JSONException e) {
                        data = null;
                        dropped = true;
                    }
                    boolean empty;
                    synchronized (LOCK) {
                        JSONArray q = p.queue();
                        q.remove(0);
                        p.setQueue(q);
                        empty = q.length() == 0;
                    }
                    // File vide : l'état du serveur fait foi (saveStatus l'ignore si un tap est arrivé entre-temps).
                    if (empty && data != null) {
                        p.saveStatus(data, p.tapSeq());
                        p.setMessage("");
                        renderAll(ctx);
                    }
                }
                if (dropped) {
                    p.setMessage("Une action a été refusée par le serveur : affichage recalé.");
                    fetchStatus(p);
                    renderAll(ctx);
                }
            } finally {
                SENDING.set(false);
            }
        } while (p.queue().length() > 0); // un tap arrivé juste à la fin de la boucle
    }

    /** Rafraîchissement : vide d'abord la file ; sinon relit l'état du serveur (compteur lancé ailleurs). */
    static void refresh(Context ctx) {
        Prefs p = new Prefs(ctx);
        if (p.code().isEmpty()) return;
        if (p.queue().length() > 0) { send(ctx); return; }
        try {
            fetchStatus(p);
            p.setMessage("");
        } catch (RuntimeException e) {
            // fetchStatus ne lève rien de prévu ; une erreur imprévue ne doit pas tuer le widget.
        }
        renderAll(ctx);
    }

    // Le compteur de taps est noté avant l'envoi : une réponse partie avant un tap est ignorée à son retour.
    private static void fetchStatus(Prefs p) {
        int seq = p.tapSeq();
        try {
            p.saveStatus(Api.call(p.url(), new JSONObject().put("code", p.code()).put("action", "status")), seq);
        } catch (Api.ApiException e) {
            // Une mise à jour sans réseau n'est pas une erreur à afficher.
            if (!"network".equals(e.kind) && !"timeout".equals(e.kind)) p.setMessage(describe(e));
        } catch (JSONException e) {
            p.setMessage("Erreur interne : " + e.getMessage());
        }
    }

    private static void scheduleRetry(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(ACTION_REFRESH);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, RETRY_REQUEST, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + RETRY_MS, pi);
    }

    // Prochain minuit (heure du téléphone), à quelques minutes près : le total du jour repart de zéro.
    private static void scheduleMidnight(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(ACTION_MIDNIGHT);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, MIDNIGHT_REQUEST, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long at = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli() + 5000;
        am.setAndAllowWhileIdle(AlarmManager.RTC, at, pi);
    }

    static String describe(Api.ApiException e) {
        if ("unauthorized".equals(e.kind)) return "Code refusé : touche le nom du projet pour le corriger.";
        if ("busy".equals(e.kind)) return "Serveur occupé, réessaie.";
        if ("locked".equals(e.kind)) return "Accès bloqué pour une heure (trop de codes refusés).";
        if ("invalid".equals(e.kind) || "server".equals(e.kind)) return "Refusé : " + e.getMessage();
        return e.getMessage();
    }

    static void renderAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        for (int id : mgr.getAppWidgetIds(new ComponentName(ctx, WidgetProvider.class))) render(ctx, mgr, id);
        scheduleMidnight(ctx);
    }

    private static void render(Context ctx, AppWidgetManager mgr, int widgetId) {
        Prefs p = new Prefs(ctx);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        boolean running = p.isRunning();
        long now = p.serverNow();
        long elapsedNow = SystemClock.elapsedRealtime();

        // Total du jour = temps déjà fait aujourd'hui + part d'aujourd'hui du compteur en cours.
        long today = p.todayDoneMs() + (running ? Math.max(0, now - Math.max(p.runningStart(), Prefs.startOfToday())) : 0);
        v.setChronometer(R.id.today, elapsedNow - today, "Aujourd'hui %s", running);

        if (running) {
            v.setTextViewText(R.id.title, p.runningProject() + " · " + p.runningType());
            v.setChronometer(R.id.chrono, elapsedNow - (now - p.runningStart()), null, true);
            v.setTextViewText(R.id.button, "■");
            v.setInt(R.id.button, "setBackgroundResource", R.drawable.btn_stop);
        } else {
            String project = p.widgetProject(widgetId);
            v.setTextViewText(R.id.title, project.isEmpty() ? "Choisir un projet" : project + " · " + WIDGET_TYPE);
            v.setChronometer(R.id.chrono, elapsedNow, null, false);
            v.setTextViewText(R.id.button, "▶");
            v.setInt(R.id.button, "setBackgroundResource", R.drawable.btn_play);
        }

        // Compteur oublié : le message remplace « Aujourd'hui » et ouvre l'app (garde-fou de l'heure de fin).
        boolean forgotten = running && now - p.runningStart() > p.thresholdMs();
        String message = forgotten
            ? "Compteur lancé il y a " + ((now - p.runningStart()) / 3600000L) + " h : touche pour corriger."
            : p.message();
        v.setTextViewText(R.id.message, message);
        v.setViewVisibility(R.id.message, message.isEmpty() ? View.GONE : View.VISIBLE);
        v.setViewVisibility(R.id.today, message.isEmpty() ? View.VISIBLE : View.GONE);

        v.setOnClickPendingIntent(R.id.button, broadcast(ctx, ACTION_TOGGLE, widgetId));
        PendingIntent messageTap = forgotten
            ? PendingIntent.getActivity(ctx, OPEN_APP_REQUEST + widgetId,
                new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
            : broadcast(ctx, ACTION_REFRESH, widgetId);
        v.setOnClickPendingIntent(R.id.message, messageTap);
        Intent config = new Intent(ctx, ConfigActivity.class)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        v.setOnClickPendingIntent(R.id.title, PendingIntent.getActivity(ctx, widgetId, config,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        mgr.updateAppWidget(widgetId, v);
    }

    // Codes de requête distincts par widget et par action : sinon Android réutilise le même intent.
    private static PendingIntent broadcast(Context ctx, String action, int widgetId) {
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(action)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        int requestCode = widgetId * 2 + (ACTION_TOGGLE.equals(action) ? 0 : 1);
        return PendingIntent.getBroadcast(ctx, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
```

- [ ] **Étape 4 : API, pont de l'app, manifeste, build**

`Api.java` :
1. Remplacer le commentaire de classe par :
   ```java
   /**
    * Appel à l'API (Worker Cloudflare) : POST JSON en text/plain. Une redirection éventuelle est
    * suivie à la main, en GET, pour ne dépendre d'aucun comportement implicite de HttpURLConnection.
    */
   ```
2. Remplacer la déclaration `DEFAULT_URL` (deux lignes) par une seule ligne (lue par `build.sh`) :
   ```java
       static final String DEFAULT_URL = "https://A_REMPLIR_A_LA_BASCULE/api";
   ```
3. Remplacer les délais et leur commentaire par :
   ```java
       // Le serveur répond en quelques centaines de ms ; au-delà, c'est le réseau du téléphone.
       private static final int CONNECT_TIMEOUT_MS = 5000;
       private static final int READ_TIMEOUT_MS = 8000;
   ```

`MainActivity.java`, dans `Bridge.onStatus`, remplacer `p.saveStatus(new JSONObject(json));` par
`p.saveStatus(new JSONObject(json), p.tapSeq());`.

`AndroidManifest.xml` :
1. Après `<uses-permission android:name="android.permission.INTERNET" />`, ajouter
   `<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />`.
2. Dans l'`intent-filter` du `receiver` `.WidgetProvider`, après l'action `APPWIDGET_UPDATE`, ajouter :
   ```xml
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.TIME_SET" />
                <action android:name="android.intent.action.TIMEZONE_CHANGED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
   ```

`build.sh`, juste après la ligne `rm -f "$OUT/extra/assets/web/sw.js"`, ajouter :

```bash
# L'app embarquée n'est pas servie par le Worker : elle appelle l'API par son adresse complète,
# celle d'Api.DEFAULT_URL (une seule source pour l'app et le widget).
API_URL="$(sed -n 's/.*DEFAULT_URL = "\(.*\)";.*/\1/p' "$HERE/src/com/kilosaurus/temps/Api.java")"
[ -n "$API_URL" ] || { echo "DEFAULT_URL introuvable dans Api.java" >&2; exit 1; }
printf "window.KT_API_URL = '%s';\n" "$API_URL" > "$OUT/extra/assets/web/config.js"
```

- [ ] **Étape 5 : compiler l'APK**

Lancer : `VERSION_CODE=10 VERSION_NAME=2.0 bash android/build.sh`
Attendu : `APK : …/android/build/kilosaurus-temps.apk`, `apksigner verify` sans erreur. (L'adresse
reste `A_REMPLIR_A_LA_BASCULE` : cet APK prouve que tout compile ; celui à installer est reconstruit
à la tâche 11.)

Vérifier le fichier généré : `unzip -p android/build/kilosaurus-temps.apk assets/web/config.js`
Attendu : `window.KT_API_URL = 'https://A_REMPLIR_A_LA_BASCULE/api';`

- [ ] **Étape 6 : commit**

```bash
git add android/src android/AndroidManifest.xml android/build.sh
git commit -m "fix(widget) : plus de comparaison d'horloges, redessiné au démarrage, au changement d'heure et à minuit, garde-fou d'oubli"
```

(Ajouter au message le résultat de l'étape 1 : reproduit / non reproduit.)

La vérification sur le téléphone (points de vigilance 3 et 4 : ancien réglage d'adresse remplacé,
redémarrage, minuit, taps rapides, mode avion) se fait à la tâche 11, avec l'APK définitif.

---

### Tâche 9 : Reprise de l'historique

**Fichiers :**
- Créer : `tools/migrate_d1.py`, `tools/check_import.mjs`, `tests/test_migrate_d1.py`

**Interfaces :**
- Consomme : `server/schema.sql` (tâche 1).
- Produit : `py tools/migrate_d1.py export.xlsx [reprise.sql] [--exclude id1,id2]` → `reprise.sql`
  + `reprise.totaux.json` ; `node tools/check_import.mjs reprise.sql`. Fonctions Python testables :
  `read(path)`, `build(cfg, projects, rows, exclude)`, `to_sql(cfg, projects, entries)`, `totals(entries)`.

- [ ] **Étape 1 : installer le fuseau pour Python**

Lancer : `py -m pip install tzdata`
Attendu : `Successfully installed tzdata-…` (sans lui, `ZoneInfo('Europe/Paris')` échoue sous Windows).

- [ ] **Étape 2 : écrire les tests**

`tests/test_migrate_d1.py` :

```python
"""Tests de tools/migrate_d1.py : py -m unittest discover -s tests -p "test_*.py" """
import os
import sys
import tempfile
import unittest
from datetime import datetime

import openpyxl

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import migrate_d1 as m  # noqa: E402

HEADERS = ["ID", "Personne", "Date", "Début", "Fin", "Heures", "Note", "Source", "Saisi le", "Corrigé", "Modifié le", "Type"]


def workbook(path, sheets):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        if name == "_Config":
            for r, values in enumerate(rows, start=1):
                for c, v in enumerate(values, start=1):
                    ws.cell(r, c, v)
            continue
        ws.append(HEADERS)
        for row in rows:
            ws.append(row)
    wb.save(path)


def d(*args):
    return datetime(*args)


CONFIG = [["Personnes", "", "Paramètre", "Valeur"], ["Amohs", "", "Seuil oubli (h)", 8], ["", "", "Onglet studio", "Studio"], ["", "", "Boutons visibles", 4]]


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "export.xlsx")

    def run_build(self, sheets, exclude=()):
        workbook(self.path, sheets)
        cfg, projects, rows = m.read(self.path)
        return cfg, projects, m.build(cfg, projects, rows, set(exclude))

    def test_sessions_blocs_et_ordre_des_projets(self):
        cfg, projects, (entries, problems, warnings) = self.run_build({
            "Heirfall": [["s1", "Amohs", d(2026, 10, 1), d(2026, 10, 1, 9), d(2026, 10, 1, 12, 30), 3.5, "dialogues", "app", d(2026, 10, 1, 9), None, d(2026, 10, 1, 12, 30), "Narration"]],
            "Fluffy": [["report-0001", "Amohs", d(2024, 3, 2), None, None, 3.5, "menus", "report", None, None, None, None],
                       ["x1", "Alex", d(2026, 10, 1), None, None, 8, "", "app", d(2026, 10, 1, 9), None, None, "Dev"]],
            "_Config": CONFIG,
            "ZZ Test A1": [],
        })
        self.assertEqual(projects, ["Heirfall", "Fluffy"])
        self.assertEqual(cfg["me"], "Amohs")
        self.assertEqual(problems, [])
        self.assertEqual([e["id"] for e in entries], ["s1", "report-0001"])
        s1, rep = entries
        self.assertEqual(s1["kind"], "session")
        self.assertEqual(s1["type"], "Writing")
        self.assertEqual(s1["day"], "2026-10-01")
        self.assertEqual(s1["end_ms"] - s1["start_ms"], 3.5 * 3600000)
        self.assertEqual(rep["kind"], "block")
        self.assertEqual(rep["hours"], 3.5)
        self.assertEqual(rep["type"], "Misc")
        self.assertEqual(rep["day"], "2024-03-02")
        self.assertEqual(m.totals(entries), {"rows": 2, "byProjectType": {"Heirfall|Writing": 3.5, "Fluffy|Misc": 3.5}})

    def test_heure_de_paris_et_changement_d_heure(self):
        _, _, (entries, _, _) = self.run_build({
            "Fluffy": [["s1", "Amohs", d(2026, 10, 25), d(2026, 10, 25, 1), d(2026, 10, 25, 4), 4, "", "app", None, None, None, "Dev"]],
            "_Config": CONFIG,
        })
        # 01:00 (heure d'été) → 04:00 (heure d'hiver) le 25 octobre : 4 h réelles.
        self.assertEqual(entries[0]["end_ms"] - entries[0]["start_ms"], 4 * 3600000)
        self.assertEqual(entries[0]["start_ms"], int(datetime.fromisoformat("2026-10-24T23:00:00+00:00").timestamp() * 1000))

    def test_lignes_refusees(self):
        _, _, (entries, problems, _) = self.run_build({
            "Fluffy": [
                ["a", "Amohs", d(2026, 10, 1), d(2026, 10, 1, 9), d(2026, 10, 1, 8), 1, "", "app", None, None, None, "Dev"],
                ["b", "Amohs", d(2026, 10, 1), d(2026, 10, 1, 9), None, None, "", "app", None, None, None, "Dev"],
                ["c", "Amohs", d(2026, 9, 1), d(2026, 9, 1, 9), d(2026, 9, 2, 10), 25, "", "app", None, None, None, "Dev"],
                ["e", "Amohs", d(2026, 9, 5), None, None, 30, "", "app", None, None, None, "Dev"],
                ["f", "Amohs", d(2026, 9, 6), d(2026, 9, 6, 9), d(2026, 9, 6, 11), 2, "", "app", None, None, None, "Dev"],
                ["g", "Amohs", d(2026, 9, 6), d(2026, 9, 6, 10), d(2026, 9, 6, 12), 2, "", "app", None, None, None, "Dev"],
            ],
            "_Config": CONFIG,
        })
        ids = sorted(p["id"] for p in problems)
        self.assertEqual(ids, ["a", "b", "c", "e", "f", "g"])
        self.assertTrue(any("chevauche" in p["why"] for p in problems))

    def test_exclure_et_signaler_les_sessions_longues(self):
        sheets = {
            "Fluffy": [
                ["long", "Amohs", d(2026, 10, 2), d(2026, 10, 2, 13, 5), d(2026, 10, 3, 3, 7), 14.03, "", "app", None, None, None, "Dev"],
                ["ok", "Amohs", d(2026, 10, 1), d(2026, 10, 1, 9), d(2026, 10, 1, 10), 1, "", "app", None, None, None, "Dev"],
                ["stale", "Amohs", d(2026, 10, 1), d(2026, 10, 1, 10), d(2026, 10, 1, 11), 3, "", "app", None, None, None, "Dev"],
            ],
            "_Config": CONFIG,
        }
        _, _, (entries, problems, warnings) = self.run_build(sheets)
        self.assertEqual(problems, [])
        self.assertTrue(any(w["id"] == "long" and "8 h" in w["why"] for w in warnings))
        self.assertTrue(any(w["id"] == "stale" and "Heures" in w["why"] for w in warnings))
        _, _, (entries, _, warnings) = self.run_build(sheets, exclude=["long"])
        self.assertEqual([e["id"] for e in entries], ["ok", "stale"])
        self.assertFalse(any(w["id"] == "long" for w in warnings))

    def test_sql(self):
        cfg, projects, (entries, _, _) = self.run_build({
            "Fluffy": [["q'1", "Amohs", d(2026, 10, 1), None, None, 2, "l'écran", "app", d(2026, 10, 1, 9), None, None, "Dev"]],
            "_Config": CONFIG,
        })
        sql = m.to_sql(cfg, projects, entries)
        self.assertIn("DELETE FROM entries;", sql)
        self.assertIn("INSERT INTO projects (name, position) VALUES ('Fluffy', 1);", sql)
        self.assertIn("('threshold', '8')", sql)
        self.assertIn("'q''1'", sql)
        self.assertIn("'l''écran'", sql)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Étape 3 : lancer les tests, vérifier qu'ils échouent**

Lancer : `py -m unittest discover -s tests -p "test_*.py"`
Attendu : ÉCHEC, `ModuleNotFoundError: No module named 'migrate_d1'`.

- [ ] **Étape 4 : écrire `tools/migrate_d1.py`**

```python
"""Reprise de l'historique : la Google Sheet (téléchargée en .xlsx) → un fichier SQL pour D1.

Usage : py tools/migrate_d1.py export.xlsx [reprise.sql] [--exclude id1,id2]

Lit les onglets de projet (tout onglet dont le nom ne commence ni par « _ » ni par « ZZ Test », dans
l'ordre des onglets), _Config, et les lignes de la personne de _Config. Refuse de produire le
fichier si une ligne viole une règle de la base (fin avant début, plus de 24 h, chevauchement, bloc
hors 0–24 h, compteur en cours) : chacune se corrige dans la Sheet, ou s'écarte avec --exclude.
Signale sans bloquer les sessions plus longues que le seuil d'oubli et les lignes dont la colonne
Heures ne correspond plus à Début / Fin. Écrit aussi <sortie>.totaux.json, que relit
tools/check_import.mjs.
"""
import json
import sys
from collections import defaultdict
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

import openpyxl

PARIS = ZoneInfo("Europe/Paris")
LEGACY = {"Autre": "Misc", "Narration": "Writing"}
TYPES = ["Misc", "Writing", "Sound", "Market", "Concept", "Art", "TechArt", "UI", "Dev", "Gameplay", "Tooling", "Debug", "Pause"]
COLS = ["id", "person", "date", "start", "end", "hours", "note", "source", "created", "corrected", "touched", "type"]
ENTRY = ["id", "project", "kind", "day", "start_ms", "end_ms", "hours", "type", "note", "source", "created_ms", "touched_ms", "deleted_ms"]
HOUR = 3600000
MAX_MS = 24 * HOUR


def to_ms(value):
    """Date-heure de la Sheet (heure de Paris, sans fuseau) → millisecondes UTC."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=PARIS)
        return int(dt.timestamp() * 1000)
    if isinstance(value, date):
        return to_ms(datetime.combine(value, time()))
    raise ValueError(f"date illisible : {value!r}")


def day_key(ms):
    return datetime.fromtimestamp(ms / 1000, PARIS).strftime("%Y-%m-%d")


def read_config(ws):
    persons = [ws.cell(r, 1).value for r in range(2, ws.max_row + 1) if ws.cell(r, 1).value]
    params = {ws.cell(r, 3).value: ws.cell(r, 4).value for r in range(2, ws.max_row + 1) if ws.cell(r, 3).value}
    return {
        "me": persons[0],
        "threshold": params.get("Seuil oubli (h)", 8),
        "studio": params.get("Onglet studio", "Studio"),
        "visible": params.get("Boutons visibles", 4),
    }


def read(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    cfg = read_config(wb["_Config"])
    projects = [ws.title for ws in wb.worksheets if not ws.title.startswith("_") and not ws.title.startswith("ZZ Test")]
    rows = []
    for name in projects:
        ws = wb[name]
        for r in range(2, ws.max_row + 1):
            v = dict(zip(COLS, (ws.cell(r, c).value for c in range(1, len(COLS) + 1))))
            if not v["id"] or not v["person"]:
                continue
            v["project"] = name
            v["where"] = f"{name}, ligne {r}"
            rows.append(v)
    return cfg, projects, rows


def convert(v):
    """Une ligne de la Sheet → (ligne de la base, None) ou (None, raison du refus)."""
    start, end = to_ms(v["start"]), to_ms(v["end"])
    created = to_ms(v["created"]) or start or to_ms(v["date"])
    common = {
        "id": str(v["id"]), "project": v["project"], "type": LEGACY.get(v["type"] or "Misc", v["type"] or "Misc"),
        "note": str(v["note"] or "").strip()[:500], "source": v["source"] or "app",
        "created_ms": created, "touched_ms": to_ms(v["touched"]) or created, "deleted_ms": None,
    }
    if common["type"] not in TYPES:
        common["type"] = "Misc"
    if start is not None:
        if end is None:
            return None, "compteur en cours : arrête-le avant la reprise"
        if end < start:
            return None, "fin avant le début"
        if end - start > MAX_MS:
            return None, "session de plus de 24 h"
        return {**common, "kind": "session", "day": day_key(start), "start_ms": start, "end_ms": end, "hours": None}, None
    hours = v["hours"]
    if not isinstance(hours, (int, float)) or not 0 < hours <= 24:
        return None, f"bloc avec une durée invalide ({hours!r})"
    if v["date"] is None:
        return None, "bloc sans date"
    return {**common, "kind": "block", "day": day_key(to_ms(v["date"])), "start_ms": None, "end_ms": None, "hours": float(hours)}, None


def build(cfg, projects, rows, exclude):
    """→ (lignes de la base, refus, signalements). Un refus empêche la reprise ; un signalement non."""
    entries, problems, warnings = [], [], []
    threshold_ms = float(cfg["threshold"]) * HOUR
    for v in rows:
        if v["person"] != cfg["me"] or str(v["id"]) in exclude:
            continue
        e, why = convert(v)
        if why:
            problems.append({"id": str(v["id"]), "where": v["where"], "why": why})
            continue
        if e["kind"] == "session":
            length = e["end_ms"] - e["start_ms"]
            if length > threshold_ms:
                warnings.append({"id": e["id"], "where": v["where"], "why": f"session de {length / HOUR:.2f} h (plus de {cfg['threshold']} h)"})
            if isinstance(v["hours"], (int, float)) and abs(v["hours"] - length / HOUR) > 0.01:
                warnings.append({"id": e["id"], "where": v["where"], "why": f"Heures = {v['hours']} mais Début / Fin = {length / HOUR:.2f} h (la base garde Début / Fin)"})
        entries.append(e)
    sessions = sorted((e for e in entries if e["kind"] == "session"), key=lambda e: e["start_ms"])
    for a, b in zip(sessions, sessions[1:]):
        if b["start_ms"] < a["end_ms"]:
            why = f"chevauche {a['id']} ({a['project']}, {day_key(a['start_ms'])})"
            problems.append({"id": b["id"], "where": b["project"], "why": why})
            problems.append({"id": a["id"], "where": a["project"], "why": f"chevauche {b['id']}"})
    return entries, problems, warnings


def lit(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def to_sql(cfg, projects, entries):
    out = ["-- Reprise de l'historique (tools/migrate_d1.py). Remplace tout le contenu de la base.",
           "DELETE FROM entries;", "DELETE FROM projects;", "DELETE FROM settings;", "DELETE FROM ops;"]
    for i, name in enumerate(projects, start=1):
        out.append(f"INSERT INTO projects (name, position) VALUES ({lit(name)}, {i});")
    for key in ("me", "studio", "visible", "threshold"):
        out.append(f"INSERT INTO settings (key, value) VALUES ({lit(key)}, {lit(str(cfg[key]))});")
    for e in entries:
        out.append(f"INSERT INTO entries ({', '.join(ENTRY)}) VALUES ({', '.join(lit(e[c]) for c in ENTRY)});")
    return "\n".join(out) + "\n"


def totals(entries):
    by = defaultdict(float)
    for e in entries:
        by[f"{e['project']}|{e['type']}"] += e["hours"] if e["kind"] == "block" else (e["end_ms"] - e["start_ms"]) / HOUR
    return {"rows": len(entries), "byProjectType": {k: round(v, 4) for k, v in by.items()}}


def main(argv):
    exclude, args, i = set(), [], 0
    while i < len(argv):
        if argv[i] == "--exclude":
            exclude = set(argv[i + 1].split(","))
            i += 2
            continue
        args.append(argv[i])
        i += 1
    src = args[0]
    out = args[1] if len(args) > 1 else "reprise.sql"
    cfg, projects, rows = read(src)
    entries, problems, warnings = build(cfg, projects, rows, exclude)

    print(f"Projets : {', '.join(projects)}")
    print(f"{len(entries)} lignes reprises pour {cfg['me']} ({len(exclude)} écartée(s) à la demande).")
    for w in warnings:
        print(f"  à vérifier : {w['id']} ({w['where']}) : {w['why']}")
    if problems:
        print("ÉCHEC : lignes refusées par les règles de la base (corrige-les dans la Sheet, ou --exclude <id>) :")
        for p in problems:
            print(f"  {p['id']} ({p['where']}) : {p['why']}")
        raise SystemExit(1)
    t = totals(entries)
    by_project = defaultdict(float)
    for key, hours in t["byProjectType"].items():
        by_project[key.split("|")[0]] += hours
    for name in projects:
        print(f"  {name:12} {by_project.get(name, 0):9.2f} h")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(to_sql(cfg, projects, entries))
    with open(out.rsplit(".", 1)[0] + ".totaux.json", "w", encoding="utf-8") as f:
        json.dump(t, f, ensure_ascii=False, indent=1)
    print(f"OK : {out} écrit. Vérifie-le avec : node tools/check_import.mjs {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
```

- [ ] **Étape 5 : écrire `tools/check_import.mjs`**

```js
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
```

- [ ] **Étape 6 : lancer les tests, puis un essai sur les vraies données**

Lancer : `py -m unittest discover -s tests -p "test_*.py"`
Attendu : `OK` (5 tests).

Si `export.xlsx` est à la racine (étape 2 de l'utilisateur) :
Lancer : `py tools/migrate_d1.py export.xlsx reprise.sql`
Attendu : la liste des projets, les lignes « à vérifier » (dont la session de 14 h), puis soit
`OK : reprise.sql écrit`, soit `ÉCHEC` avec les lignes refusées. Montrer la liste à l'utilisateur ;
ne rien écarter sans son accord. Puis, si OK : `node tools/check_import.mjs reprise.sql`, attendu
`OK : … lignes, totaux identiques`. Les fichiers `reprise.*` sont ignorés par git.

- [ ] **Étape 7 : commit**

```bash
git add tools/migrate_d1.py tools/check_import.mjs tests/test_migrate_d1.py
git commit -m "feat(reprise) : Sheet → SQL pour D1, règles vérifiées, totaux contrôlés"
```

---

### Tâche 10 : Skill d'agent et README

**Fichiers :**
- Modifier : `claude/kilosaurus-temps/SKILL.md`, `README.md`, `package.json` (script de test Python)

- [ ] **Étape 1 : mettre à jour le skill**

Dans `claude/kilosaurus-temps/SKILL.md` :
1. `## Configuration` : `KILOSAURUS_TEMPS_URL — URL de l'API (se termine par /api).`
2. `## Appeler l'API` : remplacer la phrase sur la redirection Google par
   « Toujours un POST, corps JSON, `Content-Type: text/plain`. Sous PowerShell, utilise `curl.exe`,
   pas `curl`. » ; garder `-sL` dans l'exemple. Ajouter `locked` = « cette adresse est bloquée une
   heure après trop de codes refusés : n'insiste pas, préviens l'utilisateur ».
3. Après la liste des champs de l'état, ajouter `undo` : « la dernière action annulable,
   `{ opId, summary }` ».
4. Tableau des actions : retirer la ligne `editLast` ; ajouter :

| Action | Paramètres | Usage |
|---|---|---|
| `editEntry` | `id`, `start?`, `end?`, `hours?`, `project?`, `type?`, `note?` | Corrige une ligne (trouvée avec `history`). Session : début < fin ≤ maintenant, 24 h au plus, sans chevauchement. Bloc : heures 2 à 12. |
| `deleteEntry` | `id` | Supprime une ligne (elle revient avec `undo`). |
| `undo` | `opId` | Annule la dernière action (`status.undo.opId`), puis la précédente au prochain appel. Refusé si une autre action a eu lieu entre-temps. |

5. `## Après chaque écriture` : remplacer la dernière phrase par « Si la demande était ambiguë
   (projet, heures, jour), demande avant d'écrire. Une erreur se corrige avec `editEntry`, ou
   s'annule avec `undo` tant que c'est la dernière action. »

- [ ] **Étape 2 : réécrire le README**

Garder la structure et le ton du README actuel (français, phrases courtes, étapes numérotées).
Sections et contenu :

1. **En-tête** : « Les données vivent dans une base Cloudflare D1. L'API et l'app sont servies par un
   Worker Cloudflare (offre gratuite). » Remplacer les puces Sheet / Apps Script / GitHub Pages.
2. **Contenu du dépôt** : tableau avec `server/` (Worker, règles métier, schéma), `web/`,
   `android/`, `desktop/`, `claude/kilosaurus-temps/`, `tools/` (serveur de dev, reprise, e2e,
   icônes), `tests/`. Garder la phrase sur les `.xlsx` (jamais commités), y ajouter `reprise.*`.
3. **Mise en place** (une fois) :
   1. Compte Cloudflare (gratuit, sans carte) et sous-domaine `workers.dev`.
   2. `npm install`, puis `npx wrangler login` (le navigateur s'ouvre, cliquer sur Allow).
   3. `npx wrangler d1 create kilosaurus-temps --location weur` ; copier l'identifiant affiché dans
      `wrangler.toml` (`database_id`).
   4. `npm run db:schema`.
   5. Codes : `npx wrangler secret put CODE_AMOHS_TELEPHONE` (puis `_PC`, `_CLAUDE`), la valeur se
      colle dans le terminal ; règles des codes (32 caractères, un par appareil, `CLAUDE` = agent,
      révoquer = `npx wrangler secret delete …`), commande PowerShell de génération gardée.
   6. `npm run deploy` ; l'adresse s'affiche (`https://kilosaurus-temps.<sous-domaine>.workers.dev`).
   7. Reprise de l'historique : `py -m pip install openpyxl tzdata`, télécharger la Sheet en .xlsx,
      `py tools/migrate_d1.py export.xlsx reprise.sql [--exclude …]`,
      `node tools/check_import.mjs reprise.sql`,
      `npx wrangler d1 execute kilosaurus-temps --remote --file reprise.sql`, relire le nombre de
      lignes.
   8. Installer l'app sur le téléphone / le PC (texte actuel, nouvelle adresse).
4. **Utilisation** : texte actuel, avec :
   - **↶ Annuler** : la dernière action, résumée ; on remonte une action à la fois ; annuler un
     arrêt rouvre le compteur ; demande le réseau.
   - **Sessions** : un jour à la fois ; un tap sur une ligne pour supprimer ou corriger début, fin,
     projet, type, note ; ⚠ = plus longue que le seuil d'oubli.
   - Retirer « Corriger une heure : directement dans la Sheet ».
   - « Accès bloqué » : par adresse IP ; débloquer sans attendre :
     `npx wrangler d1 execute kilosaurus-temps --remote --command "DELETE FROM lockouts"`.
   - Sauvegarde : D1 restaure la base à n'importe quelle minute des 7 derniers jours
     (`npx wrangler d1 time-travel restore kilosaurus-temps --timestamp <date ISO>`).
5. **APK et widget** : texte actuel ; l'adresse de l'API est `Api.DEFAULT_URL` (une seule source,
   recopiée dans l'app par `build.sh`) ; le widget se recale sur l'heure du serveur ; message
   d'oubli au-delà du seuil ; un widget réglé avant la v2 prend la nouvelle adresse tout seul.
6. **Mini-fenêtre** : texte actuel, plus le bouton « Sessions ».
7. **Ajouter un projet** : depuis l'app seulement (menu → + Nouveau projet).
8. **Agent Claude Code** : texte actuel, `KILOSAURUS_TEMPS_URL` = `…/api`, secret
   `CODE_AMOHS_CLAUDE` posé avec `wrangler secret put`.
9. **Mettre à jour** : `npm run deploy` publie l'API et l'app ensemble ; l'APK embarque sa copie
   (reconstruire et réinstaller).
10. **Développement** : `npm test`, `py -m unittest discover -s tests -p "test_*.py"`,
    `npm run dev` (`http://localhost:8787/?dev-code=code-amohs`, `--forgot`, `/__phone`,
    `?vue=sessions`), `node tools/e2e.js`. « Toute la logique métier est dans `server/core.js` ; elle
    ne parle qu'à une interface SQL que fournissent D1 et `node:sqlite` : les tests tournent sur les
    mêmes requêtes que la production. »

Retirer toute mention de Google Sheet, Apps Script, `clasp`, GitHub Pages, `runSelfTest`,
`unlockApi`, `_Config`, `_Corrections`, `_Modèle` — sauf dans l'étape 7 de la mise en place (reprise).

- [ ] **Étape 3 : script de test Python**

Dans `package.json`, ajouter au bloc `scripts` : `"test:py": "py -m unittest discover -s tests -p \"test_*.py\""`.

- [ ] **Étape 4 : relire et commit**

Relire le README d'un bout à l'autre comme quelqu'un qui découvre le projet : chaque commande existe
dans le dépôt, aucune étape ne renvoie à l'ancienne architecture.

```bash
git add claude/kilosaurus-temps/SKILL.md README.md package.json
git commit -m "docs : README et skill d'agent pour la v2 (Cloudflare, annuler, sessions)"
```

---

### Tâche 11 : Mise en ligne et bascule

Tâche en binôme : l'agent lance les commandes, l'utilisateur fait les quatre gestes marqués
**[utilisateur]**. Ne pas commencer avant que les tâches 1 à 10 soient faites et que `npm test`,
`npm run test:py` et `node tools/e2e.js` soient verts.

**Fichiers :**
- Modifier : `wrangler.toml` (`database_id`), `android/src/com/kilosaurus/temps/Api.java`
  (`DEFAULT_URL`), `desktop/main.js` (`SITE`)

- [ ] **Étape 1 : connexion** — Lancer `npx wrangler login`. **[utilisateur]** cliquer sur
  « Allow » dans le navigateur. Vérifier : `npx wrangler whoami` affiche le compte.

- [ ] **Étape 2 : base** — `npx wrangler d1 create kilosaurus-temps --location weur`. Copier
  l'identifiant affiché dans `wrangler.toml` (`database_id`). Puis `npm run db:schema`. Attendu :
  `Executed … commands`.

- [ ] **Étape 3 : codes** — Pour chaque nom de code de l'Apps Script (`CODE_AMOHS_TELEPHONE`,
  `CODE_AMOHS_PC`, `CODE_AMOHS_CLAUDE`, et tout autre `CODE_…`), lancer
  `npx wrangler secret put <NOM>`. **[utilisateur]** coller la valeur, copiée depuis l'éditeur
  Apps Script (⚙ Paramètres du projet → Propriétés du script). Si wrangler propose de créer le
  Worker, accepter. Vérifier : `npx wrangler secret list` liste les noms.

- [ ] **Étape 4 : déploiement** — `npm run deploy`. Noter l'adresse affichée
  (`https://kilosaurus-temps.<sous-domaine>.workers.dev`). Vérifier :
  `curl -s https://<adresse>/api` → `{"ok":true,"data":{"service":"kilosaurus-temps"}}`.

- [ ] **Étape 5 : reprise** — **[utilisateur]** arrêter le compteur, télécharger la Sheet fraîche
  (`export.xlsx` à la racine). Lancer `py tools/migrate_d1.py export.xlsx reprise.sql` ; montrer
  la liste « à vérifier » et les refus. **[utilisateur]** dire quelles lignes écarter (la session de
  14 h). Relancer avec `--exclude …` jusqu'à `OK`. Puis `node tools/check_import.mjs reprise.sql`,
  `npx wrangler d1 execute kilosaurus-temps --remote --file reprise.sql`, et la commande de
  relecture du nombre de lignes affichée par `check_import` : le nombre doit correspondre.

- [ ] **Étape 6 : essai réel** — Ouvrir `https://<adresse>/` dans le navigateur avec le code PC :
  l'historique d'hier apparaît dans « Sessions » ; lancer, annuler, relancer, arrêter. Le détail
  du point de synchro affiche des réponses en centaines de ms.

- [ ] **Étape 7 : clients**
  - `desktop/main.js` : `SITE = 'https://<adresse>/'` ; relancer la mini-fenêtre (« Recharger »
    ou relancer l'app) et saisir le code PC si demandé.
  - `Api.java` : `DEFAULT_URL = "https://<adresse>/api"` ;
    `VERSION_CODE=10 VERSION_NAME=2.0 bash android/build.sh`. **[utilisateur]** installer l'APK
    par-dessus l'ancienne version (même clé de signature : les réglages restent).
  - Agent : `KILOSAURUS_TEMPS_URL=https://<adresse>/api` (variable d'environnement de la machine)
    et recopier `claude/kilosaurus-temps/` dans `~/.claude/skills/`.

- [ ] **Étape 8 : vérifications sur le téléphone** (points de vigilance 3 et 4)
  1. Sans rien régler, le widget lance et arrête : l'ancienne adresse a été remplacée.
  2. Taper ▶ ■ ▶ ■ vite : l'affichage ne saute pas ; l'app montre le même état ensuite.
  3. Lancer, redémarrer le téléphone : le chrono est juste au retour.
  4. Régler l'heure à 23:58 (heure automatique coupée), attendre minuit : « Aujourd'hui » repart de
     zéro à quelques minutes près. Remettre l'heure automatique.
  5. Mode avion : taper ▶, réactiver le réseau : la session apparaît dans l'app avec l'heure du tap.
  6. Lancer depuis le PC : le widget le montre à l'ouverture de l'app.

- [ ] **Étape 9 : couper l'ancien** — **[utilisateur]** dans l'éditeur Apps Script :
  Déployer → Gérer les déploiements → archiver le déploiement. La Sheet reste comme archive.
  Dans GitHub : Settings → Pages → désactiver la publication.

- [ ] **Étape 10 : commit**

```bash
git add wrangler.toml android/src/com/kilosaurus/temps/Api.java desktop/main.js
git commit -m "chore : bascule sur Cloudflare (adresse du Worker, base D1)"
```

---

### Tâche 12 : Nettoyage après la bascule

**Fichiers :**
- Supprimer : `apps-script/`, `tests/core.test.js`, `tests/selftest.test.js`, `tests/harness.js`,
  `tools/migrate.py`, `.github/workflows/pages.yml`
- Modifier : `.gitignore`, `docs/specs/2026-10-01-kilosaurus-temps-design.md`

- [ ] **Étape 1 : vérifier qu'il ne reste aucun lecteur**

Lancer : `grep -rn "harness\.js\|apps-script\|Core\.gs\|fake-api\|migrate\.py\|clasp" --exclude-dir=node_modules --exclude-dir=.git .`
Attendu : seulement des mentions dans `docs/` (historique des specs et plans). Corriger toute autre.

- [ ] **Étape 2 : supprimer**

```bash
git rm -r apps-script tests/core.test.js tests/selftest.test.js tests/harness.js tools/migrate.py .github/workflows/pages.yml
rm -f .clasp.json
```

Dans `.gitignore`, supprimer le bloc `# Lien local vers le script Apps Script déployé (clasp).` et
sa ligne `.clasp.json`, et remplacer le commentaire de tête
`# Données réelles (heures, emails) : jamais dans le dépôt, qui est public pour GitHub Pages.` par
`# Données réelles (heures, emails) : jamais dans le dépôt.`

En tête de `docs/specs/2026-10-01-kilosaurus-temps-design.md`, ajouter :

```markdown
> **Remplacée pour le stockage et l'API** par `2026-10-03-base-de-donnees-design.md` (Cloudflare
> Workers + D1). Les sections sur la Sheet, l'Apps Script et GitHub Pages ne décrivent plus le code.
```

- [ ] **Étape 3 : lancer tous les tests**

Lancer : `npm test && npm run test:py && node tools/e2e.js`
Attendu : tout vert.

- [ ] **Étape 4 : commit**

```bash
git add -A .gitignore docs/specs/2026-10-01-kilosaurus-temps-design.md
git commit -m "chore : retrait de l'Apps Script, de GitHub Pages et des outils de la v1"
```

Le dépôt peut ensuite redevenir privé (GitHub : Settings → General → Change visibility) : plus rien
ne dépend de GitHub Pages. C'est un choix de l'utilisateur, à lui proposer.
