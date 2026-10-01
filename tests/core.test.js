const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, makeClock, MemoryStore } = require('./harness');

const H = 3600000;

function ok(res) {
  assert.equal(res.ok, true, res.error && `${res.error.code}: ${res.error.message}`);
  return res.data;
}
function fails(res, code) {
  assert.equal(res.ok, false, 'devait échouer');
  assert.equal(res.error.code, code);
}
function rows(store, project) { return store.data[project]; }

test('auth : code inconnu ou absent → unauthorized', () => {
  const { call } = makeEnv();
  fails(call('nope', 'status'), 'unauthorized');
  fails(call(undefined, 'status'), 'unauthorized');
});

test('auth : code dont la personne n\'est pas dans _Config → unauthorized', () => {
  const { call } = makeEnv({ store: new MemoryStore({ persons: ['Amohs'] }) });
  fails(call('code-alex-claude', 'status'), 'unauthorized');
});

test('action inconnue → invalid', () => {
  const { call } = makeEnv();
  fails(call('code-amohs', 'explode'), 'invalid');
});

test('status initial', () => {
  const { call } = makeEnv();
  const s = ok(call('code-amohs', 'status'));
  assert.equal(s.me, 'Amohs');
  assert.equal(s.agent, false);
  assert.deepEqual(s.projects, ['Fluffy', 'Studio']);
  assert.equal(s.studio, 'Studio');
  assert.equal(s.visible, 4);
  assert.equal(s.threshold, 8);
  assert.equal(s.running, null);
  assert.equal(s.last, null);
});

test('start ouvre un compteur', () => {
  const { call, store, clock } = makeEnv();
  const s = ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy', note: 'menus' }));
  assert.equal(s.running.id, 'a1');
  assert.equal(s.running.project, 'Fluffy');
  assert.equal(s.running.start, clock.now().toISOString());
  assert.equal(s.running.note, 'menus');
  const r = rows(store, 'Fluffy')[0];
  assert.equal(r.person, 'Amohs');
  assert.equal(r.source, 'app');
  assert.equal(r.end, '');
  assert.equal(r.hours, '');
  assert.equal(r.created.getTime(), clock.now().getTime());
});

test('start : projet inconnu ou décalage hors liste → invalid', () => {
  const { call } = makeEnv();
  fails(call('code-amohs', 'start', { id: 'a1', project: 'Nope' }), 'invalid');
  fails(call('code-amohs', 'start', { id: 'a1', project: '_Config' }), 'invalid');
  fails(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy', offsetMinutes: 20 }), 'invalid');
  fails(call('code-amohs', 'start', { project: 'Fluffy' }), 'invalid');
});

test('bascule : l\'ancien compteur se ferme à l\'heure du nouveau début', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(90);
  const s = ok(call('code-amohs', 'start', { id: 'a2', project: 'Studio' }));
  const a1 = rows(store, 'Fluffy')[0];
  assert.equal(a1.end.getTime(), clock.now().getTime());
  assert.equal(a1.hours, 1.5);
  assert.equal(s.running.id, 'a2');
  assert.equal(s.last.id, 'a1');
});

test('bascule avec décalage : pas de chevauchement', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(90);
  ok(call('code-amohs', 'start', { id: 'a2', project: 'Studio', offsetMinutes: 30 }));
  const a1 = rows(store, 'Fluffy')[0];
  const a2 = rows(store, 'Studio')[0];
  assert.equal(a1.hours, 1);
  assert.equal(a2.start.getTime(), a1.end.getTime());
});

test('décalage qui remonte avant le compteur en cours : ramené à son début', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  const t0 = clock.now().getTime();
  clock.advance(10);
  ok(call('code-amohs', 'start', { id: 'a2', project: 'Studio', offsetMinutes: 60 }));
  assert.equal(rows(store, 'Studio')[0].start.getTime(), t0);
  assert.equal(rows(store, 'Fluffy')[0].hours, 0);
});

test('start rejoué avec le même id : une seule ligne', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(5);
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(rows(store, 'Fluffy').length, 1);
  assert.equal(rows(store, 'Fluffy')[0].end, '');
});

test('les compteurs sont par personne', () => {
  const { call } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(call('code-alex', 'start', { id: 'l1', project: 'Fluffy' }));
  assert.equal(s.running.id, 'l1');
  assert.equal(ok(call('code-amohs', 'status')).running.id, 'a1');
});

