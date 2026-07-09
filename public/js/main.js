'use strict';
// Screen flow: auth -> character select -> game -> (death) -> back.

(() => {
  const $ = id => document.getElementById(id);
  const screens = ['screen-auth', 'screen-chars', 'screen-game'];
  function show(id) {
    for (const s of screens) $(s).classList.toggle('hidden', s !== id);
    // animated backdrop only behind the menu screens
    if (typeof MenuBg !== 'undefined') {
      if (id === 'screen-game') MenuBg.stop(); else MenuBg.start();
    }
  }

  // ---------------- character-select tabs
  const tabBar = $('chars-tabs');
  if (tabBar) {
    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      for (const t of tabBar.querySelectorAll('.tab')) t.classList.toggle('active', t === btn);
      for (const pane of document.querySelectorAll('#screen-chars .tab-pane')) {
        pane.classList.toggle('active', pane.id === btn.dataset.tab);
      }
    });
  }

  // ---------------- auth screen
  async function doAuth(isRegister) {
    const user = $('auth-user').value.trim();
    const pass = $('auth-pass').value;
    $('auth-error').textContent = '';
    try {
      await Net.login(user, pass, isRegister);
      await openChars();
    } catch (e) {
      $('auth-error').textContent = e.message;
    }
  }
  $('btn-login').onclick = () => doAuth(false);
  $('btn-register').onclick = () => doAuth(true);
  $('auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(false); });

  $('btn-logout').onclick = () => { Net.logout(); show('screen-auth'); };

  // ---------------- character select
  async function openChars() {
    let data;
    try {
      data = await Net.api('GET', '/api/chars');
    } catch {
      Net.logout();
      show('screen-auth');
      return;
    }
    show('screen-chars');
    $('chars-title').innerHTML = `Personagens de ${data.username} ` +
      `<a href="/u/${encodeURIComponent(data.username)}" target="_blank" style="font-size:12px;color:#70b0ff">(perfil publico)</a>`;

    const list = $('char-list');
    list.innerHTML = '';
    if (!data.characters.length) {
      list.innerHTML = '<div class="empty-note">Nenhum personagem ainda. Crie um abaixo!</div>';
    }
    for (const ch of data.characters) {
      const card = document.createElement('div');
      card.className = 'char-card';
      card.appendChild(classCanvas(ch.classId));
      const name = document.createElement('div');
      name.className = 'cname';
      name.textContent = ch.className;
      const info = document.createElement('div');
      info.className = 'cinfo';
      info.textContent = `Nivel ${ch.level} - Fama ${ch.fame}`;
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = 'x';
      del.title = 'Deletar personagem';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Deletar ${ch.className} nivel ${ch.level}? Isso e permanente.`)) return;
        await Net.api('DELETE', `/api/chars/${ch.id}`);
        openChars();
      };
      card.append(name, info, del);
      card.onclick = () => startGame(ch.id, ch.classId);
      list.appendChild(card);
    }

    const classes = $('class-list');
    classes.innerHTML = '';
    if (data.characters.length >= data.maxChars) {
      classes.innerHTML = `<div class="empty-note">Limite de ${data.maxChars} personagens atingido.</div>`;
    } else {
      // starter classes first, then unlocked advanced, then locked ones
      const entries = Object.entries(data.classes).sort((a, b) =>
        (a[1].locked ? 1 : 0) - (b[1].locked ? 1 : 0));
      for (const [id, c] of entries) {
        const card = document.createElement('div');
        card.className = 'class-card' + (c.locked ? ' locked' : '');
        card.appendChild(classCanvas(id));
        const name = document.createElement('div');
        name.className = 'cname';
        name.textContent = c.name;
        const info = document.createElement('div');
        info.className = 'cinfo';
        if (c.locked) {
          info.textContent = `🔒 Leve ${c.unlockName} ao nivel 20`;
        } else {
          info.textContent = `HP ${c.base.hp} MP ${c.base.mp}\n${c.weapon} / ${c.ability}`;
        }
        card.append(name, info);
        if (c.locked) {
          card.onclick = () => alert(`${c.name} esta bloqueada. Leve um ${c.unlockName} ao nivel 20 para desbloquear.`);
        } else {
          card.onclick = async () => {
            try {
              const r = await Net.api('POST', '/api/chars', { classId: id });
              startGame(r.character.id, r.character.classId);
            } catch (e) { alert(e.message); }
          };
        }
        classes.appendChild(card);
      }
    }

    loadSeason();
    loadPass();
    loadSpeedrun();
    loadCosmetics();

    const bl = $('bounties-list');
    if (bl) {
      bl.innerHTML = '';
      if (!data.bounties || !data.bounties.length) bl.textContent = 'Sem missoes hoje.';
      for (const b of data.bounties || []) {
        const div = document.createElement('div');
        div.style.color = b.done ? '#50c050' : '#ccc';
        div.textContent = `${b.done ? '✓' : '•'} ${b.label} (${b.progress}/${b.target})`;
        bl.appendChild(div);
      }
    }

    const ach = $('achievements');
    if (ach) {
      ach.innerHTML = '';
      const earned = (data.achievements || []).filter(a => a.earned).length;
      const total = (data.achievements || []).length;
      for (const a of data.achievements || []) {
        const div = document.createElement('div');
        div.style.color = a.earned ? '#f0c040' : '#666';
        div.textContent = `${a.earned ? '★' : '☆'} ${a.name}`;
        ach.appendChild(div);
      }
      if (total) ach.firstChild && (ach.insertBefore(Object.assign(document.createElement('div'), { textContent: `${earned}/${total} desbloqueadas`, style: 'color:#888;font-size:11px' }), ach.firstChild));
    }

    const gy = $('graveyard');
    gy.innerHTML = '';
    if (!data.graveyard.length) gy.textContent = 'Nenhum heroi caido... ainda.';
    for (const g of data.graveyard) {
      const div = document.createElement('div');
      const when = new Date(g.diedAt).toLocaleDateString('pt-BR');
      div.textContent = `☠ ${data.classes[g.classId] ? data.classes[g.classId].name : g.classId} nivel ${g.level}, fama ${g.fame} - morto por ${g.killedBy} (${when})`;
      gy.appendChild(div);
    }

    loadLeaderboard(data.classes);
  }

  async function loadLeaderboard(classes) {
    try {
      const lb = await Net.api('GET', '/api/leaderboard');
      $('online-count').textContent = `(${lb.online} online)`;
      const el = $('leaderboard');
      el.innerHTML = '';
      if (!lb.alive.length) { el.textContent = 'Nenhum heroi no ranking ainda.'; return; }
      lb.alive.slice(0, 10).forEach((r, i) => {
        const div = document.createElement('div');
        const cls = classes[r.class_id] ? classes[r.class_id].name : r.class_id;
        div.textContent = `${i + 1}. ${r.username} - ${cls} nivel ${r.level}, fama ${r.fame}`;
        el.appendChild(div);
      });
    } catch { /* leaderboard is cosmetic */ }
  }

  async function loadCosmetics() {
    const el = $('cosmetics');
    if (!el) return;
    try {
      const c = await Net.api('GET', '/api/cosmetics');
      el.innerHTML = '';
      const titleSel = document.createElement('select');
      titleSel.innerHTML = '<option value="">(sem titulo)</option>' +
        c.titles.map(t => `<option${c.current.title === t ? ' selected' : ''}>${t}</option>`).join('');
      const colorSel = document.createElement('select');
      colorSel.innerHTML = '<option value="">(cor padrao)</option>' +
        c.colors.map(o => `<option value="${o.color}"${c.current.color === o.color ? ' selected' : ''}>${o.name}</option>`).join('');
      const skinSel = document.createElement('select');
      skinSel.innerHTML = '<option value="">(sem skin)</option>' +
        (c.skins || []).map(o => `<option value="${o.color}"${c.current.skin === o.color ? ' selected' : ''}>${o.name}</option>`).join('');
      const save = async () => {
        try { await Net.api('POST', '/api/cosmetics', { title: titleSel.value || null, color: colorSel.value || null, skin: skinSel.value || null }); } catch {}
      };
      titleSel.onchange = save; colorSel.onchange = save; skinSel.onchange = save;
      el.append('Titulo: ', titleSel, document.createElement('br'), 'Cor: ', colorSel, document.createElement('br'), 'Skin: ', skinSel);
    } catch { el.textContent = 'Cosmeticos indisponiveis.'; }
  }

  const DUNGEON_NAMES = {
    goblin_warren: 'Goblin Warren', spider_grotto: 'Spider Grotto', cursed_keep: 'Cursed Keep',
    infernal_depths: 'Infernal Depths', sunken_tomb: 'Sunken Tomb', abyssal_rift: 'Abyssal Rift',
    frozen_depths: 'Frozen Depths', crystal_caverns: 'Crystal Caverns', storm_citadel: 'Storm Citadel',
    plague_warren: 'Plague Warren', sunbaked_ziggurat: 'Sunbaked Ziggurat', drowned_grotto: 'Drowned Grotto',
    volcanic_forge: 'Volcanic Forge', celestial_sanctum: 'Celestial Sanctum', tyrant_sanctum: 'Santuario do Tirano',
  };
  function loadSpeedrun() {
    const pick = $('speedrun-pick'), list = $('speedrun-list');
    if (!pick) return;
    pick.innerHTML = Object.entries(DUNGEON_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
    const render = async () => {
      try {
        const r = await Net.api('GET', '/api/speedrun?dungeon=' + pick.value);
        list.innerHTML = r.times.length
          ? r.times.map((t, i) => `${i + 1}. ${t.username} — ${(t.ms / 1000).toFixed(1)}s`).join('<br>')
          : '<span style="color:#888">Sem tempos ainda.</span>';
      } catch { list.textContent = 'Indisponivel.'; }
    };
    pick.onchange = render;
    render();
  }

  async function loadPass() {
    const el = $('pass-track');
    if (!el) return;
    try {
      const info = await renderPass(el);
      return info;
    } catch { el.textContent = 'Passe indisponivel.'; }
  }
  async function renderPass(el) {
    const info = await Net.api('GET', '/api/pass');
    el.innerHTML = '';
    const head = document.createElement('div');
    head.style.color = '#f0c040';
    head.textContent = `Fama da temporada: ${info.fame} (${info.perTier} por tier)`;
    el.appendChild(head);
    for (const t of info.tiers) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:2px 0';
      const txt = document.createElement('span');
      txt.style.flex = '1';
      txt.style.color = t.unlocked ? '#ccc' : '#666';
      txt.textContent = `Tier ${t.tier} (${t.need}): ${t.reward}`;
      row.appendChild(txt);
      if (t.claimed) { const s = document.createElement('span'); s.style.color = '#50c050'; s.textContent = 'coletado'; row.appendChild(s); }
      else if (t.unlocked) {
        const b = document.createElement('button');
        b.className = 'btn small'; b.textContent = 'Coletar';
        b.onclick = async () => { try { await Net.api('POST', '/api/pass', { tier: t.tier }); renderPass(el); } catch (e) { alert(e.message); } };
        row.appendChild(b);
      }
      el.appendChild(row);
    }
    return info;
  }

  async function loadSeason() {
    try {
      const s = await Net.api('GET', '/api/season');
      $('season-title').textContent = `Temporada ${s.season} - ${s.modifier}`;
      const el = $('season-info');
      el.innerHTML = '';
      const days = Math.max(0, Math.ceil((s.endsAt - Date.now()) / 86400000));
      const head = document.createElement('div');
      head.style.color = '#f0c040';
      head.textContent = `Acaba em ~${days} dia(s). Ranking da temporada:`;
      el.appendChild(head);
      if (!s.leaderboard.length) el.appendChild(Object.assign(document.createElement('div'), { textContent: 'Sem pontuacoes ainda.', style: 'color:#888' }));
      s.leaderboard.forEach((r, i) => {
        const div = document.createElement('div');
        div.textContent = `${i + 1}. ${r.username} - fama ${r.fame}`;
        el.appendChild(div);
      });
      if (s.hallOfFame.length) {
        const hof = document.createElement('div');
        hof.style.cssText = 'color:#a0a0ff;margin-top:6px';
        hof.textContent = 'Hall da Fama: ' + s.hallOfFame.map(h => `T${h.season} ${h.winner.username}`).join(', ');
        el.appendChild(hof);
      }
    } catch { /* season panel is cosmetic */ }
  }

  function classCanvas(classId) {
    const spr = Sprites.get(classId);
    const cv = document.createElement('canvas');
    cv.width = spr ? spr.width : 12;
    cv.height = spr ? spr.height : 12;
    if (spr) cv.getContext('2d').drawImage(spr, 0, 0);
    return cv;
  }

  // ---------------- game
  async function startGame(charId, classId) {
    await UI.init();
    show('screen-game');
    $('death-overlay').classList.add('hidden');
    UI.setName(Net.username);
    if (classId) UI.setPortrait(classId);
    GameClient.start(charId, {
      onDeath(m) {
        $('death-info').textContent = `Seu personagem nivel ${m.level} foi morto por ${m.killer}.`;
        const fameEl = $('death-fame');
        fameEl.innerHTML = '';
        if (m.bonuses && m.bonuses.length) {
          const base = document.createElement('div');
          base.textContent = `Fama base: ${m.baseFame}`;
          fameEl.appendChild(base);
          for (const b of m.bonuses) {
            const row = document.createElement('div');
            row.className = 'fame-bonus';
            row.textContent = `${b.label}: +${b.value}`;
            fameEl.appendChild(row);
          }
        }
        const total = document.createElement('div');
        total.className = 'fame-total';
        total.textContent = `Fama total: ${m.fame}`;
        fameEl.appendChild(total);
        $('death-overlay').classList.remove('hidden');
      },
      onDisconnect() {
        UI.notice('Conexao perdida');
        setTimeout(() => { GameClient.stop(); openChars(); }, 1200);
      },
    });
  }

  $('btn-death-ok').onclick = () => {
    GameClient.stop();
    $('death-overlay').classList.add('hidden');
    openChars();
  };

  // ---------------- boot
  if (Net.token) openChars();
  else show('screen-auth');
})();
