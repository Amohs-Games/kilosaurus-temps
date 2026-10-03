// Serveur de dev : sert web/ et répond sur /api avec le vrai server/core.js sur un SQLite en mémoire.
//
//   node tools/dev-server.mjs [--port 8787] [--forgot] [--api-url <url>]
//
// Codes : code-amohs, code-amohs-claude (agent).
// --forgot : un compteur lancé il y a 9 h (pour voir le garde-fou).
// --api-url <url> : URL d'API donnée à l'app (par défaut /api), pour simuler une mauvaise config.
// Ouvrir http://localhost:8787/?dev-code=code-amohs pour être connecté directement,
// ou /__phone?dev-code=code-amohs pour voir l'app dans un cadre de téléphone (375 px).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fromSqlite } from '../server/db.js';
import { handleRequest } from '../server/core.js';
import { dayKey } from '../server/tz.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8787;
const API_URL = args.includes('--api-url') ? args[args.indexOf('--api-url') + 1] : '/api';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));
['Fluffy', 'Studio', 'Heirfall', 'Proto', 'Jam'].forEach((name, i) => sqlite.prepare('INSERT INTO projects (name, position) VALUES (?, ?)').run(name, i + 1));
for (const [key, value] of Object.entries({ me: 'Amohs', studio: 'Studio', visible: '4', threshold: '8' })) {
  sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
const seed = sqlite.prepare('INSERT INTO entries (id, project, kind, day, start_ms, end_ms, hours, type, note, source, created_ms, touched_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const now = Date.now();
seed.run('seed-1', 'Fluffy', 'block', dayKey(now - 86400000), null, null, 8, 'Misc', '', 'app', now - 3600000, now - 3600000);
if (args.includes('--forgot')) {
  const start = now - 9 * 3600000;
  seed.run('seed-2', 'Fluffy', 'session', dayKey(start), start, null, null, 'Misc', '', 'app', start, start);
}

const CODES = { 'code-amohs': { agent: false }, 'code-amohs-claude': { agent: true } };
const env = { db: fromSqlite(sqlite), now: () => Date.now(), auth: (code) => CODES[code] || null };

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
    req.on('end', async () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { /* signalé ci-dessous */ }
      const out = parsed ? await handleRequest(env, parsed) : { ok: false, error: { code: 'invalid', message: 'Corps JSON non valide.' } };
      if (parsed && (out.ok || out.error.code !== 'unauthorized')) console.log(parsed.action, out.ok ? 'ok' : out.error.message);
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
}).listen(port, () => console.log(`Serveur de dev : http://localhost:${port}/?dev-code=code-amohs`));
