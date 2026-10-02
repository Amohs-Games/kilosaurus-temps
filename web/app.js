/**
 * Kilosaurus Temps — interface.
 *
 * Chaque tap modifie tout de suite l'état affiché (KTLogic.applyLocal), puis l'action part dans
 * une file envoyée au serveur dans l'ordre. Si le réseau ne répond pas, la file est gardée
 * (localStorage) et rejouée plus tard avec l'heure du tap. La réponse du serveur remplace
 * l'état affiché dès que la file est vide.
 */
(function () {
  'use strict';

  var L = window.KTLogic;
  var API = window.KT_API_URL;
  var VERSION = '1.7.0';
  var TIMEOUT_MS = 25000; // Apps Script répond parfois en 30 s ; l'écran, lui, a déjà réagi.
  var RETRY_MS = 30000;
  var BUSY_RETRY_MS = 5000;
  var KEYS = { code: 'kt.code', status: 'kt.status', queue: 'kt.queue', type: 'kt.type', studio: 'kt.showStudio' };
  // L'URL d'API doit avoir été renseignée dans config.js (le modèle contient « REMPLACER »).
  var CONFIGURED = typeof API === 'string' && /^(https?:\/\/|\/)/.test(API) && API.indexOf('REMPLACER') < 0;
  // Version compacte (?mini=1) pour la mini-fenêtre de bureau (dossier desktop/) : compteur, projets
  // et tâches seulement. La fenêtre fournit window.ktDesktop (taille, verrou).
  var MINI = /[?&]mini=1(&|$)/.test(location.search);
  if (MINI) document.documentElement.classList.add('mini');

  // ---- Stockage local (peut être indisponible : navigation privée…) ----

  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function save(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* l'app marche sans, simplement sans mémoire */ }
  }
  function loadJson(key) { try { return JSON.parse(load(key)); } catch (e) { return null; } }

  var state = {
    code: load(KEYS.code),
    status: loadJson(KEYS.status),
    queue: loadJson(KEYS.queue) || [],
    sync: 'ok',
    syncMsg: '',
    flushing: false,
    retryTimer: null,
    loginError: '',
    forgotOpen: false,
    type: L.typeOf({ type: load(KEYS.type) }),
    showStudio: load(KEYS.studio) === '1',
    recap: null,
  };

  function saveStatus() { save(KEYS.status, state.status ? JSON.stringify(state.status) : null); }
  function saveQueue() { save(KEYS.queue, JSON.stringify(state.queue)); }

  // Type affiché : celui du compteur en cours, sinon le dernier choisi (utilisé au prochain lancement).
  function currentType() {
    var r = state.status && state.status.running;
    return r ? L.typeOf(r) : state.type;
  }
  function setType(t) { state.type = t; save(KEYS.type, t); }

  // ---- Réseau ----

  // Échec d'appel, classé pour dire à l'utilisateur ce qui ne va pas vraiment :
  //   network — aucune réponse (hors ligne, serveur injoignable) ;
  //   http    — le serveur répond une erreur (mauvaise URL, déploiement supprimé) ;
  //   format  — le serveur répond autre chose que du JSON (déploiement pas ouvert à tous, script qui plante).
  function ApiError(kind, detail) {
    this.kind = kind;
    this.detail = detail;
  }

  function failureMessage(err) {
    if (err.kind === 'http') return 'Le serveur répond « ' + err.detail + ' ». Vérifie l’adresse de l’API (config.js) et son déploiement.';
    if (err.kind === 'format') return 'Réponse inattendue du serveur. Le déploiement doit être ouvert à « Tout le monde », et le script ne doit pas planter.';
    return navigator.onLine === false ? 'Hors ligne.' : 'Serveur injoignable.';
  }

  // Seul un vrai problème de réseau est « en attente » (orange) ; le reste est une erreur (rouge).
  function failureLevel(err) {
    return err.kind === 'network' ? 'pending' : 'error';
  }

  // Une exception du code de l'app ne doit jamais passer pour une coupure réseau.
  function rethrowIfBug(err) {
    if (!(err instanceof ApiError)) {
      setSync('error', 'Erreur de l’app : ' + (err && err.message));
      throw err;
    }
  }

  function post(body) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new ApiError('http', r.status);
      return r.text().then(function (text) {
        try { return JSON.parse(text); } catch (e) { throw new ApiError('format'); }
      });
    }, function () {
      clearTimeout(timer);
      throw new ApiError('network');
    });
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function act(action, params) {
    var item = { action: action, params: params, clientTime: new Date().toISOString(), offline: false };
    state.status = L.applyLocal(state.status, item);
    saveStatus();
    state.queue.push(item);
    saveQueue();
    if (navigator.vibrate) navigator.vibrate(10);
    render();
    flush();
  }

  function setSync(sync, msg) {
    state.sync = sync;
    state.syncMsg = msg || '';
    var dot = document.querySelector('.sync');
    if (dot) dot.className = 'sync sync-' + sync;
  }

  function scheduleRetry(ms) {
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(refresh, ms || RETRY_MS);
  }

  function flush() {
    if (state.flushing || !state.code || !state.queue.length) return;
    state.flushing = true;
    setSync('pending', state.queue.length + ' action(s) en cours d’envoi.');
    var item = state.queue[0];
    var body = Object.assign({ code: state.code, action: item.action }, item.params);
    if (item.offline) { body.offline = true; body.clientTime = item.clientTime; }

    post(body).then(function (res) {
      state.flushing = false;
      if (res.ok) {
        state.queue.shift();
        saveQueue();
        if (state.queue.length) return flush();
        setStatus(res.data);
        setSync('ok');
        return;
      }
      var code = res.error && res.error.code;
      if (code === 'unauthorized') return logout('Code refusé. Saisis-le à nouveau.');
      if (code === 'busy') { setSync('pending', 'Serveur occupé, nouvel essai…'); return scheduleRetry(BUSY_RETRY_MS); }
      if (code === 'locked') {
        // API bloquée : rien n'est écrit, la file est rejouée au déblocage avec l'heure de chaque tap.
        state.queue.forEach(function (q) { q.offline = true; });
        saveQueue();
        setSync('error', res.error.message + ' ' + state.queue.length + ' action(s) en attente.');
        return scheduleRetry();
      }
      // Refus (invalid / server) : l'action est abandonnée et l'état rechargé depuis le serveur.
      state.queue.shift();
      saveQueue();
      toast('Refusé : ' + (res.error && res.error.message));
      if (state.queue.length) flush();
      else refresh();
    }).catch(function (err) {
      state.flushing = false;
      rethrowIfBug(err);
      // Rien n'est arrivé au serveur : chaque action en file sera rejouée avec l'heure de son tap.
      state.queue.forEach(function (q) { q.offline = true; });
      saveQueue();
      setSync(failureLevel(err), failureMessage(err) + ' ' + state.queue.length + ' action(s) en attente.');
      scheduleRetry();
    });
  }

  function refresh() {
    if (!state.code) return;
    if (state.queue.length) return flush();
    post({ code: state.code, action: 'status' }).then(function (res) {
      if (res.ok) {
        setStatus(res.data);
        setSync('ok');
        checkForgotten();
      } else if (res.error.code === 'unauthorized') {
        logout(state.status ? 'Code refusé. Saisis-le à nouveau.' : 'Code inconnu.');
      } else {
        setSync('error', res.error.message);
        if (res.error.code === 'locked') scheduleRetry();
      }
    }).catch(function (err) {
      rethrowIfBug(err);
      setSync(failureLevel(err), failureMessage(err));
      if (!state.status) render();
      checkForgotten();
      scheduleRetry();
    });
  }

  function setStatus(data) {
    state.status = data;
    if (data && data.running) setType(L.typeOf(data.running));
    saveStatus();
    render();
    native('onStatus', JSON.stringify(data));
  }

  // Dans l'APK Android, la page partage son code et son état avec le widget (pont KTAndroid).
  function native(method, arg) {
    try {
      if (window.KTAndroid) window.KTAndroid[method](arg);
    } catch (e) { /* le widget se resynchronise seul */ }
  }

  function logout(message) {
    state.code = null;
    state.status = null;
    native('setCode', '');
    state.queue = [];
    save(KEYS.code, null);
    saveStatus();
    saveQueue();
    state.loginError = message || '';
    closeDialog();
    render();
  }

  // ---- Rendu ----

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  function render() {
    renderView();
    fitDesktopWindow();
  }

  // Dans la mini-fenêtre de bureau, la fenêtre prend la hauteur du contenu.
  function fitDesktopWindow() {
    if (!MINI || !window.ktDesktop) return;
    requestAnimationFrame(function () {
      var box = document.getElementById('app').getBoundingClientRect();
      window.ktDesktop.fit(Math.ceil(box.height));
    });
  }

  function renderView() {
    var app = document.getElementById('app');
    if (!CONFIGURED) { app.innerHTML = setupView(); return; }
    if (!state.code) { app.innerHTML = loginView(); return; }
    var s = state.status;
    if (!s) {
      app.innerHTML = header(null) + '<p class="empty">' +
        (state.sync === 'ok' ? 'Connexion…' : esc(state.syncMsg) + '<br>Nouvel essai dans un instant…') + '</p>';
      return;
    }
    // Haut en bas = ordre d'usage : ce qui tourne, choisir un type, lancer, la journée, après coup.
    app.innerHTML = header(s) + hero(s) +
      section('Tâche', typeBar(s)) +
      section('Ajouter un bloc d’heures', blocks(), 'add') +
      todayView(s);
    tick();
  }

  function setupView() {
    return '<section class="login"><h1>Kilosaurus Temps</h1>' +
      '<p class="error">Cette app n’est pas encore reliée à son API.</p>' +
      '<p class="muted">Déploie le script Apps Script, puis colle l’URL de l’application Web dans <b>web/config.js</b> (README, étapes 5 et 6).</p>' +
      '</section>';
  }

  function loginView() {
    return '<form class="login" id="login-form">' +
      '<h1>Kilosaurus Temps</h1>' +
      '<label for="code" class="muted">Ton code personnel</label>' +
      '<input class="field" id="code" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required>' +
      (state.loginError ? '<p class="error">' + esc(state.loginError) + '</p>' : '') +
      '<button class="primary" type="submit">Entrer</button>' +
      '</form>';
  }

  function header(s) {
    return '<header class="top">' +
      '<button class="sync sync-' + state.sync + '" data-act="sync" aria-label="État de la synchro"></button>' +
      '<span class="me">' + esc(s ? s.me : '') + (s && s.agent ? ' <span class="tag">agent</span>' : '') + '</span>' +
      (MINI ? '<a class="icon" href="./" target="_blank" aria-label="Ouvrir en grand">⤢</a>' : '') +
      '<button class="icon" data-act="menu" aria-label="Menu">' + GEAR + '</button>' +
      '</header>';
  }

  function section(title, body, extraClass) {
    return '<section class="block' + (extraClass ? ' ' + extraClass : '') + '"><h2 class="block-title">' + esc(title) + '</h2>' + body + '</section>';
  }

  // La carte compteur : toujours là, avec les projets qui le lancent. Au repos, 0:00:00 en grisé dit
  // clairement que rien ne tourne.
  function hero(s) {
    var r = s.running;
    if (!r) {
      return '<section class="hero idle">' +
        '<div class="hero-project">Rien en cours</div>' +
        '<div class="hero-time">0:00:00</div>' +
        grid(s) +
        '</section>';
    }
    var t = L.typeOf(r);
    var c = L.typeColor(s, t);
    return '<section class="hero">' +
      '<div class="hero-project">' + esc(r.project) + ' · <span class="pill" style="background:' + c + ';color:' + L.textOn(c) + '">' + esc(t) + '</span></div>' +
      '<div class="hero-time" id="elapsed">' + L.elapsed(Date.now() - new Date(r.start).getTime()) + '</div>' +
      '<button class="stop" data-act="stop">STOP</button>' +
      grid(s) +
      '<button class="link note-text" data-act="note">' + (r.note ? esc(r.note) : '+ note') + '</button>' +
      '</section>';
  }

  function typeBar(s) {
    var cur = currentType();
    return '<div class="types">' + L.typesOf(s).map(function (t) {
      return '<button class="type' + (t.name === cur ? ' on' : '') + '" style="--c:' + t.color + ';--on:' + L.textOn(t.color) + '" data-act="type" data-t="' + esc(t.name) + '">' + esc(t.name) + '</button>';
    }).join('') + '</div>';
  }

  function todayView(s) {
    return '<section class="today">' +
      '<div class="today-head"><span>Aujourd’hui</span><b id="today-total">' + L.duration(L.todayTotal(s.today, Date.now())) + '</b>' +
      '<button class="link small" data-act="recap">Récap</button></div>' +
      '<div class="timeline" id="timeline">' + timelineHtml(s) + '</div></section>';
  }

  function timelineHtml(s) {
    var tl = L.dayTimeline(s.today, Date.now());
    var span = Math.max(tl.to - tl.from, 60000);
    var pct = function (ms) { return ((ms - tl.from) / span * 100).toFixed(2) + '%'; };
    var html = tl.segments.map(function (g) {
      return '<span class="seg" style="left:' + pct(g.start) + ';width:' + (((g.end - g.start) / span) * 100).toFixed(2) + '%;background:' + L.typeColor(s, g.type) + '"></span>';
    }).join('');
    var h = new Date(tl.from);
    h.setMinutes(0, 0, 0);
    h.setHours(h.getHours() + 1);
    for (; h.getTime() < tl.to; h.setHours(h.getHours() + 1)) {
      if (h.getHours() % 2) continue;
      html += '<span class="tick" style="left:' + pct(h.getTime()) + '">' + h.getHours() + 'h</span>';
    }
    return html;
  }

  // Les projets sont les boutons qui lancent le compteur : ▶, vert « lancer ».
  function projectButton(s, p) {
    var on = s.running && s.running.project === p;
    return '<button class="proj play' + (on ? ' on' : '') + '" style="--go:' + L.projectColor(p) + '" data-act="start" data-p="' + esc(p) + '">' +
      '<span class="proj-icon">' + (on ? '●' : '▶') + '</span><span class="proj-name">' + esc(p) + '</span>' +
      (on ? '<small>en cours</small>' : '') + '</button>';
  }

  function grid(s) {
    var vp = L.visibleProjects(s, state.showStudio);
    var html = vp.shown.map(function (p) { return projectButton(s, p); }).join('');
    if (vp.more.length) {
      var hidden = s.running && vp.more.indexOf(s.running.project) >= 0;
      html += '<button class="proj play more' + (hidden ? ' on' : '') + '" data-act="more">' +
        (hidden ? '● ' + esc(s.running.project) : 'Plus…') + '</button>';
    }
    return '<div class="grid">' + html + '</div>';
  }

  function blocks() {
    return '<div class="row blocks">' +
      L.BLOCK_HOURS.map(function (h) {
        return '<button class="chip" data-act="block" data-v="' + h + '">' + h + ' h</button>';
      }).join('') + '</div>' +
      '<button class="link small" data-act="otherDay">Un autre jour…</button>';
  }

  function tick() {
    var el = document.getElementById('elapsed');
    var r = state.status && state.status.running;
    if (el && r) el.textContent = L.elapsed(Date.now() - new Date(r.start).getTime());
    var total = document.getElementById('today-total');
    if (total && state.status) total.textContent = L.duration(L.todayTotal(state.status.today, Date.now()));
    var tl = document.getElementById('timeline');
    if (tl && state.status && r && Date.now() % 30000 < 1000) tl.innerHTML = timelineHtml(state.status);
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 4000);
  }

  // ---- Fenêtres ----

  var dlg = document.createElement('dialog');
  document.body.appendChild(dlg);
  dlg.addEventListener('cancel', function (e) { if (dlg.dataset.locked) e.preventDefault(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg && !dlg.dataset.locked) closeDialog(); });
  dlg.addEventListener('close', function () { state.forgotOpen = false; state.recap = null; });

  function openDialog(html, locked) {
    dlg.innerHTML = '<div class="dlg">' + html + '</div>';
    if (locked) dlg.dataset.locked = '1';
    else delete dlg.dataset.locked;
    if (!dlg.open) dlg.showModal();
  }

  function closeDialog() {
    delete dlg.dataset.locked;
    if (dlg.open) dlg.close();
  }

  function projectList(projects, act, extraData) {
    return '<div class="list">' + projects.map(function (p) {
      return '<button class="proj" data-act="' + act + '" data-p="' + esc(p) + '"' +
        (extraData || '') + '>' + esc(p) + '</button>';
    }).join('') + '</div>';
  }

  function cancelButton() { return '<button class="secondary" data-act="close">Annuler</button>'; }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localInputValue(d) {
    return L.dayKey(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function checkForgotten() {
    var s = state.status;
    if (state.forgotOpen || !L.isForgotten(s, Date.now())) return;
    state.forgotOpen = true;
    var start = new Date(s.running.start);
    openDialog(
      '<h2>Tu as fini à quelle heure ?</h2>' +
      '<p>Ton compteur <b>' + esc(s.running.project) + '</b> tourne depuis le ' +
      start.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + ' à ' + L.clock(s.running.start) + '.</p>' +
      '<input class="field" id="forgot-end" type="datetime-local" min="' + localInputValue(start) + '" max="' + localInputValue(new Date()) + '">' +
      '<button class="primary" data-act="forgotSave">Valider</button>',
      true
    );
  }

  // ---- Actions de l'interface ----

  var handlers = {
    close: closeDialog,

    type: function (el) {
      var t = el.dataset.t;
      var r = state.status.running;
      setType(t);
      if (r && L.typeOf(r) !== t) act('start', { id: uid(), project: r.project, type: t });
      else render();
    },

    start: function (el) {
      var p = el.dataset.p;
      closeDialog();
      var r = state.status.running;
      if (r && r.project === p) return;
      act('start', { id: uid(), project: p, type: currentType() });
    },

    stop: function () { act('stop', {}); },

    more: function () {
      openDialog('<h2>Autres projets</h2>' + projectList(L.visibleProjects(state.status, state.showStudio).more, 'start') + cancelButton());
    },

    note: function () {
      var r = state.status.running;
      openDialog('<h2>Note</h2>' +
        '<textarea class="field" id="note-text" maxlength="500" placeholder="Sur quoi tu bosses ?">' + esc(r ? r.note : '') + '</textarea>' +
        '<div class="actions">' + cancelButton() + '<button class="primary" data-act="noteSave">Enregistrer</button></div>');
      document.getElementById('note-text').focus();
    },

    noteSave: function () {
      var text = document.getElementById('note-text').value.trim();
      closeDialog();
      if (state.status.running) act('note', { text: text });
    },

    block: function (el) {
      var h = Number(el.dataset.v);
      openDialog('<h2>' + h + ' h aujourd’hui sur…</h2>' +
        projectList(L.pickableProjects(state.status, state.showStudio), 'blockSave', ' data-h="' + h + '"') + cancelButton());
    },

    blockSave: function (el) {
      closeDialog();
      act('logBlock', { id: uid(), project: el.dataset.p, hours: Number(el.dataset.h), type: currentType() });
    },

    otherDay: function () {
      var today = new Date();
      var yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      openDialog('<h2>Ajouter après coup</h2>' +
        '<input class="field" id="od-date" type="date" max="' + L.dayKey(today) + '" value="' + L.dayKey(yesterday) + '">' +
        '<select class="field" id="od-project">' + L.pickableProjects(state.status, state.showStudio).map(function (p) {
          return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
        }).join('') + '</select>' +
        '<div class="row blocks" id="od-hours">' + L.BLOCK_HOURS.map(function (h) {
          return '<button class="chip' + (h === 8 ? ' on' : '') + '" data-act="pickHours" data-v="' + h + '">' + h + '</button>';
        }).join('') + '</div>' +
        '<input class="field" id="od-note" type="text" maxlength="500" placeholder="Note (optionnelle)">' +
        '<div class="actions">' + cancelButton() + '<button class="primary" data-act="otherDaySave">Enregistrer</button></div>');
    },

    pickHours: function (el) {
      el.parentNode.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', c === el); });
    },

    otherDaySave: function () {
      var date = document.getElementById('od-date').value;
      var picked = dlg.querySelector('#od-hours .chip.on');
      if (!date) return toast('Choisis une date.');
      if (date > L.dayKey(new Date())) return toast('Pas de date dans le futur.');
      if (!picked) return toast('Choisis une durée.');
      var params = {
        id: uid(),
        project: document.getElementById('od-project').value,
        hours: Number(picked.dataset.v),
        date: date,
        type: currentType(),
      };
      var note = document.getElementById('od-note').value.trim();
      if (note) params.note = note;
      closeDialog();
      act('logBlock', params);
    },


    forgotSave: function () {
      var value = document.getElementById('forgot-end').value;
      var r = state.status.running;
      if (!value) return toast('Indique ton heure de fin.');
      var end = new Date(value);
      if (end <= new Date(r.start)) return toast('La fin doit être après le début.');
      if (end > new Date()) return toast('La fin ne peut pas être dans le futur.');
      closeDialog();
      act('stop', { endAt: end.toISOString() });
    },

    menu: function () {
      openDialog('<h2>Menu</h2>' +
        (state.status ? '<button class="menu-item" data-act="addProject">+ Nouveau projet</button>' : '') +
        (state.status ? '<button class="menu-item" data-act="toggleStudio">Afficher Studio : ' + (state.showStudio ? 'oui' : 'non') + '</button>' : '') +
        '<button class="menu-item" data-act="changeCode">Changer de code</button>' +
        '<div class="version">Kilosaurus Temps ' + VERSION + '</div>' + cancelButton());
    },

    addProject: function () {
      openDialog('<h2>Nouveau projet</h2><p>Un onglet du même nom est créé dans la Sheet.</p>' +
        '<input class="field" id="project-name" type="text" maxlength="30" placeholder="Nom du projet">' +
        '<div class="actions">' + cancelButton() + '<button class="primary" data-act="addProjectSave">Créer</button></div>');
      document.getElementById('project-name').focus();
    },

    addProjectSave: function () {
      var name = document.getElementById('project-name').value.trim();
      if (!name) return toast('Donne un nom au projet.');
      if (name.charAt(0) === '_') return toast('Un nom de projet ne commence pas par « _ ».');
      closeDialog();
      act('addProject', { name: name });
    },

    changeCode: function () {
      var pending = state.queue.length;
      var msg = pending
        ? pending + ' action(s) pas encore envoyée(s) seront perdues. Changer de code quand même ?'
        : 'Changer de code sur cet appareil ?';
      if (window.confirm(msg)) logout('');
    },

    sync: function () {
      var labels = { ok: 'Tout est synchronisé.', pending: 'En attente de synchro.', error: 'Erreur de synchro.' };
      openDialog('<h2>Synchro</h2><p>' + esc(state.syncMsg || labels[state.sync]) + '</p>' +
        (state.queue.length ? '<p>' + state.queue.length + ' action(s) en attente.</p>' : '') +
        '<div class="actions">' + cancelButton() + '<button class="primary" data-act="retry">Réessayer</button></div>');
    },

    retry: function () {
      closeDialog();
      refresh();
    },

    toggleStudio: function () {
      state.showStudio = !state.showStudio;
      save(KEYS.studio, state.showStudio ? '1' : null);
      closeDialog();
      render();
    },

    recap: function () {
      state.recap = { mode: 'week', ref: new Date(), data: null, error: '' };
      loadRecap();
    },
    recapMode: function (el) {
      state.recap.mode = el.dataset.m;
      state.recap.ref = new Date();
      loadRecap();
    },
    recapPrev: function () { shiftRecap(-1); },
    recapNext: function () { shiftRecap(1); },
  };

  // ---- Récap (lecture seule : ne passe pas par la file d'actions) ----

  function recapRange() {
    return state.recap.mode === 'week' ? L.weekRange(state.recap.ref) : L.monthRange(state.recap.ref);
  }

  function shiftRecap(n) {
    var d = new Date(state.recap.ref);
    if (state.recap.mode === 'week') d.setDate(d.getDate() + 7 * n);
    else d.setMonth(d.getMonth() + n, 1);
    state.recap.ref = d;
    loadRecap();
  }

  function loadRecap() {
    var range = recapRange();
    var rc = state.recap;
    rc.data = null;
    rc.error = '';
    renderRecap();
    // Seule la réponse qui correspond à la période encore affichée compte : une réponse plus
    // ancienne, arrivée en retard après un changement de vue, est ignorée.
    var current = function () { return state.recap === rc && recapRange().from === range.from && recapRange().to === range.to; };
    post({ code: state.code, action: 'history', from: range.from, to: range.to }).then(function (res) {
      if (!current()) return;
      if (res.ok && L.recapMatches(range, res.data)) rc.data = res.data;
      else rc.error = res.ok ? 'Réponse inattendue du serveur.' : res.error.message;
      renderRecap();
    }).catch(function (err) {
      rethrowIfBug(err);
      if (!current()) return;
      rc.error = 'Récap indisponible : ' + failureMessage(err);
      renderRecap();
    });
  }

  function hoursLabel(h) { return L.duration(Math.round(h * 60) / 60); }

  function renderRecap() {
    var rc = state.recap;
    var s = state.status;
    var range = recapRange();
    var title = rc.mode === 'week'
      ? 'Semaine du ' + L.dayLabel(range.from, 0)
      : new Date(range.from + 'T12:00:00').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    var body;
    if (rc.error) body = '<p class="error">' + esc(rc.error) + '</p>';
    else if (!rc.data) body = '<p class="muted">Chargement…</p>';
    else {
      var g = L.aggregate(rc.data.rows, range.days, Date.now());
      body = '<p class="recap-total">Total : <b>' + hoursLabel(g.total) + '</b></p>' +
        (rc.mode === 'week' ? weekBars(s, g, range) : '') +
        breakdown('Par type', L.typesOf(s).map(function (t) { return [t.name, g.byType[t.name] || 0, t.color]; }), g.total) +
        (rc.mode === 'month' ? breakdown('Par projet', Object.keys(g.byProject).map(function (p) { return [p, g.byProject[p], null]; }), g.total) : '');
    }
    openDialog('<div class="recap">' +
      '<div class="tabs"><button class="chip' + (rc.mode === 'week' ? ' on' : '') + '" data-act="recapMode" data-m="week">Semaine</button>' +
      '<button class="chip' + (rc.mode === 'month' ? ' on' : '') + '" data-act="recapMode" data-m="month">Mois</button></div>' +
      '<div class="recap-nav"><button class="icon" data-act="recapPrev" aria-label="Précédent">‹</button><h2>' + esc(title) + '</h2>' +
      '<button class="icon" data-act="recapNext" aria-label="Suivant">›</button></div>' +
      body + '</div>' + '<button class="secondary" data-act="close">Fermer</button>');
  }

  function weekBars(s, g, range) {
    var max = Math.max(8, Math.max.apply(null, range.days.map(function (k) { return g.byDay[k].total; })));
    return '<div class="bars">' + range.days.map(function (k) {
      var day = g.byDay[k];
      var stack = L.typesOf(s).map(function (t) {
        var h = day.byType[t.name] || 0;
        return h ? '<span style="height:' + (h / max * 100).toFixed(1) + '%;background:' + t.color + '"></span>' : '';
      }).join('');
      var label = new Date(k + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'narrow' });
      return '<div class="bar"><div class="stack">' + stack + '</div><small>' + (day.total ? hoursLabel(day.total) : '–') + '</small><small class="muted">' + label + '</small></div>';
    }).join('') + '</div>';
  }

  function breakdown(title, items, total) {
    return '<h3>' + esc(title) + '</h3><div class="breakdown">' + items.filter(function (i) { return i[1] > 0; }).map(function (i) {
      return '<div class="line"><span class="dot"' + (i[2] ? ' style="background:' + i[2] + '"' : '') + '></span><span>' + esc(i[0]) + '</span>' +
        '<b>' + hoursLabel(i[1]) + '</b><span class="muted">' + Math.round(i[1] / (total || 1) * 100) + ' %</span></div>';
    }).join('') + '</div>';
  }

  // ---- Événements ----

  // Tant que l'état n'est pas chargé, seules ces actions ont un sens.
  var WITHOUT_STATUS = ['close', 'sync', 'retry', 'menu', 'changeCode'];

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !handlers[el.dataset.act]) return;
    if (!state.status && WITHOUT_STATUS.indexOf(el.dataset.act) < 0) return;
    handlers[el.dataset.act](el);
  });

  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'login-form') return;
    e.preventDefault();
    var code = document.getElementById('code').value.trim();
    if (!code) return;
    state.code = code;
    state.loginError = '';
    save(KEYS.code, code);
    native('setCode', code);
    render();
    refresh();
  });

  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });
  setInterval(tick, 1000);
  setInterval(function () { if (state.queue.length) flush(); }, RETRY_MS);

  // Hors ligne pour le web seulement : dans l'APK, les fichiers sont déjà sur le téléphone.
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.KTAndroid) {
    navigator.serviceWorker.register('sw.js');
  }

  // Mini-fenêtre verrouillée : la barre du haut ne sert plus de poignée pour la déplacer.
  if (MINI && window.ktDesktop && window.ktDesktop.onLocked) {
    window.ktDesktop.onLocked(function (locked) { document.documentElement.classList.toggle('locked', !!locked); });
  }

  if (state.code) native('setCode', state.code);
  render();
  if (CONFIGURED) refresh();
})();
