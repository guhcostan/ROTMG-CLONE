'use strict';
// WebGL renderer (three.js): tilted orthographic camera over a textured
// ground plane, extruded walls, billboard pixel sprites with blob shadows
// and additive glow bullets. The HUD/text layer stays on the 2D overlay
// canvas; game.js asks project()/screenToWorld() to line both up.

const Renderer3D = (() => {
  const TILE = 40;            // screen pixels per world tile (horizontal)
  const TILT = 0.56;          // camera tilt from vertical, radians
  const CAM_DIST = 80;
  const WALL_H = 1.15;

  let renderer = null, scene = null, camera = null;
  let canvas = null;
  let worldGroup = null;      // ground + walls, rebuilt per world
  let groundMesh = null, groundTexA = null, groundTexB = null;
  let ambient = null, sun = null, torch = null;
  let frame = 0;

  // ---------------------------------------------------------- ambience
  const AMBIENCE = {
    nexus:    { bg: 0x101423, amb: 1.25, sun: 0.9, torch: 0.0 },
    tutorial: { bg: 0x101423, amb: 1.25, sun: 0.9, torch: 0.0 },
    realm:    { bg: 0x122036, amb: 1.15, sun: 1.1, torch: 0.0 },
    dungeon:  { bg: 0x060409, amb: 1.0,  sun: 0.45, torch: 3.2 },
  };

  function init(cv) {
    canvas = cv;
    renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    ambient = new THREE.AmbientLight(0xffffff, 1);
    sun = new THREE.DirectionalLight(0xfff2dd, 1);
    // from above and slightly behind the camera, so the wall faces the
    // player actually sees are lit and tops read a touch brighter
    sun.position.set(1.5, 6, 4);
    torch = new THREE.PointLight(0xffa860, 0, 15, 1.6);
    scene.add(ambient, sun, torch);
    initBullets();
    initParticles();
    resize();
  }

  function resize() {
    if (!renderer) return;
    renderer.setSize(innerWidth, innerHeight, false);
    const hw = innerWidth / TILE / 2, hh = innerHeight / TILE / 2;
    camera.left = -hw; camera.right = hw;
    camera.top = hh; camera.bottom = -hh;
    camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------- world statics
  function groundTexture(cv) {
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // mapCanvases: [phaseA, phaseB] — B animates water/lava tiles
  function setWorld(world, mapCanvases) {
    if (worldGroup) {
      scene.remove(worldGroup);
      worldGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
      if (groundTexB) groundTexB.dispose();
    }
    // reset per-world sprite pools (entity ids restart between instances)
    for (const e of pool.values()) scene.remove(e.obj);
    pool.clear();

    worldGroup = new THREE.Group();

    // ground: the prerendered tile canvas as one big texture
    const canvases = Array.isArray(mapCanvases) ? mapCanvases : [mapCanvases];
    groundTexA = groundTexture(canvases[0]);
    groundTexB = canvases[1] ? groundTexture(canvases[1]) : null;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(world.w, world.h),
      new THREE.MeshLambertMaterial({ map: groundTexA })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(world.w / 2, 0, world.h / 2);
    groundMesh = ground;
    worldGroup.add(ground);

    // walls: one instanced box per blocking tile, tinted by tile color
    const blocks = [];
    for (let y = 0; y < world.h; y++) {
      for (let x = 0; x < world.w; x++) {
        const t = world.tiles[y * world.w + x];
        if (t === 4 || t === 10) blocks.push({ x, y, t });
      }
    }
    if (blocks.length) {
      const geo = new THREE.BoxGeometry(1, WALL_H, 1);
      const mat = new THREE.MeshLambertMaterial();
      const inst = new THREE.InstancedMesh(geo, mat, blocks.length);
      const m = new THREE.Matrix4();
      const c = new THREE.Color();
      // explicit stone palettes: the raw tile colors are tuned for the floor
      // texture and are far too dark to read as 3D masonry
      const WALL_TINT = { 10: '#655a86', 4: '#827e8c' };
      blocks.forEach((b, i) => {
        m.makeTranslation(b.x + 0.5, WALL_H / 2 - 0.02, b.y + 0.5);
        inst.setMatrixAt(i, m);
        c.set(WALL_TINT[b.t] || '#8d8996');
        c.multiplyScalar(0.9 + ((b.x * 7 + b.y * 13) % 5) * 0.05); // per-block variation
        inst.setColorAt(i, c);
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      // instances span the whole map; the base geometry's bounds would get
      // the mesh frustum-culled as soon as the origin leaves the screen
      inst.frustumCulled = false;
      worldGroup.add(inst);
    }
    scene.add(worldGroup);

    // zone mood
    const a = AMBIENCE[world.kind] || AMBIENCE.nexus;
    renderer.setClearColor(a.bg);
    ambient.intensity = a.amb;
    sun.intensity = a.sun;
    torch.intensity = a.torch;
  }

  // ---------------------------------------------------------- sprite pool
  // upserted every frame by key; anything not touched this frame is hidden
  const pool = new Map(); // key -> { obj, kind, used, texKey }
  const texCache = new Map();

  function texFor(key, source, flip) {
    let t = texCache.get(key);
    if (!t) {
      t = new THREE.CanvasTexture(source);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace;
      if (flip) { t.repeat.x = -1; t.offset.x = 1; } // horizontal mirror
      texCache.set(key, t);
    }
    return t;
  }

  // billboard sprite standing on the ground at (x, y); opts drive the
  // walk bob, facing flip and attack lunge micro-animations
  function sprite(key, texKey, source, x, y, opts = {}) {
    let e = pool.get(key);
    if (e && e.kind !== 's') { scene.remove(e.obj); pool.delete(key); e = null; }
    if (!e) {
      const mat = new THREE.SpriteMaterial({ transparent: true, alphaTest: 0.05 });
      const s = new THREE.Sprite(mat);
      s.center.set(0.5, 0.06); // feet on the ground
      e = { obj: s, kind: 's', texKey: null, flip: false };
      scene.add(s);
      pool.set(key, e);
    }
    const flip = !!opts.flip;
    if (e.texKey !== texKey || e.flip !== flip) {
      e.obj.material.map = texFor(texKey + (flip ? '|flip' : ''), source, flip);
      e.obj.material.needsUpdate = true;
      e.texKey = texKey;
      e.flip = flip;
    }
    const size = opts.size || 0.95;
    const ratio = source.height / source.width;
    let lift = opts.lift || 0, rot = 0;
    if (opts.bob) {
      lift += Math.abs(Math.sin(opts.bob)) * 0.07;   // little hops while walking
      rot = Math.sin(opts.bob) * 0.06;               // side-to-side wobble
    }
    let px = x, py = y;
    if (opts.lunge) {                                 // recoil toward the shot
      px += Math.cos(opts.lunge.a) * 0.16 * opts.lunge.k;
      py += Math.sin(opts.lunge.a) * 0.16 * opts.lunge.k;
    }
    e.obj.material.rotation = rot;
    e.obj.scale.set(size, size * ratio, 1);
    e.obj.position.set(px, lift, py);
    e.obj.material.opacity = opts.opacity !== undefined ? opts.opacity : 1;
    // hit flash: tint the whole sprite red for a few frames
    if (opts.flash) e.obj.material.color.setRGB(2.2, 0.55, 0.45);
    else e.obj.material.color.setRGB(1, 1, 1);
    e.obj.visible = true;
    e.used = frame;
    return e.obj;
  }

  // soft dark ellipse that grounds a billboard
  let shadowTex = null;
  function getShadowTex() {
    if (!shadowTex) {
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 64;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(32, 32, 4, 32, 32, 30);
      g.addColorStop(0, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
      shadowTex = new THREE.CanvasTexture(cv);
    }
    return shadowTex;
  }

  function shadow(key, x, y, size) {
    let e = pool.get(key);
    if (!e) {
      const mat = new THREE.MeshBasicMaterial({ map: getShadowTex(), transparent: true, depthWrite: false });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 1;
      e = { obj: m, kind: 'sh' };
      scene.add(m);
      pool.set(key, e);
    }
    e.obj.scale.set(size, size * 0.7, 1);
    e.obj.position.set(x, 0.02, y);
    e.obj.visible = true;
    e.used = frame;
  }

  // ---------------------------------------------------------- bullets
  const MAX_BULLETS = 4096;
  let bulletPoints = null, bulletGeo = null;
  function glowTex(color, core) {
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    const c = cv.getContext('2d');
    let g = c.createRadialGradient(16, 16, 1, 16, 16, 15);
    g.addColorStop(0, core);
    g.addColorStop(0.35, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(cv);
  }
  function initBullets() {
    bulletGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_BULLETS * 3);
    const col = new Float32Array(MAX_BULLETS * 3);
    bulletGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bulletGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: TILE * 0.42, sizeAttenuation: false,
      map: glowTex('rgba(255,255,255,0.9)', '#ffffff'),
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    bulletPoints = new THREE.Points(bulletGeo, mat);
    bulletPoints.frustumCulled = false;
    bulletPoints.renderOrder = 5;
    scene.add(bulletPoints);
  }
  const FRIENDLY = new THREE.Color('#7ec8ff');
  const HOSTILE = new THREE.Color('#ff5a4a');
  function setBullets(list) {
    const pos = bulletGeo.attributes.position.array;
    const col = bulletGeo.attributes.color.array;
    const n = Math.min(list.length, MAX_BULLETS);
    for (let i = 0; i < n; i++) {
      const b = list[i];
      pos[i * 3] = b.x; pos[i * 3 + 1] = 0.45; pos[i * 3 + 2] = b.y;
      const c = b.friendly ? FRIENDLY : HOSTILE;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    bulletGeo.setDrawRange(0, n);
    bulletGeo.attributes.position.needsUpdate = true;
    bulletGeo.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------- particles
  // short-lived pixel bursts (deaths, level-ups, ability novas)
  const MAX_PARTS = 1500;
  let partPoints = null, partGeo = null;
  const parts = [];
  function initParticles() {
    partGeo = new THREE.BufferGeometry();
    partGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTS * 3), 3));
    partGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PARTS * 3), 3));
    const mat = new THREE.PointsMaterial({
      size: TILE * 0.2, sizeAttenuation: false,
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    partPoints = new THREE.Points(partGeo, mat);
    partPoints.frustumCulled = false;
    partPoints.renderOrder = 6;
    scene.add(partPoints);
  }

  const _pc = new THREE.Color();
  function burst(x, y, cssColor, n = 14, speed = 3) {
    _pc.set(cssColor || '#e0a060');
    for (let i = 0; i < n && parts.length < MAX_PARTS; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      parts.push({
        x, z: y, y: 0.3 + Math.random() * 0.5,
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp,
        vy: 1.5 + Math.random() * 2.5,
        life: 0.45 + Math.random() * 0.35, max: 0.8,
        r: _pc.r, g: _pc.g, b: _pc.b,
      });
    }
  }

  let lastPartTs = 0;
  function tickParticles(now) {
    const dt = Math.min(0.05, (now - lastPartTs) / 1000);
    lastPartTs = now;
    const pos = partGeo.attributes.position.array;
    const col = partGeo.attributes.color.array;
    let n = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0 || p.y < 0.02) { parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.z += p.vz * dt;
      p.y += p.vy * dt; p.vy -= 9 * dt;
      const f = Math.min(1, p.life / 0.4); // additive: fading to black = fading out
      pos[n * 3] = p.x; pos[n * 3 + 1] = p.y; pos[n * 3 + 2] = p.z;
      col[n * 3] = p.r * f; col[n * 3 + 1] = p.g * f; col[n * 3 + 2] = p.b * f;
      n++;
    }
    partGeo.setDrawRange(0, n);
    partGeo.attributes.position.needsUpdate = true;
    partGeo.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------- frame
  function beginFrame(camX, camY) {
    frame++;
    camera.position.set(camX, CAM_DIST * Math.cos(TILT), camY + CAM_DIST * Math.sin(TILT));
    camera.lookAt(camX, 0, camY);
    camera.updateMatrixWorld();
    torch.position.set(camX, 1.6, camY);
  }

  function endFrame() {
    for (const [key, e] of pool) {
      if (e.used !== frame) {
        e.obj.visible = false;
        // drop stale entries entirely so long sessions don't accumulate
        if (frame - e.used > 600) { scene.remove(e.obj); pool.delete(key); }
      }
    }
    const now = performance.now();
    tickParticles(now);
    // two-phase ground texture: animated water/lava shimmer
    if (groundMesh && groundTexB) {
      const phase = ((now / 550) | 0) % 2;
      const want = phase ? groundTexB : groundTexA;
      if (groundMesh.material.map !== want) {
        groundMesh.material.map = want;
        groundMesh.material.needsUpdate = true;
      }
    }
    renderer.render(scene, camera);
  }

  // ---------------------------------------------------------- projections
  const _v = new THREE.Vector3();
  function project(x, y, h = 0) {
    _v.set(x, h, y).project(camera);
    return { x: (_v.x * 0.5 + 0.5) * innerWidth, y: (-_v.y * 0.5 + 0.5) * innerHeight };
  }

  const _p = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  function screenToWorld(sx, sy) {
    _p.set((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1, -1).unproject(camera);
    camera.getWorldDirection(_dir);
    const t = -_p.y / _dir.y;
    return { x: _p.x + _dir.x * t, y: _p.z + _dir.z * t };
  }

  // vertical foreshortening of the ground plane on screen (for ellipses)
  function groundYScale() { return Math.cos(TILT); }

  return { init, resize, setWorld, beginFrame, endFrame, sprite, shadow, setBullets, burst, project, screenToWorld, groundYScale, TILE };
})();
