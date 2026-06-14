'use strict';
// End-to-end smoke test: boots the server, exercises accounts, characters,
// gameplay protocol, vault, trade, guilds, leaderboard and verifies that
// data persists in SQLite across a server restart.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 18099;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rotmg-test-'));
// in-process unit checks (below) boot a Game -> point their SQLite at the temp dir too
process.env.DATA_DIR = DATA_DIR;
let failures = 0;

function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

// pure data/engine checks that don't need the network server
function dataSanity() {
  const { ENEMIES, DUNGEONS, ITEMS, LEGENDARIES } = require('../server/data');
  const bad = [];
  for (const id of LEGENDARIES) if (!ITEMS[id]) bad.push(`legendary ${id} missing`);
  for (const [id, e] of Object.entries(ENEMIES)) {
    for (const [spec] of e.loot || []) {
      if (spec === 'statpot' || spec === 'legendary') continue;
      if (spec.startsWith('weapon:') || spec.startsWith('armor:')) continue;
      if (spec.startsWith('portal:')) {
        if (!DUNGEONS[spec.slice(7)]) bad.push(`${id}: portal ${spec}`);
      } else if (!ITEMS[spec]) bad.push(`${id}: item ${spec}`);
    }
    if (e.spawns && !ENEMIES[e.spawns.type]) bad.push(`${id}: spawns ${e.spawns.type}`);
    if (e.entourage && !ENEMIES[e.entourage.type]) bad.push(`${id}: entourage ${e.entourage.type}`);
  }
  for (const [key, d] of Object.entries(DUNGEONS)) {
    if (!ENEMIES[d.boss]) bad.push(`${key}: boss ${d.boss}`);
    for (const m of d.minions) if (!ENEMIES[m]) bad.push(`${key}: minion ${m}`);
  }
  check(bad.length === 0, 'data refs consistent' + (bad.length ? ' -> ' + bad.join(', ') : ''));

  // every realm mob shoots, and band damage rises outward->inward (easy beach, hard center)
  const realmMobs = Object.values(ENEMIES).filter(e => e.band >= 0);
  check(realmMobs.every(e => e.shots), 'every realm mob has a shot attack');
  const bandDmg = b => Math.max(...realmMobs.filter(e => e.band === b).map(e => e.shots.dmg));
  check(bandDmg(0) < bandDmg(1) && bandDmg(1) < bandDmg(2) && bandDmg(2) < bandDmg(3) && bandDmg(3) < bandDmg(4),
    'band damage rises from beach to center');
}

function realmCycleSanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  const oldRealm = g.realm;
  g.closeRealm();
  check(g.realm !== oldRealm && g.realm.kind === 'realm' && g.realm.enemies.size > 0, 'realm regenerates after closing');
  check([...g.instances.values()].some(i => i.kind === 'dungeon' && i.name === 'Castelo do Rei Demente'), 'mad castle created on realm close');
  check(!g.instances.has(oldRealm.id), 'old realm removed');
  const lead = g.spawnEnemy(g.realm, 'wolf_alpha', g.realm.map.center.x, g.realm.map.center.y);
  const pack = [...g.realm.enemies.values()].filter(e => e.parentId === lead.id);
  check(pack.length === 4, 'mini-boss spawns with escort pack');

  // defeating the Mad King opens a secret portal to the Tyrant's Sanctum
  const castle = [...g.instances.values()].find(i => i.name === 'Castelo do Rei Demente');
  const king = [...castle.enemies.values()].find(e => e.type === 'mad_king');
  king.hp = 1;
  g.damageEnemy(castle, king, 9999, { id: -1, char: { fame: 0 } });
  check([...castle.portals.values()].some(p => p.dungeon === 'tyrant_sanctum'), 'mad king death opens tyrant portal');

  // expose makes an enemy take more damage
  const dummy = g.spawnEnemy(g.realm, 'goblin', 5, 5);
  dummy.exposedUntil = Date.now() + 2000;
  const before = dummy.hp;
  g.damageEnemy(g.realm, dummy, 100, { id: -2, char: { fame: 0 } });
  check(before - dummy.hp > 100, 'expose increases damage taken');
}

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'X-Token': token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function startServer() {
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT, DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(d));
  return new Promise((res, rej) => {
    server.stdout.on('data', d => { if (String(d).includes('Servidor rodando')) res(server); });
    server.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server start timeout')), 8000);
  });
}

