/**
 * Règles métier de Kilosaurus Temps. Ne connaît ni D1 ni le Worker : tout passe par `env`.
 *   env.db   — interface SQL (server/db.js) : all, first, batch
 *   env.now  — horloge, () → millisecondes
 *   env.auth — code → { agent } ou null
 *
 * Chaque écriture enregistre ses changements de lignes et une entrée du journal `ops` dans la même
 * transaction : c'est ce qui permet d'annuler (action `undo`).
 */
import { dayKey, dayStart, nextDayStart, clock, shortDate } from './tz.js';

export const BLOCK_HOURS = [2, 4, 6, 8, 10, 12];
const OFFSETS = [0, 15, 30, 60];
export const MAX_SESSION_MS = 24 * 3600000;
const MAX_HISTORY_DAYS = 62;
const FORBIDDEN_NAME = /[\[\]*?\/\\:]/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TOO_LONG = 'Une session ne peut pas dépasser 24 h : indique d’abord l’heure de fin du compteur en cours.';
const WRITE_ACTIONS = ['start', 'stop', 'note', 'logBlock', 'logSession', 'addProject', 'deleteEntry', 'editEntry', 'undo'];

// Types de travail, dans l'ordre d'affichage. Une ligne sans type (historique) vaut Misc.
export const TYPES = [
  // Trois ambiances = trois arcs du cercle des couleurs : Contenu en tons chauds (jaune → rouge),
  // Art en tons nature (vert-jaune → cyan), Code en tons froids (bleu → magenta). Dans un arc, des
  // teintes nettement différentes. Misc, la tâche par défaut, en gris et toujours en premier.
  { name: 'Misc', color: '#8A8F98', family: 'general' },
  { name: 'Writing', color: '#EAB308', family: 'contenu' },
  { name: 'Sound', color: '#F97316', family: 'contenu' },
  { name: 'Market', color: '#EF4444', family: 'contenu' },
  { name: 'Concept', color: '#84CC16', family: 'art' },
  { name: 'Art', color: '#22C55E', family: 'art' },
  { name: 'TechArt', color: '#14B8A6', family: 'art' },
  { name: 'UI', color: '#06B6D4', family: 'art' },
  { name: 'Dev', color: '#3B82F6', family: 'code' },
  { name: 'Gameplay', color: '#6366F1', family: 'code' },
  { name: 'Tooling', color: '#8B5CF6', family: 'code' },
  { name: 'Debug', color: '#D946EF', family: 'code' },
  // Pause : pas une tâche à choisir mais un état du compteur (bouton ⏸) ; le temps compte, marqué pause.
  { name: 'Pause', color: '#94A3B8', family: 'pause' },
];
const TYPE_NAMES = TYPES.map((t) => t.name);
const DEFAULT_TYPE = 'Misc';
// Noms de la première version : encore présents dans l'historique et chez les clients pas à jour.
const LEGACY_TYPES = { Autre: 'Misc', Narration: 'Writing' };

export const ENTRY_COLUMNS = ['id', 'project', 'kind', 'day', 'start_ms', 'end_ms', 'hours', 'type', 'note', 'source', 'created_ms', 'touched_ms', 'deleted_ms'];
export const ACTIVE = 'deleted_ms IS NULL';

export class AppError {
  constructor(code, message) { this.code = code; this.message = message; }
}
export function fail(message) { throw new AppError('invalid', message); }

function canonicalType(name) { return Object.hasOwn(LEGACY_TYPES, name) ? LEGACY_TYPES[name] : name; }
export function typeOf(row) {
  const name = canonicalType(row.type);
  return TYPE_NAMES.includes(name) ? name : DEFAULT_TYPE;
}

// ---- Lecture ----

