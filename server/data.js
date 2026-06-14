'use strict';
// Static game data: classes, items, enemies, dungeons.
// All names/art are original; mechanics are inspired by classic bullet-hell MMOs.

// ---------------------------------------------------------------- classes
// stats: [maxHp, maxMp, att, def, spd, dex, vit, wis]
const CLASSES = {
  wizard: {
    name: 'Wizard', weapon: 'staff', armor: 'robe', ability: 'spell',
    base: { hp: 100, mp: 100, att: 15, def: 0, spd: 10, dex: 15, vit: 10, wis: 12 },
    growth: { hp: [20, 30], mp: [5, 15], att: 1.5, def: 0, spd: 0.5, dex: 1.2, vit: 0.5, wis: 1 },
    max: { hp: 670, mp: 385, att: 75, def: 25, spd: 50, dex: 75, vit: 40, wis: 60 },
    starter: ['staff0', 'spell0', 'robe0', null],
  },
  archer: {
    name: 'Archer', weapon: 'bow', armor: 'leather', ability: 'quiver',
    base: { hp: 130, mp: 100, att: 12, def: 0, spd: 12, dex: 12, vit: 12, wis: 10 },
    growth: { hp: [22, 32], mp: [4, 12], att: 1.3, def: 0, spd: 0.7, dex: 1.1, vit: 0.7, wis: 0.6 },
    max: { hp: 700, mp: 252, att: 75, def: 25, spd: 50, dex: 50, vit: 40, wis: 50 },
    starter: ['bow0', 'quiver0', 'leather0', null],
  },
  warrior: {
    name: 'Warrior', weapon: 'sword', armor: 'heavy', ability: 'helm',
    base: { hp: 200, mp: 100, att: 15, def: 0, spd: 7, dex: 10, vit: 15, wis: 8 },
    growth: { hp: [25, 35], mp: [2, 8], att: 1.5, def: 0, spd: 0.7, dex: 1, vit: 1, wis: 0.4 },
    max: { hp: 770, mp: 252, att: 75, def: 25, spd: 50, dex: 50, vit: 75, wis: 50 },
    starter: ['sword0', 'helm0', 'heavy0', null],
  },
  priest: {
    name: 'Priest', weapon: 'wand', armor: 'robe', ability: 'tome',
    base: { hp: 100, mp: 120, att: 12, def: 0, spd: 12, dex: 12, vit: 10, wis: 15 },
    growth: { hp: [20, 30], mp: [5, 15], att: 1.2, def: 0, spd: 0.7, dex: 1.1, vit: 0.5, wis: 1.2 },
    max: { hp: 670, mp: 385, att: 50, def: 25, spd: 55, dex: 55, vit: 40, wis: 75 },
    starter: ['wand0', 'tome0', 'robe0', null],
  },
  rogue: {
    name: 'Rogue', weapon: 'dagger', armor: 'leather', ability: 'cloak',
    base: { hp: 150, mp: 100, att: 12, def: 0, spd: 15, dex: 15, vit: 12, wis: 10 },
    growth: { hp: [20, 30], mp: [2, 8], att: 1.3, def: 0, spd: 1, dex: 1.3, vit: 0.7, wis: 0.6 },
    max: { hp: 720, mp: 252, att: 50, def: 25, spd: 75, dex: 75, vit: 40, wis: 50 },
    starter: ['dagger0', 'cloak0', 'leather0', null],
  },
  knight: {
    name: 'Knight', weapon: 'sword', armor: 'heavy', ability: 'shield',
    base: { hp: 200, mp: 100, att: 15, def: 0, spd: 7, dex: 10, vit: 15, wis: 8 },
    growth: { hp: [25, 35], mp: [2, 8], att: 1.4, def: 0, spd: 0.6, dex: 0.9, vit: 1, wis: 0.4 },
    max: { hp: 770, mp: 252, att: 50, def: 40, spd: 50, dex: 50, vit: 75, wis: 50 },
    starter: ['sword0', 'shield0', 'heavy0', null],
  },
  // ---- advanced classes: unlocked by leveling the `unlock` class to 20 ----
  necromancer: {
    name: 'Necromancer', weapon: 'staff', armor: 'robe', ability: 'skull', unlock: 'wizard',
    base: { hp: 110, mp: 110, att: 15, def: 0, spd: 11, dex: 14, vit: 10, wis: 14 },
    growth: { hp: [20, 30], mp: [6, 16], att: 1.4, def: 0, spd: 0.6, dex: 1.1, vit: 0.5, wis: 1.1 },
    max: { hp: 700, mp: 450, att: 75, def: 25, spd: 50, dex: 75, vit: 40, wis: 75 },
    starter: ['staff0', 'skull0', 'robe0', null],
  },
  huntress: {
    name: 'Huntress', weapon: 'bow', armor: 'leather', ability: 'trap', unlock: 'archer',
    base: { hp: 130, mp: 100, att: 13, def: 0, spd: 13, dex: 13, vit: 12, wis: 10 },
    growth: { hp: [22, 32], mp: [4, 12], att: 1.3, def: 0, spd: 0.8, dex: 1.2, vit: 0.7, wis: 0.6 },
    max: { hp: 720, mp: 252, att: 75, def: 25, spd: 55, dex: 60, vit: 40, wis: 50 },
    starter: ['bow0', 'trap0', 'leather0', null],
  },
  paladin: {
    name: 'Paladin', weapon: 'sword', armor: 'heavy', ability: 'seal', unlock: 'warrior',
    base: { hp: 200, mp: 100, att: 14, def: 0, spd: 8, dex: 10, vit: 13, wis: 12 },
    growth: { hp: [24, 34], mp: [4, 10], att: 1.4, def: 0, spd: 0.6, dex: 0.9, vit: 0.9, wis: 0.9 },
    max: { hp: 770, mp: 320, att: 75, def: 30, spd: 50, dex: 50, vit: 60, wis: 60 },
    starter: ['sword0', 'seal0', 'heavy0', null],
  },
  mystic: {
    name: 'Mystic', weapon: 'wand', armor: 'robe', ability: 'orb', unlock: 'priest',
    base: { hp: 100, mp: 120, att: 12, def: 0, spd: 12, dex: 13, vit: 10, wis: 15 },
    growth: { hp: [20, 30], mp: [6, 16], att: 1.2, def: 0, spd: 0.7, dex: 1.1, vit: 0.5, wis: 1.2 },
    max: { hp: 670, mp: 450, att: 60, def: 25, spd: 55, dex: 60, vit: 40, wis: 75 },
    starter: ['wand0', 'orb0', 'robe0', null],
  },
  trickster: {
    name: 'Trickster', weapon: 'dagger', armor: 'leather', ability: 'prism', unlock: 'rogue',
    base: { hp: 150, mp: 100, att: 12, def: 0, spd: 14, dex: 15, vit: 12, wis: 11 },
    growth: { hp: [20, 30], mp: [3, 9], att: 1.3, def: 0, spd: 1, dex: 1.3, vit: 0.7, wis: 0.7 },
    max: { hp: 720, mp: 280, att: 50, def: 25, spd: 75, dex: 75, vit: 40, wis: 60 },
    starter: ['dagger0', 'prism0', 'leather0', null],
  },
  samurai: {
    name: 'Samurai', weapon: 'katana', armor: 'heavy', ability: 'wakizashi', unlock: 'knight',
    base: { hp: 160, mp: 100, att: 15, def: 0, spd: 9, dex: 13, vit: 13, wis: 10 },
    growth: { hp: [23, 33], mp: [3, 9], att: 1.4, def: 0, spd: 0.8, dex: 1.1, vit: 0.9, wis: 0.5 },
    max: { hp: 740, mp: 252, att: 75, def: 30, spd: 55, dex: 65, vit: 60, wis: 50 },
    starter: ['katana0', 'wakizashi0', 'heavy0', null],
  },
};

