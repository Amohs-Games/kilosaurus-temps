---
name: kilosaurus-temps
description: Loguer du temps de travail dans Kilosaurus Temps (la feuille de temps de l'utilisateur) pour l'utilisateur, et gérer sa liste de tâches. À utiliser quand l'utilisateur demande de loguer, déclarer, compter ou noter du temps passé sur un projet, de lancer ou d'arrêter son compteur, de corriger, supprimer ou annuler un log, ou d'ajouter, activer (« je passe sur telle tâche »), désactiver, valider ou cocher (« coche ma tâche »), décocher, modifier, supprimer ou réordonner ses tâches.
---

# Kilosaurus Temps — loguer du temps

Kilosaurus Temps enregistre le temps de travail par projet dans une base de données, via une API
JSON. Tu loges **au nom de ton utilisateur**, avec son code d'agent : chaque ligne que tu écris est
marquée « claude ».

## Configuration

Deux variables d'environnement, fournies par l'utilisateur :

- `KILOSAURUS_TEMPS_URL` — URL de l'API (se termine par `/api`).
- `KILOSAURUS_TEMPS_CODE` — son code d'agent. Ne l'affiche jamais, ne l'écris dans aucun fichier.

Si l'une manque, arrête-toi et demande-la à l'utilisateur.

## Appeler l'API

Toujours un POST, corps JSON, `Content-Type: text/plain`. Sous PowerShell, utilise `curl.exe`, pas
`curl`.

```bash
curl -sL -H 'Content-Type: text/plain' \
  -d "{\"code\":\"$KILOSAURUS_TEMPS_CODE\",\"action\":\"status\"}" \
  "$KILOSAURUS_TEMPS_URL"
```

Réponse : `{"ok":true,"data":{…}}`, ou `{"ok":false,"error":{"code":"…","message":"…"}}`.
`unauthorized` = code refusé : préviens l'utilisateur. `invalid` = demande refusée : lis le message,
corrige, ou explique-le à l'utilisateur. `busy` = réessaie dans quelques secondes. `locked` = cette
adresse est bloquée une heure après trop de codes refusés : n'insiste pas, préviens l'utilisateur.

Chaque action renvoie l'état à jour (`data`) : `projects` (projets existants), `running` (compteur
en cours), `last` (dernier log), `today` (lignes du jour), `types` (types de travail), `undo` (la
dernière action annulable, `{ opId, summary }`), plus :

- `choice` : `{ project, type }`, le projet et l'activité choisis, partagés par tous les appareils.
  Compteur en cours, c'est ce qui tourne ; sinon, ce que lancera ▶.
- `tasks` : la liste de tâches de l'utilisateur. D'abord les tâches à faire dans l'ordre de la liste
  (la première est « la tâche du haut »), puis les tâches validées depuis le dernier 6 h. Chacune :
  `{ id, description, project, type, position, done, started, spentMs }` (`done` est `null` pour
  une tâche à faire ; `spentMs` = millisecondes passées dessus, morceau en cours non compris).
- `activeTask` : l'`id` de la tâche active, ou `null`. `running.task` (et chaque ligne de `today`,
  `last`, `history`) : la tâche sur laquelle ce morceau de compteur a tourné, ou `null`.

Seule exception : `history` renvoie
`{ from, to, rows }`.

## Commence par `status`

Lis toujours `status` avant d'écrire : le nom du projet doit être **exactement** l'un de
`data.projects` (les majuscules comptent). `data.studio` est le temps studio (admin, compta,
réunions…). Si le projet demandé n'existe pas, demande à l'utilisateur plutôt que d'en créer un.

## Actions

