// Mini-fenêtre de bureau : le site en version compacte (?mini=1) dans une petite fenêtre sans
// bordure, dans un coin, au-dessus de tout, lancée au démarrage de Windows.
//
//   cd desktop && npm install && npm start
//
// Icône près de l'horloge : afficher / masquer, verrouiller la position, toujours au-dessus, lancer
// au démarrage, ouvrir en grand, quitter. Ctrl + Alt + K affiche ou masque la fenêtre. Le bouton –
// de la page la réduit dans la barre des tâches, le temps qu'elle ne gêne plus.
// « Sessions » (barre du haut) et le panneau « Tâches » s'ouvrent dans une deuxième fenêtre.
// Les réglages (position, verrou…) sont gardés dans window.json, dans le dossier de l'app.
// Sauvegardes : une copie vérifiée de toute la base par jour de travail, dans les dossiers
// `backupDirs` de window.json (PC et Google Drive), au lancement puis toutes les heures.
const { app, BrowserWindow, Tray, Menu, screen, shell, nativeImage, ipcMain, globalShortcut, session } = require('electron');
const fs = require('fs');
const path = require('path');

const SITE = 'https://kilosaurus-temps.kilosaurus-temps.workers.dev/';
const WIDTH = 300;
const MARGIN = 12;
const SHORTCUT = 'Control+Alt+K';
const LOGO = path.join(__dirname, '..', 'kilo_logo.png');
const ICON = path.join(__dirname, 'icon.ico');
const SHOW_FALLBACK_MS = 4000;
const RETRY_LOAD_MS = 10000;
const BACKUP_FIRST_MS = 60 * 1000;      // laisse le réseau et Google Drive arriver au démarrage
const BACKUP_EVERY_MS = 60 * 60 * 1000;

let win = null;
let tray = null;
let settings = null;
let sideWin = null;

const settingsPath = () => path.join(app.getPath('userData'), 'window.json');

// Journal court (desktop.log, à côté de window.json) : lancements et erreurs, pour comprendre une
// fenêtre qui ne s'affiche pas. Gardé sous 100 Ko.
function log(line) {
  try {
    const file = path.join(app.getPath('userData'), 'desktop.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 100000) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n');
  } catch (e) { /* le journal ne doit jamais empêcher l'app de tourner */ }
}

process.on('uncaughtException', (e) => log('erreur : ' + (e && e.stack || e)));

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (e) { /* premier lancement */ }
  return Object.assign({
    locked: false, onTop: true, autostart: true, height: 360,
    // Sauvegardes : une copie par jour de travail dans chacun de ces dossiers (desktop/backup.mjs).
    backupDirs: [
      path.join(app.getPath('documents'), 'PROJECTS', 'KILOSAURUS', 'Sauvegardes'),
      'G:\\Mon Drive\\KILOSAURUS\\Temps\\Sauvegardes',
    ],
  }, saved);
}

function saveSettings() {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings)); } catch (e) { /* non bloquant */ }
}

// Position gardée si elle est encore sur un écran (écran débranché, résolution changée) ; sinon le
// coin bas droit de l'écran principal.
function initialBounds() {
  const h = settings.height;
  if (Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
    const area = screen.getDisplayMatching({ x: settings.x, y: settings.y, width: WIDTH, height: h }).workArea;
    const inside = settings.x >= area.x && settings.x + WIDTH <= area.x + area.width
      && settings.y >= area.y && settings.y + h <= area.y + area.height;
    if (inside) return { x: settings.x, y: settings.y, width: WIDTH, height: h };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIDTH - MARGIN, y: wa.y + wa.height - h - MARGIN, width: WIDTH, height: h };
}

