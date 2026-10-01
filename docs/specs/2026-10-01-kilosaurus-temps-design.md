# Kilosaurus Temps — spécification v1

> Les types de travail, le total du jour, la frise, les récaps, le réglage Studio et le widget à
> quatre boutons sont décrits dans `2026-10-01-types-de-travail-design.md`, qui l'emporte en cas de
> divergence.

Outil de suivi du temps de travail par projet, pour une seule personne (Amohs). Le modèle de
données reste multi-personne (colonne Personne, liste dans `_Config`). Une Google Sheet stocke les données, un Apps Script lié à la Sheet sert d'API JSON, une PWA
statique (GitHub Pages) sert d'interface sur téléphone et PC. Un agent Claude Code peut aussi
loguer du temps directement via l'API.

La v1 **compte le temps, rien d'autre** : pas de calcul de parts, pas de décote, pas de bilan,
pas de totaux affichés. Les données sont structurées pour que ces calculs puissent s'y brancher
plus tard sans migration.

## Principes

- **Rien de « shady ».** L'app ne montre que le temps de la personne qui l'utilise : son compteur,
  ses boutons, son dernier log. Aucun total, aucune vue sur l'activité des autres.
- **Moins de 2 secondes.** Un tap lance un compteur ; deux taps déclarent un bloc d'heures. Tout ce
  qui sert rarement (nouveau projet, saisie d'un autre jour, changer de code) est rangé à l'écart.
- **Traçabilité.** Chaque ligne dit qui l'a saisie, quand, et par quel canal. Toute correction
  laisse une trace dans `_Corrections`.
- **Fuseau Europe/Paris** partout : script, Sheet, affichage.

## 1. La Sheet

### Onglets de projet

Un onglet par projet. **Tout onglet dont le nom ne commence pas par `_` est un projet.** L'ordre
des onglets dans la Sheet est l'ordre des boutons dans l'app. L'onglet nommé `Studio` (nom
configurable dans `_Config`) est le temps studio : il est affiché à part dans l'app mais stocké
comme les autres.

Colonnes, identiques dans tous les onglets de projet :

| Col | En-tête | Contenu |
|---|---|---|
| A | ID | Identifiant unique de la ligne (généré par le client ou par le report) |
| B | Personne | Nom tel que listé dans `_Config` |
| C | Date | Jour de travail (jour du début pour une session) |
| D | Début | Date-heure de début — vide pour un bloc ou un report |
| E | Fin | Date-heure de fin — vide si le compteur tourne, ou pour un bloc |
| F | Heures | Durée en heures décimales (2 décimales) |
| G | Note | Texte libre, optionnel |
| H | Source | `app`, `hors ligne`, `claude`, `report` |
| I | Saisi le | Horodatage serveur de la création de la ligne |
| J | Corrigé | `oui` si la ligne a été corrigée, sinon vide |
| K | Modifié le | Horodatage serveur de la dernière écriture sur la ligne (création, arrêt, correction) |
| L | Type | Misc, Art, Dev ou Writing ; vide = Misc (voir la spec des types de travail) |

Trois sortes de lignes :

- **Session** : Début rempli. Fin vide = compteur en cours. À l'arrêt, le serveur écrit Fin et
  Heures.
- **Bloc** : Date + Heures, sans Début ni Fin. Créé par les boutons 2 / 4 / 6 / 8 / 10 / 12 h.
- **Report** : comme un bloc, Source `report`. Ce sont les lignes reprises de l'ancien fichier.

**Aucune formule dans les onglets de projet.** Le serveur calcule et écrit Heures à chaque
écriture (arrêt, correction). Conséquence assumée : une modification manuelle de Début ou Fin
directement dans la Sheet ne met pas Heures à jour — les corrections passent par l'app pour
rester tracées.

Une nouvelle ligne s'écrit sur la première ligne dont la colonne B (Personne) est vide.

### Onglets fixes

