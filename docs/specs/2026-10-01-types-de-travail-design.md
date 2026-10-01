# Types de travail, total du jour et récaps — spécification

Complète la spec v1 (`2026-10-01-kilosaurus-temps-design.md`). Là où les deux divergent, celle-ci
l'emporte.

## Objectif

Savoir, sans effort, à quoi passe le temps : sur quel projet (Fluffy, Heirfall) et à quel type de
travail (Dev, Art, Narration, Autre). Changer de type en un tap pendant que le compteur tourne, voir
où en est la journée, et un récap simple de la semaine et du mois.

Succès :

- Un tap sur un type pendant une session bascule le type sans trou ni chevauchement.
- Le widget lance, bascule et met en pause par type.
- L'écran montre le total du jour (compteur en cours compris), une frise du jour colorée par type,
  un récap semaine et un récap mois.

## 1. Données

### Les types

Liste fixe, dans cet ordre : **Autre**, **Dev**, **Art**, **Narration**. Autre est le type par
défaut. Les types ne se modifient pas depuis l'app.

| Type | Couleur |
|---|---|
| Autre | `#9B20F9` (violet du logo) |
| Dev | `#3B82F6` (bleu) |
| Art | `#EC4899` (rose) |
| Narration | `#22C55E` (vert) |

Les mêmes couleurs servent aux boutons de l'app, au widget, à la frise et aux récaps.

### La colonne Type

Chaque onglet de projet gagne une colonne **L — Type**. Une cellule vide vaut **Autre** : tout
l'historique (report compris) compte donc comme Autre, sans réécrire la Sheet. L'en-tête « Type »
est posé automatiquement par le script sur un onglet qui ne l'a pas encore (à la première écriture,
et sur `_Modèle` avant chaque copie).

### Basculer de type

Une bascule de type est une bascule ordinaire : le morceau en cours est fermé et un nouveau est
ouvert à la même seconde, sur le même projet, avec le nouveau type. Aucune structure nouvelle :
la frise et les totaux se lisent directement dans les lignes.

Alternative écartée : journaliser les changements de type à part. Totaux et frise deviendraient
des reconstructions, pour aucun gain.

## 2. API

### `start` gagne un paramètre `type`

`start { id, project, type?, offsetMinutes?, note? }`

- `type` absent : le type du compteur en cours s'il y en a un, sinon Autre. Le widget de la v1,
  l'agent et tout ancien client restent donc valides.
