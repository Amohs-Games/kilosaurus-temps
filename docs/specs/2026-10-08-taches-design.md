# Kilosaurus Temps — liste de tâches et sélecteur de projet

> S'ajoute à `2026-10-03-base-de-donnees-design.md` (base, journal `ops`, hors ligne) et à
> `2026-10-08-sauvegardes-design.md` (journées figées, copie de bureau). Remplace, pour l'écran
> principal, les boutons de projet qui lancent le compteur.
>
> **Remplacée en partie** par `2026-10-12-taches-actives-design.md` : la règle de la tâche du haut
> (§ 5) n'existe plus, une tâche ne pilote le compteur qu'une fois activée, et son temps est la somme
> des morceaux passés dessus.

## Objectif

- **Préparer sa journée le matin** : une liste de tâches (description, activité, projet), qu'on
  ajoute, modifie, supprime et réordonne.
- **Dérouler sans s'occuper du compteur** : l'écran principal montre la tâche du haut ; la cocher
  fait monter la suivante, et le compteur passe tout seul sur son projet et son activité.
- **Tout marche sans tâche** : le sélecteur de projet, la rangée d'activités et le gros ▶ suffisent.
- **Garder la trace** : chaque tâche faite garde son jour, son début et sa fin, pour des stats
  futures. Rien de ce temps n'est affiché pour l'instant.
- Partout pareil : app web, app du téléphone, mini-fenêtre, agent. **Le widget Android ne change
  pas.**

## Critères de réussite

1. Cocher la tâche du haut, compteur en marche, ferme la session en cours et ouvre la suivante à la
   même seconde, sur le projet et l'activité de la tâche suivante (testé).
2. Un changement manuel de projet ou d'activité n'est jamais écrasé tant que la tâche du haut ne
   change pas (testé).
3. Une coche hors ligne, rejouée plus tard, bascule le compteur à l'heure du tap (testé).
4. Annuler une coche remet la tâche, le compteur et le choix exactement comme avant (testé).
5. À 6 h, les tâches cochées la veille disparaissent du panneau sans qu'aucune donnée ne soit
   effacée ; les tâches non cochées restent (testé).
6. Les tâches sont dans les sauvegardes (copie de bureau et journées figées) et reviennent à la
   restauration (testé par l'aller-retour existant).

## 1. Vocabulaire

- **Tâche** : un élément de la liste du jour.
- **Activité** : ce que l'app appelait « Tâche » au-dessus de la rangée colorée (Misc, Writing,
  Market…). Seul le libellé change ; dans le code et l'API, c'est toujours `type`.
- **Le choix** : le projet et l'activité sélectionnés. Compteur en marche, c'est ce qui tourne ;
  arrêté ou en pause, c'est ce que lancera ▶ ou Reprendre. Un seul choix, gardé sur le serveur,
  le même sur tous les appareils.

## 2. Écran principal

```
┌──────────────────────────────────────┐
│ ●  amohs                          ⚙  │
│ [bandeau des sauvegardes si besoin]   │
│  ☐  Répondre aux mails éditeur    ›  │  ← la tâche du haut
│     Heirfall · Market                │
│                                      │
│  Heirfall · Market                   │
│            5:12:40                   │  ← travail du jour (déjà en place)
│         Session 1:24:07              │
│          Pause 0:05:00               │
│                                      │
│ [Fluffy] [■Heirfall■] [Studio]       │  ← sélecteur
│  ┌────────────────────────────────┐  │
│  │          ▶  LANCER             │  │  ← à l'arrêt
│  └────────────────────────────────┘  │
│   (en marche : [⏸ PAUSE] [■ STOP])   │
│   (en pause : [▶ REPRENDRE] [■ STOP])│
│  Activité                            │
│  [Misc] [Market] [Social] …          │
└──────────────────────────────────────┘
```

- **La tâche du haut** : description, puis « projet · activité » en petit. ☐ la coche. Un appui
  sur la ligne ou sur › ouvre le panneau Tâches. Sans tâche à faire, la ligne devient un lien
  « + Tâches ».
