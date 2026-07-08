'use strict';
// HTTP server (static client + account REST API) and the Colyseus
// game server (matchmaking + realm room) attached on top of it.
const http = require('http');
const fs = require('fs');
const path = require('path');
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
      return fs.readFile(path.join(PUBLIC, 'profile.html'), (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
    }
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
