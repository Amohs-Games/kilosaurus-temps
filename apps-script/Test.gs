/**
 * Test de bout en bout sur la vraie Sheet. À lancer depuis l'éditeur Apps Script : runSelfTest.
 *
 * Crée deux onglets de projet temporaires et une personne de test, joue un parcours complet avec
 * une horloge simulée, vérifie le résultat, puis efface tout ce qu'il a créé et contrôle que le
 * reste de la Sheet est identique à avant. Les autres écritures attendent la fin (verrou).
 */
var TEST_PERSON = '__test__';

function runSelfTest() {
  var ss = SpreadsheetApp.getActive();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Sheet occupée, réessaie dans un instant.');

  var before = snapshot(ss);
  var corrSheet = ss.getSheetByName(CORRECTIONS_SHEET);
  var corrStart = new SheetStore(ss).firstFreeRow(corrSheet, 1);
  var suffix = String(Date.now()).slice(-6);
  var projA = 'ZZ Test A ' + suffix;
  var projB = 'ZZ Test B ' + suffix;
  var failures;

  try {
    var store = new SheetStore(ss);
    var base = store.config();
    store.config = function () {
      return { persons: base.persons.concat([TEST_PERSON]), threshold: base.threshold, studio: base.studio, visible: base.visible };
    };
    store.createProject(projA);
    store.createProject(projB);

    var t = Date.now() - 12 * 3600000;
    var env = {
      store: store,
      now: function () { return new Date(t); },
      tz: tzParis,
      auth: function (code) { return { person: TEST_PERSON, agent: code === 'agent' }; },
    };
    failures = selfTestScenario({
      projA: projA,
      projB: projB,
      call: function (kind, action, params) {
        return Core.handleRequest(env, Object.assign({ code: kind, action: action }, params || {}));
      },
      advance: function (minutes) { t += minutes * 60000; },
      rowCount: function (project) {
        return store.allRows().filter(function (r) { return r.project === project; }).length;
      },
      corrections: function () {
        var last = corrSheet.getLastRow();
        if (last < corrStart) return [];
        return corrSheet.getRange(corrStart, 1, last - corrStart + 1, 8).getValues()
          .filter(function (v) { return v[1] === TEST_PERSON; })
          .map(function (v) { return { field: v[5], oldValue: v[6], newValue: v[7] }; });
      },
    });
  } finally {
    [projA, projB].forEach(function (name) {
      var s = ss.getSheetByName(name);
      if (s) ss.deleteSheet(s);
    });
    var last = corrSheet.getLastRow();
    if (last >= corrStart) corrSheet.getRange(corrStart, 1, last - corrStart + 1, 8).clearContent();
    SpreadsheetApp.flush();
    lock.releaseLock();
  }

  var after = snapshot(ss);
  Object.keys(before).forEach(function (name) {
    if (before[name] !== after[name]) failures.push('L\'onglet « ' + name + ' » a changé pendant le test.');
  });
  if (Object.keys(after).length !== Object.keys(before).length) failures.push('Des onglets ont été ajoutés ou supprimés.');

  if (failures.length) throw new Error('ÉCHEC du test :\n- ' + failures.join('\n- '));
  Logger.log('OK : parcours complet validé, Sheet intacte.');
}

function snapshot(ss) {
  var out = {};
  ss.getSheets().forEach(function (s) { out[s.getName()] = JSON.stringify(s.getDataRange().getValues()); });
  return out;
}

/**
 * Parcours de test, indépendant de Google : `t` fournit call, advance, rowCount, corrections,
 * projA, projB. Renvoie la liste des échecs (vide si tout va bien). Utilisé par runSelfTest
 * sur la vraie Sheet et par les tests Node sur un store en mémoire.
 */
