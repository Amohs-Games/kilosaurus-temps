/**
 * Règles métier de Kilosaurus Temps. Ne connaît ni D1 ni le Worker : tout passe par `env`.
 *   env.db   — interface SQL (server/db.js) : all, first, batch
 *   env.now  — horloge, () → millisecondes
 *   env.auth — code → { agent } ou null
 *
 * Chaque écriture enregistre ses changements de lignes et une entrée du journal `ops` dans la même
 * transaction : c'est ce qui permet d'annuler (action `undo`).
 */
import { dayKey, dayStart, nextDayStart, clock, shortDate, previousDayKey, workDayKey, workDayEnd, localTime } from './tz.js';
import { TABLES, fingerprintSql } from './backup.js';

export const BLOCK_HOURS = [2, 4, 6, 8, 10, 12];
const OFFSETS = [0, 15, 30, 60];
export const MAX_SESSION_MS = 24 * 3600000;
const MAX_HISTORY_DAYS = 62;
const FORBIDDEN_NAME = /[\[\]*?\/\\:]/;
// Un NUL fausse LENGTH() de SQLite (empreinte des sauvegardes) : pas de caractère de contrôle,
// sauf tabulation et retours à la ligne dans les notes.
const CONTROL_IN_NOTE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_IN_NAME = /[\u0000-\u001F\u007F]/;
const MAX_TODO = 30;
const MAX_ACTIVE = 10;
// Un morceau lu pour le temps des tâches peut avoir été ouvert (heure du tap, hors ligne) un peu avant
// que la tâche n'arrive sur le serveur : la lecture remonte d'une semaine avant la plus ancienne.
const SPENT_LOOKBACK_MS = 7 * 24 * 3600000;
const CONTROL_IN_TASK = /[\u0000-\u001F\u007F]/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TOO_LONG = 'Une session ne peut pas dépasser 24 h : indique d’abord l’heure de fin du compteur en cours.';
const WRITE_ACTIONS = ['start', 'stop', 'note', 'logBlock', 'logSession', 'addProject', 'deleteEntry', 'editEntry', 'undo', 'select',
  'addTask', 'editTask', 'deleteTask', 'moveTask', 'checkTask', 'uncheckTask', 'activateTask', 'deactivateTask'];

// Sauvegardes. Un appel de Worker a droit à 50 requêtes D1 sur l'offre gratuite (chaque instruction
// d'un batch compte) : figer un jour en coûte 3 (lignes, tâches, résumé), d'où 14 jours au
// plus par appel (1 + 1 + 1 + 14 × 3 + 1 = 46 requêtes).
export const FREEZE_DAYS_PER_RUN = 14;
const FREEZE_GRACE_MS = 2 * 3600000; // un jour fini depuis plus de 2 h et pas figé déclenche l'alerte
const EXPORT_PAGE = 200;             // un appel de Worker a 10 ms de calcul : des pages courtes
const NEVER = '0000-00-00';

// Types de travail, dans l'ordre d'affichage. Une ligne sans type (historique) vaut Misc.
export const TYPES = [
  // Quatre ambiances, une par rangée de boutons (chaque famille commence sa rangée) : Orga en tons
  // chauds sourds (gris, brique, rose, brun), Art en tons nature (vert → cyan), Code en tons froids
  // (bleu → magenta), et Contenu en dernier, rangée incomplète, en tons chauds vifs (jaune, orange).
  // Dans une rangée, des teintes nettement différentes. Misc, la tâche par défaut, en gris et toujours
  // en premier.
  { name: 'Misc', color: '#8A8F98', family: 'orga' },
  { name: 'Market', color: '#B91C1C', family: 'orga' },
  { name: 'Social', color: '#DB2777', family: 'orga' },
  { name: 'Production', color: '#92400E', family: 'orga' },
  { name: 'Art', color: '#22C55E', family: 'art' },
  { name: 'Concept', color: '#84CC16', family: 'art' },
  { name: 'TechArt', color: '#14B8A6', family: 'art' },
  { name: 'UI', color: '#06B6D4', family: 'art' },
  { name: 'Dev', color: '#3B82F6', family: 'code' },
  { name: 'Gameplay', color: '#6366F1', family: 'code' },
  { name: 'Tooling', color: '#8B5CF6', family: 'code' },
  { name: 'Debug', color: '#D946EF', family: 'code' },
  { name: 'Writing', color: '#EAB308', family: 'contenu' },
  { name: 'Sound', color: '#F97316', family: 'contenu' },
  // Pause : pas une tâche à choisir mais un état du compteur (bouton ⏸) ; le temps compte, marqué pause.
  { name: 'Pause', color: '#94A3B8', family: 'pause' },
];
const TYPE_NAMES = TYPES.map((t) => t.name);
const DEFAULT_TYPE = 'Misc';
const PAUSE = 'Pause';
// Noms de la première version : encore présents dans l'historique et chez les clients pas à jour.
const LEGACY_TYPES = { Autre: 'Misc', Narration: 'Writing' };

