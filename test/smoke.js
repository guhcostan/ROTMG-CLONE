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
  for (const [iid, it] of Object.entries(ITEMS)) {
    if (it.dungeons) for (const dk of it.dungeons) if (!DUNGEONS[dk]) bad.push(`${iid}: key dungeon ${dk}`);
  }
  check(bad.length === 0, 'data refs consistent' + (bad.length ? ' -> ' + bad.join(', ') : ''));

  // every dungeon is reachable via a portal drop (except the two special finales)
  const portalSrc = new Set();
  for (const e of Object.values(ENEMIES)) for (const [s] of e.loot || []) if (s.startsWith('portal:')) portalSrc.add(s.slice(7));
  const special = new Set(['mad_castle', 'tyrant_sanctum']);
  const orphans = Object.keys(DUNGEONS).filter(k => !special.has(k) && !portalSrc.has(k));
  check(orphans.length === 0, 'all dungeons reachable by portal' + (orphans.length ? ' -> orphan: ' + orphans.join(', ') : ''));

  // every realm mob shoots, and band damage rises outward->inward (easy beach, hard center)
  const realmMobs = Object.values(ENEMIES).filter(e => e.band >= 0);
  check(realmMobs.every(e => e.shots), 'every realm mob has a shot attack');
  const bandDmg = b => Math.max(...realmMobs.filter(e => e.band === b).map(e => e.shots.dmg));
  check(bandDmg(0) < bandDmg(1) && bandDmg(1) < bandDmg(2) && bandDmg(2) < bandDmg(3) && bandDmg(3) < bandDmg(4),
    'band damage rises from beach to center');

  // classes: at least 18, every starter item exists, unlock chains reference real classes
  const { CLASSES } = require('../server/data');
  const classBad = [];
  for (const [id, c] of Object.entries(CLASSES)) {
    for (const it of c.starter) if (it && !ITEMS[it]) classBad.push(`${id}: starter ${it}`);
    if (c.unlock && !CLASSES[c.unlock]) classBad.push(`${id}: unlock ${c.unlock}`);
  }
  check(Object.keys(CLASSES).length >= 18, `>= 18 classes (have ${Object.keys(CLASSES).length})`);
  check(Object.keys(DUNGEONS).length >= 15, `>= 15 dungeons (have ${Object.keys(DUNGEONS).length})`);
  check(Object.keys(ENEMIES).length >= 80, `>= 80 enemies (have ${Object.keys(ENEMIES).length})`);
  check(classBad.length === 0, 'class defs consistent' + (classBad.length ? ' -> ' + classBad.join(', ') : ''));
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

// ice biome: Frozen Depths dungeon generates with ice floor + frost boss
function iceBiomeSanity() {
  const { Game } = require('../server/game');
  const { T } = require('../server/world');
  const { DUNGEONS } = require('../server/data');
  const g = new Game();
  const inst = g.createDungeon('frozen_depths', DUNGEONS.frozen_depths);
  check([...inst.map.tiles].includes(T.ICE), 'frozen depths uses ice floor');
  check([...inst.enemies.values()].some(e => e.type === 'frost_monarch'), 'frost monarch present');
}

// world event: timed invasion spawns a named boss with a guaranteed legendary
function worldEventSanity() {
  const { Game } = require('../server/game');
  const { ENEMIES } = require('../server/data');
  const g = new Game();
  const e = g.triggerWorldEvent();
  check(g.realm.eventBossId === e.id && g.realm.enemies.has(e.id), 'invasion boss spawned in realm');
  check(e.def.event && e.def.loot.some(([s, c]) => s === 'legendary' && c === 1), 'invasion boss guarantees a legendary');
  // killing it clears the active event
  e.hp = 1;
  g.damageEnemy(g.realm, e, 9999, { id: -3, char: { fame: 0 }, kills: 0, godsKilled: 0, dead: false });
  check(g.realm.eventBossId === null, 'defeating invasion boss clears the event');
}