- **Le sélecteur** : une ligne de petits boutons de projet, contour gris clair, le choisi en blanc
  plein. Mêmes règles d'affichage qu'aujourd'hui (4 projets, puis « Plus… » ; Studio masquable).
  - Compteur en marche : toucher un projet **bascule** le compteur sur ce projet, même activité,
    à la même seconde.
  - Arrêté ou en pause : toucher un projet change le choix ; rien d'autre.
- **Le gros bouton** : vert « ▶ LANCER » à l'arrêt, sur le choix. En marche : PAUSE et STOP. En
  pause : REPRENDRE (sur le choix) et STOP.
- **La rangée Activité** : même comportement qu'aujourd'hui (en marche, bascule ; sinon change le
  choix), mais le choix est celui du serveur, plus celui de l'appareil.
- La mini-fenêtre montre la même chose, en compact.

## 3. Panneau Tâches

```
┌──────────────────────────────────────┐
│  Tâches                          ✕   │
│ ≡ ☐ Répondre aux mails éditeur       │
│      Heirfall · Market               │
│ ≡ ☐ Appel avec Léa                   │
│      Studio · Social                 │
│  [ + Ajouter une tâche ]             │
│  Faites aujourd'hui                  │
│   ☑ Relire la spec        (barré)    │
└──────────────────────────────────────┘
```

- **À faire**, dans l'ordre choisi ; la première est celle de l'écran principal.
- **Faites aujourd'hui** : cochées depuis le dernier 6 h, dans l'ordre des coches. Les décocher les
  remet à leur place dans la liste.
- **Réordonner** : glisser la poignée ≡ (au doigt comme à la souris ; événements *pointer*, la
  poignée seule déclenche le glissement pour que la liste défile normalement).
- **Ajouter** : une fiche avec la description (200 caractères au plus), une rangée d'activités et
  une rangée de projets ; par défaut, le choix du moment. La tâche se place à la fin.
- **Modifier** : un appui sur une tâche ouvre la même fiche, avec **Supprimer**.
- Où il s'ouvre : par-dessus l'écran (comme Récap) dans l'app et sur le site ; dans une deuxième
  fenêtre dans la mini-fenêtre (`?vue=taches`, comme `?vue=sessions`).

## 4. Données

### Table `tasks`

| Colonne | Rôle |
|---|---|
| `id` TEXT PK | créé par le client (idempotence, comme `entries`) |
| `description` TEXT | 1 à 200 caractères, sans caractère de contrôle |
| `project` TEXT, `type` TEXT | projet existant, activité connue (pas Pause) |
| `position` INTEGER | ordre dans la liste à faire |
| `started_ms`, `done_ms` INTEGER | posés à la coche, vidés à la décoche |
| `source`, `created_ms`, `touched_ms`, `deleted_ms` | comme `entries` (suppression douce) |

Index : `(deleted_ms, done_ms, position)` pour lire la liste, `done_ms` pour les faites du jour.

### Le choix

Deux réglages : `choice_project`, `choice_type`. Absents : le dernier projet travaillé et Misc.

### Ce qui est montré

`status` gagne :
- `tasks` : les tâches à faire (ordre de `position`), puis les faites depuis le dernier 6 h ;
- `choice` : `{ project, type }`.

Une tâche cochée avant le dernier 6 h n'est plus renvoyée par `status`, mais reste en base.
Aucun nettoyage n'a lieu à 6 h : c'est la lecture qui filtre.

## 5. Règles (serveur, `core.js`)

### La tâche du haut

