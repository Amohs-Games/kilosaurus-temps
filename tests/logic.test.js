// Tests des calculs de l'app. L'app calcule en heure locale : on fixe celle de Paris.
process.env.TZ = 'Europe/Paris';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../web/logic.js');

const base = () => ({
  me: 'Amohs', projects: ['Fluffy', 'Heirfall', 'Proto', 'Jam', 'Studio'], studio: 'Studio', visible: 4,
  threshold: 8, running: null, last: null,
});

test('formats', () => {
  assert.equal(L.elapsed(8047000), '2:14:07');
  assert.equal(L.elapsed(-5), '0:00:00');
  assert.equal(L.duration(3.47), '3 h 28');
  assert.equal(L.duration(8), '8 h');
  assert.equal(L.clock('2026-10-01T07:05:00Z'), '09:05');
});

test('libellé du jour', () => {
  const now = new Date('2026-10-01T12:00:00+02:00');
  assert.equal(L.dayLabel('2026-10-01', now), "aujourd'hui");
  assert.equal(L.dayLabel('2026-09-30', now), 'hier');
  assert.match(L.dayLabel('2026-09-14', now), /14/);
});

test('boutons visibles : le studio à part, le surplus derrière « Plus… »', () => {
  assert.deepEqual(L.visibleProjects(base()), { shown: ['Fluffy', 'Heirfall', 'Proto', 'Jam'], more: [] });
  const s = Object.assign(base(), { projects: ['A', 'B', 'C', 'D', 'E', 'Studio'] });
  assert.deepEqual(L.visibleProjects(s), { shown: ['A', 'B', 'C'], more: ['D', 'E'] });
});

test('oubli détecté au-delà du seuil', () => {
  const s = Object.assign(base(), { running: { start: '2026-10-01T08:00:00+02:00' } });
  assert.equal(L.isForgotten(s, new Date('2026-10-01T15:59:00+02:00').getTime()), false);
  assert.equal(L.isForgotten(s, new Date('2026-10-01T16:01:00+02:00').getTime()), true);
  assert.equal(L.isForgotten(base(), Date.now()), false);
});

test('optimiste : bascule avec décalage, sans chevauchement', () => {
  let s = L.applyLocal(base(), { action: 'start', params: { id: 'a1', project: 'Fluffy' }, clientTime: '2026-10-01T09:00:00+02:00' });
  s = L.applyLocal(s, { action: 'start', params: { id: 'a2', project: 'Jam', offsetMinutes: 30 }, clientTime: '2026-10-01T10:30:00+02:00' });
  assert.equal(s.last.id, 'a1');
  assert.equal(s.last.hours, 1);
  assert.equal(s.running.start, new Date('2026-10-01T10:00:00+02:00').toISOString());
});

test('optimiste : relancer le projet en cours ne fait rien', () => {
  const s1 = L.applyLocal(base(), { action: 'start', params: { id: 'a1', project: 'Fluffy' }, clientTime: '2026-10-01T09:00:00+02:00' });
  const s2 = L.applyLocal(s1, { action: 'start', params: { id: 'a2', project: 'Fluffy' }, clientTime: '2026-10-01T09:30:00+02:00' });
  assert.equal(s2.running.id, 'a1');
});

test('optimiste : stop, oubli, bloc, nouveau projet', () => {
  let s = L.applyLocal(base(), { action: 'start', params: { id: 'a1', project: 'Fluffy' }, clientTime: '2026-10-01T09:00:00+02:00' });
  s = L.applyLocal(s, { action: 'stop', params: { endAt: '2026-10-01T17:00:00+02:00' }, clientTime: '2026-10-02T08:00:00+02:00' });
  assert.equal(s.running, null);
  assert.equal(s.last.hours, 8);
  assert.equal(s.last.corrected, true);
  s = L.applyLocal(s, { action: 'logBlock', params: { id: 'b1', project: 'Studio', hours: 4 }, clientTime: '2026-10-02T08:00:00+02:00' });
  assert.equal(s.last.date, '2026-10-02');
  s = L.applyLocal(s, { action: 'addProject', params: { name: 'Nouveau' }, clientTime: '2026-10-02T08:02:00+02:00' });
  assert.equal(s.projects.at(-1), 'Nouveau');
});

test('optimiste : ne modifie pas l\'état d\'origine', () => {
  const s = base();
  L.applyLocal(s, { action: 'start', params: { id: 'a1', project: 'Fluffy' }, clientTime: '2026-10-01T09:00:00+02:00' });
  assert.equal(s.running, null);
});

const at = (iso) => new Date(iso).getTime();
const sess = (id, type, start, end, project = 'Fluffy') => ({
  id, project, type, date: L.dayKey(start), start: new Date(start).toISOString(),
  end: end ? new Date(end).toISOString() : null, hours: end ? L.hoursBetween(start, end) : null,
});

test('studio masqué sauf réglage', () => {
  const s = Object.assign(base(), { projects: ['Fluffy', 'Heirfall', 'Studio'] });
  assert.deepEqual(L.visibleProjects(s, false).shown, ['Fluffy', 'Heirfall']);
  assert.deepEqual(L.visibleProjects(s, true).shown, ['Fluffy', 'Heirfall', 'Studio']);
  assert.deepEqual(L.pickableProjects(s, false), ['Fluffy', 'Heirfall']);
});

