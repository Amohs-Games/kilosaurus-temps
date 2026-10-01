# Types de travail, total du jour et récaps — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chaque ligne porte un type de travail (Autre, Dev, Art, Narration) ; l'app et le widget basculent de type en un tap ; l'écran montre le total du jour, une frise colorée et un récap semaine / mois ; le logo Kilosaurus devient l'icône partout.

**Architecture:** le type est une colonne de plus (L) dans chaque onglet de projet ; une bascule de type est une bascule ordinaire (fermer + ouvrir à la même seconde). Le serveur (`Core.gs`) ajoute `type` aux lignes, `types` et `today` à `status`, et une action `history` en lecture. Tous les calculs d'affichage (total, frise, récaps) sont des fonctions pures de `web/logic.js`, testées dans Node.

**Tech Stack:** Apps Script (V8), JavaScript vanilla sans build, tests `node --test`, Android sans Gradle (`android/build.sh`), Python + Pillow pour les icônes, clasp (`npx -y @google/clasp`) pour publier le script.

**Spec:** `docs/specs/2026-10-01-types-de-travail-design.md` (à lire avant toute tâche), en complément de `docs/specs/2026-10-01-kilosaurus-temps-design.md`.

## Global Constraints

- Types, dans cet ordre : `Autre`, `Dev`, `Art`, `Narration`. Défaut : `Autre`. Une cellule Type vide vaut `Autre`.
- Couleurs : Autre `#9B20F9`, Dev `#3B82F6`, Art `#EC4899`, Narration `#22C55E`.
- Colonne L des onglets de projet : en-tête `Type`.
- `start` : même projet **et** même type que le compteur en cours → ne fait rien ; `type` absent → type du compteur en cours, sinon Autre.
- `history { from, to }` : jours `aaaa-mm-jj` inclus, 62 jours au plus, lecture seule.
- Récaps semaine et mois : une session compte pour le jour de son début. Total et frise du jour : découpés à minuit.
- Frise : de min(8 h, début de la première session du jour) à maintenant.
- Réglage « Afficher Studio » : par appareil, décoché par défaut.
- Fuseau Europe/Paris partout. Front sans framework ni build. Commentaires en français, comme le reste du code.
- Les fichiers `.xlsx`, `.apk`, la clé Android et `.clasp.json` ne sont jamais commités.

## Review Focus

1. Un onglet de projet importé avec moins de 12 colonnes : lire et écrire la colonne L ne doit pas planter (la colonne est créée). → test dans la tâche 3.
2. Une session commencée hier soir et toujours en cours : le total et la frise du jour ne comptent que la partie d'aujourd'hui. → test dans la tâche 4.
3. Un état mis en cache par la version 1.0 (sans `types`, `today`, ni `type`) : l'app s'affiche sans erreur, total à 0. → test dans la tâche 4.
4. Le widget de la v1 ou l'agent envoient `start` sans type pendant qu'un compteur Dev tourne : le type Dev est gardé. → test dans la tâche 1.
5. La semaine du passage à l'heure d'hiver (dimanche 25 octobre 2026) : la semaine fait bien 7 jours, du lundi 19 au dimanche 25. → test dans la tâche 4.

---

### Task 1: Serveur — le type sur les lignes et sur `start`, `logBlock`, `logSession`

**Files:**
- Modify: `apps-script/Core.gs`
- Test: `tests/core.test.js`

**Interfaces:**
- Produces: `Core.TYPES` (tableau `[{ name, color }]`) ; chaque ligne d'API (`running`, `last`, lignes de `today` et `history`) a un champ `type` (texte, jamais vide) ; les lignes écrites ont `type` dans le store.

- [ ] **Step 1: Écrire les tests qui échouent** — ajouter à la fin de `tests/core.test.js` :

```js
test('type : Autre par défaut, enregistré sur la ligne', () => {
  const { call, store } = makeEnv();
  const s = ok(call('code-amohs', 'start', { id: 't1', project: 'Fluffy' }));
  assert.equal(s.running.type, 'Autre');
  assert.equal(rows(store, 'Fluffy')[0].type, 'Autre');
});

test('type : bascule de type sur le même projet, sans trou', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 't1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  const s = ok(call('code-amohs', 'start', { id: 't2', project: 'Fluffy', type: 'Art' }));
  const [a, b] = rows(store, 'Fluffy');
  assert.equal(a.type, 'Dev');
  assert.equal(a.end.getTime(), b.start.getTime());
  assert.equal(a.hours, 0.5);
  assert.equal(s.running.type, 'Art');
  assert.equal(s.last.type, 'Dev');
});

test('type : même projet et même type → rien', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 't1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(10);
  const s = ok(call('code-amohs', 'start', { id: 't2', project: 'Fluffy', type: 'Dev' }));
  assert.equal(s.running.id, 't1');
  assert.equal(rows(store, 'Fluffy').length, 1);
});

test('type : start sans type garde le type du compteur en cours', () => {
  const { call, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 't1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(10);
  const s = ok(call('code-amohs', 'start', { id: 't2', project: 'Studio' }));
  assert.equal(s.running.type, 'Dev');
  assert.equal(s.running.project, 'Studio');
});

test('type : inconnu → invalid ; blocs et sessions d\'agent typés', () => {
  const { call, store } = makeEnv();
  fails(call('code-amohs', 'start', { id: 't1', project: 'Fluffy', type: 'Musique' }), 'invalid');
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 2, type: 'Narration' }));
  assert.equal(rows(store, 'Fluffy')[0].type, 'Narration');
  ok(call('code-alex-claude', 'logSession', {
    id: 's1', project: 'Fluffy', start: '2026-10-01T06:00:00+02:00', end: '2026-10-01T07:00:00+02:00',
  }));
  assert.equal(rows(store, 'Fluffy')[1].type, 'Autre');
});

test('type : une ligne sans type (historique) vaut Autre', () => {
  const { call, store } = makeEnv();
  store.insert('Fluffy', {
    id: 'old', person: 'Amohs', date: new Date('2026-09-30T00:00:00+02:00'), start: '', end: '', hours: 4,
    note: '', source: 'app', created: new Date('2026-09-30T10:00:00+02:00'), corrected: '', touched: new Date('2026-09-30T10:00:00+02:00'),
  });
  assert.equal(ok(call('code-amohs', 'status')).last.type, 'Autre');
});
```

- [ ] **Step 2: Lancer les tests, vérifier l'échec**

Run: `npm test`
Expected: FAIL sur les 6 nouveaux tests (`type` vaut `undefined`, `Musique` accepté).

- [ ] **Step 3: Implémenter dans `apps-script/Core.gs`**

Sous `var WRITE_ACTIONS = …` :

```js
  // Types de travail, dans l'ordre d'affichage. Une ligne sans type (historique) vaut Autre.
  var TYPES = [
    { name: 'Autre', color: '#9B20F9' },
    { name: 'Dev', color: '#3B82F6' },
    { name: 'Art', color: '#EC4899' },
    { name: 'Narration', color: '#22C55E' },
  ];
  var TYPE_NAMES = TYPES.map(function (t) { return t.name; });
  var DEFAULT_TYPE = 'Autre';
```

Après `myRunning` :

```js
  function typeOf(row) {
    return TYPE_NAMES.indexOf(row.type) >= 0 ? row.type : DEFAULT_TYPE;
  }
```

Dans `toApi`, ajouter après `project: row.project,` :

```js
      type: typeOf(row),
```

Après `requireBlockHours` :

```js
  function requireType(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (TYPE_NAMES.indexOf(value) < 0) fail('Type inconnu : ' + value + '. Types : ' + TYPE_NAMES.join(', ') + '.');
    return value;
  }
```

Dans `newRow`, ajouter après `note: fields.note || '',` :

```js
      type: fields.type || DEFAULT_TYPE,
```

Remplacer l'action `start` par :

```js
    start: function (ctx, p) {
      var id = requireId(p);
      var project = requireProject(ctx, p.project);
      var offset = p.offsetMinutes === undefined ? 0 : Number(p.offsetMinutes);
      if (OFFSETS.indexOf(offset) < 0) fail('Décalage autorisé : 0, 15, 30 ou 60 minutes.');
      var note = cleanNote(p.note);
      var running = myRunning(ctx);
      var type = requireType(p.type, running ? typeOf(running) : DEFAULT_TYPE);
      if (findById(ctx, id)) return;
      // Relancer ce qui tourne déjà n'est pas une action.
      if (running && running.project === project && typeOf(running) === type) return;

      var start = new Date(actionTime(ctx).getTime() - offset * 60000);
      if (running) {
        if (start < running.start) start = running.start;
        close(ctx, running, start);
      }
      ctx.store.insert(project, newRow(ctx, { id: id, date: sessionDate(ctx, start), start: start, note: note, type: type }));
    },
```

