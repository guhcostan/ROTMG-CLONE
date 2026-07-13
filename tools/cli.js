#!/usr/bin/env node
'use strict';
// Terminal client for Realm Reborn: play, watch and debug without a browser.
//
//   node tools/cli.js --user nome --pass senha            # login (or register) and play
//   node tools/cli.js ... --host https://meu-app.fly.dev  # against production
//   node tools/cli.js ... --class archer                  # class for a new character
//   node tools/cli.js ... --bot                           # autopilot (wander + autofire)
//   node tools/cli.js ... --quiet                         # no map, just the event log
//
// Keys: WASD move · x autofire · space ability · f portal · r nexus
//       1-8 use item · t chat · q quit
const path = require('path');
// resolve colyseus.js from the repo even when run from elsewhere
module.paths.push(path.join(__dirname, '..', 'node_modules'));
const Colyseus = require('colyseus.js');

// ---------------------------------------------------------------- args
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[++i] : true;
}
const HOST = (args.host || 'http://localhost:8080').replace(/\/$/, '');
const WS = HOST.replace(/^http/, 'ws');
const USER = args.user || 'cli' + (Math.random() * 1e6 | 0);
const PASS = args.pass || 'senha123';
const CLASS = args.class || 'wizard';
const BOT = !!args.bot;
const QUIET = !!args.quiet;

// ---------------------------------------------------------------- state
let world = null, tiles = null, me = { x: 0, y: 0 }, myId = 0, self = null;
let entities = new Map();
let autofire = BOT;
let dir = { x: 0, y: 0 }, moveUntil = 0;
let chatLines = [];
let typing = null; // chat input buffer when 't' pressed
let room = null;
let statusLine = '';

const BLOCKING = new Set([0, 4, 10]);
function tileAt(x, y) {
  x |= 0; y |= 0;
  if (!world || x < 0 || y < 0 || x >= world.w || y >= world.h) return 0;
  return tiles[y * world.w + x];
}
const blocked = (x, y) => BLOCKING.has(tileAt(x, y));

function log(line) {
  chatLines.push(line);
  if (chatLines.length > 200) chatLines.shift();
  if (QUIET) console.log(line);
}

