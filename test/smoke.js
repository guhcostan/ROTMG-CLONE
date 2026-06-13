'use strict';
// End-to-end smoke test: boots the server, registers an account, creates a
// character, connects via WebSocket, moves, shoots and checks snapshots.
process.env.PORT = 18099;
const fs = require('fs');
const os = require('os');
const path = require('path');
// isolated database so tests never touch the real data/db.json
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'realmtest-'));
const { spawn } = require('child_process');
const WebSocket = require('ws');

const BASE = `http://localhost:${process.env.PORT}`;
let failures = 0;

function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'X-Token': token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function dataSanity() {
  const { ENEMIES, DUNGEONS, ITEMS } = require('../server/data');
  let bad = [];
  for (const [id, e] of Object.entries(ENEMIES)) {
    for (const [spec] of e.loot || []) {
      if (spec === 'statpot') continue;
      if (spec.startsWith('weapon:') || spec.startsWith('armor:')) continue;
      if (spec.startsWith('portal:')) {
        if (!DUNGEONS[spec.slice(7)]) bad.push(`${id}: portal ${spec}`);
      } else if (!ITEMS[spec]) bad.push(`${id}: item ${spec}`);
    }
    if (e.spawns && !ENEMIES[e.spawns.type]) bad.push(`${id}: spawns ${e.spawns.type}`);
  }
  for (const [key, d] of Object.entries(DUNGEONS)) {
    if (!ENEMIES[d.boss]) bad.push(`${key}: boss ${d.boss}`);
    for (const m of d.minions) if (!ENEMIES[m]) bad.push(`${key}: minion ${m}`);
  }
  check(bad.length === 0, 'data refs consistent' + (bad.length ? ' -> ' + bad.join(', ') : ''));
}

function realmCycleSanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  const oldRealm = g.realm;
  g.closeRealm();
  check(g.realm !== oldRealm && g.realm.kind === 'realm' && g.realm.enemies.size > 0, 'realm regenerates after closing');
  check([...g.instances.values()].some(i => i.kind === 'dungeon' && i.name === 'Castelo do Rei Demente'), 'mad castle created on realm close');
  check(!g.instances.has(oldRealm.id), 'old realm removed');
}

