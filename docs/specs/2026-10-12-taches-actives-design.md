# Kilosaurus Temps — tâches qu'on active

> Remplace, dans `2026-10-08-taches-design.md`, la règle de la tâche du haut (§ 5) et le temps d'une
> tâche calculé entre deux coches. Le reste de cette spec (liste, panneau, fiche, sauvegardes)
> tient toujours.
>
> **Remplacée en partie** par `2026-10-13-taches-paralleles-design.md` : plusieurs tâches peuvent
> être en cours à la fois, chacune reçoit le temps entier, et changer de projet ne désactive plus rien.

## Objectif

- **Une tâche se montre, elle ne pilote rien** tant qu'on ne l'a pas activée. Sans tâche active,
  on travaille sans tâche : c'est l'état normal, plus une exception.
- **Activer une tâche** la met au volant : son projet et son activité deviennent le choix, et le
  temps compté s'inscrit sur elle.
- **Le temps d'une tâche est un vrai cumul** : la somme des morceaux de compteur passés dessus, sur
  autant de jours qu'il faut. Une pause ou un stop ne la perd pas : on la reprend plus tard.
- **Valider** une tâche, depuis l'écran principal quand elle est active ou depuis le panneau, la
  sort de la liste.
- Mini-fenêtre : plus de barre de défilement, et le panneau des tâches s'ouvre dans la même fenêtre.

## Critères de réussite

1. Activer une tâche compteur en marche ferme le morceau en cours et en ouvre un sur la tâche à la
   même seconde, même si le projet et l'activité ne changent pas (testé).
2. Un STOP, une pause puis REPRENDRE, ou un STOP puis ▶ gardent la tâche active ; le morceau repris
   s'inscrit sur elle (testé).
