'use strict';
// Client game engine: world/entity rendering via Renderer3D (three.js,
// tilted orthographic "2.5D"), with a transparent 2D overlay canvas for
// names, bars, damage text, effects and the minimap. Input, local
// prediction and server reconciliation live here too.

const GameClient = (() => {
  const TILE = 40;             // pixels per tile at zoom 1
  const canvas = document.getElementById('canvas');      // 2D overlay
  const ctx = canvas.getContext('2d');
  const canvas3d = document.getElementById('canvas3d');  // WebGL world
  const minimap = document.getElementById('minimap');
  const mctx = minimap.getContext('2d');
  let gl3dReady = false;

  let running = false;
  let world = null;            // { w, h, tiles: Uint8Array, kind, name }
  let myId = 0;
  let me = { x: 0, y: 0 };     // local predicted position
  let self = null;             // server-sent stats/inventory
  let entities = new Map();    // id -> rendered entity (lerped)
  let bullets = [];            // client-side animated bullets
  let effects = [];            // transient fx (novas, damage text...)
  let lastTickEntities = [];
  let keys = {};
  let mouse = { x: 0, y: 0, down: false };
  let joy = null;              // virtual joystick: { id, ox, oy, dx, dy }
  let aimTouch = null;         // touch id currently aiming/shooting
  let touchMode = false;
  let spectating = false;      // dead but watching the fight
  let lastFrame = 0;
  let shooting = false;
  let mapCanvas = null;        // pre-rendered tile layer
  let minimapDirty = true;
  let deathInfo = null;
  let onDeath = null;

  // ------------------------------------------------ world setup
  function loadWorld(msg) {
    const tiles = Uint8Array.from(atob(msg.tiles), c => c.charCodeAt(0));
    world = { w: msg.w, h: msg.h, tiles, kind: msg.kind, name: msg.name };
    me.x = msg.x; me.y = msg.y;
    myId = msg.you;
    entities.clear(); bullets = []; effects = [];
    prerenderMap();
    minimapDirty = true;
    UI.setZone(msg.name);
    if (!gl3dReady) {
      Renderer3D.init(canvas3d);
      gl3dReady = true;
      resize();
    }
    Renderer3D.setWorld(world, [mapCanvas, mapCanvasB]);
  }

  function tileAt(x, y) {
    x |= 0; y |= 0;
    if (!world || x < 0 || y < 0 || x >= world.w || y >= world.h) return 0;
    return world.tiles[y * world.w + x];
  }
  function blocked(x, y) { return TILE_BLOCKING.has(tileAt(x, y)); }

  let mapCanvasB = null; // second phase: liquid tiles shimmer
  const LIQUID = new Set([3, 8, 13]); // water, lava, frost pool
  function buildMapCanvas(phase) {
    const px = 8; // pixels per tile in the prerender (scaled when drawn)
    const cv = document.createElement('canvas');
    cv.width = world.w * px; cv.height = world.h * px;
    const c = cv.getContext('2d');
    for (let y = 0; y < world.h; y++) {
      for (let x = 0; x < world.w; x++) {
        const t = world.tiles[y * world.w + x];
        const col = TILE_COLORS[t] || TILE_COLORS[0];
        // liquids swap their checker phase each frame -> ripple shimmer
        const flip = phase === 1 && LIQUID.has(t);
        c.fillStyle = (((x + y) % 2 === 0) !== flip) ? col[0] : col[1];
        c.fillRect(x * px, y * px, px, px);
        if (t === 10 || t === 4) {
          c.fillStyle = 'rgba(255,255,255,0.06)';
          c.fillRect(x * px, y * px, px, 2);
        } else if (flip) {
          // sparse highlight pixels sell the water/lava movement
          if (((x * 31 + y * 17) % 7) === 0) {
            c.fillStyle = 'rgba(255,255,255,0.18)';
            c.fillRect(x * px + 2, y * px + 3, 2, 1);
          }
        }
      }
    }
    return cv;
  }
  function prerenderMap() {
    mapCanvas = buildMapCanvas(0);
    mapCanvasB = buildMapCanvas(1);
  }

  // ------------------------------------------------ network handlers
  let lowHpWarned = false;
  function onTick(msg) {
    self = msg.self;
    UI.update(self);
    const q = self.quest;
    UI.setBoss(q, q && Math.hypot(q.x - me.x, q.y - me.y) < 18);
    // alert sound the moment HP crosses below 30% (rearmed once you recover)
    if (self.maxHp) {
      const low = self.hp / self.maxHp < 0.3;
      if (low && !lowHpWarned) { lowHpWarned = true; if (typeof Sfx !== 'undefined') Sfx.hit(); UI.notice('VIDA BAIXA!'); }
      else if (!low && self.hp / self.maxHp > 0.45) lowHpWarned = false;
    }
    const seen = new Set();
    for (const e of msg.e) {
      const kind = e[0];
      if (kind === 'p') {
        const [, id, name, classId, x, y, hp, maxHp, level, invis, guild, pet, title, nameColor, skin] = e;
        seen.add(id);
        let ent = entities.get(id);
        if (!ent) { ent = { kind, x, y }; entities.set(id, ent); }
        Object.assign(ent, { kind, id, name, classId, tx: x, ty: y, hp, maxHp, level, invis, guild, pet, title, nameColor, skin });
        if (id === myId) {
          // server correction: hard snap only when truly desynced; smaller
          // drifts get pulled back gently so it never *feels* like a rollback
          const drift = Math.hypot(me.x - x, me.y - y);
          if (drift > 4) { me.x = x; me.y = y; }
          else if (drift > 1.2) { me.x += (x - me.x) * 0.12; me.y += (y - me.y) * 0.12; }
          ent.tx = me.x; ent.ty = me.y;
        }
      } else if (kind === 'e') {
        const [, id, type, x, y, hp, maxHp, elite] = e;
        seen.add(id);
        let ent = entities.get(id);
        if (!ent) { ent = { kind, x, y }; entities.set(id, ent); }
        Object.assign(ent, { kind, id, type, tx: x, ty: y, hp, maxHp, elite });
      } else if (kind === 'b') {
        const [, id, x, y, tier, items] = e;
        seen.add(id);
        entities.set(id, { kind, id, x, y, tx: x, ty: y, tier, items });
      } else if (kind === 'o') {
        const [, id, pkind, x, y, name] = e;
        seen.add(id);
        entities.set(id, { kind, id, pkind, x, y, tx: x, ty: y, name });
      } else if (kind === 'v') {
        const [, , x, y, vault] = [e[0], e[1], e[2], e[3], e[4]];
        seen.add('vault');
        entities.set('vault', { kind: 'v', id: 'vault', x, y, tx: x, ty: y });
        UI.showVault(vault);
      }
    }
    for (const id of entities.keys()) if (!seen.has(id)) entities.delete(id);
    if (!seen.has('vault')) UI.showVault(null);

    // loot bag under the player?
    let bag = null;
    for (const ent of entities.values()) {
      if (ent.kind === 'b' && Math.hypot(ent.tx - me.x, ent.ty - me.y) < 1.2) { bag = ent; break; }
    }
    UI.showBag(bag);
  }

  // positional volume: full up close, fading out by ~22 tiles
  function volAt(x, y) { return Math.max(0, 1 - Math.hypot(x - me.x, y - me.y) / 22); }

  function onShot(msg) {
    if (typeof Sfx !== 'undefined' && msg.f === 1) {
      if (msg.o === myId) Sfx.shoot();
      else Sfx.shoot(volAt(msg.x, msg.y) * 0.5); // allies' shots, softer with distance
    }
    // shooter lunges briefly toward the volley's center angle
    const owner = entities.get(msg.o);
    if (owner && msg.as.length) {
      owner.lungeT = 0.14;
      owner.lungeA = msg.as[(msg.as.length / 2) | 0];
      if (Math.abs(Math.cos(owner.lungeA)) > 0.3) owner.facing = Math.cos(owner.lungeA) < 0 ? -1 : 1;
    }
    for (const a of msg.as) {
      bullets.push({
        x: msg.x, y: msg.y, a,
        speed: msg.spd, left: msg.rg,
        friendly: msg.f === 1, kind: msg.k,
      });
    }
  }

  let shake = 0; // seconds of camera shake left
  function onDmg(msg) {
    if (msg.id === myId && msg.n > 0 && typeof Sfx !== 'undefined') Sfx.hit();
    const ent = entities.get(msg.id);
    if (ent && ent.kind === 'e' && msg.n > 0) ent.hitT = 0.12;          // enemy hit flash
    if (msg.id === myId && self && msg.n >= Math.max(10, self.maxHp * 0.09)) {
      shake = 0.3;                                                       // heavy hits rattle the camera
    }
    const x = ent ? (ent.x ?? ent.tx) : null;
    if (x === null && msg.id !== myId) return;
    const px = ent ? ent.x : me.x, py = ent ? ent.y : me.y;
    effects.push({
      kind: 'text', x: px, y: py - 0.6,
      text: msg.n < 0 ? `+${-msg.n}` : `-${msg.n}`,
      color: msg.n < 0 ? '#50ff50' : (msg.id === myId ? '#ff4040' : '#ffd040'),
      t: 0, ttl: 0.9,
    });
  }

  // ground telegraph: a boss is winding up a big attack there
  function onTele(msg) {
    effects.push({ kind: 'tele', x: msg.x, y: msg.y, r: msg.r, t: 0, ttl: msg.ms / 1000 });
    if (typeof Sfx !== 'undefined') Sfx.warn(volAt(msg.x, msg.y));
  }

  // each class ability has its own color signature (ring + particle burst)
  const ABILITY_FX = {
    spell: ['#9adcff', 18],     // Wizard: frost nova
    helm: ['#ff9a4a', 14],      // Warrior: berserk
    tome: ['#6dff8a', 20],      // Priest: heal
    cloak: ['#b8a0e8', 12],     // Rogue: vanish
    shield: ['#ffd873', 20],    // Knight: stun shockwave
    skull: ['#a06dff', 18],     // Necromancer: drain
    trap: ['#7ac74f', 14],      // Huntress: trap
    seal: ['#ffe28a', 20],      // Paladin: holy aura
    orb: ['#64e8ff', 16],       // Mystic: stasis
    prism: ['#ff7ae8', 14],     // Trickster: blink
    wakizashi: ['#ff5a5a', 14], // Samurai: expose slash
  };

  function onFx(msg) {
    if (typeof Sfx !== 'undefined') {
      if (msg.k === 'die') Sfx.kill(0.3 + 0.7 * volAt(msg.x, msg.y));
      if (msg.k === 'levelup') Sfx.levelup();
    }
    const abFx = msg.ab && ABILITY_FX[msg.ab];
    if (gl3dReady) {
      if (msg.k === 'die') {
        // pixel burst in the dying enemy's palette; big deaths shake nearby screens
        Renderer3D.burst(msg.x, msg.y, nearestEnemyColor(msg.x, msg.y), 8 + Math.round((msg.r || 1) * 8), 2 + (msg.r || 1));
        if ((msg.r || 1) >= 1.5 && Math.hypot(msg.x - me.x, msg.y - me.y) < 12) shake = Math.max(shake, 0.35);
      } else if (msg.k === 'levelup') {
        Renderer3D.burst(msg.x, msg.y, '#ffd873', 22, 3);
      } else if (abFx) {
        Renderer3D.burst(msg.x, msg.y, abFx[0], abFx[1], 2.5);
      } else if (msg.k === 'nova') {
        Renderer3D.burst(msg.x, msg.y, '#7ec8ff', 10, 2.5);
      }
    }
    effects.push({ kind: msg.k, x: msg.x, y: msg.y, r: msg.r || 1, s: msg.s, color: abFx && abFx[0], t: 0, ttl: 0.6 });
  }

  // average opaque color of the sprite of the enemy nearest to (x, y)
  const avgColorCache = new Map();
  function nearestEnemyColor(x, y) {
    let best = null, bestD = 2.5;
    for (const ent of entities.values()) {
      if (ent.kind !== 'e') continue;
      const d = Math.hypot(ent.x - x, ent.y - y);
      if (d < bestD) { bestD = d; best = ent; }
    }
    if (!best) return '#e0a060';
    let col = avgColorCache.get(best.type);
    if (!col) {
      const spr = Sprites.get(best.type);
      if (!spr) return '#e0a060';
      const c = spr.getContext('2d');
      const data = c.getImageData(0, 0, spr.width, spr.height).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 100) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
      }
      col = n ? `rgb(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0})` : '#e0a060';
      avgColorCache.set(best.type, col);
    }
    return col;
  }

  // status type -> display color / short label
  const STATUS_INFO = {
    slow: ['#c8a0e8', 'LENTO'], paralyze: ['#f0d040', 'PARAL'],
    bleed: ['#e04040', 'SANGRA'], sick: ['#80c040', 'DOENTE'],
    quiet: ['#4080e0', 'SILENC'], weak: ['#b08060', 'FRACO'],
  };

  // ------------------------------------------------ input
  function setupInput() {
    onkeydown = (e) => {
      const chatInput = document.getElementById('chat-input');
      if (document.activeElement === chatInput) {
        if (e.key === 'Enter') {
          const text = chatInput.value.trim();
          if (text) Net.send({ t: 'chat', text });
          chatInput.value = '';
          chatInput.classList.add('hidden');
          chatInput.blur();
        } else if (e.key === 'Escape') {
          chatInput.value = '';
          chatInput.classList.add('hidden');
          chatInput.blur();
        }
        return;
      }
      if (!running) return;
      keys[e.key.toLowerCase()] = true;
      if (e.key === 'Enter') {
        chatInput.classList.remove('hidden');
        chatInput.focus();
        e.preventDefault();
      }
      if (e.key === ' ') {
        const w = screenToWorld(mouse.x, mouse.y);
        Net.send({ t: 'ability', x: w.x, y: w.y });
        e.preventDefault();
      }
      if (e.key === 'Escape' || e.key.toLowerCase() === 'r') Net.send({ t: 'nexus' });
      if (e.key >= '1' && e.key <= '8') {
        if (e.altKey) { Net.send({ t: 'feedpet', slot: 3 + parseInt(e.key, 10) }); e.preventDefault(); }
        else Net.send({ t: 'useitem', slot: 3 + parseInt(e.key, 10) });
      }
      if (e.key.toLowerCase() === 'f') Net.send({ t: 'portal' });
      if (e.key.toLowerCase() === 'm' && typeof Sfx !== 'undefined') UI.notice(Sfx.toggleMute() ? 'Som desligado' : 'Som ligado');
      if (e.key.toLowerCase() === 'h') { const o = document.getElementById('help-overlay'); if (o) o.classList.toggle('hidden'); }
    };
    onkeyup = (e) => { keys[e.key.toLowerCase()] = false; };
    canvas.onmousemove = (e) => { mouse.x = e.clientX; mouse.y = e.clientY; };
    canvas.onmousedown = (e) => { if (e.button === 0) shooting = true; };
    canvas.onmouseup = (e) => { if (e.button === 0) shooting = false; };
    canvas.oncontextmenu = (e) => e.preventDefault();
    window.onblur = () => { keys = {}; shooting = false; };
    onresize = resize;
    resize();
    mouse.x = canvas.width / 2; mouse.y = canvas.height / 3; // sane default aim
    setupTouch();
  }

  // ---------------- touch: left thumb = joystick, right thumb = aim & fire
  function setupTouch() {
    const ui = document.getElementById('touch-ui');
    const enterTouchMode = () => {
      if (touchMode) return;
      touchMode = true;
      document.body.classList.add('touch-mode');
      if (ui) ui.classList.remove('hidden');
    };
    if (matchMedia('(pointer: coarse)').matches) enterTouchMode();

    const JOY_MAX = 52; // px from anchor for a full-speed input
    canvas.addEventListener('touchstart', (e) => {
      enterTouchMode();
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.clientX < innerWidth * 0.45 && !joy) {
          joy = { id: t.identifier, ox: t.clientX, oy: t.clientY, dx: 0, dy: 0 };
        } else if (aimTouch === null) {
          aimTouch = t.identifier;
          mouse.x = t.clientX; mouse.y = t.clientY;
          shooting = true;
        }
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (joy && t.identifier === joy.id) {
          const dx = t.clientX - joy.ox, dy = t.clientY - joy.oy;
          const len = Math.hypot(dx, dy);
          if (len < 10) { joy.dx = 0; joy.dy = 0; }           // dead zone
          else { const k = Math.min(1, len / JOY_MAX) / len; joy.dx = dx * k; joy.dy = dy * k; }
        } else if (t.identifier === aimTouch) {
          mouse.x = t.clientX; mouse.y = t.clientY;
        }
      }
    }, { passive: false });
    const endTouch = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (joy && t.identifier === joy.id) joy = null;
        if (t.identifier === aimTouch) { aimTouch = null; shooting = false; }
      }
    };
    canvas.addEventListener('touchend', endTouch, { passive: false });
    canvas.addEventListener('touchcancel', endTouch, { passive: false });

    // action buttons
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    };
    bind('btn-t-ability', () => {
      const w = screenToWorld(mouse.x, mouse.y);
      Net.send({ t: 'ability', x: w.x, y: w.y });
    });
    bind('btn-t-portal', () => Net.send({ t: 'portal' }));
    bind('btn-t-nexus', () => Net.send({ t: 'nexus' }));
    bind('btn-t-chat', () => {
      const input = document.getElementById('chat-input');
      input.classList.remove('hidden');
      input.focus();
    });
    bind('btn-hud-toggle', () => {
      document.getElementById('hud-right').classList.toggle('open');
    });
  }

  function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    if (gl3dReady) Renderer3D.resize();
  }

  function screenToWorld(sx, sy) {
    if (gl3dReady) return Renderer3D.screenToWorld(sx, sy);
    return { x: me.x, y: me.y };
  }

  // ------------------------------------------------ simulation
  let moveAccum = 0;
  let shotAccum = 0;
  function update(dt) {
    if (!world || !self) return;
    // movement (keyboard or virtual joystick)
    let dx = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
    let dy = (keys['s'] || keys['arrowdown'] ? 1 : 0) - (keys['w'] || keys['arrowup'] ? 1 : 0);
    if (joy && (joy.dx || joy.dy)) { dx = joy.dx; dy = joy.dy; }
    const st = self.st || {};
    // spectator: ignore inputs, glide the camera to the nearest living ally
    if (spectating) {
      let target = null, bd = Infinity;
      for (const ent of entities.values()) {
        if (ent.kind !== 'p' || ent.id === myId) continue;
        const d = Math.hypot(ent.x - me.x, ent.y - me.y);
        if (d < bd) { bd = d; target = ent; }
      }
      if (target) {
        const k = Math.min(1, dt * 1.8);
        me.x += (target.x - me.x) * k;
        me.y += (target.y - me.y) * k;
      }
      dx = 0; dy = 0;
    }

    const meEnt = entities.get(myId);
    if (!spectating && (dx || dy) && !(st.paralyze > 0)) {
      const len = Math.hypot(dx, dy);
      const tileSlow = tileAt(me.x, me.y) === 3 ? 0.5 : 1;
      const statusSlow = st.slow > 0 ? 0.5 : 1;
      const spd = (4 + 5.6 * (self.stats.spd / 75)) * tileSlow * statusSlow;
      let nx = me.x + (dx / len) * spd * dt;
      let ny = me.y + (dy / len) * spd * dt;
      if (!blocked(nx, me.y)) me.x = nx;
      if (!blocked(me.x, ny)) me.y = ny;
      me.x = Math.max(0.5, Math.min(world.w - 0.5, me.x));
      me.y = Math.max(0.5, Math.min(world.h - 0.5, me.y));
      if (meEnt) {
        meEnt.moving = true;
        meEnt.animT = (meEnt.animT || 0) + dt * 10;
        if (Math.abs(dx) > 0.05) meEnt.facing = dx < 0 ? -1 : 1;
      }
    } else if (meEnt) meEnt.moving = false;
    moveAccum += dt;
    if (!spectating && moveAccum > 0.05) { // 20 position updates/s
      moveAccum = 0;
      Net.send({ t: 'move', x: Math.round(me.x * 100) / 100, y: Math.round(me.y * 100) / 100 });
    }
    // shooting (client asks; server enforces fire rate)
    if (shooting && !spectating) {
      shotAccum += dt;
      if (shotAccum > 0.07) {
        shotAccum = 0;
        const w = screenToWorld(mouse.x, mouse.y);
        Net.send({ t: 'shoot', a: Math.atan2(w.y - me.y, w.x - me.x) });
      }
    }
    if (shake > 0) shake -= dt;
    // lerp entities toward server positions + walk/attack animation state
    for (const ent of entities.values()) {
      if (ent.lungeT > 0) ent.lungeT -= dt;
      if (ent.hitT > 0) ent.hitT -= dt;
      if (ent.id === myId) { ent.x = me.x; ent.y = me.y; continue; }
      const ddx = ent.tx - ent.x, ddy = ent.ty - ent.y;
      ent.moving = Math.hypot(ddx, ddy) > 0.02;
      if (ent.moving) {
        ent.animT = (ent.animT || 0) + dt * 10;
        if (Math.abs(ddx) > 0.02) ent.facing = ddx < 0 ? -1 : 1;
      }
      const k = Math.min(1, dt * 12);
      ent.x += ddx * k;
      ent.y += ddy * k;
    }
    // bullets
    bullets = bullets.filter(b => {
      const step = b.speed * dt;
      b.x += Math.cos(b.a) * step;
      b.y += Math.sin(b.a) * step;
      b.left -= step;
      return b.left > 0 && !blocked(b.x, b.y);
    });
    // effects
    effects = effects.filter(f => (f.t += dt) < f.ttl);
  }

  // ------------------------------------------------ rendering
  // fallback source for unknown sprite names (magenta box)
  let missingCanvas = null;
  function sprCanvas(name) {
    const spr = Sprites.get(name);
    if (spr) return spr;
    if (!missingCanvas) {
      missingCanvas = document.createElement('canvas');
      missingCanvas.width = 8; missingCanvas.height = 8;
      const c = missingCanvas.getContext('2d');
      c.fillStyle = '#f0f';
      c.fillRect(0, 0, 8, 8);
    }
    return missingCanvas;
  }

  // walk bob / facing flip / attack lunge / hit flash for a billboard
  function animOpts(ent) {
    return {
      flip: ent.facing === -1,
      bob: ent.moving ? ent.animT : 0,
      lunge: ent.lungeT > 0 ? { a: ent.lungeA, k: ent.lungeT / 0.14 } : null,
      flash: ent.hitT > 0,
    };
  }

  // classic speech bubble above a player's head
  function drawBubble(cx, bottomY, text, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '15px VT323, monospace';
    const w = Math.min(ctx.measureText(text).width + 14, 300);
    const h = 22;
    const x = cx - w / 2, y = bottomY - h;
    ctx.fillStyle = 'rgba(20,16,32,0.92)';
    ctx.strokeStyle = 'rgba(232,183,74,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 5); else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    // little tail pointing at the speaker
    ctx.beginPath();
    ctx.moveTo(cx - 4, y + h); ctx.lineTo(cx, y + h + 6); ctx.lineTo(cx + 4, y + h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(20,16,32,0.92)';
    ctx.fill();
    ctx.fillStyle = '#f0ead8';
    ctx.textAlign = 'center';
    ctx.fillText(text, cx, y + 16, w - 10);
    ctx.restore();
  }

  // ground-aligned ellipse on the overlay (rings, elite auras)
  function groundEllipse(px, py, r, ys, stroke, width, alpha, fill) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.ellipse(px, py, r, r * ys, 0, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
    ctx.restore();
  }

  function render() {
    if (!world || !gl3dReady) return;
    const W = canvas.width, H = canvas.height;
    const R = Renderer3D;
    const now = performance.now();
    const sk = shake > 0 ? shake / 0.3 * 0.14 : 0;
    R.beginFrame(
      me.x + (sk ? (Math.random() * 2 - 1) * sk : 0),
      me.y + (sk ? (Math.random() * 2 - 1) * sk : 0)
    );

    // ---- 3D pass: billboards, shadows and bullets
    const labels = []; // gathered for the overlay pass
    for (const ent of entities.values()) {
      if (ent.kind === 'v') {
        R.shadow('sh:vault', ent.x, ent.y, 1.0);
        R.sprite('vault', 'chest', sprCanvas('chest'), ent.x, ent.y, { size: 1.1 });
        labels.push(ent);
      } else if (ent.kind === 'b') {
        const name = ent.tier >= 6 ? 'bag_white' : (ent.tier >= 4 ? 'bag_gold' : (ent.tier >= 2 ? 'bag_purple' : 'bag_brown'));
        R.shadow('sh:' + ent.id, ent.x, ent.y, 0.65);
        R.sprite('e' + ent.id, name, sprCanvas(name), ent.x, ent.y, { size: 0.8 });
      } else if (ent.kind === 'o') {
        if (ent.pkind === 'shop') {
          R.shadow('sh:' + ent.id, ent.x, ent.y, 0.9);
          R.sprite('e' + ent.id, 'merchant', sprCanvas('merchant'), ent.x, ent.y, { size: 1.1 });
        } else {
          const spr = ent.pkind === 'dungeon' ? 'portal_red' : 'portal_blue';
          const pulse = 1 + Math.sin(now / 300) * 0.08;
          R.shadow('sh:' + ent.id, ent.x, ent.y, 1.1);
          R.sprite('e' + ent.id, spr, sprCanvas(spr), ent.x, ent.y, { size: 1.2 * pulse });
        }
        labels.push(ent);
      } else if (ent.kind === 'e') {
        const sc = spriteScale(ent.type) * (ent.elite ? 1.2 : 1);
        R.shadow('sh:' + ent.id, ent.x, ent.y, sc * 0.85);
        R.sprite('e' + ent.id, ent.type, sprCanvas(ent.type), ent.x, ent.y,
          { size: sc, ...animOpts(ent) });
        labels.push(ent);
      } else if (ent.kind === 'p') {
        const skinned = ent.skin && Sprites.tinted(ent.classId, ent.skin);
        const texKey = skinned ? ent.classId + '|' + ent.skin : ent.classId;
        R.shadow('sh:' + ent.id, ent.x, ent.y, 0.8);
        R.sprite('e' + ent.id, texKey, skinned || sprCanvas(ent.classId), ent.x, ent.y,
          { size: 0.95, opacity: ent.invis ? 0.35 : 1, ...animOpts(ent) });
        if (ent.pet) {
          const t = now / 600 + ent.id;
          const petX = ent.x + Math.cos(t) * 0.9, petY = ent.y + Math.sin(t) * 0.9;
          R.shadow('sh:pet' + ent.id, petX, petY, 0.4);
          R.sprite('pet' + ent.id, ent.pet, sprCanvas(ent.pet), petX, petY, { size: 0.5 });
        }
        labels.push(ent);
      }
    }
    R.setBullets(bullets);
    R.endFrame();

    // ---- overlay pass: labels, bars, effects, ambience
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    const ys = R.groundYScale();

    for (const ent of labels) {
      if (ent.kind === 'v') {
        const p = R.project(ent.x, ent.y, 1.5);
        ctx.fillStyle = '#fff';
        ctx.font = '16px VT323, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Cofre', p.x, p.y);
      } else if (ent.kind === 'o') {
        const p = R.project(ent.x, ent.y, 1.8);
        ctx.fillStyle = '#fff';
        ctx.font = '16px VT323, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(ent.name + ' [F]', p.x, p.y);
      } else if (ent.kind === 'e') {
        const sc = spriteScale(ent.type) * (ent.elite ? 1.2 : 1);
        if (ent.elite) {
          const g = R.project(ent.x, ent.y);
          groundEllipse(g.x, g.y, TILE * sc * 0.55, ys, '#f0c040', 2,
            0.6 + Math.sin(now / 200) * 0.3);
        }
        if (ent.hp < ent.maxHp) {
          const p = R.project(ent.x, ent.y);
          drawHpBar(p.x, p.y + 7, ent.hp, ent.maxHp, TILE * 0.9 * Math.min(sc, 1.6));
        }
      } else if (ent.kind === 'p') {
        const head = R.project(ent.x, ent.y, 1.5);
        ctx.textAlign = 'center';
        if (ent.title) {
          ctx.fillStyle = '#c0a0e0';
          ctx.font = 'italic 13px VT323, monospace';
          ctx.fillText(ent.title, head.x, head.y - 14);
        }
        ctx.fillStyle = ent.nameColor || (ent.id === myId ? '#f0c040' : '#fff');
        ctx.font = '15px VT323, monospace';
        const tag = ent.guild ? `[${ent.guild}] ` : '';
        ctx.fillText(`${tag}${ent.name} ${ent.level}`, head.x, head.y);
        if (ent.bubble && now < ent.bubble.until) {
          drawBubble(head.x, head.y - (ent.title ? 30 : 18), ent.bubble.text,
            Math.min(1, (ent.bubble.until - now) / 500)); // fade in the last 0.5s
        }
        const feet = R.project(ent.x, ent.y);
        if (ent.id !== myId && ent.hp < ent.maxHp) {
          drawHpBar(feet.x, feet.y + 7, ent.hp, ent.maxHp, TILE * 0.9);
        }
        if (ent.id === myId && self && self.st) {
          const active = Object.keys(self.st).filter(k => STATUS_INFO[k]);
          active.forEach((k, i) => {
            ctx.fillStyle = STATUS_INFO[k][0];
            ctx.font = 'bold 14px VT323, monospace';
            ctx.fillText(STATUS_INFO[k][1], feet.x, feet.y + 20 + i * 13);
          });
        }
      }
    }

    // effects (projected to the ground plane)
    for (const f of effects) {
      const p = f.t / f.ttl;
      const s = R.project(f.x, f.y);
      if (f.kind === 'text') {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = f.color;
        ctx.font = 'bold 20px VT323, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(f.text, s.x, s.y - TILE * 0.8 - p * 26);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'nova' || f.kind === 'die') {
        groundEllipse(s.x, s.y, f.r * TILE * p, ys,
          f.color || (f.kind === 'die' ? '#ffa040' : '#80d0ff'), 3, (1 - p) * 0.7);
      } else if (f.kind === 'heal' || f.kind === 'buff' || f.kind === 'levelup') {
        groundEllipse(s.x, s.y, f.r * TILE * (0.4 + p), ys,
          f.color || (f.kind === 'heal' ? '#50ff50' : '#f0c040'), 2, (1 - p) * 0.8);
      } else if (f.kind === 'vanish') {
        groundEllipse(s.x, s.y, TILE * 0.5 * (1 - p), ys, null, 0, (1 - p) * 0.5, f.color || '#a0a0ff');
      } else if (f.kind === 'status') {
        const info = STATUS_INFO[f.s] || ['#fff', ''];
        groundEllipse(s.x, s.y, TILE * (0.4 + p * 0.5), ys, f.color || info[0], 2, (1 - p) * 0.8);
      } else if (f.kind === 'tele') {
        // danger zone fills up as the attack arms — get out!
        const pulse = 0.75 + Math.sin(now / 90) * 0.25;
        groundEllipse(s.x, s.y, f.r * TILE, ys, '#ff4838', 2.5, 0.55 * pulse);
        groundEllipse(s.x, s.y, f.r * TILE * p, ys, null, 0, 0.22 * pulse, '#ff4838');
      }
    }

    drawTouchControls();
    drawDungeonDarkness();
    drawLowHpVignette();
    drawQuestArrow();
    renderMinimap();
  }

  // joystick base + knob, and a reticle where the right thumb is aiming
  function drawTouchControls() {
    if (joy) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#d8d2c8';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(joy.ox, joy.oy, 52, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#e8b74a';
      ctx.beginPath();
      ctx.arc(joy.ox + joy.dx * 52, joy.oy + joy.dy * 52, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (aimTouch !== null) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = '#3fd0b6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, 16, 0, Math.PI * 2);
      ctx.moveTo(mouse.x - 24, mouse.y); ctx.lineTo(mouse.x - 8, mouse.y);
      ctx.moveTo(mouse.x + 8, mouse.y); ctx.lineTo(mouse.x + 24, mouse.y);
      ctx.moveTo(mouse.x, mouse.y - 24); ctx.lineTo(mouse.x, mouse.y - 8);
      ctx.moveTo(mouse.x, mouse.y + 8); ctx.lineTo(mouse.x, mouse.y + 24);
      ctx.stroke();
      ctx.restore();
    }
  }

  // light-radius vignette: dungeons stay dark beyond the player's torch
  function drawDungeonDarkness() {
    if (!world || world.kind !== 'dungeon') return;
    const W = canvas.width, H = canvas.height;
    const flicker = 1 + Math.sin(performance.now() / 140) * 0.012;
    const g = ctx.createRadialGradient(W / 2, H / 2, TILE * 6.2 * flicker, W / 2, H / 2, TILE * 12);
    g.addColorStop(0, 'rgba(4,2,8,0)');
    g.addColorStop(1, 'rgba(4,2,8,0.82)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // pulsing red border when HP is low, so you remember to pot
  function drawLowHpVignette() {
    if (!self || !self.maxHp) return;
    const ratio = self.hp / self.maxHp;
    if (ratio >= 0.3) return;
    const W = canvas.width, H = canvas.height;
    const intensity = (0.3 - ratio) / 0.3; // 0..1 as HP drops to 0
    const pulse = 0.35 + 0.35 * Math.sin(performance.now() / 220);
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(200,0,0,0)');
    g.addColorStop(1, `rgba(200,0,0,${(0.35 + 0.45 * intensity) * pulse})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(255,80,80,${0.7 * pulse})`;
    ctx.font = 'bold 16px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('VIDA BAIXA — use uma pocao (1)', W / 2, 40);
  }

  // compass arrow pointing to the nearest notable target (god/boss/mini-boss)
  function drawQuestArrow() {
    if (!self || !self.quest) return;
    const q = self.quest;
    const dist = Math.hypot(q.x - me.x, q.y - me.y);
    if (dist < 3) return; // basically on top of it
    // screen-space direction (the tilted camera compresses vertical ground distances)
    const ang = Math.atan2((q.y - me.y) * Renderer3D.groundYScale(), q.x - me.x);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const rx = canvas.width / 2 - 80, ry = canvas.height / 2 - 80;
    const ax = cx + Math.cos(ang) * rx, ay = cy + Math.sin(ang) * ry;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.fillStyle = q.god ? '#f04040' : '#f0c040';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(16, 0); ctx.lineTo(-10, -9); ctx.lineTo(-4, 0); ctx.lineTo(-10, 9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = q.god ? '#ff8080' : '#f0d878';
    ctx.font = '11px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText(`${q.name} (${Math.round(dist)})`, ax, ay - 14);
  }

  function spriteScale(type) {
    const big = { goblin_king: 1.7, brood_mother: 1.9, keep_lord: 1.9, inferno_lord: 2.2, flame_titan: 1.5, void_keeper: 1.5, storm_seraph: 1.4, ogre: 1.3, treant: 1.25, colossus: 1.7, pharaoh: 2, abyss_horror: 2.3, mad_king: 2.5, bandit_lord: 1.4, wolf_alpha: 1.4, witch: 1.35, lich: 1.5, golem: 1.35, demon_prince: 1.8, tide_caller: 1.1, tyrant: 2.8, ice_golem: 1.5, yeti: 1.6, frost_shaman: 1.2, frost_monarch: 2.5, invader_warlord: 2.4, invader_archmage: 2.3, crystal_tyrant: 2.3, storm_sovereign: 2.4, plague_mother: 2.4, solar_colossus: 2.5, leviathan: 2.6, forge_master: 2.6, stone_sentinel: 1.35, archon: 2.9, celestial_warden: 2.2, sanctum_guardian: 1.4 };
    return big[type] || 0.95;
  }

  // screen-space HP bar centered at (px, py), w pixels wide
  function drawHpBar(px, py, hp, maxHp, w) {
    ctx.fillStyle = 'rgba(20,0,0,0.85)';
    ctx.fillRect(px - w / 2 - 1, py - 1, w + 2, 7);
    ctx.fillStyle = '#e03030';
    ctx.fillRect(px - w / 2, py, w * Math.max(0, hp / maxHp), 5);
  }

  let minimapBase = null;
  function renderMinimap() {
    if (minimapDirty && mapCanvas) {
      minimapBase = document.createElement('canvas');
      minimapBase.width = 160; minimapBase.height = 160;
      const c = minimapBase.getContext('2d');
      c.imageSmoothingEnabled = true;
      c.drawImage(mapCanvas, 0, 0, 160, 160);
      minimapDirty = false;
    }
    if (!minimapBase) return;
    mctx.clearRect(0, 0, 160, 160);
    mctx.drawImage(minimapBase, 0, 0);
    const sx = 160 / world.w, sy = 160 / world.h;
    for (const ent of entities.values()) {
      if (ent.kind === 'p') {
        mctx.fillStyle = ent.id === myId ? '#ffff40' : '#40c0ff';
        mctx.fillRect(ent.x * sx - 2, ent.y * sy - 2, 4, 4);
      } else if (ent.kind === 'o') {
        mctx.fillStyle = '#ff60ff';
        mctx.fillRect(ent.x * sx - 2, ent.y * sy - 2, 4, 4);
      }
    }
    if (self && self.quest) {
      mctx.fillStyle = self.quest.god ? '#f04040' : '#f0c040';
      mctx.fillRect(self.quest.x * sx - 3, self.quest.y * sy - 3, 6, 6);
    }
  }

  // ------------------------------------------------ main loop
  function frame(ts) {
    if (!running) return;
    const dt = Math.min(0.1, (ts - lastFrame) / 1000);
    lastFrame = ts;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------ public
  let reconnectTries = 0;
  function start(charId, callbacks) {
    onDeath = callbacks.onDeath;
    running = true;
    spectating = false;
    keys = {}; shooting = false;
    const handlers = {
      world: (m) => { reconnectTries = 0; loadWorld(m); },
      tick: onTick,
      tele: onTele,
      blink: (m) => { me.x = m.x; me.y = m.y; },
      shot: onShot,
      dmg: onDmg,
      fx: onFx,
      notice: m => UI.notice(m.text),
      chat: m => {
        UI.chat(m.from, m.text, m.sys, m.evt);
        // public messages float as a speech bubble over the speaker's head
        if (!m.sys && !m.evt && m.from) {
          for (const ent of entities.values()) {
            if (ent.kind === 'p' && ent.name === m.from) {
              ent.bubble = { text: m.text.slice(0, 64), until: performance.now() + 4200 };
              break;
            }
          }
        }
      },
      bounties: m => UI.setBounties(m.list),
      pet: m => UI.setPet(m),
      shop: m => UI.showShop(m),
      tradereq: m => UI.tradeRequest(m.from),
      tradestate: m => UI.tradeState(m),
      tradedone: () => UI.tradeEnd(true),
      tradecancel: () => UI.tradeEnd(false),
      invite: m => UI.showInvite(m),
      _state: (s) => {
        UI.setOnline(s.online);
        try { UI.setZones(JSON.parse(s.zones || '[]')); } catch { /* older server */ }
      },
      death: (m) => {
        // stay connected as a spectator; the death overlay offers "watch"
        spectating = true;
        keys = {}; shooting = false;
        if (typeof Sfx !== 'undefined') Sfx.death();
        callbacks.onDeath(m);
      },
      _close: (ev) => {
        if (!running) return;
        // intentional server rejections (or admin kick): don't retry
        if (ev && ((ev.code >= 4001 && ev.code <= 4003) || ev.code === 4008)) {
          running = false;
          return callbacks.onDisconnect();
        }
        // transient drop: try to reconnect with the same character
        if (reconnectTries++ < 10) {
          UI.notice('Conexao perdida, reconectando...');
          setTimeout(() => { if (running) Net.connect(charId, handlers); }, 1500);
        } else {
          running = false;
          callbacks.onDisconnect();
        }
      },
    };
    Net.connect(charId, handlers);
    setupInput();
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    spectating = false;
    Net.disconnect();
  }

  return { start, stop };
})();