test('stop ferme le compteur ; stop sans compteur ne fait rien', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(45);
  const s = ok(call('code-amohs', 'stop'));
  assert.equal(s.running, null);
  assert.equal(s.last.id, 'a1');
  assert.equal(s.last.hours, 0.75);
  clock.advance(5);
  ok(call('code-amohs', 'stop'));
  assert.equal(rows(store, 'Fluffy')[0].end.getTime(), clock.now().getTime() - 5 * 60000);
});

test('stop avec heure de fin (oubli) : tracé dans _Corrections', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(12 * 60);
  const s = ok(call('code-amohs', 'stop', { endAt: '2026-10-01T18:00:00+02:00' }));
  assert.equal(s.last.hours, 9);
  assert.equal(s.last.corrected, true);
  const c = store.corrections[0];
  assert.equal(c.field, 'Fin (oubli)');
  assert.equal(c.oldValue, 'en cours');
  assert.equal(c.newValue, '01/10/2026 18:00');
  assert.equal(c.author, 'Amohs');
  assert.equal(c.project, 'Fluffy');
  assert.equal(c.id, 'a1');
});

test('stop avec heure de fin avant le début ou dans le futur → invalid', () => {
  const { call, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  fails(call('code-amohs', 'stop', { endAt: '2026-10-01T08:00:00+02:00' }), 'invalid');
  fails(call('code-amohs', 'stop', { endAt: '2026-10-01T23:00:00+02:00' }), 'invalid');
  fails(call('code-amohs', 'stop', { endAt: 'pas une date' }), 'invalid');
});

test('note : modifie le compteur en cours, sans correction', () => {
  const { call, store } = makeEnv();
  fails(call('code-amohs', 'note', { text: 'x' }), 'invalid');
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(call('code-amohs', 'note', { text: 'boss final' }));
  assert.equal(s.running.note, 'boss final');
  assert.equal(store.corrections.length, 0);
});

test('logBlock : bloc du jour, sans toucher au compteur', () => {
  const { call, store } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  const s = ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Studio', hours: 8 }));
  const b = rows(store, 'Studio')[0];
  assert.equal(b.start, '');
  assert.equal(b.end, '');
  assert.equal(b.hours, 8);
  assert.equal(s.running.id, 'a1');
  assert.equal(s.last.id, 'b1');
  assert.equal(s.last.date, '2026-10-01');
});

test('logBlock : heures hors liste, date future ou mal formée → invalid ; date passée ok', () => {
  const { call } = makeEnv();
  fails(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 5 }), 'invalid');
  fails(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 14 }), 'invalid');
  fails(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-10-02' }), 'invalid');
  fails(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '01/10/2026' }), 'invalid');
  const s = ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-09-14' }));
  assert.equal(s.last.date, '2026-09-14');
});

test('logBlock rejoué : une seule ligne', () => {
  const { call, store } = makeEnv();
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 2 }));
  assert.equal(rows(store, 'Fluffy').length, 1);
});

test('hors ligne : l\'heure du tap fait foi, jamais dans le futur', () => {
  const { call, store } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy', offline: true, clientTime: '2026-10-01T08:30:00+02:00' }));
  const r = rows(store, 'Fluffy')[0];
  assert.equal(r.start.toISOString(), new Date('2026-10-01T08:30:00+02:00').toISOString());
  assert.equal(r.source, 'hors ligne');
  ok(call('code-amohs', 'start', { id: 'a2', project: 'Studio', offline: true, clientTime: '2026-10-01T11:00:00+02:00' }));
  assert.equal(rows(store, 'Studio')[0].start.toISOString(), new Date('2026-10-01T09:00:00+02:00').toISOString());
});

test('hors ligne : clientTime ignoré sans le drapeau offline', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy', clientTime: '2026-10-01T08:30:00+02:00' }));
  assert.equal(rows(store, 'Fluffy')[0].start.getTime(), clock.now().getTime());
  assert.equal(rows(store, 'Fluffy')[0].source, 'app');
});

test('hors ligne : un stop plus ancien que le compteur en cours ne le ferme pas', () => {
  const { call, clock } = makeEnv({ clock: makeClock('2026-10-01T10:30:00+02:00') });
  ok(call('code-amohs', 'start', { id: 'pc', project: 'Fluffy' }));
  clock.advance(30);
  const s = ok(call('code-amohs', 'stop', { offline: true, clientTime: '2026-10-01T10:00:00+02:00' }));
  assert.equal(s.running.id, 'pc');
});

