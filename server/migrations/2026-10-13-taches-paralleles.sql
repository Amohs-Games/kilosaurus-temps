-- Plusieurs tâches en cours (docs/specs/2026-10-13-taches-paralleles-design.md) : une session garde
-- la liste des tâches actives pendant qu'elle tournait (ids séparés par des virgules). Une session
-- déjà liée garde sa tâche, liste d'un élément. À appliquer une fois sur une base qui a reçu
-- 2026-10-12-taches-actives.sql, AVANT le déploiement :
--   npx wrangler d1 execute kilosaurus-temps --remote --file server/migrations/2026-10-13-taches-paralleles.sql
-- Une base neuve n'en a pas besoin : server/schema.sql a déjà la colonne.
DROP INDEX IF EXISTS entries_task;
ALTER TABLE entries RENAME COLUMN task_id TO task_ids;
ALTER TABLE archive_entries RENAME COLUMN task_id TO task_ids;