export const TASK_COLUMNS = ['id', 'description', 'project', 'type', 'position', 'done_day', 'started_ms', 'done_ms', 'source', 'created_ms', 'touched_ms', 'deleted_ms'];
const SETTING_COLUMNS = ['key', 'value'];
export const ENTRY_COLUMNS = ['id', 'project', 'kind', 'day', 'start_ms', 'end_ms', 'hours', 'type', 'note', 'source', 'created_ms', 'touched_ms', 'deleted_ms', 'task_ids'];
export const ACTIVE = 'deleted_ms IS NULL';

export class AppError {
  constructor(code, message) { this.code = code; this.message = message; }
}
export function fail(message) { throw new AppError('invalid', message); }

function canonicalType(name) { return Object.hasOwn(LEGACY_TYPES, name) ? LEGACY_TYPES[name] : name; }

// Les tâches d'un morceau : `task_ids`, ids séparés par des virgules (vide : aucune).
function idsOf(value) { return value ? String(value).split(',') : []; }
function joinIds(ids) { return ids && ids.length ? ids.join(',') : null; }
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
// Une session terminée dure 24 h au plus : elle a commencé la veille au plus tôt, d'où la borne sur
// `day` (index) qui évite de relire tout l'historique — D1 facture chaque ligne lue. Seul le compteur
// en cours peut être plus ancien (oublié) : il est ajouté à part.
async function today(db, nowMs, run) {
  const key = dayKey(nowMs);
  const from = dayStart(key);
  const to = nextDayStart(from);
  const rows = await db.all(
    `SELECT * FROM entries WHERE ${ACTIVE} AND day >= ? AND ((kind = 'session' AND start_ms < ? AND COALESCE(end_ms, ?) > ?) OR (kind = 'block' AND day = ?))
     ORDER BY day, start_ms IS NULL, start_ms`,
    [dayKey(from - MAX_SESSION_MS), to, nowMs, from, key],
  );
  if (run && run.start_ms < to && !rows.some((r) => r.id === run.id)) rows.unshift(run);
  return rows;
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
  // `task` : la dernière tâche du morceau, pour les clients d'avant les tâches en parallèle.
  const tasks = idsOf(r.task_ids);
  return { id: r.id, project: r.project, type: typeOf(r), date: r.day, start: iso(r.start_ms), end: iso(r.end_ms), hours, note: r.note || '', source: r.source, tasks, task: tasks.length ? tasks[tasks.length - 1] : null };
}

// État des sauvegardes, pour le bandeau d'alerte : dernière copie de bureau complète, et premier
// jour fini depuis plus de 2 h pas encore figé. Une seule ligne lue (index sur day).
async function backupState(db, cfg, nowMs) {
  const next = await db.first('SELECT day FROM entries WHERE day > ? ORDER BY day LIMIT 1', [cfg.archive_through || NEVER]);
  let desktop = null;
  try { desktop = cfg.backup_desktop ? JSON.parse(cfg.backup_desktop) : null; } catch (e) { desktop = null; }
  return {
    desktopDay: desktop ? desktop.day : null,
    desktopAt: desktop ? iso(desktop.at_ms) : null,
    unfrozenSince: next && workDayEnd(next.day) + FREEZE_GRACE_MS <= nowMs ? next.day : null,
  };
}

// Le choix partagé (projet, activité) : le réglage s'il existe et que le projet existe encore ; sinon
// le compteur en cours hors pause, le dernier travaillé, le premier projet. Activité par défaut : Misc.
export async function readChoice(db, cfg, run, lastRow, projects) {
  if (projects.includes(cfg.choice_project)) {
    const type = canonicalType(cfg.choice_type);
    return { project: cfg.choice_project, type: TYPE_NAMES.includes(type) && type !== PAUSE ? type : DEFAULT_TYPE };
  }
  const from = run && typeOf(run) !== PAUSE ? run : lastRow;
  if (from && projects.includes(from.project)) {
    return { project: from.project, type: typeOf(from) === PAUSE ? DEFAULT_TYPE : typeOf(from) };
  }
  return { project: projects[0] || '', type: DEFAULT_TYPE };
}

// Les réglages qui portent le choix, pour ceux qui diffèrent seulement.
export function choiceChanges(cfg, project, type) {
  const changes = [];
  for (const [key, value] of [['choice_project', project], ['choice_type', type]]) {
    if (cfg[key] === value) continue;
    changes.push(change(cfg[key] === undefined ? null : { key, value: cfg[key] }, { key, value }, 'settings'));
  }
  return changes;
}

// Bascule du compteur en cours vers (project, type, tâches liées) à l'instant `at` : le morceau en
// cours se ferme et un autre s'ouvre à la même seconde dès que l'un des trois change. Rien à faire
// sans compteur, en pause, déjà sur ce morceau, ou si le compteur est oublié (plus de 24 h) : seul le
// choix change alors.
export async function switchTo(ctx, run, project, type, at, taskIds = []) {
  if (!run || typeOf(run) === PAUSE) return [];
  if (run.project === project && typeOf(run) === type && (run.task_ids ?? null) === joinIds(taskIds)) return [];
  const start = Math.max(at, run.start_ms);
  if (start - run.start_ms > MAX_SESSION_MS) return [];
  return [
    change(run, { ...run, end_ms: start, touched_ms: ctx.now }),
    change(null, newSession(ctx, { id: crypto.randomUUID(), project, start, type, taskIds })),
  ];
}

