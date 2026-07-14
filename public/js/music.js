'use strict';
// Procedural ambient soundtrack (WebAudio, no samples). Each zone gets a
// mood: calm arpeggios in the Nexus, adventurous pulse in the Realm, low
// tense drones in dungeons. Deliberately sparse and quiet — background
// texture, not a song fighting the sound effects. Toggle with N.

const Music = (() => {
  let enabled = localStorage.getItem('music') !== '0';
  let mood = null;
  let timer = null;
  let step = 0;
  let nextTime = 0;
  let drone = null;

  // semitone offsets walked at random; low degrees weighted by the walker
  const MOODS = {
    nexus: { scale: [0, 3, 5, 7, 10, 12, 15], base: 220, stepSec: 0.5, type: 'sine', vol: 0.02, density: 0.5, bassEvery: 8 },
    realm: { scale: [0, 2, 4, 7, 9, 12, 14], base: 174.61, stepSec: 0.32, type: 'triangle', vol: 0.022, density: 0.65, bassEvery: 8 },
    dungeon: { scale: [0, 1, 5, 6, 10, 12], base: 110, stepSec: 0.62, type: 'sine', vol: 0.016, density: 0.3, bassEvery: 4, drone: 55 },
  };
  const ALIAS = { tutorial: 'nexus' };

  function ac() { return Sfx.audioCtx(); }

  function note(freq, t, dur, type, vol) {
    const a = ac();
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function stopDrone() {
    if (drone) { try { drone.g.gain.linearRampToValueAtTime(0.0001, ac().currentTime + 0.8); drone.o.stop(ac().currentTime + 1); } catch { /* gone */ } drone = null; }
  }

  function startDrone(freq, vol) {
    stopDrone();
    const a = ac();
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(freq, a.currentTime);
    g.gain.setValueAtTime(0, a.currentTime);
    g.gain.linearRampToValueAtTime(vol, a.currentTime + 2);
    o.connect(g).connect(a.destination);
    o.start();
    drone = { o, g };
  }

  let walker = 3; // current scale degree
  function schedule() {
    if (!enabled || Sfx.muted || !mood) { stopDrone(); return; }
    let a;
    try { a = ac(); } catch { return; }
    if (a.state !== 'running') return; // wait for the first user gesture
    const m = mood;
    if (m.drone && !drone) startDrone(m.drone, m.vol * 0.6);
    if (!m.drone) stopDrone();
    if (nextTime < a.currentTime) nextTime = a.currentTime + 0.05;
    // keep ~0.6s of notes scheduled ahead
    while (nextTime < a.currentTime + 0.6) {
      step++;
      // melodic random walk over the scale
      if (Math.random() < m.density) {
        walker += [-2, -1, -1, 0, 1, 1, 2][(Math.random() * 7) | 0];
        walker = Math.max(0, Math.min(m.scale.length - 1, walker));
        const freq = m.base * Math.pow(2, m.scale[walker] / 12);
        note(freq, nextTime, m.stepSec * 2.2, m.type, m.vol);
        // soft fifth below, sometimes
        if (Math.random() < 0.2) note(freq / 1.5, nextTime, m.stepSec * 2.6, m.type, m.vol * 0.5);
      }
      if (step % m.bassEvery === 0) note(m.base / 2, nextTime, m.stepSec * m.bassEvery * 0.9, 'sine', m.vol * 1.15);
      nextTime += m.stepSec;
    }
  }

  function setMood(kind) {
    const key = ALIAS[kind] || kind;
    const next = MOODS[key] || MOODS.nexus;
    if (next === mood) return;
    mood = next;
    stopDrone();
    step = 0;
    nextTime = 0;
    if (!timer) timer = setInterval(schedule, 250);
  }

  function toggle() {
    enabled = !enabled;
    localStorage.setItem('music', enabled ? '1' : '0');
    if (!enabled) stopDrone();
    return enabled;
  }

  return { setMood, toggle, get enabled() { return enabled; } };
})();