Dans `logBlock`, après `var note = cleanNote(p.note);` ajouter `var type = requireType(p.type, DEFAULT_TYPE);` et passer `type: type` dans `newRow(ctx, { id: id, date: …, hours: hours, note: note, type: type })`.

Dans `logSession`, même ajout : `var type = requireType(p.type, DEFAULT_TYPE);` après `cleanNote`, et `type: type` dans l'objet passé à `newRow`.

Exposer la liste : le `return` final du module devient `return { handleRequest: handleRequest, isWrite: isWrite, BLOCK_HOURS: BLOCK_HOURS, TYPES: TYPES };`.

- [ ] **Step 4: Lancer les tests**

Run: `npm test`
Expected: PASS, tous les tests (les anciens compris).

- [ ] **Step 5: Commit**

```bash
git add apps-script/Core.gs tests/core.test.js
git commit -m "feat(api) : type de travail sur les lignes et bascule de type"
```

---

### Task 2: Serveur — `status.types`, `status.today` et l'action `history`

**Files:**
- Modify: `apps-script/Core.gs`
- Test: `tests/core.test.js`

**Interfaces:**
- Consumes: `typeOf`, `toApi`, `TYPES` (tâche 1).
- Produces: `status.types` = `[{ name, color }]` ; `status.today` = tableau de lignes d'API (format de `running`) ; action `history` → `data = { from, to, rows }` (lignes d'API, triées par date puis début).

- [ ] **Step 1: Écrire les tests qui échouent**

```js
test('status.types et status.today', () => {
  const { call, clock } = makeEnv({ clock: makeClock('2026-10-01T09:00:00+02:00') });
  ok(call('code-amohs', 'logBlock', { id: 'y', project: 'Fluffy', hours: 2, date: '2026-09-30' }));
  ok(call('code-amohs', 'start', { id: 'a', project: 'Fluffy', type: 'Dev' }));
  clock.advance(60);
  const s = ok(call('code-amohs', 'start', { id: 'b', project: 'Fluffy', type: 'Art' }));
  assert.deepEqual(s.types.map((t) => t.name), ['Autre', 'Dev', 'Art', 'Narration']);
  assert.deepEqual(s.today.map((r) => r.id), ['a', 'b']);
  assert.equal(s.today[1].end, null);
});

test('status.today : une session d\'hier encore en cours en fait partie', () => {
  const { call, clock } = makeEnv({ clock: makeClock('2026-09-30T22:00:00+02:00') });
  ok(call('code-amohs', 'start', { id: 'n', project: 'Fluffy' }));
  clock.set('2026-10-01T01:00:00+02:00');
  const s = ok(call('code-amohs', 'status'));
  assert.deepEqual(s.today.map((r) => r.id), ['n']);
});

test('history : lignes de la période, bornes incluses', () => {
  const { call } = makeEnv({ clock: makeClock('2026-10-01T09:00:00+02:00') });
  ok(call('code-amohs', 'logBlock', { id: 'd28', project: 'Fluffy', hours: 2, date: '2026-09-28' }));
  ok(call('code-amohs', 'logBlock', { id: 'd29', project: 'Fluffy', hours: 4, date: '2026-09-29', type: 'Dev' }));
  ok(call('code-amohs', 'logBlock', { id: 'd30', project: 'Studio', hours: 6, date: '2026-09-30' }));
  ok(call('code-alex', 'logBlock', { id: 'x', project: 'Fluffy', hours: 2, date: '2026-09-29' }));
  const h = ok(call('code-amohs', 'history', { from: '2026-09-29', to: '2026-09-30' }));
  assert.deepEqual(h.rows.map((r) => r.id), ['d29', 'd30']);
  assert.equal(h.rows[0].type, 'Dev');
  assert.equal(h.from, '2026-09-29');
});

test('history : dates invalides ou plus de 62 jours → invalid', () => {
  const { call } = makeEnv();
  fails(call('code-amohs', 'history', { from: '2026-10-01', to: '2026-09-01' }), 'invalid');
  fails(call('code-amohs', 'history', { from: '2026-01-01', to: '2026-03-15' }), 'invalid');
  fails(call('code-amohs', 'history', { from: 'hier', to: '2026-10-01' }), 'invalid');
  ok(call('code-amohs', 'history', { from: '2026-08-01', to: '2026-10-01' }));
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npm test`
Expected: FAIL (`types` et `today` absents, action `history` inconnue).

- [ ] **Step 3: Implémenter**

Ajouter `var MAX_HISTORY_DAYS = 62;` sous `MAX_SESSION_MS`.

Après `myLast` :

```js
  // Début du jour suivant, sûr aux changements d'heure (jour de 23 ou 25 h).
  function nextDayStart(ctx, dayStart) {
    return ctx.tz.dayStart(ctx.tz.dayKey(new Date(dayStart.getTime() + 36 * 3600000)));
  }

  function byDateThenStart(a, b) {
    var da = isDate(a.date) ? a.date.getTime() : 0;
    var db = isDate(b.date) ? b.date.getTime() : 0;
    if (da !== db) return da - db;
    var sa = isDate(a.start) ? a.start.getTime() : Infinity;
    var sb = isDate(b.start) ? b.start.getTime() : Infinity;
    return sa - sb;
  }

  // Mes lignes qui touchent aujourd'hui : sessions qui chevauchent la journée (en cours comprises),
  // blocs datés d'aujourd'hui.
  function myToday(ctx) {
    var key = ctx.tz.dayKey(ctx.now);
    var from = ctx.tz.dayStart(key);
    var to = nextDayStart(ctx, from);
    return myRows(ctx).filter(function (r) {
      if (isDate(r.start)) return r.start < to && (isDate(r.end) ? r.end : ctx.now) > from;
      return isDate(r.date) && ctx.tz.dayKey(r.date) === key;
    }).sort(byDateThenStart);
  }
```

Dans `status`, ajouter :

```js
      types: TYPES,
      today: myToday(ctx).map(function (r) { return toApi(ctx, r); }),
```

Ajouter l'action (après `addProject`) ; elle **renvoie** sa réponse au lieu de l'état :

```js
    history: function (ctx, p) {
      if (typeof p.from !== 'string' || !DAY_KEY.test(p.from) || typeof p.to !== 'string' || !DAY_KEY.test(p.to)) {
        fail('Période attendue : from et to au format aaaa-mm-jj.');
      }
      if (p.from > p.to) fail('La période commence après sa fin.');
      var days = Math.round((ctx.tz.dayStart(p.to) - ctx.tz.dayStart(p.from)) / 86400000) + 1;
      if (days > MAX_HISTORY_DAYS) fail('Période de ' + MAX_HISTORY_DAYS + ' jours au plus.');
      var rows = myRows(ctx).filter(function (r) {
        if (!isDate(r.date)) return false;
        var key = ctx.tz.dayKey(r.date);
        return key >= p.from && key <= p.to;
      }).sort(byDateThenStart);
      return { from: p.from, to: p.to, rows: rows.map(function (r) { return toApi(ctx, r); }) };
    },
```

Dans `handleRequest`, remplacer `action(ctx, body); return { ok: true, data: status(ctx) };` par :

```js
      var data = action(ctx, body);
      return { ok: true, data: data === undefined ? status(ctx) : data };
```

`history` n'est pas dans `WRITE_ACTIONS` : pas de verrou. Les autres actions ne renvoient rien : leur réponse reste l'état.

