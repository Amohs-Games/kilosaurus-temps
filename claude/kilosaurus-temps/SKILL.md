---
name: kilosaurus-temps
description: Loguer du temps de travail dans Kilosaurus Temps (la feuille de temps de l'utilisateur) pour l'utilisateur. À utiliser quand l'utilisateur demande de loguer, déclarer, compter ou noter du temps passé sur un projet, de lancer ou d'arrêter son compteur, de corriger, supprimer ou annuler un log.
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
dernière action annulable, `{ opId, summary }`). Seule exception : `history` renvoie
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
| `start` | `id`, `project`, `type?`, `note?` | Lance le compteur (ferme celui en cours). Sans `type`, garde celui du compteur en cours. |
| `stop` | — | Arrête le compteur. |
| `history` | `from`, `to` (`aaaa-mm-jj`, 62 jours max) | Les lignes de l'utilisateur sur la période, avec leur `id`, pour faire un bilan ou retrouver une ligne. Ne modifie rien. |
| `editEntry` | `id`, `start?`, `end?`, `hours?`, `project?`, `type?`, `note?` | Corrige une ligne (trouvée avec `history`). Session : début < fin ≤ maintenant, 24 h au plus, sans chevauchement. Bloc : heures 2 à 12. |
| `deleteEntry` | `id` | Supprime une ligne (elle revient avec `undo`). |
| `undo` | `opId` | Annule la dernière action (`status.undo.opId`), puis la précédente au prochain appel. Refusé si une autre action a eu lieu entre-temps. |

`type` : `Misc` (défaut), `Art`, `Dev`, `Writing`… (liste dans `data.types`). Choisis-le d'après
la demande (« j'ai codé » → Dev, « j'ai dessiné » → Art, « j'ai écrit les dialogues » →
Writing) ; dans le doute, demande.

Règles :

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
