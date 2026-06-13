'use strict';
// Authoritative game simulation: instances (nexus / realm / dungeons),
// enemy AI and bullet patterns, combat, XP/levels, loot and permadeath.
const { CLASSES, ITEMS, ENEMIES, DUNGEONS, STAT_POTS, LEGENDARIES } = require('./data');
const { T, generateNexus, generateRealm, generateDungeon, bandAt } = require('./world');
const { buryCharacter } = require('./auth');
const { save } = require('./db');

const TICK = 1000 / 20;          // 20 ticks/s
const VIEW = 22;                 // entity broadcast radius in tiles
const BAG_TTL = 60 * 1000;       // loot bag lifetime
const PORTAL_TTL = 45 * 1000;

let nextId = 1;
const uid = () => nextId++;

const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

// ---------------------------------------------------------------- loot
function rollLoot(lootTable, rng) {
  const items = [];
  for (const [spec, chance] of lootTable) {
    if (Math.random() >= chance) continue;
    if (spec === 'statpot') {
      items.push(STAT_POTS[Math.floor(Math.random() * STAT_POTS.length)]);
    } else if (spec === 'legendary') {
      items.push(LEGENDARIES[Math.floor(Math.random() * LEGENDARIES.length)]);
    } else if (spec.startsWith('weapon:') || spec.startsWith('armor:')) {
      const [group, range] = spec.split(':');
      const [lo, hi] = range.split('-').map(Number);
      const tier = lo + Math.floor(Math.random() * (hi - lo + 1));
      const kinds = group === 'weapon'
        ? ['staff', 'bow', 'sword', 'wand', 'dagger']
        : ['robe', 'leather', 'heavy'];
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      if (ITEMS[`${kind}${tier}`]) items.push(`${kind}${tier}`);
    } else if (spec.startsWith('portal:')) {
      items.push(spec); // handled by caller (spawns a portal, not a bag item)
    } else if (ITEMS[spec]) {
      items.push(spec);
    }
  }
  return items;
}

function bagTier(items) {
  let t = 0;
  for (const id of items) t = Math.max(t, (ITEMS[id] && ITEMS[id].tier) || 0);
  return t;
}

// ---------------------------------------------------------------- stats
function effectiveStats(player) {
  const s = Object.assign({}, player.char.stats);
  for (const itemId of player.char.equipment) {
    const it = itemId && ITEMS[itemId];
    if (!it) continue;
    if (it.slot === 'armor') s.def += it.def;
    if (it.slot === 'ring' && it.bonus) for (const k in it.bonus) s[k] = (s[k] || 0) + it.bonus[k];
  }
  if (player.berserkUntil > Date.now()) { s.dex = Math.round(s.dex * 1.5); s.spd = Math.round(s.spd * 1.25); }
  return s;
}

function moveSpeed(stats) { return 4 + 5.6 * (stats.spd / 75); }     // tiles/s
function fireRate(stats) { return 1.5 + 4.5 * (stats.dex / 75); }    // shots/s
function applyDefense(dmg, def) { return Math.max(Math.ceil(dmg * 0.1), dmg - def); }

function xpToNext(level) { return level * 100; }

// ---------------------------------------------------------------- entities
class Enemy {
  constructor(type, x, y) {
    const d = ENEMIES[type];
    this.id = uid();
    this.type = type;
    this.def = d;
    this.x = x; this.y = y;
    this.hp = d.hp; this.maxHp = d.hp;
    this.spawnX = x; this.spawnY = y;
    this.angle = Math.random() * Math.PI * 2;
    this.nextShot = 0;
    this.nextRing = 0;
    this.nextMelee = 0;
    this.nextSpawn = 0;
    this.wanderUntil = 0;
    this.stunnedUntil = 0;
    this.damagers = new Map(); // playerId -> dmg
    this.children = 0;
  }
}

class Instance {
  constructor(kind, name, map) {
    this.id = uid();
    this.kind = kind;            // 'nexus' | 'realm' | 'dungeon'
    this.name = name;
    this.map = map;
    this.players = new Map();    // playerId -> Player
    this.enemies = new Map();
    this.projectiles = [];       // server-side bullets (both sides)
    this.bags = new Map();
    this.portals = new Map();
    this.dungeonDef = null;
    this.bossId = null;
    this.bossDead = false;
    this.emptySince = 0;
  }
  tileBlocked(x, y) { return this.map.blocks(x, y); }
  broadcast(msg, except) {
    const str = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p !== except && p.ws.readyState === 1) p.ws.send(str);
    }
  }
  broadcastNear(msg, x, y, r = VIEW + 6) {
    const str = JSON.stringify(msg);
    const r2 = r * r;
    for (const p of this.players.values()) {
      if (p.ws.readyState === 1 && dist2(p.x, p.y, x, y) < r2) p.ws.send(str);
    }
  }
}

// ---------------------------------------------------------------- game
class Game {
  constructor() {
    this.players = new Map(); // playerId -> Player
    this.instances = new Map();
    this.nexus = this.addInstance(new Instance('nexus', 'Nexus', generateNexus()));
    this.realmSeed = (Math.random() * 1e9) | 0;
    this.realm = this.addInstance(new Instance('realm', 'Reino Selvagem', generateRealm(this.realmSeed)));
    const vs = this.nexus.map.vaultSpot;
    this.spawnPortal(this.nexus, vs.x, vs.y, 'vault', 'Cofre', null, 1e15);
    this.godKills = 0;
    this.godKillTarget = 25; // gods slain before the realm closes
    this.populateRealm();
    setInterval(() => this.tick(), TICK);
    setInterval(() => this.autosave(), 30000);
  }

  addInstance(inst) { this.instances.set(inst.id, inst); return inst; }

  // ------------------------------------------------ realm population
  bandTypes() {
    const byBand = [[], [], [], [], []];
    for (const e of Object.values(ENEMIES)) if (e.band >= 0) byBand[e.band].push(e.id);
    return byBand;
  }