test('hors ligne : un bloc « aujourd\'hui » rejoué compte pour le jour du tap', () => {
  const { call } = makeEnv({ clock: makeClock('2026-10-02T00:30:00+02:00') });
  const s = ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 2, offline: true, clientTime: '2026-10-01T23:30:00+02:00' }));
  assert.equal(s.last.date, '2026-10-01');
});

test('Date d\'une session = jour de Paris du début', () => {
  const { call } = makeEnv({ clock: makeClock('2026-10-01T00:30:00+02:00') });
  const s = ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(s.running.date, '2026-10-01');
});

test('logSession : réservé aux codes d\'agent', () => {
  const { call } = makeEnv();
  fails(call('code-alex', 'logSession', { id: 's1', project: 'Fluffy', start: '2026-10-01T06:00:00+02:00', end: '2026-10-01T08:00:00+02:00' }), 'invalid');
});

test('logSession : session d\'agent au nom de la personne, source claude', () => {
  const { call, store } = makeEnv();
  const s = ok(call('code-alex-claude', 'logSession', { id: 's1', project: 'Fluffy', start: '2026-09-30T14:00:00+02:00', end: '2026-09-30T17:12:00+02:00', note: 'refacto save' }));
  const r = rows(store, 'Fluffy')[0];
  assert.equal(r.person, 'Alex');
  assert.equal(r.source, 'claude');
  assert.equal(r.hours, 3.2);
  assert.equal(s.me, 'Alex');
  assert.equal(s.agent, true);
  assert.equal(s.last.date, '2026-09-30');
});

test('logSession : chevauchement, fin future, plus de 24 h, début ≥ fin → invalid', () => {
  const { call } = makeEnv();
  ok(call('code-alex-claude', 'logSession', { id: 's1', project: 'Fluffy', start: '2026-09-30T14:00:00+02:00', end: '2026-09-30T17:00:00+02:00' }));
  fails(call('code-alex-claude', 'logSession', { id: 's2', project: 'Studio', start: '2026-09-30T16:00:00+02:00', end: '2026-09-30T18:00:00+02:00' }), 'invalid');
  fails(call('code-alex-claude', 'logSession', { id: 's3', project: 'Fluffy', start: '2026-10-01T08:00:00+02:00', end: '2026-10-01T10:00:00+02:00' }), 'invalid');
  fails(call('code-alex-claude', 'logSession', { id: 's4', project: 'Fluffy', start: '2026-09-28T08:00:00+02:00', end: '2026-09-29T09:00:00+02:00' }), 'invalid');
  fails(call('code-alex-claude', 'logSession', { id: 's5', project: 'Fluffy', start: '2026-09-29T10:00:00+02:00', end: '2026-09-29T10:00:00+02:00' }), 'invalid');
  ok(call('code-alex-claude', 'logSession', { id: 's6', project: 'Fluffy', start: '2026-09-30T17:00:00+02:00', end: '2026-09-30T18:00:00+02:00' }));
});

test('logSession : chevauche le compteur en cours de la personne → invalid', () => {
  const { call, clock } = makeEnv();
  ok(call('code-alex', 'start', { id: 'l1', project: 'Fluffy' }));
  clock.advance(120);
  fails(call('code-alex-claude', 'logSession', { id: 's1', project: 'Fluffy', start: '2026-10-01T09:30:00+02:00', end: '2026-10-01T10:00:00+02:00' }), 'invalid');
});

test('logSession : d\'autres personnes ne bloquent pas', () => {
  const { call } = makeEnv();
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 8 }));
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  ok(call('code-alex-claude', 'logSession', { id: 's1', project: 'Fluffy', start: '2026-10-01T07:00:00+02:00', end: '2026-10-01T09:00:00+02:00' }));
});

test('editLast : corrige la fin d\'une session, recalcule et trace', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(call('code-amohs', 'stop'));
  clock.advance(60);
  const s = ok(call('code-amohs', 'editLast', { id: 'a1', field: 'end', value: '2026-10-01T10:30:00+02:00' }));
  assert.equal(s.last.hours, 1.5);
  assert.equal(s.last.corrected, true);
  const c = store.corrections[0];
  assert.equal(c.field, 'Fin');
  assert.equal(c.oldValue, '01/10/2026 10:00');
  assert.equal(c.newValue, '01/10/2026 10:30');
});