// discord feed: notable bosses produce a message, trash mobs do not
function webhookSanity() {
  const { notableKillMessage } = require('../server/game');
  const { ENEMIES } = require('../server/data');
  check(typeof notableKillMessage(ENEMIES.the_archon, 'Hero') === 'string', 'raid boss kill makes a feed message');
  check(typeof notableKillMessage(ENEMIES.void_keeper, 'Hero') === 'string', 'god kill makes a feed message');
  check(notableKillMessage(ENEMIES.goblin, 'Hero') === null, 'trash mob makes no feed message');
}

// speedrun: best (fastest) time per dungeon is kept; leaderboard sorts ascending
function speedrunSanity() {
  const storage = require('../server/db');
  const a = storage.createAccount('spd' + Math.floor(Math.random() * 1e9), 's', 'h');
  storage.recordDungeonTime(a, 'goblin_warren', 9000);
  storage.recordDungeonTime(a, 'goblin_warren', 12000); // slower -> ignored
  storage.recordDungeonTime(a, 'goblin_warren', 7000);  // faster -> kept
  check(storage.bestDungeonTime(a, 'goblin_warren') === 7000, 'fastest dungeon time is kept');
  const top = storage.topDungeonTimes('goblin_warren');
  check(top.length >= 1 && top[0].ms <= 7000, 'speedrun leaderboard sorts by fastest');
}

// loot QoL: pick an item straight from a bag into an equipment slot
function pickupToSlotSanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  const player = {
    id: -110, acc: null, ws: { readyState: 3, send() {} }, instance: g.realm, x: 5, y: 5,
    char: { classId: 'wizard', stats: {}, equipment: ['staff0', 'spell0', 'robe0', null], inventory: new Array(8).fill(null), hp: 100, mp: 100 },
  };
  g.players.set(player.id, player);
  const bag = { id: 999, x: 5, y: 5, items: ['ringhp0', null, null, null, null, null, null, null], expires: Date.now() + 9e9 };
  g.realm.bags.set(bag.id, bag);
  // ring slot is index 3 (empty); pick the ring directly into it
  g.onPickup(player, { bag: 999, idx: 0, to: 3 });
  check(player.char.equipment[3] === 'ringhp0' && bag.items[0] === null, 'loot can be picked straight into an equipment slot');
  // wrong slot type is rejected
  const bag2 = { id: 998, x: 5, y: 5, items: ['hppot', null, null, null, null, null, null, null], expires: Date.now() + 9e9 };
  g.realm.bags.set(bag2.id, bag2);
  g.onPickup(player, { bag: 998, idx: 0, to: 0 }); // potion into weapon slot -> rejected
  check(player.char.equipment[0] === 'staff0' && bag2.items[0] === 'hppot', 'invalid equip target is rejected');
  g.players.delete(player.id);
}

// elite mobs: forced elite has boosted HP + flag + a bonus loot bag on death
function eliteSanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  // force the elite roll deterministically
  const realRandom = Math.random;
  Math.random = () => 0.001; // < 0.04 elite chance, and small for loot rolls
  const e = g.spawnEnemy(g.realm, 'goblin', g.realm.map.center.x, g.realm.map.center.y);
  Math.random = realRandom;
  check(e.elite === true, 'overworld mob can spawn as an elite');
  const { ENEMIES } = require('../server/data');
  check(e.maxHp === ENEMIES.goblin.hp * 3, 'elite has triple HP');
  const bagsBefore = g.realm.bags.size;
  e.hp = 1;
  g.damageEnemy(g.realm, e, 9999, { id: -1, char: { fame: 0 }, gold: 0, kills: 0, godsKilled: 0, dead: false, instance: g.realm, x: e.x, y: e.y, ws: { readyState: 3, send() {} } });
  check(g.realm.bags.size > bagsBefore, 'killing an elite drops a bonus bag');
}

