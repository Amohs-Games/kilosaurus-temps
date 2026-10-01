// Charge Core.gs (JavaScript pur, sans API Google) dans Node, avec un store en mémoire.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCore() {
  const ctx = {};
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Core.gs'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'Core.gs' });
  return ctx.Core;
}

// Fuseau Europe/Paris via Intl, même contrat que la version Utilities de Code.gs.
const TZ = 'Europe/Paris';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parisParts(date) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = value;
  return p;
}

function offsetMs(date) {
  const p = parisParts(date);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const tz = {
  dayKey: (date) => dayFmt.format(date),
  dayStart: (key) => {
    const [y, m, d] = key.split('-').map(Number);
    const guess = new Date(Date.UTC(y, m - 1, d));
    return new Date(guess.getTime() - offsetMs(guess));
  },
  fmt: (date) => {
    const p = parisParts(date);
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
  },
};

class MemoryStore {
  constructor(cfg) {
    this.cfg = Object.assign({ persons: ['Amohs', 'Alex', 'Sam'], threshold: 8, studio: 'Studio', visible: 4 }, cfg);
    this.sheets = [];
    this.data = {};
    this.corrections = [];
    for (const name of ['Fluffy', 'Studio', '_Config', '_Corrections', '_Modèle']) this.addSheet(name);
  }
  addSheet(name) { this.sheets.push(name); if (!name.startsWith('_')) this.data[name] = []; }
  config() { return this.cfg; }
  sheetNames() { return this.sheets.slice(); }
  projects() { return this.sheets.filter((n) => !n.startsWith('_')); }
  allRows() {
    const out = [];
    for (const project of this.projects()) {
      this.data[project].forEach((r, i) => out.push(Object.assign({}, r, { project, ref: { project, index: i } })));
    }
    return out;
  }
  insert(project, row) { this.data[project].push(Object.assign({}, row)); }
  update(ref, patch) { Object.assign(this.data[ref.project][ref.index], patch); }
  addCorrection(entry) { this.corrections.push(entry); }
  createProject(name) {
    const lastProject = this.sheets.reduce((acc, n, i) => (n.startsWith('_') ? acc : i), -1);
    this.sheets.splice(lastProject + 1, 0, name);
    this.data[name] = [];
  }
}

// Horloge réglable : les tests avancent le temps à la main.
function makeClock(iso) {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    set: (s) => { t = new Date(s).getTime(); },
    advance: (minutes) => { t += minutes * 60000; },
  };
}

const CODES = {
  'code-amohs': { person: 'Amohs', agent: false },
  'code-alex': { person: 'Alex', agent: false },
  'code-alex-claude': { person: 'Alex', agent: true },
};

function makeEnv(opts = {}) {
  const Core = loadCore();
  const store = opts.store || new MemoryStore();
  const clock = opts.clock || makeClock('2026-10-01T09:00:00+02:00');
  const env = { store, now: clock.now, tz, auth: (code) => CODES[code] || null };
  const call = (code, action, params = {}) => Core.handleRequest(env, Object.assign({ code, action }, params));
  return { Core, store, clock, env, call };
}

module.exports = { loadCore, MemoryStore, makeClock, makeEnv, tz, CODES };