  // mini-bosses (rare: true) show up much less often than common mobs
  randomBandType(byBand, band) {
    let type = byBand[band][Math.floor(Math.random() * byBand[band].length)];
    if (ENEMIES[type].rare && Math.random() < 0.78) {
      type = byBand[band][Math.floor(Math.random() * byBand[band].length)];
    }
    return type;
  }

  // spawns the enemy plus its escort pack (entourage follows the leader)
  spawnEnemy(inst, type, x, y) {
    const e = new Enemy(type, x, y);
    inst.enemies.set(e.id, e);
    const ent = e.def.entourage;
    if (ent) {
      for (let i = 0; i < ent.count; i++) {
        const m = new Enemy(ent.type, x + (Math.random() - 0.5) * 3, y + (Math.random() - 0.5) * 3);
        m.parentId = e.id;
        inst.enemies.set(m.id, m);
      }
    }
    return e;
  }

  populateRealm() {
    const m = this.realm.map;
    const counts = [90, 140, 140, 110, 40]; // enemies per band
    const byBand = this.bandTypes();
    for (let band = 0; band < 5; band++) {
      let placed = 0, tries = 0;
      while (placed < counts[band] && tries++ < counts[band] * 60) {
        const a = Math.random() * Math.PI * 2;
        const fr = [0.94, 0.75, 0.5, 0.27, 0.08][band] + (Math.random() - 0.5) * 0.1;
        const x = m.center.x + Math.cos(a) * m.maxR * Math.max(0.02, fr);
        const y = m.center.y + Math.sin(a) * m.maxR * Math.max(0.02, fr);
        if (m.blocks(x, y) || m.get(x, y) === T.WATER || m.get(x, y) === T.LAVA) continue;
        if (bandAt(Math.hypot(x - m.center.x, y - m.center.y), m.maxR) !== band) continue;
        this.spawnEnemy(this.realm, this.randomBandType(byBand, band), x, y);
        placed++;
      }
    }
  }

  // keep realm population topped up
  respawnRealm() {
    if (this.realm.enemies.size > 450) return;
    const m = this.realm.map;
    const byBand = this.bandTypes();
    for (let i = 0; i < 10; i++) {
      const band = Math.floor(Math.random() * 5);
      const a = Math.random() * Math.PI * 2;
      const fr = [0.94, 0.75, 0.5, 0.27, 0.08][band];
      const x = m.center.x + Math.cos(a) * m.maxR * fr;
      const y = m.center.y + Math.sin(a) * m.maxR * fr;
      if (m.blocks(x, y) || m.get(x, y) === T.WATER || m.get(x, y) === T.LAVA) continue;
      // don't spawn on top of someone
      let near = false;
      for (const p of this.realm.players.values()) if (dist2(p.x, p.y, x, y) < 144) { near = true; break; }
      if (near) continue;
      this.spawnEnemy(this.realm, this.randomBandType(byBand, band), x, y);
    }
  }

  // ------------------------------------------------ player lifecycle
  joinPlayer(ws, acc, char) {
    const player = {
      id: uid(), ws, acc, char,
      name: acc.username,
      x: 0, y: 0,
      instance: null,
      lastShot: 0, lastAbility: 0,
      lastHit: 0, lastMoveAt: Date.now(),
      berserkUntil: 0, invisUntil: 0,
      trade: null, tradeInviteTo: 0,
      dead: false,
    };
    this.players.set(player.id, player);
    this.enterInstance(player, this.nexus);
    return player;
  }

  enterInstance(player, inst, spot) {
    if (player.trade) this.cancelTrade(player.trade);
    if (player.instance) player.instance.players.delete(player.id);
    player.instance = inst;
    inst.players.set(player.id, player);
    let s;
    if (spot) s = spot;
    else if (inst.kind === 'realm') s = inst.map.spawnFor();
    else s = inst.map.spawn;
    player.x = s.x; player.y = s.y;
    const tiles = Buffer.from(inst.map.tiles).toString('base64');
    send(player.ws, {
      t: 'world', kind: inst.kind, name: inst.name,
      w: inst.map.w, h: inst.map.h, tiles,
      x: player.x, y: player.y, you: player.id,
    });
    send(player.ws, { t: 'notice', text: inst.kind === 'dungeon' ? `Voce entrou em: ${inst.name}` : inst.name });
  }

  leavePlayer(player) {
    if (player.trade) this.cancelTrade(player.trade);
    if (player.instance) player.instance.players.delete(player.id);
    this.players.delete(player.id);
    if (!player.dead) save();
    this.cleanupInstances();
  }

  cleanupInstances() {
    const now = Date.now();
    for (const inst of this.instances.values()) {
      if (inst.kind !== 'dungeon') continue;
      if (inst.players.size > 0) { inst.emptySince = 0; continue; }
      if (!inst.emptySince) inst.emptySince = now;
      if (now - inst.emptySince > 60000) this.instances.delete(inst.id);
    }
  }

  // ------------------------------------------------ message handling
  handle(player, msg) {
    if (player.dead) return;
    switch (msg.t) {
      case 'move': this.onMove(player, msg); break;
      case 'shoot': this.onShoot(player, msg); break;
      case 'ability': this.onAbility(player, msg); break;
      case 'chat': this.onChat(player, msg); break;
      case 'pickup': this.onPickup(player, msg); break;
      case 'invswap': this.onInvSwap(player, msg); break;
      case 'vaultswap': this.onVaultSwap(player, msg); break;
      case 'tradeoffer': this.onTradeOffer(player, msg); break;
      case 'tradeconfirm': this.onTradeConfirm(player); break;
      case 'tradecancel': if (player.trade) this.cancelTrade(player.trade); break;
      case 'useitem': this.onUseItem(player, msg); break;
      case 'dropitem': this.onDropItem(player, msg); break;
      case 'portal': this.onPortal(player); break;
      case 'nexus': this.toNexus(player); break;
    }
  }