test('optimiste : bascule de type, même type sans effet, today tenu à jour', () => {
  let s = L.applyLocal(base(), { action: 'start', params: { id: 'a', project: 'Fluffy', type: 'Dev' }, clientTime: '2026-10-01T09:00:00+02:00' });
  s = L.applyLocal(s, { action: 'start', params: { id: 'b', project: 'Fluffy', type: 'Dev' }, clientTime: '2026-10-01T09:10:00+02:00' });
  assert.equal(s.running.id, 'a');
  s = L.applyLocal(s, { action: 'start', params: { id: 'c', project: 'Fluffy', type: 'Art' }, clientTime: '2026-10-01T09:30:00+02:00' });
  assert.equal(s.running.type, 'Art');
  assert.equal(s.last.type, 'Dev');
  assert.deepEqual(s.today.map((r) => r.id), ['a', 'c']);
  assert.equal(s.today[0].end, new Date('2026-10-01T09:30:00+02:00').toISOString());
  s = L.applyLocal(s, { action: 'start', params: { id: 'd', project: 'Heirfall' }, clientTime: '2026-10-01T10:00:00+02:00' });
  assert.equal(s.running.type, 'Art');
});

test('total du jour : la session d\'hier soir ne compte que pour aujourd\'hui', () => {
  const now = at('2026-10-01T10:00:00+02:00');
  const rows = [
    sess('n', 'Dev', '2026-09-30T23:00:00+02:00', '2026-10-01T01:00:00+02:00'),
    sess('m', 'Art', '2026-10-01T08:00:00+02:00', null),
    { id: 'b', project: 'Fluffy', type: 'Misc', date: '2026-10-01', start: null, end: null, hours: 2 },
    { id: 'old', project: 'Fluffy', type: 'Misc', date: '2026-09-30', start: null, end: null, hours: 4 },
  ];
  assert.equal(L.todayTotal(rows, now), 1 + 2 + 2);
});

test('frise : de 8 h (ou plus tôt) à maintenant, segments découpés à minuit', () => {
  const now = at('2026-10-01T10:00:00+02:00');
  const t = L.dayTimeline([sess('n', 'Dev', '2026-09-30T23:00:00+02:00', '2026-10-01T01:00:00+02:00')], now);
  assert.equal(t.from, at('2026-10-01T00:00:00+02:00'));
  assert.equal(t.to, now);
  assert.deepEqual(t.segments, [{ start: at('2026-10-01T00:00:00+02:00'), end: at('2026-10-01T01:00:00+02:00'), type: 'Dev' }]);
  const t2 = L.dayTimeline([sess('m', 'Art', '2026-10-01T09:00:00+02:00', null)], now);
  assert.equal(t2.from, at('2026-10-01T08:00:00+02:00'));
  assert.equal(t2.segments[0].end, now);
});

test('ancien état en cache (v1.0) : rien ne casse', () => {
  const old = base();
  assert.equal(L.todayTotal(old.today, Date.now()), 0);
  assert.deepEqual(L.typesOf(old).map((t) => t.name), ['Misc', 'Market', 'Social', 'Production', 'Art', 'Concept', 'TechArt', 'UI', 'Dev', 'Gameplay', 'Tooling', 'Debug', 'Writing', 'Sound', 'Pause']);
  assert.equal(L.typeOf({ project: 'Fluffy' }), 'Misc');
  const s = L.applyLocal(old, { action: 'start', params: { id: 'a', project: 'Fluffy' }, clientTime: '2026-10-01T09:00:00+02:00' });
  assert.equal(s.running.type, 'Misc');
});

