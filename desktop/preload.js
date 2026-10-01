// Pont entre la page (web/app.js, version ?mini=1) et la fenêtre : la page donne la hauteur de son
// contenu, la fenêtre lui dit si elle est verrouillée (la barre du haut ne la déplace plus).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ktDesktop', {
  fit: (height) => ipcRenderer.send('fit', height),
  onLocked: (callback) => ipcRenderer.on('locked', (_e, locked) => callback(locked)),
});