  onMove(player, msg) {
    const x = Number(msg.x), y = Number(msg.y);
    if (!isFinite(x) || !isFinite(y)) return;
    const inst = player.instance;
    const now = Date.now();
    const dt = Math.min(1, (now - player.lastMoveAt) / 1000);
    player.lastMoveAt = now;
    const stats = effectiveStats(player);
    const maxD = moveSpeed(stats) * dt * 1.6 + 0.3; // lenient anti-speed cap
    const d = Math.hypot(x - player.x, y - player.y);
    if (d > maxD) return; // reject teleport-like moves
    if (inst.tileBlocked(x, y)) return;
    player.x = x; player.y = y;
    if (player.trade) {
      const s = player.trade;
      const other = s.a === player ? s.b : s.a;
      if (dist2(player.x, player.y, other.x, other.y) > 81) this.cancelTrade(s, 'Troca cancelada: muito longe');
    }
  }

  onShoot(player, msg) {
    const inst = player.instance;
    if (inst.kind === 'nexus') return;
    const weapon = ITEMS[player.char.equipment[0]];
    if (!weapon || weapon.slot !== 'weapon') return;
    const stats = effectiveStats(player);
    const now = Date.now();
    const interval = 1000 / (fireRate(stats) * weapon.proj.rateMul);
    if (now - player.lastShot < interval * 0.85) return;
    player.lastShot = now;
    const baseAngle = Number(msg.a) || 0;
    const p = weapon.proj;
    const dmgMul = 0.5 + stats.att / 50;
    const angles = [];
    for (let i = 0; i < p.count; i++) {
      const off = p.count > 1 ? (i - (p.count - 1) / 2) * p.spread : 0;
      const a = baseAngle + off;
      angles.push(Math.round(a * 1000) / 1000);
      inst.projectiles.push({
        owner: player.id, friendly: true,
        x: player.x, y: player.y, a,
        speed: p.speed, left: p.range,
        dmg: [Math.round(p.dmg[0] * dmgMul), Math.round(p.dmg[1] * dmgMul)],
        pierce: p.pierce, hit: p.pierce ? new Set() : null,
      });
    }
    inst.broadcastNear({ t: 'shot', x: player.x, y: player.y, as: angles, spd: p.speed, rg: p.range, k: weapon.type, f: 1, o: player.id }, player.x, player.y);
  }

  onAbility(player, msg) {
    const inst = player.instance;
    const item = ITEMS[player.char.equipment[1]];
    if (!item) return;
    const now = Date.now();
    if (now - player.lastAbility < 500) return;
    const stats = effectiveStats(player);
    if (player.char.mp < item.mpCost) return;
    const tx = Number(msg.x), ty = Number(msg.y);
    if (!isFinite(tx) || !isFinite(ty)) return;
    player.lastAbility = now;
    player.char.mp -= item.mpCost;
    const pw = item.power;
    switch (item.type) {
      case 'spell': { // AOE nuke at cursor
        if (inst.kind === 'nexus') break;
        const dmg = Math.round((70 * pw) * (0.5 + stats.att / 50));
        for (const e of inst.enemies.values()) {
          if (dist2(e.x, e.y, tx, ty) < 9) this.damageEnemy(inst, e, dmg, player);
        }
        inst.broadcastNear({ t: 'fx', k: 'nova', x: tx, y: ty, r: 3 }, tx, ty);
        break;
      }
      case 'quiver': { // heavy piercing arrow
        if (inst.kind === 'nexus') break;
        const a = Math.atan2(ty - player.y, tx - player.x);
        const dmg = Math.round((110 * pw) * (0.5 + stats.att / 50));
        inst.projectiles.push({
          owner: player.id, friendly: true, x: player.x, y: player.y, a,
          speed: 18, left: 9, dmg: [dmg, dmg], pierce: true, hit: new Set(),
        });
        inst.broadcastNear({ t: 'shot', x: player.x, y: player.y, as: [a], spd: 18, rg: 9, k: 'heavyarrow', f: 1, o: player.id }, player.x, player.y);
        break;
      }
      case 'helm': // berserk
        player.berserkUntil = now + 4000 + pw * 1000;
        inst.broadcastNear({ t: 'fx', k: 'buff', x: player.x, y: player.y, r: 1 }, player.x, player.y);
        break;
      case 'tome': { // heal self + nearby allies
        const heal = Math.round(80 * pw + stats.wis * 1.5);
        for (const p of inst.players.values()) {
          if (dist2(p.x, p.y, player.x, player.y) < 36) {
            const max = effectiveMaxHp(p);
            p.char.hp = Math.min(max, p.char.hp + heal);
            inst.broadcastNear({ t: 'dmg', id: p.id, n: -heal }, p.x, p.y);
          }
        }
        inst.broadcastNear({ t: 'fx', k: 'heal', x: player.x, y: player.y, r: 6 }, player.x, player.y);
        break;
      }
      case 'cloak': // invisibility
        player.invisUntil = now + 3000 + pw * 1500;
        inst.broadcastNear({ t: 'fx', k: 'vanish', x: player.x, y: player.y, r: 1 }, player.x, player.y);
        break;
      case 'shield': { // stun burst around player
        if (inst.kind === 'nexus') break;
        const dmg = Math.round((90 * pw) * (0.5 + stats.att / 50));
        for (const e of inst.enemies.values()) {
          if (dist2(e.x, e.y, player.x, player.y) < 12.25) {
            this.damageEnemy(inst, e, dmg, player);
            if (e.def.behavior !== 'boss') e.stunnedUntil = now + 2000 + pw * 400;
          }
        }
        inst.broadcastNear({ t: 'fx', k: 'nova', x: player.x, y: player.y, r: 3.5 }, player.x, player.y);
        break;
      }
    }
  }

