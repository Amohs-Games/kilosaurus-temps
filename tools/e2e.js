// Test de bout en bout de l'app : pilote un Chrome sans écran (protocole DevTools) contre le faux
// serveur, en taille téléphone, et vérifie chaque action côté serveur.
//
//   node tools/e2e.js [dossier-captures]
//
// Nécessite Chrome (chemin par défaut Windows, ou variable CHROME).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.argv[2] || null;
const ROOT = path.join(__dirname, '..');
let failures = 0;
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, label) {
  console.log((cond ? '  ok   ' : '  ÉCHEC ') + label);
  if (!cond) failures++;
}

function startServer(port, extra = []) {
  const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'fake-api.js'), '--port', String(port), ...extra], { stdio: 'ignore' });
  children.push(p);
  return sleep(400);
}

async function api(port, body) {
  const r = await fetch(`http://localhost:${port}/api`, { method: 'POST', body: JSON.stringify(body) });
  return (await r.json()).data;
}

async function startChrome(debugPort) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-e2e-'));
  const p = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  children.push(p);
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* Chrome démarre */ }
    await sleep(200);
  }
  throw new Error('Chrome ne répond pas.');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || expression);
    return r.result.value;
  };
  const waitFor = async (expression, label, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(100);
    }
    check(false, 'attente : ' + label);
    return false;
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  return { send, evaluate, waitFor, shot, click, errors, close: () => ws.close() };
}

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const P = 8790;
  await startServer(P);
  const page = await connect(await startChrome(9333));
  const base = `http://localhost:${P}`;
  const me = { code: 'code-amohs' };

  console.log('Connexion');
  await page.send('Page.navigate', { url: base + '/' });
  await page.waitFor('document.getElementById("login-form")', 'écran de code');
  await page.evaluate('document.getElementById("code").value = "mauvais"; document.getElementById("login-form").requestSubmit()');
  await page.waitFor('document.querySelector(".error")', 'message d’erreur');
  check(/inconnu/.test(await page.evaluate('document.querySelector(".error").textContent')), 'un code inconnu est refusé');
  await page.evaluate('document.getElementById("code").value = "code-amohs"; document.getElementById("login-form").requestSubmit()');
  await page.waitFor('document.querySelector(".hero")', 'écran principal');
  await page.shot('01-accueil');

  console.log('Lancement, bascule, stop');
  await page.click('[data-act="start"][data-p="Fluffy"]');
  check(await page.evaluate('document.querySelector(".hero-project").textContent.split(" · ")[0]') === 'Fluffy', 'le compteur s’affiche tout de suite');
  await page.waitFor('document.querySelector(".sync-ok")', 'synchro');
  check((await api(P, { ...me, action: 'status' })).running?.project === 'Fluffy', 'serveur : Fluffy en cours');
  await page.click('[data-act="start"][data-p="Jam"]');
  await page.waitFor('document.querySelector(".sync-ok") && document.querySelector(".hero-project").textContent.startsWith("Jam · ")', 'bascule');
  let s = await api(P, { ...me, action: 'status' });
  check(s.running?.project === 'Jam' && s.last?.project === 'Fluffy', 'serveur : bascule Fluffy → Jam');
  await page.shot('02-compteur');
  await page.click('[data-act="stop"]');
  await page.waitFor('document.querySelector(".hero.idle") && document.querySelector(".sync-ok")', 'arrêt');
  check((await api(P, { ...me, action: 'status' })).running === null, 'serveur : plus de compteur');

  console.log('Types, total du jour, récap');
  await page.click('[data-act="type"][data-t="Dev"]');
  await page.click('[data-act="start"][data-p="Fluffy"]');
  await page.waitFor('document.querySelector(".sync-ok") && /Dev/.test(document.querySelector(".hero-project").textContent)', 'lancement en Dev');
  await page.click('[data-act="type"][data-t="Art"]');
  await page.waitFor('document.querySelector(".sync-ok") && /Art/.test(document.querySelector(".hero-project").textContent)', 'bascule en Art');
  s = await api(P, { ...me, action: 'status' });
  check(s.running?.type === 'Art' && s.last?.type === 'Dev' && s.last?.project === 'Fluffy', 'serveur : bascule de type Dev → Art sur Fluffy');
  check(await page.evaluate('document.querySelectorAll("#timeline .seg").length') >= 1, 'la frise montre la journée');
  await page.click('[data-act="pause"]');
  await page.waitFor('document.querySelector(".sync-ok") && document.querySelector(".hero.paused") && document.querySelector("[data-act=resume]")', 'pause');
  s = await api(P, { ...me, action: 'status' });
  check(s.running?.type === 'Pause' && s.running?.project === 'Fluffy' && s.last?.type === 'Art', 'serveur : la pause est un morceau Pause, le compteur continue');
  check(!(await page.evaluate('!!document.querySelector("[data-act=type][data-t=Pause]")')), 'la pause n’est pas une tâche à choisir');
  await page.shot('02a-pause');
  await page.click('[data-act="resume"]');
  await page.waitFor('document.querySelector(".sync-ok") && !document.querySelector(".hero.paused") && /Art/.test(document.querySelector(".hero-project").textContent)', 'reprise');
  check((await api(P, { ...me, action: 'status' })).running?.type === 'Art', 'serveur : reprise sur la tâche d’avant');
  await page.click('[data-act="recap"]');
  await page.waitFor('document.querySelector("dialog .recap .bars")', 'récap semaine');
  await page.shot('02b-recap');
  await page.click('dialog [data-act="recapMode"][data-m="month"]');
  await page.waitFor('document.querySelector("dialog .recap .breakdown")', 'récap mois');
  await page.click('dialog [data-act="close"]');
  await page.click('[data-act="menu"]');
  await page.click('dialog [data-act="toggleStudio"]');
  await page.waitFor('document.querySelector("[data-act=start][data-p=Studio]")', 'Studio affiché par le réglage');
  // Réglage remis : avec Studio affiché, Proto et Jam passeraient dans « Plus… » pour la suite du test.
  await page.click('[data-act="menu"]');
  await page.click('dialog [data-act="toggleStudio"]');
  await page.waitFor('!document.querySelector("[data-act=start][data-p=Studio]")', 'Studio masqué à nouveau');
  await page.click('[data-act="stop"]');
  await page.waitFor('document.querySelector(".hero.idle") && document.querySelector(".sync-ok")', 'arrêt');

  console.log('Note');
  await page.click('[data-act="start"][data-p="Proto"]');
  await page.click('[data-act="note"]');
  await page.waitFor('document.getElementById("note-text")', 'fenêtre de note');
  await page.evaluate('document.getElementById("note-text").value = "écran titre"');
  await page.click('[data-act="noteSave"]');
  await page.waitFor('document.querySelector(".sync-ok") && document.querySelector(".note-text").textContent === "écran titre"', 'note');
  check((await api(P, { ...me, action: 'status' })).running?.note === 'écran titre', 'serveur : note enregistrée');
  await page.click('[data-act="stop"]');
  await page.waitFor('document.querySelector(".hero.idle") && document.querySelector(".sync-ok")', 'arrêt');

  console.log('Bloc');
  await page.click('[data-act="block"][data-v="8"]');
  await page.waitFor('document.querySelector("dialog[open] [data-act=blockSave]")', 'choix du projet');
  await page.shot('03-bloc');
  await page.click('dialog [data-act="blockSave"][data-p="Proto"]');
  await page.waitFor('document.querySelector(".sync-ok") && !document.querySelector("dialog[open]")', 'bloc');
  s = await api(P, { ...me, action: 'status' });
  check(s.last?.project === 'Proto' && s.last?.hours === 8 && !s.last?.start, 'serveur : bloc de 8 h sur Proto');

  console.log('Autre jour');
  await page.click('[data-act="otherDay"]');
  await page.waitFor('document.getElementById("od-date")', 'fenêtre autre jour');
  await page.shot('04-autre-jour');
  await page.evaluate('document.getElementById("od-project").value = "Proto"');
  await page.click('#od-hours [data-v="4"]');
  await page.click('[data-act="otherDaySave"]');
  await page.waitFor('document.querySelector(".sync-ok") && !document.querySelector("dialog[open]")', 'enregistrement');
  s = await api(P, { ...me, action: 'status' });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  check(s.last?.project === 'Proto' && s.last?.hours === 4 && s.last?.date === yesterday, 'serveur : 4 h sur Proto hier');

  console.log('Hors ligne');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.click('[data-act="start"][data-p="Heirfall"]');
  check(await page.evaluate('document.querySelector(".hero-project").textContent.split(" · ")[0]') === 'Heirfall', 'hors ligne : le compteur s’affiche quand même');
  await page.waitFor('document.querySelector(".sync-pending")', 'indicateur en attente');
  check(JSON.parse(await page.evaluate('localStorage.getItem("kt.queue")')).length === 1, 'hors ligne : action gardée en file');
  check((await api(P, { ...me, action: 'status' })).running === null, 'serveur : rien reçu pendant la coupure');
  await page.shot('05-hors-ligne');
  await sleep(1500);
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.evaluate('window.dispatchEvent(new Event("online"))');
  await page.waitFor('document.querySelector(".sync-ok")', 'resynchro', 8000);
  s = await api(P, { ...me, action: 'status' });
  check(s.running?.project === 'Heirfall' && s.running?.source === 'hors ligne', 'serveur : action rejouée, marquée hors ligne');
  check(Date.now() - new Date(s.running.start).getTime() >= 1500, 'serveur : l’heure du tap fait foi');
  await page.click('[data-act="stop"]');
  await page.waitFor('document.querySelector(".hero.idle") && document.querySelector(".sync-ok")', 'arrêt');

  console.log('Nouveau projet');
  await page.click('[data-act="menu"]');
  await page.click('dialog [data-act="addProject"]');
  await page.evaluate('document.getElementById("project-name").value = "Game Jam 26"');
  await page.click('[data-act="addProjectSave"]');
  await page.waitFor('document.querySelector(".sync-ok") && document.querySelector("[data-act=more]")', 'projet ajouté');
  check((await api(P, { ...me, action: 'status' })).projects.includes('Game Jam 26'), 'serveur : onglet créé');
  await page.click('[data-act="more"]');
  await page.click('dialog [data-act="start"][data-p="Game Jam 26"]');
  await page.waitFor('document.querySelector(".sync-ok") && document.querySelector(".hero-project").textContent.startsWith("Game Jam 26 · ")', 'lancement depuis « Plus… »');
  await page.shot('06-plus');

  console.log('Refus du serveur');
  await page.click('[data-act="stop"]');
  await page.waitFor('document.querySelector(".hero.idle") && document.querySelector(".sync-ok")', 'arrêt');
  await page.click('[data-act="menu"]');
  await page.click('dialog [data-act="addProject"]');
  await page.evaluate('document.getElementById("project-name").value = "fluffy"');
  await page.click('[data-act="addProjectSave"]');
  await page.waitFor('document.getElementById("toast").classList.contains("show")', 'message de refus');
  check(/Refusé/.test(await page.evaluate('document.getElementById("toast").textContent')), 'un nom de projet déjà pris est refusé et signalé');
  await page.waitFor('document.querySelector(".sync-ok")', 'état rechargé après refus');
  check(!(await api(P, { ...me, action: 'status' })).projects.includes('fluffy'), 'serveur : aucun onglet en double');

  console.log('Version compacte (mini-fenêtre de bureau)');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 420, deviceScaleFactor: 2, mobile: false });
  await page.send('Page.navigate', { url: base + '/?mini=1' });
  await page.waitFor('document.querySelector(".hero") && document.querySelector(".types")', 'compteur et tâches');
  // Visible = réellement dessiné (un parent masqué compte), pas seulement le style propre.
  const shown = (sel) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.getClientRects().length > 0; })()`);
  check(await shown('.hero') && await shown('.types'), 'mini : compteur, projets et tâches affichés');
  check(!(await shown('.today')) && !(await shown('.blocks')), 'mini : journée et blocs masqués');
  check(await page.evaluate('document.documentElement.scrollWidth <= 300'), 'mini : rien ne dépasse en largeur');
  check(await page.evaluate('/Plus d.infos/.test((document.querySelector("[data-act=moreInfo]") || {}).textContent || "")'), 'mini : bouton « Plus d’infos »');
  await page.shot('11-mini');

  check(page.errors.length === 0, 'aucune erreur JavaScript' + (page.errors.length ? ' : ' + page.errors.join(' | ') : ''));
  page.close();

  console.log('Garde-fou des oublis');
  const P2 = 8791;
  await startServer(P2, ['--forgot']);
  const page2 = await connect(await startChrome(9334));
  await page2.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await page2.send('Page.navigate', { url: `http://localhost:${P2}/?dev-code=code-amohs` });
  await page2.waitFor('document.getElementById("forgot-end")', 'question « Tu as fini à quelle heure ? »');
  await page2.shot('07-oubli');
  await page2.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
  check(await page2.evaluate('!!document.querySelector("dialog[open]")'), 'la question ne se ferme pas sans réponse');
  const endValue = await page2.evaluate('(() => { const d = new Date(Date.now() - 2 * 3600000); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()); })()');
  await page2.evaluate(`document.getElementById("forgot-end").value = "${endValue}"`);
  await page2.click('[data-act="forgotSave"]');
  await page2.waitFor('document.querySelector(".sync-ok") && document.querySelector(".hero.idle")', 'compteur fermé');
  s = await api(P2, { ...me, action: 'status' });
  check(s.running === null && s.last?.corrected && Math.abs(s.last.hours - 7) < 0.05, 'serveur : session fermée à l’heure donnée, marquée corrigée');
  await page2.shot('08-clair');
  check(page2.errors.length === 0, 'aucune erreur JavaScript' + (page2.errors.length ? ' : ' + page2.errors.join(' | ') : ''));

  console.log('Mauvaise configuration : un message qui dit la vraie cause');
  const cases = [
    { port: 8792, url: 'https://script.google.com/macros/s/REMPLACER_PAR_L_ID_DU_DEPLOIEMENT/exec', expect: /pas encore reliée/, label: 'URL du modèle → écran « pas encore reliée »', shot: '09-non-reliee' },
    { port: 8793, url: '/nope', expect: /répond « 404 »/, label: 'URL qui répond 404 → message 404, pas « hors ligne »', shot: '10-erreur-404' },
    { port: 8794, url: '/index.html', expect: /Réponse inattendue/, label: 'réponse non JSON → message « réponse inattendue »' },
  ];
  for (const c of cases) {
    await startServer(c.port, ['--api-url', c.url]);
    await page2.send('Page.navigate', { url: `http://localhost:${c.port}/?dev-code=code-amohs` });
    await page2.waitFor(`/${c.expect.source}/.test(document.body.textContent)`, c.label);
    check(!/Hors ligne/.test(await page2.evaluate('document.body.textContent')), c.label);
    if (c.port !== 8792) check(await page2.evaluate('!!document.querySelector(".sync-error")'), 'indicateur rouge');
    if (c.shot) await page2.shot(c.shot);
  }
  page2.close();
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    children.forEach((c) => c.kill());
    console.log(failures ? `\n${failures} échec(s).` : '\nTout est vert.');
    process.exit(failures ? 1 : 0);
  });
