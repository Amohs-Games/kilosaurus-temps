/**
 * Calculs purs de l'app (aucun accès au DOM) : formats d'affichage, état optimiste, heures
 * corrigées. Chargé par index.html (window.KTLogic) et par les tests Node (module.exports).
 */
(function (root) {
  'use strict';

  var BLOCK_HOURS = [2, 4, 6, 8, 10, 12];
  // Copie de la liste du serveur (Core.gs), pour un état mis en cache par une version sans types.
  var DEFAULT_TYPES = [
    { name: 'Autre', color: '#9B20F9' },
    { name: 'Dev', color: '#3B82F6' },
    { name: 'Art', color: '#EC4899' },
    { name: 'Narration', color: '#22C55E' },
  ];
  var DEFAULT_TYPE = 'Autre';
  var HOUR = 3600000;
  var DAY_START_HOUR = 8;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function typesOf(s) { return (s && s.types && s.types.length) ? s.types : DEFAULT_TYPES; }
  function typeOf(row) { return (row && row.type) || DEFAULT_TYPE; }
  function typeColor(s, name) {
    var t = typesOf(s).filter(function (x) { return x.name === name; })[0];
    return t ? t.color : DEFAULT_TYPES[0].color;
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
   * Nouvelle date-heure pour une correction d'heure (champ 'start' ou 'end', valeur « HH:MM »).
   * La fin se place le jour du début, ou le lendemain si elle tombe avant : la session passe minuit.
   * Le début se place le jour de la fin, ou la veille s'il tombe après.
   */
  function editedInstant(last, field, hhmm) {
    var d;
    if (field === 'end') {
      d = atTime(last.start, hhmm);
      if (d <= new Date(last.start)) d.setDate(d.getDate() + 1);
    } else {
      d = atTime(last.end, hhmm);
      if (d >= new Date(last.end)) d.setDate(d.getDate() - 1);
    }
    return d.toISOString();
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
      var type = p.type || (s.running ? typeOf(s.running) : DEFAULT_TYPE);
      if (s.running && s.running.project === p.project && typeOf(s.running) === type) return s;
      var start = new Date(new Date(at).getTime() - (p.offsetMinutes || 0) * 60000);
      if (s.running) {
        var prevStart = new Date(s.running.start);
        if (start < prevStart) start = prevStart;
        s.running.end = start.toISOString();
        s.running.hours = hoursBetween(s.running.start, start);
        s.last = s.running;
        upsertToday(s, s.last);
      }
      s.running = {
        id: p.id, project: p.project, type: type, date: dayKey(start), start: start.toISOString(), end: null,
        hours: null, note: p.note || '', source: 'app', corrected: false,
      };
      upsertToday(s, s.running);
    } else if (item.action === 'stop') {
      if (!s.running) return s;
      var end = p.endAt || at;
      s.running.end = end;
      s.running.hours = hoursBetween(s.running.start, end);
      if (p.endAt) s.running.corrected = true;
      s.last = s.running;
      upsertToday(s, s.last);
      s.running = null;
    } else if (item.action === 'note') {
      if (s.running) s.running.note = p.text;
    } else if (item.action === 'logBlock') {
      s.last = {
        id: p.id, project: p.project, type: p.type || DEFAULT_TYPE, date: p.date || dayKey(at), start: null, end: null,
        hours: p.hours, note: p.note || '', source: 'app', corrected: false,
      };
      if (s.last.date === dayKey(at)) upsertToday(s, s.last);
    } else if (item.action === 'editLast') {
      if (!s.last || s.last.id !== p.id) return s;
      if (p.field === 'hours') s.last.hours = p.value;
      else {
        s.last[p.field] = p.value;
        s.last.hours = hoursBetween(s.last.start, s.last.end);
        s.last.date = dayKey(s.last.start);
      }
      s.last.corrected = true;
      if ((s.today || []).some(function (r) { return r.id === s.last.id; })) upsertToday(s, s.last);
    } else if (item.action === 'addProject') {
      if (s.projects.indexOf(p.name) < 0) s.projects.push(p.name);
    }
    return s;
  }

  function rowHours(row, nowMs) {
    if (!row.start) return Number(row.hours) || 0;
    var end = row.end ? new Date(row.end).getTime() : nowMs;
    return Math.max(0, end - new Date(row.start).getTime()) / HOUR;
  }

  // Total du jour : la part des sessions entre minuit et maintenant, plus les blocs du jour.
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

  var api = {
    BLOCK_HOURS: BLOCK_HOURS, DEFAULT_TYPES: DEFAULT_TYPES, dayKey: dayKey, hoursBetween: hoursBetween,
    elapsed: elapsed, duration: duration, clock: clock, dayLabel: dayLabel,
    editedInstant: editedInstant, visibleProjects: visibleProjects, pickableProjects: pickableProjects,
    isForgotten: isForgotten, applyLocal: applyLocal,
    typesOf: typesOf, typeOf: typeOf, typeColor: typeColor, rowHours: rowHours, todayTotal: todayTotal,
    dayTimeline: dayTimeline, weekRange: weekRange, monthRange: monthRange, aggregate: aggregate, recapMatches: recapMatches,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KTLogic = api;
})(this);
