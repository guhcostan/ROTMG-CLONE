'use strict';
// HTTP server (static client + account REST API) and the Colyseus
// game server (matchmaking + realm room) attached on top of it.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const auth = require('./auth');
const { Game, ACHIEVEMENTS } = require('./game');
const { RealmRoom } = require('./room');
const { CLASSES, ITEMS } = require('./data');
const storage = require('./db');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);

// a lost heartbeat mustn't take the whole shard down with it
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

const game = new Game();
const startedAt = Date.now();

// ---------------- static file cache (content + gzip, keyed by mtime)
const fileCache = new Map(); // full path -> { mtimeMs, data, gz, type }
function loadStatic(full) {
  let stat;
  try { stat = fs.statSync(full); } catch { return null; }
  if (!stat.isFile()) return null;
  let entry = fileCache.get(full);
  if (!entry || entry.mtimeMs !== stat.mtimeMs) {
    const data = fs.readFileSync(full);
    const ext = path.extname(full);
    entry = {
      mtimeMs: stat.mtimeMs, data,
      type: MIME[ext] || 'application/octet-stream',
      gz: COMPRESSIBLE.has(ext) ? zlib.gzipSync(data, { level: 9 }) : null,
    };
    fileCache.set(full, entry);
  }
  return entry;
}

