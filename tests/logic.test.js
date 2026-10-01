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