// ---------------------------------------------------------------- net
async function api(p, body, token) {
  const res = await fetch(HOST + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function main() {
  let auth = await api('/api/login', { username: USER, password: PASS });
  if (auth.error) auth = await api('/api/register', { username: USER, password: PASS });
  if (auth.error) { console.error('auth falhou:', auth.error); process.exit(1); }

  const chars = await api('/api/chars', null, auth.token);
  let charId = chars.characters[0] && chars.characters[0].id;
  if (args.char) charId = parseInt(args.char, 10);
  if (!charId) {
    const r = await api('/api/chars', { classId: CLASS }, auth.token);
    if (r.error) { console.error('criar personagem falhou:', r.error); process.exit(1); }
    charId = r.character.id;
    log(`* personagem ${CLASS} criado`);
  }

  const client = new Colyseus.Client(WS);
  room = await client.joinOrCreate('realm', { token: auth.token, char: charId });
  log(`* conectado como ${auth.username} (sala ${room.roomId})`);

  room.onMessage('g', (p) => {
    const m = typeof p === 'string' ? JSON.parse(p) : p;
    handle(m);
  });
  room.onStateChange((s) => { statusLine = `${s.online} online · zonas ${s.zones}`; });
  room.onLeave((code) => { render(true); console.log(`\n* desconectado (${code})`); process.exit(0); });

  setupKeys();
  setInterval(update, 50);
  if (!QUIET) setInterval(() => render(false), 100);
  if (BOT) setInterval(botBrain, 700);
}

function handle(m) {
  switch (m.t) {
    case 'world': {
      tiles = Uint8Array.from(atob(m.tiles), c => c.charCodeAt(0));
      world = m; me.x = m.x; me.y = m.y; myId = m.you;
      entities.clear();
      log(`* zona: ${m.name} (${m.kind} ${m.w}x${m.h})`);
      break;
    }
    case 'tick': {
      self = m.self;
      const seen = new Set();
      for (const e of m.e) {
        const [kind, id] = e;
        seen.add(id);
        if (kind === 'p') entities.set(id, { kind, id, name: e[2], cls: e[3], x: e[4], y: e[5], hp: e[6], maxHp: e[7], level: e[8] });
        else if (kind === 'e') entities.set(id, { kind, id, type: e[2], x: e[3], y: e[4], hp: e[5], maxHp: e[6], elite: e[7] });
        else if (kind === 'b') entities.set(id, { kind, id, x: e[2], y: e[3], tier: e[4], items: e[5] });
        else if (kind === 'o') entities.set(id, { kind, id, pkind: e[2], x: e[3], y: e[4], name: e[5] });
        else if (kind === 'v') entities.set('vault', { kind, id: 'vault', x: e[2], y: e[3] });
      }
      for (const id of entities.keys()) if (!seen.has(id) && id !== 'vault') entities.delete(id);
      break;
    }
    case 'chat': log(`${m.evt ? '[EVENTO] ' : m.sys ? '[sys] ' : ''}${m.from ? m.from + ': ' : ''}${m.text}`); break;
    case 'notice': log(`>> ${m.text}`); break;
    case 'dmg': if (m.id === myId) log(m.n > 0 ? `-${m.n} hp!` : `+${-m.n} hp`); break;
    case 'tele': log(`!! TELEGRAPH: ataque em (${m.x | 0},${m.y | 0}) raio ${m.r}`); break;
    case 'death':
      log(`*** VOCE MORREU para ${m.killer} (nv ${m.level}, fama ${m.fame}) ***`);
      log('* espectador por ate 90s; q para sair');
      break;
    case 'blink': me.x = m.x; me.y = m.y; break;
    case 'invite': log(`* convite de ${m.from} (${m.kind}) — digite "t /party aceitar" ou "/guilda aceitar"`); break;
    case 'tradereq': log(`* ${m.from} quer trocar`); break;
  }
}

// ---------------------------------------------------------------- input
function setupKeys() {
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    for (const key of chunk) {
      if (typing !== null) {
        if (key === '\r' || key === '\n') {
          if (typing.trim()) room.send('g', { t: 'chat', text: typing.trim() });
          typing = null;
        } else if (key === '\x7f' || key === '\b') typing = typing.slice(0, -1);
        else if (key === '\x1b') typing = null;
        else if (key >= ' ') typing += key;
        continue;
      }
      const k = key.toLowerCase();
      if (k === 'q' || key === '\x03') { try { room.leave(); } catch {} setTimeout(() => process.exit(0), 300); }
      else if (k === 'w') { dir = { x: 0, y: -1 }; moveUntil = Date.now() + 220; }
      else if (k === 's') { dir = { x: 0, y: 1 }; moveUntil = Date.now() + 220; }
      else if (k === 'a') { dir = { x: -1, y: 0 }; moveUntil = Date.now() + 220; }
      else if (k === 'd') { dir = { x: 1, y: 0 }; moveUntil = Date.now() + 220; }
      else if (k === 'x') { autofire = !autofire; log('* autofire ' + (autofire ? 'ON' : 'OFF')); }
      else if (k === ' ') ability();
      else if (k === 'f') room.send('g', { t: 'portal' });
      else if (k === 'r') room.send('g', { t: 'nexus' });
      else if (k >= '1' && k <= '8') room.send('g', { t: 'useitem', slot: 3 + parseInt(k, 10) });
      else if (k === 't') typing = '';
    }
  });
}

