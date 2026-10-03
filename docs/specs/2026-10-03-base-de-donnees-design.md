# Kilosaurus Temps v2 — base de données, annulation, fenêtre des sessions, widget stable

> Remplace la partie stockage et API de `2026-10-01-kilosaurus-temps-design.md` (la Sheet et
> l'Apps Script). Les règles d'usage (types, pause, séance, total du jour, frise, récaps) de
> `2026-10-01-types-de-travail-design.md` restent valables, sauf mention contraire ici.

## Objectif

- **Réactivité** : une action est confirmée par le serveur en quelques centaines de millisecondes,
  au lieu d'une à plusieurs secondes avec Apps Script.
- **Solidité** : les règles de cohérence vivent dans la base (un seul compteur en cours, une
  session a une fin après son début, 24 h au plus), plus seulement dans le code.
- **Annuler** : l'API sait annuler la dernière action, puis celle d'avant (utilisé par l'agent).
  L'app n'a pas de bouton Annuler : les corrections passent par la fenêtre des sessions, plus sûre
  qu'un retour en arrière à l'aveugle.
- **Fenêtre des sessions** : une fenêtre qui s'ouvre partout (app web, app du téléphone,
  mini-fenêtre du PC) liste les sessions, permet d'en choisir une, de la supprimer ou de la
  corriger.
- **Widget stable** : plus de compteur qui saute ou qui avance sans raison.

Une seule personne utilise l'outil : la notion de personne disparaît du modèle.

## Critères de réussite

1. Médiane du temps entre un tap et la confirmation du serveur, mesurée depuis le téléphone en
   France : moins de 500 ms.
2. Chaque sorte d'action annulée remet exactement l'état d'avant (testé).
3. Le widget affiche le bon état après un redémarrage du téléphone, après minuit, après un
   changement d'heure du téléphone, et sous une série de taps rapides (testé ou vérifié à la main).
4. Après la reprise de l'historique, le nombre de lignes et le total d'heures par projet et par
   type sont identiques à ceux lus dans la Sheet (lignes écartées exceptées), au centième d'heure
   près.

## 1. Hébergement : Cloudflare Workers + D1

Un **Worker** Cloudflare sert à la fois l'API (`POST /api`) et l'app web (fichiers statiques de
`web/`). Les données vivent dans **D1**, la base SQLite de Cloudflare.

Pourquoi ce choix :

- **La logique reste en JavaScript.** Les règles métier de `Core.gs` se portent presque telles
  quelles, et leurs tests continuent de tourner dans Node, contre un vrai SQLite (`node:sqlite`,
  fourni avec Node 24).
- **Du HTTP simple.** Le widget Android est compilé sans Gradle, donc sans bibliothèque externe :
  il lui faut une API appelable avec un simple POST JSON. C'est déjà le protocole actuel, il est
  gardé tel quel.
- **Gratuit, sans mise en veille.** Offre gratuite : 100 000 requêtes Worker par jour, 5 millions
  de lignes lues et 100 000 écrites par jour dans D1, fichiers statiques gratuits et illimités.
  Un projet Supabase gratuit, lui, se met en pause après une semaine sans activité.
- **Une sauvegarde intégrée.** D1 garde l'historique de la base et permet de la remettre à
  n'importe quelle minute des 7 derniers jours (offre gratuite), sans rien configurer.
- **Une seule adresse.** L'app web et l'API partagent la même origine : plus de GitHub Pages, et
  le dépôt peut redevenir privé.

Écarté : Supabase (logique à réécrire en SQL, mise en veille), Firebase (son intérêt tient à ses
bibliothèques, inutilisables dans le widget sans Gradle), un serveur à soi (à maintenir).

Limite assumée : le temps réel vers le widget demanderait des notifications push (Firebase Cloud
Messaging), donc une bibliothèque. Le widget reste mis à jour au tap, à l'ouverture de l'app, et
toutes les 30 min (minimum imposé par Android).

Volume attendu : environ 25 lignes lues par lecture d'état ; avec une relecture toutes les 20 s
pendant 10 h, environ 2 000 requêtes et 50 000 lignes lues par jour. Largement sous les limites.

## 2. La base

Heures stockées en millisecondes UTC ; jours au format `aaaa-mm-jj`, au fuseau de Paris.

### `entries` — les sessions et les blocs

| Colonne | Type | Contenu |
|---|---|---|
| `id` | TEXT, clé | Identifiant créé par le client (idempotence) ou par la reprise |
| `project` | TEXT | Nom du projet (`projects.name`) |
| `kind` | TEXT | `session` ou `block` |
| `day` | TEXT | Jour de travail : jour du début pour une session, jour déclaré pour un bloc |
| `start_ms` | INTEGER | Début (session) ; vide pour un bloc |
| `end_ms` | INTEGER | Fin (session terminée) ; vide si le compteur tourne, ou pour un bloc |
| `hours` | REAL | Heures d'un bloc ; vide pour une session (sa durée se calcule, elle ne peut plus être périmée) |
| `type` | TEXT | Misc, Writing, Art, Dev… ou Pause |
| `note` | TEXT | Note libre, 500 caractères au plus |
| `source` | TEXT | `app`, `hors ligne`, `claude`, `report` |
| `created_ms` | INTEGER | Création (heure du serveur) |
| `touched_ms` | INTEGER | Dernière écriture (heure du serveur) |
| `deleted_ms` | INTEGER | Suppression ; vide si la ligne est active |

Règles posées dans la base :

- `kind = 'session'` ⇒ `start_ms` rempli et `hours` vide ; `kind = 'block'` ⇒ `start_ms` et
  `end_ms` vides et `hours` positif, sans plafond : les blocs repris de l'ancien formulaire ont des
  durées libres, jusqu'à 72 h pour une saisie groupée. L'API, elle, n'accepte que
  2 / 4 / 6 / 8 / 10 / 12 pour un nouveau bloc.
- `end_ms ≥ start_ms` et `end_ms − start_ms ≤ 24 h`. Une session de durée nulle est permise : une
  bascule avec décalage peut fermer l'ancien compteur à l'heure de son début.
- **Un seul compteur en cours** : index unique partiel sur les sessions actives sans fin. Deux
  appareils qui lancent en même temps ne peuvent pas créer deux compteurs.
- Une suppression est douce (`deleted_ms`) : toutes les lectures ignorent les lignes supprimées,
  et l'annulation les fait revenir.

Règle vérifiée par le code (SQLite ne sait pas l'exprimer) : deux sessions ne se chevauchent
jamais. Une correction ou une session d'agent qui chevaucherait une autre est refusée.

### `ops` — le journal des actions (pour annuler)

| Colonne | Contenu |
|---|---|
| `id` | Entier croissant |
| `at_ms` | Heure de l'action |
| `action` | `start`, `stop`, `pause`, `logBlock`, `deleteEntry`, `editEntry`… |
| `summary` | Phrase lisible : « Lancement Heirfall · Writing à 14:02 » |
| `source` | Canal (comme `entries.source`) |
| `changes` | JSON : pour chaque ligne touchée (table et clé), son état avant (vide si créée) et après |
| `undone_ms` | Heure de l'annulation ; vide si l'action tient |

Chaque écriture enregistre ses changements de lignes et son entrée de journal **dans la même
transaction** (`batch` de D1) : il ne peut pas y avoir de ligne modifiée sans trace, ni de trace
sans ligne.

### `projects` et `settings`

- `projects(name, position)` : l'ordre des boutons. Remplace l'ordre des onglets.
- `settings(key, value)` : `studio` (nom du projet studio), `visible` (nombre de boutons directs),
  `threshold` (seuil d'oubli, 8 h). Remplace `_Config`.

### `lockouts`

Compteur de codes refusés par adresse IP. Le Worker connaît l'adresse de l'appelant, ce
qu'Apps Script ne permettait pas : après 10 codes refusés en 15 min, **cette adresse** est bloquée
une heure, et plus tout le monde.

## 3. L'API

Même protocole qu'aujourd'hui : `POST /api`, `Content-Type: text/plain`, corps JSON
`{ "code": "…", "action": "…", … }`, réponse `{ ok, data }` ou `{ ok: false, error: { code,
message } }`. Les clients actuels n'ont donc qu'à changer d'adresse pour les actions existantes.

### Codes d'accès

Secrets du Worker, nommés comme aujourd'hui : `CODE_AMOHS_TELEPHONE`, `CODE_AMOHS_PC`,
`CODE_AMOHS_CLAUDE`… Les valeurs actuelles sont recopiées depuis les propriétés de l'Apps Script :
les appareils n'ont pas à ressaisir leur code. Un nom contenant le segment `CLAUDE` est un code
d'agent. 32 caractères au minimum. Comparaison à temps constant.

### Heure des actions

L'heure du serveur fait foi. Deux exceptions, comme aujourd'hui : une action rejouée hors ligne
(`clientTime`) et l'heure du tap du widget (`tapTime`). Dans les deux cas, jamais dans le futur, et
jamais avant le début du compteur en cours.

### Actions

Gardées, mêmes paramètres et même effet : `status`, `start`, `stop`, `note`, `logBlock`,
`logSession` (agent), `addProject`, `history`.

`status` gagne :

- `undo` : la prochaine action annulable, `{ opId, summary }`, ou rien ;
- `serverTime` remplace `now` (même valeur, nom explicite pour le recalage d'horloge du widget).

Nouvelles :

| Action | Paramètres | Effet |
|---|---|---|
| `undo` | `opId` | Annule l'action `opId`, à condition qu'elle soit **la dernière action non annulée**. Sinon refus : « Une autre action a eu lieu entre-temps. » |
| `deleteEntry` | `id` | Supprime une session ou un bloc (suppression douce). Supprimer le compteur en cours l'arrête sans rien compter. |
| `editEntry` | `id`, `start?`, `end?`, `hours?`, `project?`, `type?`, `note?` | Corrige une ligne. Session : début < fin ≤ maintenant, 24 h au plus, aucun chevauchement ; le jour suit le début. Bloc : heures dans 2 à 12. |

Retirée : `editLast`, remplacée par `editEntry` (qui corrige n'importe quelle ligne).

La fenêtre des sessions lit ses lignes avec `history` (déjà lecture seule, déjà avec les `id`) :
pas d'action de lecture en plus.

### Annuler (API)

Pas de bouton dans l'app (les corrections passent par la fenêtre des sessions) ; l'action reste
dans l'API, pour l'agent.

- Toute action d'écriture est annulable : `start` (y compris une bascule, qui a fermé le compteur
  d'avant), `stop`, `note`, `logBlock`, `logSession`, `addProject`, `deleteEntry`, `editEntry`.
- Annuler remet chaque ligne touchée dans son état d'avant, dans une seule transaction, et marque
  l'action annulée. Une ligne créée par l'action est marquée supprimée (pas effacée) : son `id`
  reste pris, donc une requête rejouée après l'annulation ne la recrée pas.
- Avant de restaurer, le serveur vérifie que chaque ligne est encore dans l'état laissé par
  l'action ; sinon il refuse. Annuler à nouveau vise l'action précédente :
  on remonte le temps une action à la fois.
- On n'annule que la dernière action non annulée : ses lignes n'ont pas pu être modifiées depuis,
  donc la restauration est toujours exacte.
- Il n'y a pas de « rétablir ». Une annulation de trop se corrige en refaisant l'action.
- Conséquence à connaître : annuler un arrêt rouvre le compteur ; s'il a été arrêté il y a deux
  heures, la session compte ces deux heures.
- L'annulation demande le réseau (elle porte l'`opId` lu dans l'état) ; hors ligne, le bouton est
  grisé.

### Garde-fous

- **Oubli** : comme aujourd'hui, l'app demande l'heure de fin quand le compteur tourne depuis plus
  de 8 h. Le widget affiche en plus « Compteur lancé il y a 9 h : touche pour corriger », qui ouvre
  l'app.
- Une session ne peut pas dépasser 24 h (règle de la base). Un compteur oublié plus de 24 h doit
  être fermé avec une heure de fin : l'écran d'oubli l'impose.

## 4. L'app web

Mêmes écrans, mêmes règles. Changements :

- **Adresse de l'API** : `/api` sur la même origine. L'APK garde une adresse complète.
- **« Dernier log »** disparaît : la fenêtre des sessions le remplace.
- **Relecture de l'état** toutes les 20 s quand la page est visible, et dès qu'elle redevient
  visible : un compteur lancé sur un autre appareil apparaît vite.

### La fenêtre des sessions

Une fenêtre par-dessus l'app, ouverte par un bouton « Sessions ».

```
┌──────────────────────────────────┐
│ Sessions                      ✕  │
│ ‹  Vendredi 2 oct.  ›            │  jour par jour, flèches
│ Total 6 h 40 · dont 25 min pause │
│──────────────────────────────────│
│ ● Heirfall · Writing             │
│   09:12 → 12:40   3 h 28    [⋯]  │
│ ● Heirfall · Pause               │
│   12:40 → 13:05   0 h 25    [⋯]  │
│ ● Fluffy · Dev       ⚠ 14 h 02   │  durée anormale signalée
│   13:05 → 03:07   14 h 02   [⋯]  │
│ ■ Bloc Studio · Misc   4 h  [⋯]  │
└──────────────────────────────────┘
```

- Un jour à la fois, aujourd'hui à l'ouverture, flèches pour reculer. Chargé par `history`.
- Chaque ligne : couleur du type, projet · type, début → fin, durée. Le compteur en cours est
  marqué « en cours ».
- Une session de plus de 8 h est signalée (⚠) : c'est le cas du bug d'hier.
- **[⋯]** ouvre la ligne : supprimer (avec confirmation), changer le début ou la fin (sélecteur
  d'heure natif), le projet, le type, la note. Un bloc : supprimer, changer ses heures.
- Partout : sur téléphone et dans l'app web, la fenêtre occupe l'écran ; depuis la mini-fenêtre du
  PC, un bouton ouvre une deuxième petite fenêtre Electron sur la page des sessions
  (`?vue=sessions`). C'est le même code dans les trois cas.

### Hors ligne

Inchangé : les actions sont gardées et rejouées avec leur heure. Les actions de la fenêtre des
sessions (supprimer, corriger) et l'annulation demandent le réseau : la fenêtre l'indique hors
ligne.

## 5. Le widget Android

Le principe reste : l'affichage change au tap, l'action part derrière dans une file. Ce qui
change :

1. **Serveur rapide** : la fenêtre entre le tap et la confirmation passe de plusieurs secondes à
   quelques centaines de millisecondes, ce qui réduit d'autant les occasions de conflit.
2. **Plus de comparaison d'horloges pour décider si un état est périmé.** Le widget compte ses
   taps (`tapSeq`). Une relecture note ce compteur au départ ; à son retour, elle n'est appliquée
   que si aucun tap n'a eu lieu entre-temps et que la file est vide. Aucune horloge n'intervient.
3. **Heure du tap recalée sur le serveur.** À chaque réponse, le widget mémorise l'écart entre
   l'heure du serveur et celle du téléphone, et l'applique à `tapTime`. Un téléphone qui avance ou
   retarde ne décale plus les sessions.
4. **Redessiné quand ses repères changent.** Les chronos d'Android sont calés sur le temps écoulé
   depuis l'allumage du téléphone, qui repart de zéro au redémarrage ; et le total
   « Aujourd'hui » doit repartir de zéro à minuit. Le widget se redessine donc au démarrage du
   téléphone, à un changement d'heure ou de fuseau, et à minuit (alarme, à quelques minutes près).
   C'est la cause probable du « compteur qui avance sans raison » ; le plan commence par
   reproduire ces deux cas pour le confirmer.
5. **Garde-fou d'oubli** : au-delà de 8 h, le message d'oubli remplace « Aujourd'hui » et ouvre
   l'app.
6. Relecture de l'état à chaque retour dans l'app (en plus du tap et des 30 min).

Le widget n'a ni annulation ni fenêtre des sessions : il ouvre l'app pour ça.

## 6. Mini-fenêtre de bureau

- L'adresse du site devient celle du Worker.
- Un bouton « Sessions » ouvre la fenêtre des sessions dans une deuxième fenêtre Electron.

## 7. Agent Claude

- Même variables d'environnement ; `KILOSAURUS_TEMPS_URL` prend la nouvelle adresse (`…/api`).
- Le skill documente `undo`, `deleteEntry`, `editEntry` et `entries`, et retire `editLast`.

## 8. Reprise de l'historique

1. Arrêter le compteur. Télécharger la Sheet : **Fichier → Télécharger → Microsoft Excel**.
2. `py tools/migrate_d1.py <fichier.xlsx>` lit les onglets de projet, `_Config` et l'ordre des
   onglets, et produit un fichier SQL : projets, réglages, lignes. Une ligne avec Début devient une
   session, sans Début un bloc (Source `report` gardée). Les types anciens (Autre, Narration) sont
   convertis.
3. Le script refuse de produire le fichier si une ligne viole une règle de la base (fin avant
   début, session de plus de 24 h, deux sessions qui se chevauchent, bloc sans durée positive,
   compteur en cours) et liste ces lignes. Chacune se corrige dans la Sheet, ou s'écarte explicitement avec
   `--exclude <id>`.
4. Les sessions plus longues que le seuil d'oubli (8 h) sont listées sans bloquer : la session de
   14 h d'hier en fait partie, et s'écarte avec `--exclude`. Les lignes dont la colonne Heures ne
   correspond plus à Début / Fin (modifiées à la main) sont listées aussi : la base recalcule la
   durée depuis Début / Fin.
5. Contrôle avant envoi (`tools/check_import.mjs`) : le fichier passe les règles de la base dans
   un SQLite local, et son nombre de lignes et ses totaux par projet et par type égalent ceux
   calculés par le script.
6. `npx wrangler d1 execute <base> --remote --file <fichier.sql>`, puis le nombre de lignes relu
   depuis la base.
7. `_Corrections` n'est pas reprise : le fichier téléchargé est gardé comme archive (jamais
   commité).

## 9. Bascule

Dans l'ordre, en une session de travail :

1. Le Worker et la base sont créés et testés (création du compte Cloudflare et connexion de
   `wrangler` : à faire par l'utilisateur, une fois).
2. Les codes sont recopiés de l'Apps Script vers les secrets du Worker.
3. Reprise de l'historique (§8).
4. Clients basculés : app web (déployée avec le Worker), APK reconstruit et réinstallé,
   mini-fenêtre, variable d'environnement de l'agent.
5. Le déploiement Apps Script est archivé ; la Sheet reste en lecture comme archive.
6. Le workflow GitHub Pages est retiré.

Retour arrière possible tant que l'étape 5 n'est pas faite : les clients repointent sur
l'Apps Script.

## 10. Code et tests

```
server/        worker.js (routage, codes, blocages, fichiers statiques), core.js (règles métier),
               store.js (requêtes SQL), schema.sql, wrangler.toml
web/           l'app, plus la fenêtre des sessions
android/       widget : tapSeq, recalage d'horloge, redessin au démarrage / changement d'heure / minuit
desktop/       nouvelle adresse, fenêtre des sessions
tools/         migrate_d1.py, dev-server.js (remplace fake-api.js), e2e.js
claude/        skill mis à jour
apps-script/   supprimé après la bascule (reste dans l'historique git)
```

- `core.js` ne parle qu'à une petite interface (`all`, `first`, `batch`) que fournissent à la fois
  D1 en production et `node:sqlite` dans les tests et le serveur de dev. Les mêmes requêtes SQL
  tournent dans les deux.
- **Tests Node** : toutes les règles actuelles de `core.test.js` portées ; les contraintes de la
  base (deux compteurs, fin avant début, plus de 24 h) ; chaque action annulée remet l'état exact,
  annulations en chaîne, refus d'annuler une action qui n'est plus la dernière ; `deleteEntry` et
  `editEntry` (chevauchement refusé) ; blocage par adresse ; reprise (`migrate_d1.py` sur un petit
  xlsx de test, contrôle des totaux).
- **Bout en bout** (`tools/e2e.js`) : lancer, annuler, ouvrir la fenêtre, supprimer, annuler la
  suppression.
- **Widget** : vérifié à la main sur le téléphone (redémarrage, minuit simulé en changeant l'heure,
  série de taps rapides, mode avion).
- **Réactivité** : l'app mesure la durée de chaque appel et l'affiche dans le détail du point de
  synchro, pour vérifier le critère 1.

## Hors périmètre

Rétablir après annulation, temps réel vers le widget (notifications push), plusieurs personnes,
export vers une Sheet, annulation depuis le widget.
