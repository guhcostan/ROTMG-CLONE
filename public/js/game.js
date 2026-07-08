'use strict';
// Client game engine: rendering (canvas), input, local movement with
// server reconciliation, bullet animation, minimap and effects.

const GameClient = (() => {
  const TILE = 40;             // pixels per tile at zoom 1
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const minimap = document.getElementById('minimap');
  const mctx = minimap.getContext('2d');

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
  }

  function tileAt(x, y) {
    x |= 0; y |= 0;
    if (!world || x < 0 || y < 0 || x >= world.w || y >= world.h) return 0;
    return world.tiles[y * world.w + x];
  }
  function blocked(x, y) { return TILE_BLOCKING.has(tileAt(x, y)); }

  function prerenderMap() {
    const px = 8; // pixels per tile in the prerender (scaled when drawn)
    mapCanvas = document.createElement('canvas');
    mapCanvas.width = world.w * px; mapCanvas.height = world.h * px;
    const c = mapCanvas.getContext('2d');
    for (let y = 0; y < world.h; y++) {
      for (let x = 0; x < world.w; x++) {
        const t = world.tiles[y * world.w + x];
        const col = TILE_COLORS[t] || TILE_COLORS[0];
        c.fillStyle = ((x + y) % 2 === 0) ? col[0] : col[1];
        c.fillRect(x * px, y * px, px, px);
        // simple wall shading
        if (t === 10 || t === 4) {
          c.fillStyle = 'rgba(255,255,255,0.06)';
          c.fillRect(x * px, y * px, px, 2);
        }
      }
    }
  }

  // ------------------------------------------------ network handlers
  let lowHpWarned = false;
  function onTick(msg) {
    self = msg.self;
    UI.update(self);
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
          // server correction only when badly out of sync
          if (Math.hypot(me.x - x, me.y - y) > 3) { me.x = x; me.y = y; }
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

  function onShot(msg) {
    if (msg.f === 1 && msg.o === myId && typeof Sfx !== 'undefined') Sfx.shoot();
    for (const a of msg.as) {
      bullets.push({
        x: msg.x, y: msg.y, a,
        speed: msg.spd, left: msg.rg,
        friendly: msg.f === 1, kind: msg.k,
      });
    }
  }

  function onDmg(msg) {
    if (msg.id === myId && msg.n > 0 && typeof Sfx !== 'undefined') Sfx.hit();
    const ent = entities.get(msg.id);
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

  function onFx(msg) {
    if (typeof Sfx !== 'undefined') {
      if (msg.k === 'die') Sfx.kill();
      if (msg.k === 'levelup') Sfx.levelup();
    }
    effects.push({ kind: msg.k, x: msg.x, y: msg.y, r: msg.r || 1, s: msg.s, t: 0, ttl: 0.6 });
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
  }

  function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
  }

  function screenToWorld(sx, sy) {
    return {
      x: me.x + (sx - canvas.width / 2) / TILE,
      y: me.y + (sy - canvas.height / 2) / TILE,
    };
  }

  // ------------------------------------------------ simulation
  let moveAccum = 0;
  let shotAccum = 0;
  function update(dt) {
    if (!world || !self) return;
    // movement
    let dx = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
    let dy = (keys['s'] || keys['arrowdown'] ? 1 : 0) - (keys['w'] || keys['arrowup'] ? 1 : 0);
    const st = self.st || {};
    if ((dx || dy) && !(st.paralyze > 0)) {
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
    }
    moveAccum += dt;
    if (moveAccum > 0.05) { // 20 position updates/s
      moveAccum = 0;
      Net.send({ t: 'move', x: Math.round(me.x * 100) / 100, y: Math.round(me.y * 100) / 100 });
    }
    // shooting (client asks; server enforces fire rate)
    if (shooting) {
      shotAccum += dt;
      if (shotAccum > 0.07) {
        shotAccum = 0;
        const w = screenToWorld(mouse.x, mouse.y);
        Net.send({ t: 'shoot', a: Math.atan2(w.y - me.y, w.x - me.x) });
      }
    }
    // lerp entities toward server positions
    for (const ent of entities.values()) {
      if (ent.id === myId) { ent.x = me.x; ent.y = me.y; continue; }
      const k = Math.min(1, dt * 12);
      ent.x += (ent.tx - ent.x) * k;
      ent.y += (ent.ty - ent.y) * k;
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
  function render() {
    if (!world) return;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const camX = me.x * TILE - W / 2;
    const camY = me.y * TILE - H / 2;

    // tiles (from prerender, 8px per tile scaled to TILE)
    const scale = TILE / 8;
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(-camX, -camY);
    ctx.drawImage(mapCanvas, 0, 0, mapCanvas.width * scale, mapCanvas.height * scale);

    // entity draw order: vault, bags, portals, enemies, players
    const ordered = [...entities.values()].sort((a, b) =>
      ({ v: 0, b: 1, o: 2, e: 3, p: 4 }[a.kind] - { v: 0, b: 1, o: 2, e: 3, p: 4 }[b.kind]));

    for (const ent of ordered) {
      const px = ent.x * TILE, py = ent.y * TILE;
      if (ent.kind === 'v') {
        drawSprite('chest', px, py, TILE * 1.1);
        ctx.fillStyle = '#fff';
        ctx.font = '12px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText('Cofre', px, py - TILE * 0.7);
      } else if (ent.kind === 'b') {
        const name = ent.tier >= 6 ? 'bag_white' : (ent.tier >= 4 ? 'bag_gold' : (ent.tier >= 2 ? 'bag_purple' : 'bag_brown'));
        drawSprite(name, px, py, TILE * 0.8);
      } else if (ent.kind === 'o') {
        if (ent.pkind === 'shop') {
          drawSprite('merchant', px, py, TILE * 1.1);
        } else {
          const spr = ent.pkind === 'dungeon' ? 'portal_red' : 'portal_blue';
          const pulse = 1 + Math.sin(performance.now() / 300) * 0.08;
          drawSprite(spr, px, py, TILE * 1.2 * pulse);
        }
        ctx.fillStyle = '#fff';
        ctx.font = '12px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText(ent.name + ' [F]', px, py - TILE * 0.8);
      } else if (ent.kind === 'e') {
        const sc = spriteScale(ent.type);
        if (ent.elite) {
          ctx.save();
          ctx.strokeStyle = '#f0c040';
          ctx.globalAlpha = 0.6 + Math.sin(performance.now() / 200) * 0.3;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, TILE * sc * 0.6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        drawSprite(ent.type, px, py, TILE * sc * (ent.elite ? 1.2 : 1));
        drawHpBar(px, py, ent.hp, ent.maxHp, sc);
      } else if (ent.kind === 'p') {
        ctx.globalAlpha = ent.invis ? 0.35 : 1;
        const skinned = ent.skin && Sprites.tinted(ent.classId, ent.skin);
        if (skinned) {
          const ratio = skinned.height / skinned.width, size = TILE * 0.95;
          ctx.drawImage(skinned, px - size / 2, py - (size * ratio) / 2, size, size * ratio);
        } else {
          drawSprite(ent.classId, px, py, TILE * 0.95);
        }
        ctx.globalAlpha = 1;
        if (ent.pet) {
          const t = performance.now() / 600 + ent.id;
          drawSprite(ent.pet, px + Math.cos(t) * TILE * 0.9, py + Math.sin(t) * TILE * 0.9, TILE * 0.5);
        }
        ctx.textAlign = 'center';
        if (ent.title) {
          ctx.fillStyle = '#c0a0e0';
          ctx.font = 'italic 9px Courier New';
          ctx.fillText(ent.title, px, py - TILE * 0.65 - 11);
        }
        ctx.fillStyle = ent.nameColor || (ent.id === myId ? '#f0c040' : '#fff');
        ctx.font = '11px Courier New';
        const tag = ent.guild ? `[${ent.guild}] ` : '';
        ctx.fillText(`${tag}${ent.name} ${ent.level}`, px, py - TILE * 0.65);
        if (ent.id !== myId) drawHpBar(px, py, ent.hp, ent.maxHp, 0.9);
        // own active statuses, shown as colored labels under the name
        if (ent.id === myId && self && self.st) {
          const active = Object.keys(self.st).filter(k => STATUS_INFO[k]);
          active.forEach((k, i) => {
            ctx.fillStyle = STATUS_INFO[k][0];
            ctx.font = 'bold 10px Courier New';
            ctx.fillText(STATUS_INFO[k][1], px, py - TILE * 0.5 + 11 + i * 11);
          });
        }
      }
    }

    // bullets
    for (const b of bullets) {
      const px = b.x * TILE, py = b.y * TILE;
      ctx.fillStyle = b.friendly ? '#80d0ff' : '#ff6060';
      ctx.beginPath();
      ctx.arc(px, py, b.kind === 'heavyarrow' ? 7 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = b.friendly ? '#ffffff' : '#ffd0d0';
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // effects
    for (const f of effects) {
      const p = f.t / f.ttl;
      const px = f.x * TILE, py = f.y * TILE;
      if (f.kind === 'text') {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = f.color;
        ctx.font = 'bold 15px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText(f.text, px, py - p * 24);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'nova' || f.kind === 'die') {
        ctx.globalAlpha = (1 - p) * 0.7;
        ctx.strokeStyle = f.kind === 'die' ? '#ffa040' : '#80d0ff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px, py, f.r * TILE * p, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'heal' || f.kind === 'buff' || f.kind === 'levelup') {
        ctx.globalAlpha = (1 - p) * 0.8;
        ctx.strokeStyle = f.kind === 'heal' ? '#50ff50' : '#f0c040';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, f.r * TILE * (0.4 + p), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'vanish') {
        ctx.globalAlpha = (1 - p) * 0.5;
        ctx.fillStyle = '#a0a0ff';
        ctx.beginPath();
        ctx.arc(px, py, TILE * 0.5 * (1 - p), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'status') {
        const info = STATUS_INFO[f.s] || ['#fff', ''];
        ctx.globalAlpha = (1 - p) * 0.8;
        ctx.strokeStyle = info[0];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, TILE * (0.4 + p * 0.5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    drawLowHpVignette();
    drawQuestArrow();
    renderMinimap();
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
    const ang = Math.atan2(q.y - me.y, q.x - me.x);
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

  function drawSprite(name, px, py, size) {
    const spr = Sprites.get(name);
    if (!spr) {
      ctx.fillStyle = '#f0f';
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
      return;
    }
    const ratio = spr.height / spr.width;
    ctx.drawImage(spr, px - size / 2, py - (size * ratio) / 2, size, size * ratio);
  }

  function drawHpBar(px, py, hp, maxHp, scale) {
    if (hp >= maxHp) return;
    const w = TILE * 0.9 * scale;
    ctx.fillStyle = '#300';
    ctx.fillRect(px - w / 2, py + TILE * 0.55 * scale, w, 5);
    ctx.fillStyle = '#e03030';
    ctx.fillRect(px - w / 2, py + TILE * 0.55 * scale, w * Math.max(0, hp / maxHp), 5);
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
    keys = {}; shooting = false;
    const handlers = {
      world: (m) => { reconnectTries = 0; loadWorld(m); },
      tick: onTick,
      blink: (m) => { me.x = m.x; me.y = m.y; },
      shot: onShot,
      dmg: onDmg,
      fx: onFx,
      notice: m => UI.notice(m.text),
      chat: m => UI.chat(m.from, m.text, m.sys),
      bounties: m => UI.setBounties(m.list),
      pet: m => UI.setPet(m),
      shop: m => UI.showShop(m),
      tradereq: m => UI.tradeRequest(m.from),
      tradestate: m => UI.tradeState(m),
      tradedone: () => UI.tradeEnd(true),
      tradecancel: () => UI.tradeEnd(false),
      _state: (s) => UI.setOnline(s.online),
      death: (m) => {
        running = false;
        if (typeof Sfx !== 'undefined') Sfx.death();
        callbacks.onDeath(m);
      },
      _close: (ev) => {
        if (!running) return;
        // intentional server rejections: don't retry
        if (ev && ev.code >= 4001 && ev.code <= 4003) {
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
    Net.disconnect();
  }

  return { start, stop };
})();