function createWindow() {
  win = new BrowserWindow(Object.assign(initialBounds(), {
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#131316',
    title: 'Kilosaurus Temps',
    icon: fs.existsSync(ICON) ? ICON : LOGO,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  }));
  applyOnTop();
  win.setMovable(!settings.locked);
  // Affichée dès que possible, et au plus tard après quelques secondes : au démarrage de Windows le
  // réseau peut manquer, la page ne se charge pas, et « ready-to-show » pourrait ne jamais venir.
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, SHOW_FALLBACK_MS);
  win.webContents.on('did-finish-load', () => win.webContents.send('locked', settings.locked));
  // Pas de réseau (démarrage, Wi-Fi qui se connecte) : nouvel essai jusqu'à ce que la page arrive.
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    log('chargement raté (' + code + ' ' + description + '), nouvel essai dans ' + RETRY_LOAD_MS / 1000 + ' s');
    setTimeout(() => { if (win) loadSite(); }, RETRY_LOAD_MS);
  });
  loadSite();
  // Réduite (bouton – de la page, Win+Bas…), la fenêtre a sa place dans la barre des tâches pour
  // qu'on puisse la rappeler ; revenue, elle la quitte et repasse au-dessus comme avant.
  win.on('minimize', () => win.setSkipTaskbar(false));
  win.on('restore', () => { win.setSkipTaskbar(true); applyOnTop(); });
  win.on('moved', () => {
    const b = win.getBounds();
    settings.x = b.x;
    settings.y = b.y;
    saveSettings();
  });
  // « Sessions » et « Tâches » ouvrent une deuxième fenêtre ; les autres liens (« Plus d'infos ») partent dans
  // Brave, version complète.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/[?&]vue=(sessions|taches)/.test(url)) openSideWindow(url);
    else openInBrowser(url.replace(/[?&]mini=1/, ''));
    return { action: 'deny' };
  });
}

// Brave s'il est installé, sinon Chrome, sinon le navigateur par défaut.
function openInBrowser(url) {
  const roots = [
    process.env['ProgramFiles'] || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    process.env.LOCALAPPDATA || '',
  ];
  const browsers = [
    ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ];
  const candidates = [];
  browsers.forEach((parts) => roots.forEach((root) => candidates.push(path.join(root, ...parts))));
  const exe = candidates.find((p) => fs.existsSync(p));
  if (!exe) { shell.openExternal(url); return; }
  require('child_process').spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref();
}

// La fenêtre latérale (sessions ou tâches, selon l'URL) : une fenêtre normale, au-dessus si la
// mini-fenêtre l'est. Une seule à la fois : demander l'autre vue la recharge. À sa fermeture, la
// mini-fenêtre relit l'état (une session corrigée, une tâche cochée s'y voit tout de suite).
function openSideWindow(url) {
  const title = (/[?&]vue=taches/.test(url) ? 'Tâches' : 'Sessions') + ' — Kilosaurus Temps';
  if (sideWin && !sideWin.isDestroyed()) {
    sideWin.setTitle(title);
    sideWin.loadURL(url);
    sideWin.show();
    sideWin.focus();
    return;
  }
  sideWin = new BrowserWindow({
    width: 400,
    height: 640,
    title,
    backgroundColor: '#131316',
    icon: fs.existsSync(ICON) ? ICON : LOGO,
    autoHideMenuBar: true,
    alwaysOnTop: settings.onTop,
  });
  sideWin.loadURL(url).catch((e) => log('fenêtre latérale : ' + e.message));
  sideWin.on('closed', () => {
    sideWin = null;
    if (win) win.webContents.executeJavaScript("window.dispatchEvent(new Event('online'))").catch(() => {});
  });
}

function loadSite() {
  win.loadURL(SITE + '?mini=1').catch(() => { /* signalé par did-fail-load */ });
}

// Sauvegarde : au lancement puis toutes les heures, jusqu'à ce que la copie du jour de travail soit
// dans tous les dossiers. Le code est celui que la page a gardé (code PC). Tout est noté dans
// desktop.log ; une panne se voit aussi dans l'app (bandeau), sur tous les appareils.
let backupRunning = false;
async function backupTick() {
  if (backupRunning || !win) return;
  backupRunning = true;
  try {
    const code = await win.webContents.executeJavaScript("localStorage.getItem('kt.code')");
    if (!code) { log('sauvegarde : pas de code, se connecter dans la mini-fenêtre'); return; }
    const { runBackup } = await import('./backup.mjs');
    const call = async (action, params = {}) => {
      const res = await fetch(SITE + 'api', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ code, action, ...params }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error.code + ' : ' + body.error.message);
      return body.data;
    };
    const r = await runBackup({ call, dirs: settings.backupDirs, log: (line) => log('sauvegarde ' + line) });
    log('sauvegarde ' + r.day + ' : ' + (r.status === 'done' ? 'complète' : 'incomplète, nouvel essai dans 1 h'));
  } catch (e) {
    log('sauvegarde ratée : ' + (e && e.message || e));
  } finally {
    backupRunning = false;
  }
}

function applyOnTop() {
  win.setAlwaysOnTop(settings.onTop, 'floating');
}