test('editLast : corriger le début change aussi la date', () => {
  const { call, clock } = makeEnv({ clock: makeClock('2026-10-01T00:30:00+02:00') });
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(call('code-amohs', 'stop'));
  const s = ok(call('code-amohs', 'editLast', { id: 'a1', field: 'start', value: '2026-09-30T23:30:00+02:00' }));
  assert.equal(s.last.date, '2026-09-30');
  assert.equal(s.last.hours, 2);
});

test('editLast : session qui passe minuit', () => {
  const { call, clock } = makeEnv({ clock: makeClock('2026-09-30T23:00:00+02:00') });
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(30);
  ok(call('code-amohs', 'stop'));
  clock.set('2026-10-01T09:00:00+02:00');
  const s = ok(call('code-amohs', 'editLast', { id: 'a1', field: 'end', value: '2026-10-01T01:00:00+02:00' }));
  assert.equal(s.last.hours, 2);
  assert.equal(s.last.date, '2026-09-30');
});

test('editLast : seul le dernier log, valeurs cohérentes', () => {
  const { call, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(call('code-amohs', 'start', { id: 'a2', project: 'Studio' }));
  clock.advance(60);
  ok(call('code-amohs', 'stop'));
  fails(call('code-amohs', 'editLast', { id: 'a1', field: 'end', value: '2026-10-01T10:15:00+02:00' }), 'invalid');
  fails(call('code-amohs', 'editLast', { id: 'a2', field: 'end', value: '2026-10-01T09:30:00+02:00' }), 'invalid');
  fails(call('code-amohs', 'editLast', { id: 'a2', field: 'end', value: '2026-10-01T23:00:00+02:00' }), 'invalid');
  fails(call('code-amohs', 'editLast', { id: 'a2', field: 'hours', value: 4 }), 'invalid');
  fails(call('code-alex', 'editLast', { id: 'a2', field: 'end', value: '2026-10-01T10:30:00+02:00' }), 'invalid');
});

test('editLast : durée d\'un bloc', () => {
  const { call, store } = makeEnv();
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 8 }));
  fails(call('code-amohs', 'editLast', { id: 'b1', field: 'hours', value: 7 }), 'invalid');
  fails(call('code-amohs', 'editLast', { id: 'b1', field: 'start', value: '2026-10-01T08:00:00+02:00' }), 'invalid');
  const s = ok(call('code-amohs', 'editLast', { id: 'b1', field: 'hours', value: 6 }));
  assert.equal(s.last.hours, 6);
  assert.equal(store.corrections[0].field, 'Heures');
  assert.equal(store.corrections[0].oldValue, '8');
  assert.equal(store.corrections[0].newValue, '6');
});

test('dernier log : le plus récent saisi, reports et compteur en cours exclus', () => {
  const store = new MemoryStore();
  store.insert('Fluffy', { id: 'report-0001', person: 'Amohs', date: new Date('2026-09-30T00:00:00+02:00'), start: '', end: '', hours: 8, note: '', source: 'report', created: new Date('2026-10-01T08:59:00+02:00'), corrected: '' });
  const { call, clock } = makeEnv({ store });
  assert.equal(ok(call('code-amohs', 'status')).last, null);
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 8, date: '2026-09-20' }));
  clock.advance(1);
  ok(call('code-amohs', 'logBlock', { id: 'b2', project: 'Fluffy', hours: 4, date: '2026-09-10' }));
  clock.advance(1);
  const s = ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  assert.equal(s.last.id, 'b2');
});

test('dernier log : un compteur oublié qu\'on ferme passe devant un bloc saisi entre-temps', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Studio', hours: 2, date: '2026-09-30' }));
  clock.advance(600);
  const s = ok(call('code-amohs', 'stop', { endAt: '2026-10-01T17:00:00+02:00' }));
  assert.equal(s.last.id, 'a1');
  assert.equal(rows(store, 'Fluffy')[0].touched.getTime(), clock.now().getTime());
});

test('dernier log : une correction le garde en dernier', () => {
  const { call, clock } = makeEnv();
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Studio', hours: 2 }));
  clock.advance(1);
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Fluffy' }));
  clock.advance(60);
  ok(call('code-amohs', 'stop'));
  clock.advance(1);
  const s = ok(call('code-amohs', 'editLast', { id: 'a1', field: 'start', value: '2026-10-01T08:30:00+02:00' }));
  assert.equal(s.last.id, 'a1');
});