3. Toucher un autre projet (ou une autre activité, par l'agent) désactive la tâche, et le compteur
   bascule comme aujourd'hui (testé).
4. Valider la tâche active compteur en marche laisse le compteur tourner, même projet, même
   activité, sans tâche, à la même seconde (testé).
5. Cocher, ajouter, déplacer ou supprimer une tâche non active ne touche jamais au choix ni au
   compteur (testé).
6. Le temps d'une tâche est la somme de ses morceaux terminés, non supprimés ; l'écran ajoute en
   direct le morceau en cours (testé côté serveur et côté client).
7. Annuler une activation, une désactivation ou une validation remet tâche, compteur et choix
   exactement comme avant (testé).
8. Mini-fenêtre : aucune barre de défilement ; le panneau des tâches s'ouvre à la place de l'écran
   principal, la fenêtre prend sa hauteur, ✕ revient à l'écran principal.

## 1. Vocabulaire

- **Tâche active** : la tâche au volant, une au plus, la même sur tous les appareils.
- **Morceau** : une session du compteur (une ligne `entries` de type session). Une bascule ferme un
  morceau et en ouvre un autre à la même seconde.
- **Valider** : ce que l'app appelait « cocher ». Dans l'API, c'est toujours `checkTask`.

## 2. Données

- `entries.task_id` (TEXT, vide par défaut) : la tâche sur laquelle ce morceau a tourné. Posé à
  l'ouverture du morceau, jamais modifié ensuite (une correction de la ligne le garde). Les blocs
  d'heures et les sessions loguées par l'agent n'en ont pas. `archive_entries` reçoit la même
  colonne, au même rang (dernière), pour que figer un jour copie le lien.
- Index `entries_task ON entries (task_id)` : lire le temps des tâches ne relit pas l'historique.
- Réglage `active_task` : l'id de la tâche active ; absent = aucune. Le serveur ne la renvoie que si
  elle est encore à faire et non supprimée (un réglage qui pointerait ailleurs, après une
  annulation par exemple, vaut « aucune »).
- `tasks.started_ms` change de sens pour les tâches validées désormais : le début du premier morceau
  passé dessus, vide si aucun. Les tâches déjà validées gardent leur ancienne valeur.

### Ce que montre `status`

- `activeTask` : l'id de la tâche active, ou `null`.
- `running.task` (et chaque ligne de `today`, `last`, `history`) : l'id de la tâche du morceau, ou
  `null`.
- Chaque tâche de `tasks` gagne `spentMs` : la somme des morceaux terminés et non supprimés liés à
  elle. Le morceau en cours n'y est pas : l'écran l'ajoute en direct.

### Mise à jour d'une base existante

`schema.sql` ne crée que ce qui manque : la colonne s'ajoute avec
`server/migrations/2026-10-12-taches-actives.sql` (deux `ALTER TABLE` et l'index), **avant**
`npm run db:schema` et le déploiement. Sauvegarde manuelle avant, comme pour toute modification du
schéma.

## 3. Règles (serveur, `core.js`)

La règle de la tâche du haut disparaît : ajouter, déplacer, supprimer, valider ou dévalider une
tâche **non active** ne change ni le choix ni le compteur.

Une seule notion porte tout : **le lien**. Un morceau qui s'ouvre sur un projet et une activité
reçoit la tâche active si elle a exactement ce projet et cette activité ; sinon aucun lien, et la
tâche active est désactivée (on est parti travailler sur autre chose). Un morceau Pause n'a jamais
de lien et ne désactive rien.

La bascule (`switchTo`) compare désormais le projet, l'activité **et le lien** : si l'un change,
le morceau en cours se ferme et un autre s'ouvre à la même seconde. Mêmes exceptions qu'avant :
rien sans compteur, en pause, ou compteur oublié (plus de 24 h).

| Action | Effet |
|---|---|
| `activateTask { id }` | Tâche à faire, non supprimée. Devient active ; son projet et son activité deviennent le choix ; compteur en marche : bascule sur elle (lien compris). Déjà active : rien. Une autre était active : elle est remplacée. |
| `deactivateTask {}` | Plus de tâche active ; le choix ne change pas ; compteur en marche sur la tâche : bascule à la même seconde, même projet, même activité, sans lien. |
| `checkTask { id }` | Valide. `done_ms` = heure de l'action, `started_ms` = début du premier morceau lié. Si c'est la tâche active : désactivée, avec la bascule sans lien de `deactivateTask`. |
| `uncheckTask { id }` | Reprend sa place dans la liste, non active. |
| `editTask` | Si c'est la tâche active et que son projet ou son activité change : le choix suit, et le compteur en marche bascule (lien gardé). |
| `deleteTask` | Si c'est la tâche active : désactivée, comme `deactivateTask`. |
| `addTask`, `moveTask` | La liste seulement. |
| `start` | Le lien selon la règle ci-dessus. Un `start` sur un autre projet ou une autre activité que la tâche active la désactive. Pause : pas de lien, la tâche reste active ; REPRENDRE (start sur le choix) repart donc dessus. |
| `select` | Un projet ou une activité différents de ceux de la tâche active la désactivent ; puis comme avant. |
| `stop` | Ne touche pas à la tâche active : le prochain ▶ repart dessus. |

Toutes passent par le journal `ops` (une action = une entrée, annulable d'un bloc avec la bascule
et les réglages qu'elle a provoqués), acceptent l'heure du tap hors ligne et sont idempotentes.

### Temps d'une tâche

`SUM(end_ms - start_ms)` des sessions terminées, non supprimées, liées à la tâche, pour les tâches
renvoyées par `status` (une seule requête, par l'index). Corriger ou supprimer un morceau corrige
donc le temps de sa tâche sans autre écriture.

## 4. Hors ligne (`logic.js`)

`applyLocal` rejoue les mêmes règles (lien, bascule avec lien, désactivation, validation) pour que
l'écran réagisse au tap. Un morceau lié fermé en local ajoute sa durée au `spentMs` de sa tâche, pour
que le temps affiché ne recule pas avant la réponse du serveur, qui remplace ensuite l'état.

## 5. Écran

- **Ligne du haut** : sans tâche active, la tâche du haut avec un bouton **▶** (Activer) à la place de
  la case ; un appui ailleurs ouvre le panneau. Tâche active : le lien « Tâches » (avec le nombre de
  faites du jour).
- **À la place de la rangée Activité**, quand une tâche est active : sa carte — description, « projet
  · activité », le temps passé dessus en direct, et deux boutons **Valider** et **Désactiver**. Les
  boutons de projet restent : en toucher un autre désactive la tâche.
- **Panneau** : chaque tâche à faire a sa poignée, sa case (valider), son texte (ouvre la fiche) et
  un bouton ▶ (activer) ; la tâche active montre « en cours » à la place. Le temps passé s'affiche
  après « projet · activité » dès qu'il dépasse une minute, sur les tâches à faire comme sur les
  faites du jour.
- **Mini-fenêtre** : le panneau remplace l'écran principal dans la même fenêtre (plus de deuxième
  fenêtre) ; la fenêtre prend sa hauteur ; ✕ revient à l'écran principal. Aucune barre de
  défilement : la fenêtre prend la hauteur du contenu, et au-delà de sa hauteur maximale le contenu
  défile à la molette sans barre.

## 6. Agent Claude

Le skill décrit `activateTask`, `deactivateTask`, `activeTask`, `spentMs` et `running.task`, et
remplace la règle de la tâche du haut par celle du lien.

## 7. Limites connues

- **Widget Android** : il ne change pas. Son ▶ lance toujours « dernier projet · Writing » : si la
  tâche active n'est pas exactement ce projet en Writing, ce lancement la désactive. Sa reprise après
  une pause repart sur l'activité d'avant la pause, donc sur la tâche.
- **L'APK** embarque sa copie de l'app : la nouvelle interface y arrive au prochain build.

## Tests

- Serveur : chaque ligne du tableau du § 3, les critères 1 à 7, l'idempotence (activer deux fois,
  désactiver sans tâche active), l'heure du tap hors ligne pour une activation, un réglage
  `active_task` qui pointe vers une tâche validée (vaut « aucune »), le temps d'une tâche après
  correction et suppression d'un morceau, la parité du schéma et des sauvegardes avec `task_id`.
- Client : `applyLocal` sur les mêmes scénarios ; le temps affiché qui ne recule pas à un stop local.
- Bout en bout (`tools/e2e.js`) : activer depuis la ligne du haut, la carte à la place de la rangée
  Activité, valider.

## Hors périmètre

- Statistiques par tâche au-delà du temps affiché.
- Widget Android.