// La page donne la hauteur de son contenu ; la fenêtre s'y ajuste en gardant son bord haut en place :
// le contenu s'ouvre vers le bas, la barre du haut reste sous la souris. Si elle sortait de l'écran
// par le bas, elle remonte juste ce qu'il faut ; le haut choisi (settings.y, posé en la déplaçant)
// reste la référence, et elle y revient quand elle rapetisse.
// Écran zoomé (175 %…) : Windows arrondit la taille posée, getBounds() revient à 1 ou 2 px près.
// D'où la largeur toujours redemandée à WIDTH (repartir de getBounds() l'élargit à chaque appel) et
// la comparaison avec la dernière hauteur demandée (celle relue ne tombe jamais juste).
let fittedHeight = 0;
ipcMain.on('fit', (_e, height) => {
  if (!win) return;
  const h = Math.max(120, Math.min(900, Math.round(Number(height) || 0)));
  if (h === fittedHeight) return;
  fittedHeight = h;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const top = Number.isFinite(settings.y) ? settings.y : b.y;
  const y = Math.max(area.y, Math.min(top, area.y + area.height - h));
  win.setBounds({ x: b.x, y, width: WIDTH, height: h });
  settings.height = h;
  saveSettings();
});

ipcMain.on('minimize', () => {
  if (!win) return;
  win.setSkipTaskbar(false);
  win.minimize();
});

// Une fenêtre réduite revient à sa place (au lieu d'être masquée par le raccourci ou l'icône).
function showWindow() {
  if (win.isMinimized()) win.restore();
  win.show();
  applyOnTop();
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function applyAutostart() {
  // Lancement direct par electron.exe (sans installeur) : le chemin de l'app est passé en argument.
  app.setLoginItemSettings({
    openAtLogin: settings.autostart,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  });
}

// Au démarrage de Windows, la zone près de l'horloge peut ne pas être prête : nouvel essai.
function createTray(attempt = 1) {
  try {
    tray = new Tray(nativeImage.createFromPath(LOGO).resize({ width: 16, height: 16 }));
    tray.setToolTip('Kilosaurus Temps');
    tray.on('click', toggleVisible);
    buildMenu();
  } catch (e) {
    log('icône près de l\'horloge impossible (essai ' + attempt + ') : ' + e.message);
    if (attempt < 10) setTimeout(() => createTray(attempt + 1), 3000);
  }
}

function buildMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher / masquer (Ctrl+Alt+K)', click: toggleVisible },
    { type: 'separator' },
    {
      label: 'Verrouiller la position', type: 'checkbox', checked: settings.locked,
      click: (item) => {
        settings.locked = item.checked;
        win.setMovable(!settings.locked);
        win.webContents.send('locked', settings.locked);
        saveSettings();
      },
    },
    {
      label: 'Toujours au-dessus', type: 'checkbox', checked: settings.onTop,
      click: (item) => { settings.onTop = item.checked; applyOnTop(); saveSettings(); },
    },
    {
      label: 'Lancer au démarrage', type: 'checkbox', checked: settings.autostart,
      click: (item) => { settings.autostart = item.checked; applyAutostart(); saveSettings(); },
    },
    {
      label: 'Remettre dans le coin', click: () => {
        delete settings.x;
        delete settings.y;
        win.setBounds(initialBounds());
        saveSettings();
      },
    },
    { type: 'separator' },
    { label: 'Plus d’infos (Brave)', click: () => openInBrowser(SITE) },
    {
      label: 'Recharger (dernière version)', click: async () => {
        await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
        loadSite();
      },
    },
    { label: 'Quitter', click: () => app.quit() },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Un second lancement montre la fenêtre déjà ouverte au lieu d'en créer une autre.
  app.on('second-instance', () => { if (win) showWindow(); });

  app.whenReady().then(async () => {
    log('lancement (' + process.execPath + ')');
    // Le site s'installe en cache (service worker) et servirait sinon l'ancienne version jusqu'au
    // lancement suivant. Vidé à chaque lancement : toujours la dernière version. Le code et les
    // réglages (localStorage) sont gardés ; sans réseau, la fenêtre réessaie toute seule.
    try {
      await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    } catch (e) {
      log('cache non vidé : ' + e.message);
    }
    settings = loadSettings();
    createWindow();
    applyAutostart();
    createTray();
    setTimeout(backupTick, BACKUP_FIRST_MS);
    setInterval(backupTick, BACKUP_EVERY_MS);
    if (!globalShortcut.register(SHORTCUT, toggleVisible)) log('raccourci ' + SHORTCUT + ' déjà pris');
  });

  app.on('will-quit', () => { log('fermeture'); globalShortcut.unregisterAll(); });
  // La fenêtre masquée n'arrête pas l'app : elle vit dans l'icône près de l'horloge.
  app.on('window-all-closed', () => {});
}