test('addProject : crée l\'onglet après le dernier projet', () => {
  const { call, store } = makeEnv();
  const s = ok(call('code-amohs', 'addProject', { name: '  Heirfall ' }));
  assert.deepEqual(s.projects, ['Fluffy', 'Studio', 'Heirfall']);
  assert.deepEqual(store.sheetNames(), ['Fluffy', 'Studio', 'Heirfall', '_Config', '_Corrections', '_Modèle']);
  ok(call('code-amohs', 'start', { id: 'a1', project: 'Heirfall' }));
});

test('addProject : noms refusés', () => {
  const { call } = makeEnv();
  for (const name of ['', '   ', 'fluffy', '_Secret', 'a/b', 'x'.repeat(31), '_modèle']) {
    fails(call('code-amohs', 'addProject', { name }), 'invalid');
  }
});

test('erreur interne → server, sans faire planter l\'appelant', () => {
  const store = new MemoryStore();
  store.allRows = () => { throw new Error('boom'); };
  const { call } = makeEnv({ store });
  fails(call('code-amohs', 'status'), 'server');
});

test('type : Misc par défaut, enregistré sur la ligne', () => {
  const { call, store } = makeEnv();
  const s = ok(call('code-amohs', 'start', { id: 't1', project: 'Fluffy' }));
  assert.equal(s.running.type, 'Misc');
  assert.equal(rows(store, 'Fluffy')[0].type, 'Misc');
});

test('type : bascule de type sur le même projet, sans trou', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 't1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(30);
  const s = ok(call('code-amohs', 'start', { id: 't2', project: 'Fluffy', type: 'Art' }));
  const [a, b] = rows(store, 'Fluffy');
  assert.equal(a.type, 'Dev');
  assert.equal(a.end.getTime(), b.start.getTime());
  assert.equal(a.hours, 0.5);
  assert.equal(s.running.type, 'Art');
  assert.equal(s.last.type, 'Dev');
});

