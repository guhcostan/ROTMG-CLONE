'use strict';
// Animated menu backdrop: slow starfield, drifting embers and a faint
// arcane horizon. Runs only while a menu screen is visible.

const MenuBg = (() => {
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas.getContext('2d');
  let running = false;
  let stars = [], embers = [];

  function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
  }

  function init() {
    resize();
    stars = [];
    for (let i = 0; i < 130; i++) {
      stars.push({
        x: Math.random(), y: Math.random() * 0.85,
        size: Math.random() < 0.15 ? 2 : 1,
        tw: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 1.2,
      });
    }
    embers = [];
    for (let i = 0; i < 36; i++) embers.push(newEmber(true));
  }

  function newEmber(anywhere) {
    return {
      x: Math.random(),
      y: anywhere ? Math.random() : 1.05,
      vx: (Math.random() - 0.5) * 0.01,
      vy: -(0.012 + Math.random() * 0.03),
      size: 1 + Math.random() * 2.2,
      hue: Math.random() < 0.35 ? 'teal' : 'gold',
      life: 0.4 + Math.random() * 0.6,
    };
  }

  let last = 0;
  function frame(ts) {
    if (!running) return;
    const dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    const W = canvas.width, H = canvas.height;

    // night sky with a faint arcane glow at the horizon
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#07060d');
    sky.addColorStop(0.65, '#0c0918');
    sky.addColorStop(1, '#191029');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, H * 1.15, H * 0.1, W / 2, H * 1.15, H * 0.75);
    glow.addColorStop(0, 'rgba(63, 208, 182, 0.10)');
    glow.addColorStop(1, 'rgba(63, 208, 182, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // stars twinkle
    for (const s of stars) {
      s.tw += dt * s.speed;
      const a = 0.35 + 0.65 * (0.5 + Math.sin(s.tw) / 2);
      ctx.globalAlpha = a * 0.8;
      ctx.fillStyle = '#d8d2c8';
      ctx.fillRect(s.x * W, s.y * H, s.size, s.size);
    }

    // embers rise and fade
    ctx.globalAlpha = 1;
    for (let i = 0; i < embers.length; i++) {
      const e = embers[i];
      e.x += e.vx * dt * 6;
      e.y += e.vy * dt * 6;
      e.life -= dt * 0.09;
      if (e.y < -0.05 || e.life <= 0) { embers[i] = newEmber(false); continue; }
      ctx.globalAlpha = Math.max(0, Math.min(0.9, e.life));
      ctx.fillStyle = e.hue === 'teal' ? '#3fd0b6' : '#e8b74a';
      ctx.fillRect(e.x * W, e.y * H, e.size, e.size);
    }
    ctx.globalAlpha = 1;

    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    canvas.style.display = '';
    init();
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    canvas.style.display = 'none';
  }

  window.addEventListener('resize', () => { if (running) resize(); });

  return { start, stop };
})();