export function running(db) {
  return db.first(`SELECT * FROM entries WHERE kind = 'session' AND end_ms IS NULL AND ${ACTIVE}`);
}
export function byId(db, id) { return db.first('SELECT * FROM entries WHERE id = ?', [id]); }
function last(db) {
  return db.first(`SELECT * FROM entries WHERE ${ACTIVE} AND source <> 'report' AND NOT (kind = 'session' AND end_ms IS NULL) ORDER BY touched_ms DESC LIMIT 1`);
}
// Lignes qui touchent aujourd'hui : sessions qui chevauchent la journée (en cours comprises), blocs du jour.
function today(db, nowMs) {
  const key = dayKey(nowMs);
  const from = dayStart(key);
  const to = nextDayStart(from);
  return db.all(
    `SELECT * FROM entries WHERE ${ACTIVE} AND ((kind = 'session' AND start_ms < ? AND COALESCE(end_ms, ?) > ?) OR (kind = 'block' AND day = ?))
     ORDER BY day, start_ms IS NULL, start_ms`,
    [to, nowMs, from, key],
  );
}
async function projectNames(db) { return (await db.all('SELECT name FROM projects ORDER BY position')).map((r) => r.name); }
async function settings(db) {
  const out = {};
  for (const r of await db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}
export function undoTarget(db) { return db.first('SELECT id, summary FROM ops WHERE undone_ms IS NULL ORDER BY id DESC LIMIT 1'); }

export function overlapping(ctx, start, end, exceptId) {
  return ctx.db.first(
    `SELECT * FROM entries WHERE ${ACTIVE} AND kind = 'session' AND id <> ? AND start_ms < ? AND COALESCE(end_ms, ?) > ? LIMIT 1`,
    [exceptId || '', end, ctx.now, start],
  );
}

function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

export function toApi(r) {
  if (!r) return null;
  const hours = r.kind === 'block' ? r.hours : (r.end_ms == null ? null : Math.round((r.end_ms - r.start_ms) / 36000) / 100);
  return { id: r.id, project: r.project, type: typeOf(r), date: r.day, start: iso(r.start_ms), end: iso(r.end_ms), hours, note: r.note || '', source: r.source };
}

async function status(ctx) {
  const { db } = ctx;
  const [cfg, projects, run, lastRow, todayRows, undo] = await Promise.all([
    settings(db), projectNames(db), running(db), last(db), today(db, ctx.now), undoTarget(db),
  ]);
  return {
    me: cfg.me || '',
    agent: ctx.agent,
    projects,
    studio: cfg.studio || 'Studio',
    visible: Number(cfg.visible || 4),
    threshold: Number(cfg.threshold || 8),
    running: toApi(run),
    last: toApi(lastRow),
    types: TYPES,
    today: todayRows.map(toApi),
    undo: undo ? { opId: undo.id, summary: undo.summary } : null,
    serverTime: iso(ctx.now),
    now: iso(ctx.now),
  };
}

// ---- Validation ----

export function parseInstant(value, label) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) fail(`${label} : date-heure non valide.`);
  return t;
}
function requireId(p) {
  if (typeof p.id !== 'string' || !p.id || p.id.length > 64) fail('Identifiant de ligne manquant ou trop long.');
  return p.id;
}
export async function requireProject(ctx, name) {
  if (!(await projectNames(ctx.db)).includes(name)) fail('Projet inconnu : ' + name);
  return name;
}
export function cleanNote(text) {
  if (text === undefined || text === null) return '';
  if (typeof text !== 'string') fail('La note doit être du texte.');
  if (text.length > 500) fail('Note trop longue (500 caractères max).');
  return text.trim();
}
export function requireBlockHours(value) {
  const h = Number(value);
  if (!BLOCK_HOURS.includes(h)) fail('Heures autorisées : 2, 4, 6, 8, 10 ou 12.');
  return h;
}
export function requireType(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const name = canonicalType(value);
  if (!TYPE_NAMES.includes(name)) fail(`Type inconnu : ${value}. Types : ${TYPE_NAMES.join(', ')}.`);
  return name;
}

// Heure de l'action : celle du serveur, sauf pour une action rejouée hors ligne (clientTime) ou
// envoyée par le widget, qui affiche son état avant la réponse (tapTime). Jamais dans le futur.
function actionTime(ctx) {
  const claimed = ctx.offline && ctx.clientTime ? ctx.clientTime : ctx.tapTime;
  if (claimed) {
    const t = Date.parse(claimed);
    if (!Number.isNaN(t)) return Math.min(t, ctx.now);
  }
  return ctx.now;
}

export function source(ctx) {
  if (ctx.agent) return 'claude';
  return ctx.offline ? 'hors ligne' : 'app';
}

function newSession(ctx, f) {
  return {
    id: f.id, project: f.project, kind: 'session', day: dayKey(f.start), start_ms: f.start, end_ms: f.end ?? null, hours: null,
    type: f.type, note: f.note || '', source: source(ctx), created_ms: ctx.now, touched_ms: ctx.now, deleted_ms: null,
  };
}
function newBlock(ctx, f) {
  return {
    id: f.id, project: f.project, kind: 'block', day: f.day, start_ms: null, end_ms: null, hours: f.hours,
    type: f.type, note: f.note || '', source: source(ctx), created_ms: ctx.now, touched_ms: ctx.now, deleted_ms: null,
  };
}

