/**
 * Calculs purs de l'app (aucun accès au DOM) : formats d'affichage, état optimiste, heures
 * corrigées. Chargé par index.html (window.KTLogic) et par les tests Node (module.exports).
 */
(function (root) {
  'use strict';

  var BLOCK_HOURS = [2, 4, 6, 8, 10, 12];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

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

  // Boutons projets : les `visible` premiers (hors studio), le reste derrière « Plus… ».
  function visibleProjects(s) {
    var list = s.projects.filter(function (p) { return p !== s.studio; });
    if (list.length <= s.visible) return { shown: list, more: [] };
    var n = Math.max(s.visible - 1, 1);
    return { shown: list.slice(0, n), more: list.slice(n) };
  }

  function isForgotten(s, now) {
    return !!(s && s.running && now - new Date(s.running.start).getTime() > s.threshold * 3600000);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

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
      if (s.running && s.running.project === p.project) return s;
      var start = new Date(new Date(at).getTime() - (p.offsetMinutes || 0) * 60000);
      if (s.running) {
        var prevStart = new Date(s.running.start);
        if (start < prevStart) start = prevStart;
        s.running.end = start.toISOString();
        s.running.hours = hoursBetween(s.running.start, start);
        s.last = s.running;
      }
      s.running = {
        id: p.id, project: p.project, date: dayKey(start), start: start.toISOString(), end: null,
        hours: null, note: p.note || '', source: 'app', corrected: false,
      };
    } else if (item.action === 'stop') {
      if (!s.running) return s;
      var end = p.endAt || at;
      s.running.end = end;
      s.running.hours = hoursBetween(s.running.start, end);
      if (p.endAt) s.running.corrected = true;
      s.last = s.running;
      s.running = null;
    } else if (item.action === 'note') {
      if (s.running) s.running.note = p.text;
    } else if (item.action === 'logBlock') {
      s.last = {
        id: p.id, project: p.project, date: p.date || dayKey(at), start: null, end: null,
        hours: p.hours, note: p.note || '', source: 'app', corrected: false,
      };
    } else if (item.action === 'editLast') {
      if (!s.last || s.last.id !== p.id) return s;
      if (p.field === 'hours') s.last.hours = p.value;
      else {
        s.last[p.field] = p.value;
        s.last.hours = hoursBetween(s.last.start, s.last.end);
        s.last.date = dayKey(s.last.start);
      }
      s.last.corrected = true;
    } else if (item.action === 'addProject') {
      if (s.projects.indexOf(p.name) < 0) s.projects.push(p.name);
    }
    return s;
  }

  var api = {
    BLOCK_HOURS: BLOCK_HOURS, dayKey: dayKey, hoursBetween: hoursBetween,
    elapsed: elapsed, duration: duration, clock: clock, dayLabel: dayLabel,
    editedInstant: editedInstant, visibleProjects: visibleProjects, isForgotten: isForgotten,
    applyLocal: applyLocal,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KTLogic = api;
})(this);
