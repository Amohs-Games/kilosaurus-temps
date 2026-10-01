// Faux serveur de dev : sert web/ et répond sur /api avec le vrai Core.gs et une Sheet en mémoire.
//
//   node tools/fake-api.js [--port 8787] [--forgot]
//
// Codes : code-amohs, code-alex, code-sam, code-alex-claude (agent).
// --forgot : Amohs a un compteur lancé il y a 9 h (pour voir le garde-fou).
// --api-url <url> : URL d'API donnée à l'app (par défaut /api), pour simuler une mauvaise config.
// Ouvrir http://localhost:8787/?dev-code=code-amohs pour être connecté directement,
// ou /__phone?dev-code=code-amohs pour voir l'app dans un cadre de téléphone (375 px).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadCore, MemoryStore, tz } = require('../tests/harness');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8787;
const WEB = path.join(__dirname, '..', 'web');
const API_URL = args.includes('--api-url') ? args[args.indexOf('--api-url') + 1] : '/api';
const Core = loadCore();

const store = new MemoryStore();
for (const name of ['Heirfall', 'Proto', 'Jam']) store.createProject(name);
store.insert('Fluffy', {
  id: 'seed-1', person: 'Amohs', date: tz.dayStart(tz.dayKey(new Date(Date.now() - 86400000))), start: '', end: '',
  hours: 8, note: '', source: 'app', created: new Date(Date.now() - 3600000), corrected: '', touched: new Date(Date.now() - 3600000),
});
if (args.includes('--forgot')) {
  const start = new Date(Date.now() - 9 * 3600000);
  store.insert('Fluffy', {
    id: 'seed-2', person: 'Amohs', date: tz.dayStart(tz.dayKey(start)), start, end: '', hours: '', note: '',
    source: 'app', created: start, corrected: '', touched: start,
  });
}

const CODES = {
  'code-amohs': { person: 'Amohs', agent: false },
  'code-alex': { person: 'Alex', agent: false },
  'code-sam': { person: 'Sam', agent: false },
  'code-alex-claude': { person: 'Alex', agent: true },
};
const env = { store, now: () => new Date(), tz, auth: (code) => CODES[code] || null };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const DEV_CONFIG = `window.KT_API_URL = ${JSON.stringify(API_URL)};
(function () {
  var code = new URLSearchParams(location.search).get('dev-code');
  if (code) localStorage.setItem('kt.code', code);
})();`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let out;
      try { out = Core.handleRequest(env, JSON.parse(body)); } catch (e) { out = { ok: false, error: { code: 'invalid', message: 'Corps JSON non valide.' } }; }
      if (out.ok || out.error.code !== 'unauthorized') console.log(JSON.parse(body).action, out.ok ? 'ok' : out.error.message);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__phone') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<body style="margin:0;background:#888"><iframe src="/' + url.search + '" style="width:375px;height:812px;border:0;display:block"></iframe></body>');
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(DEV_CONFIG);
  }
  const file = path.join(WEB, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Faux serveur : http://localhost:${port}/?dev-code=code-amohs`));