// endgame raid: a mid-boss + a raid boss whose HP scales with the group
function raidSanity() {
  const { Game } = require('../server/game');
  const { DUNGEONS } = require('../server/data');
  const g = new Game();
  const inst = g.createDungeon('celestial_sanctum', DUNGEONS.celestial_sanctum);
  check([...inst.enemies.values()].some(e => e.type === 'the_archon'), 'raid boss present');
  check([...inst.enemies.values()].some(e => e.type === 'celestial_warden'), 'raid mid-boss present');
  const archon = [...inst.enemies.values()].find(e => e.type === 'the_archon');
  const baseHp = archon.maxHp;
  // simulate 4 players in the instance, then a first hit
  for (let i = 0; i < 4; i++) inst.players.set(-200 - i, { id: -200 - i, x: 0, y: 0, dead: false, ws: { readyState: 3, send() {} } });
  g.damageEnemy(inst, archon, 1, { id: -1, char: { fame: 0 }, kills: 0, godsKilled: 0, dead: false });
  check(archon.maxHp > baseHp && archon.scaled, 'raid boss HP scales up with the group');
  for (let i = 0; i < 4; i++) inst.players.delete(-200 - i); // don't leave partial players in the ticking Game
}

// multi-realm: a pool of capped realms, one Nexus portal each, refilled on close
function multiRealmSanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  check(g.realms.length === 3, 'three realms open at once');
  const realmPortals = [...g.nexus.portals.values()].filter(p => p.kind === 'realm');
  check(realmPortals.length === 3, 'one Nexus portal per realm');
  check(realmPortals.every(p => g.instances.has(p.instanceId)), 'each realm portal points to a live realm');
  check(g.realms.every(r => r.godKills === 0 && r.godKillTarget > 0), 'each realm tracks its own god-kill progress');
  const first = g.realms[0];
  g.closeRealm(first);
  check(!g.realms.includes(first) && g.realms.length === 3, 'closing a realm opens a replacement (pool stays full)');
  check([...g.nexus.portals.values()].filter(p => p.kind === 'realm').length === 3, 'Nexus portals refresh after a realm closes');

  // realm portal labels show population and conquest progress
  const r0 = g.realms[0];
  r0.godKills = r0.godKillTarget;
  g.refreshRealmLabels();
  check(/\(0\/20\)/.test(r0.portal.name) && /100%/.test(r0.portal.name), 'realm portal label shows population and conquest %');
}

// multi-phase boss: crossing an HP threshold teleports it and swaps its pattern
function multiPhaseSanity() {
  const { Game } = require('../server/game');
  const { DUNGEONS } = require('../server/data');
  const g = new Game();
  const inst = g.createDungeon('tyrant_sanctum', DUNGEONS.tyrant_sanctum);
  const boss = [...inst.enemies.values()].find(e => e.type === 'the_tyrant');
  // a lone target so the boss AI runs its shooting/phase logic
  const fake = { id: -9, x: boss.x + 1, y: boss.y + 1, dead: false, invisUntil: 0, char: { hp: 999 }, ws: { readyState: 3, send() {} } };
  inst.players.set(fake.id, fake);
  const pat0 = boss.shots, x0 = boss.x, y0 = boss.y;
  boss.hp = boss.maxHp * 0.5; // below first phase threshold (0.66)
  g.tickEnemy(inst, boss, Date.now(), 1 / 20);
  check(boss.phase === 1, 'boss advances to phase 1 below threshold');
  check(boss.shots !== pat0, 'boss swaps shot pattern on phase change');
  check(boss.x !== x0 || boss.y !== y0, 'boss teleports on phase change');
  inst.players.delete(fake.id); // don't leave a partial player in the still-ticking Game
}

// account progression: achievements are permanent + idempotent; daily once per day
function progressionSanity() {
  const storage = require('../server/db');
  const acc = storage.createAccount('prog' + Math.floor(Math.random() * 1e9), 's', 'h');
  check(storage.earnAchievement(acc, 'first_boss') === true, 'first achievement earn is new');
  check(storage.earnAchievement(acc, 'first_boss') === false, 'duplicate achievement is idempotent');
  check(storage.listAchievements(acc).includes('first_boss'), 'earned achievement is listed');
  const d1 = storage.claimDaily(acc);
  check(d1.claimed === true && d1.streak === 1, 'first daily claim grants streak 1');
  check(storage.claimDaily(acc).claimed === false, 'second daily claim same day is blocked');
}