function selfTestScenario(t) {
  var failures = [];
  function check(cond, label) { if (!cond) failures.push(label); }
  function ok(res, label) {
    if (!res.ok) { failures.push(label + ' → ' + res.error.code + ' : ' + res.error.message); return null; }
    return res.data;
  }
  function refused(res, label) { check(!res.ok && res.error.code === 'invalid', label + ' aurait dû être refusé'); }

  var s = ok(t.call('human', 'start', { id: 'st-1', project: t.projA }), 'Lancement');
  check(s && s.running && s.running.project === t.projA, 'Le compteur tourne sur A');

  t.advance(60);
  s = ok(t.call('human', 'start', { id: 'st-2', project: t.projB, offsetMinutes: 15 }), 'Bascule');
  check(s && s.last && s.last.id === 'st-1' && s.last.hours === 0.75, 'A fermé à 0,75 h par la bascule décalée');
  check(s && s.running && s.running.project === t.projB, 'Le compteur tourne sur B');

  t.advance(45);
  s = ok(t.call('human', 'stop'), 'Arrêt');
  check(s && !s.running && s.last.id === 'st-2' && s.last.hours === 1, 'B fermé à 1 h');

  var newEnd = new Date(new Date(s.last.start).getTime() + 45 * 60000).toISOString();
  s = ok(t.call('human', 'editLast', { id: 'st-2', field: 'end', value: newEnd }), 'Correction de fin');
  check(s && s.last.hours === 0.75 && s.last.corrected, 'B corrigé à 0,75 h');

  s = ok(t.call('human', 'logBlock', { id: 'st-3', project: t.projA, hours: 4 }), 'Bloc');
  ok(t.call('human', 'logBlock', { id: 'st-3', project: t.projA, hours: 4 }), 'Bloc rejoué');
  s = ok(t.call('human', 'editLast', { id: 'st-3', field: 'hours', value: 6 }), 'Correction de bloc');
  check(s && s.last.hours === 6, 'Bloc corrigé à 6 h');
  refused(t.call('human', 'logBlock', { id: 'st-x', project: t.projA, hours: 5 }), 'Bloc de 5 h');

  t.advance(1);
  s = ok(t.call('human', 'start', { id: 'st-4', project: t.projA }), 'Lancement oublié');
  var forgotStart = s ? new Date(s.running.start).getTime() : 0;
  t.advance(600);
  s = ok(t.call('human', 'stop', { endAt: new Date(forgotStart + 8 * 3600000).toISOString() }), 'Fin d\'oubli');
  check(s && s.last.id === 'st-4' && s.last.hours === 8 && s.last.corrected, 'Oubli fermé à 8 h');

  refused(t.call('human', 'logSession', { id: 'st-y', project: t.projB,
    start: new Date(forgotStart - 3 * 3600000).toISOString(), end: new Date(forgotStart - 2 * 3600000).toISOString() }), 'Session libre par un humain');
  ok(t.call('agent', 'logSession', { id: 'st-5', project: t.projB,
    start: new Date(forgotStart - 6 * 3600000).toISOString(), end: new Date(forgotStart - 5 * 3600000).toISOString() }), 'Session d\'agent');
  refused(t.call('agent', 'logSession', { id: 'st-z', project: t.projB,
    start: new Date(forgotStart + 3600000).toISOString(), end: new Date(forgotStart + 2 * 3600000).toISOString() }), 'Session d\'agent qui chevauche');

  s = ok(t.call('human', 'start', { id: 'st-6', project: t.projB }), 'Nouveau lancement');
  var runningStart = s ? new Date(s.running.start).getTime() : 0;
  t.advance(30);
  s = ok(t.call('human', 'stop', { offline: true, clientTime: new Date(runningStart - 60000).toISOString() }), 'Stop hors ligne périmé');
  check(s && s.running && s.running.id === 'st-6', 'Un stop périmé ne ferme pas le compteur récent');
  ok(t.call('human', 'stop'), 'Arrêt final');

  check(t.rowCount(t.projA) === 3, 'A contient 3 lignes (' + t.rowCount(t.projA) + ')');
  check(t.rowCount(t.projB) === 3, 'B contient 3 lignes (' + t.rowCount(t.projB) + ')');
  var fields = t.corrections().map(function (c) { return c.field; }).join(', ');
  check(fields === 'Fin, Heures, Fin (oubli)', 'Corrections attendues : Fin, Heures, Fin (oubli) — trouvées : ' + fields);

  return failures;
}