La tâche du haut est la première tâche à faire, non supprimée. Chaque action sur les tâches compare
la tâche du haut avant et après. **Si elle a changé** (autre tâche, ou même tâche dont le projet ou
l'activité a été modifié), son projet et son activité deviennent le choix, dans la même transaction :
- **compteur en marche (hors pause)** : la session en cours se ferme et une nouvelle s'ouvre à la
  même seconde, comme une bascule `start` ; rien si le compteur tourne déjà sur ce projet et cette
  activité ;
- **en pause** : la pause continue ; seul le choix change (Reprendre partira dessus) ;
- **arrêté** : seul le choix change.

Une liste qui devient vide ne change rien.

### Le choix manuel

- `select { project?, type? }` : change le choix ; compteur en marche hors pause, bascule à la même
  seconde (même règle que la rangée Activité aujourd'hui) ; en pause ou arrêté, ne touche pas au
  compteur.
- `start` (▶, Reprendre, widget, agent) met aussi le choix au projet et à l'activité lancés (sauf
  Pause). Le widget ne change pas : il lance toujours « dernier projet · Writing », et le choix suit.
- Le choix manuel commande jusqu'au prochain changement de la tâche du haut.

### Actions sur les tâches

| Action | Paramètres | Effet |
|---|---|---|
| `addTask` | `id`, `description`, `project?`, `type?` | à la fin ; défaut : le choix |
| `editTask` | `id`, `description?`, `project?`, `type?` | |
| `deleteTask` | `id` | suppression douce |
| `moveTask` | `id`, `before` (id ou `null` = à la fin) | réécrit `position` des tâches à faire |
| `checkTask` | `id` | `done_ms` = heure de l'action ; `started_ms` = la coche précédente du même jour de travail, sinon 6 h ce jour-là |
| `uncheckTask` | `id` | vide `done_ms` et `started_ms` |

Toutes passent par le journal `ops` (annulables d'un bloc, avec la bascule et le choix qu'elles ont
provoqués), acceptent l'heure du tap hors ligne (`clientTime`), et sont idempotentes (même `id`
de tâche, même état visé : rien ne s'écrit deux fois). Le journal sait donc écrire trois tables de
plus : `tasks`, `settings` (le choix) et toujours `entries`.

### Temps d'une tâche (pour plus tard)

Début = `started_ms`, fin = `done_ms`. Le temps de la tâche est ce que le compteur a compté entre
les deux, pauses exclues, calculé à partir des sessions au moment d'en faire des stats. Une tâche
décochée puis recochée prend les heures de sa dernière coche.

## 6. Hors ligne

`logic.js` applique localement les nouvelles actions (`select`, actions sur les tâches) et la règle de
la tâche du haut, pour que l'écran réagisse au tap ; la réponse du serveur remplace l'état comme
aujourd'hui. La règle existe donc deux fois (serveur et client) : les mêmes scénarios sont testés des
deux côtés.

## 7. Sauvegardes

- `tasks` rejoint les tables exportées (`server/backup.js`) : copie de bureau, empreinte et
  restauration la prennent sans autre changement (le test de parité du schéma l'exige).
- Journées figées : `archive_tasks` (mêmes colonnes + `archived_day`, mêmes triggers) reçoit, pour
  le jour de travail J, les tâches cochées entre 6 h J et 6 h J+1, telles qu'elles sont à ce moment.
- Figer un jour coûte alors 3 instructions : **14 jours au plus par appel** du cron (au lieu de 20)
  pour rester sous les 50 requêtes D1.

## 8. Agent Claude

Le skill gagne les actions sur les tâches et `select`, et `status` y décrit `tasks` et `choice`.

## 9. Mini-fenêtre

`main.js` ouvre `?vue=taches` dans une deuxième fenêtre, comme `?vue=sessions`. Cette partie demande
de redémarrer la mini-fenêtre une fois après la mise à jour.

## 10. Tests

- Serveur : chaque action ; la règle de la tâche du haut dans les trois états du compteur ; le choix
  manuel qui n'est pas écrasé ; l'heure du tap hors ligne ; l'annulation d'une coche avec bascule ;
  `started_ms` (première du jour à 6 h, suivantes à la coche précédente, changement de jour de
  travail) ; le filtre de 6 h ; idempotence.
- Client : `applyLocal` sur les mêmes scénarios que le serveur.
- Sauvegardes : parité du schéma avec `tasks` et `archive_tasks` ; gel des tâches du jour ; budget
  de requêtes à 14 jours ; aller-retour.
- Bout en bout (`tools/e2e.js`) : ajouter, cocher, réordonner, et la bascule visible.

## Hors périmètre

- Affichage du temps par tâche et stats.
- Widget Android.
- Tâches récurrentes, échéances, sous-tâches.