  onChat(player, msg) {
    const text = String(msg.text || '').slice(0, 200).trim();
    if (!text) return;
    if (text === '/nexus') return this.toNexus(player);
    if (text.startsWith('/trade ')) return this.requestTrade(player, text.slice(7).trim());
    if (text === '/help') {
      return send(player.ws, { t: 'chat', from: '', text: 'Comandos: /nexus volta ao Nexus, /who lista jogadores, /trade nome troca itens, /help', sys: 1 });
    }
    if (text === '/who') {
      const names = [...player.instance.players.values()].map(p => p.name).join(', ');
      return send(player.ws, { t: 'chat', from: '', text: `Online aqui: ${names}`, sys: 1 });
    }
    player.instance.broadcast({ t: 'chat', from: player.name, text });
  }

  onPickup(player, msg) {
    const inst = player.instance;
    const bag = inst.bags.get(msg.bag);
    if (!bag || dist2(bag.x, bag.y, player.x, player.y) > 4) return;
    const idx = msg.idx | 0;
    const itemId = bag.items[idx];
    if (!itemId) return;
    const slot = player.char.inventory.indexOf(null);
    if (slot === -1) return send(player.ws, { t: 'notice', text: 'Inventario cheio!' });
    player.char.inventory[slot] = itemId;
    bag.items[idx] = null;
    if (bag.items.every(i => !i)) inst.bags.delete(bag.id);
  }

  // slots: 0-3 equipment, 4-11 inventory
  getSlot(player, i) { return i < 4 ? player.char.equipment[i] : player.char.inventory[i - 4]; }
  setSlot(player, i, v) { if (i < 4) player.char.equipment[i] = v; else player.char.inventory[i - 4] = v; }

  canEquip(player, slotIdx, itemId) {
    if (!itemId) return true;
    const item = ITEMS[itemId];
    if (!item) return false;
    const cls = CLASSES[player.char.classId];
    if (slotIdx === 0) return item.type === cls.weapon;
    if (slotIdx === 1) return item.type === cls.ability;
    if (slotIdx === 2) return item.type === cls.armor;
    if (slotIdx === 3) return item.slot === 'ring';
    return true;
  }

  onInvSwap(player, msg) {
    const from = msg.from | 0, to = msg.to | 0;
    if (from < 0 || from > 11 || to < 0 || to > 11 || from === to) return;
    const a = this.getSlot(player, from), b = this.getSlot(player, to);
    if (!this.canEquip(player, to, a) || !this.canEquip(player, from, b)) return;
    this.setSlot(player, from, b);
    this.setSlot(player, to, a);
    player.char.hp = Math.min(player.char.hp, effectiveMaxHp(player));
  }

  // ------------------------------------------------ trade
  requestTrade(player, name) {
    const inst = player.instance;
    if (inst.kind !== 'nexus') return send(player.ws, { t: 'notice', text: 'Trocas apenas no Nexus' });
    const target = [...inst.players.values()].find(p => p !== player && p.name.toLowerCase() === name.toLowerCase());
    if (!target) return send(player.ws, { t: 'notice', text: 'Jogador nao encontrado no Nexus' });
    if (player.trade || target.trade) return send(player.ws, { t: 'notice', text: 'Jogador ocupado em outra troca' });
    if (dist2(player.x, player.y, target.x, target.y) > 64) return send(player.ws, { t: 'notice', text: 'Aproxime-se do jogador para trocar' });
    if (target.tradeInviteTo === player.id) {
      target.tradeInviteTo = 0;
      player.tradeInviteTo = 0;
      return this.openTrade(player, target);
    }
    player.tradeInviteTo = target.id;
    send(player.ws, { t: 'notice', text: `Convite de troca enviado para ${target.name}` });
    send(target.ws, { t: 'chat', from: '', text: `${player.name} quer trocar. Digite /trade ${player.name} para aceitar.`, sys: 1 });
  }

  openTrade(a, b) {
    const s = {
      a, b,
      offer: new Map([[a.id, new Array(8).fill(false)], [b.id, new Array(8).fill(false)]]),
      ok: new Map([[a.id, false], [b.id, false]]),
    };
    a.trade = s; b.trade = s;
    this.sendTrade(s);
  }

  sendTrade(s) {
    for (const [me, them] of [[s.a, s.b], [s.b, s.a]]) {
      send(me.ws, {
        t: 'trade', partner: them.name,
        mine: s.offer.get(me.id),
        theirs: them.char.inventory.map((it, i) => (s.offer.get(them.id)[i] ? it : null)),
        ok: s.ok.get(me.id), theirOk: s.ok.get(them.id),
      });
    }
  }

  onTradeOffer(player, msg) {
    const s = player.trade;
    if (!s || !Array.isArray(msg.slots)) return;
    s.offer.set(player.id, player.char.inventory.map((it, i) => !!(it && msg.slots[i])));
    s.ok.set(s.a.id, false); // any change resets both confirmations
    s.ok.set(s.b.id, false);
    this.sendTrade(s);
  }

  onTradeConfirm(player) {
    const s = player.trade;
    if (!s) return;
    s.ok.set(player.id, true);
    if (s.ok.get(s.a.id) && s.ok.get(s.b.id)) return this.executeTrade(s);
    this.sendTrade(s);
  }

  executeTrade(s) {
    const { a, b } = s;
    const offA = s.offer.get(a.id), offB = s.offer.get(b.id);
    const giveA = a.char.inventory.filter((it, i) => it && offA[i]);
    const giveB = b.char.inventory.filter((it, i) => it && offB[i]);
    const newA = a.char.inventory.map((it, i) => (offA[i] ? null : it));
    const newB = b.char.inventory.map((it, i) => (offB[i] ? null : it));
    if (newA.filter(x => !x).length < giveB.length || newB.filter(x => !x).length < giveA.length) {
      return this.cancelTrade(s, 'Troca cancelada: inventario sem espaco');
    }
    for (const it of giveB) newA[newA.indexOf(null)] = it;
    for (const it of giveA) newB[newB.indexOf(null)] = it;
    a.char.inventory = newA;
    b.char.inventory = newB;
    a.trade = null; b.trade = null;
    for (const p of [a, b]) {
      send(p.ws, { t: 'tradeend', done: 1 });
      send(p.ws, { t: 'notice', text: 'Troca concluida!' });
    }
    save();
  }

