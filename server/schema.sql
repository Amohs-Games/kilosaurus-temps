-- Base de Kilosaurus Temps (Cloudflare D1, SQLite). Appliquer avec :
--   npx wrangler d1 execute kilosaurus-temps --remote --file server/schema.sql
-- Heures en millisecondes UTC ; jours aaaa-mm-jj au fuseau de Paris.

CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  position INTEGER NOT NULL          -- ordre des boutons
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,              -- me, studio, visible, threshold
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

-- Codes refusés par adresse IP (blocage d'une heure après 10 refus en 15 min).
CREATE TABLE IF NOT EXISTS lockouts (
  ip TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  first_ms INTEGER NOT NULL,
  until_ms INTEGER
);