// ---- Journal ----

export function plain(row) {
  if (!row) return null;
  const out = {};
  for (const c of ENTRY_COLUMNS) out[c] = row[c] ?? null;
  return out;
}
export function change(before, after) {
  return { table: 'entries', key: (after || before).id, before: plain(before), after: plain(after) };
}

// Écriture d'une ligne dans son état complet (création ou remplacement), ou retrait d'un projet.
export function writeRow(table, key, row) {
  if (table === 'projects') {
    return row
      ? { sql: 'INSERT INTO projects (name, position) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET position = excluded.position', params: [row.name, row.position] }
      : { sql: 'DELETE FROM projects WHERE name = ?', params: [key] };
  }
  const cols = ENTRY_COLUMNS;
  return {
    sql: `INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
          ON CONFLICT(id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`,
    params: cols.map((c) => row[c] ?? null),
  };
}

// Les changements, dans l'ordre où ils s'appliquent, et leur entrée de journal : une seule transaction.
export async function commit(ctx, action, summary, changes) {
  if (!changes.length) return;
  const stmts = changes.map((c) => writeRow(c.table, c.key, c.after));
  stmts.push({
    sql: 'INSERT INTO ops (at_ms, action, summary, source, changes) VALUES (?, ?, ?, ?, ?)',
    params: [ctx.now, action, summary, source(ctx), JSON.stringify(changes)],
  });
  await ctx.db.batch(stmts);
}

// ---- Actions ----

