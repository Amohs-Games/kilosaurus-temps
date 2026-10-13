# Kilosaurus Temps — plusieurs activités à la fois, temps partagé au calcul

> Complète `2026-10-13-taches-paralleles-design.md` et en remplace une règle : une tâche ne reçoit
> plus le temps entier d'un morceau, mais sa part.

## Objectif

Avec plusieurs tâches en cours, on travaille sur plusieurs activités à la fois. Le système doit :

- **enregistrer** tout ce qui était en cours, sans rien diviser : chaque morceau de compteur garde ses
  tâches et l'activité de chacune ;
- **calculer** en partageant le temps de chaque morceau à parts égales entre ses tâches : une heure à
  trois tâches compte 20 min pour chacune, et chaque part va à l'activité de sa tâche. La somme des
  activités retombe ainsi toujours sur le total de la journée ;
- **montrer** les activités qui se superposent : pastilles dans le compteur, bandes empilées dans la
  frise.

Le partage n'existe qu'au calcul : changer la règle plus tard (temps entier, pondération) ne demandera
aucune reprise des données.

## Critères de réussite

1. Deux tâches en cours une heure : 30 min chacune dans leur temps (testé, serveur et client).
2. Une heure avec une tâche Art et une tâche Social : 30 min d'Art et 30 min de Social au récap ; deux
   tâches Art : 1 h d'Art (testé).
3. Un morceau sans tâche compte entier pour sa propre activité (testé).
4. Changer l'activité d'une tâche en cours ouvre un nouveau morceau à la même seconde ; le passé garde
   l'ancienne activité (testé).
5. Un morceau lié avant cette version (tâches sans activités enregistrées) prend sa propre activité
   pour chaque tâche (testé).

## 1. Données

- `entries.task_types` : l'activité de chaque tâche de `task_ids`, même ordre, virgules ; vide sans
  tâche. `archive_entries` suit. Migration : `server/migrations/2026-10-13-activites-paralleles.sql`,
  avant le déploiement.
- `type` reste l'activité du compteur (celle de la dernière tâche activée quand des tâches sont en
  cours) ; elle ne compte au récap que pour un morceau sans tâche.
- API : chaque ligne (`running`, `today`, `last`, `history`) gagne `taskTypes`, aligné sur `tasks`.

## 2. Calcul

- **Temps d'une tâche** (`spentMs`, serveur) : pour chaque morceau terminé qui la contient, sa durée
  divisée par le nombre de tâches du morceau. L'écran ajoute la part du morceau en cours.
- **Récap** (client) : chaque morceau apporte sa durée au total, et à chaque activité la part de ses
  tâches (`partsByType`). Le total par projet reste celui du morceau.

## 3. Écran

- Tâches en cours : la rangée Activité disparaît (la section « En cours » la remplace).
- Compteur : une pastille par activité du morceau en cours ; une seule à côté du projet, plusieurs sur
  une ligne en dessous.
- Frise du jour : un morceau à plusieurs activités se dessine en bandes empilées, une par activité, de
  hauteur égale à sa part.
- Fenêtre des sessions : chaque ligne nomme toutes ses activités (« Social + Art »). La correction
  d'une ligne ne change que l'activité du compteur, pas celles des tâches.

## Limites connues

- Le widget Android ne connaît pas les activités des tâches : il affiche celle du compteur.