  cancelTrade(s, reason) {
    s.a.trade = null; s.b.trade = null;
    for (const p of [s.a, s.b]) {
      send(p.ws, { t: 'tradeend', done: 0 });
      send(p.ws, { t: 'notice', text: reason || 'Troca cancelada' });
    }
  }

  // vault: account-wide storage, only usable near the nexus chest
  nearVault(player) {
    const inst = player.instance;
    if (inst.kind !== 'nexus' || !inst.map.vaultSpot) return false;
    const vs = inst.map.vaultSpot;
    return dist2(vs.x, vs.y, player.x, player.y) < 9;
  }

  vaultOf(acc) {
    if (!acc.vault) acc.vault = new Array(16).fill(null);
    return acc.vault;
  }

  // indexes: 0-3 equipment, 4-11 inventory, 12-27 vault
  onVaultSwap(player, msg) {
    if (!this.nearVault(player)) return;
    const vault = this.vaultOf(player.acc);
    const from = msg.from | 0, to = msg.to | 0;
    if (from < 0 || from > 27 || to < 0 || to > 27 || from === to) return;
    const get = i => i < 12 ? this.getSlot(player, i) : vault[i - 12];
    const set = (i, v) => { if (i < 12) this.setSlot(player, i, v); else vault[i - 12] = v; };
    const a = get(from), b = get(to);
    if (to < 4 && !this.canEquip(player, to, a)) return;
    if (from < 4 && !this.canEquip(player, from, b)) return;
    set(from, b);
    set(to, a);
    player.char.hp = Math.min(player.char.hp, effectiveMaxHp(player));
    save();
  }

  onUseItem(player, msg) {
    const slot = msg.slot | 0;
    if (slot < 4 || slot > 11) return;
    const itemId = this.getSlot(player, slot);
    const item = itemId && ITEMS[itemId];
    if (!item || item.type !== 'consumable') return;
    const ch = player.char;
    const cls = CLASSES[ch.classId];
    if (item.heal) ch.hp = Math.min(effectiveMaxHp(player), ch.hp + item.heal);
    else if (item.restore) ch.mp = Math.min(effectiveMaxMp(player), ch.mp + item.restore);
    else if (item.stat) {
      const s = item.stat;
      const cap = cls.max[s];
      if (ch.stats[s] >= cap) return send(player.ws, { t: 'notice', text: 'Atributo ja esta no maximo!' });
      ch.stats[s] = Math.min(cap, ch.stats[s] + item.amount);
    }
    this.setSlot(player, slot, null);
    save();
  }

  onDropItem(player, msg) {
    const slot = msg.slot | 0;
    if (slot < 0 || slot > 11) return;
    const itemId = this.getSlot(player, slot);
    if (!itemId) return;
    this.setSlot(player, slot, null);
    this.spawnBag(player.instance, player.x, player.y, [itemId]);
  }

  onPortal(player) {
    const inst = player.instance;
    for (const portal of inst.portals.values()) {
      if (dist2(portal.x, portal.y, player.x, player.y) > 4) continue;
      if (portal.kind === 'realm') return this.enterInstance(player, this.realm);
      if (portal.kind === 'nexus') return this.toNexus(player);
      if (portal.kind === 'dungeon') {
        let dest = portal.instanceId && this.instances.get(portal.instanceId);
        if (!dest) {
          const defn = DUNGEONS[portal.dungeon];
          dest = this.createDungeon(portal.dungeon, defn);
          portal.instanceId = dest.id;
        }
        return this.enterInstance(player, dest);
      }
    }
  }

  toNexus(player) {
    if (player.instance !== this.nexus) this.enterInstance(player, this.nexus);
  }

  // ------------------------------------------------ dungeons
  createDungeon(key, defn) {
    const map = generateDungeon(defn, (Math.random() * 1e9) | 0);
    const inst = this.addInstance(new Instance('dungeon', defn.name, map));
    inst.dungeonDef = defn;
    // minions across rooms (skip entry room)
    const rooms = map.rooms.slice(1, -1);
    for (let i = 0; i < defn.minionCount && rooms.length; i++) {
      const r = rooms[Math.floor(Math.random() * rooms.length)];
      const type = defn.minions[Math.floor(Math.random() * defn.minions.length)];
      const x = r.x + 1 + Math.random() * (r.w - 2);
      const y = r.y + 1 + Math.random() * (r.h - 2);
      const e = new Enemy(type, x, y);
      e.leash = 14;
      inst.enemies.set(e.id, e);
    }
    const br = map.bossRoom;
    const boss = new Enemy(defn.boss, br.cx, br.cy);
    boss.leash = Math.max(br.w, br.h);
    inst.enemies.set(boss.id, boss);
    inst.bossId = boss.id;
    return inst;
  }

  // realm closes: everyone inside is summoned to the final castle and a
  // brand-new realm is generated
  closeRealm() {
    const old = this.realm;
    const castle = this.createDungeon('mad_castle', DUNGEONS.mad_castle);
    for (const p of this.players.values()) {
      send(p.ws, { t: 'chat', from: '', text: 'O Reino caiu! O Rei Demente convoca os herois ao seu castelo!', sys: 1 });
    }
    for (const p of [...old.players.values()]) this.enterInstance(p, castle);
    this.realmSeed = (Math.random() * 1e9) | 0;
    this.realm = this.addInstance(new Instance('realm', 'Reino Selvagem', generateRealm(this.realmSeed)));
    this.godKills = 0;
    this.populateRealm();
    this.instances.delete(old.id);
  }