async function main() {
  dataSanity();
  realmCycleSanity();
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(d));
  await new Promise((res, rej) => {
    server.stdout.on('data', d => { if (String(d).includes('Servidor rodando')) res(); });
    server.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server start timeout')), 8000);
  });

  try {
    const user = 'tester' + Math.floor(Math.random() * 1e6);

    // --- accounts
    let r = await api('POST', '/api/register', { username: user, password: 'senha123' });
    check(r.status === 200 && r.data.token, 'register returns token');
    const token = r.data.token;

    r = await api('POST', '/api/register', { username: user, password: 'senha123' });
    check(r.status === 400, 'duplicate username rejected');

    r = await api('POST', '/api/login', { username: user, password: 'errada' });
    check(r.status === 400, 'wrong password rejected');

    r = await api('POST', '/api/login', { username: user, password: 'senha123' });
    check(r.status === 200 && r.data.token, 'login works');

    // --- characters
    r = await api('GET', '/api/chars', null, token);
    check(r.status === 200 && r.data.characters.length === 0, 'char list starts empty');
    check(Object.keys(r.data.classes).length === 6, 'six classes available');

    r = await api('POST', '/api/chars', { classId: 'wizard' }, token);
    check(r.status === 200 && r.data.character.classId === 'wizard', 'create wizard');
    const charId = r.data.character.id;

    r = await api('GET', '/api/items', null);
    check(r.status === 200 && r.data.staff0 && r.data.hppot, 'item metadata served');

    // --- websocket gameplay
    const ws = new WebSocket(`ws://localhost:${process.env.PORT}/ws?token=${token}&char=${charId}`);
    const messages = [];
    const waitFor = (type, timeout = 5000) => new Promise((res, rej) => {
      const found = messages.find(m => m.t === type);
      if (found) return res(found);
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = messages.find(x => x.t === type);
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('timeout waiting ' + type)); }
      }, 30);
    });
    ws.on('message', d => messages.push(JSON.parse(d)));
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    const world = await waitFor('world');
    check(world.kind === 'nexus' && world.w > 0, 'spawned in nexus with map');
    const tiles = Buffer.from(world.tiles, 'base64');
    check(tiles.length === world.w * world.h, 'map tile payload complete');

    const tick = await waitFor('tick');
    check(tick.self.hp === 100 && tick.self.level === 1, 'self stats in snapshot');
    check(tick.e.some(e => e[0] === 'p'), 'player entity visible');
    check(tick.e.some(e => e[0] === 'o' && e[2] === 'realm'), 'realm portal in nexus');

    // move toward the portal and enter the realm
    const portal = tick.e.find(e => e[0] === 'o' && e[2] === 'realm');
    let px = world.x, py = world.y;
    // walk step by step (server enforces speed)
    for (let i = 0; i < 200; i++) {
      const dx = portal[3] - px, dy = portal[4] - py;
      const d = Math.hypot(dx, dy);
      if (d < 1) break;
      const step = Math.min(0.25, d);
      px += (dx / d) * step; py += (dy / d) * step;
      ws.send(JSON.stringify({ t: 'move', x: px, y: py }));
      await new Promise(r => setTimeout(r, 35));
    }
    messages.length = 0;
    ws.send(JSON.stringify({ t: 'portal' }));
    const realm = await waitFor('world');
    check(realm.kind === 'realm', 'entered realm through portal');

    // shoot a few times; expect shot broadcast back
    messages.length = 0;
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ t: 'shoot', a: i }));
      await new Promise(r => setTimeout(r, 250));
    }
    await waitFor('shot');
    check(true, 'shot broadcast received');

    // chat roundtrip
    messages.length = 0;
    ws.send(JSON.stringify({ t: 'chat', text: 'ola mundo' }));
    const chat = await waitFor('chat');
    check(chat.text === 'ola mundo', 'chat roundtrip');

    // back to nexus command
    messages.length = 0;
    ws.send(JSON.stringify({ t: 'nexus' }));
    const nx = await waitFor('world');
    check(nx.kind === 'nexus', '/nexus teleport works');

    // --- vault: walk to the chest, deposit the starter weapon, take it back
    let chest = null;
    for (let i = 0; i < 100 && !chest; i++) {
      const m = messages.find(x => x.t === 'tick' && x.e.some(e => e[0] === 'o' && e[2] === 'vault'));
      if (m) chest = m.e.find(e => e[0] === 'o' && e[2] === 'vault');
      else await new Promise(r => setTimeout(r, 30));
    }
    check(!!chest, 'vault chest in nexus');
    px = nx.x; py = nx.y;
    for (let i = 0; i < 200; i++) {
      const dx = chest[3] - px, dy = chest[4] - py;
      const d = Math.hypot(dx, dy);
      if (d < 1.5) break;
      const step = Math.min(0.25, d);
      px += (dx / d) * step; py += (dy / d) * step;
      ws.send(JSON.stringify({ t: 'move', x: px, y: py }));
      await new Promise(r => setTimeout(r, 35));
    }
    messages.length = 0;
    let vt = await waitFor('tick');
    check(Array.isArray(vt.self.vault) && vt.self.vault.length === 16, 'vault visible near chest');
    const weapon = vt.self.eq[0];
    ws.send(JSON.stringify({ t: 'vaultswap', from: 0, to: 12 }));
    await new Promise(r => setTimeout(r, 200));
    messages.length = 0;
    vt = await waitFor('tick');
    check(vt.self.vault[0] === weapon && vt.self.eq[0] === null, 'deposited weapon in vault');
    ws.send(JSON.stringify({ t: 'vaultswap', from: 12, to: 0 }));
    await new Promise(r => setTimeout(r, 200));
    messages.length = 0;
    vt = await waitFor('tick');
    check(vt.self.eq[0] === weapon && vt.self.vault[0] === null, 'withdrew weapon from vault');

    // --- trade: second account joins, both swap via /trade
    const user2 = 'trader' + Math.floor(Math.random() * 1e6);
    r = await api('POST', '/api/register', { username: user2, password: 'senha123' });
    const token2 = r.data.token;
    r = await api('POST', '/api/chars', { classId: 'archer' }, token2);
    const charId2 = r.data.character.id;
    const ws2 = new WebSocket(`ws://localhost:${process.env.PORT}/ws?token=${token2}&char=${charId2}`);
    const messages2 = [];
    const waitFor2 = (type, timeout = 5000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = messages2.find(x => x.t === type);
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('timeout waiting ' + type)); }
      }, 30);
    });
    ws2.on('message', d => messages2.push(JSON.parse(d)));
    await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej); });
    await waitFor2('world');

    // player 1 walks back to spawn so both are in range
    for (let i = 0; i < 200; i++) {
      const dx = nx.x - px, dy = nx.y - py;
      const d = Math.hypot(dx, dy);
      if (d < 1) break;
      const step = Math.min(0.25, d);
      px += (dx / d) * step; py += (dy / d) * step;
      ws.send(JSON.stringify({ t: 'move', x: px, y: py }));
      await new Promise(r => setTimeout(r, 35));
    }
    // move the starter weapon to inventory so it can be offered
    ws.send(JSON.stringify({ t: 'invswap', from: 0, to: 4 }));
    await new Promise(r => setTimeout(r, 150));
    messages.length = 0; messages2.length = 0;
    ws.send(JSON.stringify({ t: 'chat', text: `/trade ${user2}` }));
    await new Promise(r => setTimeout(r, 200));
    ws2.send(JSON.stringify({ t: 'chat', text: `/trade ${user}` }));
    const tr1 = await waitFor('trade');
    check(tr1.partner === user2, 'trade window opened');
    ws.send(JSON.stringify({ t: 'tradeoffer', slots: [true, false, false, false, false, false, false, false] }));
    await new Promise(r => setTimeout(r, 200));
    ws.send(JSON.stringify({ t: 'tradeconfirm' }));
    ws2.send(JSON.stringify({ t: 'tradeconfirm' }));
    await waitFor('tradeend');
    await waitFor2('tradeend');
    messages2.length = 0;
    const t2 = await waitFor2('tick');
    check(t2.self.inv.includes('staff0'), 'traded item arrived in partner inventory');
    ws2.close();

    // --- leaderboard
    r = await api('GET', '/api/leaderboard', null);
    check(r.status === 200 && Array.isArray(r.data) && r.data.some(x => x.name === user), 'leaderboard lists characters');

    ws.close();
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    console.error('TEST ERROR:', e.message);
    failures++;
  } finally {
    server.kill();
  }
  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
