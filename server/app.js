// HTTP server: static files from public/ (only Node built-ins, no dependencies),
// plus the WebSocket endpoint /ws that shared sessions run over.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade, rejectUpgrade } from './ws.js';
import { Hub } from './hub.js';

const ROOT = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const HEARTBEAT_MS = 30_000;

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

/**
 * A browser always sends Origin on a WebSocket handshake. Requiring it to match the
 * Host stops other web pages from opening sockets here with a visitor's browser
 * (cross-site WebSocket hijacking). Non-browser clients may leave it out.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createAppServer({ hub = new Hub() } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const rel = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^[/\\]+/, '');
      const file = join(ROOT, rel);
      if (file !== ROOT && !file.startsWith(ROOT + sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES.get(extname(file)) || 'application/octet-stream',
        'Cache-Control': 'no-store',
        // 'self' covers ws:/wss: to this same host in current browsers (CSP Level 3).
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let path;
    try {
      path = new URL(req.url, 'http://x').pathname;
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (path !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    if (!sameOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    const ws = acceptUpgrade(req, socket, head, { maxPayload: 16 * 1024 });
    if (ws) hub.connect(ws);
  });

  const timer = setInterval(() => hub.heartbeat(), HEARTBEAT_MS);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  server.hub = hub;
  return server;
}