// abilities scale with Wisdom: a higher-WIS caster's spell hits harder
function abilityScalingSanity() {
  const { Game } = require('../server/game');
  const { CLASSES } = require('../server/data');
  const g = new Game();
  const cast = (wis) => {
    const stats = Object.assign({}, CLASSES.wizard.base, { att: 30, wis });
    const player = {
      id: -20 - wis, instance: g.realm, x: 10, y: 10, dead: false, invisUntil: 0,
      lastAbility: 0, status: {},
      char: { mp: 999, hp: 500, classId: 'wizard', equipment: ['staff0', 'spell0', 'robe0', null], inventory: [], stats },
      ws: { readyState: 3, send() {} },
    };
    g.players.set(player.id, player);
    const e = g.spawnEnemy(g.realm, 'goblin', 10, 10); // on top of the cursor
    const hp0 = e.hp;
    // effectiveStats reads player.char.stats; bypass MP/cooldown via fresh player
    g.onAbility(player, { x: 10, y: 10 });
    const dealt = hp0 - e.hp;
    g.realm.enemies.delete(e.id);
    g.players.delete(player.id);
    return dealt;
  };
  const low = cast(10), high = cast(70);
  check(low > 0 && high > low, `spell damage scales with WIS (${low} -> ${high})`);
}

// co-op: a player standing near a kill earns XP even without dealing damage
function coopXpSanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  const mk = (id, x) => {
    const p = { id, x, y: 10, dead: false, instance: g.realm, invisUntil: 0, name: 'P' + id,
      char: { level: 1, xp: 0, fame: 0, classId: 'wizard', stats: { hp: 100, mp: 100, att: 10, def: 0, spd: 10, dex: 10, vit: 10, wis: 10 }, equipment: [], hp: 100, mp: 100 },
      kills: 0, godsKilled: 0, dungeons: 0, status: {}, ws: { readyState: 3, send() {} }, acc: null };
    g.players.set(id, p); g.realm.players.set(id, p); return p;
  };
  const killer = mk(-30, 10);   // deals the damage
  const bystander = mk(-31, 12); // 2 tiles away, no damage
  const far = mk(-32, 200);      // far away
  const e = g.spawnEnemy(g.realm, 'goblin', 10, 10);
  e.hp = 1;
  g.damageEnemy(g.realm, e, 9999, killer);
  check(killer.char.xp > 0, 'killer earns XP');
  check(bystander.char.xp > 0, 'nearby ally earns XP without dealing damage');
  check(far.char.xp === 0, 'far-away player earns no XP');

  // teleport-to-player: same instance only, with a cooldown
  killer.x = 10; killer.y = 10; bystander.x = 80; bystander.y = 80;
  g.teleportToPlayer(killer, bystander.name = 'Beta');
  check(Math.round(killer.x) === 80 && Math.round(killer.y) === 80, 'teleport moves player to the target');
  killer.x = 5; killer.y = 5;
  g.teleportToPlayer(killer, 'Beta'); // still on cooldown -> ignored
  check(killer.x === 5, 'teleport respects the cooldown');
  check(typeof g.teleportToPlayer === 'function', 'teleport command exists');

  for (const id of [-30, -31, -32]) { g.players.delete(id); g.realm.players.delete(id); }
}

// bleed scales with max HP (floored) so it isn't lethal to low-level characters
function bleedSanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  const now = Date.now();
  const bleedTick = (maxHp) => {
    const p = { id: -40 - maxHp, x: 5, y: 5, dead: false, instance: g.realm, lastHit: 0, status: { bleed: now + 5000 },
      char: { hp: maxHp, mp: 0, classId: 'wizard', stats: { hp: maxHp, mp: 0, att: 0, def: 0, spd: 0, dex: 0, vit: 0, wis: 0 }, equipment: [] },
      ws: { readyState: 3, send() {} }, acc: null };
    g.players.set(p.id, p); g.realm.players.set(p.id, p);
    const hp0 = p.char.hp;
    g.tickInstance(g.realm, now); // first tick triggers the bleed sub-tick
    const lost = hp0 - p.char.hp;
    g.players.delete(p.id); g.realm.players.delete(p.id);
    return lost;
  };
  const low = bleedTick(100), high = bleedTick(780);
  check(low <= 6.5 && low > 0, `low-HP bleed is gentle (${low}/tick)`);
  check(high > low, `bleed scales with max HP (${low} -> ${high})`);
}

