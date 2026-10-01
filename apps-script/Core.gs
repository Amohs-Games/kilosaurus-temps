/**
 * Logique métier de Kilosaurus Temps, en JavaScript pur : aucune API Google ici.
 *
 * Tout passe par `env` :
 *   env.store — lecture / écriture des lignes (SheetStore en production, MemoryStore en test)
 *   env.now   — horloge, () => Date
 *   env.tz    — fuseau Europe/Paris : dayKey(date) → 'aaaa-mm-jj', dayStart(key) → Date, fmt(date) → texte
 *   env.auth  — code → { person, agent } ou null
 *
 * Ce découpage permet de tester toute la logique dans Node, avec le même fichier.
 */
var Core = (function () {
  var BLOCK_HOURS = [2, 4, 6, 8, 10, 12];
  var OFFSETS = [0, 15, 30, 60];
  var MAX_SESSION_MS = 24 * 3600000;
  var FORBIDDEN_NAME = /[\[\]*?\/\\:]/;
  var DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
  var WRITE_ACTIONS = ['start', 'stop', 'note', 'logBlock', 'logSession', 'editLast', 'addProject'];
  // Types de travail, dans l'ordre d'affichage. Une ligne sans type (historique) vaut Autre.
  var TYPES = [
    { name: 'Autre', color: '#9B20F9' },
    { name: 'Dev', color: '#3B82F6' },
    { name: 'Art', color: '#EC4899' },
    { name: 'Narration', color: '#22C55E' },
  ];
  var TYPE_NAMES = TYPES.map(function (t) { return t.name; });
  var DEFAULT_TYPE = 'Autre';

  // Pas d'instanceof : une Date venue d'un autre contexte JS (tests Node) doit aussi être reconnue.
  function isDate(v) {
    return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
  }

  function AppError(code, message) {
    this.code = code;
    this.message = message;
  }

  function fail(message) {
    throw new AppError('invalid', message);
  }

  // ---- Lecture ----

  function isRunning(row) {
    return isDate(row.start) && !(isDate(row.end));
  }

  function myRows(ctx) {
    return ctx.store.allRows().filter(function (r) { return r.person === ctx.me; });
  }

  function myRunning(ctx) {
    var running = myRows(ctx).filter(isRunning);
    running.sort(function (a, b) { return b.start - a.start; });
    return running[0] || null;
  }

  function typeOf(row) {
    return TYPE_NAMES.indexOf(row.type) >= 0 ? row.type : DEFAULT_TYPE;
  }

  function myLast(ctx) {
    var done = myRows(ctx).filter(function (r) {
      return !isRunning(r) && r.source !== 'report' && isDate(r.touched);
    });
    done.sort(function (a, b) { return b.touched - a.touched; });
    return done[0] || null;
  }

  function findById(ctx, id) {
    var all = ctx.store.allRows();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function toApi(ctx, row) {
    if (!row) return null;
    return {
      id: row.id,
      project: row.project,
      type: typeOf(row),
      date: isDate(row.date) ? ctx.tz.dayKey(row.date) : null,
      start: isDate(row.start) ? row.start.toISOString() : null,
      end: isDate(row.end) ? row.end.toISOString() : null,
      hours: typeof row.hours === 'number' ? row.hours : null,
      note: row.note || '',
      source: row.source,
      corrected: row.corrected === 'oui',
    };
  }

  function status(ctx) {
    var cfg = ctx.store.config();
    return {
      me: ctx.me,
      agent: ctx.agent,
      projects: ctx.store.projects(),
      studio: cfg.studio,
      visible: cfg.visible,
      threshold: cfg.threshold,
      running: toApi(ctx, myRunning(ctx)),
      last: toApi(ctx, myLast(ctx)),
      now: ctx.now.toISOString(),
    };
  }

  // ---- Validation ----

  function hoursBetween(start, end) {
    return Math.round((end.getTime() - start.getTime()) / 36000) / 100;
  }

  function parseInstant(value, label) {
    var d = typeof value === 'string' ? new Date(value) : null;
    if (!d || isNaN(d.getTime())) fail(label + ' : date-heure non valide.');
    return d;
  }

  function requireId(p) {
    if (typeof p.id !== 'string' || !p.id || p.id.length > 64) fail('Identifiant de ligne manquant ou trop long.');
    return p.id;
  }

  function requireProject(ctx, name) {
    if (ctx.store.projects().indexOf(name) < 0) fail('Projet inconnu : ' + name);
    return name;
  }

  function cleanNote(text) {
    if (text === undefined || text === null) return '';
    if (typeof text !== 'string') fail('La note doit être du texte.');
    if (text.length > 500) fail('Note trop longue (500 caractères max).');
    return text.trim();
  }

  function requireBlockHours(value) {
    var h = Number(value);
    if (BLOCK_HOURS.indexOf(h) < 0) fail('Heures autorisées : 2, 4, 6, 8, 10 ou 12.');
    return h;
  }

  function requireType(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (TYPE_NAMES.indexOf(value) < 0) fail('Type inconnu : ' + value + '. Types : ' + TYPE_NAMES.join(', ') + '.');
    return value;
  }

  // Heure à laquelle l'action a eu lieu : celle du serveur, sauf pour une action rejouée hors ligne.
  function actionTime(ctx) {
    if (ctx.offline && ctx.clientTime) {
      var t = new Date(ctx.clientTime);
      if (!isNaN(t.getTime())) return t > ctx.now ? ctx.now : t;
    }
    return ctx.now;
  }

  function source(ctx) {
    if (ctx.agent) return 'claude';
    return ctx.offline ? 'hors ligne' : 'app';
  }

  function newRow(ctx, fields) {
    return {
      id: fields.id,
      person: ctx.me,
      date: fields.date,
      start: fields.start || '',
      end: fields.end || '',
      hours: fields.hours === undefined ? '' : fields.hours,
      note: fields.note || '',
      type: fields.type || DEFAULT_TYPE,
      source: source(ctx),
      created: ctx.now,
      touched: ctx.now,
      corrected: '',
    };
  }

  function sessionDate(ctx, start) {
    return ctx.tz.dayStart(ctx.tz.dayKey(start));
  }

  function correction(ctx, row, field, oldValue, newValue) {
    ctx.store.addCorrection({
      at: ctx.now,
      author: ctx.me,
      source: source(ctx),
      project: row.project,
      id: row.id,
      field: field,
      oldValue: oldValue,
      newValue: newValue,
    });
  }

  function close(ctx, row, end) {
    ctx.store.update(row.ref, { end: end, hours: hoursBetween(row.start, end), touched: ctx.now });
  }

  // ---- Actions ----

  var actions = {
    status: function () {},

    start: function (ctx, p) {
      var id = requireId(p);
      var project = requireProject(ctx, p.project);
      var offset = p.offsetMinutes === undefined ? 0 : Number(p.offsetMinutes);
      if (OFFSETS.indexOf(offset) < 0) fail('Décalage autorisé : 0, 15, 30 ou 60 minutes.');
      var note = cleanNote(p.note);
      var running = myRunning(ctx);
      var type = requireType(p.type, running ? typeOf(running) : DEFAULT_TYPE);
      if (findById(ctx, id)) return;
      // Relancer ce qui tourne déjà n'est pas une action.
      if (running && running.project === project && typeOf(running) === type) return;

      var start = new Date(actionTime(ctx).getTime() - offset * 60000);
      if (running) {
        if (start < running.start) start = running.start;
        close(ctx, running, start);
      }
      ctx.store.insert(project, newRow(ctx, { id: id, date: sessionDate(ctx, start), start: start, note: note, type: type }));
    },

    stop: function (ctx, p) {
      var running = myRunning(ctx);
      if (p.endAt !== undefined && p.endAt !== null) {
        if (!running) fail('Aucun compteur en cours.');
        var endAt = parseInstant(p.endAt, 'Heure de fin');
        if (endAt <= running.start) fail('La fin doit être après le début.');
        if (endAt > ctx.now) fail('La fin ne peut pas être dans le futur.');
        close(ctx, running, endAt);
        ctx.store.update(running.ref, { corrected: 'oui' });
        correction(ctx, running, 'Fin (oubli)', 'en cours', ctx.tz.fmt(endAt));
        return;
      }
      if (!running) return;
      var end = actionTime(ctx);
      // Un stop rejoué hors ligne, plus ancien que le compteur en cours, visait un compteur déjà fermé.
      if (end < running.start) return;
      close(ctx, running, end);
    },

    note: function (ctx, p) {
      var text = cleanNote(p.text);
      var running = myRunning(ctx);
      if (!running) fail('Aucun compteur en cours.');
      ctx.store.update(running.ref, { note: text });
    },

    logBlock: function (ctx, p) {
      var id = requireId(p);
      var project = requireProject(ctx, p.project);
      var hours = requireBlockHours(p.hours);
      var note = cleanNote(p.note);
      var type = requireType(p.type, DEFAULT_TYPE);
      var today = ctx.tz.dayKey(ctx.now);
      var key = p.date === undefined || p.date === null ? ctx.tz.dayKey(actionTime(ctx)) : p.date;
      if (typeof key !== 'string' || !DAY_KEY.test(key)) fail('Date attendue au format aaaa-mm-jj.');
      if (key > today) fail('La date ne peut pas être dans le futur.');
      if (findById(ctx, id)) return;
      ctx.store.insert(project, newRow(ctx, { id: id, date: ctx.tz.dayStart(key), hours: hours, note: note, type: type }));
    },

    logSession: function (ctx, p) {
      if (!ctx.agent) fail('Action réservée aux codes d\'agent.');
      var id = requireId(p);
      var project = requireProject(ctx, p.project);
      var start = parseInstant(p.start, 'Début');
      var end = parseInstant(p.end, 'Fin');
      var note = cleanNote(p.note);
      var type = requireType(p.type, DEFAULT_TYPE);
      if (end <= start) fail('La fin doit être après le début.');
      if (end > ctx.now) fail('La fin ne peut pas être dans le futur.');
      if (end - start > MAX_SESSION_MS) fail('Une session ne peut pas dépasser 24 h.');
      if (findById(ctx, id)) return;
      var overlap = myRows(ctx).filter(function (r) {
        if (!(isDate(r.start))) return false;
        var rEnd = isDate(r.end) ? r.end : ctx.now;
        return start < rEnd && r.start < end;
      })[0];
      if (overlap) fail('Chevauche une session existante (' + overlap.project + ', ' + ctx.tz.fmt(overlap.start) + ').');
      ctx.store.insert(project, newRow(ctx, {
        id: id, date: sessionDate(ctx, start), start: start, end: end, hours: hoursBetween(start, end), note: note, type: type,
      }));
    },

    editLast: function (ctx, p) {
      var last = myLast(ctx);
      if (!last || last.id !== p.id) fail('Seul ton dernier log peut être corrigé.');
      var isSession = isDate(last.start);

      if (p.field === 'hours') {
        if (isSession) fail('Pour une session, corrige le début ou la fin.');
        var hours = requireBlockHours(p.value);
        ctx.store.update(last.ref, { hours: hours, corrected: 'oui', touched: ctx.now });
        correction(ctx, last, 'Heures', String(last.hours), String(hours));
        return;
      }
      if (p.field !== 'start' && p.field !== 'end') fail('Champ à corriger : start, end ou hours.');
      if (!isSession) fail('Un bloc n\'a ni début ni fin : corrige ses heures.');

      var value = parseInstant(p.value, p.field === 'start' ? 'Début' : 'Fin');
      var start = p.field === 'start' ? value : last.start;
      var end = p.field === 'end' ? value : last.end;
      if (end <= start) fail('La fin doit être après le début.');
      if (end > ctx.now) fail('La fin ne peut pas être dans le futur.');
      if (end - start > MAX_SESSION_MS) fail('Une session ne peut pas dépasser 24 h.');

      ctx.store.update(last.ref, {
        start: start, end: end, date: sessionDate(ctx, start), hours: hoursBetween(start, end), corrected: 'oui',
        touched: ctx.now,
      });
      var old = p.field === 'start' ? last.start : last.end;
      correction(ctx, last, p.field === 'start' ? 'Début' : 'Fin', ctx.tz.fmt(old), ctx.tz.fmt(value));
    },

    addProject: function (ctx, p) {
      var name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name) fail('Nom de projet vide.');
      if (name.length > 30) fail('Nom de projet trop long (30 caractères max).');
      if (name.charAt(0) === '_') fail('Un nom de projet ne commence pas par « _ ».');
      if (FORBIDDEN_NAME.test(name)) fail('Caractères interdits : [ ] * ? / \\ :');
      var lower = name.toLowerCase();
      var taken = ctx.store.sheetNames().some(function (n) { return n.toLowerCase() === lower; });
      if (taken) fail('Ce nom est déjà pris : ' + name);
      ctx.store.createProject(name);
    },
  };

  // ---- Entrée ----

  function authenticate(env, code) {
    if (typeof code !== 'string' || !code) return null;
    var who = env.auth(code);
    if (!who) return null;
    if (env.store.config().persons.indexOf(who.person) < 0) return null;
    return who;
  }

  function handleRequest(env, body) {
    try {
      body = body || {};
      var who = authenticate(env, body.code);
      if (!who) return { ok: false, error: { code: 'unauthorized', message: 'Code inconnu.' } };
      var action = actions.hasOwnProperty(body.action) ? actions[body.action] : null;
      if (!action) fail('Action inconnue : ' + body.action);
      var ctx = {
        store: env.store,
        tz: env.tz,
        now: env.now(),
        me: who.person,
        agent: !!who.agent,
        offline: body.offline === true,
        clientTime: body.clientTime,
      };
      action(ctx, body);
      return { ok: true, data: status(ctx) };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message } };
      return { ok: false, error: { code: 'server', message: String(e && e.message ? e.message : e) } };
    }
  }

  function isWrite(action) {
    return WRITE_ACTIONS.indexOf(action) >= 0;
  }

  return { handleRequest: handleRequest, isWrite: isWrite, BLOCK_HOURS: BLOCK_HOURS, TYPES: TYPES };
})();