// Classes available to every account from the start; the rest are unlocked.
const STARTER_CLASSES = ['wizard', 'archer', 'warrior', 'priest', 'rogue', 'knight'];

// ---------------------------------------------------------------- items
// type: weapon kinds (staff/bow/sword/wand/dagger), ability kinds
// (spell/quiver/helm/tome/cloak/shield), armor kinds (robe/leather/heavy),
// ring, consumable.
const ITEMS = {};
function def(id, item) { item.id = id; ITEMS[id] = item; return item; }

// Weapons: proj = {dmg:[min,max], speed (tiles/s), range (tiles), count, spread(rad), pierce}
const WEAPON_TIERS = {
  staff: [
    ['Cracked Staff',      [15, 30]], ['Apprentice Staff', [25, 40]],
    ['Staff of Embers',    [35, 55]], ['Staff of Storms',  [45, 70]],
    ['Staff of the Comet', [55, 85]], ['Staff of Eternity', [65, 100]],
  ],
  bow: [
    ['Worn Shortbow', [15, 35]], ['Hunter Bow',    [25, 45]],
    ['Longbow',       [35, 60]], ['Hawkeye Bow',   [45, 75]],
    ['Stormcaller Bow', [55, 90]], ['Bow of the Void', [65, 105]],
  ],
  sword: [
    ['Rusty Blade',  [25, 45]], ['Iron Sword',    [40, 60]],
    ['Steel Saber',  [55, 80]], ['Knight Blade',  [70, 95]],
    ['Dragonfang',   [85, 110]], ['Sword of Dawn', [100, 130]],
  ],
  wand: [
    ['Bent Wand',     [20, 40]], ['Oak Wand',     [30, 55]],
    ['Wand of Sparks', [45, 70]], ['Wand of Dusk', [55, 85]],
    ['Wand of Wonder', [70, 100]], ['Wand of Ascension', [80, 115]],
  ],
  dagger: [
    ['Chipped Dagger', [20, 40]], ['Steel Dagger', [30, 55]],
    ['Twin Fang',      [45, 70]], ['Night Edge',   [55, 85]],
    ['Viper Kiss',     [70, 100]], ['Dagger of the Abyss', [80, 115]],
  ],
  katana: [
    ['Bamboo Katana', [30, 50]], ['Iron Katana', [45, 65]],
    ['Folded Steel',  [60, 85]], ['Moonlight Katana', [75, 100]],
    ['Dragontail Katana', [90, 120]], ['Katana of the Tempest', [105, 140]],
  ],
};
const WEAPON_PROJ = {
  staff:  { speed: 18, range: 8,   count: 2, spread: 0.18, pierce: false, rateMul: 1 },
  bow:    { speed: 16, range: 7,   count: 1, spread: 0,    pierce: true,  rateMul: 1.2 },
  sword:  { speed: 14, range: 3.5, count: 1, spread: 0,    pierce: false, rateMul: 1 },
  wand:   { speed: 18, range: 9,   count: 1, spread: 0,    pierce: false, rateMul: 0.9 },
  dagger: { speed: 16, range: 5.6, count: 1, spread: 0,    pierce: false, rateMul: 1.3 },
  katana: { speed: 16, range: 4.2, count: 1, spread: 0,    pierce: false, rateMul: 1.15 },
};
for (const [kind, tiers] of Object.entries(WEAPON_TIERS)) {
  tiers.forEach(([name, dmg], t) => {
    def(`${kind}${t}`, {
      name, type: kind, slot: 'weapon', tier: t,
      proj: Object.assign({ dmg }, WEAPON_PROJ[kind]),
    });
  });
}

// Abilities: mpCost + effect parameters scale by tier.
const ABILITY_TIERS = {
  spell:  ['Magic Bolt Scroll', 'Fire Burst Spell', 'Ice Nova Spell', 'Meteor Spell', 'Spell of Cataclysm'],
  quiver: ['Frayed Quiver', 'Hunter Quiver', 'Piercing Quiver', 'Quiver of Storms', 'Quiver of Stars'],
  helm:   ['Dented Helm', 'Soldier Helm', 'Captain Helm', 'Helm of Fury', 'Helm of the Juggernaut'],
  tome:   ['Torn Tome', 'Tome of Renewal', 'Blessed Tome', 'Tome of Purity', 'Tome of Divine Light'],
  cloak:  ['Ragged Cloak', 'Shadow Cloak', 'Night Cloak', 'Cloak of Ghosts', 'Cloak of the Unseen'],
  shield: ['Wooden Shield', 'Iron Shield', 'Tower Shield', 'Bulwark Shield', 'Aegis of Kings'],
  // advanced-class abilities
  skull:  ['Cracked Skull', 'Bone Skull', 'Cursed Skull', 'Soul Skull', 'Skull of the Reaper'],   // AoE drain + lifesteal
  trap:   ['Snare Trap', 'Spike Trap', 'Venom Trap', 'Frost Trap', 'Trap of the Wild'],            // AoE damage + slow
  seal:   ['Worn Seal', 'Blessed Seal', 'Holy Seal', 'Radiant Seal', 'Seal of the Divine'],        // heal + attack buff aura
  orb:    ['Glass Orb', 'Crystal Orb', 'Stasis Orb', 'Astral Orb', 'Orb of Oblivion'],             // stasis (mass stun)
  prism:  ['Dim Prism', 'Bright Prism', 'Mirror Prism', 'Phantom Prism', 'Prism of the Void'],     // blink teleport
  wakizashi: ['Dull Wakizashi', 'Keen Wakizashi', 'Exposing Wakizashi', 'Sundering Wakizashi', 'Wakizashi of Ruin'], // expose (enemies take +dmg)
};
for (const [kind, tiers] of Object.entries(ABILITY_TIERS)) {
  tiers.forEach(([, x] = [], t) => {
    def(`${kind}${t}`, {
      name: ABILITY_TIERS[kind][t], type: kind, slot: 'ability', tier: t,
      mpCost: [20, 25, 30, 35, 40][t],
      power: [1, 1.5, 2, 2.6, 3.3][t],
    });
  });
}