// onboarding: tutorial map is valid + a fresh account starts there, once
function tutorialSanity() {
  const { generateTutorial, T } = require('../server/world');
  const m = generateTutorial();
  check(m.get(0, 0) === T.WALL && m.get((m.w / 2) | 0, (m.h / 2) | 0) === T.FLOOR, 'tutorial room is walled with a floor');
  check(m.spawn && m.dummySpot && m.portalSpot, 'tutorial has spawn/dummy/portal spots');

  const { Game } = require('../server/game');
  const storage = require('../server/db');
  const g = new Game();
  const id = storage.createAccount('tut' + Math.floor(Math.random() * 1e9), 's', 'h');
  const acc = storage.getAccountById(id);
  const char = { id: 1, classId: 'wizard', level: 1, xp: 0, fame: 0, hp: 100, mp: 100,
    stats: { hp: 100, mp: 100, att: 10, def: 0, spd: 10, dex: 10, vit: 10, wis: 10 },
    equipment: ['staff0', 'spell0', 'robe0', null], inventory: new Array(8).fill(null) };
  const ws = { readyState: 1, send() {} };
  const p = g.joinPlayer(ws, acc, char);
  check(p.instance.kind === 'tutorial', 'new account starts in its own tutorial room');

  // a second new account gets a DIFFERENT tutorial instance (per-player, not shared)
  const id2 = storage.createAccount('tut' + Math.floor(Math.random() * 1e9), 's', 'h');
  const p2 = g.joinPlayer(ws, storage.getAccountById(id2), { ...char, id: 2 });
  check(p2.instance.kind === 'tutorial' && p2.instance !== p.instance, 'each player gets their own tutorial room');
  g.leavePlayer(p2);

  g.toNexus(p);
  check(p.instance === g.nexus, 'leaving the tutorial drops into the Nexus');
  check(storage.getAccountById(id).tutorial_done === 1, 'tutorial completion persists on the account');
  g.leavePlayer(p);
}

// daily bounties: deterministic set per day, progress completes + rewards
function bountySanity() {
  const { Game } = require('../server/game');
  const storage = require('../server/db');
  const g = new Game();
  const id = storage.createAccount('bnty' + Math.floor(Math.random() * 1e9), 's', 'h');
  const list = g.getDailyBounties(id);
  check(list.length === 3 && list.every(b => b.progress === 0 && !b.done), 'three fresh bounties for the day');
  check(JSON.stringify(g.getDailyBounties(id)) === JSON.stringify(list), 'bounties are stable within the same day');

  // drive one bounty to completion and confirm reward lands in the vault
  const b = list.find(x => x.type === 'kill_count') || list[0];
  const player = { id: -50, acc: { id }, ws: { readyState: 3, send() {} }, bounties: list, vault: new Array(16).fill(null) };
  for (let i = 0; i < b.target; i++) g.progressBounty(player, b.type);
  check(b.done === true, 'bounty completes when its target is reached');
  check(player.vault.some(s => s !== null), 'completed bounty drops a reward in the vault');
}

// party: invite -> accept forms a group; leaving disbands a pair
function partySanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  const mk = (id, name) => { const p = { id, name, instance: g.nexus, char: { level: 1, hp: 100 }, ws: { readyState: 3, send() {} }, party: null, partyInviteFrom: null, dead: false }; g.players.set(id, p); return p; };
  const a = mk(-90, 'Alpha'), b = mk(-91, 'Bravo');
  g.partyCommand(a, ['convidar', 'Bravo']);
  check(b.partyInviteFrom === a.id, 'invite reaches the target');
  g.partyCommand(b, ['aceitar']);
  check(a.party && a.party === b.party && a.party.members.size === 2, 'accepting forms a shared party');
  g.leaveParty(b);
  check(b.party === null && a.party === null, 'leaving a pair disbands the party');
  g.players.delete(-90); g.players.delete(-91);
}