// À faire (dans l'ordre de la liste), puis faites depuis le dernier 6 h (dans l'ordre des coches).
// Une tâche cochée avant ce 6 h reste en base mais n'est plus renvoyée.
async function todoTasks(db) {
  return db.all('SELECT * FROM tasks WHERE deleted_ms IS NULL AND done_ms IS NULL ORDER BY position, created_ms, id');
}
// Les sessions liées à des tâches depuis `fromMs` (index sur start_ms : un morceau n'est jamais bien
// plus ancien que ses tâches, d'où une lecture bornée).
function linkedSessions(db, fromMs) {
  return db.all(
    `SELECT start_ms, end_ms, task_ids FROM entries WHERE ${ACTIVE} AND kind = 'session' AND task_ids IS NOT NULL AND start_ms >= ? ORDER BY start_ms`,
    [fromMs - SPENT_LOOKBACK_MS],
  );
}

// Avec le temps passé sur chacune : les sessions terminées, non supprimées, qui la contiennent. Une
// session avec trois tâches compte entière pour chacune. Le morceau en cours n'y est pas, l'écran
// l'ajoute.
async function listTasks(db, nowMs) {
  const since = localTime(workDayKey(nowMs), 6);
  const [todo, done] = await Promise.all([
    todoTasks(db),
    db.all('SELECT * FROM tasks WHERE deleted_ms IS NULL AND done_ms >= ? ORDER BY done_ms', [since]),
  ]);
  const listed = [...todo, ...done];
  const spentById = new Map();
  if (listed.length) {
    for (const s of await linkedSessions(db, Math.min(...listed.map((t) => t.created_ms)))) {
      if (s.end_ms == null) continue;
      for (const id of idsOf(s.task_ids)) spentById.set(id, (spentById.get(id) || 0) + s.end_ms - s.start_ms);
    }
  }
  return listed.map((r) => ({
    id: r.id, description: r.description, project: r.project, type: typeOf(r), position: r.position,
    done: iso(r.done_ms), started: iso(r.started_ms), spentMs: spentById.get(r.id) || 0,
  }));
}

async function status(ctx) {
  const { db } = ctx;
  const run = await running(db);
  const [cfg, projects, lastRow, todayRows, undo, tasks] = await Promise.all([
    settings(db), projectNames(db), last(db), today(db, ctx.now, run), undoTarget(db), listTasks(db, ctx.now),
  ]);
  const actives = await readActives(db, cfg);
  const backup = await backupState(db, cfg, ctx.now);
  return {
    me: cfg.me || '',
    agent: ctx.agent,
    projects,
    studio: cfg.studio || 'Studio',
    visible: Number(cfg.visible || 4),
    threshold: Number(cfg.threshold || 8),
    running: toApi(run),
    last: toApi(lastRow),
    choice: await readChoice(db, cfg, run, lastRow, projects),
    tasks,
    activeTasks: actives.map((t) => t.id),
    // Pour les clients d'avant les tâches en parallèle : la dernière activée.
    activeTask: actives.length ? actives[actives.length - 1].id : null,
    types: TYPES,
    today: todayRows.map(toApi),
    undo: undo ? { opId: undo.id, summary: undo.summary } : null,
    backup,
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
  if (CONTROL_IN_NOTE.test(text)) fail('La note contient un caractère de contrôle interdit.');
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
    task_ids: joinIds(f.taskIds),
  };
}
function newBlock(ctx, f) {
  return {
    id: f.id, project: f.project, kind: 'block', day: f.day, start_ms: null, end_ms: null, hours: f.hours,
    type: f.type, note: f.note || '', source: source(ctx), created_ms: ctx.now, touched_ms: ctx.now, deleted_ms: null,
    task_ids: null,
  };
}

// ---- Journal ----

const COLUMNS = { entries: ENTRY_COLUMNS, tasks: TASK_COLUMNS, settings: SETTING_COLUMNS };

export function plain(row, table = 'entries') {
  if (!row) return null;
  const out = {};
  for (const c of COLUMNS[table]) out[c] = row[c] ?? null;
  return out;
}
export function change(before, after, table = 'entries') {
  const r = after || before;
  return { table, key: table === 'settings' ? r.key : r.id, before: plain(before, table), after: plain(after, table) };
}

