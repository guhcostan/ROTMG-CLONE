'use strict';
// Authoritative game simulation: instances (nexus / realm / dungeons),
// enemy AI and bullet patterns, combat, XP/levels, loot and permadeath.
const { CLASSES, ITEMS, ENEMIES, DUNGEONS, STAT_POTS, LEGENDARIES } = require('./data');
const { T, generateNexus, generateTutorial, generateRealm, generateDungeon, bandAt } = require('./world');
const { buryCharacter } = require('./auth');
const storage = require('./db');

const TICK = 1000 / 20;          // 20 ticks/s
const VIEW = 22;                 // entity broadcast radius in tiles
const BAG_TTL = 60 * 1000;       // loot bag lifetime
const PORTAL_TTL = 45 * 1000;

// Negative status effects an enemy bullet can inflict on a player.
// slow: half move speed | paralyze: cannot move | bleed: damage-over-time
// that ignores defense | sick: cannot heal | quiet: no MP regen / abilities |
// weak: halved attack.
const STATUS_KINDS = ['slow', 'paralyze', 'bleed', 'sick', 'quiet', 'weak'];

// Permanent account achievements (codes referenced by awardAchievement).
const ACHIEVEMENTS = {
  first_boss: { name: 'Cacador de Chefes' },
  godslayer: { name: 'Matador de Deuses' },
  dungeoneer: { name: 'Explorador de Masmorras' },
  max_level: { name: 'Nivel Maximo' },
  invader_bane: { name: 'Repelente de Invasoes' },
  tyrant_slayer: { name: 'Algoz do Tirano' },
};

// Daily bounty pool. Three are picked per day (deterministic by day number),
// shared by everyone, and reset each day. Rewards land in the vault.
const BOUNTY_POOL = [
  { type: 'kill_gods', label: 'Mate 3 deuses do Reino', target: 3, reward: ['statpot'] },
  { type: 'kill_bosses', label: 'Derrote 4 chefes', target: 4, reward: ['pot_life'] },
  { type: 'clear_dungeons', label: 'Conclua 2 masmorras', target: 2, reward: ['pot_mana'] },
  { type: 'kill_event', label: 'Repila uma invasao', target: 1, reward: ['statpot'] },
  { type: 'kill_count', label: 'Abata 80 inimigos', target: 80, reward: ['hppot', 'mppot'] },
];
const DAY_MS = 86400000;
const SEASON_MS = 7 * DAY_MS;
// weekly rotating season modifiers (live-ops): one active per week
const SEASON_MODIFIERS = [
  { id: 'xp', name: 'Semana da Experiencia', xpMul: 1.5, fameMul: 1, lootMul: 1 },
  { id: 'loot', name: 'Semana da Pilhagem', xpMul: 1, fameMul: 1, lootMul: 1.4 },
  { id: 'fame', name: 'Semana da Gloria', xpMul: 1, fameMul: 1.5, lootMul: 1 },
];
const currentSeason = () => Math.floor(Date.now() / SEASON_MS);
const seasonModifier = (season) => SEASON_MODIFIERS[((season % SEASON_MODIFIERS.length) + SEASON_MODIFIERS.length) % SEASON_MODIFIERS.length];

// Earnable cosmetics (no purchase): name colors by best fame, titles by achievement.
const COLOR_TIERS = [
  { min: 0, color: '#dddddd', name: 'Comum' },
  { min: 100, color: '#48b048', name: 'Veterano' },
  { min: 500, color: '#4878e0', name: 'Heroico' },
  { min: 1500, color: '#a860d8', name: 'Lendario' },
  { min: 5000, color: '#f0c040', name: 'Mitico' },
];

let nextId = 1;
const uid = () => nextId++;

const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