// seasons: a rotating weekly modifier + a per-season fame leaderboard
function seasonSanity() {
  const { Game } = require('../server/game');
  const storage = require('../server/db');
  const g = new Game();
  const info = g.seasonInfo();
  check(typeof info.season === 'number' && info.modifier && info.endsAt > Date.now(), 'season has an active modifier and end time');
  check(['xp', 'loot', 'fame'].includes(info.modifierId), 'season modifier is one of the rotating set');

  const id = storage.createAccount('seas' + Math.floor(Math.random() * 1e9), 's', 'h');
  storage.recordSeasonFame(id, info.season, 500);
  storage.recordSeasonFame(id, info.season, 300); // lower -> kept at max
  const top = storage.seasonLeaderboard(info.season);
  const row = top.find(r => r.fame === 500);
  check(!!row, 'season leaderboard records the account best fame');
}

// free season pass: tiers unlock by season fame; claiming is once per tier
function passSanity() {
  const { Game } = require('../server/game');
  const storage = require('../server/db');
  const g = new Game();
  const id = storage.createAccount('pass' + Math.floor(Math.random() * 1e9), 's', 'h');
  storage.recordSeasonFame(id, g.season, 250); // unlocks tiers 1 and 2 (100, 200)
  let info = g.passInfo(id);
  check(info.tiers[0].unlocked && info.tiers[1].unlocked && !info.tiers[2].unlocked, 'tiers unlock by season fame');
  const before = storage.getAccountById(id).gold;
  const r = g.claimPass(id, 1); // tier 1 = 50 gold
  check(r.ok && storage.getAccountById(id).gold === before + 50, 'claiming a tier grants its reward');
  check(g.claimPass(id, 1).error, 'a tier cannot be claimed twice');
  check(g.claimPass(id, 3).error, 'a locked tier cannot be claimed');
}

// cosmetics: name colors unlock by best fame; titles by achievement; ownership enforced
function cosmeticSanity() {
  const { Game, ACHIEVEMENTS } = require('../server/game');
  const storage = require('../server/db');
  const g = new Game();
  const id = storage.createAccount('cosm' + Math.floor(Math.random() * 1e9), 's', 'h');
  let c = g.cosmeticsFor(id);
  check(c.colors.length === 1 && c.titles.length === 1, 'fresh account has only the base color + title');
  check(g.setCosmetic(id, null, '#f0c040') === false, 'cannot pick a color that is not unlocked');

  storage.bury(id, { id: -1, classId: 'wizard', level: 20, fame: 2000 }, 'teste'); // best fame -> unlocks tiers
  storage.earnAchievement(id, 'first_boss');
  const title = ACHIEVEMENTS.first_boss.name;
  c = g.cosmeticsFor(id);
  check(c.colors.length >= 4, 'higher best fame unlocks more name colors');
  check(c.titles.includes(title), 'earning an achievement unlocks its title');
  check(g.setCosmetic(id, title, '#a860d8') === true, 'can pick an unlocked title + color');
  check(g.cosmeticsFor(id).current.color === '#a860d8', 'chosen cosmetic persists');
  // skins unlock by best fame (2000 -> Rubi/Esmeralda/Safira)
  const skins = c.skins.map(s => s.color);
  check(c.skins.length >= 3, 'best fame unlocks earnable skins');
  check(g.setCosmetic(id, title, '#a860d8', skins[0]) === true, 'can equip an unlocked skin');
  check(g.cosmeticsFor(id).current.skin === skins[0], 'chosen skin persists');
  check(g.setCosmetic(id, null, null, '#000000') === false, 'cannot equip a locked skin');
}