  // ------------------------------------------------ combat helpers
  damageEnemy(inst, enemy, rawDmg, player) {
    const dmg = applyDefense(rawDmg, enemy.def.def);
    enemy.hp -= dmg;
    enemy.damagers.set(player.id, (enemy.damagers.get(player.id) || 0) + dmg);
    inst.broadcastNear({ t: 'dmg', id: enemy.id, n: dmg }, enemy.x, enemy.y);
    if (enemy.hp <= 0) this.killEnemy(inst, enemy);
  }

  killEnemy(inst, enemy) {
    inst.enemies.delete(enemy.id);
    inst.broadcastNear({ t: 'fx', k: 'die', x: enemy.x, y: enemy.y, r: enemy.def.size }, enemy.x, enemy.y);
    // XP for everyone who contributed (full XP each, like the classic)
    for (const pid of enemy.damagers.keys()) {
      const p = this.players.get(pid);
      if (p && !p.dead) this.grantXp(p, enemy.def.xp);
    }
    // loot
    const drops = rollLoot(enemy.def.loot);
    const bagItems = [];
    for (const d of drops) {
      if (d.startsWith('portal:')) {
        const key = d.slice(7);
        const defn = DUNGEONS[key];
        if (defn) this.spawnPortal(inst, enemy.x, enemy.y, 'dungeon', defn.name, key);
      } else bagItems.push(d);
    }
    if (bagItems.length) this.spawnBag(inst, enemy.x, enemy.y, bagItems);
    // realm cycle: enough gods slain -> the realm closes into the final castle
    if (inst === this.realm && enemy.def.god) {
      this.godKills++;
      const left = this.godKillTarget - this.godKills;
      if (left > 0 && left % 5 === 0) {
        inst.broadcast({ t: 'chat', from: '', text: `Os deuses enfraquecem: restam ${left} para o Reino cair!`, sys: 1 });
      }
      if (left <= 0) this.closeRealm();
    }
    // dungeon completion: boss dies -> open a portal back + announce
    if (inst.kind === 'dungeon' && enemy.id === inst.bossId) {
      inst.bossDead = true;
      this.spawnPortal(inst, enemy.x, enemy.y, 'nexus', 'Portal para o Nexus', null, 10 * 60 * 1000);
      inst.broadcast({ t: 'notice', text: `${enemy.def.name} foi derrotado!` });
      inst.broadcast({ t: 'chat', from: '', text: `A masmorra ${inst.name} foi concluida!`, sys: 1 });
    }
  }

  grantXp(player, xp) {
    const ch = player.char;
    ch.fame += Math.ceil(xp / 10);
    if (ch.level >= 20) return;
    ch.xp += xp;
    let leveled = false;
    while (ch.level < 20 && ch.xp >= xpToNext(ch.level)) {
      ch.xp -= xpToNext(ch.level);
      ch.level++;
      leveled = true;
      const g = CLASSES[ch.classId].growth;
      const max = CLASSES[ch.classId].max;
      ch.stats.hp = Math.min(max.hp, ch.stats.hp + g.hp[0] + Math.floor(Math.random() * (g.hp[1] - g.hp[0] + 1)));
      ch.stats.mp = Math.min(max.mp, ch.stats.mp + g.mp[0] + Math.floor(Math.random() * (g.mp[1] - g.mp[0] + 1)));
      for (const s of ['att', 'def', 'spd', 'dex', 'vit', 'wis']) {
        ch.stats[s] = Math.min(max[s], ch.stats[s] + Math.round(g[s] + (Math.random() < (g[s] % 1) ? 1 : 0)));
      }
    }
    if (leveled) {
      ch.hp = effectiveMaxHp(player);
      ch.mp = effectiveMaxMp(player);
      player.instance.broadcastNear({ t: 'fx', k: 'levelup', x: player.x, y: player.y, r: 1 }, player.x, player.y);
      send(player.ws, { t: 'notice', text: `Voce alcancou o nivel ${ch.level}!` });
      save();
    }
  }

  damagePlayer(player, rawDmg, sourceName) {
    const stats = effectiveStats(player);
    const dmg = applyDefense(rawDmg, stats.def);
    player.char.hp -= dmg;
    player.lastHit = Date.now();
    player.instance.broadcastNear({ t: 'dmg', id: player.id, n: dmg }, player.x, player.y);
    if (player.char.hp <= 0) this.killPlayer(player, sourceName);
  }

  killPlayer(player, killedBy) {
    if (player.trade) this.cancelTrade(player.trade);
    player.dead = true;
    const ch = player.char;
    const inst = player.instance;
    inst.broadcast({ t: 'chat', from: '', text: `${player.name} (${CLASSES[ch.classId].name} nv ${ch.level}) morreu para ${killedBy}`, sys: 1 });
    buryCharacter(player.acc, ch, killedBy);
    send(player.ws, {
      t: 'death', killer: killedBy,
      classId: ch.classId, level: ch.level, fame: ch.fame,
    });
    inst.players.delete(player.id);
    this.players.delete(player.id);
  }

  spawnBag(inst, x, y, items) {
    const bag = { id: uid(), x, y, items: items.slice(0, 8), expires: Date.now() + BAG_TTL };
    while (bag.items.length < 8) bag.items.push(null);
    bag.tier = bagTier(items);
    inst.bags.set(bag.id, bag);
  }

  spawnPortal(inst, x, y, kind, name, dungeon, ttl = PORTAL_TTL) {
    const portal = { id: uid(), x, y, kind, name, dungeon, instanceId: null, expires: Date.now() + ttl };
    inst.portals.set(portal.id, portal);
    if (kind === 'dungeon') {
      inst.broadcast({ t: 'chat', from: '', text: `Um portal para ${name} se abriu!`, sys: 1 });
    }
    return portal;
  }

