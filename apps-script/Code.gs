/**
 * Point d'entrée de la web app : reçoit un POST (corps JSON en text/plain), identifie la personne
 * par son code, verrouille les écritures, délègue à Core.gs.
 *
 * Codes (Script Properties) : CODE_<NOM> ou CODE_<NOM>_<APPAREIL> (un code par appareil, chacun
 * révocable seul). Un code dont le nom contient le segment CLAUDE est un code d'agent.
 * <NOM> = le nom de _Config en majuscules, sans accent ni espace (Amohs → AMOHS).
 * Un code de moins de MIN_CODE_LENGTH caractères est ignoré : l'URL est publique, le code est la
 * seule serrure.
 *
 * Blocage : après MAX_FAILED_CODES codes refusés, l'API refuse tout le monde pendant LOCKOUT_S.
 * Google ne donne pas l'adresse de l'appelant : le blocage est global, il bloque aussi les bons
 * codes. Un blocage ne met aucune donnée en danger ; il signale qu'on essaie de deviner un code.
 * Pour débloquer avant la fin : exécuter unlockApi() depuis l'éditeur.
 */
var TZ = 'Europe/Paris';
var LOCK_WAIT_MS = 15000;
var MIN_CODE_LENGTH = 32;
var MAX_FAILED_CODES = 10;       // codes refusés tolérés…
var FAILED_WINDOW_S = 15 * 60;   // …à moins de 15 min d'écart l'un de l'autre
var LOCKOUT_S = 60 * 60;

var tzParis = {
  dayKey: function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); },
  dayStart: function (key) { return Utilities.parseDate(key, TZ, 'yyyy-MM-dd'); },
  fmt: function (d) { return Utilities.formatDate(d, TZ, 'dd/MM/yyyy HH:mm'); },
};

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e && e.postData ? e.postData.contents : '{}');
  } catch (err) {
    return json({ ok: false, error: { code: 'invalid', message: 'Corps JSON non valide.' } });
  }
  return json(handle(body, SpreadsheetApp.getActive(), function () { return new Date(); }));
}

function doGet() {
  return json({ ok: true, data: { service: 'kilosaurus-temps' } });
}

function handle(body, ss, now) {
  var cache = CacheService.getScriptCache();
  if (cache.get('locked')) {
    return { ok: false, error: { code: 'locked', message: 'Accès bloqué : trop de codes refusés. Réessaie dans une heure.' } };
  }
  var store = new SheetStore(ss);
  var env = { store: store, now: now, tz: tzParis, auth: function (code) {
    var who = authByCode(store, code);
    if (!who) countFailedCode(cache);
    return who;
  } };
  if (!Core.isWrite(body && body.action)) return Core.handleRequest(env, body);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, error: { code: 'busy', message: 'Serveur occupé, réessaie.' } };
  try {
    var res = Core.handleRequest(env, body);
    SpreadsheetApp.flush();
    return res;
  } finally {
    lock.releaseLock();
  }
}

function authByCode(store, code) {
  var props = PropertiesService.getScriptProperties().getProperties();
  for (var key in props) {
    var m = /^CODE_([A-Z0-9]+)((?:_[A-Z0-9]+)*)$/.exec(key);
    if (!m || props[key].length < MIN_CODE_LENGTH || props[key] !== code) continue;
    var person = store.config().persons.filter(function (p) { return normalizeName(p) === m[1]; })[0];
    return person ? { person: person, agent: m[2].split('_').indexOf('CLAUDE') !== -1 } : null;
  }
  return null;
}

function countFailedCode(cache) {
  var failed = Number(cache.get('failedCodes') || 0) + 1;
  if (failed < MAX_FAILED_CODES) return cache.put('failedCodes', String(failed), FAILED_WINDOW_S);
  cache.put('locked', '1', LOCKOUT_S);
  cache.remove('failedCodes');
}

function unlockApi() {
  CacheService.getScriptCache().removeAll(['locked', 'failedCodes']);
}

function normalizeName(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