- **`_Config`** — table clé / valeur et liste des personnes :
  - Personnes : `Amohs`.
  - `Seuil oubli (h)` : 8.
  - `Onglet studio` : `Studio`.
  - `Boutons visibles` : 4.
- **`_Corrections`** — Horodatage, Auteur, Source, Projet, ID, Champ, Ancienne valeur, Nouvelle
  valeur.
- **`_Modèle`** — onglet vierge (en-têtes, formats de date et d'heure, ligne figée) que l'action
  « + Projet » duplique.

### Codes d'accès

Les codes ne sont jamais dans la Sheet ni dans le code : ils vivent dans les Script Properties.

- `CODE_<NOM>` ou `CODE_<NOM>_<APPAREIL>` (ex. `CODE_AMOHS_TELEPHONE`) — codes humains (app). Un
  code par appareil permet de révoquer un appareil perdu sans toucher aux autres.
- Tout code dont le nom contient le segment `CLAUDE` (ex. `CODE_AMOHS_CLAUDE`,
  `CODE_AMOHS_CLAUDE_PC`) est un code d'agent. Les lignes vont au nom de la personne, avec Source
  `claude`. Ce code se révoque sans toucher au code humain.
- Un code de moins de 32 caractères est ignoré : l'URL de l'API est publique, le code est la seule
  serrure.

Le canal (humain ou agent) se déduit du code, jamais d'un champ déclaré par le client.

## 2. Le report de l'ancien fichier

Source : onglet `Formulaire` de `Kilosaurus Timesheet.xlsx` (536 lignes, août 2023 → sept. 2026).

- Projet `Fluffy` → onglet Fluffy ; projet `Compta/Gestion` → onglet Studio.
- Personne : colonne calculée de l'ancien fichier. Seules les lignes d'`Honoré` sont reprises, au
  nom d'`Amohs` ; celles des autres personnes sont ignorées et seulement comptées.
- Date = « Quel Jour ? », Heures = « Combien de temps ? » (valeur calculée pour les 4 lignes à
  formule), Note = l'ancienne tâche, Source = `report`, Saisi le = l'ancien horodatage s'il existe.
- La ligne sans durée est écartée et signalée.
- L'ancien onglet caché `Historique` (export Notion) **n'est pas repris** : ses 158 jours sont tous
  déjà présents dans `Formulaire`, avec les mêmes heures.

Contrôle : les heures reprises dans le nouveau fichier égalent celles de l'ancien `Formulaire`
pour chaque personne reprise. Le script de report échoue si elles diffèrent.

Le Google Form est coupé le jour du lancement de l'app.

## 3. L'API (Apps Script)

Web app déployée « Exécuter en tant que : moi », « Accès : tout le monde ». Toutes les requêtes
sont des `POST` avec `Content-Type: text/plain` (évite le preflight CORS) et un corps JSON :

```json
{ "code": "…", "action": "start", "...": "paramètres" }
```

Réponse : `{ "ok": true, "data": … }` ou `{ "ok": false, "error": { "code": "…", "message": "…" } }`.
Codes d'erreur : `unauthorized`, `invalid`, `busy`, `locked`.

**Blocage (`locked`).** Après 10 codes refusés à moins de 15 min d'écart, l'API refuse toute
requête pendant une heure, bons codes compris. Google ne donne pas au script l'adresse de
l'appelant : le blocage ne peut pas viser un seul attaquant, il est global. C'est accepté : un
blocage ne met aucune donnée en danger, et il signale qu'on essaie de deviner un code. Pendant un
blocage, l'app garde ses actions et les rejoue ensuite avec l'heure du tap, comme hors ligne ; le
widget et l'agent affichent le message et n'écrivent rien. `unlockApi()`, lancé depuis l'éditeur,
débloque sans attendre.

Apps Script ne permet pas de renvoyer un statut HTTP 401 : un code inconnu renvoie un 200 avec
`error.code = "unauthorized"`, que le client traite comme un 401 (il efface le code mémorisé et le
redemande).

Chaque action d'écriture renvoie l'état frais (`status`), ce qui évite un second appel.

### Actions

| Action | Paramètres | Effet |
|---|---|---|
| `status` | — | Moi, liste des projets (ordre des onglets), nom de l'onglet studio, nombre de boutons visibles, mon compteur en cours, mon dernier log, seuil d'oubli, heure serveur. |
| `start` | `id`, `project`, `offsetMinutes?` (0/15/30/60), `note?` | Ferme mon compteur en cours s'il existe, puis en ouvre un nouveau. Le décalage n'est pas proposé dans l'app (réservé aux agents). |
| `stop` | `endAt?` | Ferme mon compteur. Avec `endAt` : fin posée à cette heure (cas de l'oubli), tracée dans `_Corrections`. |
| `note` | `text` | Remplace la note de mon compteur en cours. Pas une correction (une note n'est pas du temps). |
| `logBlock` | `id`, `project`, `hours` (2/4/6/8/10/12), `date?` (aaaa-mm-jj, aujourd'hui par défaut), `note?` | Crée un bloc. |
| `logSession` | `id`, `project`, `start`, `end`, `note?` | **Codes d'agent uniquement.** Crée une session complète avec des heures fournies par l'appelant. |
| `editLast` | `id`, `field` (`start`/`end`/`hours`), `value` | Corrige mon dernier log. |
| `addProject` | `name` | Crée un onglet de projet à partir de `_Modèle`. |

### Règles

- **Horodatage.** Début et Fin viennent de l'horloge du serveur. Deux exceptions seulement :
  les actions rejouées hors ligne (voir §5) et `logSession` (agent).
- **Bascule.** `start` avec un compteur en cours ferme l'ancien à l'heure exacte du début du
  nouveau. Avec un décalage (« commencé il y a 30 min »), le début est `maintenant − décalage`,
  ramené au début du compteur fermé s'il le précède : deux sessions ne se chevauchent jamais.
- **Idempotence.** `start`, `logBlock` et `logSession` portent un `id` créé par le client. Si une
  ligne porte déjà cet `id`, l'action ne fait rien et renvoie l'état. `stop` sans compteur en cours
  ne fait rien. Une requête rejouée n'écrit donc jamais deux fois.
- **Oubli.** `stop` avec `endAt` : `endAt` doit être après le début et pas dans le futur.
  Corrections : champ `Fin (oubli)`, ancienne valeur `en cours`.
- **Dernier log.** Ma ligne non en cours la plus récemment écrite (« Modifié le »), reports exclus.
  Un compteur fermé aujourd'hui passe donc devant un bloc saisi pendant qu'il tournait.
  `editLast` n'accepte que l'`id` de ce dernier log : on ne corrige que son propre dernier log.
  - Session : `start` / `end` ; contraintes Début < Fin ≤ maintenant ; Date suit Début.
  - Bloc : `hours` dans 2 / 4 / 6 / 8 / 10 / 12.
  - Chaque correction : ligne dans `_Corrections`, Corrigé = `oui`, Heures recalculées.
- **logBlock.** Heures dans 2 / 4 / 6 / 8 / 10 / 12 ; date jamais dans le futur. Un bloc ne touche
  pas au compteur en cours.
- **logSession (agent).** Début < Fin ≤ maintenant, durée ≤ 24 h. Refusée si elle chevauche une
  session existante de la même personne (les blocs, sans heures, ne peuvent pas être comparés).
  Source `claude`.
- **Agent.** Un code d'agent a accès à toutes les actions ci-dessus ; ses lignes portent Source
  `claude`.
- **addProject.** Nom nettoyé, 1 à 30 caractères, ne commence pas par `_`, sans `[ ] * ? / \ :`,
  unique sans tenir compte de la casse. Le nouvel onglet est placé après le dernier projet.
- **Concurrence.** Toute écriture passe par `LockService` (attente max 15 s, sinon `busy` et le
  client réessaie).

## 4. L'app (PWA)

HTML, CSS, JS vanilla, sans framework ni build. Installable (manifest + service worker). Thème
clair / sombre selon le système. Mobile d'abord, gros éléments tactiles.

### Écran principal (un seul écran)

```
┌──────────────────────────────┐
│ ● Amohs                    ⚙ │  point de synchro · menu
│                              │
│           FLUFFY             │
│          2:14:07             │  horloge qui défile
│        [   STOP   ]          │
│        + note                │
│                              │
│ ┌──────────┐ ┌──────────┐    │
│ │  Fluffy  │ │ Projet B │    │
│ └──────────┘ └──────────┘    │
│ ┌──────────┐ ┌──────────┐    │
│ │ Projet C │ │  Plus…   │    │
│ └──────────┘ └──────────┘    │
│ ┌──────────────────────────┐ │
│ │         STUDIO           │ │
│ └──────────────────────────┘ │
│ Déclarer :  2  4  6  8 10 12 │
│              Autre jour…     │
│ Dernier : Fluffy             │
│ 09:12 → 12:40 · 3 h 28       │
└──────────────────────────────┘
```

- **Compteur** : nom du projet et temps écoulé en très grand, gros bouton Stop, lien « + note ».
  Sans compteur : « Rien en cours ».
- **Boutons projets** : 2 colonnes, ordre des onglets. Les `Boutons visibles` premiers projets
  (hors Studio) sont affichés, les autres dans « Plus… ». Un tap lance le compteur tout de suite ;
  si un autre tourne, bascule. Pas de bouton Pause.
- **Studio** : remplacé par le réglage « Afficher Studio » et les types de travail (voir la spec
  des types de travail).
- **Déclarer 2 / 4 / 6 / 8 / 10 / 12** : un tap ouvre un panneau listant les projets (Studio
  compris) ; un tap sur un projet enregistre le bloc pour aujourd'hui.
- **Autre jour…** : ouvre une fenêtre à part pour saisir après coup — date (pas dans le futur),
  projet, heures 2 à 12, note.
- **Dernier log** : projet, début → fin, durée (ou « 8 h · hier » pour un bloc). Un tap sur une
  heure ouvre le sélecteur d'heure natif ; si la nouvelle fin tombe avant le début, la session est
  comprise comme passant minuit. Un tap sur la durée d'un bloc propose 2 à 12.
- **Garde-fou** : à l'ouverture, si mon compteur tourne depuis plus que le seuil, un écran plein
  demande « Tu as fini à quelle heure ? » avant toute autre chose. La réponse appelle `stop` avec
  `endAt`.
- **Menu ⚙** : « + Projet », « Changer de code », version de l'app.
- **Premier lancement** : un seul champ, le code. Gardé en `localStorage`.

### Synchro

- **Optimiste** : l'écran réagit au tap immédiatement ; l'appel part en arrière-plan.
- **Indicateur** (point en haut à gauche) : vert synchronisé, orange en attente, rouge erreur. Un
  tap affiche le détail.
- L'état reçu du serveur remplace l'état local à chaque réponse.

## 5. Hors ligne

- Une action dont l'appel échoue pour cause de réseau (erreur ou délai dépassé de 10 s) est mise
  en file locale avec l'heure du tap.
- La file est rejouée dans l'ordre au retour du réseau, à l'ouverture et toutes les 30 s.
- Une action rejouée porte `offline: true` et `clientTime`. **Dans ce cas seulement**, le serveur
  utilise `clientTime` comme heure de l'action (jamais dans le futur) ; Source = `hors ligne`.
  Un bloc « aujourd'hui » rejoué compte pour le jour de `clientTime`, pas pour le jour du rejeu.
- L'idempotence (§3) garantit qu'une action arrivée au serveur mais dont la réponse s'est perdue
  n'est pas écrite deux fois au rejeu.

## 6. Agent Claude Code

Livré avec le projet : un skill Claude Code (`claude/kilosaurus-temps/SKILL.md`) qui explique à un
agent comment loguer pour son utilisateur :

- l'URL de l'API et le code d'agent lus depuis des variables d'environnement
  (`KILOSAURUS_TEMPS_URL`, `KILOSAURUS_TEMPS_CODE`) — jamais écrits dans le skill ;
- les actions disponibles et leur format, avec exemples d'appels ;
- les règles : générer un `id` unique par ligne, ne pas loguer de session qui chevauche, relire
  `status` pour connaître les projets existants.

## 6 bis. App Android et widget Start / Stop

Un APK, installé à la main (hors Play Store), Android seulement. Il permet de tout faire sans
hébergement web.

- **L'app** : l'interface web du dossier `web/`, embarquée dans l'APK et affichée dans une
  WebView. Les fichiers sont servis sous une adresse https interne, pour que la page ait une
  origine normale (appels à l'API, stockage local). Mêmes écrans, mêmes règles que la PWA.
- **Le widget** : nom du projet, chrono (géré par Android, sans réveiller l'app) et quatre boutons
  de type (comportement : spec des types de travail, §4).
  - Un tap envoie **une seule** requête. La décision repose sur le dernier état connu ; si le
    serveur a changé entre-temps, sa réponse remet le widget à jour.
  - Réglage par widget : le projet. Réglage par téléphone : code perso et adresse de l'API.
  - **Pas de file hors ligne** : sans réseau, rien n'est enregistré et le widget l'affiche.
  - Mise à jour de l'état : à chaque tap, à chaque changement fait dans l'app (pont JavaScript
    `KTAndroid`), et toutes les 30 min (minimum imposé par Android).
- **Build** (`android/build.sh`) : outils du SDK Android (aapt2, javac, d8, zipalign, apksigner)
  sans Gradle. La clé de signature est créée au premier build et ne quitte pas la machine.

## 7. Tests et livraison

- **Script de report** (`tools/migrate.py`) : produit `Kilosaurus_Temps.xlsx` (onglets Fluffy,
  Studio, `_Config`, `_Corrections`, `_Modèle`, anciennes lignes rangées) et vérifie les heures
  reprises.
- **Test Apps Script** (`runSelfTest`) : crée deux onglets de projet temporaires et une personne
  de test ; joue lancement, bascule (avec décalage), arrêt, oubli, bloc, session d'agent (et son
  refus en cas de chevauchement), rejeu idempotent, correction ; vérifie chaque ligne écrite et
  chaque entrée de `_Corrections` ; vérifie que les vrais onglets n'ont pas changé ; efface tout ce
  qu'il a créé.
- **README** (français) : import du xlsx dans Google Sheets et réglage du fuseau, collage du
  script, Script Properties, déploiement web app, URL côté app, GitHub Pages, installation iOS et
  Android, ajout d'un projet, d'une personne, d'un code d'agent, coupure du Google Form.

### Arborescence

```
apps-script/   Code.gs (routage, auth), Sheet.gs (accès aux onglets), Actions.gs, Test.gs, appsscript.json
web/           index.html, style.css, app.js, config.js (URL de l'API), manifest.json, sw.js, icônes
android/       build.sh, AndroidManifest.xml, src/ (Java), res/ (widget, thèmes, icône)
claude/        kilosaurus-temps/SKILL.md
tools/         migrate.py, make_icons.py, fake-api.js, e2e.js
README.md
```

Les fichiers xlsx (données réelles, emails) sont exclus du dépôt : GitHub Pages gratuit impose un
dépôt public.

## Hors périmètre v1

Calcul des parts et décote, bilan, totaux affichés, vue équipe, tags Studio, niveaux
Conception / Production, historique consultable dans l'app, correction d'autre chose que son
dernier log.
