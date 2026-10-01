// Mini-fenêtre de bureau : le site en version compacte (?mini=1) dans une petite fenêtre sans
// bordure, dans un coin, au-dessus de tout, lancée au démarrage de Windows.
//
//   cd desktop && npm install && npm start
//
// Icône près de l'horloge : afficher / masquer, verrouiller la position, toujours au-dessus, lancer
// au démarrage, ouvrir en grand, quitter. Ctrl + Alt + K affiche ou masque la fenêtre.
// Les réglages (position, verrou…) sont gardés dans window.json, dans le dossier de l'app.
const { app, BrowserWindow, Tray, Menu, screen, shell, nativeImage, ipcMain, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const SITE = 'https://amohs-games.github.io/kilosaurus-temps/';
const WIDTH = 300;
const MARGIN = 12;
const SHORTCUT = 'Control+Alt+K';
const LOGO = path.join(__dirname, '..', 'kilo_logo.png');

let win = null;
let tray = null;
let settings = null;

const settingsPath = () => path.join(app.getPath('userData'), 'window.json');

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
    icon: LOGO,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  }));
  applyOnTop();
  win.setMovable(!settings.locked);
  win.loadURL(SITE + '?mini=1');
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => win.webContents.send('locked', settings.locked));
  win.on('moved', () => {
    const b = win.getBounds();
    settings.x = b.x;
    settings.y = b.y;
    saveSettings();
  });
  // Les liens qui ouvrent une fenêtre (« ouvrir en grand ») partent dans le navigateur.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
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
    { label: 'Ouvrir en grand', click: () => shell.openExternal(SITE) },
    { label: 'Recharger', click: () => win.reload() },
    { label: 'Quitter', click: () => app.quit() },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Un second lancement montre la fenêtre déjà ouverte au lieu d'en créer une autre.
  app.on('second-instance', () => { if (win) { win.show(); applyOnTop(); } });

  app.whenReady().then(() => {
    settings = loadSettings();
    createWindow();
    applyAutostart();
    tray = new Tray(nativeImage.createFromPath(LOGO).resize({ width: 16, height: 16 }));
    tray.setToolTip('Kilosaurus Temps');
    tray.on('click', toggleVisible);
    buildMenu();
    globalShortcut.register(SHORTCUT, toggleVisible);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  // La fenêtre masquée n'arrête pas l'app : elle vit dans l'icône près de l'horloge.
  app.on('window-all-closed', () => {});
}