// pets: feeding consumables levels the pet; aura choice scales regen
function petSanity() {
  const { Game } = require('../server/game');
  const storage = require('../server/db');
  const g = new Game();
  const id = storage.createAccount('pet' + Math.floor(Math.random() * 1e9), 's', 'h');
  const player = {
    id: -60, acc: storage.getAccountById(id), ws: { readyState: 3, send() {} },
    pet: 'pet_wolf', petLevel: 1, petXp: 0, petAura: 'heal',
    char: { equipment: [null, null, null, null], inventory: ['pot_att', null, null, null, null, null, null, null] },
  };
  const baseHeal = g.petMult(player, 'hp');
  check(baseHeal > 1, 'pet with heal aura boosts HP regen');
  check(g.petMult(player, 'mp') === 1, 'heal aura does not boost MP regen');
  // feed the stat potion (tier 4) -> 75 xp, enough to pass level 1 (needs 50)
  g.feedPet(player, 4);
  check(player.petLevel === 2 && player.char.inventory[0] === null, 'feeding a consumable levels the pet and consumes it');
  check(g.petMult(player, 'hp') > baseHeal, 'higher pet level gives a stronger aura');
  g.setPetAura(player, 'magic');
  check(g.petMult(player, 'mp') > 1 && g.petMult(player, 'hp') === 1, 'switching aura moves the bonus to MP');
}

// merchant economy: kills give gold; buying costs gold, selling pays it
function shopSanity() {
  const { Game } = require('../server/game');
  const storage = require('../server/db');
  const g = new Game();
  const id = storage.createAccount('shop' + Math.floor(Math.random() * 1e9), 's', 'h');
  const player = {
    id: -80, acc: storage.getAccountById(id), ws: { readyState: 3, send() {} }, instance: g.nexus,
    gold: 500, char: { classId: 'wizard', stats: {}, equipment: [null, null, null, null], inventory: new Array(8).fill(null), hp: 100, mp: 100, level: 1, xp: 0, fame: 0 },
  };
  // buy a health potion (price 30)
  g.onShopBuy(player, 'hppot');
  check(player.gold === 470 && player.char.inventory.includes('hppot'), 'buying deducts gold and grants the item');
  g.onShopBuy(player, 'pet_egg'); // 600 > 470 -> rejected
  check(player.gold === 470, 'cannot buy without enough gold');
  // sell the potion back
  const slot = 4 + player.char.inventory.indexOf('hppot');
  g.onShopSell(player, slot);
  check(player.gold > 470 && !player.char.inventory.includes('hppot'), 'selling removes the item and pays gold');
  check(storage.getAccountById(id).gold === player.gold, 'gold persists to the account');
}

// dungeon keys: using one in the Nexus opens a dungeon portal and consumes it
function keySanity() {
  const { Game } = require('../server/game');
  const g = new Game();
  const player = {
    id: -70, acc: null, ws: { readyState: 3, send() {} }, instance: g.nexus, x: 20, y: 20,
    char: { classId: 'wizard', stats: {}, equipment: [null, null, null, null], inventory: ['key_lesser', null, null, null, null, null, null, null], hp: 100, mp: 100 },
  };
  const before = g.nexus.portals.size;
  g.onUseItem(player, { slot: 4 });
  check(g.nexus.portals.size === before + 1, 'using a key opens a dungeon portal in the nexus');
  check(player.char.inventory[0] === null, 'the key is consumed on use');
  // a key cannot be used outside the Nexus
  player.instance = g.realm;
  player.char.inventory[1] = 'key_master';
  g.onUseItem(player, { slot: 5 });
  check(player.char.inventory[1] === 'key_master', 'key is not consumed when used outside the Nexus');
}