test('type : même projet et même type → rien', () => {
  const { call, store, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 't1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(10);
  const s = ok(call('code-amohs', 'start', { id: 't2', project: 'Fluffy', type: 'Dev' }));
  assert.equal(s.running.id, 't1');
  assert.equal(rows(store, 'Fluffy').length, 1);
});

test('type : start sans type garde le type du compteur en cours', () => {
  const { call, clock } = makeEnv();
  ok(call('code-amohs', 'start', { id: 't1', project: 'Fluffy', type: 'Dev' }));
  clock.advance(10);
  const s = ok(call('code-amohs', 'start', { id: 't2', project: 'Studio' }));
  assert.equal(s.running.type, 'Dev');
  assert.equal(s.running.project, 'Studio');
});

test('type : inconnu → invalid ; blocs et sessions d\'agent typés', () => {
  const { call, store } = makeEnv();
  fails(call('code-amohs', 'start', { id: 't1', project: 'Fluffy', type: 'Musique' }), 'invalid');
  ok(call('code-amohs', 'logBlock', { id: 'b1', project: 'Fluffy', hours: 2, type: 'Writing' }));
  assert.equal(rows(store, 'Fluffy')[0].type, 'Writing');
  ok(call('code-alex-claude', 'logSession', {
    id: 's1', project: 'Fluffy', start: '2026-10-01T06:00:00+02:00', end: '2026-10-01T07:00:00+02:00',
  }));
  assert.equal(rows(store, 'Fluffy')[1].type, 'Misc');
});

test('type : une ligne sans type (historique) vaut Misc', () => {
  const { call, store } = makeEnv();
  store.insert('Fluffy', {
    id: 'old', person: 'Amohs', date: new Date('2026-09-30T00:00:00+02:00'), start: '', end: '', hours: 4,
    note: '', source: 'app', created: new Date('2026-09-30T10:00:00+02:00'), corrected: '', touched: new Date('2026-09-30T10:00:00+02:00'),
  });
  assert.equal(ok(call('code-amohs', 'status')).last.type, 'Misc');
});

test('status.types et status.today', () => {
  const { call, clock } = makeEnv({ clock: makeClock('2026-10-01T09:00:00+02:00') });
  ok(call('code-amohs', 'logBlock', { id: 'y', project: 'Fluffy', hours: 2, date: '2026-09-30' }));
  ok(call('code-amohs', 'start', { id: 'a', project: 'Fluffy', type: 'Dev' }));
  clock.advance(60);
  const s = ok(call('code-amohs', 'start', { id: 'b', project: 'Fluffy', type: 'Art' }));
  assert.deepEqual(Array.from(s.types, (t) => t.name), ['Misc', 'Art', 'Dev', 'Writing', 'UI', 'Gameplay', 'Sound', 'Market']);
  assert.deepEqual(s.today.map((r) => r.id), ['a', 'b']);
  assert.equal(s.today[1].end, null);
});

test('status.today : une session d\'hier encore en cours en fait partie', () => {
  const { call, clock } = makeEnv({ clock: makeClock('2026-09-30T22:00:00+02:00') });
  ok(call('code-amohs', 'start', { id: 'n', project: 'Fluffy' }));
  clock.set('2026-10-01T01:00:00+02:00');
  const s = ok(call('code-amohs', 'status'));
  assert.deepEqual(s.today.map((r) => r.id), ['n']);
});

test('history : lignes de la période, bornes incluses', () => {
  const { call } = makeEnv({ clock: makeClock('2026-10-01T09:00:00+02:00') });
  ok(call('code-amohs', 'logBlock', { id: 'd28', project: 'Fluffy', hours: 2, date: '2026-09-28' }));
  ok(call('code-amohs', 'logBlock', { id: 'd29', project: 'Fluffy', hours: 4, date: '2026-09-29', type: 'Dev' }));
  ok(call('code-amohs', 'logBlock', { id: 'd30', project: 'Studio', hours: 6, date: '2026-09-30' }));
  ok(call('code-alex', 'logBlock', { id: 'x', project: 'Fluffy', hours: 2, date: '2026-09-29' }));
  const h = ok(call('code-amohs', 'history', { from: '2026-09-29', to: '2026-09-30' }));
  assert.deepEqual(h.rows.map((r) => r.id), ['d29', 'd30']);
  assert.equal(h.rows[0].type, 'Dev');
  assert.equal(h.from, '2026-09-29');
});

test('history : dates invalides ou plus de 62 jours → invalid', () => {
  const { call } = makeEnv();
  fails(call('code-amohs', 'history', { from: '2026-10-01', to: '2026-09-01' }), 'invalid');
  fails(call('code-amohs', 'history', { from: '2026-01-01', to: '2026-03-15' }), 'invalid');
  fails(call('code-amohs', 'history', { from: 'hier', to: '2026-10-01' }), 'invalid');
  ok(call('code-amohs', 'history', { from: '2026-08-01', to: '2026-10-01' }));
});

test('type : anciens noms (Autre, Narration) lus et acceptés comme Misc, Writing', () => {
  const { call, store, clock } = makeEnv();
  const old = (id, type) => ({
    id, person: 'Amohs', date: new Date('2026-10-01T00:00:00+02:00'), start: new Date('2026-10-01T07:00:00+02:00'),
    end: new Date('2026-10-01T08:00:00+02:00'), hours: 1, note: '', type, source: 'app',
    created: new Date('2026-10-01T08:00:00+02:00'), corrected: '', touched: new Date('2026-10-01T08:00:00+02:00'),
  });
  store.insert('Fluffy', old('o1', 'Autre'));
  store.insert('Fluffy', old('o2', 'Narration'));
  const h = ok(call('code-amohs', 'history', { from: '2026-10-01', to: '2026-10-01' }));
  assert.deepEqual(h.rows.map((r) => r.type), ['Misc', 'Writing']);
  const s = ok(call('code-amohs', 'start', { id: 'n1', project: 'Fluffy', type: 'Narration' }));
  assert.equal(s.running.type, 'Writing');
  assert.equal(rows(store, 'Fluffy')[2].type, 'Writing');
  clock.advance(5);
  const s2 = ok(call('code-amohs', 'start', { id: 'n2', project: 'Fluffy', type: 'Writing' }));
  assert.equal(s2.running.id, 'n1', 'Narration puis Writing : même type, rien ne change');
});

test('tapTime : l\'heure du tap (widget) fait foi, source app, jamais dans le futur', () => {
  const { call, store } = makeEnv({ clock: makeClock('2026-10-01T09:00:00+02:00') });
  ok(call('code-amohs', 'start', { id: 'w1', project: 'Fluffy', tapTime: '2026-10-01T08:59:40+02:00' }));
  const r = rows(store, 'Fluffy')[0];
  assert.equal(r.start.toISOString(), new Date('2026-10-01T08:59:40+02:00').toISOString());
  assert.equal(r.source, 'app');
  ok(call('code-amohs', 'stop', { tapTime: '2026-10-01T09:30:00+02:00' }));
  assert.equal(rows(store, 'Fluffy')[0].end.toISOString(), new Date('2026-10-01T09:00:00+02:00').toISOString());
});
