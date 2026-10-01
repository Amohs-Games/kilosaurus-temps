# Kilosaurus Temps v1 — plan d'implémentation

**Objectif :** livrer la v1 décrite dans la spec : Sheet de départ avec le report, API Apps Script,
PWA, skill agent, README.

**Spec :** `docs/specs/2026-10-01-kilosaurus-temps-design.md` — à lire avant toute tâche.

**Architecture :** toute la logique métier vit dans `apps-script/Core.gs`, écrit en JavaScript
pur (aucune API Google) : il reçoit un *store* (lecture / écriture des lignes), une horloge et des
fonctions de fuseau. En production, `Sheet.gs` fournit le store sur la vraie Sheet et `Code.gs`
l'horloge, l'authentification et le verrou. En test, Node charge le même `Core.gs` avec un store
en mémoire — la logique est donc testée hors de Google, sur la machine de dev.

## Contraintes globales

- Fuseau Europe/Paris partout.
- POST `text/plain`, corps JSON ; réponse `{ok, data}` / `{ok:false, error:{code, message}}`.
- Aucune formule dans les onglets de projet ; le serveur écrit Heures.
- Colonnes de projet : ID, Personne, Date, Début, Fin, Heures, Note, Source, Saisi le, Corrigé.
- Sources : `app`, `hors ligne`, `claude`, `report`.
- Blocs : 2 / 4 / 6 / 8 / 10 / 12 h uniquement. Décalages : 0 / 15 / 30 / 60 min.
- Front : HTML / CSS / JS vanilla, sans build. Aucun total ni activité des autres affiché.
- Les xlsx ne sont jamais commités.

## Points de vigilance (non couverts par le chemin nominal)

1. Rejeu d'une action déjà arrivée au serveur → aucune ligne en double (idempotence par `id`).
2. Stop rejoué hors ligne alors qu'un compteur plus récent tourne → ne doit pas fermer ce compteur.
3. Correction d'une fin après minuit (fin < début à l'heure près) → le jour suivant.
4. Session d'agent qui chevauche une session existante → refusée.
5. Code d'agent sans personne correspondante dans `_Config` → `unauthorized`.

## Tâches

### 1. Report — `tools/migrate.py`
Lit `Formulaire` (valeurs calculées) de `Kilosaurus Timesheet.xlsx`, écrit `Kilosaurus_Temps.xlsx`
(onglets Fluffy, Studio, `_Config`, `_Corrections`, `_Modèle`). Relit le fichier produit et échoue
si les totaux par personne diffèrent de l'ancien fichier.
**Vérif :** exécution sans erreur, totaux affichés égaux.

### 2. Cœur — `apps-script/Core.gs` + `tests/core.test.js`
`handleRequest(env, body)` avec `env = {store, now, tz, auth}`. Actions : status, start, stop,
note, logBlock, logSession, editLast, addProject.
Store : `config()`, `projects()`, `sheetNames()`, `allRows()`, `insert(project, row)`,
`update(ref, patch)`, `addCorrection(entry)`, `createProject(name)`.
Ligne : `{ref, project, id, person, date, start, end, hours, note, source, created, corrected}`
(dates en `Date`, cellules vides en `''`).
Tz : `dayKey(date) → 'aaaa-mm-jj'`, `dayStart(key) → Date`, `fmt(date) → 'jj/mm/aaaa hh:mm'`.
**Vérif :** `node --test tests/` vert, dont les 5 points de vigilance.

### 3. Adaptateurs Google — `Sheet.gs`, `Code.gs`, `Test.gs`, `appsscript.json`
`SheetStore` sur la Sheet, `doPost` / `doGet`, auth par Script Properties, verrou,
`runSelfTest()` (onglets temporaires, horloge simulée, vérifie que le reste de la Sheet est
inchangé, nettoie).
**Vérif :** chargement des `.gs` dans Node sans erreur de syntaxe ; `runSelfTest` exécuté par
l'utilisateur après déploiement.

### 4. App — `web/`
`index.html`, `style.css`, `app.js`, `config.js`, `manifest.json`, `sw.js`, icônes.
**Vérif :** servie en local contre un faux serveur (`tools/fake-api.js` qui utilise `Core.gs` et
un store mémoire) : lancement, bascule, stop, bloc, autre jour, correction, garde-fou, hors ligne.

### 5. Skill agent — `claude/kilosaurus-temps/SKILL.md`
**Vérif :** les exemples d'appel tournent contre le faux serveur.

### 6. README
Déploiement pas à pas (voir spec §7).