// Armor: def value per tier per kind.
const ARMOR_TIERS = {
  robe:    [['Cloth Robe', 2], ['Apprentice Robe', 5], ['Silk Robe', 8], ['Robe of Shadows', 11], ['Robe of the Archmage', 14], ['Robe of Infinity', 17]],
  leather: [['Worn Leather', 3], ['Studded Leather', 6], ['Ranger Hide', 9], ['Drake Hide', 13], ['Wyvern Hide', 16], ['Hide of the Behemoth', 19]],
  heavy:   [['Rusty Mail', 4], ['Chain Mail', 8], ['Plate Mail', 12], ['Knight Plate', 16], ['Dragonscale Plate', 20], ['Armor of the Colossus', 24]],
};
for (const [kind, tiers] of Object.entries(ARMOR_TIERS)) {
  tiers.forEach(([name, defense], t) => {
    def(`${kind}${t}`, { name, type: kind, slot: 'armor', tier: t, def: defense });
  });
}

// Rings
[
  ['ringhp0', 'Ring of Health', { hp: 40 }, 1],
  ['ringhp1', 'Ring of Greater Health', { hp: 90 }, 3],
  ['ringmp0', 'Ring of Magic', { mp: 30 }, 1],
  ['ringmp1', 'Ring of Greater Magic', { mp: 70 }, 3],
  ['ringatt0', 'Ring of Attack', { att: 4 }, 2],
  ['ringdef0', 'Ring of Defense', { def: 4 }, 2],
  ['ringspd0', 'Ring of Speed', { spd: 5 }, 2],
  ['ringdex0', 'Ring of Dexterity', { dex: 5 }, 2],
  ['ringall0', 'Ring of the Realm', { hp: 60, mp: 40, att: 3, def: 3 }, 5],
  ['ringking', 'Coroa do Rei Demente', { hp: 100, mp: 60, att: 5, def: 5, spd: 5 }, 6],
  ['ringtyrant', 'Selo do Tirano', { hp: 150, mp: 100, att: 7, def: 7, spd: 6, dex: 6 }, 7],
].forEach(([id, name, bonus, tier]) => def(id, { name, type: 'ring', slot: 'ring', tier, bonus }));

// Legendary uniques (tier 6, white bag drops from gods and bosses)
def('staff_cataclysm', { name: 'Cajado do Cataclisma', type: 'staff', slot: 'weapon', tier: 6, proj: { dmg: [70, 110], speed: 19, range: 8.5, count: 3, spread: 0.22, pierce: false, rateMul: 1 } });
def('bow_tempest', { name: 'Arco da Tempestade', type: 'bow', slot: 'weapon', tier: 6, proj: { dmg: [60, 95], speed: 17, range: 7.5, count: 3, spread: 0.16, pierce: true, rateMul: 1.1 } });
def('sword_kings', { name: 'Lamina dos Reis', type: 'sword', slot: 'weapon', tier: 6, proj: { dmg: [110, 150], speed: 15, range: 3.8, count: 1, spread: 0, pierce: false, rateMul: 1 } });
def('wand_eclipse', { name: 'Varinha do Eclipse', type: 'wand', slot: 'weapon', tier: 6, proj: { dmg: [85, 130], speed: 19, range: 10, count: 1, spread: 0, pierce: false, rateMul: 0.9 } });
def('dagger_void', { name: 'Adaga do Vazio', type: 'dagger', slot: 'weapon', tier: 6, proj: { dmg: [75, 115], speed: 17, range: 5.8, count: 1, spread: 0, pierce: false, rateMul: 1.45 } });
def('katana_tempest', { name: 'Katana da Tempestade', type: 'katana', slot: 'weapon', tier: 6, proj: { dmg: [120, 160], speed: 16, range: 4.5, count: 1, spread: 0, pierce: false, rateMul: 1.2 } });
const LEGENDARIES = ['staff_cataclysm', 'bow_tempest', 'sword_kings', 'wand_eclipse', 'dagger_void', 'katana_tempest', 'ringking'];

// Pet egg (hatches into a follower pet; drops from bosses)
def('pet_egg', { name: 'Mysterious Egg', type: 'consumable', tier: 5, pet: true });

// Consumables
def('hppot', { name: 'Health Potion', type: 'consumable', tier: 0, heal: 100 });
def('mppot', { name: 'Magic Potion', type: 'consumable', tier: 0, restore: 100 });
for (const s of ['att', 'def', 'spd', 'dex', 'vit', 'wis']) {
  def(`pot_${s}`, { name: `Potion of ${{ att: 'Attack', def: 'Defense', spd: 'Speed', dex: 'Dexterity', vit: 'Vitality', wis: 'Wisdom' }[s]}`, type: 'consumable', tier: 4, stat: s, amount: 1 });
}
def('pot_life', { name: 'Potion of Life', type: 'consumable', tier: 6, stat: 'hp', amount: 20 });
def('pot_mana', { name: 'Potion of Mana', type: 'consumable', tier: 6, stat: 'mp', amount: 20 });

// ---------------------------------------------------------------- enemies
// behavior: wander | chase | orbit | turret | boss
// shots: { dmg, speed, range, count, spread, rate (shots/s), ring }
// loot: [[itemId|group, chance], ...]  group e.g. 'weapon:1-2' rolls weapon tier 1-2
const ENEMIES = {};
function enemy(id, e) { e.id = id; ENEMIES[id] = e; return e; }