- [ ] **Step 4: Lancer les tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps-script/Core.gs tests/core.test.js
git commit -m "feat(api) : total du jour (status.today), liste des types, action history"
```

---

### Task 3: Sheet — colonne Type sur la vraie Sheet, et le test Apps Script

**Files:**
- Modify: `apps-script/Sheet.gs`, `apps-script/Test.gs`
- Test: `tests/selftest.test.js`

**Interfaces:**
- Consumes: le type sur les lignes (tâche 1).
- Produces: `ensureTypeHeader(sheet)` et `ensureTypeHeaders(ss)` dans `Sheet.gs` ; `COLUMNS` a 12 entrées, la dernière `'type'`.

- [ ] **Step 1: Écrire les tests qui échouent** — dans `tests/selftest.test.js`, ajouter :

```js
// Feuille Google minimale en mémoire : assez pour SheetStore (lecture, écriture, colonnes).
function fakeSheet(name, header, maxColumns) {
  const cells = [header.slice()];
  let maxCols = maxColumns;
  const range = (r, c, nr, nc) => ({
    getValues: () => {
      if (c + nc - 1 > maxCols) throw new Error('Plage hors de la feuille');
      return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (cells[r - 1 + i] || [])[c - 1 + j] ?? ''));
    },
    getValue: () => { if (c > maxCols) throw new Error('Plage hors de la feuille'); return (cells[r - 1] || [])[c - 1] ?? ''; },
    setValues: (v) => {
      if (c + nc - 1 > maxCols) throw new Error('Plage hors de la feuille');
      v.forEach((row, i) => { cells[r - 1 + i] = cells[r - 1 + i] || []; row.forEach((x, j) => { cells[r - 1 + i][c - 1 + j] = x; }); });
    },
    setValue: (x) => { if (c > maxCols) throw new Error('Plage hors de la feuille'); cells[r - 1] = cells[r - 1] || []; cells[r - 1][c - 1] = x; },
    copyTo: () => {},
  });
  return {
    cells,
    getName: () => name,
    getLastRow: () => cells.length,
    getMaxColumns: () => maxCols,
    insertColumnsAfter: (after, n) => { maxCols += n; },
    getRange: (r, c, nr = 1, nc = 1) => range(r, c, nr, nc),
  };
}