function client(token, charId) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}&char=${charId}`);
  const messages = [];
  ws.on('message', d => messages.push(JSON.parse(d)));
  const waitFor = (type, timeout = 5000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = messages.find(x => x.t === type);
      if (m) { clearInterval(iv); res(m); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('timeout waiting ' + type)); }
    }, 30);
  });
  const sendMsg = (m) => ws.send(JSON.stringify(m));
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return { ws, messages, waitFor, sendMsg, opened };
}

async function walkTo(c, fromX, fromY, toX, toY) {
  let px = fromX, py = fromY;
  for (let i = 0; i < 300; i++) {
    const dx = toX - px, dy = toY - py;
    const d = Math.hypot(dx, dy);
    if (d < 0.8) break;
    const step = Math.min(0.25, d);
    px += (dx / d) * step; py += (dy / d) * step;
    c.sendMsg({ t: 'move', x: px, y: py });
    await new Promise(r => setTimeout(r, 35));
  }
  return { x: px, y: py };
}

// status effects + fame-bonus math, exercised directly on the engine
function statusAndFameSanity() {
  const { Game } = require('../server/game');
  const { CLASSES } = require('../server/data');
  const g = new Game();
  // fake a player object good enough for the helpers under test
  const cls = CLASSES.warrior;
  const player = {
    id: 999, instance: g.realm, char: {
      classId: 'warrior', level: 20, fame: 100,
      stats: Object.assign({}, cls.max), // all stats maxed
      equipment: ['sword_kings', 'helm0', 'heavy0', 'ringking'],
    },
    status: {}, kills: 55, godsKilled: 3, dungeons: 2,
    ws: { readyState: 3, send() {} }, x: 10, y: 10, dead: false,
  };
  g.applyStatus(player, 'slow', 1000);
  check(player.status.slow > Date.now(), 'applyStatus sets a timed status');
  check(g.activeStatus(player).slow > 0, 'activeStatus reports remaining time');
  g.applyStatus(player, 'bogus', 1000);
  check(!player.status.bogus, 'unknown status types are rejected');
  g.cleanseStatus(player);
  check(Object.keys(g.activeStatus(player)).length === 0, 'cleanse clears all statuses');

  const bonuses = g.fameBonuses(player);
  const byLabel = Object.fromEntries(bonuses.map(b => [b.label, b.value]));
  check(byLabel['Matador'] === 5, 'kill fame bonus (55 kills -> +5)');
  check(byLabel['Inimigo dos Deuses'] === 30, 'god-kill fame bonus (3 -> +30)');
  check(byLabel['Explorador de Masmorras'] === 30, 'dungeon fame bonus (2 -> +30)');
  check(byLabel['Atributos no Maximo'] === 160, 'maxed-stat fame bonus (8 -> +160)');
  check(byLabel['Nivel Maximo'] === 25, 'max-level fame bonus');
  check(byLabel['Bem Equipado'] >= 8, 'high-tier equip fame bonus');
}

async function main() {
  dataSanity();
  realmCycleSanity();
  statusAndFameSanity();
  let server = await startServer();
  const user1 = 'alpha' + Math.floor(Math.random() * 1e6);
  const user2 = 'beta' + Math.floor(Math.random() * 1e6);

  try {
    // --- accounts
    let r = await api('POST', '/api/register', { username: user1, password: 'senha123' });
    check(r.status === 200 && r.data.token, 'register returns token');
    let token1 = r.data.token;

    r = await api('POST', '/api/register', { username: user1, password: 'senha123' });
    check(r.status === 400, 'duplicate username rejected');

    r = await api('POST', '/api/login', { username: user1, password: 'errada' });
    check(r.status === 400, 'wrong password rejected');

    r = await api('POST', '/api/register', { username: user2, password: 'senha123' });
    const token2 = r.data.token;
    check(r.status === 200, 'second account registered');

    // --- characters
    r = await api('GET', '/api/chars', null, token1);
    check(r.status === 200 && r.data.characters.length === 0, 'char list starts empty');
    check(Object.keys(r.data.classes).length === 12, 'twelve classes available');
    check(r.data.classes.wizard.locked === false, 'starter class wizard unlocked');
    check(r.data.classes.necromancer.locked === true, 'advanced class necromancer locked initially');
    check(r.data.classes.necromancer.unlockName === 'Wizard', 'necromancer shows its unlock requirement');
    check(r.data.classes.samurai.locked === true && r.data.classes.samurai.unlockName === 'Knight', 'samurai locked behind Knight');

    r = await api('POST', '/api/chars', { classId: 'wizard' }, token1);
    check(r.status === 200 && r.data.character.classId === 'wizard', 'create wizard');
    const char1 = r.data.character.id;

    // locked class cannot be created yet
    r = await api('POST', '/api/chars', { classId: 'necromancer' }, token1);
    check(r.status === 400, 'creating a locked class is rejected');

    // reaching level 20 with the prerequisite unlocks the advanced class
    const storage = require('../server/db');
    const acc1 = storage.getAccountByName(user1);
    storage.bury(acc1.id, { id: -1, classId: 'wizard', level: 20, fame: 500 }, 'aposentadoria');
    r = await api('GET', '/api/chars', null, token1);
    check(r.data.classes.necromancer.locked === false, 'necromancer unlocks after maxing Wizard');
    r = await api('POST', '/api/chars', { classId: 'necromancer' }, token1);
    check(r.status === 200 && r.data.character.classId === 'necromancer', 'can create unlocked necromancer');
    // remove it again so later restart checks still see a single character
    await api('DELETE', `/api/chars/${r.data.character.id}`, null, token1);

    r = await api('POST', '/api/chars', { classId: 'knight' }, token2);
    const char2 = r.data.character.id;
    check(r.status === 200, 'create knight on second account');

    r = await api('GET', '/api/items', null);
    check(r.status === 200 && r.data.staff0 && r.data.pet_egg, 'item metadata served');

    r = await api('GET', '/api/leaderboard', null);
    check(r.status === 200 && Array.isArray(r.data.alive), 'leaderboard endpoint');

    // --- gameplay: two clients in the nexus
    const c1 = client(token1, char1);
    const c2 = client(token2, char2);
    await c1.opened; await c2.opened;

    const w1 = await c1.waitFor('world');
    const w2 = await c2.waitFor('world');
    check(w1.kind === 'nexus' && w2.kind === 'nexus', 'both spawned in nexus');
    const tiles = Buffer.from(w1.tiles, 'base64');
    check(tiles.length === w1.w * w1.h, 'map tile payload complete');

    const t1 = await c1.waitFor('tick');
    check(t1.self.hp === 100 && t1.self.level === 1, 'self stats in snapshot');
    check(t1.e.filter(e => e[0] === 'p').length === 2, 'both players visible to each other');
    check(t1.e.some(e => e[0] === 'o' && e[2] === 'realm'), 'realm portal in nexus');
    check(t1.e.some(e => e[0] === 'v'), 'vault chest in nexus');

    // --- vault: walk to chest, deposit a starter item, withdraw it back
    const vaultEnt = t1.e.find(e => e[0] === 'v');
    // give the wizard something tradable: drop nothing, use equipment slot? deposit needs inventory.
    // move weapon to inventory first
    c1.sendMsg({ t: 'invswap', from: 0, to: 4 });
    await walkTo(c1, w1.x, w1.y, vaultEnt[2], vaultEnt[3]);
    await new Promise(r => setTimeout(r, 200));
    let tick = c1.messages.filter(m => m.t === 'tick').pop();
    const vNear = tick.e.find(e => e[0] === 'v');
    check(Array.isArray(vNear[4]), 'vault contents visible when near chest');

    c1.sendMsg({ t: 'vault', cmd: 'deposit', slot: 4 });
    await new Promise(r => setTimeout(r, 300));
    tick = c1.messages.filter(m => m.t === 'tick').pop();
    check(tick.e.find(e => e[0] === 'v')[4][0] === 'staff0', 'item deposited in vault');
    check(tick.self.inv[0] === null, 'item removed from inventory');

    c1.sendMsg({ t: 'vault', cmd: 'withdraw', idx: 0 });
    await new Promise(r => setTimeout(r, 300));
    tick = c1.messages.filter(m => m.t === 'tick').pop();
    check(tick.self.inv.includes('staff0'), 'item withdrawn from vault');
    c1.sendMsg({ t: 'invswap', from: 4, to: 0 }); // re-equip

    // --- trade: c2 walks to c1, c1 offers nothing, c2 offers its sword
    const t2 = await c2.waitFor('tick');
    c2.sendMsg({ t: 'invswap', from: 0, to: 4 }); // sword -> inventory
    const myEnt2 = t2.e.find(e => e[0] === 'p' && e[1] === w2.you);
    const pos1 = c1.messages.filter(m => m.t === 'tick').pop().e.find(e => e[1] === w1.you);
    await walkTo(c2, myEnt2[4], myEnt2[5], pos1[4], pos1[5]);

    c1.sendMsg({ t: 'trade', cmd: 'request', name: user2 });
    const req = await c2.waitFor('tradereq');
    check(req.from === user1, 'trade request delivered');
    c2.sendMsg({ t: 'trade', cmd: 'accept' });
    await c1.waitFor('tradestate');
    await c2.waitFor('tradestate');
    check(true, 'trade session opened');

    c2.sendMsg({ t: 'trade', cmd: 'offer', slots: [0] });
    await new Promise(r => setTimeout(r, 200));
    const st = c1.messages.filter(m => m.t === 'tradestate').pop();
    check(st.theirs[0] === 'sword0', 'partner offer visible');

    c1.sendMsg({ t: 'trade', cmd: 'confirm' });
    c2.sendMsg({ t: 'trade', cmd: 'confirm' });
    await c1.waitFor('tradedone');
    await c2.waitFor('tradedone');
    await new Promise(r => setTimeout(r, 200));
    tick = c1.messages.filter(m => m.t === 'tick').pop();
    check(tick.self.inv.includes('sword0'), 'traded item received');

    // --- guild
    c1.sendMsg({ t: 'chat', text: '/guilda criar Os Testers' });
    await new Promise(r => setTimeout(r, 200));
    c1.sendMsg({ t: 'chat', text: '/guilda convidar ' + user2 });
    await new Promise(r => setTimeout(r, 200));
    c2.sendMsg({ t: 'chat', text: '/guilda aceitar' });
    await new Promise(r => setTimeout(r, 300));
    c1.messages.length = 0;
    c2.sendMsg({ t: 'chat', text: '/g ola guilda' });
    const gmsg = await c1.waitFor('chat');
    check(gmsg.from.includes('[Os Testers]'), 'guild chat delivered to members');
    tick = c1.messages.filter(m => m.t === 'tick').pop() || await c1.waitFor('tick');
    check(tick.e.some(e => e[0] === 'p' && e[10] === 'Os Testers'), 'guild tag in snapshot');

    // --- realm + combat still work
    c1.messages.length = 0;
    const portal = (await c1.waitFor('tick')).e.find(e => e[0] === 'o' && e[2] === 'realm');
    const mePos = c1.messages.filter(m => m.t === 'tick').pop().e.find(e => e[1] === w1.you);
    await walkTo(c1, mePos[4], mePos[5], portal[3], portal[4]);
    c1.messages.length = 0;
    c1.sendMsg({ t: 'portal' });
    const realm = await c1.waitFor('world');
    check(realm.kind === 'realm', 'entered realm through portal');
    c1.messages.length = 0;
    const realmTick = await c1.waitFor('tick');
    check(realmTick.self.quest && typeof realmTick.self.quest.x === 'number', 'quest compass target in realm');
    for (let i = 0; i < 5; i++) {
      c1.sendMsg({ t: 'shoot', a: i });
      await new Promise(r => setTimeout(r, 250));
    }
    await c1.waitFor('shot');
    check(true, 'shot broadcast received');

    c1.ws.close(); c2.ws.close();
    await new Promise(r => setTimeout(r, 400));

    // --- persistence across restart (real database!)
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 600));
    server = await startServer();

    r = await api('POST', '/api/login', { username: user1, password: 'senha123' });
    check(r.status === 200, 'login works after restart');
    token1 = r.data.token;

    r = await api('GET', '/api/chars', null, token1);
    check(r.data.characters.length === 1, 'character survived restart');
    const c1b = client(token1, char1);
    await c1b.opened;
    await c1b.waitFor('world');
    const tickB = await c1b.waitFor('tick');
    check(tickB.self.inv.includes('sword0'), 'traded item persisted in database');
    c1b.sendMsg({ t: 'chat', text: '/guilda info' });
    const ginfo = await c1b.waitFor('chat');
    check(ginfo.text.includes('Os Testers'), 'guild persisted in database');
    check(fs.existsSync(path.join(DATA_DIR, 'game.db')), 'SQLite database file exists');
    c1b.ws.close();
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    console.error('TEST ERROR:', e.message);
    failures++;
  } finally {
    server.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  }
  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
