# Types de travail, total du jour et récaps — spécification

Complète la spec v1 (`2026-10-01-kilosaurus-temps-design.md`). Là où les deux divergent, celle-ci
l'emporte.

## Objectif

Savoir, sans effort, à quoi passe le temps : sur quel projet (Fluffy, Heirfall) et à quel type de
travail (Misc, Art, Dev, Writing). Changer de type en un tap pendant que le compteur tourne, voir
où en est la journée, et un récap simple de la semaine et du mois.

Succès :

- Un tap sur un type pendant une session bascule le type sans trou ni chevauchement.
- Le widget lance, bascule et met en pause par type.
- L'écran montre le total du jour (compteur en cours compris), une frise du jour colorée par type,
  un récap semaine et un récap mois.

## 1. Données

### Les types

Liste fixe, dans cet ordre : **Misc**, **Art**, **Dev**, **Writing**, **UI**, **Gameplay**,
**Sound**, **Market**. Misc est le type par défaut. Les types ne se modifient pas depuis l'app.

| Type | Couleur |
|---|---|
| Misc | `#9B20F9` (violet du logo) |
| Art | `#EC4899` (rose) |
| Dev | `#3B82F6` (bleu) |
| Writing | `#22C55E` (vert) |
| UI | `#06B6D4` (cyan) |
| Gameplay | `#F97316` (orange) |
| Sound | `#CA8A04` (ambre) |
| Market | `#64748B` (gris-bleu) |

Les mêmes couleurs servent aux boutons de l'app, au widget, à la frise et aux récaps.

**Anciens noms.** La première version s'appelait Autre, Dev, Art, Narration. `Autre` se lit `Misc`
et `Narration` se lit `Writing`, à la lecture des lignes comme à la réception d'une requête : la
Sheet n'est pas réécrite, et un client pas encore mis à jour continue de fonctionner. Les nouvelles
lignes sont écrites avec les nouveaux noms.

### La colonne Type

Chaque onglet de projet gagne une colonne **L — Type**. Une cellule vide vaut **Misc** : tout
l'historique (report compris) compte donc comme Misc, sans réécrire la Sheet. L'en-tête « Type »
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

- `type` absent : le type du compteur en cours s'il y en a un, sinon Misc. Le widget de la v1,
  l'agent et tout ancien client restent donc valides.
- `type` hors de la liste : refusé (`invalid`).
- Même projet **et** même type que le compteur en cours : ne fait rien (relancer ce qui tourne
  déjà n'est pas une action). Même projet, autre type : bascule de type.
- Changer de projet garde le type que le client envoie ; l'app envoie toujours le type
  sélectionné.

`logBlock` et `logSession` acceptent aussi `type?` (défaut Misc). `editLast` ne corrige pas le
type.

### `status` gagne `types` et `today`

- `types` : la liste des types, dans l'ordre, avec leurs couleurs. L'app web s'en sert (avec la
  liste ci-dessus en secours, pour un état mis en cache par une version précédente). Le widget, à
  disposition fixe, a ses quatre boutons en dur.
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

L'écran se lit de haut en bas dans l'ordre de l'usage : ce qui tourne, choisir un type, lancer un
projet, voir sa journée, ajouter du temps après coup, corriger la dernière entrée.

```
● Amohs                                   ⚙
 ┌ Maintenant ─────────────────────────┐
 │        HEIRFALL · DEV                │   au repos : « Rien en cours —
 │          2:14:07                     │   choisis un type, puis lance
 │        [   STOP   ]                  │   un projet. »
 └──────────────────────────────────────┘
 TYPE
 [Misc] [Art] [Dev] [Writing]
 [UI] [Gameplay] [Sound] [Market]
 LANCER
 [ ▶ Fluffy ]  [ ● Heirfall  en cours ]    couleur du type choisi
 ┌ Aujourd'hui  5 h 42          Récap ┐
 │ ▕██▓▓▓░░██████▓▓▏                   │
 └──────────────────────────────────────┘
 AJOUTER DES HEURES
 [2] [4] [6] [8] [10] [12]  · Autre jour…
 ┌ Dernière entrée · Heirfall · Dev ───┐
 │ 09:12 → 12:40 · 3 h 28              │
 └──────────────────────────────────────┘
```

- **Sélecteur de type** : un bouton par type (quatre par rangée), aux couleurs des types ; le type
  choisi est plein, les autres atténués. Compteur en cours : un tap bascule le type (requête
  `start` sur le projet en cours). Compteur arrêté : un tap choisit le type du prochain lancement.
  Le type choisi est gardé sur l'appareil.
- **Projets** (section « Lancer ») : ce sont les boutons qui démarrent le compteur. Chacun porte ▶
  et prend la couleur du type choisi ; le projet en cours est plein, marqué « ● en cours ». Un tap
  lance le projet avec le type choisi (bascule si un autre tourne). Les projets sont les onglets de
  la Sheet (Fluffy, Heirfall…) ; un nouveau se crée par ⚙ → + Projet.
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

Le téléphone sert à un seul usage (écrire) : le widget est un simple lecture / stop, sans choix de
type. Les types se choisissent dans l'app.

- Titre : « projet · type » du compteur en cours, sinon « projet du widget · Writing ».
- Deux compteurs : la session en cours (grand) et le total du jour (petit, « Aujourd'hui »), qui
  avance avec la session. Le total du jour vient de `status.today` (sessions découpées à minuit,
  plus les blocs du jour).
- Un seul bouton :
  - compteur arrêté → ▶ : `start` sur le projet choisi dans le réglage du widget, type **Writing** ;
  - compteur en cours (quel que soit son projet ou son type, lancé ici ou ailleurs) → ■ : `stop`.
- **Zéro attente** : l'état affiché est celui du téléphone. Un tap le change aussitôt, sans réseau,
  et chaque tap compte, même pendant un envoi. Les actions partent derrière, dans une file, une par
  une et dans l'ordre, avec `tapTime` (l'heure du tap, que le serveur retient : la Sheet suit ce que
  le widget a montré). Sans réseau, la file attend et repart toute seule (nouvel essai toutes les
  minutes, à chaque tap et à chaque rafraîchissement). Tant que la file n'est pas vide, l'état du
  serveur ne remplace pas celui du widget ; une fois vide, l'état du serveur fait foi. Une action
  refusée par le serveur est retirée de la file et le widget se recale sur le serveur.
- Taille de départ : 3 × 1 case, redimensionnable.

## 5. Agent Claude

Le skill documente `type` sur `start`, `logSession` et `logBlock` (défaut Misc) et l'action
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