  // ------------------------------------------------ main loop
  tick() {
    const now = Date.now();
    for (const inst of this.instances.values()) {
      if (inst.players.size > 0 || inst.kind !== 'dungeon') this.tickInstance(inst, now);
    }
    if ((this._respawnT = (this._respawnT || 0) + 1) % 40 === 0) this.respawnRealm();
    this.cleanupInstances();
  }

  tickInstance(inst, now) {
    const dt = TICK / 1000;

    // --- players: regen, tile damage
    for (const p of inst.players.values()) {
      const stats = effectiveStats(p);
      const inCombat = now - p.lastHit < 4000;
      const regenMul = inst.kind === 'nexus' ? 10 : (inCombat ? 0.4 : 1);
      p.char.hp = Math.min(effectiveMaxHp(p), p.char.hp + (1 + stats.vit * 0.24) * dt * regenMul);
      p.char.mp = Math.min(effectiveMaxMp(p), p.char.mp + (0.5 + stats.wis * 0.12) * dt * regenMul);
      if (inst.map.damages(p.x, p.y)) {
        if (!p._lavaT || now - p._lavaT > 500) { p._lavaT = now; this.damagePlayer(p, 40, 'lava'); }
        if (p.dead) continue;
      }
    }

    // --- enemies
    if (inst.kind !== 'nexus') {
      for (const e of inst.enemies.values()) this.tickEnemy(inst, e, now, dt);
    }

    // --- projectiles
    const alive = [];
    for (const pr of inst.projectiles) {
      const step = pr.speed * dt;
      pr.x += Math.cos(pr.a) * step;
      pr.y += Math.sin(pr.a) * step;
      pr.left -= step;
      let dead = pr.left <= 0 || inst.map.blocks(pr.x, pr.y);
      if (!dead && pr.friendly) {
        for (const e of inst.enemies.values()) {
          const r = 0.35 + e.def.size * 0.45;
          if (dist2(e.x, e.y, pr.x, pr.y) < r * r) {
            if (pr.hit) { if (pr.hit.has(e.id)) continue; pr.hit.add(e.id); }
            const owner = this.players.get(pr.owner);
            if (owner) {
              const dmg = pr.dmg[0] + Math.floor(Math.random() * (pr.dmg[1] - pr.dmg[0] + 1));
              this.damageEnemy(inst, e, dmg, owner);
            }
            if (!pr.pierce) { dead = true; break; }
          }
        }
      } else if (!dead && !pr.friendly) {
        for (const p of inst.players.values()) {
          if (p.dead) continue;
          if (dist2(p.x, p.y, pr.x, pr.y) < 0.45 * 0.45) {
            this.damagePlayer(p, pr.dmg, pr.src);
            dead = true; break;
          }
        }
      }
      if (!dead) alive.push(pr);
    }
    inst.projectiles = alive;

    // --- expire bags & portals
    for (const [id, bag] of inst.bags) if (now > bag.expires) inst.bags.delete(id);
    for (const [id, portal] of inst.portals) if (now > portal.expires) inst.portals.delete(id);
    // nexus always has a realm portal
    if (inst.kind === 'nexus' && ![...inst.portals.values()].some(o => o.kind === 'realm')) {
      this.spawnPortal(inst, inst.map.portalSpot.x, inst.map.portalSpot.y, 'realm', 'Portal do Reino', null, 1e15);
    }

    // --- snapshots
    this.sendSnapshots(inst);
  }