// --- band 0: beach/shore (edge of realm)
enemy('crab', {
  name: 'Scuttler Crab', sprite: 'crab', hp: 60, def: 0, xp: 5, speed: 2.5, size: 0.8,
  behavior: 'wander', band: 0,
  shots: { dmg: 8, speed: 6, range: 5, count: 1, spread: 0, rate: 0.7 }, // slow heavy orb
  loot: [['hppot', 0.15]],
});
enemy('sandling', {
  name: 'Sandling', sprite: 'sandling', hp: 45, def: 0, xp: 4, speed: 3.5, size: 0.7,
  behavior: 'chase', band: 0,
  shots: { dmg: 5, speed: 12, range: 4.5, count: 1, spread: 0, rate: 1.8 }, // fast pea shooter
  loot: [['weapon:0-0', 0.12], ['hppot', 0.12]],
});
enemy('gull', {
  name: 'Razor Gull', sprite: 'gull', hp: 40, def: 0, xp: 5, speed: 6, size: 0.7,
  behavior: 'orbit', band: 0,
  shots: { dmg: 4, speed: 14, range: 5, count: 1, spread: 0, rate: 2.5 }, // very fast, weak
  loot: [['hppot', 0.1], ['mppot', 0.1]],
});
enemy('tide_caller', {
  name: 'Tide Caller', sprite: 'tide_caller', hp: 100, def: 1, xp: 8, speed: 2,
  size: 1, behavior: 'wander', band: 0,
  shots: { dmg: 16, speed: 5, range: 6, count: 3, spread: 0.7, rate: 0.5 }, // slow wide wave
  loot: [['weapon:0-0', 0.12], ['armor:0-0', 0.12], ['hppot', 0.12]],
});
// --- band 1: plains
enemy('goblin', {
  name: 'Goblin Raider', sprite: 'goblin', hp: 110, def: 2, xp: 12, speed: 4, size: 0.9,
  behavior: 'chase', band: 1,
  shots: { dmg: 9, speed: 10, range: 5, count: 1, spread: 0, rate: 1, burst: 2 }, // double tap
  loot: [['weapon:0-1', 0.2], ['armor:0-1', 0.2], ['hppot', 0.18], ['portal:goblin_warren', 0.04]],
});
enemy('wolf', {
  name: 'Dire Wolf', sprite: 'wolf', hp: 130, def: 3, xp: 14, speed: 5.5, size: 0.9,
  behavior: 'chase', band: 1, melee: { dmg: 14, rate: 1 },
  shots: { dmg: 8, speed: 9, range: 4, count: 1, spread: 0, rate: 1 }, // close snap
  loot: [['armor:0-1', 0.2], ['hppot', 0.18]],
});
enemy('bandit', {
  name: 'Bandit', sprite: 'bandit', hp: 100, def: 2, xp: 12, speed: 4, size: 0.9,
  behavior: 'orbit', band: 1,
  shots: { dmg: 16, speed: 14, range: 7.5, count: 1, spread: 0, rate: 0.8 }, // sniper
  loot: [['weapon:0-1', 0.2], ['ringhp0', 0.08], ['mppot', 0.15]],
});
enemy('scorpion', {
  name: 'Dune Scorpion', sprite: 'scorpion', hp: 140, def: 4, xp: 15, speed: 4.5, size: 0.9,
  behavior: 'chase', band: 1,
  shots: { dmg: 8, speed: 11, range: 5.5, count: 1, spread: 0, rate: 0.9, burst: 3, burstGap: 90, status: { type: 'bleed', dur: 2500, chance: 0.5 } }, // venom sting
  loot: [['weapon:0-1', 0.18], ['hppot', 0.15]],
});
enemy('bandit_lord', {
  name: 'Bandit Lord', sprite: 'bandit_lord', hp: 600, def: 6, xp: 80, speed: 4, size: 1.3,
  behavior: 'chase', band: 1, rare: true, entourage: { type: 'bandit', count: 3 },
  shots: { dmg: 18, speed: 12, range: 7, count: 2, spread: 0.25, rate: 1, burst: 2 },
  loot: [['weapon:1-2', 0.5], ['armor:1-2', 0.5], ['ringhp0', 0.2], ['portal:goblin_warren', 0.12], ['hppot', 0.3]],
});
enemy('wolf_alpha', {
  name: 'Alpha Dire Wolf', sprite: 'wolf_alpha', hp: 700, def: 8, xp: 90, speed: 6.5, size: 1.4,
  behavior: 'chase', band: 1, rare: true, entourage: { type: 'wolf', count: 4 },
  melee: { dmg: 26, rate: 1.4 },
  shots: { dmg: 16, speed: 10, range: 5, count: 3, spread: 0.5, rate: 1 }, // close cone
  loot: [['weapon:1-2', 0.5], ['armor:1-2', 0.5], ['ringspd0', 0.15], ['hppot', 0.3]],
});
// --- band 2: forest
enemy('treant', {
  name: 'Elder Treant', sprite: 'treant', hp: 350, def: 6, xp: 30, speed: 1.5, size: 1.3,
  behavior: 'wander', band: 2,
  shots: { dmg: 22, speed: 6, range: 6, count: 4, spread: 0.8, rate: 0.6 }, // slow shotgun
  loot: [['weapon:1-2', 0.22], ['armor:1-2', 0.22], ['ringdef0', 0.08], ['portal:spider_grotto', 0.05]],
});
enemy('spider', {
  name: 'Venom Spider', sprite: 'spider', hp: 200, def: 4, xp: 22, speed: 5, size: 0.9,
  behavior: 'chase', band: 2,
  shots: { dmg: 15, speed: 11, range: 5.5, count: 2, spread: 0.35, rate: 1.4, status: { type: 'slow', dur: 2000, chance: 0.4 } }, // webbing
  loot: [['weapon:1-2', 0.2], ['mppot', 0.18]],
});
enemy('shaman', {
  name: 'Dark Shaman', sprite: 'shaman', hp: 240, def: 5, xp: 28, speed: 3, size: 1,
  behavior: 'orbit', band: 2,
  shots: { dmg: 24, speed: 7, range: 7, count: 1, spread: 0, rate: 1, ring: 6, ringRate: 0.25 }, // slow orbs + ring
  loot: [['armor:1-2', 0.22], ['ringmp0', 0.08], ['ringatt0', 0.06]],
});
enemy('harpy', {
  name: 'Shrieking Harpy', sprite: 'harpy', hp: 180, def: 3, xp: 24, speed: 6.5, size: 0.9,
  behavior: 'orbit', band: 2,
  shots: { dmg: 12, speed: 13, range: 6, count: 1, spread: 0, rate: 2.2 }, // fast strafer
  loot: [['weapon:1-2', 0.18], ['mppot', 0.15], ['ringdex0', 0.05]],
});
enemy('forest_witch', {
  name: 'Forest Witch', sprite: 'witch', hp: 1000, def: 8, xp: 130, speed: 3.5, size: 1.3,
  behavior: 'orbit', band: 2, rare: true, entourage: { type: 'spider', count: 3 },
  shots: { dmg: 26, speed: 9, range: 7.5, count: 3, spread: 0.6, rate: 1.2, ring: 8, ringRate: 0.3, status: { type: 'quiet', dur: 2500, chance: 0.5 } }, // hex

  loot: [['weapon:2-3', 0.5], ['armor:2-3', 0.5], ['ringmp0', 0.2], ['portal:spider_grotto', 0.15], ['mppot', 0.3]],
});
// --- band 3: highlands
enemy('ogre', {
  name: 'Highland Ogre', sprite: 'ogre', hp: 700, def: 10, xp: 60, speed: 3, size: 1.4,
  behavior: 'chase', band: 3,
  shots: { dmg: 34, speed: 8, range: 5.5, count: 4, spread: 0.8, rate: 0.8 }, // brutal shotgun
  loot: [['weapon:2-3', 0.25], ['armor:2-3', 0.25], ['ringspd0', 0.08], ['portal:cursed_keep', 0.06]],
});
enemy('gargoyle', {
  name: 'Gargoyle', sprite: 'gargoyle', hp: 550, def: 14, xp: 55, speed: 4.5, size: 1.1,
  behavior: 'orbit', band: 3,
  shots: { dmg: 22, speed: 13, range: 7, count: 1, spread: 0, rate: 1.2, burst: 3, burstGap: 100 }, // triple burst
  loot: [['weapon:2-3', 0.22], ['ringdex0', 0.08], ['mppot', 0.2], ['portal:frozen_depths', 0.05]],
});
enemy('wraith', {
  name: 'Hollow Wraith', sprite: 'wraith', hp: 450, def: 8, xp: 50, speed: 5.5, size: 1,
  behavior: 'chase', band: 3,
  shots: { dmg: 18, speed: 11, range: 6, count: 1, spread: 0, rate: 3 }, // machine gun
  loot: [['armor:2-3', 0.22], ['hppot', 0.2], ['ringall0', 0.03]],
});
enemy('golem', {
  name: 'Granite Golem', sprite: 'golem', hp: 1000, def: 18, xp: 75, speed: 2, size: 1.4,
  behavior: 'wander', band: 3,
  shots: { dmg: 40, speed: 6, range: 6.5, count: 5, spread: 1, rate: 0.5 }, // wall of slow rocks
  loot: [['weapon:2-3', 0.25], ['armor:2-3', 0.25], ['ringdef0', 0.1], ['hppot', 0.2]],
});
enemy('skeleton', {
  name: 'Restless Skeleton', sprite: 'skeleton', hp: 320, def: 6, xp: 35, speed: 4.5, size: 0.9,
  behavior: 'chase', band: 3,
  shots: { dmg: 20, speed: 12, range: 6, count: 1, spread: 0, rate: 1.8 },
  loot: [['weapon:2-3', 0.15], ['mppot', 0.15]],
});
enemy('lich', {
  name: 'Highland Lich', sprite: 'lich', hp: 2000, def: 14, xp: 250, speed: 3, size: 1.5,
  behavior: 'orbit', band: 3, rare: true, entourage: { type: 'skeleton', count: 4 },
  shots: { dmg: 36, speed: 10, range: 8, count: 3, spread: 0.5, rate: 1.4, ring: 10, ringRate: 0.3, spiral: true, ringStatus: { type: 'paralyze', dur: 900, chance: 0.5 } }, // death grip
  loot: [['weapon:3-4', 0.5], ['armor:3-4', 0.5], ['statpot', 0.3], ['portal:cursed_keep', 0.18], ['portal:sunken_tomb', 0.12]],
});
// --- band 4: mountains / gods
enemy('flame_titan', {
  name: 'Flame Titan', sprite: 'flame_titan', hp: 2200, def: 18, xp: 180, speed: 3, size: 1.6,
  behavior: 'orbit', band: 4, god: true,
  shots: { dmg: 45, speed: 11, range: 8, count: 5, spread: 0.9, rate: 1.6, ring: 10, ringRate: 0.2 },
  loot: [['weapon:3-4', 0.3], ['armor:3-4', 0.3], ['statpot', 0.5], ['portal:infernal_depths', 0.07], ['legendary', 0.015]],
});
enemy('storm_seraph', {
  name: 'Storm Seraph', sprite: 'storm_seraph', hp: 1800, def: 15, xp: 170, speed: 5, size: 1.4,
  behavior: 'orbit', band: 4, god: true,
  shots: { dmg: 50, speed: 16, range: 9.5, count: 1, spread: 0, rate: 1.4, burst: 3, burstGap: 120 }, // lightning sniper
  loot: [['weapon:3-4', 0.3], ['ringall0', 0.08], ['statpot', 0.5], ['legendary', 0.015]],
});
enemy('void_keeper', {
  name: 'Void Keeper', sprite: 'void_keeper', hp: 2500, def: 20, xp: 200, speed: 2.5, size: 1.6,
  behavior: 'orbit', band: 4, god: true,
  shots: { dmg: 55, speed: 8, range: 8, count: 1, spread: 0, rate: 1, ring: 14, ringRate: 0.35, ringStatus: { type: 'sick', dur: 3000, chance: 0.6 } }, // curse of the void
  loot: [['armor:3-4', 0.3], ['statpot', 0.55], ['portal:infernal_depths', 0.08], ['portal:abyssal_rift', 0.06], ['legendary', 0.02]],
});
enemy('ancient_colossus', {
  name: 'Ancient Colossus', sprite: 'colossus', hp: 3000, def: 22, xp: 220, speed: 2, size: 1.8,
  behavior: 'orbit', band: 4, god: true,
  shots: { dmg: 50, speed: 10, range: 9, count: 3, spread: 0.5, rate: 1.4, ring: 12, ringRate: 0.3, spiral: true },
  loot: [['weapon:3-4', 0.3], ['armor:3-4', 0.3], ['statpot', 0.55], ['portal:sunken_tomb', 0.07], ['portal:frozen_depths', 0.08], ['legendary', 0.02]],
});
enemy('demon_prince', {
  name: 'Demon Prince', sprite: 'demon_prince', hp: 5000, def: 24, xp: 400, speed: 4, size: 1.8,
  behavior: 'chase', band: 4, god: true, rare: true, entourage: { type: 'imp', count: 3 },
  shots: { dmg: 55, speed: 12, range: 8.5, count: 3, spread: 0.4, rate: 1.2, burst: 2, ring: 12, ringRate: 0.35, spiral: true },
  loot: [['weapon:3-4', 0.5], ['armor:3-4', 0.5], ['statpot', 0.8], ['portal:abyssal_rift', 0.12], ['legendary', 0.05]],
});