// ---------------------------------------------------------------- loot
function rollLoot(lootTable, rng, mult = 1) {
  const items = [];
  for (const [spec, chance] of lootTable) {
    if (Math.random() >= chance * mult) continue;
    if (spec === 'statpot') {
      items.push(STAT_POTS[Math.floor(Math.random() * STAT_POTS.length)]);
    } else if (spec === 'legendary') {
      items.push(LEGENDARIES[Math.floor(Math.random() * LEGENDARIES.length)]);
    } else if (spec.startsWith('weapon:') || spec.startsWith('armor:')) {
      const [group, range] = spec.split(':');
      const [lo, hi] = range.split('-').map(Number);
      const tier = lo + Math.floor(Math.random() * (hi - lo + 1));
      const kinds = group === 'weapon'
        ? ['staff', 'bow', 'sword', 'wand', 'dagger', 'katana']
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
  if (player.attBuffUntil > Date.now()) s.att = Math.round(s.att * 1.25);
  if (player.status && player.status.weak > Date.now()) s.att = Math.max(1, Math.round(s.att * 0.5));
  return s;
}

// move multiplier from movement-impairing statuses (paralyze stops, slow halves)
function statusMoveMul(player) {
  if (!player.status) return 1;
  const now = Date.now();
  if (player.status.paralyze > now) return 0;
  if (player.status.slow > now) return 0.5;
  return 1;
}

const PLAYER_MIN_SPEED = 4;       // moveSpeed() at SPD 0
const MOB_SPEED_CAP = 3.9;        // strictly below a 0-SPD player so no mob outruns anyone
function moveSpeed(stats) { return PLAYER_MIN_SPEED + 5.6 * (stats.spd / 75); }     // tiles/s
function fireRate(stats) { return 1.5 + 4.5 * (stats.dex / 75); }    // shots/s
function applyDefense(dmg, def) { return Math.max(Math.ceil(dmg * 0.1), dmg - def); }
// ability damage scales with both ATT and WIS, so caster builds invest in WIS
function abilityMul(stats) { return 0.5 + stats.att / 50 + stats.wis / 60; }

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
    this.shots = d.shots;   // per-enemy so multi-phase bosses can swap pattern
    this.phase = 0;
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
    this.tutorial = this.addInstance(new Instance('tutorial', 'Treinamento', generateTutorial()));
    this.realmSeed = (Math.random() * 1e9) | 0;
    this.realm = this.addInstance(new Instance('realm', 'Reino Selvagem', generateRealm(this.realmSeed)));
    this.godKills = 0;
    this.godKillTarget = 25; // gods slain before the realm closes
    this.eventBossId = null;
    this.nextEvent = Date.now() + 3 * 60 * 1000; // first invasion 3 min after boot
    this.season = currentSeason();
    this.seasonMod = seasonModifier(this.season);
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
    const guild = storage.getGuildOf(acc.id);
    const player = {
      id: uid(), ws, acc, char,
      name: acc.username,
      x: 0, y: 0,
      instance: null,
      lastShot: 0, lastAbility: 0,
      lastHit: 0, lastMoveAt: Date.now(),
      berserkUntil: 0, invisUntil: 0,
      dead: false,
      guild: guild ? { id: guild.id, name: guild.name, rank: guild.rank } : null,
      guildInviteId: null,
      pet: acc.pet || null,
      vault: storage.getVault(acc.id),
      trade: null, tradeReqFrom: null,
      status: {},                       // statusType -> expiresAt (ms)
      kills: 0, godsKilled: 0, dungeons: 0, // fame-bonus counters (per life)
      bounties: this.getDailyBounties(acc.id),
      title: acc.title || null, nameColor: acc.name_color || null,
    };
    this.players.set(player.id, player);
    // first-ever login on this account starts in the tutorial; everyone else in the Nexus
    if (!acc.tutorial_done) { this.enterInstance(player, this.tutorial); this.startTutorial(player); }
    else this.enterInstance(player, this.nexus);
    this.grantDaily(player);
    send(player.ws, { t: 'bounties', list: player.bounties });
    send(player.ws, { t: 'chat', from: '', text: `Temporada ativa: ${this.seasonMod.name}.`, sys: 1 });
    return player;
  }

  // training-room onboarding: drip a few tips; a dummy lets the player practice
  startTutorial(player) {
    const tips = [
      'Bem-vindo! Use WASD ou as setas para se mover.',
      'Segure o botao esquerdo do mouse para atirar. Acerte o boneco de treino.',
      'Aperte ESPACO para usar a habilidade da classe (gasta MP).',
      'Aperte H a qualquer momento para ver todos os controles.',
      'Quando estiver pronto, pise no portal e aperte F para entrar no Nexus.',
    ];
    tips.forEach((text, i) => setTimeout(() => { if (player.ws.readyState === 1) send(player.ws, { t: 'chat', from: '', text, sys: 1 }); }, 800 + i * 2600));
    send(player.ws, { t: 'notice', text: 'Treinamento' });
  }

  // ------------------------------------------------ account progression
  // award a permanent account achievement; notify only the first time
  awardAchievement(player, code) {
    if (!player.acc || !ACHIEVEMENTS[code]) return;
    if (storage.earnAchievement(player.acc.id, code)) {
      send(player.ws, { t: 'notice', text: `Conquista: ${ACHIEVEMENTS[code].name}!` });
      send(player.ws, { t: 'chat', from: '', text: `${player.name} desbloqueou a conquista "${ACHIEVEMENTS[code].name}".`, sys: 1 });
    }
  }

  // cosmetics an account has unlocked (name colors by best fame, titles by achievement)
  cosmeticsFor(accountId) {
    const best = storage.bestFame(accountId);
    const colors = COLOR_TIERS.filter(t => best >= t.min).map(t => ({ color: t.color, name: t.name }));
    const earned = new Set(storage.listAchievements(accountId));
    const titles = ['Aventureiro', ...Object.entries(ACHIEVEMENTS).filter(([c]) => earned.has(c)).map(([, a]) => a.name)];
    const acc = storage.getAccountById(accountId);
    return { titles, colors, current: { title: acc.title || null, color: acc.name_color || null } };
  }

  // validate ownership, then save the chosen title + color
  setCosmetic(accountId, title, color) {
    const { titles, colors } = this.cosmeticsFor(accountId);
    const okTitle = title == null || titles.includes(title);
    const okColor = color == null || colors.some(c => c.color === color);
    if (!okTitle || !okColor) return false;
    storage.setCosmetic(accountId, title || null, color || null);
    for (const p of this.players.values()) if (p.acc && p.acc.id === accountId) {
      p.acc.title = title || null; p.acc.name_color = color || null;
      p.title = title || null; p.nameColor = color || null;
    }
    return true;
  }

  // current season: active modifier, this season's leaderboard, and a hall of fame
  seasonInfo() {
    const s = this.season;
    const hallOfFame = storage.pastSeasons(s)
      .map(ps => ({ season: ps, winner: storage.seasonWinner(ps) }))
      .filter(x => x.winner);
    return {
      season: s, modifier: this.seasonMod.name, modifierId: this.seasonMod.id,
      endsAt: (s + 1) * SEASON_MS,
      leaderboard: storage.seasonLeaderboard(s),
      hallOfFame,
    };
  }

  // build (or fetch) today's three bounties for an account, regenerating at day change
  getDailyBounties(accountId) {
    const today = Math.floor(Date.now() / DAY_MS);
    const row = storage.getBounties(accountId);
    if (row && row.day === today) return row.list;
    // deterministic pick of 3 distinct bounties seeded by the day
    const pool = BOUNTY_POOL.map((b, i) => ({ i, k: (today * 9301 + i * 49297) % 233280 }));
    pool.sort((a, b) => a.k - b.k);
    const list = pool.slice(0, 3).map(({ i }) => ({ type: BOUNTY_POOL[i].type, label: BOUNTY_POOL[i].label, target: BOUNTY_POOL[i].target, reward: BOUNTY_POOL[i].reward, progress: 0, done: false }));
    storage.setBounties(accountId, today, list);
    return list;
  }

  // advance any matching bounty; on completion drop the reward in the vault
  progressBounty(player, type, n = 1) {
    if (!player.bounties) return;
    let changed = false, completed = null;
    for (const b of player.bounties) {
      if (b.done || b.type !== type) continue;
      b.progress = Math.min(b.target, b.progress + n);
      changed = true;
      if (b.progress >= b.target) { b.done = true; completed = b; }
    }
    if (!changed) return;
    if (completed) {
      const vault = player.vault;
      for (const it of completed.reward) { const i = vault.indexOf(null); if (i !== -1) vault[i] = it; }
      storage.setVault(player.acc.id, vault);
      send(player.ws, { t: 'notice', text: `Missao diaria concluida: ${completed.label}!` });
      send(player.ws, { t: 'chat', from: '', text: `Recompensa da missao no cofre: ${completed.label}.`, sys: 1 });
    }
    storage.setBounties(player.acc.id, Math.floor(Date.now() / DAY_MS), player.bounties);
    send(player.ws, { t: 'bounties', list: player.bounties });
  }

  // once per day: a vault reward that grows with the login streak
  grantDaily(player) {
    const { claimed, streak } = storage.claimDaily(player.acc.id);
    if (!claimed) return;
    const reward = ['hppot', 'mppot'];
    if (streak % 3 === 0) reward.push(STAT_POTS[Math.floor(Math.random() * STAT_POTS.length)]);
    if (streak % 7 === 0) reward.push('pet_egg');
    const vault = player.vault;
    for (const it of reward) { const i = vault.indexOf(null); if (i !== -1) vault[i] = it; }
    storage.setVault(player.acc.id, vault);
    send(player.ws, { t: 'notice', text: `Recompensa diaria (sequencia ${streak})! Veja o cofre.` });
  }

  // ------------------------------------------------ status effects
  applyStatus(player, type, dur) {
    if (!STATUS_KINDS.includes(type)) return;
    const now = Date.now();
    // paralyze (full immobilize) can't be chained: brief immunity after it ends,
    // so a wide bullet ring can't perma-lock a player to death
    if (type === 'paralyze') {
      if (now < (player.paralyzeImmuneUntil || 0)) return;
      player.paralyzeImmuneUntil = now + dur + 1500;
    }
    player.status[type] = Math.max(player.status[type] || 0, now + dur);
    player.instance.broadcastNear({ t: 'fx', k: 'status', x: player.x, y: player.y, r: 1, s: type }, player.x, player.y);
  }

  cleanseStatus(player) {
    let any = false;
    for (const k of STATUS_KINDS) if (player.status[k]) { delete player.status[k]; any = true; }
    return any;
  }

  activeStatus(player) {
    const now = Date.now();
    const out = {};
    for (const k of STATUS_KINDS) {
      const left = (player.status[k] || 0) - now;
      if (left > 0) out[k] = left; else if (player.status[k]) delete player.status[k];
    }
    return out;
  }

  persist(player) {
    if (!player.dead) storage.saveChar(player.char);
  }

  enterInstance(player, inst, spot) {
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
    this.cancelTrade(player, true);
    if (player.instance) player.instance.players.delete(player.id);
    this.players.delete(player.id);
    this.persist(player);
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
      case 'useitem': this.onUseItem(player, msg); break;
      case 'dropitem': this.onDropItem(player, msg); break;
      case 'portal': this.onPortal(player); break;
      case 'nexus': this.toNexus(player); break;
      case 'vault': this.onVault(player, msg); break;
      case 'trade': this.onTrade(player, msg); break;
    }
  }

  // ------------------------------------------------ vault (nexus chest)
  nearVault(player) {
    const inst = player.instance;
    if (inst.kind !== 'nexus' || !inst.map.vaultSpot) return false;
    return dist2(player.x, player.y, inst.map.vaultSpot.x, inst.map.vaultSpot.y) < 4;
  }

  onVault(player, msg) {
    if (!this.nearVault(player)) return;
    if (msg.cmd === 'deposit') {
      const slot = msg.slot | 0;
      if (slot < 4 || slot > 11) return; // inventory slots only
      const itemId = this.getSlot(player, slot);
      if (!itemId) return;
      const free = player.vault.indexOf(null);
      if (free === -1) return send(player.ws, { t: 'notice', text: 'Cofre cheio!' });
      player.vault[free] = itemId;
      this.setSlot(player, slot, null);
    } else if (msg.cmd === 'withdraw') {
      const idx = msg.idx | 0;
      if (idx < 0 || idx > 15) return;
      const itemId = player.vault[idx];
      if (!itemId) return;
      const free = player.char.inventory.indexOf(null);
      if (free === -1) return send(player.ws, { t: 'notice', text: 'Inventario cheio!' });
      player.char.inventory[free] = itemId;
      player.vault[idx] = null;
    } else return;
    storage.setVault(player.acc.id, player.vault);
    this.persist(player);
  }

  // ------------------------------------------------ trading
  onTrade(player, msg) {
    switch (msg.cmd) {
      case 'request': {
        const name = String(msg.name || '').toLowerCase();
        const target = [...player.instance.players.values()]
          .find(p => p !== player && p.name.toLowerCase() === name);
        if (!target) return send(player.ws, { t: 'notice', text: 'Jogador nao encontrado aqui' });
        if (target.trade) return send(player.ws, { t: 'notice', text: 'Jogador ja esta negociando' });
        target.tradeReqFrom = player.id;
        send(target.ws, { t: 'tradereq', from: player.name });
        send(player.ws, { t: 'notice', text: `Proposta de troca enviada para ${target.name}` });
        break;
      }
      case 'accept': {
        const from = this.players.get(player.tradeReqFrom);
        player.tradeReqFrom = null;
        if (!from || from.dead || from.instance !== player.instance) return;
        if (from.trade || player.trade) return;
        if (dist2(from.x, from.y, player.x, player.y) > 64) {
          return send(player.ws, { t: 'notice', text: 'Muito longe para negociar' });
        }
        from.trade = { partnerId: player.id, offer: [], confirmed: false };
        player.trade = { partnerId: from.id, offer: [], confirmed: false };
        this.sendTradeState(from);
        this.sendTradeState(player);
        break;
      }
      case 'offer': {
        if (!player.trade) return;
        const slots = Array.isArray(msg.slots) ? msg.slots : [];
        const offer = [];
        for (const s of slots) {
          const i = s | 0;
          if (i >= 0 && i < 8 && player.char.inventory[i] && !offer.includes(i)) offer.push(i);
        }
        player.trade.offer = offer;
        player.trade.confirmed = false;
        const partner = this.players.get(player.trade.partnerId);
        if (partner && partner.trade) partner.trade.confirmed = false;
        this.sendTradeState(player);
        if (partner) this.sendTradeState(partner);
        break;
      }
      case 'confirm': {
        if (!player.trade) return;
        player.trade.confirmed = true;
        const partner = this.players.get(player.trade.partnerId);
        if (!partner || !partner.trade) return this.cancelTrade(player, true);
        if (partner.trade.confirmed) this.executeTrade(player, partner);
        else { this.sendTradeState(player); this.sendTradeState(partner); }
        break;
      }
      case 'cancel': this.cancelTrade(player, true); break;
    }
  }

  sendTradeState(player) {
    if (!player.trade) return;
    const partner = this.players.get(player.trade.partnerId);
    if (!partner || !partner.trade) return;
    send(player.ws, {
      t: 'tradestate',
      partner: partner.name,
      mine: player.trade.offer,
      theirs: partner.trade.offer.map(i => partner.char.inventory[i]),
      myConfirm: player.trade.confirmed,
      theirConfirm: partner.trade.confirmed,
    });
  }

  executeTrade(a, b) {
    const itemsA = a.trade.offer.map(i => a.char.inventory[i]).filter(Boolean);
    const itemsB = b.trade.offer.map(i => b.char.inventory[i]).filter(Boolean);
    const freeA = a.char.inventory.filter(x => !x).length + itemsA.length;
    const freeB = b.char.inventory.filter(x => !x).length + itemsB.length;
    if (freeA < itemsB.length || freeB < itemsA.length) {
      send(a.ws, { t: 'notice', text: 'Inventario sem espaco para a troca' });
      send(b.ws, { t: 'notice', text: 'Inventario sem espaco para a troca' });
      return this.cancelTrade(a, true);
    }
    for (const i of a.trade.offer) a.char.inventory[i] = null;
    for (const i of b.trade.offer) b.char.inventory[i] = null;
    for (const item of itemsB) a.char.inventory[a.char.inventory.indexOf(null)] = item;
    for (const item of itemsA) b.char.inventory[b.char.inventory.indexOf(null)] = item;
    a.trade = null; b.trade = null;
    this.persist(a); this.persist(b);
    send(a.ws, { t: 'tradedone' });
    send(b.ws, { t: 'tradedone' });
  }

  cancelTrade(player, notifyPartner) {
    if (!player.trade) return;
    const partner = this.players.get(player.trade.partnerId);
    player.trade = null;
    send(player.ws, { t: 'tradecancel' });
    if (partner && partner.trade && partner.trade.partnerId === player.id) {
      partner.trade = null;
      if (notifyPartner) send(partner.ws, { t: 'tradecancel' });
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
    const mm = statusMoveMul(player);
    const maxD = mm <= 0 ? 0.06 : moveSpeed(stats) * mm * dt * 1.6 + 0.3; // lenient anti-speed cap
    const d = Math.hypot(x - player.x, y - player.y);
    if (d > maxD) return; // reject teleport-like moves
    if (inst.tileBlocked(x, y)) return;
    player.x = x; player.y = y;
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
    if (player.status && player.status.quiet > now) {
      return send(player.ws, { t: 'notice', text: 'Silenciado! Nao pode usar habilidades.' });
    }
    const stats = effectiveStats(player);
    if (player.char.mp < item.mpCost) return;
    const tx = Number(msg.x), ty = Number(msg.y);
    if (!isFinite(tx) || !isFinite(ty)) return;
    player.lastAbility = now;
    player.char.mp -= item.mpCost;
    const pw = item.power;
    switch (item.type) {
      case 'spell': { // AOE frost nova at cursor: damage + slow, radius grows with power
        if (inst.kind === 'nexus') break;
        const dmg = Math.round((70 * pw) * abilityMul(stats));
        const r2 = 9 + pw; // radius scales slightly with tier
        for (const e of inst.enemies.values()) {
          if (dist2(e.x, e.y, tx, ty) < r2) { this.damageEnemy(inst, e, dmg, player); e.slowedUntil = now + 2000; }
        }
        inst.broadcastNear({ t: 'fx', k: 'nova', x: tx, y: ty, r: Math.sqrt(r2) }, tx, ty);
        break;
      }
      case 'quiver': { // fan of heavy piercing arrows (more arrows at higher tier)
        if (inst.kind === 'nexus') break;
        const a0 = Math.atan2(ty - player.y, tx - player.x);
        const dmg = Math.round((110 * pw) * abilityMul(stats));
        const count = 1 + Math.floor(pw); // tier 0 -> 2 arrows, scales up
        const angles = [];
        for (let i = 0; i < count; i++) {
          const a = a0 + (i - (count - 1) / 2) * 0.12;
          angles.push(Math.round(a * 1000) / 1000);
          inst.projectiles.push({ owner: player.id, friendly: true, x: player.x, y: player.y, a, speed: 18, left: 9, dmg: [dmg, dmg], pierce: true, hit: new Set() });
        }
        inst.broadcastNear({ t: 'shot', x: player.x, y: player.y, as: angles, spd: 18, rg: 9, k: 'heavyarrow', f: 1, o: player.id }, player.x, player.y);
        break;
      }
      case 'helm': // berserk: faster fire + move speed (via effectiveStats)
        player.berserkUntil = now + 4000 + pw * 1000;
        inst.broadcastNear({ t: 'fx', k: 'buff', x: player.x, y: player.y, r: 1 }, player.x, player.y);
        break;
      case 'tome': { // heal self + nearby allies, and cleanse their statuses
        const heal = Math.round(80 * pw + stats.wis * 1.5);
        for (const p of inst.players.values()) {
          if (dist2(p.x, p.y, player.x, player.y) < 36) {
            const max = effectiveMaxHp(p);
            if (!(p.status && p.status.sick > now)) {
              p.char.hp = Math.min(max, p.char.hp + heal);
              inst.broadcastNear({ t: 'dmg', id: p.id, n: -heal }, p.x, p.y);
            }
            this.cleanseStatus(p);
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
        const dmg = Math.round((90 * pw) * abilityMul(stats));
        for (const e of inst.enemies.values()) {
          if (dist2(e.x, e.y, player.x, player.y) < 12.25) {
            this.damageEnemy(inst, e, dmg, player);
            if (e.def.behavior !== 'boss') e.stunnedUntil = now + 2000 + pw * 400;
          }
        }
        inst.broadcastNear({ t: 'fx', k: 'nova', x: player.x, y: player.y, r: 3.5 }, player.x, player.y);
        break;
      }
      // ---- advanced-class abilities ----
      case 'skull': { // Necromancer: AoE drain at cursor, heals self for part of it (lifesteal scales with WIS)
        if (inst.kind === 'nexus') break;
        const dmg = Math.round((85 * pw) * abilityMul(stats));
        let dealt = 0;
        for (const e of inst.enemies.values()) {
          if (dist2(e.x, e.y, tx, ty) < 12.25) { this.damageEnemy(inst, e, dmg, player); dealt += dmg; }
        }
        if (dealt > 0) {
          const leech = Math.round(dealt * (0.12 + stats.wis / 400));
          player.char.hp = Math.min(effectiveMaxHp(player), player.char.hp + leech);
          inst.broadcastNear({ t: 'dmg', id: player.id, n: -leech }, player.x, player.y);
        }
        inst.broadcastNear({ t: 'fx', k: 'nova', x: tx, y: ty, r: 3.5 }, tx, ty);
        break;
      }
      case 'trap': { // Huntress: AoE damage + slow at cursor
        if (inst.kind === 'nexus') break;
        const dmg = Math.round((100 * pw) * abilityMul(stats));
        for (const e of inst.enemies.values()) {
          if (dist2(e.x, e.y, tx, ty) < 9) {
            this.damageEnemy(inst, e, dmg, player);
            e.slowedUntil = now + 3000;
          }
        }
        inst.broadcastNear({ t: 'fx', k: 'nova', x: tx, y: ty, r: 3 }, tx, ty);
        break;
      }
      case 'seal': { // Paladin: heal + attack buff aura for nearby allies
        const heal = Math.round(60 * pw + stats.wis);
        for (const p of inst.players.values()) {
          if (dist2(p.x, p.y, player.x, player.y) < 36) {
            if (!(p.status && p.status.sick > now)) {
              p.char.hp = Math.min(effectiveMaxHp(p), p.char.hp + heal);
              inst.broadcastNear({ t: 'dmg', id: p.id, n: -heal }, p.x, p.y);
            }
            p.attBuffUntil = now + 4000 + pw * 800;
          }
        }
        inst.broadcastNear({ t: 'fx', k: 'buff', x: player.x, y: player.y, r: 6 }, player.x, player.y);
        break;
      }
      case 'orb': { // Mystic: stasis — stun a cluster of enemies at cursor
        if (inst.kind === 'nexus') break;
        for (const e of inst.enemies.values()) {
          if (dist2(e.x, e.y, tx, ty) < 12.25 && e.def.behavior !== 'boss') {
            e.stunnedUntil = now + 3000 + pw * 800;
          }
        }
        inst.broadcastNear({ t: 'fx', k: 'status', x: tx, y: ty, r: 3.5, s: 'paralyze' }, tx, ty);
        break;
      }
      case 'prism': { // Trickster: blink toward cursor
        const a = Math.atan2(ty - player.y, tx - player.x);
        const want = Math.min(Math.hypot(tx - player.x, ty - player.y), 6);
        let nx = player.x, ny = player.y;
        for (let d = 0.5; d <= want; d += 0.5) {
          const cx = player.x + Math.cos(a) * d, cy = player.y + Math.sin(a) * d;
          if (inst.tileBlocked(cx, cy)) break;
          nx = cx; ny = cy;
        }
        inst.broadcastNear({ t: 'fx', k: 'vanish', x: player.x, y: player.y, r: 1 }, player.x, player.y);
        player.x = nx; player.y = ny;
        send(player.ws, { t: 'blink', x: nx, y: ny });
        inst.broadcastNear({ t: 'fx', k: 'vanish', x: nx, y: ny, r: 1 }, nx, ny);
        break;
      }
      case 'wakizashi': { // Samurai: strike + expose enemies (they take +25% dmg)
        if (inst.kind === 'nexus') break;
        const dmg = Math.round((70 * pw) * abilityMul(stats));
        for (const e of inst.enemies.values()) {
          if (dist2(e.x, e.y, tx, ty) < 9) {
            this.damageEnemy(inst, e, dmg, player);
            e.exposedUntil = now + 4000;
          }
        }
        inst.broadcastNear({ t: 'fx', k: 'status', x: tx, y: ty, r: 3, s: 'weak' }, tx, ty);
        break;
      }
    }
  }

  onChat(player, msg) {
    const text = String(msg.text || '').slice(0, 200).trim();
    if (!text) return;
    if (text === '/nexus') return this.toNexus(player);
    if (text === '/who') {
      const names = [...player.instance.players.values()].map(p => p.name).join(', ');
      return this.sysMsg(player, `Online aqui: ${names}`);
    }
    if (text.startsWith('/trade ')) {
      return this.onTrade(player, { cmd: 'request', name: text.slice(7).trim() });
    }
    if (text.startsWith('/g ')) return this.guildChat(player, text.slice(3));
    if (text.startsWith('/guilda')) return this.guildCommand(player, text.split(/\s+/).slice(1));
    player.instance.broadcast({ t: 'chat', from: player.name, text });
  }

  sysMsg(player, text) { send(player.ws, { t: 'chat', from: '', text, sys: 1 }); }

  guildChat(player, text) {
    if (!player.guild) return this.sysMsg(player, 'Voce nao esta em uma guilda');
    text = text.slice(0, 200).trim();
    if (!text) return;
    for (const p of this.players.values()) {
      if (p.guild && p.guild.id === player.guild.id) {
        send(p.ws, { t: 'chat', from: `[${player.guild.name}] ${player.name}`, text });
      }
    }
  }

  guildCommand(player, args) {
    const sub = (args[0] || '').toLowerCase();
    const acc = player.acc;
    if (sub === 'criar') {
      const name = args.slice(1).join(' ').trim();
      if (player.guild) return this.sysMsg(player, 'Voce ja esta em uma guilda');
      if (!/^[a-zA-Z0-9_ ]{3,20}$/.test(name)) return this.sysMsg(player, 'Nome de guilda invalido (3-20 caracteres)');
      if (storage.getGuildByName(name)) return this.sysMsg(player, 'Ja existe uma guilda com esse nome');
      const id = storage.createGuild(name, acc.id);
      player.guild = { id, name, rank: 'leader' };
      return this.sysMsg(player, `Guilda "${name}" criada! Convide com /guilda convidar <usuario>`);
    }
    if (sub === 'convidar') {
      if (!player.guild) return this.sysMsg(player, 'Voce nao esta em uma guilda');
      if (player.guild.rank !== 'leader') return this.sysMsg(player, 'Apenas o lider convida');
      const name = (args[1] || '').toLowerCase();
      const target = [...this.players.values()].find(p => p.name.toLowerCase() === name);
      if (!target) return this.sysMsg(player, 'Jogador nao esta online');
      if (target.guild) return this.sysMsg(player, 'Jogador ja tem guilda');
      target.guildInviteId = player.guild.id;
      this.sysMsg(target, `${player.name} convidou voce para a guilda "${player.guild.name}". Digite /guilda aceitar`);
      return this.sysMsg(player, 'Convite enviado');
    }
    if (sub === 'aceitar') {
      if (player.guild) return this.sysMsg(player, 'Voce ja esta em uma guilda');
      if (!player.guildInviteId) return this.sysMsg(player, 'Nenhum convite pendente');
      try { storage.joinGuild(player.guildInviteId, acc.id); } catch { return this.sysMsg(player, 'Convite invalido'); }
      const g = storage.getGuildOf(acc.id);
      player.guild = g ? { id: g.id, name: g.name, rank: g.rank } : null;
      player.guildInviteId = null;
      if (player.guild) this.guildChat(player, 'entrou na guilda!');
      return;
    }
    if (sub === 'sair') {
      if (!player.guild) return this.sysMsg(player, 'Voce nao esta em uma guilda');
      storage.leaveGuild(acc.id);
      this.sysMsg(player, `Voce saiu da guilda "${player.guild.name}"`);
      player.guild = null;
      return;
    }
    if (sub === 'info') {
      if (!player.guild) return this.sysMsg(player, 'Voce nao esta em uma guilda');
      const members = storage.guildMembers(player.guild.id)
        .map(m => `${m.username}${m.rank === 'leader' ? ' (lider)' : ''}`).join(', ');
      return this.sysMsg(player, `Guilda "${player.guild.name}": ${members}`);
    }
    this.sysMsg(player, 'Comandos: /guilda criar <nome> | convidar <usuario> | aceitar | sair | info — chat: /g <msg>');
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
    else if (item.pet) {
      const types = ['pet_wolf', 'pet_imp', 'pet_sprite'];
      player.pet = types[Math.floor(Math.random() * types.length)];
      storage.setPet(player.acc.id, player.pet);
      send(player.ws, { t: 'notice', text: 'O ovo chocou! Um pet agora segue voce (cura ao longo do tempo).' });
    }
    else if (item.stat) {
      const s = item.stat;
      const cap = cls.max[s];
      if (ch.stats[s] >= cap) return send(player.ws, { t: 'notice', text: 'Atributo ja esta no maximo!' });
      ch.stats[s] = Math.min(cap, ch.stats[s] + item.amount);
    }
    this.setSlot(player, slot, null);
    this.persist(player);
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
      if (portal.kind === 'tutorial') { this.enterInstance(player, this.tutorial); return this.startTutorial(player); }
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
    // leaving the tutorial for the first time marks it complete for the account
    if (player.instance === this.tutorial && !player.acc.tutorial_done) {
      player.acc.tutorial_done = 1;
      storage.setTutorialDone(player.acc.id);
    }
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
    if (enemy.exposedUntil > Date.now()) rawDmg = Math.round(rawDmg * 1.25); // Samurai expose
    const dmg = applyDefense(rawDmg, enemy.def.def);
    enemy.hp -= dmg;
    enemy.damagers.set(player.id, (enemy.damagers.get(player.id) || 0) + dmg);
    inst.broadcastNear({ t: 'dmg', id: enemy.id, n: dmg }, enemy.x, enemy.y);
    if (enemy.hp <= 0) this.killEnemy(inst, enemy);
  }

  killEnemy(inst, enemy) {
    inst.enemies.delete(enemy.id);
    inst.broadcastNear({ t: 'fx', k: 'die', x: enemy.x, y: enemy.y, r: enemy.def.size }, enemy.x, enemy.y);
    // XP for everyone who contributed OR is standing nearby (classic co-op:
    // stand near someone killing bosses and you level up fast). Full XP each.
    const d0 = enemy.def;
    const XP_RANGE2 = 15 * 15;
    const recipients = new Set(enemy.damagers.keys());
    for (const p of inst.players.values()) {
      if (!p.dead && dist2(p.x, p.y, enemy.x, enemy.y) < XP_RANGE2) recipients.add(p.id);
    }
    for (const pid of recipients) {
      const p = this.players.get(pid);
      if (p && !p.dead) {
        this.grantXp(p, d0.xp);
        p.kills++;
        if (d0.god) p.godsKilled++;
        // account achievements for notable kills
        if (d0.behavior === 'boss') this.awardAchievement(p, 'first_boss');
        if (d0.god) this.awardAchievement(p, 'godslayer');
        if (d0.event) this.awardAchievement(p, 'invader_bane');
        if (enemy.type === 'the_tyrant') this.awardAchievement(p, 'tyrant_slayer');
        // daily bounty progress
        if (d0.xp > 0) this.progressBounty(p, 'kill_count');
        if (d0.behavior === 'boss') this.progressBounty(p, 'kill_bosses');
        if (d0.god) this.progressBounty(p, 'kill_gods');
        if (d0.event) this.progressBounty(p, 'kill_event');
      }
    }
    // loot
    const drops = rollLoot(enemy.def.loot, null, this.seasonMod.lootMul);
    const bagItems = [];
    for (const d of drops) {
      if (d.startsWith('portal:')) {
        const key = d.slice(7);
        const defn = DUNGEONS[key];
        if (defn) this.spawnPortal(inst, enemy.x, enemy.y, 'dungeon', defn.name, key);
      } else bagItems.push(d);
    }
    if (bagItems.length) this.spawnBag(inst, enemy.x, enemy.y, bagItems);
    // world-event boss defeated: announce + clear so the next can spawn
    if (enemy.def.event && enemy.id === this.eventBossId) {
      this.eventBossId = null;
      inst.broadcast({ t: 'notice', text: `${enemy.def.name} foi repelido!` });
      inst.broadcast({ t: 'chat', from: '', text: `A invasao foi repelida! ${enemy.def.name} caiu.`, sys: 1 });
    }
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
      for (const p of inst.players.values()) if (!p.dead) { p.dungeons++; this.awardAchievement(p, 'dungeoneer'); this.progressBounty(p, 'clear_dungeons'); }
      this.spawnPortal(inst, enemy.x, enemy.y, 'nexus', 'Portal para o Nexus', null, 10 * 60 * 1000);
      inst.broadcast({ t: 'notice', text: `${enemy.def.name} foi derrotado!` });
      inst.broadcast({ t: 'chat', from: '', text: `A masmorra ${inst.name} foi concluida!`, sys: 1 });
      // the Mad King's defeat opens the secret path to the Tyrant's Sanctum
      if (enemy.type === 'mad_king') {
        this.spawnPortal(inst, enemy.x + 2, enemy.y, 'dungeon', DUNGEONS.tyrant_sanctum.name, 'tyrant_sanctum', 5 * 60 * 1000);
        inst.broadcast({ t: 'chat', from: '', text: 'Um portal sombrio se abre... O Tirano aguarda os corajosos.', sys: 1 });
      }
    }
  }

  grantXp(player, xp) {
    const ch = player.char;
    xp = Math.round(xp * this.seasonMod.xpMul);
    ch.fame += Math.ceil(xp / 10 * this.seasonMod.fameMul);
    if (player.acc) storage.recordSeasonFame(player.acc.id, this.season, ch.fame);
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
      if (ch.level >= 20) this.awardAchievement(player, 'max_level');
      this.persist(player);
    }
  }

  damagePlayer(player, rawDmg, sourceName) {
    const stats = effectiveStats(player);
    this.hurtPlayer(player, applyDefense(rawDmg, stats.def), sourceName);
  }

  // applies already-resolved damage (defense ignored); used by bleed/lava too
  hurtPlayer(player, dmg, sourceName) {
    if (player.dead || dmg <= 0) return;
    player.char.hp -= dmg;
    player.lastHit = Date.now();
    player.instance.broadcastNear({ t: 'dmg', id: player.id, n: dmg }, player.x, player.y);
    if (player.char.hp <= 0) this.killPlayer(player, sourceName);
  }

  // fame awarded for achievements at the moment of death (classic-style)
  fameBonuses(player) {
    const ch = player.char;
    const max = CLASSES[ch.classId].max;
    let maxed = 0;
    for (const s of ['hp', 'mp', 'att', 'def', 'spd', 'dex', 'vit', 'wis']) {
      if (ch.stats[s] >= max[s]) maxed++;
    }
    let highTier = 0;
    for (const id of ch.equipment) { const it = id && ITEMS[id]; if (it && it.tier >= 5) highTier++; }
    const list = [
      ['Matador', Math.floor(player.kills / 10)],
      ['Inimigo dos Deuses', player.godsKilled * 10],
      ['Explorador de Masmorras', player.dungeons * 15],
      ['Atributos no Maximo', maxed * 20],
      ['Bem Equipado', highTier * 8],
      ['Nivel Maximo', ch.level >= 20 ? 25 : 0],
    ];
    return list.filter(([, v]) => v > 0).map(([label, value]) => ({ label, value }));
  }

  killPlayer(player, killedBy) {
    player.dead = true;
    const ch = player.char;
    const inst = player.instance;
    const baseFame = ch.fame;
    const bonuses = this.fameBonuses(player);
    const bonusFame = bonuses.reduce((s, b) => s + b.value, 0);
    ch.fame = baseFame + bonusFame;
    if (player.acc) storage.recordSeasonFame(player.acc.id, this.season, ch.fame);
    inst.broadcast({ t: 'chat', from: '', text: `${player.name} (${CLASSES[ch.classId].name} nv ${ch.level}) morreu para ${killedBy}`, sys: 1 });
    buryCharacter(player.acc, ch, killedBy);
    send(player.ws, {
      t: 'death', killer: killedBy,
      classId: ch.classId, level: ch.level,
      fame: ch.fame, baseFame, bonusFame, bonuses,
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
    if ((this._respawnT = (this._respawnT || 0) + 1) % 40 === 0) {
      this.respawnRealm();
      const s = currentSeason();
      if (s !== this.season) { // week rolled over: new season + modifier
        this.season = s; this.seasonMod = seasonModifier(s);
        this.nexus.broadcast({ t: 'chat', from: '', text: `Nova temporada: ${this.seasonMod.name}!`, sys: 1 });
      }
    }
    this.maybeWorldEvent(now);
    this.cleanupInstances();
  }

  // timed realm invasion: a named boss spawns; killing it drops a guaranteed
  // white bag (legendary). One active at a time. ponytail: fixed 8-min cadence.
  maybeWorldEvent(now) {
    if (this.eventBossId && !this.realm.enemies.has(this.eventBossId)) this.eventBossId = null;
    if (this.eventBossId || now < this.nextEvent) return;
    if (this.realm.players.size === 0) { this.nextEvent = now + 30000; return; } // wait for players
    this.triggerWorldEvent();
    this.nextEvent = now + 8 * 60 * 1000;
  }

  triggerWorldEvent() {
    const types = ['invader_warlord', 'invader_archmage'];
    const type = types[Math.floor(Math.random() * types.length)];
    const m = this.realm.map;
    let x = m.center.x, y = m.center.y;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, r = m.maxR * (0.4 + Math.random() * 0.2);
      const tx = m.center.x + Math.cos(a) * r, ty = m.center.y + Math.sin(a) * r;
      if (!m.blocks(tx, ty) && m.get(tx, ty) !== T.WATER && m.get(tx, ty) !== T.LAVA) { x = tx; y = ty; break; }
    }
    const e = this.spawnEnemy(this.realm, type, x, y);
    this.eventBossId = e.id;
    this.realm.broadcast({ t: 'notice', text: `INVASAO: ${e.def.name}!` });
    this.realm.broadcast({ t: 'chat', from: '', text: `${e.def.name} invadiu o Reino! Derrote-o por um item lendario. (siga a bussola)`, sys: 1 });
    return e;
  }

  tickInstance(inst, now) {
    const dt = TICK / 1000;

    // --- players: regen, tile damage, trade proximity
    for (const p of inst.players.values()) {
      const stats = effectiveStats(p);
      const inCombat = now - p.lastHit < 4000;
      const regenMul = inst.kind === 'nexus' ? 10 : (inCombat ? 0.4 : 1);
      const petBonus = p.pet ? 1.3 : 1;
      const sick = p.status.sick > now;     // no HP recovery
      const quiet = p.status.quiet > now;   // no MP recovery
      if (!sick) p.char.hp = Math.min(effectiveMaxHp(p), p.char.hp + (1 + stats.vit * 0.24) * dt * regenMul * petBonus);
      if (!quiet) p.char.mp = Math.min(effectiveMaxMp(p), p.char.mp + (0.5 + stats.wis * 0.12) * dt * regenMul * petBonus);
      if (p.status.bleed > now) {
        // scale with max HP so bleed isn't a death sentence on low-level characters
        if (!p._bleedT || now - p._bleedT >= 500) { p._bleedT = now; this.hurtPlayer(p, Math.max(6, Math.round(effectiveMaxHp(p) * 0.012)), 'sangramento'); }
        if (p.dead) continue;
      }
      if (inst.map.damages(p.x, p.y)) {
        if (!p._lavaT || now - p._lavaT > 500) { p._lavaT = now; this.damagePlayer(p, 40, 'lava'); }
        if (p.dead) continue;
      }
      // cancel trades when players walk apart or change instance
      if (p.trade) {
        const partner = this.players.get(p.trade.partnerId);
        if (!partner || partner.instance !== inst || dist2(p.x, p.y, partner.x, partner.y) > 100) {
          this.cancelTrade(p, true);
        }
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
            if (!p.dead && pr.status && Math.random() < (pr.status.chance ?? 1)) {
              this.applyStatus(p, pr.status.type, pr.status.dur);
            }
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
    // nexus always offers the realm portal and a tutorial replay portal
    if (inst.kind === 'nexus') {
      const kinds = new Set([...inst.portals.values()].map(p => p.kind));
      if (!kinds.has('realm')) this.spawnPortal(inst, inst.map.portalSpot.x, inst.map.portalSpot.y, 'realm', 'Portal do Reino', null, 1e15);
      if (!kinds.has('tutorial')) this.spawnPortal(inst, inst.map.vaultSpot.x, inst.map.vaultSpot.y - 4, 'tutorial', 'Treinamento', null, 1e15);
    }
    // tutorial room keeps an exit portal and a training dummy available
    if (inst === this.tutorial) {
      if (![...inst.portals.values()].some(p => p.kind === 'nexus')) {
        this.spawnPortal(inst, inst.map.portalSpot.x, inst.map.portalSpot.y, 'nexus', 'Portal para o Nexus', null, 1e15);
      }
      if (inst.enemies.size === 0) {
        const e = new Enemy('training_dummy', inst.map.dummySpot.x, inst.map.dummySpot.y);
        e.leash = 2;
        inst.enemies.set(e.id, e);
      }
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
    const range = e.shots ? e.shots.range : 2;
    const aggro = 121; // 11 tiles
    // ponytail: cap at 4.3 t/s so no mob outruns even a 0-speed player; bump if a fast-mob archetype is wanted
    const speed = Math.min(d.speed, MOB_SPEED_CAP) * dt * (e.slowedUntil > now ? 0.5 : 1);

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

    // boss enrage: below the HP threshold, fires faster and harder (and says so once)
    let rateMul = 1, dmgMul = 1;
    if (d.enrage && e.hp / e.maxHp < d.enrage.hpPct) {
      rateMul = d.enrage.rateMul; dmgMul = d.enrage.dmgMul;
      if (!e.enraged) {
        e.enraged = true;
        inst.broadcast({ t: 'chat', from: '', text: `${d.name} entrou em FURIA!`, sys: 1 });
        inst.broadcastNear({ t: 'fx', k: 'buff', x: e.x, y: e.y, r: 3 }, e.x, e.y);
      }
    }

    // multi-phase bosses: cross an HP threshold -> teleport + swap shot pattern
    if (d.phases && e.phase < d.phases.length && e.hp / e.maxHp <= d.phases[e.phase].hpPct) {
      const ph = d.phases[e.phase];
      e.phase++;
      if (ph.shots) e.shots = ph.shots;
      this.teleportBoss(inst, e);
      e.stunnedUntil = now + 600; // brief beat after the blink
      inst.broadcast({ t: 'chat', from: '', text: `${d.name} ${ph.cry || 'muda de forma!'}`, sys: 1 });
      inst.broadcastNear({ t: 'fx', k: 'nova', x: e.x, y: e.y, r: 4 }, e.x, e.y);
      return;
    }

    // melee
    if (d.melee && now > e.nextMelee && bestD2 < 1.2) {
      e.nextMelee = now + 1000 / d.melee.rate;
      this.damagePlayer(target, Math.round(d.melee.dmg * dmgMul), d.name);
    }
    // shooting (burst: several quick volleys, then the full cooldown)
    if (e.shots && now > e.nextShot && bestD2 < (e.shots.range * 1.1) ** 2) {
      const s = e.shots;
      if (s.burst) {
        e.burstLeft = (e.burstLeft || 0) > 0 ? e.burstLeft - 1 : s.burst - 1;
        e.nextShot = now + (e.burstLeft > 0 ? (s.burstGap || 110) : 1000 / (s.rate * rateMul));
      } else {
        e.nextShot = now + 1000 / (s.rate * rateMul);
      }
      const shotDmg = Math.round(s.dmg * dmgMul);
      const base = Math.atan2(target.y - e.y, target.x - e.x);
      const angles = [];
      for (let i = 0; i < s.count; i++) {
        const off = s.count > 1 ? (i - (s.count - 1) / 2) * (s.spread / Math.max(1, s.count - 1)) * 2 : 0;
        const a = base + off;
        angles.push(Math.round(a * 1000) / 1000);
        inst.projectiles.push({ friendly: false, x: e.x, y: e.y, a, speed: s.speed, left: s.range, dmg: shotDmg, src: d.name, status: s.status });
      }
      inst.broadcastNear({ t: 'shot', x: e.x, y: e.y, as: angles, spd: s.speed, rg: s.range, k: 'enemy', f: 0, o: e.id, st: s.status && s.status.type }, e.x, e.y);
    }
    // ring attacks (spiral rings rotate a bit each volley)
    if (e.shots && e.shots.ring && now > e.nextRing) {
      e.nextRing = now + 1000 / (e.shots.ringRate * rateMul);
      const s = e.shots;
      const base = s.spiral ? (e.spiralA = (e.spiralA || 0) + 0.37) : 0;
      const ringDmg = Math.round(s.dmg * 0.8 * dmgMul);
      const angles = [];
      for (let i = 0; i < s.ring; i++) {
        const a = base + (i / s.ring) * Math.PI * 2;
        angles.push(Math.round(a * 1000) / 1000);
        inst.projectiles.push({ friendly: false, x: e.x, y: e.y, a, speed: s.speed * 0.8, left: s.range, dmg: ringDmg, src: d.name, status: s.ringStatus || s.status });
      }
      inst.broadcastNear({ t: 'shot', x: e.x, y: e.y, as: angles, spd: s.speed * 0.8, rg: s.range, k: 'enemy', f: 0, o: e.id, st: (s.ringStatus || s.status) && (s.ringStatus || s.status).type }, e.x, e.y);
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

  // blink a boss to a fresh spot within its arena (or near its spawn)
  teleportBoss(inst, e) {
    const r = e.leash || 8;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, d = r * (0.3 + Math.random() * 0.6);
      const x = e.spawnX + Math.cos(a) * d, y = e.spawnY + Math.sin(a) * d;
      if (!inst.map.blocks(x, y) && inst.map.get(x, y) !== T.WATER && inst.map.get(x, y) !== T.LAVA) { e.x = x; e.y = y; return; }
    }
  }

  sendSnapshots(inst) {
    const now = Date.now();
    // notable targets for the quest compass (gods, bosses, mini-bosses)
    let notable = null;
    if (inst.kind !== 'nexus') {
      notable = [];
      for (const e of inst.enemies.values()) {
        if (e.def.god || e.def.behavior === 'boss' || e.def.rare) notable.push(e);
      }
    }
    for (const p of inst.players.values()) {
      if (p.ws.readyState !== 1) continue;
      const ents = [];
      const r2 = VIEW * VIEW;
      for (const o of inst.players.values()) {
        if (dist2(o.x, o.y, p.x, p.y) > r2) continue;
        ents.push(['p', o.id, o.name, o.char.classId, round1(o.x), round1(o.y),
          Math.round(o.char.hp), effectiveMaxHp(o), o.char.level,
          o.invisUntil > now ? 1 : 0,
          o.guild ? o.guild.name : '', o.pet || '',
          o.title || '', o.nameColor || '']);
      }
      // account vault chest in the nexus (contents are per-player)
      if (inst.kind === 'nexus' && inst.map.vaultSpot) {
        const v = inst.map.vaultSpot;
        ents.push(['v', 0, v.x, v.y, this.nearVault(p) ? p.vault : null]);
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
      // nearest notable target -> quest compass
      let quest = null;
      if (notable && notable.length) {
        let best = null, bd = Infinity;
        for (const e of notable) { const dd = dist2(e.x, e.y, p.x, p.y); if (dd < bd) { bd = dd; best = e; } }
        if (best) quest = { x: round1(best.x), y: round1(best.y), name: best.def.name, god: best.def.god ? 1 : 0 };
      }
      const ch = p.char;
      send(p.ws, {
        t: 'tick',
        e: ents,
        self: {
          hp: Math.round(ch.hp), maxHp: effectiveMaxHp(p),
          mp: Math.round(ch.mp), maxMp: effectiveMaxMp(p),
          xp: ch.xp, next: xpToNext(ch.level), level: ch.level, fame: ch.fame,
          stats: effectiveStats(p), eq: ch.equipment, inv: ch.inventory,
          st: this.activeStatus(p), quest,
        },
      });
    }
  }

  autosave() {
    for (const p of this.players.values()) this.persist(p);
  }
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

module.exports = { Game, ACHIEVEMENTS, MOB_SPEED_CAP, PLAYER_MIN_SPEED };