  tickEnemy(inst, e, now, dt) {
    const d = e.def;
    if (e.stunnedUntil > now) return;
    // find nearest visible player
    let target = null, bestD2 = Infinity;
    for (const p of inst.players.values()) {
      if (p.dead || p.invisUntil > now) continue;
      const dd = dist2(p.x, p.y, e.x, e.y);
      if (dd < bestD2) { bestD2 = dd; target = p; }
    }
    const range = d.shots ? d.shots.range : 2;
    const aggro = 121; // 11 tiles
    const speed = d.speed * dt;

    // movement
    let mx = 0, my = 0;
    if (target && bestD2 < aggro) {
      const a = Math.atan2(target.y - e.y, target.x - e.x);
      if (d.behavior === 'chase' || d.behavior === 'boss') {
        if (bestD2 > (range * 0.5) ** 2) { mx = Math.cos(a) * speed; my = Math.sin(a) * speed; }
      } else if (d.behavior === 'orbit') {
        const want = range * 0.7;
        const dd = Math.sqrt(bestD2);
        const tangent = a + Math.PI / 2;
        mx = Math.cos(tangent) * speed * 0.7 + Math.cos(a) * speed * Math.sign(dd - want) * 0.6;
        my = Math.sin(tangent) * speed * 0.7 + Math.sin(a) * speed * Math.sign(dd - want) * 0.6;
      } else { // wander but drift toward player slowly
        mx = Math.cos(a) * speed * 0.4; my = Math.sin(a) * speed * 0.4;
      }
    } else {
      // escorts stick close to their leader; everyone else wanders
      const leader = e.parentId && inst.enemies.get(e.parentId);
      if (leader && dist2(e.x, e.y, leader.x, leader.y) > 9) {
        const a = Math.atan2(leader.y - e.y, leader.x - e.x);
        mx = Math.cos(a) * speed * 0.9; my = Math.sin(a) * speed * 0.9;
      } else {
        if (now > e.wanderUntil) { e.angle = Math.random() * Math.PI * 2; e.wanderUntil = now + 1000 + Math.random() * 2000; }
        mx = Math.cos(e.angle) * speed * 0.5; my = Math.sin(e.angle) * speed * 0.5;
      }
    }
    // leash dungeons enemies to their room area
    if (e.leash && dist2(e.x + mx, e.y + my, e.spawnX, e.spawnY) > e.leash * e.leash) { mx = -mx; my = -my; }
    const nx = e.x + mx, ny = e.y + my;
    if (!inst.map.blocks(nx, e.y) && inst.map.get(nx, e.y) !== T.WATER) e.x = nx;
    if (!inst.map.blocks(e.x, ny) && inst.map.get(e.x, ny) !== T.WATER) e.y = ny;

    if (!target || bestD2 > aggro) return;

    // melee
    if (d.melee && now > e.nextMelee && bestD2 < 1.2) {
      e.nextMelee = now + 1000 / d.melee.rate;
      this.damagePlayer(target, d.melee.dmg, d.name);
    }
    // shooting (burst: several quick volleys, then the full cooldown)
    if (d.shots && now > e.nextShot && bestD2 < (d.shots.range * 1.1) ** 2) {
      const s = d.shots;
      if (s.burst) {
        e.burstLeft = (e.burstLeft || 0) > 0 ? e.burstLeft - 1 : s.burst - 1;
        e.nextShot = now + (e.burstLeft > 0 ? (s.burstGap || 110) : 1000 / s.rate);
      } else {
        e.nextShot = now + 1000 / s.rate;
      }
      const base = Math.atan2(target.y - e.y, target.x - e.x);
      const angles = [];
      for (let i = 0; i < s.count; i++) {
        const off = s.count > 1 ? (i - (s.count - 1) / 2) * (s.spread / Math.max(1, s.count - 1)) * 2 : 0;
        const a = base + off;
        angles.push(Math.round(a * 1000) / 1000);
        inst.projectiles.push({ friendly: false, x: e.x, y: e.y, a, speed: s.speed, left: s.range, dmg: s.dmg, src: d.name });
      }
      inst.broadcastNear({ t: 'shot', x: e.x, y: e.y, as: angles, spd: s.speed, rg: s.range, k: 'enemy', f: 0, o: e.id }, e.x, e.y);
    }
    // ring attacks (spiral rings rotate a bit each volley)
    if (d.shots && d.shots.ring && now > e.nextRing) {
      e.nextRing = now + 1000 / d.shots.ringRate;
      const s = d.shots;
      const base = s.spiral ? (e.spiralA = (e.spiralA || 0) + 0.37) : 0;
      const angles = [];
      for (let i = 0; i < s.ring; i++) {
        const a = base + (i / s.ring) * Math.PI * 2;
        angles.push(Math.round(a * 1000) / 1000);
        inst.projectiles.push({ friendly: false, x: e.x, y: e.y, a, speed: s.speed * 0.8, left: s.range, dmg: Math.round(s.dmg * 0.8), src: d.name });
      }
      inst.broadcastNear({ t: 'shot', x: e.x, y: e.y, as: angles, spd: s.speed * 0.8, rg: s.range, k: 'enemy', f: 0, o: e.id }, e.x, e.y);
    }
    // boss minion spawns
    if (d.spawns && now > e.nextSpawn) {
      e.nextSpawn = now + 1000 / d.spawns.rate;
      let count = 0;
      for (const o of inst.enemies.values()) if (o.parentId === e.id) count++;
      if (count < d.spawns.max) {
        const m = new Enemy(d.spawns.type, e.x + (Math.random() - 0.5) * 2, e.y + (Math.random() - 0.5) * 2);
        m.parentId = e.id;
        m.leash = e.leash;
        inst.enemies.set(m.id, m);
      }
    }
  }

  sendSnapshots(inst) {
    const now = Date.now();
    for (const p of inst.players.values()) {
      if (p.ws.readyState !== 1) continue;
      const ents = [];
      const r2 = VIEW * VIEW;
      for (const o of inst.players.values()) {
        if (dist2(o.x, o.y, p.x, p.y) > r2) continue;
        ents.push(['p', o.id, o.name, o.classId || o.char.classId, round1(o.x), round1(o.y),
          Math.round(o.char.hp), effectiveMaxHp(o), o.char.level,
          o.invisUntil > now ? 1 : 0]);
      }
      for (const e of inst.enemies.values()) {
        if (dist2(e.x, e.y, p.x, p.y) > r2) continue;
        ents.push(['e', e.id, e.def.sprite || e.type, round1(e.x), round1(e.y), Math.round(e.hp), e.maxHp]);
      }
      for (const b of inst.bags.values()) {
        if (dist2(b.x, b.y, p.x, p.y) > r2) continue;
        ents.push(['b', b.id, round1(b.x), round1(b.y), b.tier, b.items]);
      }
      for (const o of inst.portals.values()) {
        if (dist2(o.x, o.y, p.x, p.y) > r2) continue;
        ents.push(['o', o.id, o.kind, round1(o.x), round1(o.y), o.name]);
      }
      const ch = p.char;
      const self = {
        hp: Math.round(ch.hp), maxHp: effectiveMaxHp(p),
        mp: Math.round(ch.mp), maxMp: effectiveMaxMp(p),
        xp: ch.xp, next: xpToNext(ch.level), level: ch.level, fame: ch.fame,
        stats: effectiveStats(p), eq: ch.equipment, inv: ch.inventory,
      };
      if (this.nearVault(p)) self.vault = this.vaultOf(p.acc);
      send(p.ws, { t: 'tick', e: ents, self });
    }
  }

  autosave() { save(); }
}

function effectiveMaxHp(player) {
  let hp = player.char.stats.hp;
  for (const id of player.char.equipment) {
    const it = id && ITEMS[id];
    if (it && it.bonus && it.bonus.hp) hp += it.bonus.hp;
  }
  return hp;
}
function effectiveMaxMp(player) {
  let mp = player.char.stats.mp;
  for (const id of player.char.equipment) {
    const it = id && ITEMS[id];
    if (it && it.bonus && it.bonus.mp) mp += it.bonus.mp;
  }
  return mp;
}

function round1(n) { return Math.round(n * 10) / 10; }
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

module.exports = { Game };
