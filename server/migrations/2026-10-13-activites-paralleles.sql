-- Plusieurs activités à la fois (docs/specs/2026-10-13-activites-paralleles-design.md) : une session
-- garde l'activité de chacune de ses tâches, dans l'ordre de task_ids. À appliquer une fois sur une base
-- qui a reçu 2026-10-13-taches-paralleles.sql, AVANT le déploiement :
--   npx wrangler d1 execute kilosaurus-temps --remote --file server/migrations/2026-10-13-activites-paralleles.sql
-- Une base neuve n'en a pas besoin : server/schema.sql a déjà la colonne.
ALTER TABLE entries ADD COLUMN task_types TEXT;
ALTER TABLE archive_entries ADD COLUMN task_types TEXT;