- `type` hors de la liste : refusé (`invalid`).
- Même projet **et** même type que le compteur en cours : ne fait rien (relancer ce qui tourne
  déjà n'est pas une action). Même projet, autre type : bascule de type.
- Changer de projet garde le type que le client envoie ; l'app envoie toujours le type
  sélectionné.

`logBlock` et `logSession` acceptent aussi `type?` (défaut Autre). `editLast` ne corrige pas le
type.

### `status` gagne `types` et `today`

- `types` : la liste des types, dans l'ordre, avec leurs couleurs. Les clients ne codent pas la
  liste en dur.
- `running` et `last` portent `type`.
- `today` : mes lignes qui touchent la journée en cours (sessions commencées hier et encore en
  cours comprises), au format de `running`. Chaque écriture renvoyant `status`, la frise du jour est
  toujours fraîche sans appel supplémentaire.

### Nouvelle action `history`

`history { from, to }` (jours `aaaa-mm-jj`, inclus, 62 jours au plus) → mes lignes de la période,
au même format. Lecture seule, sans verrou. Sert aux récaps semaine et mois, appelée à l'ouverture
du récap.

## 3. L'app

### Écran principal

```
● Amohs                         ⚙
        HEIRFALL · Dev
          2:14:07      [ STOP ]
 [Autre] [Dev] [Art] [Narration]     type
 [  Fluffy  ]  [  Heirfall  ]        projets
 Aujourd'hui : 5 h 42
 ▕██▓▓▓░░██████▓▓▏                   frise du jour
 Récap : Semaine · Mois
 Déclarer 2…12 h · Autre jour…
 Dernier : Heirfall · Dev  09:12 → 12:40 · 3 h 28
```

- **Sélecteur de type** : quatre boutons aux couleurs des types, le type choisi est plein, les
  autres atténués. Compteur en cours : un tap bascule le type (requête `start` sur le projet en
  cours). Compteur arrêté : un tap choisit le type du prochain lancement. Le type choisi est gardé
  sur l'appareil.
- **Projets** : un tap lance le projet avec le type choisi (bascule si un autre tourne). Les
  projets sont les onglets de la Sheet (Fluffy, Heirfall…) ; un nouveau se crée par ⚙ → + Projet.
- **Studio** : plus de bouton spécial. L'onglet nommé dans `_Config` (« Onglet studio ») n'apparaît
  parmi les projets que si le réglage **⚙ → Afficher Studio** est coché. Réglage gardé sur
  l'appareil, décoché par défaut. Masqué ou non, son historique compte dans les totaux et récaps.
- **Blocs** (Déclarer, Autre jour) : enregistrés avec le type choisi.

### Total du jour et frise

- **Total du jour** : la part de chaque session comprise entre minuit et maintenant (une session
  commencée la veille ne compte que pour sa partie d'aujourd'hui), plus les blocs datés
  d'aujourd'hui. Le compteur en cours le fait avancer en direct.
- **Frise** : une barre qui commence à la plus tôt des deux heures entre 8 h et le début de la
  première session du jour, et finit à maintenant, avec repères d'heures. Chaque session y est un segment coloré par type ; les pauses
  restent vides. Les blocs n'ont pas d'heure : ils comptent dans le total mais n'apparaissent pas
  sur la frise.

### Récaps

Un panneau « Récap » à deux onglets, chargé par `history` à son ouverture.

- **Semaine** (lundi → dimanche, avec flèches semaine précédente / suivante) : sept barres
  empilées par type, total de chaque jour sous la barre, total de la semaine.
- **Mois** (avec flèches) : total du mois, puis une ligne par type et une ligne par projet (heures
  et part du total).

Règles de comptage communes : une session compte pour le jour de son début (comme la colonne Date),
sauf le total et la frise du jour, découpés à minuit (ci-dessus). Les heures d'un compteur en cours
vont jusqu'à maintenant.

### Hors ligne

L'état optimiste (`applyLocal`) tient aussi `today` à jour : une bascule de type ou de projet
hors ligne s'affiche tout de suite sur la frise. Le récap demande le réseau ; hors ligne, il
l'indique.

## 4. Widget Android

- Titre : le projet du compteur en cours, sinon celui choisi dans le réglage du widget. Chrono
  comme aujourd'hui.
- Quatre boutons, un par type, aux couleurs des types ; celui du compteur en cours est mis en
  évidence.
- Un tap sur un type :
  - compteur arrêté → `start` sur le projet du widget, avec ce type ;
  - compteur en cours d'un autre type → `start` sur le projet en cours, avec ce type (bascule) ;
  - compteur en cours de ce type → `stop` (pause).
- Taille de départ : 4 × 2 cases.

## 5. Agent Claude

Le skill documente `type` sur `start`, `logSession` et `logBlock` (défaut Autre) et l'action
`history`.

## 6. Icônes

`kilo_logo.png` (racine du dépôt, 392 × 392, fond `#9B20F9`) devient l'icône partout :
`web/icons/` (192, 512, 180 pour iPhone, 512 masquable avec marge de fond violet) et les icônes de
lancement Android (`mipmap-xxhdpi` 144, `mipmap-xxxhdpi` 192). `tools/make_icons.py` les génère
toutes depuis ce fichier.

## 7. Tests

- **Node** : `start` avec type (défaut, bascule de type, même projet même type sans effet, type
  refusé), `status.today` (session d'hier encore en cours), `history` (bornes, 62 jours),
  calculs de l'app (total du jour découpé à minuit, segments de frise, agrégats semaine et mois,
  `applyLocal` sur `today`).
- **runSelfTest** : ajoute une bascule de type et vérifie la colonne Type.
- **Bout en bout** (`tools/e2e.js`) : choisir un type, lancer, basculer, ouvrir le récap.

## Hors périmètre

Types modifiables depuis l'app, correction du type d'une ligne, export, récap à l'année, objectifs
d'heures.
