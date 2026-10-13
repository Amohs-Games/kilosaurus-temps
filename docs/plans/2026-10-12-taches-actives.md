# Tâches qu'on active — plan d'implémentation

**Goal:** Une tâche ne pilote le compteur qu'une fois activée ; son temps est la somme des morceaux
passés dessus ; la mini-fenêtre ouvre les tâches dans sa propre fenêtre, sans barre de défilement.

**Spec:** `docs/specs/2026-10-12-taches-actives-design.md`

**Architecture:** Le lien tâche ↔ temps vit sur le morceau (`entries.task_id`), la tâche active dans
un réglage (`active_task`). Le serveur (`server/core.js`) porte la règle du lien et la bascule qui
compare projet, activité et lien ; la règle de la tâche du haut disparaît. `web/logic.js` rejoue les
mêmes règles hors ligne ; `web/app.js` affiche le bouton Activer, la carte de la tâche active et le
panneau en ligne dans la mini-fenêtre.

## Contraintes

- Le widget Android ne change pas.
- Toute écriture : une entrée `ops`, heure du tap hors ligne, idempotente.
- `task_id` en dernière colonne d'`entries` et d'`archive_entries` (même rang que l'`ALTER TABLE`
  d'une base existante).
- Aucune dépendance nouvelle.

## Tâches

1. **Schéma et sauvegardes** — `schema.sql` (`task_id` + index), `server/migrations/2026-10-12-taches-actives.sql`,
   `ENTRY_COLUMNS` (core + backup), `toApi` (`task`). Tests : parité schéma / sauvegardes,
   aller-retour, archive.
2. **Règles serveur** — `switchTo` avec lien, `readActive`, `linkFor`, `activateTask`,
   `deactivateTask`, `start` / `select` / `checkTask` / `editTask` / `deleteTask` selon la spec,
   suppression de `withTopRule`, `spentMs` dans `status`. Tests : `server-tasks.test.mjs` réécrit
   sur la nouvelle spec (la règle de la tâche du haut n'existe plus), annulations.
3. **Client hors ligne** — `logic.js` : mêmes règles, `activeTaskOf`, `taskSpentMs`, fermeture d'un
   morceau lié qui crédite `spentMs`. Tests : `logic.test.js`.
4. **Écran** — `app.js` / `style.css` : ▶ Activer sur la ligne du haut et dans le panneau, carte de la
   tâche active à la place de la rangée Activité, temps passé, panneau en ligne en mini-fenêtre, pas
   de barre de défilement. `desktop/main.js` : seules les sessions ouvrent une deuxième fenêtre.
   `sw.js` : nouveau cache. `tools/e2e.js` : activer, carte, valider.
5. **Agent et docs** — `claude/kilosaurus-temps/SKILL.md`, README (mise à jour de la base).
