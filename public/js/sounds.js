'use strict';
// Tiny procedural WebAudio sound effects. No samples, no dependencies.
// Audio context is created lazily on the first user interaction.

const Sfx = (() => {
  let ac = null;
  let muted = localStorage.getItem('muted') === '1';

  function ctx() {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  function tone(freq, dur, { type = 'square', vol = 0.04, slide = 0 } = {}) {
    if (muted) return;
    try {
      const a = ctx();
      const o = a.createOscillator(), g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, a.currentTime);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), a.currentTime + dur);
      g.gain.setValueAtTime(vol, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
      o.connect(g).connect(a.destination);
      o.start();
      o.stop(a.currentTime + dur);
    } catch { /* audio unavailable: stay silent */ }
  }

  return {
    shoot: () => tone(700, 0.07, { slide: -350, vol: 0.025 }),
    hit: () => tone(160, 0.12, { type: 'sawtooth', vol: 0.06, slide: -60 }),
    kill: () => tone(300, 0.15, { type: 'triangle', vol: 0.05, slide: -200 }),
    levelup: () => { tone(440, 0.09); setTimeout(() => tone(660, 0.09), 90); setTimeout(() => tone(880, 0.16), 180); },
    death: () => tone(400, 0.7, { type: 'sawtooth', vol: 0.08, slide: -340 }),
    pickup: () => tone(900, 0.06, { type: 'triangle' }),
    toggleMute() {
      muted = !muted;
      localStorage.setItem('muted', muted ? '1' : '0');
      return muted;
    },
    get muted() { return muted; },
  };
})();
