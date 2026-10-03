// Petite interface SQL commune à D1 (production) et à node:sqlite (tests, serveur de dev). Les
// règles métier n'utilisent qu'elle : les mêmes requêtes tournent dans les deux.
//   all(sql, params)   → toutes les lignes
//   first(sql, params) → la première ligne, ou null
//   batch([{ sql, params }]) → les écritures, en une seule transaction (tout ou rien)

export function fromD1(d1) {
  const prepare = (sql, params = []) => d1.prepare(sql).bind(...params);
  return {
    async all(sql, params) { return (await prepare(sql, params).all()).results; },
    async first(sql, params) { return (await prepare(sql, params).first()) ?? null; },
    async batch(stmts) { if (stmts.length) await d1.batch(stmts.map((s) => prepare(s.sql, s.params))); },
  };
}

export function fromSqlite(db) {
  return {
    async all(sql, params = []) { return db.prepare(sql).all(...params); },
    async first(sql, params = []) { return db.prepare(sql).get(...params) ?? null; },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        for (const s of stmts) db.prepare(s.sql).run(...(s.params || []));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
