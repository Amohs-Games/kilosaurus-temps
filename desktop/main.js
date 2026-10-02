// Mini-fenêtre de bureau : le site en version compacte (?mini=1) dans une petite fenêtre sans
// bordure, dans un coin, au-dessus de tout, lancée au démarrage de Windows.
//
//   cd desktop && npm install && npm start
//
// Icône près de l'horloge : afficher / masquer, verrouiller la position, toujours au-dessus, lancer
// au démarrage, ouvrir en grand, quitter. Ctrl + Alt + K affiche ou masque la fenêtre.
// Les réglages (position, verrou…) sont gardés dans window.json, dans le dossier de l'app.
const { app, BrowserWindow, Tray, Menu, screen, shell, nativeImage, ipcMain, globalShortcut, session } = require('electron');
const fs = require('fs');
const path = require('path');

const SITE = 'https://amohs-games.github.io/kilosaurus-temps/';
const WIDTH = 300;
const MARGIN = 12;
const SHORTCUT = 'Control+Alt+K';
const LOGO = path.join(__dirname, '..', 'kilo_logo.png');
const ICON = path.join(__dirname, 'icon.ico');
const SHOW_FALLBACK_MS = 4000;
const RETRY_LOAD_MS = 10000;

let win = null;
let tray = null;
let settings = null;

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
  return Object.assign({ locked: false, onTop: true, autostart: true, height: 360 }, saved);
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
    minimizable: false,
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
  win.on('moved', () => {
    const b = win.getBounds();
    settings.x = b.x;
    settings.y = b.y;
    saveSettings();
  });
  // Les liens qui ouvrent une fenêtre (« Plus d'infos ») partent dans Chrome, version complète.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInChrome(url.replace(/[?&]mini=1/, ''));
    return { action: 'deny' };
  });
}

// Chrome s'il est installé, sinon le navigateur par défaut.
function openInChrome(url) {
  const candidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const chrome = candidates.find((p) => fs.existsSync(p));
  if (!chrome) { shell.openExternal(url); return; }
  require('child_process').spawn(chrome, [url], { detached: true, stdio: 'ignore' }).unref();
}

function loadSite() {
  win.loadURL(SITE + '?mini=1').catch(() => { /* signalé par did-fail-load */ });
}

function applyOnTop() {
  win.setAlwaysOnTop(settings.onTop, 'floating');
}

// La page donne la hauteur de son contenu ; la fenêtre s'y ajuste en gardant son bord bas en place
// (posée dans un coin bas, elle grandit vers le haut).
ipcMain.on('fit', (_e, height) => {
  if (!win) return;
  const h = Math.max(120, Math.min(900, Math.round(Number(height) || 0)));
  const b = win.getBounds();
  if (b.height === h) return;
  win.setBounds({ x: b.x, y: b.y + b.height - h, width: b.width, height: h });
  settings.height = h;
  settings.y = b.y + b.height - h;
  saveSettings();
});

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.show(); applyOnTop(); }
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
    { label: 'Plus d’infos (Chrome)', click: () => openInChrome(SITE) },
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
  app.on('second-instance', () => { if (win) { win.show(); applyOnTop(); } });

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
    if (!globalShortcut.register(SHORTCUT, toggleVisible)) log('raccourci ' + SHORTCUT + ' déjà pris');
  });

  app.on('will-quit', () => { log('fermeture'); globalShortcut.unregisterAll(); });
  // La fenêtre masquée n'arrête pas l'app : elle vit dans l'icône près de l'horloge.
  app.on('window-all-closed', () => {});
}