export const actions = {
  async status() {},

  async start(ctx, p) {
    const id = requireId(p);
    const project = await requireProject(ctx, p.project);
    const offset = p.offsetMinutes === undefined ? 0 : Number(p.offsetMinutes);
    if (!OFFSETS.includes(offset)) fail('Décalage autorisé : 0, 15, 30 ou 60 minutes.');
    const note = cleanNote(p.note);
    const run = await running(ctx.db);
    const type = requireType(p.type, run ? typeOf(run) : DEFAULT_TYPE);
    if (await byId(ctx.db, id)) return;
    // Relancer ce qui tourne déjà n'est pas une action.
    if (run && run.project === project && typeOf(run) === type) return;

    let start = actionTime(ctx) - offset * 60000;
    const changes = [];
    if (run) {
      if (start < run.start_ms) start = run.start_ms;
      if (start - run.start_ms > MAX_SESSION_MS) fail(TOO_LONG);
      changes.push(change(run, { ...run, end_ms: start, touched_ms: ctx.now }));
    }
    changes.push(change(null, newSession(ctx, { id, project, start, type, note })));
    await commit(ctx, 'start', `${run ? 'Bascule' : 'Lancement'} ${project} · ${type} à ${clock(start)}`, changes);
  },

  async stop(ctx, p) {
    const run = await running(ctx.db);
    let end;
    if (p.endAt !== undefined && p.endAt !== null) {
      if (!run) fail('Aucun compteur en cours.');
      end = parseInstant(p.endAt, 'Heure de fin');
      if (end <= run.start_ms) fail('La fin doit être après le début.');
      if (end > ctx.now) fail('La fin ne peut pas être dans le futur.');
    } else {
      if (!run) return;
      end = actionTime(ctx);
      // Un stop rejoué hors ligne, plus ancien que le compteur en cours, visait un compteur déjà fermé.
      if (end < run.start_ms) return;
    }
    if (end - run.start_ms > MAX_SESSION_MS) fail(TOO_LONG);
    await commit(ctx, 'stop', `Arrêt ${run.project} · ${typeOf(run)} à ${clock(end)}`, [change(run, { ...run, end_ms: end, touched_ms: ctx.now })]);
  },

  async note(ctx, p) {
    const text = cleanNote(p.text);
    const run = await running(ctx.db);
    if (!run) fail('Aucun compteur en cours.');
    if (run.note === text) return;
    await commit(ctx, 'note', `Note sur ${run.project}`, [change(run, { ...run, note: text })]);
  },

  async logBlock(ctx, p) {
    const id = requireId(p);
    const project = await requireProject(ctx, p.project);
    const hours = requireBlockHours(p.hours);
    const note = cleanNote(p.note);
    const type = requireType(p.type, DEFAULT_TYPE);
    const key = p.date === undefined || p.date === null ? dayKey(actionTime(ctx)) : p.date;
    if (typeof key !== 'string' || !DAY_KEY.test(key)) fail('Date attendue au format aaaa-mm-jj.');
    if (key > dayKey(ctx.now)) fail('La date ne peut pas être dans le futur.');
    if (await byId(ctx.db, id)) return;
    const [, m, d] = key.split('-');
    await commit(ctx, 'logBlock', `Bloc ${hours} h ${project} · ${type} (${d}/${m})`, [change(null, newBlock(ctx, { id, project, day: key, hours, type, note }))]);
  },

  async logSession(ctx, p) {
    if (!ctx.agent) fail('Action réservée aux codes d’agent.');
    const id = requireId(p);
    const project = await requireProject(ctx, p.project);
    const start = parseInstant(p.start, 'Début');
    const end = parseInstant(p.end, 'Fin');
    const note = cleanNote(p.note);
    const type = requireType(p.type, DEFAULT_TYPE);
    if (end <= start) fail('La fin doit être après le début.');
    if (end > ctx.now) fail('La fin ne peut pas être dans le futur.');
    if (end - start > MAX_SESSION_MS) fail('Une session ne peut pas dépasser 24 h.');
    if (await byId(ctx.db, id)) return;
    const o = await overlapping(ctx, start, end);
    if (o) fail(`Chevauche une session existante (${o.project}, ${shortDate(o.start_ms)} ${clock(o.start_ms)}).`);
    await commit(ctx, 'logSession', `Session ${project} · ${type} ${clock(start)} → ${clock(end)}`, [change(null, newSession(ctx, { id, project, start, end, type, note }))]);
  },

  async addProject(ctx, p) {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) fail('Nom de projet vide.');
    if (name.length > 30) fail('Nom de projet trop long (30 caractères max).');
    if (name.charAt(0) === '_') fail('Un nom de projet ne commence pas par « _ ».');
    if (FORBIDDEN_NAME.test(name)) fail('Caractères interdits : [ ] * ? / \\ :');
    const taken = (await projectNames(ctx.db)).some((n) => n.toLowerCase() === name.toLowerCase());
    if (taken) fail('Ce nom est déjà pris : ' + name);
    const { position } = await ctx.db.first('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM projects');
    await commit(ctx, 'addProject', `Projet ${name} créé`, [{ table: 'projects', key: name, before: null, after: { name, position } }]);
  },

  // Lecture seule : renvoie les lignes de la période au lieu de l'état.
  async history(ctx, p) {
    if (typeof p.from !== 'string' || !DAY_KEY.test(p.from) || typeof p.to !== 'string' || !DAY_KEY.test(p.to)) {
      fail('Période attendue : from et to au format aaaa-mm-jj.');
    }
    if (p.from > p.to) fail('La période commence après sa fin.');
    const days = Math.round((dayStart(p.to) - dayStart(p.from)) / 86400000) + 1;
    if (days > MAX_HISTORY_DAYS) fail(`Période de ${MAX_HISTORY_DAYS} jours au plus.`);
    const rows = await ctx.db.all(
      `SELECT * FROM entries WHERE ${ACTIVE} AND day >= ? AND day <= ? ORDER BY day, start_ms IS NULL, start_ms`,
      [p.from, p.to],
    );
    return { from: p.from, to: p.to, rows: rows.map(toApi) };
  },
};

// ---- Entrée ----

export function isWrite(action) { return WRITE_ACTIONS.includes(action); }

export async function handleRequest(env, body) {
  try {
    body = body || {};
    const who = await env.auth(body.code);
    if (!who) return { ok: false, error: { code: 'unauthorized', message: 'Code inconnu.' } };
    const action = Object.hasOwn(actions, body.action) ? actions[body.action] : null;
    if (!action) fail('Action inconnue : ' + body.action);
    const ctx = {
      db: env.db,
      now: env.now(),
      agent: !!who.agent,
      offline: body.offline === true,
      clientTime: body.clientTime,
      tapTime: body.tapTime,
    };
    const data = await action(ctx, body);
    return { ok: true, data: data === undefined ? await status(ctx) : data };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message } };
    const message = String(e && e.message ? e.message : e);
    // Deux appareils qui lancent en même temps : la base refuse le second compteur ; le client réessaie.
    if (/UNIQUE constraint failed: entries\.kind/.test(message)) {
      return { ok: false, error: { code: 'busy', message: 'Deux actions en même temps : réessaie.' } };
    }
    return { ok: false, error: { code: 'server', message } };
  }
}