// Écriture d'une ligne dans son état complet (création ou remplacement), ou retrait d'un projet ou d'un réglage.
export function writeRow(table, key, row) {
  if (table === 'projects') {
    return row
      ? { sql: 'INSERT INTO projects (name, position) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET position = excluded.position', params: [row.name, row.position] }
      : { sql: 'DELETE FROM projects WHERE name = ?', params: [key] };
  }
  if (table === 'settings') {
    return row
      ? settingWrite(row.key, row.value)
      : { sql: 'DELETE FROM settings WHERE key = ?', params: [key] };
  }
  const cols = COLUMNS[table];
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
          ON CONFLICT(id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`,
    params: cols.map((c) => row[c] ?? null),
  };
}

// La ligne actuelle d'une table, au format `plain` (projets : { name, position }).
export async function readRow(db, table, key) {
  if (table === 'projects') return db.first('SELECT name, position FROM projects WHERE name = ?', [key]);
  if (table === 'settings') return plain(await db.first('SELECT key, value FROM settings WHERE key = ?', [key]), 'settings');
  return plain(await db.first(`SELECT * FROM ${table} WHERE id = ?`, [key]), table);
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

// Phrase lisible d'une ligne, pour le journal : « Fluffy · Dev 01/10 09:00 → 10:30 », « bloc 4 h Fluffy (01/10) ».
function describe(r) {
  if (r.kind === 'block') {
    const [, m, d] = r.day.split('-');
    return `bloc ${r.hours} h ${r.project} (${d}/${m})`;
  }
  return `${r.project} · ${typeOf(r)} ${shortDate(r.start_ms)} ${clock(r.start_ms)} → ${r.end_ms == null ? 'en cours' : clock(r.end_ms)}`;
}

// La ligne est-elle encore dans l'état laissé par l'action ? (champs de `expected` seulement)
function sameRow(current, expected) {
  if (!current || !expected) return !current && !expected;
  return Object.keys(expected).every((k) => (current[k] ?? null) === (expected[k] ?? null));
}

// ---- Journées figées ----

function settingWrite(key, value) {
  return { sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', params: [key, value] };
}

// Les lignes et les tâches cochées d'un jour (supprimées comprises) copiées dans l'archive, et son résumé : une seule
// transaction. Tout se passe dans la base : le coût pour le Worker ne grandit pas avec l'historique.
function freezeStatements(day, nowMs) {
  const cols = ENTRY_COLUMNS.join(', ');
  const taskCols = TASK_COLUMNS.join(', ');
  return [
    { sql: `INSERT INTO archive_entries (archived_day, ${cols}) SELECT day, ${cols} FROM entries WHERE day = ?`, params: [day] },
    { sql: `INSERT INTO archive_tasks (archived_day, ${taskCols}) SELECT ?, ${taskCols} FROM tasks WHERE done_day = ?`, params: [day, day] },
    {
      sql: `INSERT INTO archive_days (day, archived_ms, row_count, hours)
            SELECT ?, ?, COUNT(*), COALESCE(SUM(CASE WHEN deleted_ms IS NOT NULL THEN 0 WHEN kind = 'block' THEN hours
              WHEN end_ms IS NULL THEN 0 ELSE (end_ms - start_ms) / 3600000.0 END), 0)
            FROM entries WHERE day = ?`,
      params: [day, nowMs, day],
    },
  ];
}

// Fige chaque jour fini (6 h passées le lendemain) pas encore figé, du plus ancien au plus récent.
// `archive_through` retient le dernier jour traité : on ne relit que ce qui vient après. Une ligne
// ajoutée plus tard sur un jour déjà traité reste dans `entries`, le journal et les copies de bureau.
// Appelé par le cron du Worker (server/worker.js).
export async function freezeDays({ db, now }) {
  const through = (await settings(db)).archive_through || NEVER;
  const lastFinished = previousDayKey(workDayKey(now));
  if (through >= lastFinished) return { frozen: [], through };
  const days = (await db.all(
    `SELECT day FROM (SELECT DISTINCT day FROM entries WHERE day > ? AND day <= ?
      UNION SELECT DISTINCT done_day AS day FROM tasks WHERE done_day > ? AND done_day <= ?) ORDER BY day LIMIT ?`,
    [through, lastFinished, through, lastFinished, FREEZE_DAYS_PER_RUN],
  )).map((r) => r.day);
  const already = new Set((await db.all('SELECT day FROM archive_days WHERE day > ? AND day <= ?', [through, lastFinished])).map((r) => r.day));
  const frozen = [];
  for (const day of days) {
    if (already.has(day)) continue;
    await db.batch(freezeStatements(day, now));
    frozen.push(day);
  }
  const next = days.length < FREEZE_DAYS_PER_RUN ? lastFinished : days[days.length - 1];
  await db.batch([settingWrite('archive_through', next)]);
  return { frozen, through: next };
}

// ---- Tâches : validation et tâche active ----

function cleanDescription(value) {
  if (typeof value !== 'string') fail('La description doit être du texte.');
  const text = value.trim();
  if (!text) fail('Description vide.');
  if (text.length > 200) fail('Description trop longue (200 caractères max).');
  if (CONTROL_IN_TASK.test(text)) fail('La description contient un caractère de contrôle interdit.');
  return text;
}
function requireTaskType(value, fallback) {
  const type = requireType(value, fallback);
  if (type === PAUSE) fail('Une tâche ne peut pas avoir l’activité Pause.');
  return type;
}
async function requireLiveTask(ctx, p) {
  const id = requireId(p);
  const row = await ctx.db.first('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!row || row.deleted_ms != null) fail('Tâche introuvable.');
  return row;
}

// Refuse si la liste à faire est pleine ; renvoie la liste.
async function requireRoom(db) {
  const todo = await todoTasks(db);
  if (todo.length >= MAX_TODO) fail(`Liste pleine : ${MAX_TODO} tâches à faire au plus.`);
  return todo;
}

// Les ids du réglage `active_tasks` (liste JSON, ordre d'activation) ; à défaut, l'ancien réglage
// `active_task` d'une seule tâche.
function activeIdsOf(cfg) {
  if (cfg.active_tasks) {
    try {
      const ids = JSON.parse(cfg.active_tasks);
      if (Array.isArray(ids)) return ids.filter((id) => typeof id === 'string');
    } catch (e) { /* réglage illisible : aucune */ }
    return [];
  }
  return cfg.active_task ? [cfg.active_task] : [];
}

// Les tâches actives, dans l'ordre d'activation, encore à faire et non supprimées (un réglage laissé
// par une annulation ne doit jamais remettre une tâche finie en cours).
async function readActives(db, cfg) {
  const ids = activeIdsOf(cfg);
  if (!ids.length) return [];
  const rows = await db.all(`SELECT * FROM tasks WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r) => r && r.deleted_ms == null && r.done_ms == null);
}

