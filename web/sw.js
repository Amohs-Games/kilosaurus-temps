// Service worker : l'app s'ouvre même sans réseau, mais affiche toujours la dernière version.
// Réseau d'abord : chaque fichier de l'app est redemandé au serveur (en revalidant le cache HTTP de
// GitHub Pages, qui garde sinon les fichiers 10 min) ; la copie locale ne sert que hors ligne.
// Les appels à l'API (autre domaine) ne passent jamais par ici.
var CACHE = 'kt-v12';
var SHELL = [
  './', 'index.html', 'style.css', 'config.js', 'logic.js', 'app.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'no-cache' }); }));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(function () {
      return cache.match(req, { ignoreSearch: true });
    });
  }));
});
