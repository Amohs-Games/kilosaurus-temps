-- Base de Kilosaurus Temps (Cloudflare D1, SQLite). Appliquer avec :
--   npx wrangler d1 execute kilosaurus-temps --remote --file server/schema.sql
-- Heures en millisecondes UTC ; jours aaaa-mm-jj au fuseau de Paris.

CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  position INTEGER NOT NULL          -- ordre des boutons
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,              -- me, studio, visible, threshold, archive_through, backup_desktop
  value TEXT NOT NULL
);

-- Sessions (début, fin) et blocs (heures sur un jour). Une suppression est douce : deleted_ms.
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,               -- créé par le client : une requête rejouée n'écrit pas deux fois
  project TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'block')),
  day TEXT NOT NULL,                 -- jour du début (session) ou jour déclaré (bloc)
  start_ms INTEGER,
  end_ms INTEGER,                    -- vide : compteur en cours
  hours REAL,                        -- bloc seulement (sans plafond : des blocs repris dépassent 24 h) ;
                                     -- la durée d'une session se calcule
  type TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,              -- app, hors ligne, claude, report
  created_ms INTEGER NOT NULL,
  touched_ms INTEGER NOT NULL,       -- dernière écriture : fait le « dernier log »
  deleted_ms INTEGER,
  CHECK (kind <> 'session' OR (start_ms IS NOT NULL AND hours IS NULL)),
  CHECK (kind <> 'block' OR (start_ms IS NULL AND end_ms IS NULL AND hours > 0)),
  CHECK (end_ms IS NULL OR (end_ms >= start_ms AND end_ms - start_ms <= 86400000))
);

-- Un seul compteur en cours, même si deux appareils lancent en même temps.
CREATE UNIQUE INDEX IF NOT EXISTS one_running ON entries (kind)
  WHERE kind = 'session' AND end_ms IS NULL AND deleted_ms IS NULL;
CREATE INDEX IF NOT EXISTS entries_day ON entries (day);
CREATE INDEX IF NOT EXISTS entries_start ON entries (start_ms);
CREATE INDEX IF NOT EXISTS entries_touched ON entries (touched_ms);

-- Journal des écritures, pour annuler : chaque action garde l'état avant / après des lignes touchées.
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,             -- « Lancement Heirfall · Writing à 14:02 »
  source TEXT NOT NULL,
  changes TEXT NOT NULL,             -- JSON : [{ table, key, before, after }]
  undone_ms INTEGER
);

-- Journées figées (sauvegardes) : chaque jour fini (6 h passées le lendemain) est copié ici par le
-- cron du Worker. Jamais modifié ni effacé : les triggers refusent UPDATE et DELETE. Une correction
-- faite ensuite dans l'app ne touche que `entries` ; la version d'origine reste ici.
CREATE TABLE IF NOT EXISTS archive_days (
  day TEXT PRIMARY KEY,
  archived_ms INTEGER NOT NULL,
  row_count INTEGER NOT NULL,        -- lignes copiées, supprimées comprises
  hours REAL NOT NULL                -- total du jour (sessions terminées et blocs non supprimés)
);

-- Mêmes colonnes qu'`entries`, dans le même ordre, précédées du jour figé.
CREATE TABLE IF NOT EXISTS archive_entries (
  archived_day TEXT NOT NULL,
  id TEXT NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  hours REAL,
  type TEXT NOT NULL,
  note TEXT NOT NULL,
  source TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  touched_ms INTEGER NOT NULL,
  deleted_ms INTEGER,
  PRIMARY KEY (archived_day, id)
);

CREATE TRIGGER IF NOT EXISTS archive_days_no_update BEFORE UPDATE ON archive_days BEGIN SELECT RAISE(ABORT, 'archive figée'); END;
CREATE TRIGGER IF NOT EXISTS archive_days_no_delete BEFORE DELETE ON archive_days BEGIN SELECT RAISE(ABORT, 'archive figée'); END;
CREATE TRIGGER IF NOT EXISTS archive_entries_no_update BEFORE UPDATE ON archive_entries BEGIN SELECT RAISE(ABORT, 'archive figée'); END;
CREATE TRIGGER IF NOT EXISTS archive_entries_no_delete BEFORE DELETE ON archive_entries BEGIN SELECT RAISE(ABORT, 'archive figée'); END;

-- Codes refusés par adresse IP (blocage d'une heure après 10 refus en 15 min).
CREATE TABLE IF NOT EXISTS lockouts (
  ip TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  first_ms INTEGER NOT NULL,
  until_ms INTEGER
);