test('semaine : lundi → dimanche, 7 jours même au passage à l\'heure d\'hiver', () => {
  const w = L.weekRange(new Date('2026-10-25T12:00:00+01:00'));
  assert.equal(w.from, '2026-10-19');
  assert.equal(w.to, '2026-10-25');
  assert.deepEqual(w.days, ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  const m = L.monthRange(new Date('2026-02-10T12:00:00+01:00'));
  assert.equal(m.from, '2026-02-01');
  assert.equal(m.to, '2026-02-28');
  assert.equal(m.days.length, 28);
});

test('agrégats : par jour, par type, par projet', () => {
  const now = at('2026-10-01T12:00:00+02:00');
  const rows = [
    sess('a', 'Dev', '2026-09-29T09:00:00+02:00', '2026-09-29T12:00:00+02:00', 'Fluffy'),
    sess('b', 'Art', '2026-09-30T09:00:00+02:00', '2026-09-30T10:00:00+02:00', 'Heirfall'),
    { id: 'c', project: 'Heirfall', type: 'Misc', date: '2026-09-30', start: null, end: null, hours: 2 },
    sess('d', 'Dev', '2026-10-01T11:00:00+02:00', null, 'Heirfall'),
  ];
  const g = L.aggregate(rows, ['2026-09-29', '2026-09-30', '2026-10-01'], now);
  assert.equal(g.total, 3 + 1 + 2 + 1);
  assert.deepEqual(g.byType, { Dev: 4, Art: 1, Misc: 2 });
  assert.deepEqual(g.byProject, { Fluffy: 3, Heirfall: 4 });
  assert.equal(g.byDay['2026-09-30'].total, 3);
  assert.deepEqual(g.byDay['2026-09-30'].byType, { Art: 1, Misc: 2 });
});

test('récap : une réponse ne vaut que pour la période affichée', () => {
  const week = L.weekRange(new Date('2026-10-01T12:00:00+02:00'));
  const month = L.monthRange(new Date('2026-10-01T12:00:00+02:00'));
  assert.equal(L.recapMatches(month, { from: month.from, to: month.to, rows: [] }), true);
  assert.equal(L.recapMatches(month, { from: week.from, to: week.to, rows: [] }), false);
  assert.equal(L.recapMatches(month, null), false);
});

test('anciens noms de type (état en cache) : Autre → Misc, Narration → Writing', () => {
  assert.equal(L.typeOf({ type: 'Autre' }), 'Misc');
  assert.equal(L.typeOf({ type: 'Narration' }), 'Writing');
  assert.equal(L.typeOf({ type: 'Dev' }), 'Dev');
  const g = L.aggregate([{ id: 'a', project: 'Fluffy', type: 'Narration', date: '2026-10-01', start: null, end: null, hours: 2 }], ['2026-10-01'], Date.now());
  assert.deepEqual(g.byType, { Writing: 2 });
});

test('texte lisible sur une couleur de tâche : sombre sur clair, blanc sur foncé', () => {
  assert.equal(L.textOn('#EAB308'), '#17171b');
  assert.equal(L.textOn('#18181B'), '#ffffff');
  assert.equal(L.textOn('#3B82F6'), '#ffffff');
});

test('couleur des boutons de projet : Fluffy en bleu, les autres en vert', () => {
  assert.equal(L.projectColor('Fluffy'), L.projectColor('fluffy'));
  assert.notEqual(L.projectColor('Fluffy'), L.projectColor('Heirfall'));
  assert.equal(L.projectColor('Heirfall'), L.projectColor('Proto'));
});

test('travaillé aujourd’hui : total du jour moins les pauses', () => {
  const now = at('2026-10-01T12:00:00+02:00');
  const rows = [
    sess('y', 'Dev', '2026-09-30T23:00:00+02:00', '2026-10-01T01:00:00+02:00'), // 1 h après minuit
    sess('a', 'Dev', '2026-10-01T09:00:00+02:00', '2026-10-01T10:00:00+02:00'), // 1 h
    sess('p', 'Pause', '2026-10-01T10:00:00+02:00', '2026-10-01T10:30:00+02:00'), // 0,5 h de pause
    { id: 'b', project: 'Fluffy', type: 'Misc', date: '2026-10-01', start: null, end: null, hours: 1 }, // bloc
    sess('c', 'Dev', '2026-10-01T10:30:00+02:00', null), // en cours : 1,5 h
  ];
  assert.equal(L.todayTotal(rows, now), 5);
  assert.equal(L.todayWorked(rows, now), 4.5);
  assert.equal(L.todayWorked([], now), 0);
});

test('familles de tâches : Orga (Misc en premier), puis Art, Code, Contenu', () => {
  const fam = L.typesOf(base()).map((t) => t.family);
  assert.deepEqual(fam, ['orga', 'orga', 'orga', 'orga', 'art', 'art', 'art', 'art', 'code', 'code', 'code', 'code', 'contenu', 'contenu', 'pause']);
});

test('pause du jour : comptée à part, et incluse dans le total', () => {
  const now = at('2026-10-01T12:00:00+02:00');
  const rows = [
    sess('a', 'Dev', '2026-10-01T09:00:00+02:00', '2026-10-01T10:00:00+02:00'),
    sess('p', 'Pause', '2026-10-01T10:00:00+02:00', '2026-10-01T10:30:00+02:00'),
    sess('b', 'Dev', '2026-10-01T10:30:00+02:00', null),
  ];
  assert.equal(L.todayTotal(rows, now), 3);
  assert.equal(L.todayPause(rows, now), 0.5);
  assert.equal(L.isPause({ type: 'Pause' }), true);
  assert.equal(L.isPause({ type: 'Dev' }), false);
});

test('séance : le compteur part du lancement, la pause se cumule, un autre projet ou un trou repart à zéro', () => {
  const now = at('2026-10-01T11:00:00+02:00');
  const rows = [
    sess('old', 'Dev', '2026-10-01T07:00:00+02:00', '2026-10-01T08:00:00+02:00', 'Fluffy'),     // trou de 30 min après
    sess('a', 'Dev', '2026-10-01T08:30:00+02:00', '2026-10-01T09:00:00+02:00', 'Fluffy'),
    sess('p1', 'Pause', '2026-10-01T09:00:00+02:00', '2026-10-01T09:10:00+02:00', 'Fluffy'),
    sess('b', 'Art', '2026-10-01T09:10:00+02:00', '2026-10-01T10:30:00+02:00', 'Fluffy'),
    sess('p2', 'Pause', '2026-10-01T10:30:00+02:00', null, 'Fluffy'),
  ];
  const run = rows[4];
  const s = L.sessionOf(rows, run, now);
  assert.equal(s.start, at('2026-10-01T08:30:00+02:00'));
  assert.equal(s.pauseMs, (10 + 30) * 60000);
  const other = [sess('x', 'Dev', '2026-10-01T09:00:00+02:00', '2026-10-01T10:00:00+02:00', 'Heirfall'),
    sess('y', 'Dev', '2026-10-01T10:00:00+02:00', null, 'Fluffy')];
  assert.equal(L.sessionOf(other, other[1], now).start, at('2026-10-01T10:00:00+02:00'));
  assert.equal(L.sessionOf([], { start: new Date(now - 60000).toISOString(), type: 'Dev', project: 'Fluffy' }, now).pauseMs, 0);
});

test('correction : seuls les champs changés partent', () => {
  const row = { id: 'a', project: 'Fluffy', type: 'Dev', note: '', start: '2026-10-01T09:12:37+02:00', end: '2026-10-01T10:30:00+02:00', hours: 1.29 };
  assert.equal(L.entryEdit(row, { start: '09:12', end: '10:30', project: 'Fluffy', type: 'Dev', note: '' }), null, 'les secondes du début ne comptent pas');
  assert.deepEqual(L.entryEdit(row, { start: '09:12', end: '11:00', project: 'Fluffy', type: 'Dev', note: '' }), { end: new Date('2026-10-01T11:00:00+02:00').toISOString() });
  assert.deepEqual(L.entryEdit(row, { start: '08:00', end: '10:30', project: 'Jam', type: 'Art', note: ' boss ' }), {
    project: 'Jam', type: 'Art', note: 'boss', start: new Date('2026-10-01T08:00:00+02:00').toISOString(),
  });
});

test('correction : fin après minuit', () => {
  const row = { id: 'a', project: 'Fluffy', type: 'Dev', note: '', start: '2026-09-30T23:00:00+02:00', end: '2026-09-30T23:30:00+02:00' };
  assert.deepEqual(L.entryEdit(row, { start: '23:00', end: '01:15', project: 'Fluffy', type: 'Dev', note: '' }), { end: new Date('2026-10-01T01:15:00+02:00').toISOString() });
});

test('correction : compteur en cours (pas de fin), bloc (heures)', () => {
  const running = { id: 'r', project: 'Fluffy', type: 'Misc', note: '', start: '2026-10-01T09:00:00+02:00', end: null };
  assert.deepEqual(L.entryEdit(running, { start: '08:30', end: null, project: 'Fluffy', type: 'Misc', note: '' }), { start: new Date('2026-10-01T08:30:00+02:00').toISOString() });
  const block = { id: 'b', project: 'Fluffy', type: 'Misc', note: '', start: null, end: null, hours: 8 };
  assert.deepEqual(L.entryEdit(block, { hours: 6, project: 'Fluffy', type: 'Misc', note: '' }), { hours: 6 });
  assert.equal(L.entryEdit(block, { hours: 8, project: 'Fluffy', type: 'Misc', note: '' }), null);
});

test('session anormalement longue : au-delà du seuil d\'oubli', () => {
  const now = at('2026-10-02T12:00:00+02:00');
  assert.equal(L.isLong(sess('a', 'Dev', '2026-10-01T13:05:00+02:00', '2026-10-02T03:07:00+02:00'), 8, now), true);
  assert.equal(L.isLong(sess('b', 'Dev', '2026-10-01T09:00:00+02:00', '2026-10-01T12:00:00+02:00'), 8, now), false);
  assert.equal(L.isLong({ start: null, hours: 10 }, 8, now), false, 'un bloc n\'est jamais signalé');
});

test('oubli : l\'heure de fin proposée va au plus à 24 h du début, jamais dans le futur', () => {
  assert.equal(L.forgotMax('2026-10-01T09:00:00+02:00', at('2026-10-03T12:00:00+02:00')).toISOString(), new Date('2026-10-02T09:00:00+02:00').toISOString());
  assert.equal(L.forgotMax('2026-10-01T09:00:00+02:00', at('2026-10-01T18:00:00+02:00')).toISOString(), new Date('2026-10-01T18:00:00+02:00').toISOString());
});

test('alertes de sauvegarde', () => {
  const now = Date.parse('2026-10-08T12:00:00+02:00');
  assert.deepEqual(L.backupWarnings(undefined, now), []);
  assert.deepEqual(L.backupWarnings({ desktopAt: '2026-10-07T07:00:00.000Z', unfrozenSince: null }, now), []);
  assert.deepEqual(L.backupWarnings({ desktopAt: null, unfrozenSince: null }, now), ['Aucune sauvegarde complète (PC et Drive) pour l’instant.']);
  assert.deepEqual(L.backupWarnings({ desktopAt: '2026-10-05T07:00:00.000Z', unfrozenSince: '2026-10-03' }, now), [
    'Pas de sauvegarde complète (PC et Drive) depuis 3 jours.',
    'Journées non figées depuis le 03/10.',
  ]);
});

// ---- Tâches et choix partagé (rejoue les scénarios du serveur) ----

const T0 = '2026-10-01T10:00:00+02:00';
const T1 = '2026-10-01T10:30:00+02:00';
const T2 = '2026-10-01T11:00:00+02:00';
const act = (s, action, params, clientTime) => L.applyLocal(s, { action, params, clientTime: clientTime || T1 });
const withTasks = () => Object.assign(base(), { tasks: [], choice: { project: 'Fluffy', type: 'Misc' } });
const todoIds = (s) => L.todoTasks(s).map((t) => t.id);

test('choiceOf : le choix du statut, sinon le compteur hors pause, sinon le dernier, sinon le premier projet', () => {
  assert.deepEqual(L.choiceOf(withTasks()), { project: 'Fluffy', type: 'Misc' });
  const running = { project: 'Jam', type: 'Dev', start: T0 };
  assert.deepEqual(L.choiceOf(Object.assign(base(), { running })), { project: 'Jam', type: 'Dev' });
  const pause = { project: 'Jam', type: 'Pause', start: T0 };
  const last = { project: 'Proto', type: 'Art' };
  assert.deepEqual(L.choiceOf(Object.assign(base(), { running: pause, last })), { project: 'Proto', type: 'Art' });
  assert.deepEqual(L.choiceOf(Object.assign(base(), { last: { project: 'Proto', type: 'Pause' } })), { project: 'Proto', type: 'Misc' });
  assert.deepEqual(L.choiceOf(base()), { project: 'Fluffy', type: 'Misc' });
  assert.deepEqual(L.choiceOf(null), { project: '', type: 'Misc' });
});

test('un ancien état sans tasks ni choice ne casse rien', () => {
  const s = base();
  assert.deepEqual(L.todoTasks(s), []);
  assert.deepEqual(L.doneTasks(s), []);
  assert.equal(L.topTask(s), null);
  assert.deepEqual(L.activeTasksOf(s), []);
  for (const action of ['checkTask', 'uncheckTask', 'deleteTask', 'editTask', 'activateTask', 'deactivateTask']) {
    assert.doesNotThrow(() => L.applyLocal(s, { action, params: { id: 'x' }, clientTime: T1 }));
  }
  assert.doesNotThrow(() => L.applyLocal(s, { action: 'moveTask', params: { id: 'x', before: null }, clientTime: T1 }));
  const a = act(s, 'addTask', { id: 'a', description: 'A' });
  assert.equal(a.tasks.length, 1);
  assert.deepEqual(L.choiceOf(a), { project: 'Fluffy', type: 'Misc' });
});

test('select : change le choix ; compteur en marche bascule, en pause ou arrêté seul le choix change', () => {
  let s = act(withTasks(), 'start', { id: 'r1', project: 'Fluffy', type: 'Dev' }, T0);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Dev' });
  s = act(s, 'select', { project: 'Jam', type: 'Art' }, T1);
  assert.deepEqual(s.choice, { project: 'Jam', type: 'Art' });
  assert.equal(s.running.project, 'Jam');
  assert.equal(s.running.type, 'Art');
  assert.equal(s.running.start, new Date(T1).toISOString());
  assert.equal(s.last.id, 'r1');
  assert.equal(s.last.end, new Date(T1).toISOString());
  assert.notEqual(s.running.id, 'r1');
  // en pause : le choix seul
  let p = act(withTasks(), 'start', { id: 'p1', project: 'Fluffy', type: 'Pause' }, T0);
  assert.deepEqual(p.choice, { project: 'Fluffy', type: 'Misc' }, 'start en pause ne touche pas le choix');
  p = act(p, 'select', { project: 'Jam' }, T1);
  assert.deepEqual(p.choice, { project: 'Jam', type: 'Misc' });
  assert.equal(p.running.id, 'p1');
  // arrêté : le choix seul, aucune session
  const a = act(withTasks(), 'select', { type: 'Sound' });
  assert.deepEqual(a.choice, { project: 'Fluffy', type: 'Sound' });
  assert.equal(a.running, null);
  // Pause n'est pas une activité à choisir
  assert.deepEqual(act(withTasks(), 'select', { type: 'Pause' }).choice, { project: 'Fluffy', type: 'Misc' });
});

test('start met à jour le choix partagé', () => {
  const s = act(base(), 'start', { id: 'a', project: 'Jam', type: 'Sound' }, T0);
  assert.deepEqual(s.choice, { project: 'Jam', type: 'Sound' });
});

test('addTask : ni choix ni compteur touchés', () => {
  const s = act(withTasks(), 'addTask', { id: 'a', description: '  Appel avec Léa ', project: 'Studio', type: 'Social' });
  assert.deepEqual(s.tasks, [{ id: 'a', description: 'Appel avec Léa', project: 'Studio', type: 'Social', position: 1, done: null, started: null, spentMs: 0 }]);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Misc' });
  assert.equal(s.running, null);
  assert.deepEqual(L.activeTasksOf(s), []);
});

test('addTask : défaut = le choix ; Pause, doublon et description vide refusés', () => {
  let s = act(withTasks(), 'select', { project: 'Studio', type: 'Art' });
  s = act(s, 'addTask', { id: 'a', description: 'A' });
  assert.equal(s.tasks[0].project, 'Studio');
  assert.equal(s.tasks[0].type, 'Art');
  s = act(s, 'addTask', { id: 'b', description: 'B', project: 'Fluffy', type: 'Dev' });
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Art' });
  assert.deepEqual(s.tasks.map((t) => t.position), [1, 2]);
  assert.equal(act(s, 'addTask', { id: 'c', description: 'C', type: 'Pause' }).tasks.length, 2);
  assert.equal(act(s, 'addTask', { id: 'a', description: 'doublon' }).tasks.length, 2);
  assert.equal(act(s, 'addTask', { id: 'd', description: '   ' }).tasks.length, 2);
});

// Deux tâches, A (Studio · Social) et B (Fluffy · Art), et un compteur sur Fluffy · Dev depuis T0.
function twoTasksRunning() {
  let s = act(withTasks(), 'addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }, T0);
  s = act(s, 'addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }, T0);
  return act(s, 'start', { id: 'r0', project: 'Fluffy', type: 'Dev' }, T0);
}

test('valider, déplacer, supprimer, dévalider une tâche non active : ni choix ni compteur touchés', () => {
  let s = twoTasksRunning();
  s = act(s, 'addTask', { id: 'C', description: 'C', project: 'Studio', type: 'Dev' }, T0);
  s = act(s, 'checkTask', { id: 'A' }, T1);
  s = act(s, 'moveTask', { id: 'C', before: 'B' }, T1);
  s = act(s, 'deleteTask', { id: 'B' }, T1);
  s = act(s, 'uncheckTask', { id: 'A' }, T2);
  s = act(s, 'editTask', { id: 'C', type: 'Writing' }, T2);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Dev' });
  assert.equal(s.running.id, 'r0');
  assert.deepEqual(todoIds(s), ['A', 'C']);
});

const activeIds = (s) => L.activeTasksOf(s).map((t) => t.id);

test('activateTask arrêté : le choix devient la tâche, rien ne se lance ; ▶ part avec elle', () => {
  let s = act(withTasks(), 'addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }, T0);
  s = act(s, 'activateTask', { id: 'A' }, T1);
  assert.deepEqual(activeIds(s), ['A']);
  assert.deepEqual(s.choice, { project: 'Studio', type: 'Social' });
  assert.equal(s.running, null);
  s = act(s, 'start', { id: 'r', project: 'Studio', type: 'Social' }, T1);
  assert.deepEqual(s.running.tasks, ['A']);
  assert.equal(act(s, 'activateTask', { id: 'A' }, T2), s, 'déjà active : sans effet');
});

test('deux tâches actives une heure : chacune reçoit l’heure entière ; la dernière activée donne le choix', () => {
  let s = act(twoTasksRunning(), 'activateTask', { id: 'A' }, T0);
  s = act(s, 'activateTask', { id: 'B' }, T0);
  assert.deepEqual(activeIds(s), ['A', 'B']);
  assert.deepEqual(s.running.tasks, ['A', 'B']);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  s = act(s, 'stop', {}, T2);
  assert.equal(s.tasks.find((t) => t.id === 'A').spentMs, 60 * 60000);
  assert.equal(s.tasks.find((t) => t.id === 'B').spentMs, 60 * 60000);
});

test('activer une tâche de plus en marche : nouveau morceau avec la liste, même seconde', () => {
  let s = act(twoTasksRunning(), 'activateTask', { id: 'B' }, T0);
  s = act(s, 'activateTask', { id: 'A' }, T1);
  assert.equal(s.last.end, new Date(T1).toISOString());
  assert.deepEqual(s.last.tasks, ['B']);
  assert.deepEqual([s.running.project, s.running.type, s.running.start], ['Studio', 'Social', new Date(T1).toISOString()]);
  assert.deepEqual(s.running.tasks, ['B', 'A']);
});

test('changer de projet ou d’activité, ou un start ailleurs, ne désactive rien', () => {
  let s = act(twoTasksRunning(), 'activateTask', { id: 'A' }, T0);
  s = act(s, 'activateTask', { id: 'B' }, T0);
  const other = act(s, 'select', { project: 'Jam', type: 'Dev' }, T1);
  assert.deepEqual(activeIds(other), ['A', 'B']);
  assert.deepEqual([other.running.project, other.running.type], ['Jam', 'Dev']);
  assert.deepEqual(other.running.tasks, ['A', 'B']);
  const widget = act(act(s, 'stop', {}, T1), 'start', { id: 'w', project: 'Studio', type: 'Writing' }, T1);
  assert.deepEqual(activeIds(widget), ['A', 'B']);
  assert.deepEqual(widget.running.tasks, ['A', 'B']);
});

test('pause : aucune tâche ; REPRENDRE repart avec toutes ; STOP les garde', () => {
  let s = act(twoTasksRunning(), 'activateTask', { id: 'A' }, T0);
  s = act(s, 'start', { id: 'p', project: 'Studio', type: 'Pause' }, T1);
  assert.deepEqual(activeIds(s), ['A']);
  assert.deepEqual(s.running.tasks, []);
  s = act(s, 'start', { id: 'r', project: 'Studio', type: 'Social' }, T1);
  assert.deepEqual(s.running.tasks, ['A']);
  s = act(s, 'stop', {}, T2);
  assert.deepEqual(activeIds(s), ['A']);
});

test('10 tâches en cours au plus', () => {
  let s = withTasks();
  for (let i = 0; i < 11; i += 1) s = act(s, 'addTask', { id: 't' + i, description: 't' + i }, T0);
  for (let i = 0; i < 10; i += 1) s = act(s, 'activateTask', { id: 't' + i }, T0);
  assert.equal(activeIds(s).length, 10);
  assert.equal(act(s, 'activateTask', { id: 't10' }, T1), s);
});

test('valider une tâche en cours : elle sort de la liste, le compteur continue avec les autres ; temps crédité', () => {
  let s = act(twoTasksRunning(), 'activateTask', { id: 'A' }, T0);
  s = act(s, 'activateTask', { id: 'B' }, T0);
  s = act(s, 'checkTask', { id: 'A' }, T2);
  assert.deepEqual(activeIds(s), ['B']);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  assert.deepEqual([s.running.project, s.running.type, s.running.start], ['Fluffy', 'Art', new Date(T2).toISOString()]);
  assert.deepEqual(s.running.tasks, ['B']);
  const a = s.tasks.find((t) => t.id === 'A');
  assert.equal(a.done, new Date(T2).toISOString());
  assert.equal(a.started, new Date(T0).toISOString());
  assert.equal(a.spentMs, 60 * 60000);
});

test('deactivateTask { id } : celle-là ; sans id : toutes ; le choix reste ; rien à retirer : sans effet', () => {
  let s = act(twoTasksRunning(), 'activateTask', { id: 'A' }, T0);
  s = act(s, 'activateTask', { id: 'B' }, T0);
  s = act(s, 'deactivateTask', { id: 'A' }, T1);
  assert.deepEqual(activeIds(s), ['B']);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Art' });
  assert.deepEqual([s.running.tasks, s.running.start], [['B'], new Date(T1).toISOString()]);
  assert.equal(act(s, 'deactivateTask', { id: 'A' }, T2), s);
  s = act(s, 'deactivateTask', {}, T2);
  assert.deepEqual(activeIds(s), []);
  assert.deepEqual(s.running.tasks, []);
  assert.equal(act(s, 'deactivateTask', {}, T2), s);
});

test('editTask d’une tâche en cours : ni le choix ni le compteur ne bougent', () => {
  let s = act(withTasks(), 'addTask', { id: 'A', description: 'A', project: 'Fluffy', type: 'Dev' }, T0);
  s = act(s, 'activateTask', { id: 'A' }, T0);
  s = act(s, 'start', { id: 'r', project: 'Fluffy', type: 'Dev' }, T0);
  s = act(s, 'editTask', { id: 'A', project: 'Jam', type: 'Art' }, T1);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Dev' });
  assert.equal(s.running.id, 'r');
  assert.equal(act(s, 'editTask', { id: 'A', type: 'Pause' }).tasks[0].type, 'Art');
});

test('editTask sans changement ou description seule : le choix ne bouge pas', () => {
  let s = act(withTasks(), 'addTask', { id: 'A', description: 'A', project: 'Fluffy', type: 'Dev' }, T0);
  s = act(s, 'select', { project: 'Jam' }, T0);
  const same = act(s, 'editTask', { id: 'A', description: ' A ', project: 'Fluffy' });
  assert.equal(same, s);
  const renamed = act(s, 'editTask', { id: 'A', description: 'Autre' });
  assert.equal(renamed.tasks[0].description, 'Autre');
  assert.deepEqual(renamed.choice, { project: 'Jam', type: 'Misc' });
  assert.equal(act(s, 'editTask', { id: 'zzz', description: 'x' }).tasks.length, 1);
});

test('deleteTask d’une tâche en cours : elle sort de la liste, le compteur continue avec les autres', () => {
  let s = act(twoTasksRunning(), 'activateTask', { id: 'A' }, T0);
  s = act(s, 'activateTask', { id: 'B' }, T0);
  s = act(s, 'deleteTask', { id: 'B' }, T1);
  assert.deepEqual(activeIds(s), ['A']);
  assert.deepEqual(s.running.tasks, ['A']);
  assert.deepEqual(todoIds(s), ['A']);
});

test('moveTask : positions renumérotées ; sans changement rien', () => {
  let s = act(withTasks(), 'addTask', { id: 'A', description: 'A' }, T0);
  s = act(s, 'addTask', { id: 'B', description: 'B' }, T0);
  s = act(s, 'addTask', { id: 'C', description: 'C' }, T0);
  assert.equal(act(s, 'moveTask', { id: 'A', before: 'B' }), s);
  s = act(s, 'moveTask', { id: 'B', before: 'A' });
  assert.deepEqual(todoIds(s), ['B', 'A', 'C']);
  assert.deepEqual(s.tasks.map((t) => t.position).sort(), [1, 2, 3]);
  s = act(s, 'moveTask', { id: 'B', before: null });
  assert.deepEqual(todoIds(s), ['A', 'C', 'B']);
  assert.deepEqual(todoIds(act(s, 'moveTask', { id: 'A', before: 'A' })), ['A', 'C', 'B']);
  assert.deepEqual(todoIds(act(s, 'moveTask', { id: 'A', before: 'nope' })), ['A', 'C', 'B']);
});

test('uncheckTask : positions uniques, la tâche reprend sa place, non active, choix intact', () => {
  let s = act(withTasks(), 'addTask', { id: 'A', description: 'A', project: 'Studio', type: 'Social' }, T0);
  s = act(s, 'addTask', { id: 'B', description: 'B', project: 'Fluffy', type: 'Art' }, T0);
  s = act(s, 'addTask', { id: 'C', description: 'C', project: 'Fluffy', type: 'Dev' }, T0);
  s = act(s, 'activateTask', { id: 'A' }, T0);
  s = act(s, 'checkTask', { id: 'A' }, T0);
  s = act(s, 'select', { project: 'Fluffy', type: 'Misc' }, T0);
  s = act(s, 'moveTask', { id: 'C', before: 'B' }, T0);
  s = act(s, 'uncheckTask', { id: 'A' }, T2);
  assert.deepEqual(todoIds(s), ['A', 'C', 'B']);
  assert.deepEqual(L.todoTasks(s).map((t) => t.position), [1, 2, 3]);
  assert.deepEqual(s.choice, { project: 'Fluffy', type: 'Misc' });
  assert.deepEqual(activeIds(s), []);
  assert.equal(s.tasks.find((t) => t.id === 'A').done, null);
  assert.equal(act(s, 'uncheckTask', { id: 'A' }, T2), s);
});

test('compteur oublié (plus de 24 h) : l’activation change le choix, pas de bascule', () => {
  let s = act(withTasks(), 'start', { id: 'r', project: 'Fluffy', type: 'Dev' }, '2026-09-29T09:00:00+02:00');
  s = act(s, 'addTask', { id: 'A', description: 'A', project: 'Jam', type: 'Art' }, T1);
  s = act(s, 'activateTask', { id: 'A' }, T1);
  assert.deepEqual(s.choice, { project: 'Jam', type: 'Art' });
  assert.equal(s.running.id, 'r');
});

test('temps d’une tâche : terminé (serveur) plus le morceau en cours qui la contient ; un stop local ne le fait pas reculer', () => {
  let s = Object.assign(withTasks(), {
    activeTasks: ['A'],
    tasks: [{ id: 'A', description: 'A', project: 'Fluffy', type: 'Dev', position: 1, done: null, started: null, spentMs: 10 * 60000 }],
  });
  s = act(s, 'start', { id: 'r', project: 'Studio', type: 'Social' }, T0);
  const a = () => s.tasks[0];
  assert.equal(L.taskSpentMs(s, a(), Date.parse(T1)), 40 * 60000, 'compte quel que soit le projet du compteur');
  s = act(s, 'stop', {}, T1);
  assert.equal(L.taskSpentMs(s, a(), Date.parse(T2)), 40 * 60000);
  assert.equal(L.taskSpentMs(s, null, Date.parse(T2)), 0);
});

test('état d’avant les tâches en parallèle (activeTask, running.task) : lu comme une liste d’une tâche', () => {
  const s = Object.assign(withTasks(), {
    activeTask: 'A',
    running: { id: 'r', project: 'Fluffy', type: 'Dev', start: T0, end: null, task: 'A' },
    tasks: [{ id: 'A', description: 'A', project: 'Fluffy', type: 'Dev', position: 1, done: null, started: null, spentMs: 0 }],
  });
  assert.deepEqual(activeIds(s), ['A']);
  assert.equal(L.taskSpentMs(s, s.tasks[0], Date.parse(T1)), 30 * 60000);
});

test('une liste qui vise une tâche validée l’ignore', () => {
  const s = Object.assign(withTasks(), {
    activeTasks: ['A', 'B'],
    tasks: [
      { id: 'A', description: 'A', project: 'Fluffy', type: 'Dev', position: 1, done: T0, started: null, spentMs: 0 },
      { id: 'B', description: 'B', project: 'Fluffy', type: 'Dev', position: 2, done: null, started: null, spentMs: 0 },
    ],
  });
  assert.deepEqual(activeIds(s), ['B']);
  assert.deepEqual(act(s, 'start', { id: 'r', project: 'Fluffy', type: 'Dev' }, T1).running.tasks, ['B']);
});

test('les actions de tâche ne modifient pas l’état d’origine', () => {
  const s0 = act(twoTasksRunning(), 'activateTask', { id: 'A' }, T0);
  const snap = JSON.stringify(s0);
  act(s0, 'checkTask', { id: 'A' }, T1);
  act(s0, 'deactivateTask', {}, T1);
  act(s0, 'stop', {}, T1);
  assert.equal(JSON.stringify(s0), snap);
});

test('une activité null ou vide veut dire absente (repli), comme sur le serveur', () => {
  let s = act(withTasks(), 'addTask', { id: 'A', description: 'A', project: 'Jam', type: 'Dev' });
  s = act(s, 'editTask', { id: 'A', description: 'A bis', type: null });
  assert.equal(s.tasks[0].type, 'Dev');
  s = act(s, 'editTask', { id: 'A', description: 'A ter', type: '' });
  assert.equal(s.tasks[0].type, 'Dev');
  const c = Object.assign(withTasks(), { choice: { project: 'Jam', type: 'Sound' } });
  assert.equal(act(c, 'addTask', { id: 'B', description: 'B', type: '' }).tasks[0].type, 'Sound');
  assert.equal(act(c, 'select', { project: 'Fluffy', type: '' }).choice.type, 'Sound');
});

test('doneTasks avec nowMs : seulement les tâches faites depuis le dernier 6 h', () => {
  const s = Object.assign(withTasks(), { tasks: [
    { id: 'Y', description: 'Y', project: 'Fluffy', type: 'Misc', position: 1, done: '2026-10-07T20:00:00+02:00', started: null },
    { id: 'T', description: 'T', project: 'Fluffy', type: 'Misc', position: 2, done: '2026-10-08T07:00:00+02:00', started: null },
  ] });
  const now = Date.parse('2026-10-08T09:00:00+02:00');
  assert.deepEqual(L.doneTasks(s, now).map((t) => t.id), ['T']);
  assert.deepEqual(L.doneTasks(s).map((t) => t.id), ['Y', 'T']);
  // à 5 h du matin, le jour de travail est encore celui de la veille
  assert.deepEqual(L.doneTasks(s, Date.parse('2026-10-08T05:00:00+02:00')).map((t) => t.id), ['Y', 'T']);
});

test('liste limitée à 30 tâches à faire : addTask et uncheckTask sans effet au-delà', () => {
  let s = act(withTasks(), 'addTask', { id: 'first', description: 'première' }, T0);
  s = act(s, 'checkTask', { id: 'first' }, T0);
  for (let i = 0; i < 30; i += 1) s = act(s, 'addTask', { id: 't' + i, description: 't' + i }, T0);
  assert.equal(L.todoTasks(s).length, 30);
  assert.equal(L.todoTasks(act(s, 'addTask', { id: 'extra', description: 'de trop' })).length, 30);
  assert.equal(L.todoTasks(act(s, 'uncheckTask', { id: 'first' })).length, 30);
  assert.ok(L.doneTasks(act(s, 'uncheckTask', { id: 'first' })).length === 1);
  s = act(s, 'checkTask', { id: 't0' }, T1);
  assert.equal(L.todoTasks(act(s, 'addTask', { id: 'extra', description: 'de trop' })).length, 30);
});
