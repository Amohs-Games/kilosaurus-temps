-- Tâches qu'on active (docs/specs/2026-10-12-taches-actives-design.md) : chaque session garde la
-- tâche sur laquelle elle a tourné. À appliquer une fois sur une base existante, AVANT
-- `npm run db:schema` (qui crée l'index sur cette colonne) et le déploiement :
--   npx wrangler d1 execute kilosaurus-temps --remote --file server/migrations/2026-10-12-taches-actives.sql
-- Une base neuve n'en a pas besoin : server/schema.sql a déjà la colonne.
ALTER TABLE entries ADD COLUMN task_id TEXT;
ALTER TABLE archive_entries ADD COLUMN task_id TEXT;
CREATE INDEX IF NOT EXISTS entries_task ON entries (task_id);
