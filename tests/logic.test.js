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

test('correction d\'heure : la fin passe minuit si besoin', () => {
  const last = { start: '2026-09-30T23:00:00+02:00', end: '2026-09-30T23:30:00+02:00' };
  assert.equal(L.editedInstant(last, 'end', '01:00'), new Date('2026-10-01T01:00:00+02:00').toISOString());
  assert.equal(L.editedInstant(last, 'end', '23:45'), new Date('2026-09-30T23:45:00+02:00').toISOString());
});

test('correction d\'heure : le début passe la veille si besoin', () => {
  const last = { start: '2026-10-01T00:30:00+02:00', end: '2026-10-01T01:30:00+02:00' };
  assert.equal(L.editedInstant(last, 'start', '23:30'), new Date('2026-09-30T23:30:00+02:00').toISOString());
  assert.equal(L.editedInstant(last, 'start', '00:15'), new Date('2026-10-01T00:15:00+02:00').toISOString());
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

test('optimiste : stop, oubli, bloc, correction, nouveau projet', () => {
  let s = L.applyLocal(base(), { action: 'start', params: { id: 'a1', project: 'Fluffy' }, clientTime: '2026-10-01T09:00:00+02:00' });
  s = L.applyLocal(s, { action: 'stop', params: { endAt: '2026-10-01T17:00:00+02:00' }, clientTime: '2026-10-02T08:00:00+02:00' });
  assert.equal(s.running, null);
  assert.equal(s.last.hours, 8);
  assert.equal(s.last.corrected, true);
  s = L.applyLocal(s, { action: 'logBlock', params: { id: 'b1', project: 'Studio', hours: 4 }, clientTime: '2026-10-02T08:00:00+02:00' });
  assert.equal(s.last.date, '2026-10-02');
  s = L.applyLocal(s, { action: 'editLast', params: { id: 'b1', field: 'hours', value: 6 }, clientTime: '2026-10-02T08:01:00+02:00' });
  assert.equal(s.last.hours, 6);
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
  assert.deepEqual(L.typesOf(old).map((t) => t.name), ['Misc', 'Writing', 'Sound', 'Market', 'Concept', 'Art', 'TechArt', 'UI', 'Dev', 'Gameplay', 'Tooling', 'Debug']);
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

test('familles de tâches : Misc seul en premier, puis Contenu, Art, Code', () => {
  const fam = L.typesOf(base()).map((t) => t.family);
  assert.deepEqual(fam, ['general', 'contenu', 'contenu', 'contenu', 'art', 'art', 'art', 'art', 'code', 'code', 'code', 'code']);
});