// Les réglages qui portent les tâches actives, s'ils changent. L'ancien réglage d'une seule tâche est
// retiré à la première écriture.
function activeChanges(cfg, ids) {
  const changes = [];
  const value = ids.length ? JSON.stringify(ids) : null;
  const current = cfg.active_tasks ?? null;
  if (current !== value) {
    changes.push(change(current === null ? null : { key: 'active_tasks', value: current }, value === null ? null : { key: 'active_tasks', value }, 'settings'));
  }
  if (cfg.active_task !== undefined) changes.push(change({ key: 'active_task', value: cfg.active_task }, null, 'settings'));
  return changes;
}

// Les tâches qu'un morceau reçoit en s'ouvrant : toutes les actives, quel que soit son projet ; aucune
// pour une pause.
function linkIds(type, actives) {
  return type === PAUSE ? [] : actives.map((t) => t.id);
}

// Nouvelle liste de tâches actives : réglages, et un compteur en marche qui bascule à l'instant de
// l'action, même projet, même activité, avec la nouvelle liste. Le choix ne bouge pas.
async function setActives(ctx, cfg, ids, at) {
  const run = await running(ctx.db);
  return [
    ...activeChanges(cfg, ids),
    ...(run ? await switchTo(ctx, run, run.project, typeOf(run), at, ids) : []),
  ];
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
    const cfg = await settings(ctx.db);
    // Le morceau reçoit toutes les tâches actives (aucune pour une pause), quel que soit son projet.
    const taskIds = linkIds(type, await readActives(ctx.db, cfg));
    // Relancer ce qui tourne déjà n'est pas une action.
    if (run && run.project === project && typeOf(run) === type && (run.task_ids ?? null) === joinIds(taskIds)) return;

    let start = actionTime(ctx) - offset * 60000;
    const changes = [];
    if (run) {
      if (start < run.start_ms) start = run.start_ms;
      if (start - run.start_ms > MAX_SESSION_MS) fail(TOO_LONG);
      changes.push(change(run, { ...run, end_ms: start, touched_ms: ctx.now }));
    }
    changes.push(change(null, newSession(ctx, { id, project, start, type, note, taskIds })));
    if (type !== PAUSE) changes.push(...choiceChanges(cfg, project, type));
    await commit(ctx, 'start', `${run ? 'Bascule' : 'Lancement'} ${project} · ${type} à ${clock(start)}`, changes);
  },

  // Change le projet et/ou l'activité du choix partagé. Si un compteur tourne (hors pause), il bascule
  // sur le nouveau choix à l'instant du tap, avec les tâches actives ; en pause ou à l'arrêt, seul le
  // choix change.
  async select(ctx, p) {
    const { db } = ctx;
    const run = await running(db);
    const [cfg, projects, lastRow] = await Promise.all([settings(db), projectNames(db), last(db)]);
    const current = await readChoice(db, cfg, run, lastRow, projects);
    const project = p.project === undefined ? current.project : await requireProject(ctx, p.project);
    const type = requireType(p.type, current.type);
    if (type === PAUSE) fail('Pause n’est pas une activité à choisir.');
    const taskIds = linkIds(type, await readActives(db, cfg));
    // Le choix visé est déjà le choix calculé : on n'écrit pas les réglages d'un choix par défaut.
    const same = project === current.project && type === current.type;
    await commit(ctx, 'select', `Choix ${project} · ${type}`, [
      ...(same ? [] : choiceChanges(cfg, project, type)),
      ...(await switchTo(ctx, run, project, type, actionTime(ctx), taskIds)),
    ]);
  },

  async stop(ctx, p) {
    const run = await running(ctx.db);
    let end;
    if (p.endAt !== undefined && p.endAt !== null) {
      if (!run) fail('Aucun compteur en cours.');
      end = parseInstant(p.endAt, 'Heure de fin');
      if (end <= run.start_ms) fail('La fin doit être après le début.');
      if (end > ctx.now) fail('La fin ne peut pas être dans le futur.');
      if (end - run.start_ms > MAX_SESSION_MS) fail('La fin doit être au plus 24 h après le début.');
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
    if (CONTROL_IN_NAME.test(name)) fail('Caractères de contrôle interdits dans un nom de projet.');
    const taken = (await projectNames(ctx.db)).some((n) => n.toLowerCase() === name.toLowerCase());
    if (taken) fail('Ce nom est déjà pris : ' + name);
    const { position } = await ctx.db.first('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM projects');
    await commit(ctx, 'addProject', `Projet ${name} créé`, [{ table: 'projects', key: name, before: null, after: { name, position } }]);
  },

  async deleteEntry(ctx, p) {
    const row = typeof p.id === 'string' ? await byId(ctx.db, p.id) : null;
    if (!row) fail('Ligne introuvable.');
    if (row.deleted_ms != null) return;
    await commit(ctx, 'deleteEntry', `Suppression ${describe(row)}`, [change(row, { ...row, deleted_ms: ctx.now, touched_ms: ctx.now })]);
  },

  async editEntry(ctx, p) {
    const row = typeof p.id === 'string' ? await byId(ctx.db, p.id) : null;
    if (!row || row.deleted_ms != null) fail('Ligne introuvable.');
    const next = { ...row };
    if (p.project !== undefined) next.project = await requireProject(ctx, p.project);
    if (p.type !== undefined) next.type = requireType(p.type, typeOf(row));
    if (p.note !== undefined) next.note = cleanNote(p.note);
    if (row.kind === 'block') {
      if (p.start !== undefined || p.end !== undefined) fail('Un bloc n’a ni début ni fin : corrige ses heures.');
      if (p.hours !== undefined) next.hours = requireBlockHours(p.hours);
    } else {
      if (p.hours !== undefined) fail('Pour une session, corrige le début ou la fin.');
      if (p.start !== undefined) next.start_ms = parseInstant(p.start, 'Début');
      if (p.end !== undefined) {
        if (row.end_ms == null) fail('Pour arrêter le compteur en cours, utilise STOP.');
        next.end_ms = parseInstant(p.end, 'Fin');
      }
      const end = next.end_ms ?? ctx.now;
      if (next.start_ms > ctx.now) fail('Le début ne peut pas être dans le futur.');
      if (next.end_ms != null && next.end_ms <= next.start_ms) fail('La fin doit être après le début.');
      if (next.end_ms != null && next.end_ms > ctx.now) fail('La fin ne peut pas être dans le futur.');
      if (end - next.start_ms > MAX_SESSION_MS) fail('Une session ne peut pas dépasser 24 h.');
      next.day = dayKey(next.start_ms);
      if (next.start_ms !== row.start_ms || next.end_ms !== row.end_ms) {
        const o = await overlapping(ctx, next.start_ms, end, row.id);
        if (o) fail(`Chevauche une autre session (${o.project}, ${shortDate(o.start_ms)} ${clock(o.start_ms)}).`);
      }
    }
    if (['project', 'type', 'note', 'hours', 'start_ms', 'end_ms', 'day'].every((f) => next[f] === row[f])) return;
    next.touched_ms = ctx.now;
    await commit(ctx, 'editEntry', `Correction ${describe(next)}`, [change(row, next)]);
  },

  // ---- Tâches ----

  async addTask(ctx, p) {
    const id = requireId(p);
    // Les tâches d'une session sont rangées séparées par des virgules (entries.task_ids).
    if (id.includes(',')) fail('Identifiant de tâche non valide (virgule).');
    const description = cleanDescription(p.description);
    const { db } = ctx;
    const [cfg, projects, lastRow, run] = await Promise.all([settings(db), projectNames(db), last(db), running(db)]);
    const current = await readChoice(db, cfg, run, lastRow, projects);
    const project = await requireProject(ctx, p.project === undefined || p.project === null ? current.project : p.project);
    const type = requireTaskType(p.type, current.type);
    if (await db.first('SELECT id FROM tasks WHERE id = ?', [id])) return;
    await requireRoom(db);
    const { position } = await db.first('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM tasks WHERE deleted_ms IS NULL AND done_ms IS NULL');
    const task = {
      id, description, project, type, position, done_day: null, started_ms: null, done_ms: null,
      source: source(ctx), created_ms: ctx.now, touched_ms: ctx.now, deleted_ms: null,
    };
    await commit(ctx, 'addTask', `Tâche ajoutée : ${description}`, [change(null, task, 'tasks')]);
  },

  // La tâche seulement : une tâche active ne tient pas le compteur sur son projet.
  async editTask(ctx, p) {
    const row = await requireLiveTask(ctx, p);
    const next = { ...row };
    if (p.description !== undefined) next.description = cleanDescription(p.description);
    if (p.project !== undefined) next.project = await requireProject(ctx, p.project);
    if (p.type !== undefined) next.type = requireTaskType(p.type, row.type);
    if (['description', 'project', 'type'].every((f) => next[f] === row[f])) return;
    next.touched_ms = ctx.now;
    await commit(ctx, 'editTask', `Tâche modifiée : ${next.description}`, [change(row, next, 'tasks')]);
  },

  async deleteTask(ctx, p) {
    const id = requireId(p);
    const row = await ctx.db.first('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!row) fail('Tâche introuvable.');
    if (row.deleted_ms != null) return;
    const changes = [change(row, { ...row, deleted_ms: ctx.now, touched_ms: ctx.now }, 'tasks')];
    const cfg = await settings(ctx.db);
    const ids = (await readActives(ctx.db, cfg)).map((t) => t.id);
    if (ids.includes(row.id)) changes.push(...(await setActives(ctx, cfg, ids.filter((x) => x !== row.id), actionTime(ctx))));
    await commit(ctx, 'deleteTask', `Tâche supprimée : ${row.description}`, changes);
  },

  async moveTask(ctx, p) {
    const row = await requireLiveTask(ctx, p);
    if (row.done_ms != null) fail('Cette tâche est déjà cochée : elle n’est plus dans la liste.');
    const before = p.before === undefined ? null : p.before;
    if (before !== null && (typeof before !== 'string' || before === row.id)) fail('Position de destination non valide.');
    const todo = await todoTasks(ctx.db);
    const others = todo.filter((t) => t.id !== row.id);
    let index = others.length;
    if (before !== null) {
      index = others.findIndex((t) => t.id === before);
      if (index < 0) fail('Position de destination non valide.');
    }
    const order = [...others.slice(0, index), row, ...others.slice(index)];
    if (order.every((t, i) => t.id === todo[i].id)) return;
    const changes = [];
    order.forEach((t, i) => {
      if (t.position !== i + 1) changes.push(change(t, { ...t, position: i + 1, touched_ms: ctx.now }, 'tasks'));
    });
    if (!changes.length) return;
    await commit(ctx, 'moveTask', `Tâche déplacée : ${row.description}`, changes);
  },

  // Valide. Une tâche active sort de la liste : le compteur continue sans elle, à la même seconde.
  async checkTask(ctx, p) {
    const row = await requireLiveTask(ctx, p);
    if (row.done_ms != null) return;
    const doneMs = actionTime(ctx);
    const doneDay = workDayKey(doneMs);
    const cfg = await settings(ctx.db);
    const ids = (await readActives(ctx.db, cfg)).map((t) => t.id);
    const changes = ids.includes(row.id) ? await setActives(ctx, cfg, ids.filter((x) => x !== row.id), doneMs) : [];
    // Début = le premier morceau passé dessus (le morceau fermé par cette validation compris).
    const first = (await linkedSessions(ctx.db, row.created_ms)).find((s) => idsOf(s.task_ids).includes(row.id));
    const startedMs = first && first.start_ms <= doneMs ? first.start_ms : null;
    const next = { ...row, done_ms: doneMs, done_day: doneDay, started_ms: startedMs, touched_ms: ctx.now };
    await commit(ctx, 'checkTask', `Tâche validée : ${row.description}`, [change(row, next, 'tasks'), ...changes]);
  },

  async uncheckTask(ctx, p) {
    const row = await requireLiveTask(ctx, p);
    if (row.done_ms == null) return;
    const todo = await requireRoom(ctx.db);
    // La tâche reprend sa position : les tâches à faire à cette position ou après descendent d'un cran,
    // pour que les positions restent uniques (même ordre sur le serveur et à l'écran).
    const next = { ...row, done_ms: null, done_day: null, started_ms: null, touched_ms: ctx.now };
    const changes = [change(row, next, 'tasks')];
    for (const t of todo) {
      if (t.position >= row.position) changes.push(change(t, { ...t, position: t.position + 1, touched_ms: ctx.now }, 'tasks'));
    }
    await commit(ctx, 'uncheckTask', `Tâche dévalidée : ${row.description}`, changes);
  },

  // La tâche rejoint celles en cours : son projet et son activité deviennent le choix, et un compteur
  // en marche bascule dessus avec toutes les tâches actives, à la même seconde.
  async activateTask(ctx, p) {
    const row = await requireLiveTask(ctx, p);
    if (row.done_ms != null) fail('Cette tâche est déjà validée.');
    const cfg = await settings(ctx.db);
    const ids = (await readActives(ctx.db, cfg)).map((t) => t.id);
    if (ids.includes(row.id)) return;
    if (ids.length >= MAX_ACTIVE) fail(`${MAX_ACTIVE} tâches en cours au plus : valide ou désactive-en une d’abord.`);
    const next = [...ids, row.id];
    const type = typeOf(row);
    await commit(ctx, 'activateTask', `Tâche activée : ${row.description}`, [
      ...activeChanges(cfg, next),
      ...choiceChanges(cfg, row.project, type),
      ...(await switchTo(ctx, await running(ctx.db), row.project, type, actionTime(ctx), next)),
    ]);
  },

  // Sort une tâche de celles en cours (toutes, sans `id`) ; le choix ne bouge pas.
  async deactivateTask(ctx, p) {
    const cfg = await settings(ctx.db);
    const actives = await readActives(ctx.db, cfg);
    const gone = p.id === undefined || p.id === null ? actives : actives.filter((t) => t.id === p.id);
    if (!gone.length) return;
    const next = actives.filter((t) => !gone.includes(t)).map((t) => t.id);
    const summary = gone.length === 1 ? `Tâche désactivée : ${gone[0].description}` : `${gone.length} tâches désactivées`;
    await commit(ctx, 'deactivateTask', summary, await setActives(ctx, cfg, next, actionTime(ctx)));
  },

  // Annule l'action opId, si c'est la dernière non annulée. Les changements sont défaits dans l'ordre
  // inverse (une bascule : d'abord retirer le nouveau compteur, puis rouvrir l'ancien).
  async undo(ctx, p) {
    const opId = Number(p.opId);
    if (!Number.isInteger(opId)) fail('Action à annuler manquante.');
    const op = await ctx.db.first('SELECT * FROM ops WHERE id = ?', [opId]);
    if (!op) fail('Action introuvable.');
    if (op.undone_ms != null) return; // déjà annulée : une requête rejouée ne fait rien
    const latest = await undoTarget(ctx.db);
    if (!latest || latest.id !== opId) fail('Une autre action a eu lieu entre-temps : rien n’est annulé.');
    const stmts = [];
    for (const c of JSON.parse(op.changes).reverse()) {
      const current = await readRow(ctx.db, c.table, c.key);
      if (!sameRow(current, c.after)) fail('La ligne a changé depuis : rien n’est annulé.');
      // Une entrée ou une tâche créée par l'action est marquée supprimée : son id reste pris (idempotence).
      const restore = (c.table === 'entries' || c.table === 'tasks') && !c.before ? { ...c.after, deleted_ms: ctx.now } : c.before;
      stmts.push(writeRow(c.table, c.key, restore));
    }
    stmts.push({ sql: 'UPDATE ops SET undone_ms = ? WHERE id = ?', params: [ctx.now, opId] });
    await ctx.db.batch(stmts);
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

  // ---- Sauvegardes ----

  // Une page d'une table, dans l'ordre de stockage (rowid) : la mini-fenêtre enchaîne les pages
  // jusqu'à `next: null`. Des pages courtes : un appel de Worker n'a que 10 ms de calcul.
  async export(ctx, p) {
    const table = TABLES.find((t) => t.name === p.table);
    if (!table) fail('Table inconnue : ' + p.table);
    const after = p.after === undefined || p.after === null ? 0 : Number(p.after);
    if (!Number.isInteger(after) || after < 0) fail('Curseur de page non valide.');
    const limit = p.limit === undefined || p.limit === null ? EXPORT_PAGE : Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_PAGE) fail(`Taille de page : 1 à ${EXPORT_PAGE}.`);
    const cols = Object.keys(table.columns).join(', ');
    const rows = await ctx.db.all(`SELECT rowid AS _rowid, ${cols} FROM ${table.name} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [after, limit]);
    return {
      table: table.name,
      rows: rows.map(({ _rowid, ...row }) => row),
      next: rows.length === limit ? rows[rows.length - 1]._rowid : null,
    };
  },

  // L'empreinte de chaque table, calculée par la base (server/backup.js).
  async exportCheck(ctx) {
    const tables = {};
    for (const t of TABLES) tables[t.name] = { ...(await ctx.db.first(fingerprintSql(t))) };
    return { tables };
  },

  // La mini-fenêtre a rangé la copie du jour dans tous ses dossiers. Un réglage, hors du journal :
  // ce n'est pas une action que l'agent devrait pouvoir annuler.
  async backupDone(ctx, p) {
    if (typeof p.day !== 'string' || !DAY_KEY.test(p.day)) fail('Jour attendu au format aaaa-mm-jj.');
    await ctx.db.batch([settingWrite('backup_desktop', JSON.stringify({ day: p.day, at_ms: ctx.now }))]);
  },

  // Les lignes d'un jour figé, telles qu'elles étaient à 6 h le lendemain.
  async archivedDay(ctx, p) {
    if (typeof p.day !== 'string' || !DAY_KEY.test(p.day)) fail('Jour attendu au format aaaa-mm-jj.');
    const info = await ctx.db.first('SELECT archived_ms FROM archive_days WHERE day = ?', [p.day]);
    const rows = await ctx.db.all('SELECT * FROM archive_entries WHERE archived_day = ? ORDER BY start_ms IS NULL, start_ms, created_ms', [p.day]);
    return {
      day: p.day,
      archivedAt: info ? iso(info.archived_ms) : null,
      rows: rows.map((r) => ({ ...toApi(r), deleted: r.deleted_ms != null })),
    };
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