test('SheetStore : un onglet à 11 colonnes reçoit la colonne Type sans planter', () => {
  const g = loadAllGs();
  const header = ['ID', 'Personne', 'Date', 'Début', 'Fin', 'Heures', 'Note', 'Source', 'Saisi le', 'Corrigé', 'Modifié le'];
  const fluffy = fakeSheet('Fluffy', header, 11);
  fluffy.cells.push(['old', 'Amohs', new Date('2026-09-30'), '', '', 4, '', 'report', '', '', '']);
  const ss = { getSheets: () => [fluffy], getSheetByName: (n) => (n === 'Fluffy' ? fluffy : null) };
  const store = new g.SheetStore(ss);
  assert.equal(store.allRows()[0].type, '');
  store.insert('Fluffy', { id: 'n1', person: 'Amohs', date: new Date(), start: '', end: '', hours: 2, note: '',
    type: 'Dev', source: 'app', created: new Date(), corrected: '', touched: new Date() });
  assert.equal(fluffy.getMaxColumns(), 12);
  assert.equal(fluffy.cells[0][11], 'Type');
  assert.equal(fluffy.cells[2][11], 'Dev');
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npm test`
Expected: FAIL (`type` absent de `COLUMNS`, puis plage hors de la feuille).

- [ ] **Step 3: Implémenter `apps-script/Sheet.gs`**

```js
var COLUMNS = ['id', 'person', 'date', 'start', 'end', 'hours', 'note', 'source', 'created', 'corrected', 'touched', 'type'];
var TYPE_HEADER = 'Type';
```

Ajouter après `SheetStore` :

```js
// La colonne Type (L) a été ajoutée après la v1 : un onglet plus ancien la reçoit à sa première
// écriture, en-tête compris. Un onglet importé peut avoir moins de 12 colonnes : on les crée.
function ensureTypeHeader(sheet) {
  var max = sheet.getMaxColumns();
  if (max < COLUMNS.length) sheet.insertColumnsAfter(max, COLUMNS.length - max);
  var cell = sheet.getRange(1, COLUMNS.length);
  if (cell.getValue() !== '') return;
  sheet.getRange(1, COLUMNS.length - 1).copyTo(cell, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  cell.setValue(TYPE_HEADER);
}

// Pose la colonne Type sur tous les onglets de projet et sur _Modèle.
function ensureTypeHeaders(ss) {
  ss.getSheets().forEach(function (s) {
    var name = s.getName();
    if (name.charAt(0) !== '_' || name === TEMPLATE_SHEET) ensureTypeHeader(s);
  });
}
```

Dans le test Node, `SpreadsheetApp` n'existe pas : le `copyTo` du faux onglet ignore ses arguments, mais `SpreadsheetApp.CopyPasteType` doit exister. Dans le test ajouté au Step 1, avant `new g.SheetStore(ss)`, ajouter `g.SpreadsheetApp = { CopyPasteType: { PASTE_FORMAT: 'format' } };`.

Dans `allRows`, lire seulement les colonnes qui existent :

```js
    var width = Math.min(COLUMNS.length, sheet.getMaxColumns());
    var values = sheet.getRange(2, 1, last - 1, width).getValues();
    values.forEach(function (v, i) {
      if (v[0] === '' && v[1] === '') return;
      var row = { project: project, ref: { project: project, row: i + 2 } };
      COLUMNS.forEach(function (key, c) { row[key] = c < width ? v[c] : ''; });
      out.push(row);
    });
```

Dans `insert`, avant `firstFreeRow` : `ensureTypeHeader(sheet);`. Dans `update`, avant la boucle : `if (patch.type !== undefined) ensureTypeHeader(sheet);`. Dans `createProject`, après `setName(name)` : `ensureTypeHeader(copy);`.

- [ ] **Step 4: Adapter `apps-script/Test.gs`**

Dans `runSelfTest`, avant `var before = snapshot(ss);` :

```js
  // La colonne Type est posée avant la photo : sinon le test la verrait apparaître et crierait au changement.
  ensureTypeHeaders(ss);
  SpreadsheetApp.flush();
```

Dans `selfTestScenario`, après `ok(t.call('human', 'stop'), 'Arrêt final');`, ajouter :

```js
  s = ok(t.call('human', 'start', { id: 'st-7', project: t.projB, type: 'Dev' }), 'Lancement typé');
  check(s && s.running && s.running.type === 'Dev', 'Le compteur tourne en Dev');
  t.advance(20);
  s = ok(t.call('human', 'start', { id: 'st-8', project: t.projB, type: 'Art' }), 'Bascule de type');
  check(s && s.last && s.last.id === 'st-7' && s.last.type === 'Dev' && s.last.hours === 0.33, 'Dev fermé à 0,33 h par la bascule de type');
  s = ok(t.call('human', 'start', { id: 'st-9', project: t.projB, type: 'Art' }), 'Relance du même type');
  check(s && s.running && s.running.id === 'st-8', 'Relancer le même projet et le même type ne fait rien');
  refused(t.call('human', 'start', { id: 'st-w', project: t.projB, type: 'Musique' }), 'Type inconnu');
  ok(t.call('human', 'stop'), 'Arrêt après bascule de type');
```

Remplacer `check(t.rowCount(t.projB) === 3, …)` par `check(t.rowCount(t.projB) === 5, 'B contient 5 lignes (' + t.rowCount(t.projB) + ')');`.

- [ ] **Step 5: Lancer les tests**

Run: `npm test`
Expected: PASS (dont « le parcours de runSelfTest passe sur un store en mémoire »).

- [ ] **Step 6: Commit**

```bash
git add apps-script/Sheet.gs apps-script/Test.gs tests/selftest.test.js
git commit -m "feat(sheet) : colonne Type posée automatiquement, test Apps Script étendu"
```

---

### Task 4: Calculs de l'app — type optimiste, total du jour, frise, récaps

**Files:**
- Modify: `web/logic.js`
- Test: `tests/logic.test.js`

**Interfaces:**
- Consumes: les champs `type`, `types`, `today` de l'API (tâches 1-2).
- Produces (dans `KTLogic`) :
  - `DEFAULT_TYPES` : `[{ name, color }]` (copie de la liste serveur, en secours).
  - `typesOf(status)` → `[{ name, color }]` ; `typeOf(row)` → nom ; `typeColor(status, name)` → couleur.
  - `visibleProjects(status, showStudio)` → `{ shown, more }` (le studio n'y figure que si `showStudio`).
  - `pickableProjects(status, showStudio)` → tableau de noms.
  - `applyLocal(status, item)` : gère `params.type` et tient `status.today` à jour.
  - `rowHours(row, nowMs)` → heures (session en cours : jusqu'à maintenant).
  - `todayTotal(rows, nowMs)` → heures du jour, sessions découpées à minuit.
  - `dayTimeline(rows, nowMs)` → `{ from, to, segments: [{ start, end, type }] }` (millisecondes).
  - `weekRange(date)` → `{ from, to, days }` (clés `aaaa-mm-jj`, lundi → dimanche, `days` = 7 clés).
  - `monthRange(date)` → `{ from, to, days }`.
  - `aggregate(rows, days, nowMs)` → `{ total, byDay: { key: { total, byType } }, byType, byProject }`.

- [ ] **Step 1: Écrire les tests qui échouent** — dans `tests/logic.test.js`, ajouter :

```js
const at = (iso) => new Date(iso).getTime();
const sess = (id, type, start, end, project = 'Fluffy') => ({
  id, project, type, date: L.dayKey(start), start: new Date(start).toISOString(),
  end: end ? new Date(end).toISOString() : null, hours: end ? L.hoursBetween(start, end) : null,
});

test('studio masqué sauf réglage', () => {
  const s = Object.assign(base(), { projects: ['Fluffy', 'Heirfall', 'Studio'] });
  assert.deepEqual(L.visibleProjects(s, false).shown, ['Fluffy', 'Heirfall']);
  assert.deepEqual(L.visibleProjects(s, true).shown, ['Fluffy', 'Heirfall', 'Studio']);
  assert.deepEqual(L.pickableProjects(s, false), ['Fluffy', 'Heirfall']);
});

test('optimiste : bascule de type, même type sans effet, today tenu à jour', () => {
  let s = L.applyLocal(base(), { action: 'start', params: { id: 'a', project: 'Fluffy', type: 'Dev' }, clientTime: '2026-10-01T09:00:00+02:00' });
  s = L.applyLocal(s, { action: 'start', params: { id: 'b', project: 'Fluffy', type: 'Dev' }, clientTime: '2026-10-01T09:10:00+02:00' });
  assert.equal(s.running.id, 'a');
  s = L.applyLocal(s, { action: 'start', params: { id: 'c', project: 'Fluffy', type: 'Art' }, clientTime: '2026-10-01T09:30:00+02:00' });
  assert.equal(s.running.type, 'Art');
  assert.equal(s.last.type, 'Dev');
  assert.deepEqual(s.today.map((r) => r.id), ['a', 'c']);
  assert.equal(s.today[0].end, new Date('2026-10-01T09:30:00+02:00').toISOString());
  s = L.applyLocal(s, { action: 'start', params: { id: 'd', project: 'Heirfall' }, clientTime: '2026-10-01T10:00:00+02:00' });
  assert.equal(s.running.type, 'Art');
});

test('total du jour : la session d\'hier soir ne compte que pour aujourd\'hui', () => {
  const now = at('2026-10-01T10:00:00+02:00');
  const rows = [
    sess('n', 'Dev', '2026-09-30T23:00:00+02:00', '2026-10-01T01:00:00+02:00'),
    sess('m', 'Art', '2026-10-01T08:00:00+02:00', null),
    { id: 'b', project: 'Fluffy', type: 'Autre', date: '2026-10-01', start: null, end: null, hours: 2 },
    { id: 'old', project: 'Fluffy', type: 'Autre', date: '2026-09-30', start: null, end: null, hours: 4 },
  ];
  assert.equal(L.todayTotal(rows, now), 1 + 2 + 2);
});

test('frise : de 8 h (ou plus tôt) à maintenant, segments découpés à minuit', () => {
  const now = at('2026-10-01T10:00:00+02:00');
  const t = L.dayTimeline([sess('n', 'Dev', '2026-09-30T23:00:00+02:00', '2026-10-01T01:00:00+02:00')], now);
  assert.equal(t.from, at('2026-10-01T00:00:00+02:00'));
  assert.equal(t.to, now);
  assert.deepEqual(t.segments, [{ start: at('2026-10-01T00:00:00+02:00'), end: at('2026-10-01T01:00:00+02:00'), type: 'Dev' }]);
  const t2 = L.dayTimeline([sess('m', 'Art', '2026-10-01T09:00:00+02:00', null)], now);
  assert.equal(t2.from, at('2026-10-01T08:00:00+02:00'));
  assert.equal(t2.segments[0].end, now);
});

test('ancien état en cache (v1.0) : rien ne casse', () => {
  const old = base();
  assert.equal(L.todayTotal(old.today, Date.now()), 0);
  assert.deepEqual(L.typesOf(old).map((t) => t.name), ['Autre', 'Dev', 'Art', 'Narration']);
  assert.equal(L.typeOf({ project: 'Fluffy' }), 'Autre');
  const s = L.applyLocal(old, { action: 'start', params: { id: 'a', project: 'Fluffy' }, clientTime: '2026-10-01T09:00:00+02:00' });
  assert.equal(s.running.type, 'Autre');
});

test('semaine : lundi → dimanche, 7 jours même au passage à l\'heure d\'hiver', () => {
  const w = L.weekRange(new Date('2026-10-25T12:00:00+01:00'));
  assert.equal(w.from, '2026-10-19');
  assert.equal(w.to, '2026-10-25');
  assert.deepEqual(w.days, ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  const m = L.monthRange(new Date('2026-02-10T12:00:00+01:00'));
  assert.equal(m.from, '2026-02-01');
  assert.equal(m.to, '2026-02-28');
  assert.equal(m.days.length, 28);
});

test('agrégats : par jour, par type, par projet', () => {
  const now = at('2026-10-01T12:00:00+02:00');
  const rows = [
    sess('a', 'Dev', '2026-09-29T09:00:00+02:00', '2026-09-29T12:00:00+02:00', 'Fluffy'),
    sess('b', 'Art', '2026-09-30T09:00:00+02:00', '2026-09-30T10:00:00+02:00', 'Heirfall'),
    { id: 'c', project: 'Heirfall', type: 'Autre', date: '2026-09-30', start: null, end: null, hours: 2 },
    sess('d', 'Dev', '2026-10-01T11:00:00+02:00', null, 'Heirfall'),
  ];
  const g = L.aggregate(rows, ['2026-09-29', '2026-09-30', '2026-10-01'], now);
  assert.equal(g.total, 3 + 1 + 2 + 1);
  assert.deepEqual(g.byType, { Dev: 4, Art: 1, Autre: 2 });
  assert.deepEqual(g.byProject, { Fluffy: 3, Heirfall: 4 });
  assert.equal(g.byDay['2026-09-30'].total, 3);
  assert.deepEqual(g.byDay['2026-09-30'].byType, { Art: 1, Autre: 2 });
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npm test`
Expected: FAIL (fonctions absentes).

- [ ] **Step 3: Implémenter dans `web/logic.js`**

Sous `var BLOCK_HOURS = …` :

```js
  // Copie de la liste du serveur (Core.gs), pour un état mis en cache par une version sans types.
  var DEFAULT_TYPES = [
    { name: 'Autre', color: '#9B20F9' },
    { name: 'Dev', color: '#3B82F6' },
    { name: 'Art', color: '#EC4899' },
    { name: 'Narration', color: '#22C55E' },
  ];
  var DEFAULT_TYPE = 'Autre';
  var HOUR = 3600000;
  var DAY_START_HOUR = 8;

  function typesOf(s) { return (s && s.types && s.types.length) ? s.types : DEFAULT_TYPES; }
  function typeOf(row) { return (row && row.type) || DEFAULT_TYPE; }
  function typeColor(s, name) {
    var t = typesOf(s).filter(function (x) { return x.name === name; })[0];
    return t ? t.color : DEFAULT_TYPES[0].color;
  }

  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(date, n) { var d = new Date(date); d.setDate(d.getDate() + n); return d; }
```

Remplacer `visibleProjects` :

```js
  function pickableProjects(s, showStudio) {
    return s.projects.filter(function (p) { return showStudio || p !== s.studio; });
  }

  // Boutons projets : les `visible` premiers, le reste derrière « Plus… ». Le studio n'y est que
  // si le réglage « Afficher Studio » est coché.
  function visibleProjects(s, showStudio) {
    var list = pickableProjects(s, showStudio);
    if (list.length <= s.visible) return { shown: list, more: [] };
    var n = Math.max(s.visible - 1, 1);
    return { shown: list.slice(0, n), more: list.slice(n) };
  }
```

Mettre à jour le test existant « boutons visibles » : il attendait que le studio soit retiré ; c'est toujours le cas avec `showStudio` absent (faux). Aucune assertion à changer.

Ajouter avant `applyLocal` :

```js
  // Ajoute ou remplace une ligne dans `today` (même id).
  function upsertToday(s, row) {
    s.today = (s.today || []).filter(function (r) { return r.id !== row.id; });
    s.today.push(row);
  }
```

Dans `applyLocal`, branche `start` :

```js
    if (item.action === 'start') {
      var type = p.type || (s.running ? typeOf(s.running) : DEFAULT_TYPE);
      if (s.running && s.running.project === p.project && typeOf(s.running) === type) return s;
      var start = new Date(new Date(at).getTime() - (p.offsetMinutes || 0) * 60000);
      if (s.running) {
        var prevStart = new Date(s.running.start);
        if (start < prevStart) start = prevStart;
        s.running.end = start.toISOString();
        s.running.hours = hoursBetween(s.running.start, start);
        s.last = s.running;
        upsertToday(s, s.last);
      }
      s.running = {
        id: p.id, project: p.project, type: type, date: dayKey(start), start: start.toISOString(), end: null,
        hours: null, note: p.note || '', source: 'app', corrected: false,
      };
      upsertToday(s, s.running);
    }
```

Branche `stop` : après `s.last = s.running;` ajouter `upsertToday(s, s.last);` (avant `s.running = null`).

Branche `logBlock` : ajouter `type: p.type || DEFAULT_TYPE,` dans l'objet `s.last`, puis `if (s.last.date === dayKey(at)) upsertToday(s, s.last);`.

Branche `editLast` : à la fin de la branche (après `s.last.corrected = true;`), ajouter `if ((s.today || []).some(function (r) { return r.id === s.last.id; })) upsertToday(s, s.last);`.

Comme `upsertToday` remplace l'objet, `s.last` et la ligne de `today` sont le même objet : pas de copie divergente.

Ajouter les calculs (avant `var api`) :

```js
  function rowHours(row, nowMs) {
    if (!row.start) return Number(row.hours) || 0;
    var end = row.end ? new Date(row.end).getTime() : nowMs;
    return Math.max(0, end - new Date(row.start).getTime()) / HOUR;
  }

  // Total du jour : la part des sessions entre minuit et maintenant, plus les blocs du jour.
  function todayTotal(rows, nowMs) {
    var from = startOfDay(nowMs);
    var key = dayKey(nowMs);
    return (rows || []).reduce(function (sum, r) {
      if (!r.start) return sum + (r.date === key ? Number(r.hours) || 0 : 0);
      var a = Math.max(new Date(r.start).getTime(), from);
      var b = Math.min(r.end ? new Date(r.end).getTime() : nowMs, nowMs);
      return sum + Math.max(0, b - a) / HOUR;
    }, 0);
  }

  // Frise du jour : de min(8 h, première session) à maintenant ; les blocs n'ont pas d'heure.
  function dayTimeline(rows, nowMs) {
    var midnight = startOfDay(nowMs);
    var segments = [];
    (rows || []).forEach(function (r) {
      if (!r.start) return;
      var a = Math.max(new Date(r.start).getTime(), midnight);
      var b = Math.min(r.end ? new Date(r.end).getTime() : nowMs, nowMs);
      if (b > a) segments.push({ start: a, end: b, type: typeOf(r) });
    });
    segments.sort(function (x, y) { return x.start - y.start; });
    var from = Math.min(midnight + DAY_START_HOUR * HOUR, segments.length ? segments[0].start : Infinity);
    return { from: Math.min(from, nowMs), to: nowMs, segments: segments };
  }

  function rangeOf(first, count) {
    var days = [];
    for (var i = 0; i < count; i++) days.push(dayKey(addDays(first, i)));
    return { from: days[0], to: days[days.length - 1], days: days };
  }

  // Semaine du lundi au dimanche contenant `date` (jours calendaires : sûr aux changements d'heure).
  function weekRange(date) {
    var d = new Date(date);
    d.setHours(12, 0, 0, 0);
    var monday = addDays(d, -((d.getDay() + 6) % 7));
    return rangeOf(monday, 7);
  }

  function monthRange(date) {
    var first = new Date(new Date(date).getFullYear(), new Date(date).getMonth(), 1, 12);
    var count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return rangeOf(first, count);
  }

  // Récap : une session compte pour son jour de début (colonne Date) ; en cours, jusqu'à maintenant.
  function aggregate(rows, days, nowMs) {
    var out = { total: 0, byDay: {}, byType: {}, byProject: {} };
    days.forEach(function (k) { out.byDay[k] = { total: 0, byType: {} }; });
    (rows || []).forEach(function (r) {
      var day = out.byDay[r.date];
      if (!day) return;
      var h = rowHours(r, nowMs);
      var t = typeOf(r);
      day.total += h;
      day.byType[t] = (day.byType[t] || 0) + h;
      out.total += h;
      out.byType[t] = (out.byType[t] || 0) + h;
      out.byProject[r.project] = (out.byProject[r.project] || 0) + h;
    });
    return out;
  }
```

Les tests comparent des sommes d'heures entières : les additions flottantes y sont exactes.

Exporter dans `api` : `DEFAULT_TYPES, typesOf, typeOf, typeColor, pickableProjects, rowHours, todayTotal, dayTimeline, weekRange, monthRange, aggregate` (en plus de l'existant).

- [ ] **Step 4: Lancer les tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/logic.js tests/logic.test.js
git commit -m "feat(app) : calculs du type, du total du jour, de la frise et des récaps"
```

---

### Task 5: Interface — sélecteur de type, Studio en réglage, total, frise, récap

**Files:**
- Modify: `web/app.js`, `web/style.css`, `web/sw.js`, `tools/e2e.js`

**Interfaces:**
- Consumes: tout `KTLogic` de la tâche 4 ; actions `start { type }`, `logBlock { type }`, `history { from, to }`.
- Produces: écran décrit en spec §3. Sélecteurs utilisés par l'e2e : `[data-act="type"][data-t="Dev"]`, `#today-total`, `#timeline .seg`, `[data-act="recap"]`, `dialog .recap`, `[data-act="toggleStudio"]`.

- [ ] **Step 1: État et stockage** — dans `app.js` :

```js
  var VERSION = '1.1.0';
  var KEYS = { code: 'kt.code', status: 'kt.status', queue: 'kt.queue', type: 'kt.type', studio: 'kt.showStudio' };
```

Ajouter dans `state` : `type: load(KEYS.type) || 'Autre', showStudio: load(KEYS.studio) === '1', recap: null,`.

Ajouter :

```js
  // Type affiché : celui du compteur en cours, sinon le dernier choisi (utilisé au prochain lancement).
  function currentType() {
    var r = state.status && state.status.running;
    return r ? L.typeOf(r) : state.type;
  }
  function setType(t) { state.type = t; save(KEYS.type, t); }
```

Dans `setStatus`, après `state.status = data;` : `if (data && data.running) setType(L.typeOf(data.running));`.

- [ ] **Step 2: Rendu** — remplacer la ligne de `render()` qui assemble l'écran :

```js
    app.innerHTML = header(s) + hero(s) + typeBar(s) + grid(s) + todayView(s) + blocks() + lastView(s);
```

Supprimer la fonction `studio(s)`. Remplacer `hero` :

```js
  function hero(s) {
    var r = s.running;
    if (!r) return '<section class="hero idle">Rien en cours</section>';
    var t = L.typeOf(r);
    return '<section class="hero" style="--c:' + L.typeColor(s, t) + '">' +
      '<div class="hero-project">' + esc(r.project) + ' · ' + esc(t) + '</div>' +
      '<div class="hero-time" id="elapsed">' + L.elapsed(Date.now() - new Date(r.start).getTime()) + '</div>' +
      '<button class="stop" data-act="stop">STOP</button>' +
      '<button class="link note-text" data-act="note">' + (r.note ? esc(r.note) : '+ note') + '</button>' +
      '</section>';
  }

  function typeBar(s) {
    var cur = currentType();
    return '<div class="types">' + L.typesOf(s).map(function (t) {
      return '<button class="type' + (t.name === cur ? ' on' : '') + '" style="--c:' + t.color + '" data-act="type" data-t="' + esc(t.name) + '">' + esc(t.name) + '</button>';
    }).join('') + '</div>';
  }

  function todayView(s) {
    return '<section class="today">' +
      '<div class="today-head"><span>Aujourd’hui</span><b id="today-total">' + L.duration(L.todayTotal(s.today, Date.now())) + '</b>' +
      '<button class="link small" data-act="recap">Récap</button></div>' +
      '<div class="timeline" id="timeline">' + timelineHtml(s) + '</div></section>';
  }

  function timelineHtml(s) {
    var tl = L.dayTimeline(s.today, Date.now());
    var span = Math.max(tl.to - tl.from, 60000);
    var pct = function (ms) { return ((ms - tl.from) / span * 100).toFixed(2) + '%'; };
    var html = tl.segments.map(function (g) {
      return '<span class="seg" style="left:' + pct(g.start) + ';width:' + (((g.end - g.start) / span) * 100).toFixed(2) + '%;background:' + L.typeColor(s, g.type) + '"></span>';
    }).join('');
    var h = new Date(tl.from); h.setMinutes(0, 0, 0); h.setHours(h.getHours() + 1);
    for (; h.getTime() < tl.to; h.setHours(h.getHours() + 1)) {
      if (h.getHours() % 2) continue;
      html += '<span class="tick" style="left:' + pct(h.getTime()) + '">' + h.getHours() + 'h</span>';
    }
    return html;
  }
```

Dans `grid(s)`, utiliser `L.visibleProjects(s, state.showStudio)`. Dans `projectButton`, retirer le paramètre `extra` devenu inutile si plus aucun appel ne le passe (garder la signature `(s, p)`).

Dans `tick()`, après la mise à jour de `#elapsed`, ajouter :

```js
    var total = document.getElementById('today-total');
    if (total && state.status) total.textContent = L.duration(L.todayTotal(state.status.today, Date.now()));
    var tl = document.getElementById('timeline');
    if (tl && state.status && r && Date.now() % 30000 < 1000) tl.innerHTML = timelineHtml(state.status);
```

- [ ] **Step 3: Gestionnaires** — dans `handlers` :

```js
    type: function (el) {
      var t = el.dataset.t;
      var r = state.status.running;
      setType(t);
      if (r && L.typeOf(r) !== t) act('start', { id: uid(), project: r.project, type: t });
      else render();
    },

    start: function (el) {
      var p = el.dataset.p;
      closeDialog();
      var r = state.status.running;
      if (r && r.project === p) return;
      act('start', { id: uid(), project: p, type: currentType() });
    },
```

Dans `blockSave` : `act('logBlock', { id: uid(), project: el.dataset.p, hours: Number(el.dataset.h), type: currentType() });`. Dans `otherDaySave`, ajouter `type: currentType(),` à `params`. Dans `block` et `otherDay`, remplacer `state.status.projects` par `L.pickableProjects(state.status, state.showStudio)`. Dans `more`, utiliser `L.visibleProjects(state.status, state.showStudio).more`. Dans `projectList`, retirer la classe `studio`.

Menu : ajouter avant « Changer de code » :

```js
        (state.status ? '<button class="menu-item" data-act="toggleStudio">Afficher Studio : ' + (state.showStudio ? 'oui' : 'non') + '</button>' : '') +
```

et le gestionnaire :

```js
    toggleStudio: function () {
      state.showStudio = !state.showStudio;
      save(KEYS.studio, state.showStudio ? '1' : null);
      closeDialog();
      render();
    },
```

- [ ] **Step 4: Le récap** — gestionnaires et rendu :

```js
    recap: function () {
      state.recap = { mode: 'week', ref: new Date(), data: null, error: '' };
      loadRecap();
    },
    recapMode: function (el) { state.recap.mode = el.dataset.m; state.recap.ref = new Date(); loadRecap(); },
    recapPrev: function () { shiftRecap(-1); },
    recapNext: function () { shiftRecap(1); },
```

```js
  function recapRange() {
    return state.recap.mode === 'week' ? L.weekRange(state.recap.ref) : L.monthRange(state.recap.ref);
  }

  function shiftRecap(n) {
    var d = new Date(state.recap.ref);
    if (state.recap.mode === 'week') d.setDate(d.getDate() + 7 * n);
    else d.setMonth(d.getMonth() + n, 1);
    state.recap.ref = d;
    loadRecap();
  }

  function loadRecap() {
    var range = recapRange();
    var asked = state.recap;
    asked.data = null;
    asked.error = '';
    renderRecap();
    post({ code: state.code, action: 'history', from: range.from, to: range.to }).then(function (res) {
      if (state.recap !== asked) return;
      if (res.ok) asked.data = res.data;
      else asked.error = res.error.message;
      renderRecap();
    }).catch(function (err) {
      rethrowIfBug(err);
      if (state.recap !== asked) return;
      asked.error = 'Récap indisponible : ' + failureMessage(err);
      renderRecap();
    });
  }

  function hoursLabel(h) { return L.duration(Math.round(h * 60) / 60); }

  function renderRecap() {
    var rc = state.recap;
    var s = state.status;
    var range = recapRange();
    var title = rc.mode === 'week'
      ? 'Semaine du ' + L.dayLabel(range.from, 0)
      : new Date(range.from + 'T12:00:00').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    var body;
    if (rc.error) body = '<p class="error">' + esc(rc.error) + '</p>';
    else if (!rc.data) body = '<p class="muted">Chargement…</p>';
    else {
      var g = L.aggregate(rc.data.rows, range.days, Date.now());
      body = '<p class="recap-total">Total : <b>' + hoursLabel(g.total) + '</b></p>' +
        (rc.mode === 'week' ? weekBars(s, g, range) : '') +
        breakdown('Par type', L.typesOf(s).map(function (t) { return [t.name, g.byType[t.name] || 0, t.color]; }), g.total) +
        (rc.mode === 'month' ? breakdown('Par projet', Object.keys(g.byProject).map(function (p) { return [p, g.byProject[p], null]; }), g.total) : '');
    }
    openDialog('<div class="recap">' +
      '<div class="tabs"><button class="chip' + (rc.mode === 'week' ? ' on' : '') + '" data-act="recapMode" data-m="week">Semaine</button>' +
      '<button class="chip' + (rc.mode === 'month' ? ' on' : '') + '" data-act="recapMode" data-m="month">Mois</button></div>' +
      '<div class="recap-nav"><button class="icon" data-act="recapPrev" aria-label="Précédent">‹</button><h2>' + esc(title) + '</h2>' +
      '<button class="icon" data-act="recapNext" aria-label="Suivant">›</button></div>' +
      body + '</div>' + '<button class="secondary" data-act="close">Fermer</button>');
  }

  function weekBars(s, g, range) {
    var max = Math.max(8, Math.max.apply(null, range.days.map(function (k) { return g.byDay[k].total; })));
    return '<div class="bars">' + range.days.map(function (k) {
      var day = g.byDay[k];
      var stack = L.typesOf(s).map(function (t) {
        var h = day.byType[t.name] || 0;
        return h ? '<span style="height:' + (h / max * 100).toFixed(1) + '%;background:' + t.color + '"></span>' : '';
      }).join('');
      var label = new Date(k + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'narrow' });
      return '<div class="bar"><div class="stack">' + stack + '</div><small>' + (day.total ? hoursLabel(day.total) : '–') + '</small><small class="muted">' + label + '</small></div>';
    }).join('') + '</div>';
  }

  function breakdown(title, items, total) {
    return '<h3>' + esc(title) + '</h3><div class="breakdown">' + items.filter(function (i) { return i[1] > 0; }).map(function (i) {
      return '<div class="line"><span class="dot"' + (i[2] ? ' style="background:' + i[2] + '"' : '') + '></span><span>' + esc(i[0]) + '</span>' +
        '<b>' + hoursLabel(i[1]) + '</b><span class="muted">' + Math.round(i[1] / (total || 1) * 100) + ' %</span></div>';
    }).join('') + '</div>';
  }
```

`L.dayLabel(range.from, 0)` donne « lun. 28 sept. » (date absolue, car `now = 0` n'est ni aujourd'hui ni hier). Le récap ne passe pas par la file d'actions : c'est une lecture, refaite à chaque ouverture.

Fermer le récap remet `state.recap = null` : dans le gestionnaire existant `dlg.addEventListener('close', …)`, ajouter `state.recap = null;`.

- [ ] **Step 5: Styles** — dans `style.css`, supprimer `--studio`, `--studio-fg`, `--studio-soft` (clair et sombre), `.hero.is-studio …`, `.proj.studio` et `.proj.studio.on`. Remplacer `.hero-project { … color: var(--accent); }` par `color: var(--c, var(--accent));`. Ajouter :

```css
/* Types de travail */
.types { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.type {
  min-height: 48px;
  border-radius: 12px;
  font-weight: 600;
  font-size: 15px;
  background: color-mix(in srgb, var(--c) 16%, var(--card));
  color: var(--fg);
  border: 1px solid color-mix(in srgb, var(--c) 35%, transparent);
}
.type.on { background: var(--c); color: #fff; border-color: var(--c); }

/* Aujourd'hui */
.today { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px 22px; }
.today-head { display: flex; align-items: baseline; gap: 8px; }
.today-head span { color: var(--muted); font-size: 15px; }
.today-head b { font-size: 22px; font-variant-numeric: tabular-nums; flex: 1; }
.today-head .link { margin: 0; padding: 4px 6px; }
.timeline { position: relative; height: 22px; margin-top: 8px; border-radius: 6px; background: var(--bg); }
.seg { position: absolute; top: 0; bottom: 0; border-radius: 4px; min-width: 2px; }
.tick { position: absolute; top: 24px; transform: translateX(-50%); font-size: 11px; color: var(--muted); }

/* Récap */
.recap { display: flex; flex-direction: column; gap: 10px; }
.recap .tabs { display: flex; gap: 6px; }
.recap .tabs .chip { flex: 1; }
.recap-nav { display: flex; align-items: center; gap: 6px; }
.recap-nav h2 { flex: 1; text-align: center; font-size: 17px; }
.recap-nav .icon { font-size: 26px; color: var(--fg); }
.recap h3 { margin: 4px 0 0; font-size: 15px; color: var(--muted); }
.recap-total { margin: 0; }
.bars { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; align-items: end; }
.bar { display: flex; flex-direction: column; align-items: center; gap: 2px; font-variant-numeric: tabular-nums; }
.bar .stack { height: 120px; width: 100%; display: flex; flex-direction: column-reverse; border-radius: 6px; background: var(--bg); overflow: hidden; }
.bar small { font-size: 11px; }
.breakdown { display: flex; flex-direction: column; gap: 4px; }
.line { display: grid; grid-template-columns: 12px 1fr auto 42px; align-items: center; gap: 8px; }
.line .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
.line .muted { text-align: right; font-size: 14px; }
```

- [ ] **Step 6: Cache** — dans `web/sw.js`, `var CACHE = 'kt-v2';`.

- [ ] **Step 7: Bout en bout** — dans `tools/e2e.js` :
  - le bloc « Bloc et correction de durée » choisissait Studio, désormais masqué : remplacer `[data-p="Studio"]` par `[data-p="Proto"]` et le contrôle par `s.last?.project === 'Proto' && …`, libellé « bloc de 8 h sur Proto ».
  - après le bloc « Lancement, bascule, stop », ajouter :

```js
  console.log('Types, total du jour, récap');
  await page.click('[data-act="type"][data-t="Dev"]');
  await page.click('[data-act="start"][data-p="Fluffy"]');
  await page.waitFor('document.querySelector(".sync-ok") && /Dev/.test(document.querySelector(".hero-project").textContent)', 'lancement en Dev');
  await page.click('[data-act="type"][data-t="Art"]');
  await page.waitFor('document.querySelector(".sync-ok") && /Art/.test(document.querySelector(".hero-project").textContent)', 'bascule en Art');
  s = await api(P, { ...me, action: 'status' });
  check(s.running?.type === 'Art' && s.last?.type === 'Dev' && s.last?.project === 'Fluffy', 'serveur : bascule de type Dev → Art sur Fluffy');
  check(await page.evaluate('document.querySelectorAll("#timeline .seg").length') >= 1, 'la frise montre la journée');
  await page.click('[data-act="recap"]');
  await page.waitFor('document.querySelector("dialog .recap .bars")', 'récap semaine');
  await page.shot('02b-recap');
  await page.click('dialog [data-act="recapMode"][data-m="month"]');
  await page.waitFor('document.querySelector("dialog .recap .breakdown")', 'récap mois');
  await page.click('dialog [data-act="close"]');
  await page.click('[data-act="menu"]');
  await page.click('dialog [data-act="toggleStudio"]');
  await page.waitFor('document.querySelector("[data-act=start][data-p=Studio]")', 'Studio affiché par le réglage');
  // Réglage remis : avec Studio affiché, Proto et Jam passeraient dans « Plus… » pour la suite du test.
  await page.click('[data-act="menu"]');
  await page.click('dialog [data-act="toggleStudio"]');
  await page.waitFor('!document.querySelector("[data-act=start][data-p=Studio]")', 'Studio masqué à nouveau');
  await page.click('[data-act="stop"]');
  await page.waitFor('document.querySelector(".hero.idle") && document.querySelector(".sync-ok")', 'arrêt');
```

  (`s` est déjà déclaré par le bloc « Lancement, bascule, stop », juste avant.)

- [ ] **Step 8: Lancer tous les tests**

Run: `npm test` puis `node tools/e2e.js`
Expected: `npm test` PASS ; e2e « Tout est vert. »

- [ ] **Step 9: Commit**

```bash
git add web/app.js web/style.css web/sw.js tools/e2e.js
git commit -m "feat(app) : sélecteur de type, total et frise du jour, récap semaine et mois, Studio en réglage"
```

---

### Task 6: Widget Android — quatre boutons de type

**Files:**
- Modify: `android/src/com/kilosaurus/temps/Prefs.java`, `android/src/com/kilosaurus/temps/WidgetProvider.java`, `android/res/layout/widget.xml`, `android/res/xml/widget_info.xml`
- Create: `android/res/drawable/type_{autre,dev,art,narration}_{on,off}.xml` (8 fichiers)
- Delete: `android/res/drawable/btn_start.xml`, `android/res/drawable/btn_stop.xml` (après vérification qu'aucun autre fichier ne les cite : `grep -r "btn_start\|btn_stop" android/`)

**Interfaces:**
- Consumes: `status.running.type` (tâche 1) ; `start { project, type }`.
- Produces: rien pour les autres tâches.

- [ ] **Step 1: `Prefs`** — mémoriser le type en cours :

```java
    String runningType() { return sp.getString("runningType", "Autre"); }
```

Dans `saveStatus`, branche `running != null` : `e.putString("runningType", running.optString("type", "Autre"));` ; branche sinon : ajouter `.remove("runningType")`.

- [ ] **Step 2: Drawables** — `type_dev_on.xml` (les autres sur le même modèle, couleurs de la spec ; `_off` = même couleur avec l'alpha `40`) :

```xml
<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#3B82F6" />
    <corners android:radius="12dp" />
</shape>
```

| Fichier | Couleur |
|---|---|
| `type_autre_on` / `type_autre_off` | `#9B20F9` / `#409B20F9` |
| `type_dev_on` / `type_dev_off` | `#3B82F6` / `#403B82F6` |
| `type_art_on` / `type_art_off` | `#EC4899` / `#40EC4899` |
| `type_narration_on` / `type_narration_off` | `#22C55E` / `#4022C55E` |

- [ ] **Step 3: Layout** — dans `widget.xml`, remplacer le `<Button android:id="@+id/button" … />` par :

```xml
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="52dp"
        android:layout_marginTop="6dp"
        android:orientation="horizontal">

        <Button android:id="@+id/type_autre" style="@style/TypeButton" android:text="Autre" />
        <Button android:id="@+id/type_dev" style="@style/TypeButton" android:text="Dev" />
        <Button android:id="@+id/type_art" style="@style/TypeButton" android:text="Art" />
        <Button android:id="@+id/type_narration" style="@style/TypeButton" android:text="Narr." />
    </LinearLayout>
```

Dans `android/res/values/styles.xml`, ajouter :

```xml
    <style name="TypeButton">
        <item name="android:layout_width">0dp</item>
        <item name="android:layout_height">match_parent</item>
        <item name="android:layout_weight">1</item>
        <item name="android:layout_marginStart">2dp</item>
        <item name="android:layout_marginEnd">2dp</item>
        <item name="android:padding">0dp</item>
        <item name="android:textSize">14sp</item>
        <item name="android:textStyle">bold</item>
        <item name="android:textAllCaps">false</item>
    </style>
```

- [ ] **Step 4: `widget_info.xml`** — `android:minWidth="250dp"`, `android:targetCellWidth="4"` (le reste inchangé).

- [ ] **Step 5: `WidgetProvider`** — remplacer `ACTION_TOGGLE` par `ACTION_TYPE = "com.kilosaurus.temps.TYPE"` et l'extra `EXTRA_TYPE = "type"`. Ajouter :

```java
    static final String[] TYPES = { "Autre", "Dev", "Art", "Narration" };
    static final int[] BUTTONS = { R.id.type_autre, R.id.type_dev, R.id.type_art, R.id.type_narration };
    static final int[] ON = { R.drawable.type_autre_on, R.drawable.type_dev_on, R.drawable.type_art_on, R.drawable.type_narration_on };
    static final int[] OFF = { R.drawable.type_autre_off, R.drawable.type_dev_off, R.drawable.type_art_off, R.drawable.type_narration_off };
```

Dans `onReceive`, la branche `ACTION_TYPE` lit `intent.getStringExtra(EXTRA_TYPE)` et appelle `tap(ctx, widgetId, type)`.

Remplacer `toggle` par :

```java
    /**
     * Un tap sur un type : arrêté → lance le projet du widget avec ce type ; un autre type tourne →
     * bascule le compteur en cours vers ce type ; ce type tourne → pause (stop).
     */
    private static void tap(Context ctx, int widgetId, String type) {
        Prefs p = new Prefs(ctx);
        if (p.code().isEmpty()) {
            p.setMessage("Touche le nom du projet pour régler le widget.");
            renderAll(ctx);
            return;
        }
        boolean running = p.isRunning();
        String project = running ? p.runningProject() : p.widgetProject(widgetId);
        if (project.isEmpty()) {
            p.setMessage("Touche le nom du projet pour en choisir un.");
            renderAll(ctx);
            return;
        }
        p.setMessage("Envoi…");
        renderAll(ctx);
        try {
            JSONObject body = new JSONObject().put("code", p.code());
            if (running && type.equals(p.runningType())) {
                body.put("action", "stop");
            } else {
                body.put("action", "start").put("id", UUID.randomUUID().toString()).put("project", project).put("type", type);
            }
            p.saveStatus(Api.call(p.url(), body));
            p.setMessage("");
        } catch (Api.ApiException e) {
            p.setMessage(describe(e));
        } catch (JSONException e) {
            p.setMessage("Erreur interne : " + e.getMessage());
        }
        renderAll(ctx);
    }
```

Dans `render`, remplacer les lignes du bouton unique (texte START / STOP et fond) par :

```java
        String active = p.isRunning() ? p.runningType() : "";
        for (int i = 0; i < TYPES.length; i++) {
            boolean on = TYPES[i].equals(active);
            v.setInt(BUTTONS[i], "setBackgroundResource", on ? ON[i] : OFF[i]);
            v.setTextColor(BUTTONS[i], on ? 0xFFFFFFFF : ctx.getColor(R.color.fg));
            v.setOnClickPendingIntent(BUTTONS[i], typeIntent(ctx, widgetId, i));
        }
```

et dans la branche `isRunning()`, le titre devient `p.runningProject() + " · " + p.runningType()`. Supprimer `v.setOnClickPendingIntent(R.id.button, …)`.

Remplacer `broadcast` par deux fabriques à codes de requête distincts :

```java
    private static PendingIntent typeIntent(Context ctx, int widgetId, int index) {
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(ACTION_TYPE)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .putExtra(EXTRA_TYPE, TYPES[index]);
        return PendingIntent.getBroadcast(ctx, widgetId * 8 + index, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent refreshIntent(Context ctx, int widgetId) {
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(ACTION_REFRESH)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        return PendingIntent.getBroadcast(ctx, widgetId * 8 + 7, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
```

(`R.id.message` utilise `refreshIntent`.) Mettre à jour le commentaire de classe : « Widget à quatre boutons de type ».

- [ ] **Step 6: Construire**

Run: `VERSION_CODE=3 VERSION_NAME=1.2 bash android/build.sh`
Expected: `APK : …/android/build/kilosaurus-temps.apk`, sans erreur de compilation.

- [ ] **Step 7: Commit**

```bash
git add android
git commit -m "feat(widget) : quatre boutons de type, bascule et pause"
```

---

### Task 7: Icônes depuis le logo

**Files:**
- Add: `kilo_logo.png`
- Modify: `tools/make_icons.py`
- Regenerate: `web/icons/*.png`, `android/res/mipmap-xxhdpi/ic_launcher.png`, `android/res/mipmap-xxxhdpi/ic_launcher.png`

- [ ] **Step 1: Réécrire `tools/make_icons.py`**

```python
"""Génère toutes les icônes (web et Android) depuis kilo_logo.png. Usage : py tools/make_icons.py"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "kilo_logo.png"
WEB = ROOT / "web" / "icons"
ANDROID = ROOT / "android" / "res"


def square(logo, size):
    return logo.resize((size, size), Image.LANCZOS)


def padded(logo, size, ratio):
    """Logo réduit à `ratio` du côté, centré sur sa couleur de fond (icône masquable)."""
    bg = logo.getpixel((2, 2))
    canvas = Image.new("RGB", (size, size), bg)
    inner = int(size * ratio)
    canvas.paste(logo.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return canvas


def main():
    logo = Image.open(LOGO).convert("RGB")
    WEB.mkdir(parents=True, exist_ok=True)
    square(logo, 192).save(WEB / "icon-192.png")
    square(logo, 512).save(WEB / "icon-512.png")
    square(logo, 180).save(WEB / "apple-touch-icon.png")
    padded(logo, 512, 0.8).save(WEB / "icon-maskable-512.png")
    square(logo, 144).save(ANDROID / "mipmap-xxhdpi" / "ic_launcher.png")
    square(logo, 192).save(ANDROID / "mipmap-xxxhdpi" / "ic_launcher.png")
    print("Icônes écrites dans", WEB, "et", ANDROID)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Générer et vérifier**

Run: `py tools/make_icons.py`
Expected: le message « Icônes écrites… ». Ouvrir `web/icons/icon-512.png` et `icon-maskable-512.png` pour vérifier visuellement (logo net, marge violette sur la masquable).

- [ ] **Step 3: Reconstruire l'APK** (l'icône est dans l'APK)

Run: `VERSION_CODE=3 VERSION_NAME=1.2 bash android/build.sh`

- [ ] **Step 4: Commit**

```bash
git add kilo_logo.png tools/make_icons.py web/icons android/res/mipmap-xxhdpi android/res/mipmap-xxxhdpi
git commit -m "feat : le logo Kilosaurus devient l'icône de l'app web et de l'APK"
```

---

### Task 8: Docs, mise en ligne et projet Heirfall

**Files:**
- Modify: `README.md`, `docs/specs/2026-10-01-kilosaurus-temps-design.md`, `claude/kilosaurus-temps/SKILL.md`

- [ ] **Step 1: README** — section « Utilisation » : remplacer la puce Studio par les types (sélecteur, bascule en un tap, Studio via ⚙ → Afficher Studio), ajouter « Aujourd'hui » (total, frise) et « Récap » (semaine, mois). Section widget : quatre boutons de type (tap = lancer / basculer / pause), taille 4 × 2. Section « La Sheet contient » : colonne Type (L), posée automatiquement, vide = Autre.

- [ ] **Step 2: Spec v1** — dans `docs/specs/2026-10-01-kilosaurus-temps-design.md`, en tête : « Les types de travail, le total du jour et les récaps sont décrits dans `2026-10-01-types-de-travail-design.md`, qui l'emporte en cas de divergence. » Remplacer les puces « Studio : bouton pleine largeur… » (§4) et « Le widget : … un bouton » (§6 bis) par un renvoi à la nouvelle spec ; ajouter la colonne L au tableau des colonnes.

- [ ] **Step 3: Skill agent** — dans `SKILL.md`, tableau des actions : `type?` (Autre, Dev, Art, Narration ; défaut Autre) sur `start`, `logBlock`, `logSession` ; nouvelle ligne `history | from, to (aaaa-mm-jj, 62 jours max) | Mes lignes de la période, pour faire un bilan.`

- [ ] **Step 4: Vérification complète**

Run: `npm test` puis `node tools/e2e.js`
Expected: tout vert.

- [ ] **Step 5: Commit et mise en ligne**

```bash
git add README.md docs claude
git commit -m "docs : types de travail, total du jour, récaps, widget à quatre boutons"
npx -y @google/clasp push --force
npx -y @google/clasp deploy -i AKfycbymtz045MJ4nZKm1scGElvtfiyAlb3WPzb9UEm4K_xiylXgADZdrFJsQaOINctJ5rNOKQ -d "Types de travail, today, history"
git push
cp android/build/kilosaurus-temps.apk kilosaurus-temps.apk
```

Vérifier : `gh run watch` du workflow Pages vert ; un POST `status` avec le code PC renvoie `types` et `today`.

- [ ] **Step 6: Créer Heirfall** — si `status.projects` ne contient pas `Heirfall`, envoyer `addProject { name: "Heirfall" }` avec le code PC, puis relire `status`.

- [ ] **Step 7: Dire à l'utilisateur** — lancer `runSelfTest` (pose la colonne Type partout et valide le parcours sur la vraie Sheet), installer l'APK 1.2, reposer le widget (nouvelle taille).
