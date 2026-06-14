'use strict';
// HUD: bars, stats, inventory/equipment slots with drag & drop, loot bag
// panel, chat log, tooltips.

const UI = (() => {
  let ITEMS = {}; // item metadata from /api/items
  const $ = id => document.getElementById(id);

  const EQUIP_LABELS = ['Arma', 'Habilid.', 'Armadura', 'Anel'];
  let slotEls = [];   // 12 slots: 0-3 equip, 4-11 inventory
  let bagEls = [];
  let currentBagId = null;
  let dragFrom = null;

  async function init() {
    ITEMS = await Net.api('GET', '/api/items');
    buildSlots();
  }

  function buildSlots() {
    const eq = $('equip-slots'), inv = $('inv-slots'), bag = $('bag-slots');
    eq.innerHTML = ''; inv.innerHTML = ''; bag.innerHTML = '';
    slotEls = []; bagEls = [];
    buildVaultSlots();
    buildTradePanel();
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
        if (dragFrom.type === 'bag') { Net.send({ t: 'pickup', bag: currentBagId, idx: dragFrom.i }); if (typeof Sfx !== 'undefined') Sfx.pickup(); }
        dragFrom = null;
      });
      el.addEventListener('dblclick', () => {
        if (vaultOpen && i >= 4 && getSlotItem(i)) Net.send({ t: 'vault', cmd: 'deposit', slot: i });
        else useOrEquip(i);
      });
      el.addEventListener('click', () => {
        if (trading && i >= 4) toggleOffer(i - 4);
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
      el.addEventListener('dblclick', () => Net.send({ t: 'vault', cmd: 'withdraw', idx: i }));
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
    init, update, showBag, showVault, chat, notice, setName, setBounties,
    tradeRequest, tradeState, tradeEnd,
    get items() { return ITEMS; },
  };
})();
