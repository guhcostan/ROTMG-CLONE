'use strict';
// HUD: bars, stats, inventory/equipment slots with drag & drop, loot bag
// panel, chat log, tooltips.

const UI = (() => {
  let ITEMS = {}; // item metadata from /api/items
  let SETS = {};  // equipment set bonuses from /api/sets
  const $ = id => document.getElementById(id);

  const EQUIP_LABELS = ['Arma', 'Habilid.', 'Armadura', 'Anel'];
  let slotEls = [];   // 12 slots: 0-3 equip, 4-11 inventory
  let bagEls = [];
  let currentBagId = null;
  let dragFrom = null;

  async function init() {
    ITEMS = await Net.api('GET', '/api/items');
    try { SETS = await Net.api('GET', '/api/sets'); } catch { SETS = {}; }
    buildSlots();
    const close = $('shop-close');
    if (close) close.onclick = () => hideShop();
  }

  function buildSlots() {
    const eq = $('equip-slots'), inv = $('inv-slots'), bag = $('bag-slots');
    eq.innerHTML = ''; inv.innerHTML = ''; bag.innerHTML = '';
    slotEls = []; bagEls = [];
    buildVaultSlots();
    buildTradePanel();
    const EQUIP_GHOSTS = ['⚔', '✦', '⛨', '◉']; // weapon, ability, armor, ring
    for (let i = 0; i < 12; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.dataset.slot = i;
      el.title = i < 4 ? EQUIP_LABELS[i] : '';
      if (i < 4) el.dataset.ghost = EQUIP_GHOSTS[i];
      el.draggable = true;
      el.addEventListener('dragstart', () => { dragFrom = { type: 'slot', i }; });
      el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault(); el.classList.remove('drag-over');
        if (!dragFrom) return;
        if (dragFrom.type === 'slot' && dragFrom.i !== i) Net.send({ t: 'invswap', from: dragFrom.i, to: i });
        else if (dragFrom.type === 'bag') { Net.send({ t: 'pickup', bag: currentBagId, idx: dragFrom.i, to: i }); if (typeof Sfx !== 'undefined') Sfx.pickup(); }
        else if (dragFrom.type === 'vault') Net.send({ t: 'vault', cmd: 'withdraw', idx: dragFrom.i });
        dragFrom = null;
      });
      el.addEventListener('dblclick', () => {
        if (vaultOpen && i >= 4 && getSlotItem(i)) Net.send({ t: 'vault', cmd: 'deposit', slot: i });
        else useOrEquip(i);
      });
      el.addEventListener('click', () => {
        if (trading && i >= 4) return toggleOffer(i - 4);
        // on touch there is no double click: a single tap acts
        if (document.body.classList.contains('touch-mode')) {
          if (vaultOpen && i >= 4 && getSlotItem(i)) Net.send({ t: 'vault', cmd: 'deposit', slot: i });
          else useOrEquip(i);
        }
      });
      el.addEventListener('contextmenu', e => { e.preventDefault(); Net.send({ t: 'dropitem', slot: i }); });
      el.addEventListener('mousemove', e => showTooltip(e, currentSelf && getSlotItem(i)));
      el.addEventListener('mouseleave', hideTooltip);
      (i < 4 ? eq : inv).appendChild(el);
      slotEls.push(el);
    }
    for (let i = 0; i < 8; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.draggable = true;
      el.addEventListener('dragstart', () => { dragFrom = { type: 'bag', i }; });
      el.addEventListener('dblclick', () => { Net.send({ t: 'pickup', bag: currentBagId, idx: i }); if (typeof Sfx !== 'undefined') Sfx.pickup(); });
      el.addEventListener('click', () => {
        if (document.body.classList.contains('touch-mode')) {
          Net.send({ t: 'pickup', bag: currentBagId, idx: i });
          if (typeof Sfx !== 'undefined') Sfx.pickup();
        }
      });
      el.addEventListener('mousemove', e => showTooltip(e, currentBagItems && currentBagItems[i]));
      el.addEventListener('mouseleave', hideTooltip);
      bag.appendChild(el);
      bagEls.push(el);
    }
  }

  let currentSelf = null;
  let currentBagItems = null;
  let vaultEls = [];
  let vaultOpen = false;
  let currentVault = null;
  let trading = false;
  let myOffer = [];
  let tradeMineEls = [], tradeTheirsEls = [];

  function buildVaultSlots() {
    const wrap = $('vault-slots');
    wrap.innerHTML = '';
    vaultEls = [];
    for (let i = 0; i < 16; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.draggable = true;
      el.addEventListener('dragstart', () => { dragFrom = { type: 'vault', i }; });
      el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault(); el.classList.remove('drag-over');
        if (dragFrom && dragFrom.type === 'slot') Net.send({ t: 'vault', cmd: 'deposit', slot: dragFrom.i });
        dragFrom = null;
      });
      el.addEventListener('dblclick', () => Net.send({ t: 'vault', cmd: 'withdraw', idx: i }));
      el.addEventListener('click', () => {
        if (document.body.classList.contains('touch-mode')) Net.send({ t: 'vault', cmd: 'withdraw', idx: i });
      });
      el.addEventListener('mousemove', e => showTooltip(e, currentVault && currentVault[i]));
      el.addEventListener('mouseleave', hideTooltip);
      wrap.appendChild(el);
      vaultEls.push(el);
    }
  }

  function showVault(slots) {
    vaultOpen = !!slots;
    currentVault = slots;
    $('vault-label').style.display = vaultOpen ? '' : 'none';
    $('vault-slots').style.display = vaultOpen ? '' : 'none';
    if (vaultOpen) for (let i = 0; i < 16; i++) renderSlot(vaultEls[i], slots[i]);
  }

  // ---------------- trade
  function buildTradePanel() {
    const mine = $('trade-mine'), theirs = $('trade-theirs');
    mine.innerHTML = ''; theirs.innerHTML = '';
    tradeMineEls = []; tradeTheirsEls = [];
    for (let i = 0; i < 8; i++) {
      const a = document.createElement('div');
      a.className = 'slot';
      mine.appendChild(a); tradeMineEls.push(a);
      const b = document.createElement('div');
      b.className = 'slot';
      b.addEventListener('mousemove', e => showTooltip(e, b.dataset.item || null));
      b.addEventListener('mouseleave', hideTooltip);
      theirs.appendChild(b); tradeTheirsEls.push(b);
    }
    $('btn-trade-confirm').onclick = () => Net.send({ t: 'trade', cmd: 'confirm' });
    $('btn-trade-cancel').onclick = () => Net.send({ t: 'trade', cmd: 'cancel' });
    $('btn-trade-accept').onclick = () => {
      $('trade-request').classList.add('hidden');
      Net.send({ t: 'trade', cmd: 'accept' });
    };
    $('btn-trade-decline').onclick = () => $('trade-request').classList.add('hidden');
  }

  function toggleOffer(invIdx) {
    if (!currentSelf || !currentSelf.inv[invIdx]) return;
    const at = myOffer.indexOf(invIdx);
    if (at === -1) myOffer.push(invIdx); else myOffer.splice(at, 1);
    Net.send({ t: 'trade', cmd: 'offer', slots: myOffer });
  }

  function tradeRequest(from) {
    $('trade-req-text').textContent = `${from} quer negociar com voce.`;
    $('trade-request').classList.remove('hidden');
    setTimeout(() => $('trade-request').classList.add('hidden'), 15000);
  }

  function tradeState(m) {
    trading = true;
    myOffer = m.mine.slice();
    $('trade-panel').classList.remove('hidden');
    $('trade-partner').textContent = m.partner;
    for (let i = 0; i < 8; i++) {
      const mineItem = i < m.mine.length && currentSelf ? currentSelf.inv[m.mine[i]] : null;
      renderSlot(tradeMineEls[i], mineItem);
      renderSlot(tradeTheirsEls[i], m.theirs[i] || null);
    }
    // highlight offered slots in the inventory grid
    for (let i = 0; i < 8; i++) {
      slotEls[i + 4].classList.toggle('offered', myOffer.includes(i));
    }
    $('trade-status').textContent =
      (m.myConfirm ? 'Voce confirmou. ' : '') + (m.theirConfirm ? `${m.partner} confirmou.` : '');
  }

  function tradeEnd(done) {
    trading = false;
    myOffer = [];
    $('trade-panel').classList.add('hidden');
    for (let i = 0; i < 8; i++) slotEls[i + 4].classList.remove('offered');
    notice(done ? 'Troca concluida!' : 'Troca cancelada');
  }

  function getSlotItem(i) {
    if (!currentSelf) return null;
    return i < 4 ? currentSelf.eq[i] : currentSelf.inv[i - 4];
  }

  function useOrEquip(i) {
    const id = getSlotItem(i);
    if (!id) return;
    const it = ITEMS[id];
    if (i >= 4 && it && it.type === 'consumable') {
      Net.send({ t: 'useitem', slot: i });
    } else if (i >= 4 && it && it.slot) {
      // auto-equip to matching slot
      const target = { weapon: 0, ability: 1, armor: 2, ring: 3 }[it.slot];
      if (target !== undefined) Net.send({ t: 'invswap', from: i, to: target });
    } else if (i < 4) {
      const free = currentSelf.inv.indexOf(null);
      if (free !== -1) Net.send({ t: 'invswap', from: i, to: free + 4 });
    }
  }

  function renderSlot(el, itemId) {
    const cur = el.dataset.item || '';
    if (cur === (itemId || '')) return;
    el.dataset.item = itemId || '';
    el.innerHTML = '';
    el.style.boxShadow = '';
    el.classList.remove('rarity');
    if (!itemId) return;
    const it = ITEMS[itemId];
    const [, rcolor] = it ? rarity(it.tier) : ['', ''];
    const spr = Sprites.forItem(itemId, ITEMS);
    if (spr) {
      const cv = document.createElement('canvas');
      cv.width = spr.width; cv.height = spr.height;
      const c = cv.getContext('2d');
      c.drawImage(spr, 0, 0);
      if (it && it.tier >= 2) { // rarer items get a tint so they read at a glance
        c.globalCompositeOperation = 'source-atop';
        c.globalAlpha = it.tier >= 6 ? 0.4 : 0.22;
        c.fillStyle = rcolor;
        c.fillRect(0, 0, cv.width, cv.height);
      }
      el.appendChild(cv);
    }
    if (it && it.tier > 0) {
      el.classList.add('rarity');
      el.style.boxShadow = `inset 0 0 0 1px ${rcolor}`;
      const t = document.createElement('span');
      t.className = 'tier'; t.textContent = it.tier >= 6 ? '★' : 'T' + it.tier;
      t.style.color = rcolor;
      el.appendChild(t);
    }
  }

  function update(self) {
    currentSelf = self;
    if (self.gold !== undefined) $('hud-gold').textContent = `Ouro: ${self.gold}`;
    renderParty(self.party);
    renderMates(self.mates);
    if (shopOpen) renderShopSell();
    setBar('bar-hp', 'txt-hp', self.hp, self.maxHp);
    setBar('bar-mp', 'txt-mp', self.mp, self.maxMp);
    // compact bars shown on touch layouts while the sidebar drawer is closed
    const mh = $('mbar-hp'), mm = $('mbar-mp');
    if (mh) mh.style.width = Math.max(0, Math.min(100, (self.hp / self.maxHp) * 100)) + '%';
    if (mm) mm.style.width = Math.max(0, Math.min(100, (self.mp / self.maxMp) * 100)) + '%';
    if (self.level >= 20) {
      $('bar-xp').style.width = '100%';
      $('txt-xp').textContent = `Nv 20 - Fama ${self.fame}`;
    } else {
      setBar('bar-xp', 'txt-xp', self.xp, self.next, `Nv ${self.level} - ${self.xp}/${self.next}`);
    }
    const s = self.stats;
    $('hud-stats').innerHTML =
      `<span><b>ATT</b> ${s.att}</span><span><b>DEF</b> ${s.def}</span>` +
      `<span><b>SPD</b> ${s.spd}</span><span><b>DEX</b> ${s.dex}</span>` +
      `<span><b>VIT</b> ${s.vit}</span><span><b>WIS</b> ${s.wis}</span>`;
    for (let i = 0; i < 12; i++) renderSlot(slotEls[i], getSlotItem(i));
  }

  function setBar(barId, txtId, val, max, label) {
    $(barId).style.width = Math.max(0, Math.min(100, (val / max) * 100)) + '%';
    $(txtId).textContent = label || `${val}/${max}`;
  }

  function showBag(bag) {
    if (!bag) {
      currentBagId = null; currentBagItems = null;
      $('bag-label').style.display = 'none';
      $('bag-slots').style.display = 'none';
      return;
    }
    currentBagId = bag.id;
    currentBagItems = bag.items;
    $('bag-label').style.display = '';
    $('bag-slots').style.display = '';
    for (let i = 0; i < 8; i++) renderSlot(bagEls[i], bag.items[i]);
  }

  // ---------------- tooltip
  function rarity(tier) {
    if (tier >= 6) return ['Lendario', '#ffffff'];
    if (tier >= 4) return ['Epico', '#f0a040'];
    if (tier >= 2) return ['Raro', '#a860d8'];
    if (tier >= 1) return ['Incomum', '#48b048'];
    return ['Comum', '#aaaaaa'];
  }

  function showTooltip(e, itemId) {
    const tip = $('tooltip');
    if (!itemId || !ITEMS[itemId]) { tip.classList.add('hidden'); return; }
    const it = ITEMS[itemId];
    const [rname, rcolor] = rarity(it.tier);
    let html = `<div class="tname" style="color:${rcolor}">${it.name}${it.tier > 0 && it.tier < 6 ? ' (T' + it.tier + ')' : ''}</div>`;
    html += `<div style="color:${rcolor};font-size:10px">${rname}</div>`;
    if (it.proj) html += `Dano: ${it.proj.dmg[0]}-${it.proj.dmg[1]}<br>Alcance: ${it.proj.range}<br>${it.proj.count > 1 ? 'Tiros: ' + it.proj.count + '<br>' : ''}${it.proj.pierce ? 'Perfurante<br>' : ''}`;
    if (it.def) html += `Defesa: +${it.def}<br>`;
    if (it.mpCost) html += `Custo: ${it.mpCost} MP<br>`;
    if (it.bonus) html += Object.entries(it.bonus).map(([k, v]) => `${k.toUpperCase()} +${v}`).join(', ') + '<br>';
    if (it.heal) html += `Cura ${it.heal} HP<br>`;
    if (it.restore) html += `Restaura ${it.restore} MP<br>`;
    if (it.stat) html += `+${it.amount} ${it.stat.toUpperCase()} permanente<br>`;
    if (it.dungeons) html += 'Abre uma masmorra no Nexus<br>';
    if (it.buff) html += `+${Math.round((it.buff.mul - 1) * 100)}% ${it.buff.stat.toUpperCase()} por ${it.buff.durMs / 1000}s<br>`;
    if (it.set && SETS[it.set]) {
      const set = SETS[it.set];
      // how many pieces of this set are currently worn (colors the bonus lines)
      let worn = 0;
      if (currentSelf) for (let s = 0; s < 4; s++) {
        const eq = ITEMS[currentSelf.eq[s]];
        if (eq && eq.set === it.set) worn++;
      }
      html += `<div style="color:#3fd0b6;margin-top:3px">${set.name} (${worn}/3)</div>`;
      for (const n of [2, 3]) {
        const b = set.bonuses[n];
        if (!b) continue;
        const txt = Object.entries(b).map(([k, v]) => `${k.toUpperCase()} +${v}`).join(', ');
        html += `<div style="color:${worn >= n ? '#3fd0b6' : '#777'};font-size:10px">(${n}) ${txt}</div>`;
      }
    }
    if (it.type === 'consumable') html += '<i>Duplo clique para usar</i>';
    else html += '<i>Duplo clique para equipar - botao direito solta</i>';
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 240) + 'px';
    tip.style.top = Math.min(e.clientY + 14, innerHeight - 120) + 'px';
  }
  function hideTooltip() { $('tooltip').classList.add('hidden'); }

  // ---------------- chat & notices
  function chat(from, text, sys, evt) {
    const log = $('chat-log');
    const div = document.createElement('div');
    if (evt) { div.className = 'evt'; div.textContent = text; }
    else if (sys) { div.className = 'sys'; div.textContent = text; }
    else {
      const f = document.createElement('span');
      f.className = 'from'; f.textContent = from + ': ';
      div.appendChild(f);
      div.appendChild(document.createTextNode(text));
    }
    log.appendChild(div);
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  let noticeTimer = null;
  function notice(text) {
    const el = $('notice');
    el.textContent = text;
    el.style.opacity = 1;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el.style.opacity = 0; }, 2500);
  }

  function setName(text) { $('hud-name').textContent = text; }

  function setPortrait(classId) {
    const cv = $('hud-portrait');
    if (!cv) return;
    const spr = Sprites.get(classId);
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    if (spr) {
      const scale = Math.min(cv.width / spr.width, cv.height / spr.height);
      const w = spr.width * scale, h = spr.height * scale;
      c.imageSmoothingEnabled = false;
      c.drawImage(spr, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
    }
  }

  function setOnline(n) {
    const el = $('hud-online');
    if (el) el.textContent = n > 0 ? `${n} online` : '';
  }

  // boss encounter bar: shown while the compass target is a nearby boss
  function setBoss(quest, near) {
    const bar = $('boss-bar');
    if (!bar) return;
    if (!quest || !quest.maxHp || !near) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('boss-name').textContent = quest.name;
    $('boss-fill').style.width = Math.max(0, Math.min(100, (quest.hp / quest.maxHp) * 100)) + '%';
  }

  let zonesKey = '';
  function setZones(list) {
    const el = $('hud-zones'), label = $('zones-label');
    if (!el) return;
    list = list || [];
    const key = list.map(z => `${z.n}:${z.c}`).join('|');
    if (key === zonesKey) return;
    zonesKey = key;
    label.style.display = list.length ? '' : 'none';
    el.innerHTML = '';
    for (const z of list) {
      const div = document.createElement('div');
      const c = document.createElement('span');
      c.className = 'zc';
      c.textContent = z.c;
      div.append(`${z.n} · `, c);
      el.appendChild(div);
    }
  }

  function setZone(name) {
    const banner = $('zone-banner');
    if (!banner) return;
    $('zone-name').textContent = name;
    banner.classList.remove('hidden');
    // retrigger the entry animation on zone change
    banner.style.animation = 'none';
    void banner.offsetWidth;
    banner.style.animation = '';
  }

  function setPet(p) {
    const label = $('pet-label'), el = $('hud-pet');
    if (!el) return;
    if (!p || !p.pet) { label.style.display = 'none'; el.style.display = 'none'; return; }
    label.style.display = ''; el.style.display = '';
    el.innerHTML = '';
    const info = document.createElement('div');
    info.style.fontSize = '11px';
    info.textContent = `Nivel ${p.level} (${p.xp}/${p.next} xp) - alimente com ALT+1-8`;
    el.appendChild(info);
    const ACTIVES = {
      pet_wolf: 'Ativa: morde inimigos proximos',
      pet_imp: 'Ativa: dispara raios em inimigos',
      pet_sprite: 'Ativa: cura voce em combate',
    };
    if (ACTIVES[p.pet]) {
      const act = document.createElement('div');
      act.style.cssText = 'font-size:10px;color:#3fd0b6;margin-top:2px';
      act.textContent = ACTIVES[p.pet];
      el.appendChild(act);
    }
    const auraNames = { heal: 'Cura HP', magic: 'Cura MP', vigor: 'Vigor (ambos)' };
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;margin-top:3px';
    for (const a of p.auras) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = auraNames[a] || a;
      b.style.cssText = 'flex:1;font-size:10px;padding:3px' + (p.aura === a ? ';background:#7a2020' : '');
      b.onclick = () => Net.send({ t: 'petaura', aura: a });
      row.appendChild(b);
    }
    el.appendChild(row);
  }

  // party/mates lists arrive every tick: rebuild the DOM only when the
  // roster changes (otherwise clicks land on detached elements), and keep
  // the HP bars updated in place
  let partyKey = '';
  let partyHpEls = new Map();
  function renderParty(party) {
    const label = $('party-label'), el = $('hud-party');
    if (!el) return;
    if (!party || !party.length) {
      if (partyKey !== '') { partyKey = ''; partyHpEls.clear(); label.style.display = 'none'; el.innerHTML = ''; }
      return;
    }
    const key = party.map(m => `${m.name}:${m.level}:${m.here ? 1 : 0}`).join('|');
    if (key !== partyKey) {
      partyKey = key;
      partyHpEls.clear();
      label.style.display = '';
      el.innerHTML = '';
      for (const m of party) {
        const row = document.createElement('div');
        row.className = 'party-mate';
        row.innerHTML = `<span class="pm-name" style="color:${m.here ? '#8fe08f' : '#999'}">${m.name} ${m.level}</span>` +
          `<span class="pm-hp"><span></span></span>`;
        row.title = m.here ? 'Clique para teleportar' : 'Em outra area';
        if (m.here) row.onclick = () => Net.send({ t: 'teleport', name: m.name });
        el.appendChild(row);
        partyHpEls.set(m.name, row.querySelector('.pm-hp span'));
      }
      const leave = document.createElement('div');
      leave.className = 'party-leave';
      leave.textContent = '✕ Sair do grupo';
      leave.onclick = () => Net.send({ t: 'chat', text: '/party sair' });
      el.appendChild(leave);
    }
    for (const m of party) {
      const bar = partyHpEls.get(m.name);
      if (bar) bar.style.width = Math.max(0, Math.min(100, (m.hp / m.maxHp) * 100)) + '%';
    }
  }

  let matesKey = null;
  function renderMates(mates) {
    const label = $('mates-label'), el = $('hud-mates');
    if (!el) return;
    mates = mates || [];
    const key = mates.join('|');
    if (key === matesKey) return;
    matesKey = key;
    if (!mates.length) { label.style.display = 'none'; el.innerHTML = ''; return; }
    label.style.display = '';
    el.innerHTML = '';
    for (const name of mates) {
      const b = document.createElement('div');
      b.className = 'mate';
      b.textContent = name;
      b.title = 'Clique para acoes com ' + name;
      b.onclick = (e) => { e.stopPropagation(); showPlayerMenu(name, e.clientX, e.clientY); };
      el.appendChild(b);
    }
  }

  // ---------------- player action menu + invites
  function showPlayerMenu(name, x, y) {
    const menu = $('player-menu');
    if (!menu) return;
    menu.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'pm-title';
    title.textContent = name;
    menu.appendChild(title);
    const actions = [
      ['Teleportar ate', () => Net.send({ t: 'teleport', name })],
      ['Propor troca', () => Net.send({ t: 'trade', cmd: 'request', name })],
      ['Convidar p/ grupo', () => Net.send({ t: 'chat', text: '/party convidar ' + name })],
      ['Convidar p/ guilda', () => Net.send({ t: 'chat', text: '/guilda convidar ' + name })],
      ['Silenciar', () => Net.send({ t: 'chat', text: '/mute ' + name }), 'danger'],
    ];
    for (const [label2, fn, cls] of actions) {
      const btn = document.createElement('button');
      btn.textContent = label2;
      if (cls) btn.className = cls;
      btn.onclick = () => { fn(); hidePlayerMenu(); };
      menu.appendChild(btn);
    }
    menu.classList.remove('hidden');
    // keep it on-screen, anchored near the click
    const w = 190, h = 190;
    menu.style.left = Math.max(6, Math.min(x - w, innerWidth - w - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y - 10, innerHeight - h - 6)) + 'px';
    setTimeout(() => document.addEventListener('click', hidePlayerMenu, { once: true }), 0);
  }
  function hidePlayerMenu() {
    const menu = $('player-menu');
    if (menu) menu.classList.add('hidden');
  }

  let inviteTimer = null;
  function showInvite(m) {
    const bar = $('invite-bar');
    if (!bar) return;
    $('invite-text').textContent = m.kind === 'guild'
      ? `${m.from} convidou voce para a guilda "${m.guild}".`
      : `${m.from} convidou voce para o grupo.`;
    $('btn-invite-accept').onclick = () => {
      Net.send({ t: 'chat', text: m.kind === 'guild' ? '/guilda aceitar' : '/party aceitar' });
      bar.classList.add('hidden');
    };
    $('btn-invite-decline').onclick = () => bar.classList.add('hidden');
    bar.classList.remove('hidden');
    clearTimeout(inviteTimer);
    inviteTimer = setTimeout(() => bar.classList.add('hidden'), 20000);
  }

  let shopOpen = false;
  let shopValues = [];
  function renderShopSell() {
    const el = $('shop-sell');
    if (!el || !currentSelf) return;
    el.innerHTML = '';
    currentSelf.inv.forEach((id, i) => {
      const cell = document.createElement('div');
      cell.className = 'slot';
      if (id) {
        const spr = Sprites.forItem(id, ITEMS);
        if (spr) { const cv = document.createElement('canvas'); cv.width = spr.width; cv.height = spr.height; cv.getContext('2d').drawImage(spr, 0, 0); cell.appendChild(cv); }
        if (shopValues[i]) {
          const v = document.createElement('span');
          v.className = 'sell-val';
          v.textContent = `+${shopValues[i]}`;
          cell.appendChild(v);
        }
        cell.onmousemove = e => showTooltip(e, id);
        cell.onmouseleave = hideTooltip;
        cell.onclick = () => Net.send({ t: 'shopsell', slot: 4 + i });
      }
      el.appendChild(cell);
    });
  }
  let shopGold = 0;
  function showShop(m) {
    shopOpen = true;
    shopGold = m.gold;
    shopValues = m.values || [];
    $('shop-overlay').classList.remove('hidden');
    $('shop-gold').textContent = `Ouro: ${m.gold}`;
    const buy = $('shop-buy');
    buy.innerHTML = '';
    // group the catalog by category; the daily deal comes first
    const cats = [];
    const byCat = new Map();
    for (const b of m.buy) {
      const cat = b.cat || 'Itens';
      if (!byCat.has(cat)) { byCat.set(cat, []); cats.push(cat); }
      byCat.get(cat).push(b);
    }
    cats.sort((a, b) => (a === 'Oferta do Dia' ? -1 : b === 'Oferta do Dia' ? 1 : 0));
    for (const cat of cats) {
      const head = document.createElement('div');
      head.className = 'inv-label' + (cat === 'Oferta do Dia' ? ' sale-head' : '');
      head.textContent = cat;
      buy.appendChild(head);
      for (const b of byCat.get(cat)) {
        const row = document.createElement('div');
        row.className = 'shop-buy-row' + (m.gold < b.price ? ' poor' : '') + (b.sale ? ' sale' : '');
        const icon = document.createElement('div');
        icon.className = 'shop-icon';
        const spr = Sprites.forItem(b.id, ITEMS);
        if (spr) { const cv = document.createElement('canvas'); cv.width = spr.width; cv.height = spr.height; cv.getContext('2d').drawImage(spr, 0, 0); icon.appendChild(cv); }
        const name = document.createElement('span'); name.className = 'shop-name'; name.textContent = b.name;
        const price = document.createElement('span'); price.className = 'shop-price';
        if (b.sale && b.was) price.innerHTML = `<s>${b.was}</s> ${b.price} ⦿`;
        else price.textContent = `${b.price} ⦿`;
        row.append(icon, name, price);
        row.onmousemove = e => showTooltip(e, b.id);
        row.onmouseleave = hideTooltip;
        row.onclick = () => { if (shopGold >= b.price) Net.send({ t: 'shopbuy', item: b.id }); };
        buy.appendChild(row);
      }
    }
    // forge: fuse two same-tier items of the same kind into one tier up
    const head = document.createElement('div');
    head.className = 'inv-label';
    head.textContent = 'Forja (fusao de itens)';
    buy.appendChild(head);
    if (m.forge && m.forge.length) {
      for (const f of m.forge) {
        const row = document.createElement('div');
        row.className = 'shop-buy-row' + (m.gold < f.cost ? ' poor' : '');
        const icon = document.createElement('div');
        icon.className = 'shop-icon';
        icon.textContent = '⚒';
        const name = document.createElement('span');
        name.className = 'shop-name';
        name.textContent = `${f.label} → ${f.result}`;
        const price = document.createElement('span');
        price.className = 'shop-price';
        price.textContent = `${f.cost} ⦿`;
        row.append(icon, name, price);
        row.onclick = () => { if (shopGold >= f.cost) Net.send({ t: 'forge', a: f.a, b: f.b }); };
        buy.appendChild(row);
      }
    } else {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:10px;color:#888;padding:2px 4px';
      hint.textContent = 'Carregue 2 itens do mesmo tipo e tier no inventario para fundir.';
      buy.appendChild(hint);
    }
    renderShopSell();
  }
  function hideShop() { shopOpen = false; $('shop-overlay').classList.add('hidden'); }

  function setBounties(list) {
    const el = $('hud-bounties');
    if (!el) return;
    el.innerHTML = '';
    for (const b of list || []) {
      const div = document.createElement('div');
      div.className = 'bounty' + (b.done ? ' done' : '');
      div.textContent = `${b.done ? '✓' : '•'} ${b.label} (${b.progress}/${b.target})`;
      el.appendChild(div);
    }
  }

  return {
    init, update, showBag, showVault, chat, notice, setName, setBounties, setPet, showShop, hideShop,
    tradeRequest, tradeState, tradeEnd, setPortrait, setOnline, setZone, showInvite, setBoss, setZones,
    get items() { return ITEMS; },
  };
})();
