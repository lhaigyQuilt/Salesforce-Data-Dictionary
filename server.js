// Minimal static server so the dictionary can be hosted (Railway, Render, any
// PaaS that sets PORT). Node built-ins only — no dependencies to install.
//
// The page is served at / so the deployment URL works with no path.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const PAGE = 'salesforce-data-dictionary.html';

// Explicit allowlist — no path traversal is possible because nothing is
// resolved from the request. Anything not listed is a 404.
const ROUTES = {
  '/': [PAGE, 'text/html; charset=utf-8'],
  '/index.html': [PAGE, 'text/html; charset=utf-8'],
  ['/' + PAGE]: [PAGE, 'text/html; charset=utf-8'],
  '/changes.json': ['changes.json', 'application/json; charset=utf-8'],
  '/sbu_data.json': ['sbu_data.json', 'application/json; charset=utf-8'],
  '/xbu_data.json': ['xbu_data.json', 'application/json; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain' });
    return res.end('Method not allowed\n');
  }
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok\n');
  }

  const route = ROUTES[url];
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found. The dictionary is at /\n');
  }

  const [file, type] = route;
  const full = path.join(ROOT, file);
  let stat;
  try { stat = fs.statSync(full); }
  catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Missing ' + file + ' — the build did not include it.\n');
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Last-Modified': stat.mtime.toUTCString(),
    // The page embeds its own gzipped payload, so it is already compact;
    // a short cache keeps a refresh visible within the day.
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Salesforce data dictionary listening on 0.0.0.0:' + PORT);
});