| Action | Paramètres | Usage |
|---|---|---|
| `logSession` | `id`, `project`, `start`, `end`, `type?`, `note?` | Une session terminée, avec ses heures exactes. **L'action normale pour un agent.** |
| `logBlock` | `id`, `project`, `hours` (2, 4, 6, 8, 10 ou 12), `date?` (`aaaa-mm-jj`), `type?`, `note?` | Un bloc d'heures sur une journée, sans heures précises. |
| `start` | `id`, `project`, `type?`, `note?` | Lance le compteur (ferme celui en cours) et met aussi à jour le choix partagé. Sans `type`, garde celui du compteur en cours. |
| `stop` | — | Arrête le compteur. |
| `history` | `from`, `to` (`aaaa-mm-jj`, 62 jours max) | Les lignes de l'utilisateur sur la période, avec leur `id`, pour faire un bilan ou retrouver une ligne. Ne modifie rien. |
| `archivedDay` | `day` (`aaaa-mm-jj`) | Les lignes d'un jour figé, telles qu'elles étaient à 6 h le lendemain (supprimées comprises, `deleted: true`). Pour retrouver une version d'origine. Ne modifie rien. |
| `editEntry` | `id`, `start?`, `end?`, `hours?`, `project?`, `type?`, `note?` | Corrige une ligne (trouvée avec `history`). Session : début < fin ≤ maintenant, 24 h au plus, sans chevauchement. Bloc : heures 2 à 12. |
| `deleteEntry` | `id` | Supprime une ligne (elle revient avec `undo`). |
| `select` | `project?`, `type?` | Change le choix partagé. Compteur en cours (hors pause), il bascule aussitôt sur ce choix ; en pause ou arrêté, seul le choix change. |
| `addTask` | `id`, `description` (200 caractères max), `project?`, `type?` | Ajoute une tâche à la fin de la liste (30 tâches à faire au plus) ; `project` et `type` valent le choix par défaut. |
| `editTask` | `id`, `description?`, `project?`, `type?` | Modifie une tâche. |
| `deleteTask` | `id` | Supprime une tâche (elle revient avec `undo`). |
| `moveTask` | `id`, `before` (id d'une tâche à faire, ou `null` pour la fin) | Place une tâche à faire juste avant `before`. |
| `activateTask` | `id` | Active une tâche à faire : son projet et son activité deviennent le choix, et le temps compté s'inscrit sur elle. |
| `deactivateTask` | — | Plus de tâche active ; le choix ne change pas. |
| `checkTask` | `id` | Valide (coche) une tâche : elle passe dans les faites du jour. |
| `uncheckTask` | `id` | Décoche une tâche : elle reprend sa place dans la liste à faire, non active (refusé si la liste a déjà 30 tâches). |
| `undo` | `opId` | Annule la dernière action (`status.undo.opId`), puis la précédente au prochain appel. Refusé si une autre action a eu lieu entre-temps. Lis d'abord `status.undo.summary` : n'annule que ta propre action, car un tap dans le sélecteur de l'utilisateur est aussi une action annulable. |

`type` : `Misc` (défaut), `Art`, `Dev`, `Writing`… (liste dans `data.types`). Choisis-le d'après
la demande (« j'ai codé » → Dev, « j'ai dessiné » → Art, « j'ai écrit les dialogues » →
Writing) ; dans le doute, demande.

Règles :

- **Tâches** : l'activité d'une tâche ne peut pas être `Pause`. Une tâche ne pilote le compteur
  qu'une fois **active** : ajouter, déplacer, valider ou supprimer une tâche non active ne touche ni
  au choix ni au compteur. Une seule tâche active à la fois, la même sur tous les appareils.
  - Un morceau de compteur qui s'ouvre sur exactement le projet et l'activité de la tâche active
    s'inscrit sur elle. `activateTask` compteur en cours le fait basculer dessus à la même seconde.
  - Pause, stop, puis `start` sur le choix gardent la tâche active : le temps repris s'ajoute au sien.
  - Un `start` ou un `select` sur un autre projet ou une autre activité **désactive** la tâche.
  - Valider (`checkTask`) la tâche active, `deactivateTask` ou supprimer la tâche active : le compteur
    continue, même projet, même activité, sans tâche.
  - Ne valide ou n'active une tâche que si l'utilisateur le demande. `undo` annule l'action avec la
    bascule qu'elle a provoquée. La liste à faire tient 30 tâches au plus : `addTask` et
    `uncheckTask` sont refusés au-delà (« Liste pleine »).

- **`id`** : un identifiant unique par nouvelle ligne (un UUID). Si tu renvoies la même requête
  avec le même `id`, rien n'est écrit en double : en cas de doute après une erreur réseau,
  renvoie-la avec le même `id`.
- **Dates-heures** : ISO 8601 avec fuseau, heure de Paris, par exemple `2026-10-01T14:00:00+02:00`
  (`+01:00` en hiver). Jamais dans le futur.
- **`logSession`** : 24 h au plus, et refusée si elle chevauche une autre session de l'utilisateur.
  Si c'est refusé pour chevauchement, montre le message à l'utilisateur : il a sans doute déjà
  logué ce temps depuis l'app.
- **Note** : courte et utile (« refacto sauvegarde », « build 2.3 »), 500 caractères au plus.

## Exemple : loguer une session terminée

```bash
curl -sL -H 'Content-Type: text/plain' -d "{
  \"code\": \"$KILOSAURUS_TEMPS_CODE\",
  \"action\": \"logSession\",
  \"id\": \"$(uuidgen 2>/dev/null || date +%s%N)\",
  \"project\": \"Fluffy\",
  \"start\": \"2026-10-01T14:00:00+02:00\",
  \"end\": \"2026-10-01T17:12:00+02:00\",
  \"note\": \"refacto sauvegarde\"
}" "$KILOSAURUS_TEMPS_URL"
```

## Après chaque écriture

Dis à l'utilisateur, en une ligne, ce qui a été logué : projet, jour, heures, durée. Si la demande
était ambiguë (projet, heures, jour), demande avant d'écrire. Une erreur se corrige avec
`editEntry`, ou s'annule avec `undo` tant que c'est la dernière action.