// --- dungeon enemies
enemy('goblin_grunt', {
  name: 'Goblin Grunt', sprite: 'goblin', hp: 90, def: 1, xp: 10, speed: 4.5, size: 0.85,
  behavior: 'chase', band: -1,
  shots: { dmg: 9, speed: 9, range: 5, count: 1, spread: 0, rate: 1.4 },
  loot: [['hppot', 0.18], ['weapon:0-1', 0.1]],
});
enemy('goblin_king', {
  name: 'Goblin King', sprite: 'goblin_king', hp: 1500, def: 8, xp: 150, speed: 3.5, size: 1.8,
  behavior: 'boss', band: -1,
  shots: { dmg: 22, speed: 10, range: 7, count: 5, spread: 1.2, rate: 1.4, ring: 8, ringRate: 0.3 },
  loot: [['weapon:1-3', 1], ['armor:1-3', 1], ['pot_def', 0.6], ['pot_spd', 0.5], ['ringhp1', 0.2], ['legendary', 0.02]],
});
enemy('spiderling', {
  name: 'Spiderling', sprite: 'spider', hp: 160, def: 3, xp: 18, speed: 5.5, size: 0.7,
  behavior: 'chase', band: -1,
  shots: { dmg: 13, speed: 11, range: 5, count: 1, spread: 0, rate: 1.6 },
  loot: [['mppot', 0.18], ['weapon:1-2', 0.1]],
});
enemy('brood_mother', {
  name: 'Brood Mother', sprite: 'brood_mother', hp: 3000, def: 12, xp: 280, speed: 3, size: 2,
  behavior: 'boss', band: -1, spawns: { type: 'spiderling', max: 4, rate: 0.15 },
  shots: { dmg: 28, speed: 10, range: 7.5, count: 3, spread: 0.7, rate: 1.6, ring: 12, ringRate: 0.25 },
  loot: [['weapon:2-4', 1], ['armor:2-4', 1], ['pot_dex', 0.7], ['pot_att', 0.6], ['ringmp1', 0.2], ['legendary', 0.03], ['pet_egg', 0.05]],
});
enemy('keep_knight', {
  name: 'Cursed Knight', sprite: 'keep_knight', hp: 500, def: 12, xp: 45, speed: 4, size: 1,
  behavior: 'chase', band: -1,
  shots: { dmg: 26, speed: 10, range: 5.5, count: 2, spread: 0.3, rate: 1.5 },
  loot: [['hppot', 0.2], ['weapon:2-3', 0.12]],
});
enemy('keep_lord', {
  name: 'Lord of the Cursed Keep', sprite: 'keep_lord', hp: 6000, def: 18, xp: 500, speed: 3.5, size: 2,
  behavior: 'boss', band: -1, spawns: { type: 'keep_knight', max: 3, rate: 0.1 },
  shots: { dmg: 40, speed: 11, range: 8, count: 5, spread: 1, rate: 1.8, ring: 16, ringRate: 0.3 },
  loot: [['weapon:3-4', 1], ['armor:3-4', 1], ['pot_vit', 0.8], ['pot_wis', 0.8], ['statpot', 1], ['ringall0', 0.25], ['legendary', 0.05], ['pet_egg', 0.08]],
});
enemy('imp', {
  name: 'Infernal Imp', sprite: 'imp', hp: 700, def: 14, xp: 70, speed: 5.5, size: 0.9,
  behavior: 'chase', band: -1,
  shots: { dmg: 35, speed: 12, range: 6, count: 1, spread: 0, rate: 2 },
  loot: [['mppot', 0.2], ['hppot', 0.2], ['weapon:3-4', 0.08]],
});
enemy('inferno_lord', {
  name: 'Lord of the Inferno', sprite: 'inferno_lord', hp: 14000, def: 25, xp: 1500, speed: 4, size: 2.4,
  behavior: 'boss', band: -1, spawns: { type: 'imp', max: 4, rate: 0.12 },
  enrage: { hpPct: 0.4, rateMul: 1.4, dmgMul: 1.2 },
  shots: { dmg: 60, speed: 12, range: 9, count: 7, spread: 1.4, rate: 2, ring: 20, ringRate: 0.4 },
  loot: [['weapon:4-5', 1], ['armor:4-5', 1], ['pot_life', 0.7], ['pot_mana', 0.7], ['statpot', 1], ['ringall0', 0.4], ['legendary', 0.08], ['pet_egg', 0.15]],
});

