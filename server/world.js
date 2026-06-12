'use strict';
// Map generation: nexus (safe hub), realm (procedural overworld with
// difficulty bands toward the center) and instanced dungeons.

// Tile ids (keep in sync with client sprites.js)
const T = {
  VOID: 0, GRASS: 1, SAND: 2, WATER: 3, ROCK: 4, ROAD: 5,
  FOREST: 6, MOUNTAIN: 7, LAVA: 8, FLOOR: 9, WALL: 10, NEXUS: 11,
};
const BLOCKING = new Set([T.VOID, T.ROCK, T.WALL]);
const SLOW = new Set([T.WATER]);
const DAMAGING = new Set([T.LAVA]);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple value-noise for the realm heightmap.
function makeNoise(rand, gridSize) {
  const g = [];
  for (let i = 0; i < gridSize * gridSize; i++) g.push(rand());
  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const s = (a, b, t) => a + (b - a) * (t * t * (3 - 2 * t));
    const at = (gx, gy) => g[((gy % gridSize + gridSize) % gridSize) * gridSize + ((gx % gridSize + gridSize) % gridSize)];
    return s(s(at(xi, yi), at(xi + 1, yi), xf), s(at(xi, yi + 1), at(xi + 1, yi + 1), xf), yf);
  };
}

class GameMap {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.tiles = new Uint8Array(w * h);
  }
  get(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return T.VOID;
    return this.tiles[y * this.w + x];
  }
  set(x, y, t) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.tiles[y * this.w + x] = t;
  }
  blocks(x, y) { return BLOCKING.has(this.get(x, y)); }
  slows(x, y) { return SLOW.has(this.get(x, y)); }
  damages(x, y) { return DAMAGING.has(this.get(x, y)); }
}

// ---------------------------------------------------------------- nexus
function generateNexus() {
  const size = 40;
  const m = new GameMap(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5);
      if (d < 16) m.set(x, y, T.NEXUS);
      if (d < 5) m.set(x, y, T.ROAD);
    }
  }
  m.spawn = { x: c, y: c + 6 };
  m.portalSpot = { x: c, y: c - 6 }; // realm portal location
  return m;
}

// ---------------------------------------------------------------- realm
// Concentric difficulty: band 0 (beach) at the edge -> band 4 (gods) center.
function generateRealm(seed) {
  const size = 260;
  const m = new GameMap(size, size);
  const rand = mulberry32(seed);
  const noise = makeNoise(rand, 32);
  const c = size / 2;
  const maxR = c - 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c + 0.5, dy = y - c + 0.5;
      // wobbly island edge
      const ang = Math.atan2(dy, dx);
      const wob = 1 + 0.12 * Math.sin(ang * 5 + seed % 10) + 0.2 * (noise(x / 24, y / 24) - 0.5);
      const d = Math.hypot(dx, dy) / wob;
      if (d > maxR) { m.set(x, y, T.WATER); continue; }
      const band = bandAt(d, maxR);
      const n = noise(x / 9, y / 9);
      let t;
      if (band === 0) t = T.SAND;
      else if (band === 1) t = n > 0.72 ? T.WATER : T.GRASS;
      else if (band === 2) t = n > 0.78 ? T.ROCK : T.FOREST;
      else if (band === 3) t = n > 0.74 ? T.ROCK : (n < 0.2 ? T.GRASS : T.MOUNTAIN);
      else t = n > 0.82 ? T.LAVA : (n > 0.74 ? T.ROCK : T.MOUNTAIN);
      m.set(x, y, t);
    }
  }
  // central arena for the realm gods
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5);
      if (d < 14) m.set(x, y, d < 12 ? T.MOUNTAIN : T.LAVA);
    }
  }
  m.center = { x: c, y: c };
  m.maxR = maxR;
  // spawn on the beach at a random angle
  m.spawnFor = (rng) => {
    for (let i = 0; i < 80; i++) {
      const a = (rng || Math.random)() * Math.PI * 2;
      const r = maxR * 0.93;
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      if (!m.blocks(x, y) && m.get(x, y) !== T.WATER) return { x, y };
    }
    return { x: c, y: c + maxR * 0.9 };
  };
  return m;
}

function bandAt(dist, maxR) {
  const f = dist / maxR; // 1 = edge, 0 = center
  if (f > 0.88) return 0;
  if (f > 0.62) return 1;
  if (f > 0.38) return 2;
  if (f > 0.16) return 3;
  return 4;
}

// ---------------------------------------------------------------- dungeons
// Random rooms connected by corridors; last room holds the boss.
function generateDungeon(defn, seed) {
  const size = defn.size;
  const m = new GameMap(size, size);
  const rand = mulberry32(seed);
  m.tiles.fill(T.WALL);

  const rooms = [];
  let tries = 0;
  while (rooms.length < defn.rooms && tries++ < 400) {
    const w = 8 + Math.floor(rand() * 8);
    const h = 8 + Math.floor(rand() * 8);
    const x = 2 + Math.floor(rand() * (size - w - 4));
    const y = 2 + Math.floor(rand() * (size - h - 4));
    const r = { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
    if (rooms.some(o => x < o.x + o.w + 2 && x + w + 2 > o.x && y < o.y + o.h + 2 && y + h + 2 > o.y)) continue;
    rooms.push(r);
  }
  // order rooms as a chain from the first
  for (let i = 1; i < rooms.length; i++) {
    let best = i, bd = Infinity;
    for (let j = i; j < rooms.length; j++) {
      const d = Math.hypot(rooms[j].cx - rooms[i - 1].cx, rooms[j].cy - rooms[i - 1].cy);
      if (d < bd) { bd = d; best = j; }
    }
    [rooms[i], rooms[best]] = [rooms[best], rooms[i]];
  }
  const floor = defn.theme === 'inferno' ? T.FLOOR : T.FLOOR;
  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) m.set(x, y, floor);
  }
  // corridors
  for (let i = 1; i < rooms.length; i++) {
    let x = Math.floor(rooms[i - 1].cx), y = Math.floor(rooms[i - 1].cy);
    const tx = Math.floor(rooms[i].cx), ty = Math.floor(rooms[i].cy);
    while (x !== tx) { m.set(x, y, floor); m.set(x, y + 1, floor); x += Math.sign(tx - x); }
    while (y !== ty) { m.set(x, y, floor); m.set(x + 1, y, floor); y += Math.sign(ty - y); }
  }
  // lava pools for inferno theme
  if (defn.theme === 'inferno') {
    for (const r of rooms.slice(1)) {
      if (rand() < 0.5) {
        const px = r.x + 2 + Math.floor(rand() * (r.w - 4));
        const py = r.y + 2 + Math.floor(rand() * (r.h - 4));
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) m.set(px + dx, py + dy, T.LAVA);
      }
    }
  }
  m.rooms = rooms;
  m.spawn = { x: rooms[0].cx, y: rooms[0].cy };
  m.bossRoom = rooms[rooms.length - 1];
  return m;
}

module.exports = { T, GameMap, generateNexus, generateRealm, generateDungeon, bandAt, mulberry32 };
