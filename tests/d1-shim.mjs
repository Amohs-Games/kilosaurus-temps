// Imitation minimale de l'API D1 (prepare / bind / all / first / run / batch) sur node:sqlite, pour
// tester le Worker tel qu'il tourne en production, à travers fromD1.
export function d1Shim(sqlite) {
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => statement(sql, p),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => { sqlite.prepare(sql).run(...params); return { success: true }; },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) {
      sqlite.exec('BEGIN');
      try {
        for (const s of list) sqlite.prepare(s.sql).run(...s.params);
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      return list.map(() => ({ success: true }));
    },
  };
}