// balance: no mob can outrun even a 0-SPD player; new dungeon bosses fit the curve
function balanceSanity() {
  const { MOB_SPEED_CAP, PLAYER_MIN_SPEED } = require('../server/game');
  const { DUNGEONS, ENEMIES } = require('../server/data');
  check(MOB_SPEED_CAP < PLAYER_MIN_SPEED, `mob speed cap (${MOB_SPEED_CAP}) below player floor (${PLAYER_MIN_SPEED})`);
  // mid-tier dungeons (drop from band 2-3 mobs) stay below the late-game Abyssal Rift (18k)
  const hp = name => ENEMIES[DUNGEONS[name].boss].hp;
  const mid = ['crystal_caverns', 'plague_warren', 'frozen_depths', 'storm_citadel', 'sunbaked_ziggurat', 'drowned_grotto', 'volcanic_forge'];
  check(mid.every(d => hp(d) <= 16000), 'new dungeon bosses scaled into the mid curve (<=16k HP)');
  check(hp('crystal_caverns') < hp('volcanic_forge'), 'new dungeons have an internal difficulty ramp');

  // legendary weapons: melee/single-target ones shouldn't lag the multi-shot ranged ones
  const { ITEMS, LEGENDARIES } = require('../server/data');
  const fr = 1.5 + 4.5 * (50 / 75);
  const dps = id => { const p = ITEMS[id].proj; return (p.dmg[0] + p.dmg[1]) / 2 * fr * p.rateMul * p.count; };
  for (const id of ['sword_kings', 'dagger_void', 'katana_tempest']) {
    check(dps(id) >= 1000, `legendary ${id} DPS competitive (${Math.round(dps(id))})`);
  }
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

  // paralyze can't be chained: a second application during the immunity window is ignored
  g.applyStatus(player, 'paralyze', 800);
  const firstEnd = player.status.paralyze;
  g.applyStatus(player, 'paralyze', 800); // immediately re-applied -> should be blocked
  check(player.status.paralyze === firstEnd, 'paralyze cannot be re-applied during immunity');
  g.cleanseStatus(player);

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
  iceBiomeSanity();
  worldEventSanity();
  webhookSanity();
  speedrunSanity();
  eliteSanity();
  pickupToSlotSanity();
  raidSanity();
  multiRealmSanity();
  multiPhaseSanity();
  progressionSanity();
  abilityScalingSanity();
  coopXpSanity();
  balanceSanity();
  bleedSanity();
  tutorialSanity();
  bountySanity();
  partySanity();
  seasonSanity();
  passSanity();
  cosmeticSanity();
  petSanity();
  keySanity();
  shopSanity();
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
    check(Object.keys(r.data.classes).length === 18, 'eighteen classes available');
    check(r.data.classes.wizard.locked === false, 'starter class wizard unlocked');
    check(r.data.classes.necromancer.locked === true, 'advanced class necromancer locked initially');
    check(r.data.classes.necromancer.unlockName === 'Wizard', 'necromancer shows its unlock requirement');
    check(r.data.classes.samurai.locked === true && r.data.classes.samurai.unlockName === 'Knight', 'samurai locked behind Knight');
    check(r.data.classes.warlock.locked === true && r.data.classes.warlock.unlockName === 'Necromancer', 'tier-3 Warlock locked behind Necromancer');

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

    // public profile: by username, no auth
    r = await api('GET', '/api/profile?name=' + user1, null);
    check(r.status === 200 && r.data.username === user1 && Array.isArray(r.data.characters), 'public profile endpoint');
    r = await api('GET', '/api/profile?name=naoexiste_zzz', null);
    check(r.status === 404, 'unknown profile returns 404');

    // --- gameplay: two clients in the nexus
    const c1 = client(token1, char1);
    const c2 = client(token2, char2);
    await c1.opened; await c2.opened;

    const wt1 = await c1.waitFor('world');
    const wt2 = await c2.waitFor('world');
    check(wt1.kind === 'tutorial' && wt2.kind === 'tutorial', 'new accounts start in the tutorial');
    // leave the tutorial into the Nexus
    c1.messages.length = 0; c2.messages.length = 0;
    c1.sendMsg({ t: 'nexus' }); c2.sendMsg({ t: 'nexus' });
    const w1 = await c1.waitFor('world');
    const w2 = await c2.waitFor('world');
    check(w1.kind === 'nexus' && w2.kind === 'nexus', 'both reach the nexus');
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
    // vault may already hold a daily-login reward, so find staff0 at any slot
    const vIdx = tick.e.find(e => e[0] === 'v')[4].indexOf('staff0');
    check(vIdx !== -1, 'item deposited in vault');
    check(tick.self.inv[0] === null, 'item removed from inventory');

    c1.sendMsg({ t: 'vault', cmd: 'withdraw', idx: vIdx });
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
    c1b.messages.length = 0; // drop join-time system chatter (season/bounties)
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
