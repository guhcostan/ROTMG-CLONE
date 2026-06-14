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
      for (const [id, c] of Object.entries(data.classes)) {
        const card = document.createElement('div');
        card.className = 'class-card';
        card.appendChild(classCanvas(id));
        const name = document.createElement('div');
        name.className = 'cname';
        name.textContent = c.name;
        const info = document.createElement('div');
        info.className = 'cinfo';
        info.textContent = `HP ${c.base.hp} MP ${c.base.mp}\n${c.weapon} / ${c.ability}`;
        card.append(name, info);
        card.onclick = async () => {
          try {
            const r = await Net.api('POST', '/api/chars', { classId: id });
            startGame(r.character.id);
          } catch (e) { alert(e.message); }
        };
        classes.appendChild(card);
      }
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
