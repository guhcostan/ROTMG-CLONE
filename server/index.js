'use strict';
// HTTP server (static client + account REST API) and the WebSocket
// game endpoint.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const { Game } = require('./game');
const { CLASSES, ITEMS } = require('./data');
const storage = require('./db');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

const game = new Game();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function charSummary(ch) {
  return {
    id: ch.id, classId: ch.classId, className: CLASSES[ch.classId].name,
    level: ch.level, fame: ch.fame, stats: ch.stats,
    equipment: ch.equipment,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // ---------------- API
    if ((p === '/api/register' || p === '/api/login') && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '?';
      if (auth.throttled(ip)) return json(res, 429, { error: 'Muitas tentativas, aguarde alguns minutos' });
      const { username, password } = await readBody(req);
      const r = p === '/api/register' ? auth.register(username, password) : auth.login(username, password);
      return json(res, r.error ? 400 : 200, r);
    }
    if (p === '/api/leaderboard' && req.method === 'GET') {
      return json(res, 200, {
        alive: storage.leaderboard(),
        legends: storage.legends(),
        online: game.players.size,
      });
    }
    if (p.startsWith('/api/chars')) {
      const acc = auth.authed(req.headers['x-token']);
      if (!acc) return json(res, 401, { error: 'Sessao invalida' });
      if (req.method === 'GET') {
        const classMeta = {};
        for (const [id, c] of Object.entries(CLASSES)) {
          classMeta[id] = { name: c.name, weapon: c.weapon, ability: c.ability, armor: c.armor, base: c.base };
        }
        return json(res, 200, {
          username: acc.username,
          characters: storage.listChars(acc.id).map(charSummary),
          graveyard: storage.listGraves(acc.id).map(g => ({
            classId: g.class_id, level: g.level, fame: g.fame,
            killedBy: g.killed_by, diedAt: g.died_at,
          })),
          maxChars: auth.MAX_CHARS,
          classes: classMeta,
        });
      }
      if (req.method === 'POST') {
        const { classId } = await readBody(req);
        const r = auth.createCharacter(acc, classId);
        return json(res, r.error ? 400 : 200, r.error ? r : { character: charSummary(r.character) });
      }
      if (req.method === 'DELETE') {
        const id = parseInt(p.split('/')[3], 10);
        const r = auth.deleteCharacter(acc, id);
        return json(res, r.error ? 400 : 200, r);
      }
    }
    if (p === '/api/items' && req.method === 'GET') {
      // client needs item metadata for rendering/tooltips
      return json(res, 200, ITEMS);
    }

    // ---------------- static files
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Erro interno' });
  }
});

// ---------------- websocket game endpoint
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const acc = auth.authed(url.searchParams.get('token'));
  const charId = parseInt(url.searchParams.get('char'), 10);
  if (!acc) { ws.close(4001, 'unauthorized'); return; }
  const char = storage.getChar(charId, acc.id);
  if (!char) { ws.close(4002, 'no character'); return; }
  // one connection per character
  for (const p of game.players.values()) {
    if (p.char.id === charId) { ws.close(4003, 'already playing'); return; }
  }

  const player = game.joinPlayer(ws, acc, char);
  console.log(`[+] ${acc.username} entrou (${CLASSES[char.classId].name} nv ${char.level})`);

  ws.on('message', (raw) => {
    if (raw.length > 2000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { game.handle(player, msg); } catch (e) { console.error('handle error:', e); }
  });
  ws.on('close', () => {
    game.leavePlayer(player);
    console.log(`[-] ${acc.username} saiu`);
  });
  ws.on('error', () => {});
});

function shutdown() {
  try { game.autosave(); } catch {}
  storage.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
