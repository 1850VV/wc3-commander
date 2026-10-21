/* The console's shell: the page's state (编排 for now; 实战 and 回放 come next), the top bar, the menus, the
   script and its versions, and the budget behind everything on screen.

   编排: the tactic script (GET /api/script) and the start's layout (GET /api/strategies/人族速矿二本 · 方向)
   go through the budget model (budget.js) into what the timeline and the sandbox draw (TL.load). Every
   edit there fires 「script-edited」: the timeline's lanes are written back as script text (lanesToText),
   kept as a version for undo, budgeted again and loaded again, in a few milliseconds. 「保存」 writes the
   text (PUT /api/script); the server checks it, and its errors are shown under the top bar. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), TL = window.TL, fmt = TL.fmt, DATA = window.LT_DATA, ECO = DATA.economy.units;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const START_NAMES = DATA.starts.map(s => s.name);
  const S = {text: '', saved: '', model: null, start: 0, layouts: {}, undo: [], redo: [], busy: false, errors: [], state: 'plan', bottom: 'tl'};
  async function api(method, path, body) {
    const r = await fetch(path, {method, headers: {'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return r.json();
  }

  /* ---------- the budget: the script as it is now -> what the timeline and the sandbox draw ---------- */
  async function layoutOf(start) {
    if (!(start in S.layouts)) {
      try { const j = await api('GET', '/api/strategies/' + encodeURIComponent('人族速矿二本 · ' + START_NAMES[start])); S.layouts[start] = j.ok ? j.plan.groups : []; }
      catch (_) { S.layouts[start] = []; }
    }
    return S.layouts[start];
  }
  function mineOf(hall) { return DATA.mines.map(m => [m.x, m.y]).sort((a, b) => Math.hypot(a[0] - hall[0], a[1] - hall[1]) - Math.hypot(b[0] - hall[0], b[1] - hall[1]))[0]; }
  function budget(text, start) {
    const st = DATA.starts[start], hall = [st.x, st.y], m = Budget.fromText(text);
    const places = Budget.resolvePlaces(m.positions, S.layouts[start] || [], hall, Budget.NATURALS[start]);
    return Budget.run({eco: ECO, start, hall, mine: mineOf(hall), lanes: m.lanes, reserves: m.reserves, places});
  }
  /* the budget's result in the timeline's shape: lanes, one economy row and every unit's place a second */
  function toData(j) {
    const T = j.timeline, F = j.frames, pos = {}, eco = [];
    for (const f of F) {
      const r = {main: 0, nat: 0, wood: 0, build: 0, mil: 0, idle: 0};
      for (const u of f.units) {
        (pos[u.id] = pos[u.id] || []).push([f.t, u.x, u.y]);
        if (u.type === 'hmil') r.mil++;
        else if (u.type === 'hpea') { if (u.role === 'gold') (Math.hypot(u.x - T.natural[0], u.y - T.natural[1]) < 1500 ? r.nat++ : r.main++); else if (u.role === 'wood') r.wood++; else if (u.role === 'idle') r.idle++; else r.build++; }
      }
      const got = f.got || [0, 0];
      eco.push([f.t, f.gold, f.wood, f.foodUsed, f.foodCap, got[0], got[1], r.main, r.nat, r.wood, r.build, r.mil, r.idle]);
    }
    const places = {...T.places}; delete places.主矿; delete places.分矿; // the mines are named by the step, not the script's places
    return {lanes: T.lanes, eco, pos, units: T.units, places: {...places, 分矿: T.natural, 主矿: T.mine}, hall: T.hall, mine: T.mine, natural: T.natural, mineGold: T.mineGold || 12500, end: F.length ? F[F.length - 1].t : 600};
  }
  function recompute() {
    let j;
    try { j = budget(S.text, S.start); } catch (e) { TL.toast('预算没算出来：' + e.message); return; }
    TL.load(toData(j));
    TL.muted.clear(); TL.lanes.forEach(L => { if (L.muted) TL.muted.add(L.id); });
    window.dispatchEvent(new CustomEvent('data-loaded'));
    syncTop();
  }

  /* ---------- the timeline's lanes back to the script's text ----------
     The script's own order, notes and positions are kept; each lane's steps are what the timeline holds
     now. Peasants that share a line stay together while their steps are the same, and split when not. */
  const ecoName = t => (ECO[t] || {}).name || t;
  function laneLabelOf(ln) {
    if (ln.kind === 'hero') return ln.head;
    if (ln.kind === 'army') return '步兵';
    if (ln.kind === 'squad') return '队伍·' + ln.name;
    if (ln.kind === 'building') return ln.tag ? '#' + ln.tag : ecoName(ln.btype);
    return null;
  }
  const stepsOf = L => L.steps.map(s => String(s.raw || '').trim()).filter(Boolean);
  function lanesToText() {
    const M = S.model, byLabel = new Map(TL.lanes.map(L => [L.label, L])), used = new Set(), out = [];
    const note = x => (x.note ? ['# ' + x.note] : []);
    const muted = L => !!(L && TL.muted.has(L.id)); // TL.muted starts from the script's 「#⏸」 at every load
    const line = (head, steps, mute) => { const rows = []; for (let i = 0; i < steps.length; i += 4) rows.push(steps.slice(i, i + 4)); return [(mute ? '#⏸ ' : '') + head + '：' + (rows[0] || []).join(' → ')].concat(rows.slice(1).map(r => '      → ' + r.join(' → '))); };
    if (M.header) out.push(...M.header.split('\n').map(h => '# ' + h));
    out.push('# ---------- 位置 ----------');
    const named = new Set(M.positions.map(p => p.name));
    for (const p of M.positions) out.push(...note(p), `位置 ${p.name} = ${p.expr}`);
    for (const [name, xy] of Object.entries(TL.D.places)) // places made on the sandbox
      if (!named.has(name) && name !== '主矿' && name !== '分矿' && xy && TL.lanes.some(L => L.steps.some(s => s.pos === name))) out.push(`位置 ${name} = 坐标 ${Math.round(xy[0])},${Math.round(xy[1])}`);
    for (const [title, kind] of [['农民', 'peasant'], ['建筑生产顺序', 'building'], ['英雄', 'hero'], ['队伍', 'squad'], ['部队', 'army']]) {
      const lanes = M.lanes.filter(x => x.kind === kind), extra = kind === 'squad' ? TL.lanes.filter(L => L.kind === 'squad' && !M.lanes.some(x => x.kind === 'squad' && '队伍·' + x.name === L.label)) : [];
      if (!lanes.length && !extra.length && (kind === 'squad' || kind === 'army')) continue;
      out.push('', `# ---------- ${title} ----------`);
      for (const ln of lanes) {
        out.push(...note(ln));
        if (kind === 'peasant') { // one group per run of identical lives
          const groups = [];
          for (const c of ln.cids) {
            const L = byLabel.get('农民' + c); used.add('农民' + c);
            const steps = L ? stepsOf(L) : ln.steps.map(s => s.raw), key = (muted(L) ? '⏸' : '') + steps.join('→');
            const g = groups.find(x => x.key === key); if (g) g.cids.push(c); else groups.push({key, cids: [c], steps, mute: muted(L) || (!L && ln.muted)});
          }
          for (const g of groups) if (g.steps.length) out.push(...line('农民' + g.cids.join('、'), g.steps, g.mute));
        } else {
          const label = laneLabelOf(ln), L = byLabel.get(label); used.add(label);
          const steps = L ? stepsOf(L) : ln.steps.map(s => s.raw);
          if (steps.length) out.push(...line(ln.head, steps, L ? muted(L) : ln.muted));
        }
      }
      for (const L of extra) { const steps = stepsOf(L); if (steps.length) out.push(...line('队伍 ' + L.label.replace(/^队伍·/, ''), steps, muted(L))); }
    }
    out.push('', '# ---------- 留钱 ----------');
    for (const r of M.reserves) out.push(...note(r), r.raw.trim());
    return out.join('\n') + '\n';
  }

  /* ---------- edits, versions, saving ---------- */
  let pending = false;
  window.addEventListener('script-edited', () => {
    if (pending || S.busy) return; pending = true;
    setTimeout(() => { pending = false; const text = lanesToText(); if (text !== S.text) setText(text, true); }, 0);
  });
  function setText(text, keepUndo) {
    if (keepUndo) { S.undo.push(S.text); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
    S.text = text; S.busy = true;
    try { recompute(); } finally { S.busy = false; }
    reparse(); checkSoon();
  }
  function reparse() { // the model the next write keeps its order, notes and positions from
    api('PUT', '/api/script', {text: S.text, dryRun: true}).then(j => { if (j.model) S.model = j.model; showErrors(j.errors || []); }).catch(() => {});
  }
  let checkT = 0;
  function checkSoon() { clearTimeout(checkT); checkT = setTimeout(reparse, 400); }
  function showErrors(errors) {
    S.errors = errors; const el = $('errs');
    el.hidden = !errors.length;
    el.innerHTML = errors.length ? `<b>脚本有 ${errors.length} 处要改</b>（改好前不能保存）：` + errors.slice(0, 4).map(e => `<span>${esc(e)}</span>`).join('') + (errors.length > 4 ? `<span>…还有 ${errors.length - 4} 处，用「更多 → 用文本编辑脚本」看全部</span>` : '') : '';
  }
  function undo() { if (!S.undo.length) { TL.toast('没有可以撤销的了'); return; } S.redo.push(S.text); S.text = S.undo.pop(); S.busy = true; try { recompute(); } finally { S.busy = false; } reparse(); TL.toast(`撤销了上一个改动${S.undo.length ? `（还能撤销 ${S.undo.length} 次）` : ''}`); }
  function redo() { if (!S.redo.length) { TL.toast('没有可以重做的了'); return; } S.undo.push(S.text); S.text = S.redo.pop(); S.busy = true; try { recompute(); } finally { S.busy = false; } reparse(); TL.toast('重做了一个改动'); }
  $('undoBtn').onclick = undo; $('redoBtn').onclick = redo;
  document.addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || !(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); save(); }
  });
  async function save() {
    let j; try { j = await api('PUT', '/api/script', {text: S.text}); } catch (_) { TL.toast('没保存：连不上本地服务'); return; }
    if (!j.saved) { showErrors(j.errors || []); TL.toast('脚本有错，没有保存：' + ((j.errors || [])[0] || '')); return; }
    S.saved = S.text; if (j.model) S.model = j.model; syncTop(); TL.toast('已保存：战术脚本（工地位置也在脚本里）。');
  }
  $('saveBtn').onclick = save;

  /* ---------- the top bar ---------- */
  function syncTop() {
    const dirty = S.text !== S.saved;
    $('saveBtn').querySelector('.dirty').hidden = !dirty; $('saveBtn').title = dirty ? '有改动还没保存（Ctrl+S）' : '已保存';
    $('undoBtn').disabled = !S.undo.length; $('redoBtn').disabled = !S.redo.length;
    $('undoBtn').title = S.undo.length ? `撤销（还能撤销 ${S.undo.length} 次，Ctrl+Z）` : '没有可以撤销的';
    $('redoBtn').title = S.redo.length ? `重做（${S.redo.length} 次，Ctrl+Shift+Z）` : '没有可以重做的';
    $('stName').textContent = '编排'; $('stSub').textContent = `${START_NAMES[S.start]} · 时间按预算估算 · 改了马上重算`;
  }
  $('startSel').innerHTML = START_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  $('startSel').onchange = async () => { S.start = +$('startSel').value; await layoutOf(S.start); recompute(); TL.toast(`换到${START_NAMES[S.start]}：同一份脚本，工地用${START_NAMES[S.start]}的布局。`); };
  $('connect').onclick = () => TL.toast('实战（连着游戏时时间轴跟着游戏走、下令马上生效）下一步接上；现在请用「更多 → 旧控制台」连接游戏。');
  document.querySelectorAll('[data-in]').forEach(el => { el.hidden = !el.dataset.in.split(' ').includes('plan'); });
  function loop() { requestAnimationFrame(loop); $('clock').textContent = fmt(TL.t); $('orderBtn').textContent = `在 ${fmt(TL.t)} 下令`; if (S.bottom === 'cards') renderCards(); }

  /* ---------- menus ---------- */
  const MENUS = [['moreBtn', 'moreMenu'], ['showBtn', 'showMenu'], ['helpBtn', 'helpMenu']];
  function closeMenus(except) { for (const [b, m] of MENUS) if (m !== except) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); } }
  for (const [b, m] of MENUS) $(b).onclick = e => { e.stopPropagation(); const open = $(m).hidden; closeMenus(m); $(m).hidden = !open; $(b).setAttribute('aria-expanded', open); };
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenus(); $('textDlg').hidden = true; } });
  $('moreMenu').onclick = e => {
    const b = e.target.closest('[data-m]'); if (!b) return; closeMenus();
    const m = b.dataset.m;
    if (m === 'text') { $('textArea').value = S.text; $('textErr').textContent = ''; $('textDlg').hidden = false; $('textArea').focus(); return; }
    if (m === 'old') { location.href = 'old.html'; return; }
    if (m === 'revert') { if (S.text === S.saved) { TL.toast('没有没保存的改动'); return; } setText(S.saved, true); TL.toast('回到了上次保存的脚本（可以撤销）'); return; }
    TL.toast({saveas: '另存为：下一步接上（现在只有一份战术脚本）。', load: '载入：下一步接上。', replay: '回放：下一步接上；现在请用「旧控制台」的回放。',
      full: '完整跑一遍（假游戏）：下一步接上；现在请用「旧控制台」的战术脚本标签。'}[m] || '');
  };
  /* the script as text: for big changes, copy and paste */
  $('textApply').onclick = async () => {
    const text = $('textArea').value;
    let j; try { j = await api('PUT', '/api/script', {text, dryRun: true}); } catch (_) { $('textErr').textContent = '连不上本地服务'; return; }
    if (j.errors && j.errors.length) { $('textErr').textContent = '有错：' + j.errors.slice(0, 3).join('；'); return; }
    $('textDlg').hidden = true; S.model = j.model; setText(text, true); TL.toast('脚本按文本更新了（未保存；可以撤销）');
  };
  $('textCancel').onclick = () => { $('textDlg').hidden = true; };

  /* ---------- the lower half: timeline or cards ---------- */
  $('bottomTabs').onclick = e => {
    const b = e.target.closest('[data-b]'); if (!b) return; S.bottom = b.dataset.b;
    $('bottomTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('tlView').hidden = S.bottom !== 'tl'; $('cardView').hidden = S.bottom !== 'cards';
    if (S.bottom === 'cards') renderCards(true); else TL.redraw();
  };
  const KIND = body => { const w = body.split(' ')[0];
    return {采金: 'gold', 伐木: 'wood', 建造: 'build', 协助: 'assist', 敲钟: 'bell', 集合: 'bell', 清野: 'fight', 攻击移动: 'fight', 待命: 'wait', 移动: 'wait', 学: 'wait', 集结点: 'wait', 升级: 'upgrade', 加入: 'bell', 解散: 'bell'}[w] || 'train'; };
  let cardsKey = '';
  function renderCards(force) {
    const key = Math.floor(TL.t) + '|' + S.text.length + '|' + S.undo.length;
    if (!force && key === cardsKey) return; cardsKey = key;
    const groups = [];
    for (const L of TL.lanes) {
      const sig = L.steps.map(s => s.raw).join('→'), g = L.kind === 'peasant' && groups.find(x => x.kind === 'peasant' && x.sig === sig);
      if (g) g.lanes.push(L); else groups.push({kind: L.kind, sig, lanes: [L]});
    }
    const head = {peasant: '农民', building: '建筑', hero: '英雄', squad: '队伍', army: '部队'};
    let html = '', lastKind = '';
    for (const g of groups) {
      if (g.kind !== lastKind) { html += `<div class="cv-row grp">${head[g.kind] || g.kind}</div>`; lastKind = g.kind; }
      const L0 = g.lanes[0], label = g.kind === 'peasant' ? '农民' + g.lanes.map(L => L.label.slice(2)).join('、') : L0.label;
      const cards = L0.steps.map((s, k) => {
        const starts = g.lanes.map(L => L.steps[k] && L.steps[k].start).filter(x => x != null), st = starts.length ? Math.min(...starts) : null;
        const end = TL.stepEnd(s), cls = st == null ? 'never' : (end != null && end <= TL.t) ? 'past' : st <= TL.t ? 'now' : '';
        return `${k ? '<span class="cv-arrow" aria-hidden="true">→</span>' : ''}<button type="button" class="cv-card k-${KIND(s.body)} ${cls}" data-t="${st == null ? '' : st}">` +
          `${s.cond ? `<em>[${esc(s.cond)}]</em>` : ''}<b>${esc(s.body)}${s.pos ? ' @' + esc(s.pos) : ''}${s.tag ? ' #' + esc(s.tag) : ''}</b><small>${st == null ? fmt(TL.END) + ' 前不会开始' : fmt(st) + ' 开始'}</small></button>`;
      }).join('');
      html += `<div class="cv-row"><div class="cv-lab">${esc(label)}${g.lanes.length > 1 ? `<small>${g.lanes.length} 人一起</small>` : ''}${L0.muted ? '<small>暂停执行</small>' : ''}</div><div class="cv-steps">${cards}</div></div>`;
    }
    $('cvRows').innerHTML = html;
  }
  $('cvRows').onclick = e => { const c = e.target.closest('.cv-card'); if (!c) return; if (c.dataset.t === '') { TL.toast('这一步不会开始：它的条件一直没满足。'); return; } TL.t = +c.dataset.t; renderCards(true); };

  window.CONSOLE = {lanesToText, get text() { return S.text; }, get errors() { return S.errors; }}; // for checks from the browser
  /* ---------- start ---------- */
  (async function init() {
    if (location.protocol === 'file:') { $('errs').hidden = false; $('errs').innerHTML = '<b>这个页面要从本地服务打开</b>：运行 <code>python -m commander_bridge</code> 后打开 http://127.0.0.1:8790/'; return; }
    let j; try { j = await api('GET', '/api/script'); } catch (_) { $('errs').hidden = false; $('errs').innerHTML = '<b>连不上本地服务</b>：战术脚本读不到。'; return; }
    S.text = S.saved = j.text; S.model = j.model;
    await layoutOf(S.start);
    recompute(); showErrors(j.errors || []);
    requestAnimationFrame(loop);
    TL.toast('编排：时间轴和沙盘都是这份战术脚本的预算。选中单位后右键下令、Shift+右键接在最后；改了马上重算，Ctrl+Z 撤销，Ctrl+S 保存。');
  })();
})();
