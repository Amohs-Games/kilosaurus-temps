# Kilosaurus Temps — plusieurs tâches en cours

> Remplace, dans `2026-10-12-taches-actives-design.md`, la tâche active unique et la règle du lien
> (§ 2, § 3, § 5). Le reste tient : une tâche montrée ne pilote rien, le temps d'une tâche est la
> somme des morceaux passés dessus, la mini-fenêtre ouvre le panneau chez elle.
>
> **Remplacée en partie** par `2026-10-13-activites-paralleles-design.md` : une tâche ne reçoit plus
> le temps entier d'un morceau mais sa part (le temps est partagé entre les tâches au calcul, jamais
> en base), et la rangée Activité disparaît quand des tâches sont en cours.

## Objectif

Travailler avec des agents, c'est mener plusieurs features à la fois. Plusieurs tâches peuvent donc
être actives ensemble, et **chacune reçoit le temps entier** pendant lequel elle était active : trois
tâches actives pendant une heure prennent chacune une heure. Le total de la journée reste celui du
compteur ; seule la somme des temps par tâche dépasse la journée, et c'est voulu.

## Critères de réussite

1. Deux tâches actives, compteur en marche une heure : chacune reçoit une heure (testé).
2. Les tâches actives comptent quel que soit le projet du compteur ; changer de projet ou d'activité
   ne désactive rien (testé).
3. Activer une tâche de plus, en désactiver une ou en valider une, compteur en marche : le morceau en
   cours se ferme et un autre s'ouvre à la même seconde avec la nouvelle liste (testé).
4. Pause et stop ne comptent pour aucune tâche ; REPRENDRE et ▶ repartent avec toutes les tâches
   actives (testé).
5. Une base et des clients d'avant (une seule tâche active, `entries.task_id`) passent sans perte
   (testé sur une copie de la vraie base).

## 1. Données

- `entries.task_ids` (renommée depuis `task_id`) : les ids des tâches actives pendant ce morceau,
  séparés par des virgules, dans l'ordre d'activation ; vide = aucune. Un id de tâche ne contient
  donc jamais de virgule (refusé à l'ajout). `archive_entries` suit.
- L'index `entries_task` disparaît : le temps des tâches se lit par la date (index `entries_start`),
  à partir de la création de la plus ancienne tâche affichée — un morceau ne peut pas être plus
  ancien que sa tâche.
- Réglage `active_tasks` : la liste JSON des ids actifs, dans l'ordre d'activation (10 au plus).
  L'ancien réglage `active_task` est lu s'il est seul, et retiré à la première écriture.
- Migration : `server/migrations/2026-10-13-taches-paralleles.sql` (deux `RENAME COLUMN`, un
  `DROP INDEX`), avant le déploiement. Les morceaux déjà liés gardent leur tâche (liste d'un élément).

### Ce que montre `status`

- `activeTasks` : les ids actifs, dans l'ordre d'activation (seulement des tâches à faire, non
  supprimées). `activeTask` reste, pour les clients d'avant : la dernière activée, ou `null`.
- `running.tasks` (et chaque ligne de `today`, `last`, `history`) : la liste des tâches du morceau.
  `task` reste : la dernière de la liste, ou `null`.
- `tasks[].spentMs` : inchangé (morceaux terminés, non supprimés, qui contiennent la tâche).

## 2. Règles (serveur)

- **Le lien** : un morceau qui s'ouvre (hors Pause) reçoit toutes les tâches actives, quel que soit
  son projet ou son activité. Un morceau Pause n'en reçoit aucune.
- **La bascule** compare projet, activité et liste des tâches : si l'un change, le morceau en cours se
  ferme et un autre s'ouvre à la même seconde (mêmes exceptions qu'avant : pas de compteur, pause,
  compteur oublié).

| Action | Effet |
|---|---|
| `activateTask { id }` | Ajoute la tâche à la fin de la liste active ; son projet et son activité deviennent le choix ; compteur en marche : bascule. Déjà active : rien. 10 actives au plus. |
| `deactivateTask { id? }` | Retire la tâche (toutes sans `id`) ; le choix ne change pas ; compteur en marche : bascule avec la nouvelle liste. |
| `checkTask` | Valide ; une tâche active est retirée de la liste, comme `deactivateTask`. |
| `deleteTask` | Une tâche active est retirée de la liste. |
| `editTask` | La liste seulement : ne touche ni au choix ni au compteur. |
| `start`, `select` | Ne désactivent plus rien ; le morceau ouvert reçoit les tâches actives. |
| `stop` | Ne touche pas aux tâches actives. |

## 3. Écran

- **Section « En cours »**, au-dessus de la rangée Activité (qui reste) : une ligne par tâche active —
  description, « projet · activité », temps passé en direct, ✓ (valider) et ✕ (désactiver).
- **Ligne du haut** : la première tâche à faire qui n'est pas active, avec ▶ ; sinon le lien
  « Tâches ».
- **Panneau** : ▶ sur chaque tâche non active, « en cours » sur les actives.

## 4. Hors ligne et agent

`logic.js` rejoue les mêmes règles. Le skill décrit `activeTasks`, `running.tasks`,
`deactivateTask { id? }` et la nouvelle règle.

## Limites connues

- Le widget Android ne change pas : son ▶ lance « dernier projet · Writing » avec toutes les tâches
  actives (il ne désactive plus rien).
- Les copies de bureau d'avant la migration ont `task_id` ; une restauration depuis l'une d'elles
  perd les liens de ce jour-là (pas les sessions).

## Tests

Serveur : critères 1 à 4, chaque ligne du tableau, l'ancien réglage `active_task`, la limite de 10,
un id de tâche avec une virgule refusé, la migration sur un schéma d'avant. Client : les mêmes
scénarios. Bout en bout : deux tâches activées, la section « En cours », valider l'une.