function serveStatic(req, res, full, cacheControl) {
  const entry = loadStatic(full);
  if (!entry) { res.writeHead(404); return res.end('not found'); }
  const headers = { 'Content-Type': entry.type, 'Cache-Control': cacheControl };
  const acceptsGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (entry.gz && acceptsGz) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    return res.end(entry.gz);
  }
  res.writeHead(200, headers);
  res.end(entry.data);
}

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
    // ---------------- health (load balancers / uptime monitors)
    if (p === '/health') {
      return json(res, 200, {
        ok: true,
        online: game.players.size,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        tick: game.tickStats, // avg/max simulation ms over the last ~10s window
      });
    }
    // ---------------- API
    if ((p === '/api/register' || p === '/api/login') && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '?';
      if (auth.throttled(ip)) return json(res, 429, { error: 'Muitas tentativas, aguarde alguns minutos' });
      const { username, password } = await readBody(req);
      const r = p === '/api/register' ? await auth.register(username, password) : await auth.login(username, password);
      return json(res, r.error ? 400 : 200, r);
    }
    if (p === '/api/leaderboard' && req.method === 'GET') {
      return json(res, 200, {
        alive: storage.leaderboard(),
        legends: storage.legends(),
        online: game.players.size,
      });
    }
    if (p === '/api/season' && req.method === 'GET') {
      return json(res, 200, game.seasonInfo());
    }
    if (p === '/api/speedrun' && req.method === 'GET') {
      const dungeon = url.searchParams.get('dungeon') || '';
      return json(res, 200, { dungeon, times: storage.topDungeonTimes(dungeon) });
    }
    if (p === '/api/pass') {
      const acc = auth.authed(req.headers['x-token']);
      if (!acc) return json(res, 401, { error: 'Sessao invalida' });
      if (req.method === 'GET') return json(res, 200, game.passInfo(acc.id));
      if (req.method === 'POST') {
        const { tier } = await readBody(req);
        const r = game.claimPass(acc.id, tier);
        return json(res, r.error ? 400 : 200, r.error ? r : r.info);
      }
    }
    if (p === '/api/cosmetics') {
      const acc = auth.authed(req.headers['x-token']);
      if (!acc) return json(res, 401, { error: 'Sessao invalida' });
      if (req.method === 'GET') return json(res, 200, game.cosmeticsFor(acc.id));
      if (req.method === 'POST') {
        const { title, color, skin } = await readBody(req);
        const ok = game.setCosmetic(acc.id, title || null, color || null, skin || null);
        return json(res, ok ? 200 : 400, ok ? game.cosmeticsFor(acc.id) : { error: 'Cosmetico nao desbloqueado' });
      }
    }
    if (p.startsWith('/api/chars')) {
      const acc = auth.authed(req.headers['x-token']);
      if (!acc) return json(res, 401, { error: 'Sessao invalida' });
      if (req.method === 'GET') {
        const unlocked = auth.unlockedClasses(acc.id);
        const classMeta = {};
        for (const [id, c] of Object.entries(CLASSES)) {
          classMeta[id] = {
            name: c.name, weapon: c.weapon, ability: c.ability, armor: c.armor, base: c.base,
            locked: !unlocked.has(id),
            unlock: c.unlock || null,
            unlockName: c.unlock ? CLASSES[c.unlock].name : null,
          };
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
          achievements: (() => {
            const earned = new Set(storage.listAchievements(acc.id));
            return Object.entries(ACHIEVEMENTS).map(([code, a]) => ({ code, name: a.name, earned: earned.has(code) }));
          })(),
          bounties: game.getDailyBounties(acc.id),
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
    if (p === '/api/profile' && req.method === 'GET') {
      const acc = storage.getAccountByName(url.searchParams.get('name') || '');
      if (!acc) return json(res, 404, { error: 'Jogador nao encontrado' });
      const earned = new Set(storage.listAchievements(acc.id));
      return json(res, 200, {
        username: acc.username,
        title: acc.title || null, nameColor: acc.name_color || null,
        bestFame: storage.bestFame(acc.id),
        characters: storage.listChars(acc.id).map(c => ({ classId: c.classId, className: CLASSES[c.classId] ? CLASSES[c.classId].name : c.classId, level: c.level, fame: c.fame })),
        graveyard: storage.listGraves(acc.id).map(g => ({ classId: g.class_id, level: g.level, fame: g.fame, killedBy: g.killed_by, diedAt: g.died_at })),
        achievements: Object.entries(ACHIEVEMENTS).filter(([c]) => earned.has(c)).map(([, a]) => a.name),
        seasonFame: storage.seasonFameOf(acc.id, game.season),
      });
    }

    // ---------------- static files
    // public shareable profile pages: /u/<name> -> profile.html (client fetches /api/profile)
    if (p.startsWith('/u/')) {
      return serveStatic(req, res, path.join(PUBLIC, 'profile.html'), 'no-cache');
    }
    // index.html: absolutize the og:image URL from the request host so link
    // previews (WhatsApp/Discord scrapers need absolute URLs) work on any domain
    if (p === '/' || p === '/index.html') {
      const entry = loadStatic(path.join(PUBLIC, 'index.html'));
      if (!entry) { res.writeHead(404); return res.end('not found'); }
      const proto = (req.headers['x-forwarded-proto'] || '').includes('https') ? 'https' : 'http';
      const host = String(req.headers.host || `localhost:${PORT}`).replace(/[^a-zA-Z0-9.:\-\[\]]/g, '');
      const html = entry.data.toString().replace('content="/og.jpg"', `content="${proto}://${host}/og.jpg"`);
      const headers = { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' };
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        return res.end(zlib.gzipSync(html));
      }
      res.writeHead(200, headers);
      return res.end(html);
    }
    let file = p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    // vendored libs and fonts never change without a redeploy; html must revalidate
    const cacheControl =
      file.startsWith(path.sep + 'vendor') || file.startsWith(path.sep + 'fonts')
        ? 'public, max-age=604800, immutable'
        : path.extname(full) === '.html' ? 'no-cache' : 'public, max-age=300';
    return serveStatic(req, res, full, cacheControl);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Erro interno' });
  }
});

// ---------------- colyseus game server
// The transport reuses the HTTP server above; Colyseus wraps its request
// listener so /matchmake/* is answered by the matchmaker and everything
// else falls through to the static/API handler.
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
  greet: false,
});
gameServer.define('realm', RealmRoom, { game });
gameServer.onShutdown(() => {
  try { game.autosave(); } catch {}
  storage.close();
});

gameServer.listen(PORT).then(() => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