enemy('mummy', {
  name: 'Restless Mummy', sprite: 'mummy', hp: 600, def: 10, xp: 55, speed: 3.5, size: 1,
  behavior: 'chase', band: -1,
  shots: { dmg: 28, speed: 9, range: 5.5, count: 2, spread: 0.4, rate: 1.3 },
  loot: [['hppot', 0.2], ['armor:2-3', 0.1]],
});
enemy('tomb_sentinel', {
  name: 'Tomb Sentinel', sprite: 'gargoyle', hp: 800, def: 16, xp: 75, speed: 4, size: 1.1,
  behavior: 'orbit', band: -1,
  shots: { dmg: 32, speed: 11, range: 7, count: 1, spread: 0, rate: 1.8 },
  loot: [['mppot', 0.2], ['weapon:2-3', 0.1]],
});
enemy('pharaoh', {
  name: 'Pharaoh of the Sands', sprite: 'pharaoh', hp: 9000, def: 20, xp: 800, speed: 3.5, size: 2.1,
  behavior: 'boss', band: -1, spawns: { type: 'mummy', max: 3, rate: 0.1 },
  shots: { dmg: 45, speed: 11, range: 8.5, count: 5, spread: 1.1, rate: 1.8, ring: 14, ringRate: 0.35, spiral: true },
  loot: [['weapon:3-4', 1], ['armor:3-4', 1], ['pot_life', 0.5], ['statpot', 1], ['ringhp1', 0.25], ['legendary', 0.06]],
});
enemy('void_spawn', {
  name: 'Void Spawn', sprite: 'void_spawn', hp: 900, def: 16, xp: 90, speed: 5, size: 0.9,
  behavior: 'chase', band: -1,
  shots: { dmg: 38, speed: 12, range: 6, count: 1, spread: 0, rate: 2 },
  loot: [['mppot', 0.2], ['hppot', 0.2], ['armor:3-4', 0.08]],
});
enemy('royal_guard', {
  name: 'Royal Guard', sprite: 'keep_knight', hp: 1200, def: 18, xp: 110, speed: 4.5, size: 1.1,
  behavior: 'chase', band: -1,
  shots: { dmg: 40, speed: 11, range: 6, count: 2, spread: 0.3, rate: 1.8 },
  loot: [['hppot', 0.25], ['mppot', 0.25], ['weapon:3-4', 0.1]],
});
enemy('mad_king', {
  name: 'O Rei Demente', sprite: 'mad_king', hp: 30000, def: 30, xp: 4000, speed: 4, size: 2.6,
  behavior: 'boss', band: -1, spawns: { type: 'royal_guard', max: 5, rate: 0.15 },
  enrage: { hpPct: 0.35, rateMul: 1.5, dmgMul: 1.25 },
  shots: { dmg: 70, speed: 13, range: 10, count: 9, spread: 1.6, rate: 2.2, ring: 26, ringRate: 0.45, spiral: true, status: { type: 'weak', dur: 2500, chance: 0.4 }, ringStatus: { type: 'slow', dur: 1500, chance: 0.5 } },
  loot: [['weapon:4-5', 1], ['armor:4-5', 1], ['pot_life', 0.8], ['pot_mana', 0.8], ['statpot', 1], ['ringking', 0.4], ['ringall0', 0.5], ['legendary', 0.25]],
});
enemy('abyss_horror', {
  name: 'Horror of the Abyss', sprite: 'abyss_horror', hp: 18000, def: 28, xp: 2000, speed: 3.5, size: 2.4,
  behavior: 'boss', band: -1, spawns: { type: 'void_spawn', max: 4, rate: 0.12 },
  shots: { dmg: 65, speed: 12, range: 9, count: 7, spread: 1.4, rate: 2, ring: 22, ringRate: 0.4, spiral: true },
  loot: [['weapon:4-5', 1], ['armor:4-5', 1], ['pot_life', 0.8], ['pot_mana', 0.8], ['statpot', 1], ['ringall0', 0.5], ['legendary', 0.12]],
});
// secret finale boss, reachable only from a portal the Mad King leaves behind
enemy('the_tyrant', {
  name: 'O Tirano', sprite: 'tyrant', hp: 60000, def: 38, xp: 8000, speed: 4.5, size: 3,
  behavior: 'boss', band: -1, spawns: { type: 'royal_guard', max: 6, rate: 0.18 },
  enrage: { hpPct: 0.4, rateMul: 1.6, dmgMul: 1.3 },
  shots: { dmg: 80, speed: 14, range: 11, count: 11, spread: 1.8, rate: 2.4, ring: 30, ringRate: 0.5, spiral: true,
    status: { type: 'weak', dur: 2500, chance: 0.4 }, ringStatus: { type: 'slow', dur: 1500, chance: 0.5 } },
  phases: [
    { hpPct: 0.66, cry: 'cerra fileiras!', shots: { dmg: 75, speed: 13, range: 11, count: 13, spread: 0.6, rate: 3, ringStatus: { type: 'weak', dur: 2000, chance: 0.4 } } },
    { hpPct: 0.33, cry: 'desata a tempestade!', shots: { dmg: 85, speed: 12, range: 12, count: 3, spread: 0.4, rate: 2, ring: 40, ringRate: 0.7, spiral: true, ringStatus: { type: 'slow', dur: 1500, chance: 0.6 } } },
  ],
  loot: [['weapon:5-5', 1], ['armor:5-5', 1], ['legendary', 1], ['legendary', 0.6],
    ['ringtyrant', 0.5], ['statpot', 1], ['pot_life', 1], ['pot_mana', 1]],
});

