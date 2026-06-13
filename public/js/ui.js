'use strict';
// HUD: bars, stats, inventory/equipment slots with drag & drop, loot bag
// panel, chat log, tooltips.

const UI = (() => {
  let ITEMS = {}; // item metadata from /api/items
  const $ = id => document.getElementById(id);

  const EQUIP_LABELS = ['Arma', 'Habilid.', 'Armadura', 'Anel'];
  let slotEls = [];   // 12 slots: 0-3 equip, 4-11 inventory
  let bagEls = [];
  let vaultEls = [];  // 16 vault slots (server indexes 12-27)
  let currentBagId = null;
  let dragFrom = null;

  async function init() {
    ITEMS = await Net.api('GET', '/api/items');
    buildSlots();
  }

  function buildSlots() {
    const eq = $('equip-slots'), inv = $('inv-slots'), bag = $('bag-slots'), vault = $('vault-slots');
    eq.innerHTML = ''; inv.innerHTML = ''; bag.innerHTML = ''; vault.innerHTML = '';
    slotEls = []; bagEls = []; vaultEls = [];
    for (let i = 0; i < 12; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.dataset.slot = i;
      el.title = i < 4 ? EQUIP_LABELS[i] : '';
      el.draggable = true;
      el.addEventListener('dragstart', () => { dragFrom = { type: 'slot', i }; });
      el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault(); el.classList.remove('drag-over');
        if (!dragFrom) return;
        if (dragFrom.type === 'slot' && dragFrom.i !== i) Net.send({ t: 'invswap', from: dragFrom.i, to: i });
        if (dragFrom.type === 'bag') { Net.send({ t: 'pickup', bag: currentBagId, idx: dragFrom.i }); Sfx.pickup(); }
        if (dragFrom.type === 'vault') Net.send({ t: 'vaultswap', from: 12 + dragFrom.i, to: i });
        dragFrom = null;
      });
      el.addEventListener('dblclick', () => useOrEquip(i));
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
      el.addEventListener('dblclick', () => { Net.send({ t: 'pickup', bag: currentBagId, idx: i }); Sfx.pickup(); });
      el.addEventListener('mousemove', e => showTooltip(e, currentBagItems && currentBagItems[i]));
      el.addEventListener('mouseleave', hideTooltip);
      bag.appendChild(el);
      bagEls.push(el);
    }
    const tm = $('trade-mine'), tt = $('trade-theirs');
    tm.innerHTML = ''; tt.innerHTML = '';
    tradeMineEls = []; tradeTheirEls = [];
    for (let i = 0; i < 8; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.addEventListener('click', () => {
        if (!lastTrade) return;
        const mine = lastTrade.mine.slice();
        mine[i] = !mine[i];
        Net.send({ t: 'tradeoffer', slots: mine });
      });
      el.addEventListener('mousemove', e => showTooltip(e, currentSelf && currentSelf.inv[i]));
      el.addEventListener('mouseleave', hideTooltip);
      tm.appendChild(el);
      tradeMineEls.push(el);
      const el2 = document.createElement('div');
      el2.className = 'slot';
      el2.addEventListener('mousemove', e => showTooltip(e, lastTrade && lastTrade.theirs[i]));
      el2.addEventListener('mouseleave', hideTooltip);
      tt.appendChild(el2);
      tradeTheirEls.push(el2);
    }
    $('btn-trade-ok').onclick = () => Net.send({ t: 'tradeconfirm' });
    $('btn-trade-cancel').onclick = () => Net.send({ t: 'tradecancel' });
    for (let i = 0; i < 16; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.draggable = true;
      el.addEventListener('dragstart', () => { dragFrom = { type: 'vault', i }; });
      el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault(); el.classList.remove('drag-over');
        if (!dragFrom) return;
        if (dragFrom.type === 'slot') Net.send({ t: 'vaultswap', from: dragFrom.i, to: 12 + i });
        if (dragFrom.type === 'vault' && dragFrom.i !== i) Net.send({ t: 'vaultswap', from: 12 + dragFrom.i, to: 12 + i });
        dragFrom = null;
      });
      el.addEventListener('dblclick', () => {
        // move to first free inventory slot
        if (!currentSelf || !currentVault || !currentVault[i]) return;
        const free = currentSelf.inv.indexOf(null);
        if (free !== -1) Net.send({ t: 'vaultswap', from: 12 + i, to: free + 4 });
      });
      el.addEventListener('mousemove', e => showTooltip(e, currentVault && currentVault[i]));
      el.addEventListener('mouseleave', hideTooltip);
      vault.appendChild(el);
      vaultEls.push(el);
    }
  }

  let currentSelf = null;
  let currentBagItems = null;
  let currentVault = null;
  let tradeMineEls = [], tradeTheirEls = [];
  let lastTrade = null;

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
    if (!itemId) return;
    const it = ITEMS[itemId];
    const spr = Sprites.forItem(itemId, ITEMS);
    if (spr) {
      const cv = document.createElement('canvas');
      cv.width = spr.width; cv.height = spr.height;
      cv.getContext('2d').drawImage(spr, 0, 0);
      el.appendChild(cv);
    }
    if (it && it.tier > 0) {
      const t = document.createElement('span');
      t.className = 'tier'; t.textContent = 'T' + it.tier;
      el.appendChild(t);
    }
  }

  function update(self) {
    currentSelf = self;
    setBar('bar-hp', 'txt-hp', self.hp, self.maxHp);
    setBar('bar-mp', 'txt-mp', self.mp, self.maxMp);
    if (self.level >= 20) {
      $('bar-xp').style.width = '100%';
      $('txt-xp').textContent = `Nv 20 - Fama ${self.fame}`;
    } else {
      setBar('bar-xp', 'txt-xp', self.xp, self.next, `Nv ${self.level} - ${self.xp}/${self.next}`);
    }
    const s = self.stats;
    $('hud-stats').innerHTML =
      `<span>ATT ${s.att}</span><span>DEF ${s.def}</span>` +
      `<span>SPD ${s.spd}</span><span>DEX ${s.dex}</span>` +
      `<span>VIT ${s.vit}</span><span>WIS ${s.wis}</span>`;
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

  function showVault(vault) {
    if (!vault) {
      currentVault = null;
      $('vault-label').style.display = 'none';
      $('vault-slots').style.display = 'none';
      return;
    }
    currentVault = vault;
    $('vault-label').style.display = '';
    $('vault-slots').style.display = '';
    for (let i = 0; i < 16; i++) renderSlot(vaultEls[i], vault[i]);
  }

  function showTrade(msg) {
    lastTrade = msg;
    $('trade-overlay').classList.remove('hidden');
    $('trade-title').textContent = 'Troca com ' + msg.partner;
    for (let i = 0; i < 8; i++) {
      renderSlot(tradeMineEls[i], currentSelf ? currentSelf.inv[i] : null);
      tradeMineEls[i].classList.toggle('offered', !!msg.mine[i]);
      renderSlot(tradeTheirEls[i], msg.theirs[i]);
    }
    $('trade-status').textContent =
      (msg.ok ? 'Voce confirmou. ' : '') + (msg.theirOk ? `${msg.partner} confirmou.` : '');
  }

  function hideTrade() {
    lastTrade = null;
    $('trade-overlay').classList.add('hidden');
  }

  // ---------------- tooltip
  function showTooltip(e, itemId) {
    const tip = $('tooltip');
    if (!itemId || !ITEMS[itemId]) { tip.classList.add('hidden'); return; }
    const it = ITEMS[itemId];
    let html = `<div class="tname">${it.name}${it.tier > 0 ? ' (T' + it.tier + ')' : ''}</div>`;
    if (it.proj) html += `Dano: ${it.proj.dmg[0]}-${it.proj.dmg[1]}<br>Alcance: ${it.proj.range}<br>${it.proj.count > 1 ? 'Tiros: ' + it.proj.count + '<br>' : ''}${it.proj.pierce ? 'Perfurante<br>' : ''}`;
    if (it.def) html += `Defesa: +${it.def}<br>`;
    if (it.mpCost) html += `Custo: ${it.mpCost} MP<br>`;
    if (it.bonus) html += Object.entries(it.bonus).map(([k, v]) => `${k.toUpperCase()} +${v}`).join(', ') + '<br>';
    if (it.heal) html += `Cura ${it.heal} HP<br>`;
    if (it.restore) html += `Restaura ${it.restore} MP<br>`;
    if (it.stat) html += `+${it.amount} ${it.stat.toUpperCase()} permanente<br>`;
    if (it.type === 'consumable') html += '<i>Duplo clique para usar</i>';
    else html += '<i>Duplo clique para equipar - botao direito solta</i>';
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 240) + 'px';
    tip.style.top = Math.min(e.clientY + 14, innerHeight - 120) + 'px';
  }
  function hideTooltip() { $('tooltip').classList.add('hidden'); }

  // ---------------- chat & notices
  function chat(from, text, sys) {
    const log = $('chat-log');
    const div = document.createElement('div');
    if (sys) { div.className = 'sys'; div.textContent = text; }
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

  return { init, update, showBag, showVault, showTrade, hideTrade, chat, notice, setName, get items() { return ITEMS; } };
})();
