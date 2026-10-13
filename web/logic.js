/**
 * Calculs purs de l'app (aucun accès au DOM) : formats d'affichage, état optimiste, heures
 * corrigées. Chargé par index.html (window.KTLogic) et par les tests Node (module.exports).
 */
(function (root) {
  'use strict';

  var BLOCK_HOURS = [2, 4, 6, 8, 10, 12];
  // Copie de la liste du serveur (Core.gs), pour un état mis en cache par une version sans types.
  var DEFAULT_TYPES = [
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
  var DEFAULT_TYPE = 'Misc';
  var PAUSE_NAME = 'Pause';
  // Noms de la première version, encore possibles dans un état ou un réglage mis en cache.
  var LEGACY_TYPES = { Autre: 'Misc', Narration: 'Writing' };
  var HOUR = 3600000;
  var DAY_START_HOUR = 8;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function typesOf(s) { return (s && s.types && s.types.length) ? s.types : DEFAULT_TYPES; }
  function canonicalType(name) { return LEGACY_TYPES.hasOwnProperty(name) ? LEGACY_TYPES[name] : name; }
  function typeOf(row) { return canonicalType((row && row.type) || DEFAULT_TYPE); }
  function typeColor(s, name) {
    var t = typesOf(s).filter(function (x) { return x.name === name; })[0];
    return t ? t.color : DEFAULT_TYPES[0].color;
  }

  // Couleur des boutons de projet (lancer) : vert par défaut, quelques projets ont la leur.
  var PROJECT_COLORS = { fluffy: '#4a7fc1' };
  var DEFAULT_PROJECT_COLOR = '#4e9f6d';
  function projectColor(name) {
    return PROJECT_COLORS[String(name).toLowerCase()] || DEFAULT_PROJECT_COLOR;
  }

  // Couleur du texte posé sur une couleur de tâche : sombre sur une couleur claire (jaune…), blanc sinon.
  function textOn(hex) {
    var n = parseInt(String(hex).replace('#', ''), 16);
    var lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? '#17171b' : '#ffffff';
  }

  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(date, n) { var d = new Date(date); d.setDate(d.getDate() + n); return d; }

  function dayKey(d) {
    d = new Date(d);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function hoursBetween(a, b) {
    return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 36000) / 100;
  }

  // Temps écoulé du compteur : 2:14:07
  function elapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 3600) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }

  // Durée d'un log : « 3 h 28 », « 8 h »
  function duration(hours) {
    var m = Math.round(hours * 60);
    var h = Math.floor(m / 60);
    return m % 60 ? h + ' h ' + pad(m % 60) : h + ' h';
  }

  function clock(iso) {
    var d = new Date(iso);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function dayLabel(key, now) {
    var today = new Date(now);
    if (key === dayKey(today)) return "aujourd'hui";
    var y = new Date(today);
    y.setDate(y.getDate() - 1);
    if (key === dayKey(y)) return 'hier';
    var p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function atTime(baseIso, hhmm) {
    var d = new Date(baseIso);
    var p = hhmm.split(':');
    d.setHours(+p[0], +p[1], 0, 0);
    return d;
  }

  /**
   * Champs à envoyer pour corriger une ligne depuis la fenêtre des sessions : seulement ceux qui
   * changent. Les heures « HH:MM » se placent le jour du début ; une fin plus tôt que le début passe
   * au lendemain (session qui passe minuit). Une heure inchangée (même HH:MM) n'est pas renvoyée,
   * pour ne pas perdre ses secondes. Renvoie null si rien ne change.
   */
  function entryEdit(row, form) {
    var out = {};
    if (form.project && form.project !== row.project) out.project = form.project;
    if (form.type && form.type !== typeOf(row)) out.type = form.type;
    if (form.note != null && form.note.trim() !== (row.note || '')) out.note = form.note.trim();
    if (row.start) {
      var startChanged = !!form.start && form.start !== clock(row.start);
      var start = startChanged ? atTime(row.start, form.start) : new Date(row.start);
      if (startChanged) out.start = start.toISOString();
      if (row.end && form.end && form.end !== clock(row.end)) {
        var end = atTime(start.toISOString(), form.end);
        if (end <= start) end.setDate(end.getDate() + 1);
        out.end = end.toISOString();
      }
    } else if (form.hours && form.hours !== Number(row.hours)) {
      out.hours = form.hours;
    }
    return Object.keys(out).length ? out : null;
  }

  // Heure de fin la plus tardive pour un compteur oublié : maintenant, mais pas plus de 24 h après
  // le début (une session ne dépasse pas 24 h).
  function forgotMax(startIso, nowMs) {
    return new Date(Math.min(nowMs, new Date(startIso).getTime() + 24 * HOUR));
  }

  // Session plus longue que le seuil d'oubli : sans doute un compteur oublié (signalé ⚠).
  function isLong(row, thresholdHours, nowMs) {
    return !!row.start && rowHours(row, nowMs) > (thresholdHours || 8);
  }

  function pickableProjects(s, showStudio) {
    return s.projects.filter(function (p) { return showStudio || p !== s.studio; });
  }

  // Boutons projets : les `visible` premiers, le reste derrière « Plus… ». Le studio n'y est que
  // si le réglage « Afficher Studio » est coché.
  function visibleProjects(s, showStudio) {
    var list = pickableProjects(s, showStudio);
    if (list.length <= s.visible) return { shown: list, more: [] };
    var n = Math.max(s.visible - 1, 1);
    return { shown: list.slice(0, n), more: list.slice(n) };
  }

  function isForgotten(s, now) {
    return !!(s && s.running && now - new Date(s.running.start).getTime() > s.threshold * 3600000);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Ajoute ou remplace une ligne dans `today` (même id).
  function upsertToday(s, row) {
    s.today = (s.today || []).filter(function (r) { return r.id !== row.id; });
    s.today.push(row);
  }

  var TASK_ACTIONS = ['select', 'addTask', 'editTask', 'deleteTask', 'moveTask', 'checkTask', 'uncheckTask', 'activateTask', 'deactivateTask'];
  var WORKDAY_HOUR = 6;
  var MAX_SESSION_MS = 24 * HOUR;
  var MAX_DESCRIPTION = 200;
  var MAX_TODO = 30;

  // Une activité absente, null ou vide veut dire « pas donnée » (repli), comme sur le serveur.
  function typeOrFallback(value, fallback) {
    return value === undefined || value === null || value === '' ? fallback : canonicalType(value);
  }

  function isPauseType(type) { return canonicalType(type) === PAUSE_NAME; }

  // Jour de travail : de 6 h à 6 h le lendemain, à l’heure locale de l’appareil. Avant 6 h du matin,
  // c’est encore celui de la veille.
  function workDayKey(ms) {
    var d = new Date(ms);
    if (d.getHours() < WORKDAY_HOUR) d.setDate(d.getDate() - 1);
    return dayKey(d);
  }
  function workDayStart(key) {
    var p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], WORKDAY_HOUR, 0, 0, 0).getTime();
  }

  // À faire (ordre de la liste : position, puis ordre du tableau). Tolère un état sans `tasks`.
  function todoTasks(s) {
    return ((s && s.tasks) || [])
      .map(function (t, i) { return { t: t, i: i }; })
      .filter(function (x) { return !x.t.done; })
      .sort(function (a, b) {
        return (a.t.position - b.t.position) || (a.i - b.i) || (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0);
      })
      .map(function (x) { return x.t; });
  }
  // Faites (ordre des coches).
  // Avec `nowMs` : seulement celles cochées depuis le début du jour de travail en cours (6 h).
  function doneTasks(s, nowMs) {
    var since = nowMs == null ? 0 : workDayStart(workDayKey(nowMs));
    return ((s && s.tasks) || []).filter(function (t) { return !!t.done && new Date(t.done).getTime() >= since; })
      .sort(function (a, b) { return new Date(a.done).getTime() - new Date(b.done).getTime(); });
  }
  // La tâche du haut : la première à faire.
  function topTask(s) { return todoTasks(s)[0] || null; }

  // Le choix partagé (projet, activité) : celui du serveur s’il existe ; sinon (ancien état en cache)
  // le compteur en cours hors pause, le dernier travaillé, le premier projet. Activité par défaut : Misc.
  function choiceOf(s) {
    if (s && s.choice) return { project: s.choice.project, type: canonicalType(s.choice.type || DEFAULT_TYPE) };
    var projects = (s && s.projects) || [];
    var from = s && s.running && !isPause(s.running) ? s.running : (s && s.last);
    if (from && projects.indexOf(from.project) >= 0) {
      return { project: from.project, type: isPause(from) ? DEFAULT_TYPE : typeOf(from) };
    }
    return { project: projects[0] || '', type: DEFAULT_TYPE };
  }

  function findTask(s, id) {
    var list = (s && s.tasks) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // La tâche active : celle du serveur si elle est encore à faire, sinon aucune.
  function activeTaskOf(s) {
    var t = s && s.activeTask ? findTask(s, s.activeTask) : null;
    return t && !t.done ? t : null;
  }

  // Le lien d’un morceau qui s’ouvre sur (project, type) : la tâche active si elle a exactement ce projet
  // et cette activité, sinon aucune.
  function linkFor(s, project, type) {
    var t = activeTaskOf(s);
    return t && t.project === project && typeOf(t) === type ? t.id : null;
  }

  // Ferme le compteur en cours à `endIso`. Un morceau lié crédite sa tâche : le temps affiché ne recule
  // pas avant la réponse du serveur.
  function closeRunning(s, endIso) {
    var run = s.running;
    run.end = endIso;
    run.hours = hoursBetween(run.start, endIso);
    var t = run.task ? findTask(s, run.task) : null;
    if (t) t.spentMs = (t.spentMs || 0) + Math.max(0, new Date(endIso).getTime() - new Date(run.start).getTime());
    s.last = run;
    upsertToday(s, run);
    s.running = null;
  }

  // Bascule locale du compteur en marche vers (project, type, tâche liée) à l’instant `atMs`, dès que
  // l’un des trois change. Rien sans compteur, en pause, déjà sur ce morceau, ou compteur oublié (plus
  // de 24 h) : seul le choix change alors.
  function switchRunning(s, project, type, atMs, taskId) {
    var run = s.running;
    taskId = taskId || null;
    if (!run || isPause(run)) return;
    if (run.project === project && typeOf(run) === type && (run.task || null) === taskId) return;
    var runStart = new Date(run.start).getTime();
    var start = Math.max(atMs, runStart);
    if (start - runStart > MAX_SESSION_MS) return;
    var startIso = new Date(start).toISOString();
    closeRunning(s, startIso);
    s.running = {
      id: 'local-' + start + '-' + project + '-' + type, project: project, type: type, date: dayKey(start), start: startIso,
      end: null, hours: null, note: '', source: 'app', corrected: false, task: taskId,
    };
    upsertToday(s, s.running);
  }

  // Plus de tâche active : le choix reste ; un compteur en marche sur elle continue sans lien.
  function deactivate(s, atMs) {
    s.activeTask = null;
    if (s.running) switchRunning(s, s.running.project, typeOf(s.running), atMs, null);
  }

  // Applique une action de tâche ou de choix à `s` (déjà copié). Renvoie false si l’action n’a pas lieu
  // (invalide ou sans effet), comme le serveur qui la refuse ou l’ignore.
  function applyTaskAction(s, item) {
    var p = item.params || {};
    var atMs = item.clientTime ? new Date(item.clientTime).getTime() : Date.now();
    var action = item.action;
    var cur = choiceOf(s);
    var active = activeTaskOf(s);
    var task;

    if (action === 'select') {
      var project = p.project === undefined ? cur.project : p.project;
      var type = typeOrFallback(p.type, cur.type);
      if ((s.projects || []).indexOf(project) < 0 || isPauseType(type)) return false;
      var link = linkFor(s, project, type);
      s.choice = { project: project, type: type };
      if (active && !link) s.activeTask = null;
      switchRunning(s, project, type, atMs, link);
      return true;
    }
    if (action === 'deactivateTask') {
      if (!active) return false;
      deactivate(s, atMs);
      return true;
    }
    if (!s.tasks) s.tasks = [];

    if (action === 'addTask') {
      var description = typeof p.description === 'string' ? p.description.trim() : '';
      if (!p.id || !description || description.length > MAX_DESCRIPTION || findTask(s, p.id)) return false;
      var taskProject = p.project === undefined || p.project === null ? cur.project : p.project;
      var taskType = typeOrFallback(p.type, cur.type);
      if ((s.projects || []).indexOf(taskProject) < 0 || isPauseType(taskType)) return false;
      var todo = todoTasks(s);
      if (todo.length >= MAX_TODO) return false;
      var position = todo.length ? todo.reduce(function (m, t) { return Math.max(m, t.position); }, 0) + 1 : 1;
      s.tasks.push({ id: p.id, description: description, project: taskProject, type: taskType, position: position, done: null, started: null, spentMs: 0 });
    } else if (action === 'editTask') {
      task = findTask(s, p.id);
      if (!task) return false;
      var next = { description: task.description, project: task.project, type: task.type };
      if (p.description !== undefined) {
        next.description = typeof p.description === 'string' ? p.description.trim() : '';
        if (!next.description || next.description.length > MAX_DESCRIPTION) return false;
      }
      if (p.project !== undefined) {
        if ((s.projects || []).indexOf(p.project) < 0) return false;
        next.project = p.project;
      }
      if (p.type !== undefined) {
        next.type = typeOrFallback(p.type, next.type);
        if (isPauseType(next.type)) return false;
      }
      if (next.description === task.description && next.project === task.project && next.type === task.type) return false;
      var moved = next.project !== task.project || next.type !== task.type;
      task.description = next.description;
      task.project = next.project;
      task.type = next.type;
      // La tâche active : le choix suit et le compteur bascule, lien gardé.
      if (active === task && moved) {
        s.choice = { project: task.project, type: typeOf(task) };
        switchRunning(s, task.project, typeOf(task), atMs, task.id);
      }
    } else if (action === 'deleteTask') {
      task = findTask(s, p.id);
      if (!task) return false;
      if (active === task) deactivate(s, atMs);
      s.tasks = s.tasks.filter(function (t) { return t !== task; });
    } else if (action === 'activateTask') {
      task = findTask(s, p.id);
      if (!task || task.done || active === task) return false;
      s.activeTask = task.id;
      s.choice = { project: task.project, type: typeOf(task) };
      switchRunning(s, task.project, typeOf(task), atMs, task.id);
    } else if (action === 'moveTask') {
      task = findTask(s, p.id);
      var dest = p.before === undefined ? null : p.before;
      if (!task || task.done || (dest !== null && (typeof dest !== 'string' || dest === task.id))) return false;
      var current = todoTasks(s);
      var others = current.filter(function (t) { return t !== task; });
      var index = others.length;
      if (dest !== null) {
        index = -1;
        others.forEach(function (t, i) { if (t.id === dest) index = i; });
        if (index < 0) return false;
      }
      var order = others.slice(0, index).concat([task], others.slice(index));
      if (order.every(function (t, i) { return t === current[i]; })) return false;
      order.forEach(function (t, i) { t.position = i + 1; });
    } else if (action === 'checkTask') {
      // Valider : la tâche active est désactivée, le compteur continue sans elle.
      task = findTask(s, p.id);
      if (!task || task.done) return false;
      if (active === task) deactivate(s, atMs);
      task.done = new Date(atMs).toISOString();
      // Début : le premier morceau du jour passé dessus (le serveur, qui voit tout l’historique, corrige).
      var first = null;
      (s.today || []).forEach(function (r) {
        if (r.task === task.id && r.start && (!first || r.start < first)) first = r.start;
      });
      task.started = first || task.started || null;
    } else if (action === 'uncheckTask') {
      task = findTask(s, p.id);
      if (!task || !task.done) return false;
      var todoNow = todoTasks(s);
      if (todoNow.length >= MAX_TODO) return false;
      // Reprend sa position ; les tâches à faire à cette position ou après descendent d'un cran.
      todoNow.forEach(function (t) { if (t.position >= task.position) t.position += 1; });
      task.done = null;
      task.started = null;
    } else {
      return false;
    }
    return true;
  }

  // Temps passé sur une tâche : ses morceaux terminés (serveur), plus le morceau en cours s’il est lié.
  function taskSpentMs(s, task, nowMs) {
    var ms = (task && task.spentMs) || 0;
    var run = s && s.running;
    if (task && run && run.task === task.id) ms += Math.max(0, nowMs - new Date(run.start).getTime());
    return ms;
  }

  /**
   * Applique une action à l'état affiché, avant la réponse du serveur (interface optimiste).
   * Reprend les règles du serveur ; la réponse du serveur remplace ensuite cet état.
   */
  function applyLocal(status, item) {
    if (!status) return status;
    var s = clone(status);
    var p = item.params || {};
    var at = item.clientTime;

    if (item.action === 'start') {
      var type = p.type ? canonicalType(p.type) : (s.running ? typeOf(s.running) : DEFAULT_TYPE);
      // Une pause n’a pas de lien et garde la tâche active ; un autre projet ou une autre activité la
      // désactivent.
      var link = type === PAUSE_NAME ? null : linkFor(s, p.project, type);
      if (s.running && s.running.project === p.project && typeOf(s.running) === type && (s.running.task || null) === link) return s;
      var start = new Date(new Date(at).getTime() - (p.offsetMinutes || 0) * 60000);
      if (s.running) {
        var prevStart = new Date(s.running.start);
        if (start < prevStart) start = prevStart;
        closeRunning(s, start.toISOString());
      }
      s.running = {
        id: p.id, project: p.project, type: type, date: dayKey(start), start: start.toISOString(), end: null,
        hours: null, note: p.note || '', source: 'app', corrected: false, task: link,
      };
      upsertToday(s, s.running);
      if (type !== PAUSE_NAME) {
        s.choice = { project: p.project, type: type };
        if (!link) s.activeTask = null;
      }
    } else if (item.action === 'stop') {
      if (!s.running) return s;
      if (p.endAt) s.running.corrected = true;
      closeRunning(s, p.endAt || at);
    } else if (item.action === 'note') {
      if (s.running) s.running.note = p.text;
    } else if (item.action === 'logBlock') {
      s.last = {
        id: p.id, project: p.project, type: canonicalType(p.type || DEFAULT_TYPE), date: p.date || dayKey(at), start: null, end: null,
        hours: p.hours, note: p.note || '', source: 'app', corrected: false,
      };
      if (s.last.date === dayKey(at)) upsertToday(s, s.last);
    } else if (item.action === 'addProject') {
      if (s.projects.indexOf(p.name) < 0) s.projects.push(p.name);
    } else if (TASK_ACTIONS.indexOf(item.action) >= 0) {
      if (!applyTaskAction(s, item)) return status;
    }
    return s;
  }

  function rowHours(row, nowMs) {
    if (!row.start) return Number(row.hours) || 0;
    var end = row.end ? new Date(row.end).getTime() : nowMs;
    return Math.max(0, end - new Date(row.start).getTime()) / HOUR;
  }

  // Total du jour : la part des sessions entre minuit et maintenant, plus les blocs du jour. Les
  // pauses font partie du travail : elles y comptent.
  function todayTotal(rows, nowMs) {
    var from = startOfDay(nowMs);
    var key = dayKey(nowMs);
    return (rows || []).reduce(function (sum, r) {
      if (!r.start) return sum + (r.date === key ? Number(r.hours) || 0 : 0);
      var a = Math.max(new Date(r.start).getTime(), from);
      var b = Math.min(r.end ? new Date(r.end).getTime() : nowMs, nowMs);
      return sum + Math.max(0, b - a) / HOUR;
    }, 0);
  }

  var PAUSE_TYPE = 'Pause';
  function isPause(row) { return typeOf(row) === PAUSE_TYPE; }

  // Part du total du jour passée en pause.
  function todayPause(rows, nowMs) {
    return todayTotal((rows || []).filter(isPause), nowMs);
  }

  // Temps travaillé aujourd’hui : le total du jour sans les pauses.
  function todayWorked(rows, nowMs) {
    return Math.max(0, todayTotal(rows, nowMs) - todayPause(rows, nowMs));
  }

  var SAME_INSTANT_MS = 1000;

  /**
   * Séance du compteur en cours : la suite continue de morceaux sur le même projet (changer de
   * tâche ou faire une pause ferme un morceau et en ouvre un autre à la même seconde). Renvoie le
   * début de la séance (le lancement) et le cumul des pauses, en cours compris. Un trou ou un autre
   * projet ouvre une nouvelle séance.
   */
  function sessionOf(rows, running, nowMs) {
    var start = new Date(running.start).getTime();
    var pauseMs = isPause(running) ? Math.max(0, nowMs - start) : 0;
    var closed = (rows || []).filter(function (r) { return r.start && r.end && r.project === running.project; });
    for (;;) {
      var prev = closed.filter(function (r) { return Math.abs(new Date(r.end).getTime() - start) <= SAME_INSTANT_MS; })[0];
      if (!prev) break;
      var prevStart = new Date(prev.start).getTime();
      if (prevStart >= start) break; // garde-fou : jamais de boucle
      if (isPause(prev)) pauseMs += new Date(prev.end).getTime() - prevStart;
      start = prevStart;
    }
    return { start: start, pauseMs: pauseMs };
  }

  // Frise du jour : de min(8 h, première session) à maintenant ; les blocs n'ont pas d'heure.
  function dayTimeline(rows, nowMs) {
    var midnight = startOfDay(nowMs);
    var segments = [];
    (rows || []).forEach(function (r) {
      if (!r.start) return;
      var a = Math.max(new Date(r.start).getTime(), midnight);
      var b = Math.min(r.end ? new Date(r.end).getTime() : nowMs, nowMs);
      if (b > a) segments.push({ start: a, end: b, type: typeOf(r) });
    });
    segments.sort(function (x, y) { return x.start - y.start; });
    var from = Math.min(midnight + DAY_START_HOUR * HOUR, segments.length ? segments[0].start : Infinity);
    return { from: Math.min(from, nowMs), to: nowMs, segments: segments };
  }

  function rangeOf(first, count) {
    var days = [];
    for (var i = 0; i < count; i++) days.push(dayKey(addDays(first, i)));
    return { from: days[0], to: days[days.length - 1], days: days };
  }

  // Semaine du lundi au dimanche contenant `date` (jours calendaires : sûr aux changements d'heure).
  function weekRange(date) {
    var d = new Date(date);
    d.setHours(12, 0, 0, 0);
    return rangeOf(addDays(d, -((d.getDay() + 6) % 7)), 7);
  }

  function monthRange(date) {
    var d = new Date(date);
    var first = new Date(d.getFullYear(), d.getMonth(), 1, 12);
    return rangeOf(first, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
  }

  // Une réponse `history` ne vaut que pour la période qu'elle couvre : les réponses peuvent
  // arriver dans le désordre quand on change vite de vue (Apps Script répond en 1 à 30 s).
  function recapMatches(range, data) {
    return !!data && data.from === range.from && data.to === range.to;
  }

  // Récap : une session compte pour son jour de début (colonne Date) ; en cours, jusqu'à maintenant.
  function aggregate(rows, days, nowMs) {
    var out = { total: 0, byDay: {}, byType: {}, byProject: {} };
    days.forEach(function (k) { out.byDay[k] = { total: 0, byType: {} }; });
    (rows || []).forEach(function (r) {
      var day = out.byDay[r.date];
      if (!day) return;
      var h = rowHours(r, nowMs);
      var t = typeOf(r);
      day.total += h;
      day.byType[t] = (day.byType[t] || 0) + h;
      out.total += h;
      out.byType[t] = (out.byType[t] || 0) + h;
      out.byProject[r.project] = (out.byProject[r.project] || 0) + h;
    });
    return out;
  }

  // Bandeau d'alerte : la copie du PC manque ou a plus de 48 h, ou une journée finie n'a pas été
  // figée (status.backup). Rien si le serveur ne donne pas encore cet état.
  var BACKUP_LATE_MS = 48 * 3600000;
  function backupWarnings(backup, nowMs) {
    if (!backup) return [];
    var out = [];
    if (!backup.desktopAt) out.push('Aucune sauvegarde complète (PC et Drive) pour l’instant.');
    else {
      var age = nowMs - Date.parse(backup.desktopAt);
      if (age > BACKUP_LATE_MS) out.push('Pas de sauvegarde complète (PC et Drive) depuis ' + Math.floor(age / 86400000) + ' jours.');
    }
    if (backup.unfrozenSince) {
      var p = backup.unfrozenSince.split('-');
      out.push('Journées non figées depuis le ' + p[2] + '/' + p[1] + '.');
    }
    return out;
  }

  var api = {
    BLOCK_HOURS: BLOCK_HOURS, DEFAULT_TYPES: DEFAULT_TYPES, dayKey: dayKey, hoursBetween: hoursBetween,
    elapsed: elapsed, duration: duration, clock: clock, dayLabel: dayLabel,
    entryEdit: entryEdit, isLong: isLong, forgotMax: forgotMax, visibleProjects: visibleProjects, pickableProjects: pickableProjects,
    isForgotten: isForgotten, applyLocal: applyLocal, todoTasks: todoTasks, doneTasks: doneTasks, topTask: topTask, choiceOf: choiceOf,
    activeTaskOf: activeTaskOf, taskSpentMs: taskSpentMs,
    typesOf: typesOf, typeOf: typeOf, typeColor: typeColor, textOn: textOn, projectColor: projectColor, isPause: isPause, todayPause: todayPause, sessionOf: sessionOf, PAUSE_TYPE: PAUSE_TYPE, rowHours: rowHours, todayTotal: todayTotal, todayWorked: todayWorked,
    dayTimeline: dayTimeline, weekRange: weekRange, monthRange: monthRange, aggregate: aggregate, recapMatches: recapMatches, backupWarnings: backupWarnings,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KTLogic = api;
})(this);