// --- world-event invasion bosses (spawned in the realm on a timer) ---
enemy('invader_warlord', {
  name: 'Senhor da Guerra Invasor', sprite: 'invader_warlord', hp: 20000, def: 24, xp: 2400, speed: 4, size: 2.4,
  behavior: 'chase', band: -1, event: true, spawns: { type: 'bandit', max: 5, rate: 0.16 },
  enrage: { hpPct: 0.4, rateMul: 1.5, dmgMul: 1.25 },
  shots: { dmg: 60, speed: 12, range: 9, count: 5, spread: 1, rate: 1.8, burst: 3, burstGap: 110, ring: 18, ringRate: 0.4 },
  loot: [['weapon:4-5', 1], ['armor:4-5', 1], ['legendary', 1], ['statpot', 1], ['pot_life', 0.5], ['ringall0', 0.5]],
});
enemy('invader_archmage', {
  name: 'Arquimago Invasor', sprite: 'invader_archmage', hp: 18000, def: 20, xp: 2400, speed: 3.5, size: 2.2,
  behavior: 'orbit', band: -1, event: true, spawns: { type: 'imp', max: 4, rate: 0.14 },
  enrage: { hpPct: 0.4, rateMul: 1.5, dmgMul: 1.25 },
  shots: { dmg: 55, speed: 11, range: 10, count: 3, spread: 0.5, rate: 1.6, ring: 22, ringRate: 0.45, spiral: true,
    status: { type: 'slow', dur: 2000, chance: 0.4 } },
  loot: [['weapon:4-5', 1], ['armor:4-5', 1], ['legendary', 1], ['statpot', 1], ['pot_mana', 0.5], ['ringall0', 0.5]],
});

