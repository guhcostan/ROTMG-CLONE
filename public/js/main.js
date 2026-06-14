'use strict';
// Screen flow: auth -> character select -> game -> (death) -> back.

(() => {
  const $ = id => document.getElementById(id);
  const screens = ['screen-auth', 'screen-chars', 'screen-game'];
  function show(id) {
    for (const s of screens) $(s).classList.toggle('hidden', s !== id);
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
    $('chars-title').textContent = `Personagens de ${data.username}`;

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
      card.onclick = () => startGame(ch.id);
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
              startGame(r.character.id);
            } catch (e) { alert(e.message); }
          };
        }
        classes.appendChild(card);
      }
    }

    loadSeason();

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
  async function startGame(charId) {
    await UI.init();
    show('screen-game');
    $('death-overlay').classList.add('hidden');
    UI.setName(Net.username);
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