function nearestEnemy() {
  let best = null, bd = Infinity;
  for (const e of entities.values()) {
    if (e.kind !== 'e') continue;
    const d = Math.hypot(e.x - me.x, e.y - me.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function ability() {
  const t = nearestEnemy() || me;
  room.send('g', { t: 'ability', x: t.x, y: t.y });
}

// ---------------------------------------------------------------- sim
let shotAccum = 0;
function update() {
  if (!world || !self) return;
  const dt = 0.05;
  if (Date.now() < moveUntil && (dir.x || dir.y)) {
    const spd = 4 + 5.6 * ((self.stats ? self.stats.spd : 10) / 75);
    const nx = me.x + dir.x * spd * dt, ny = me.y + dir.y * spd * dt;
    if (!blocked(nx, me.y)) me.x = nx;
    if (!blocked(me.x, ny)) me.y = ny;
    me.x = Math.max(0.5, Math.min(world.w - 0.5, me.x));
    me.y = Math.max(0.5, Math.min(world.h - 0.5, me.y));
    room.send('g', { t: 'move', x: Math.round(me.x * 100) / 100, y: Math.round(me.y * 100) / 100 });
  }
  if (autofire) {
    shotAccum += dt;
    if (shotAccum > 0.12) {
      shotAccum = 0;
      const e = nearestEnemy();
      if (e && Math.hypot(e.x - me.x, e.y - me.y) < 12) {
        room.send('g', { t: 'shoot', a: Math.atan2(e.y - me.y, e.x - me.x) });
      }
    }
  }
}

// dumb but effective: wander, chase portals out of safe zones, drink potions
function botBrain() {
  if (!world || !self) return;
  if (self.hp / self.maxHp < 0.4 && self.inv && self.inv.includes('hppot')) {
    room.send('g', { t: 'useitem', slot: 4 + self.inv.indexOf('hppot') });
  }
  if (world.kind === 'tutorial' || world.kind === 'nexus') {
    const portal = [...entities.values()].find(e => e.kind === 'o' && (world.kind === 'tutorial' || e.pkind === 'realm'));
    if (portal) {
      const d = Math.hypot(portal.x - me.x, portal.y - me.y);
      if (d < 1.5) room.send('g', { t: 'portal' });
      else { dir = { x: Math.sign(portal.x - me.x), y: Math.sign(portal.y - me.y) }; moveUntil = Date.now() + 700; }
      return;
    }
  }
  dir = { x: Math.sign(Math.random() - 0.5), y: Math.sign(Math.random() - 0.5) };
  moveUntil = Date.now() + 500;
}

// ---------------------------------------------------------------- render
const TILE_CH = {
  0: ['\x1b[38;5;236m', ' '], 1: ['\x1b[38;5;28m', '.'], 2: ['\x1b[38;5;180m', ','],
  3: ['\x1b[38;5;25m', '~'], 4: ['\x1b[38;5;244m', '#'], 5: ['\x1b[38;5;137m', '·'],
  6: ['\x1b[38;5;22m', '"'], 7: ['\x1b[38;5;101m', '^'], 8: ['\x1b[38;5;166m', '≈'],
  9: ['\x1b[38;5;240m', '.'], 10: ['\x1b[38;5;99m', '#'], 11: ['\x1b[38;5;110m', '.'],
  12: ['\x1b[38;5;153m', '.'], 13: ['\x1b[38;5;117m', '~'],
};
function render(final) {
  if (QUIET || !world || !self) return;
  const W = Math.min((process.stdout.columns || 80), 100);
  const H = Math.min((process.stdout.rows || 30) - 8, 26);
  const out = [];
  const hpBar = bar(self.hp, self.maxHp, 12, '\x1b[31m');
  const mpBar = bar(self.mp, self.maxMp, 12, '\x1b[34m');
  out.push(`\x1b[1m${USER}\x1b[0m @ ${world.name}  HP ${hpBar} ${self.hp}/${self.maxHp}  MP ${mpBar}  nv ${self.level}  ouro ${self.gold}  ${autofire ? '\x1b[33m[AUTOFIRE]\x1b[0m' : ''}`);
  const x0 = me.x - W / 2, y0 = me.y - H / 2;
  for (let ry = 0; ry < H; ry++) {
    let line = '';
    for (let rx = 0; rx < W; rx++) {
      const wx = x0 + rx, wy = y0 + ry;
      const t = TILE_CH[tileAt(wx, wy)] || TILE_CH[0];
      line += t[0] + t[1];
    }
    out.push(line + '\x1b[0m');
  }
  // overlay entities on the grid
  const put = (x, y, str) => {
    const rx = Math.round(x - x0), ry = Math.round(y - y0);
    if (rx < 0 || ry < 0 || rx >= W || ry >= H) return;
    const row = out[1 + ry];
    // each cell = color escape + one char; rebuild the row with the sprite in place
    const cells = row.split(/(?=\x1b\[38)/);
    cells[rx] = str + '\x1b[0m';
    out[1 + ry] = cells.join('');
  };
  for (const e of entities.values()) {
    if (e.kind === 'e') put(e.x, e.y, (e.elite ? '\x1b[1;33;41m' : '\x1b[1;31m') + (e.type[0] || 'e').toUpperCase());
    else if (e.kind === 'b') put(e.x, e.y, '\x1b[1;33m$');
    else if (e.kind === 'o') put(e.x, e.y, '\x1b[1;35mO');
    else if (e.kind === 'v') put(e.x, e.y, '\x1b[1;36mV');
    else if (e.kind === 'p' && e.id !== myId) put(e.x, e.y, '\x1b[1;36mP');
  }
  put(me.x, me.y, '\x1b[1;93m@');
  out.push('\x1b[2m' + statusLine + '\x1b[0m');
  for (const l of chatLines.slice(-5)) out.push((l.startsWith('[EVENTO]') ? '\x1b[36m' : l.startsWith('[sys]') ? '\x1b[33m' : '') + l.slice(0, W) + '\x1b[0m');
  out.push(typing !== null
    ? `\x1b[7mchat> ${typing}\x1b[0m`
    : '\x1b[2mwasd move · x autofire · espaco habilidade · f portal · r nexus · 1-8 item · t chat · q sair\x1b[0m');
  process.stdout.write('\x1b[H\x1b[2J' + out.join('\n') + (final ? '\n' : ''));
}
function bar(v, max, w, color) {
  const n = Math.max(0, Math.min(w, Math.round(v / max * w)));
  return color + '█'.repeat(n) + '\x1b[2m' + '░'.repeat(w - n) + '\x1b[0m';
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
