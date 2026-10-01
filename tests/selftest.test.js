// Vérifie le parcours de runSelfTest (Test.gs) sur un store en mémoire, et que tous les .gs se
// chargent ensemble sans erreur (Apps Script les exécute dans un même espace global).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { MemoryStore, makeClock, tz } = require('./harness');

function loadAllGs() {
  const ctx = {};
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'apps-script');
  for (const file of ['Core.gs', 'Sheet.gs', 'Code.gs', 'Test.gs']) {
    vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), ctx, { filename: file });
  }
  return ctx;
}

test('les .gs se chargent ensemble', () => {
  const g = loadAllGs();
  for (const name of ['Core', 'SheetStore', 'doPost', 'doGet', 'runSelfTest', 'selfTestScenario', 'normalizeName']) {
    assert.ok(g[name], `${name} manquant`);
  }
  assert.equal(g.normalizeName('Honoré Jaussoin'), 'HONOREJAUSSOIN');
  assert.equal(g.normalizeName('Amohs'), 'AMOHS');
});

test('authByCode : un code par appareil, agent si segment CLAUDE, code court ignoré', () => {
  const g = loadAllGs();
  const long = (c) => c.repeat(32);
  g.PropertiesService = { getScriptProperties: () => ({ getProperties: () => ({
    CODE_AMOHS: long('a'),
    CODE_AMOHS_TELEPHONE: long('t'),
    CODE_AMOHS_CLAUDE: long('c'),
    CODE_AMOHS_CLAUDE_PC: long('p'),
    CODE_AMOHS_PC: 'trop-court',
    CODE_INCONNU: long('i'),
    AUTRE: long('x'),
  }) }) };
  const store = new MemoryStore({ persons: ['Amohs'] });
  const auth = (code) => g.authByCode(store, code);
  assert.deepEqual({ ...auth(long('a')) }, { person: 'Amohs', agent: false });
  assert.deepEqual({ ...auth(long('t')) }, { person: 'Amohs', agent: false });
  assert.deepEqual({ ...auth(long('c')) }, { person: 'Amohs', agent: true });
  assert.deepEqual({ ...auth(long('p')) }, { person: 'Amohs', agent: true });
  assert.equal(auth('trop-court'), null);
  assert.equal(auth(long('i')), null);
  assert.equal(auth(long('x')), null);
  assert.equal(auth(undefined), null);
});

test('blocage : 10 codes refusés bloquent tout le monde, unlockApi débloque', () => {
  const g = loadAllGs();
  const good = 'b'.repeat(32);
  const cache = new Map();
  g.CacheService = { getScriptCache: () => ({
    get: (k) => (cache.has(k) ? cache.get(k) : null),
    put: (k, v) => { cache.set(k, v); },
    remove: (k) => { cache.delete(k); },
    removeAll: (ks) => ks.forEach((k) => cache.delete(k)),
  }) };
  g.PropertiesService = { getScriptProperties: () => ({ getProperties: () => ({ CODE_AMOHS: good }) }) };
  const store = new MemoryStore({ persons: ['Amohs'] });
  g.SheetStore = function () { return store; };
  g.tzParis = tz; // Utilities (Google) n'existe pas dans Node
  const call = (code) => g.handle({ code, action: 'status' }, null, () => new Date('2026-10-01T10:00:00+02:00'));

  for (let i = 0; i < 9; i++) assert.equal(call('faux-' + i).error.code, 'unauthorized');
  assert.equal(call(good).ok, true, 'neuf échecs ne bloquent pas');
  assert.equal(call('faux-9').error.code, 'unauthorized');
  assert.equal(call(good).error.code, 'locked', 'le dixième échec bloque aussi les bons codes');
  assert.equal(call('').error.code, 'locked');
  g.unlockApi();
  assert.equal(call(good).ok, true);
});

test('le parcours de runSelfTest passe sur un store en mémoire', () => {
  const g = loadAllGs();
  const store = new MemoryStore({ persons: ['__test__'] });
  store.createProject('ZZ Test A');
  store.createProject('ZZ Test B');
  const clock = makeClock('2026-10-01T06:00:00+02:00');
  const env = { store, now: clock.now, tz, auth: (code) => ({ person: '__test__', agent: code === 'agent' }) };
  const failures = g.selfTestScenario({
    projA: 'ZZ Test A',
    projB: 'ZZ Test B',
    call: (kind, action, params) => g.Core.handleRequest(env, Object.assign({ code: kind, action }, params || {})),
    advance: clock.advance,
    rowCount: (p) => store.data[p].length,
    corrections: () => store.corrections,
  });
  assert.deepEqual(Array.from(failures), []);
});