// --- ice biome: Frozen Depths dungeon (theme 'ice') ---
enemy('frost_imp', {
  name: 'Frost Imp', sprite: 'frost_imp', hp: 320, def: 6, xp: 32, speed: 5.5, size: 0.8,
  behavior: 'chase', band: -1,
  shots: { dmg: 22, speed: 11, range: 5.5, count: 1, spread: 0, rate: 1.8, status: { type: 'slow', dur: 1200, chance: 0.25 } },
  loot: [['mppot', 0.18], ['weapon:2-3', 0.1]],
});
enemy('snow_wolf', {
  name: 'Snow Wolf', sprite: 'snow_wolf', hp: 380, def: 5, xp: 34, speed: 6, size: 0.9,
  behavior: 'chase', band: -1, melee: { dmg: 30, rate: 1.2 },
  shots: { dmg: 18, speed: 10, range: 5, count: 1, spread: 0, rate: 1.2 },
  loot: [['hppot', 0.2], ['armor:2-3', 0.1]],
});
enemy('ice_golem', {
  name: 'Ice Golem', sprite: 'ice_golem', hp: 1400, def: 20, xp: 90, speed: 2, size: 1.5,
  behavior: 'wander', band: -1,
  shots: { dmg: 40, speed: 6, range: 6.5, count: 5, spread: 1, rate: 0.6, status: { type: 'slow', dur: 1500, chance: 0.4 } },
  loot: [['weapon:3-4', 0.18], ['armor:3-4', 0.18], ['ringdef0', 0.1]],
});
enemy('frost_archer', {
  name: 'Frost Archer', sprite: 'frost_archer', hp: 420, def: 8, xp: 40, speed: 4, size: 0.9,
  behavior: 'orbit', band: -1,
  shots: { dmg: 34, speed: 15, range: 8, count: 1, spread: 0, rate: 0.9, status: { type: 'slow', dur: 1500, chance: 0.5 } },
  loot: [['weapon:3-4', 0.15], ['mppot', 0.15]],
});
enemy('yeti', {
  name: 'Snowfield Yeti', sprite: 'yeti', hp: 1600, def: 14, xp: 110, speed: 4.5, size: 1.5,
  behavior: 'chase', band: -1,
  shots: { dmg: 30, speed: 11, range: 6, count: 2, spread: 0.3, rate: 1.2, burst: 3, burstGap: 100 },
  loot: [['weapon:3-4', 0.2], ['armor:3-4', 0.2], ['hppot', 0.25]],
});
enemy('ice_wisp', {
  name: 'Ice Wisp', sprite: 'ice_wisp', hp: 260, def: 4, xp: 30, speed: 6, size: 0.7,
  behavior: 'orbit', band: -1,
  shots: { dmg: 20, speed: 13, range: 6, count: 1, spread: 0, rate: 2.4 },
  loot: [['mppot', 0.2]],
});
enemy('frost_shaman', {
  name: 'Frost Shaman', sprite: 'frost_shaman', hp: 900, def: 12, xp: 80, speed: 3, size: 1.1,
  behavior: 'orbit', band: -1,
  shots: { dmg: 30, speed: 9, range: 7.5, count: 3, spread: 0.6, rate: 1.2, ring: 10, ringRate: 0.3, status: { type: 'slow', dur: 1500, chance: 0.4 } },
  loot: [['armor:3-4', 0.18], ['ringmp0', 0.1], ['statpot', 0.15]],
});
enemy('frost_monarch', {
  name: 'Monarca do Gelo', sprite: 'frost_monarch', hp: 24000, def: 26, xp: 2200, speed: 3.5, size: 2.4,
  behavior: 'boss', band: -1, spawns: { type: 'ice_wisp', max: 4, rate: 0.14 },
  enrage: { hpPct: 0.35, rateMul: 1.5, dmgMul: 1.25 },
  shots: { dmg: 60, speed: 12, range: 9.5, count: 7, spread: 1.4, rate: 2, ring: 24, ringRate: 0.42, spiral: true,
    status: { type: 'slow', dur: 2000, chance: 0.4 }, ringStatus: { type: 'paralyze', dur: 900, chance: 0.3 } },
  phases: [
    { hpPct: 0.6, cry: 'invoca a nevasca!', shots: { dmg: 55, speed: 10, range: 9, count: 9, spread: 1.6, rate: 2.4, ring: 16, ringRate: 0.4, status: { type: 'slow', dur: 2000, chance: 0.5 } } },
    { hpPct: 0.3, cry: 'congela tudo!', shots: { dmg: 65, speed: 12, range: 10, count: 1, spread: 0, rate: 2, ring: 32, ringRate: 0.7, spiral: true, ringStatus: { type: 'paralyze', dur: 1100, chance: 0.4 } } },
  ],
  loot: [['weapon:4-5', 1], ['armor:4-5', 1], ['statpot', 1], ['pot_life', 0.5], ['legendary', 0.1], ['ringall0', 0.4]],
});

// ---------------------------------------------------------------- dungeons
const DUNGEONS = {
  frozen_depths: {
    name: 'Frozen Depths', theme: 'ice', size: 110, rooms: 11,
    minions: ['frost_imp', 'snow_wolf', 'ice_golem', 'frost_archer', 'yeti', 'ice_wisp', 'frost_shaman'],
    minionCount: 36, boss: 'frost_monarch',
  },
  goblin_warren: {
    name: 'Goblin Warren', theme: 'cave', size: 80, rooms: 8,
    minions: ['goblin_grunt'], minionCount: 26, boss: 'goblin_king',
  },
  spider_grotto: {
    name: 'Spider Grotto', theme: 'cave', size: 90, rooms: 9,
    minions: ['spiderling', 'spider'], minionCount: 30, boss: 'brood_mother',
  },
  cursed_keep: {
    name: 'Cursed Keep', theme: 'keep', size: 100, rooms: 10,
    minions: ['keep_knight', 'wraith'], minionCount: 32, boss: 'keep_lord',
  },
  infernal_depths: {
    name: 'Infernal Depths', theme: 'inferno', size: 110, rooms: 11,
    minions: ['imp', 'flame_titan'], minionCount: 34, boss: 'inferno_lord',
  },
  sunken_tomb: {
    name: 'Sunken Tomb', theme: 'keep', size: 100, rooms: 10,
    minions: ['mummy', 'tomb_sentinel'], minionCount: 30, boss: 'pharaoh',
  },
  abyssal_rift: {
    name: 'Abyssal Rift', theme: 'inferno', size: 120, rooms: 12,
    minions: ['void_spawn', 'imp'], minionCount: 36, boss: 'abyss_horror',
  },
  // final fight when the realm closes (never drops as a portal item)
  mad_castle: {
    name: 'Castelo do Rei Demente', theme: 'keep', size: 110, rooms: 10,
    minions: ['royal_guard', 'keep_knight'], minionCount: 30, boss: 'mad_king',
  },
  // secret finale, reached only via the portal the Mad King leaves on death
  tyrant_sanctum: {
    name: 'Santuario do Tirano', theme: 'inferno', size: 90, rooms: 6,
    minions: ['royal_guard', 'void_spawn'], minionCount: 18, boss: 'the_tyrant',
  },
};

const STAT_POTS = ['pot_att', 'pot_def', 'pot_spd', 'pot_dex', 'pot_vit', 'pot_wis'];

module.exports = { CLASSES, ITEMS, ENEMIES, DUNGEONS, STAT_POTS, LEGENDARIES, STARTER_CLASSES };
