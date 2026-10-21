/* The console's shell: the page's state (编排 / 实战 / 回放), the top bar, the menus, the script and its
   versions, and what the timeline and the sandbox draw (TL.load).

   编排: the tactic script (GET /api/script) and the start's layout (GET /api/strategies/人族速矿二本 · 方向)
   go through the budget model (budget.js). Every edit on the timeline or the sandbox fires「script-edited」:
   the lanes are written back as script text (lanesToText), kept as a version for undo, budgeted again and
   loaded again, in a few milliseconds. 「保存」 writes the text (PUT /api/script).

   实战: connected to the bridge (GET /api/stream). The console takes the script the game plays
   (GET /api/script/live), records the game second by second, and every 2 s budgets the rest of it from the
   game as it is (Budget.run({live})) at the gathering rates measured (Budget.ratesFrom): the red line is
   now, before it the game, after it the projection, each step's shadow and the side box against the plan
   budgeted from 0:00. Edits go to the game at once (POST /api/script/live); a change it refuses is taken back.

   回放: a recorded game (GET /api/runs/<id>): its frames and each step's real times; no edits. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), TL = window.TL, fmt = TL.fmt, DATA = window.LT_DATA, ECO = DATA.economy.units;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const START_NAMES = DATA.starts.map(s => s.name);
  const S = {text: '', saved: '', model: null, start: 0, layouts: {}, undo: [], redo: [], busy: false, errors: [], state: 'plan', bottom: 'tl'};
  const LV = {es: null, state: null, hist: null, rates: null, hold: 0, lastProj: 0, adopted: false, backend: '', sending: false};
  let RP = null; // the replay open: {id, meta, frames, data}
  async function api(method, path, body) {
    const r = await fetch(path, {method, headers: {'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return r.json();
  }

  /* ---------- the budget: the script -> what the timeline and the sandbox draw ---------- */
  async function layoutOf(start) {
    if (!(start in S.layouts)) {
      try { const j = await api('GET', '/api/strategies/' + encodeURIComponent('人族速矿二本 · ' + START_NAMES[start])); S.layouts[start] = j.ok ? j.plan.groups : []; }
      catch (_) { S.layouts[start] = []; }
    }
    return S.layouts[start];
  }
  function mineOf(hall) { return DATA.mines.map(m => [m.x, m.y]).sort((a, b) => Math.hypot(a[0] - hall[0], a[1] - hall[1]) - Math.hypot(b[0] - hall[0], b[1] - hall[1]))[0]; }
  function budget(text, start, extra = {}) {
    const st = DATA.starts[start], hall = [st.x, st.y], m = Budget.fromText(text);
    const places = Budget.resolvePlaces(m.positions, S.layouts[start] || [], hall, Budget.NATURALS[start]);
    return Budget.run({eco: ECO, start, hall, mine: mineOf(hall), lanes: m.lanes, reserves: m.reserves, places, ...extra});
  }
  /* frames (budget, game or replay) and lanes in the timeline's shape: one economy row and every unit's
     place a second */
  function toData(T, F) {
    const pos = {}, eco = [], natural = T.natural || [0, 0];
    for (const f of F) {
      const r = {main: 0, nat: 0, wood: 0, build: 0, mil: 0, idle: 0};
      for (const u of f.units) {
        if (!u.hidden) (pos[u.id] = pos[u.id] || []).push([f.t, u.x, u.y]);
        if (u.type === 'hmil') r.mil++;
        else if (u.type === 'hpea') { if (u.role === 'gold') (Math.hypot(u.x - natural[0], u.y - natural[1]) < 1500 ? r.nat++ : r.main++); else if (u.role === 'wood') r.wood++; else if (u.role === 'idle') r.idle++; else r.build++; }
      }
      const got = f.got || [0, 0];
      eco.push([f.t, f.gold, f.wood, f.foodUsed, f.foodCap, got[0], got[1], r.main, r.nat, r.wood, r.build, r.mil, r.idle]);
    }
    const places = {...(T.places || {})}; delete places.主矿; delete places.分矿; // the mines are named by the step, not the script's places
    const units = {...(T.units || {})}; for (const f of F) for (const u of f.units) if (!(u.id in units)) units[u.id] = u.type === 'hmil' ? 'hpea' : u.type;
    return {lanes: T.lanes, eco, pos, units, places: {...places, 分矿: natural, 主矿: T.mine}, hall: T.hall, mine: T.mine, natural, mineGold: T.mineGold || 12500, end: F.length ? F[F.length - 1].t : 600};
  }
  /* one frame a second, by index (the timeline reads rows by second; a fast game records one every few) */
  function perSecond(src) {
    const F = []; if (!src.length) return F;
    for (let sec = 0, i = 0; sec <= Math.floor(src[src.length - 1].t); sec++) { while (i + 1 < src.length && src[i + 1].t <= sec) i++; F.push({...src[i], t: sec}); }
    return F;
  }
  function show(D) {
    TL.load(D);
    TL.muted.clear(); TL.lanes.forEach(L => { if (L.muted) TL.muted.add(L.id); });
    window.dispatchEvent(new CustomEvent('data-loaded'));
    syncTop();
  }
  function recompute() {
    if (S.state === 'live') { project(true); return; }
    if (S.state === 'replay') return;
    let j; try { j = budget(S.text, S.start); } catch (e) { TL.toast('预算没算出来：' + e.message); return; }
    show(toData(j.timeline, j.frames));
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
    const M = S.model, byLabel = new Map(TL.lanes.map(L => [L.label, L])), out = [];
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
            const L = byLabel.get('农民' + c), steps = L ? stepsOf(L) : ln.steps.map(s => s.raw), key = (muted(L) ? '⏸' : '') + steps.join('→');
            const g = groups.find(x => x.key === key); if (g) g.cids.push(c); else groups.push({key, cids: [c], steps, mute: L ? muted(L) : !!ln.muted});
          }
          for (const g of groups) if (g.steps.length) out.push(...line('农民' + g.cids.join('、'), g.steps, g.mute));
        } else {
          const L = byLabel.get(laneLabelOf(ln)), steps = L ? stepsOf(L) : ln.steps.map(s => s.raw);
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
    setTimeout(() => {
      pending = false;
      if (S.state === 'replay') { show(RP.data); TL.toast('回放是已经打完的一局，不能改；点「回到编排」改脚本。'); return; }
      const text = lanesToText(); if (text === S.text) return;
      if (S.state === 'live') sendLive(text); else setText(text, true);
    }, 0);
  });
  function setText(text, keepUndo) {
    if (keepUndo) { S.undo.push(S.text); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
    S.text = text; S.busy = true;
    try { recompute(); } finally { S.busy = false; }
    checkSoon();
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
  function switchTo(text, msg) { // undo / redo: in a game the version goes to the game too
    if (S.state === 'live') { sendLive(text, msg); return true; }
    S.text = text; S.busy = true; try { recompute(); } finally { S.busy = false; } reparse(); TL.toast(msg); return true;
  }
  function undo() { if (S.state === 'replay') return; if (!S.undo.length) { TL.toast('没有可以撤销的了'); return; } const was = S.text, to = S.undo.pop(); S.redo.push(was); if (S.state !== 'live') switchTo(to, `撤销了上一个改动${S.undo.length ? `（还能撤销 ${S.undo.length} 次）` : ''}`); else sendLive(to, '撤销了上一个改动，已发给游戏', true); }
  function redo() { if (S.state === 'replay') return; if (!S.redo.length) { TL.toast('没有可以重做的了'); return; } const was = S.text, to = S.redo.pop(); S.undo.push(was); if (S.state !== 'live') switchTo(to, '重做了一个改动'); else sendLive(to, '重做了一个改动，已发给游戏', true); }
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

  /* ---------- states and the top bar ---------- */
  const STATE = {
    plan: {name: '编排', sub: () => `${START_NAMES[S.start]} · 时间按预算估算 · 改了马上重算`},
    live: {name: '实战', sub: () => LV.waiting ? (LV.waitLeft != null ? `等你打开魔兽争霸三 · 还剩 ${LV.waitLeft} 秒` : LV.found ? '已接入魔兽，等你开始一局' : '等你打开魔兽争霸三') : `${START_NAMES[S.start]} · ${LV.backend === 'fake' ? '假游戏' : '魔兽争霸三'} · ${$('tactic').getAttribute('aria-checked') === 'true' ? '指挥官在执行脚本' : '战术已关，只看不下令'}`},
    replay: {name: '回放', sub: () => RP ? `${(RP.meta.name || RP.id)}` : ''},
  };
  function setState(s) {
    S.state = s; document.body.dataset.state = s;
    document.querySelectorAll('[data-in]').forEach(el => { el.hidden = !el.dataset.in.split(' ').includes(s); });
    if (s !== 'live') { $('proj').hidden = true; $('liveBox').hidden = true; $('backNow').hidden = true; }
    syncTop();
  }
  function syncTop() {
    const dirty = S.text !== S.saved;
    $('saveBtn').querySelector('.dirty').hidden = !dirty; $('saveBtn').title = dirty ? '有改动还没保存（Ctrl+S）' : '已保存';
    $('undoBtn').disabled = !S.undo.length || S.state === 'replay'; $('redoBtn').disabled = !S.redo.length || S.state === 'replay';
    $('undoBtn').title = S.undo.length ? `撤销（还能撤销 ${S.undo.length} 次，Ctrl+Z）` : '没有可以撤销的';
    $('redoBtn').title = S.redo.length ? `重做（${S.redo.length} 次，Ctrl+Shift+Z）` : '没有可以重做的';
    $('stName').textContent = STATE[S.state].name; $('stSub').textContent = STATE[S.state].sub();
    $('startSel').value = String(S.start);
  }
  $('startSel').innerHTML = START_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  $('startSel').onchange = async () => { S.start = +$('startSel').value; await layoutOf(S.start); recompute(); TL.toast(`换到${START_NAMES[S.start]}：同一份脚本，工地用${START_NAMES[S.start]}的布局。`); };
  function loop() {
    requestAnimationFrame(loop);
    if (S.state === 'live') liveFrame();
    else { $('clock').textContent = fmt(TL.t); $('orderBtn').textContent = `在 ${fmt(TL.t)} 下令`; }
    if (S.bottom === 'cards') renderCards();
  }

  /* ---------- 实战 ---------- */
  $('connect').onclick = connect;
  $('disconnect').onclick = () => disconnect(true);
  $('backNow').onclick = () => { LV.hold = 0; };
  $('tactic').onclick = () => {
    const on = $('tactic').getAttribute('aria-checked') !== 'true'; $('tactic').setAttribute('aria-checked', on); syncTop();
    api('POST', '/api/control', {action: 'tactic', on}).catch(() => TL.toast('开关没送到本地服务'));
    TL.toast(on ? '战术执行：开。指挥官按脚本下命令。' : '战术执行：关。指挥官只看不下令，你自己操作；时间轴照样跟着游戏走。');
  };
  /* 连接设置: how the game starts (wc3env launches Warcraft, or the commander takes over one the
     player opens), its speed, whether Warcraft draws its window; remembered in this browser */
  const CF_KEY = 'wc3c.connect';
  function cfLoad() { try { return JSON.parse(localStorage.getItem(CF_KEY) || '{}') || {}; } catch (_) { return {}; } }
  function cfSave(o) { try { localStorage.setItem(CF_KEY, JSON.stringify(o)); } catch (_) { /* private window */ } }
  let CF = null; // {h, mode, speed}: the dialog open
  function cfSync() {
    const fake = CF.h.backend === 'fake', attach = !fake && $('cfAttach').checked;
    $('cfModeRow').hidden = fake;
    document.querySelectorAll('[data-cf]').forEach(el => {
      const k = el.dataset.cf; el.hidden = k === 'attach' ? !attach : k === 'launch' ? attach : attach || fake;
    });
    $('cfStart').disabled = attach; $('cfStartNote').textContent = attach ? '接管时由你开的那局决定' : '';
    $('cfSaveNote').hidden = !(attach && S.text !== S.saved);
    $('cfGo').textContent = attach ? '开始等待' : fake ? '开一局假游戏' : '启动魔兽';
  }
  async function connect() {
    let h; try { h = await api('GET', '/api/health'); } catch (_) { TL.toast('连不上本地服务'); return; }
    if (h.running || h.waiting) { join(h, null); return; } // a game, or a wait, already going: just follow it
    const o = cfLoad();
    CF = {h, speed: o.speed || (h.backend === 'fake' ? 16 : (h.speed > 1 ? h.speed : 1))};
    $('cfStart').innerHTML = START_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join(''); $('cfStart').value = S.start;
    $((o.mode || (h.launch ? 'launch' : 'attach')) === 'attach' ? 'cfAttach' : 'cfLaunch').checked = true;
    $('cfRender').checked = o.render != null ? o.render : h.render !== false;
    $('cfWait').value = o.attachWait || 60;
    document.querySelectorAll('#cfSpeed [data-v]').forEach(b => b.classList.toggle('on', +b.dataset.v === CF.speed));
    cfSync(); $('connDlg').hidden = false; $('cfGo').focus();
  }
  $('cfLaunch').onchange = $('cfAttach').onchange = () => cfSync();
  $('cfSpeed').onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; CF.speed = +b.dataset.v; document.querySelectorAll('#cfSpeed [data-v]').forEach(x => x.classList.toggle('on', x === b)); };
  $('cfCancel').onclick = () => { $('connDlg').hidden = true; CF = null; };
  $('cfGo').onclick = async () => {
    const h = CF.h, fake = h.backend === 'fake', mode = !fake && $('cfAttach').checked ? 'attach' : 'launch';
    const opts = {mode, speed: CF.speed, render: $('cfRender').checked, slot: +$('cfStart').value,
      attachWait: Math.max(10, Math.min(600, +$('cfWait').value || 60))};
    cfSave({mode, speed: opts.speed, render: opts.render, attachWait: opts.attachWait});
    $('connDlg').hidden = true; CF = null;
    if (opts.slot !== S.start && mode === 'launch') { S.start = opts.slot; $('startSel').value = S.start; await layoutOf(S.start); }
    if (mode === 'launch') { // this console starts the game with its script and this start's layout
      let plan = {}; try { const j = await api('GET', '/api/strategies/' + encodeURIComponent('人族速矿二本 · ' + START_NAMES[S.start])); if (j.ok) plan = j.plan; } catch (_) { /* no layout */ }
      try { await api('POST', '/api/plan', {...plan, start: S.start, script: S.text, name: '人族速矿二本 · ' + START_NAMES[S.start]}); } catch (_) { TL.toast('连不上本地服务'); return; }
    }
    join(h, opts);
  };
  function join(h, opts) { // follow the game: opts given = start one first
    LV.backend = h.backend;
    LV.hist = null; LV.state = null; LV.adopted = false; LV.hold = 0; LV.lastProj = 0; LV.rates = null; LV.waitLeft = null;
    LV.waiting = !!(opts && opts.mode === 'attach') || (!opts && h.waiting && !h.running); // the stream repeats the last game's state until then
    LV.es = new EventSource('/api/stream');
    LV.es.onmessage = m => { const msg = JSON.parse(m.data); if (msg.type === 'state') onState(msg.state); else if (msg.type === 'log') TL.toast(msg.text); };
    LV.es.onerror = () => TL.toast('与本地服务的连接中断，正在重试…');
    $('tactic').setAttribute('aria-checked', h.running ? String(h.tactic !== false) : 'true');
    setState('live'); TL.stop();
    if (opts) api('POST', '/api/control', {action: 'start', start: S.start, opts}).then(() => { if (opts.mode === 'attach') watchWait(); });
    else if (h.waiting) watchWait();
    const sp = opts && opts.speed > 1 ? `（${opts.speed} 倍速${opts.render === false && h.backend !== 'fake' ? '，不画游戏窗口' : ''}）` : '';
    TL.toast(h.running ? '已加入正在进行的游戏：红线是现在，之前是真实发生的，之后按实测速度推算。'
      : opts && opts.mode === 'attach' ? `正在等你在 PC 上打开魔兽（最多 ${opts.attachWait} 秒）：开一局失落神庙，指挥官会自动接管。`
      : h.waiting ? '正在等你开游戏…' : '正在开一局' + (h.backend === 'fake' ? '假游戏' : '魔兽') + sp + '…');
  }
  async function watchWait() { // taking over: count down until Warcraft shows up, or give up
    while (S.state === 'live' && LV.es) {
      let h; try { h = await api('GET', '/api/health'); } catch (_) { h = null; }
      if (h && h.running) { LV.waiting = false; /* taking over keeps 'waiting' on for the whole session */ LV.waitLeft = null; syncTop(); return; } // found it: the game's frames take over
      if (h && !h.waiting && !h.running) { LV.waiting = false; LV.waitLeft = null; disconnect(false); TL.toast('没等到魔兽争霸三：打开游戏后再点「连接游戏」。'); return; }
      LV.waitLeft = h ? h.waitLeft : null; LV.found = !!(h && h.waiting && h.waitLeft == null); syncTop();
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  function disconnect(stop) {
    if (LV.es) LV.es.close(); LV.es = null; LV.state = null;
    if (stop) api('POST', '/api/control', {action: 'stop'}).catch(() => {});
    setState('plan'); recompute(); TL.toast('已断开，回到编排。');
  }
  function onState(s) {
    if (LV.waiting) return;
    if (LV.state && s.t < LV.state.t - 1) { LV.hist = null; LV.adopted = false; } // a new game
    LV.state = s;
    if (s.start != null && s.start !== S.start) { S.start = s.start; layoutOf(S.start).then(() => { LV.lastProj = 0; }); TL.toast('游戏分配的出生点是' + START_NAMES[s.start]); }
    if (s.script && !LV.adopted) { LV.adopted = true; adopt(); }
    record(s);
  }
  async function adopt() { // the console edits the script the game plays (the game may have picked the file itself)
    let j; try { j = await api('GET', '/api/script/live'); } catch (_) { return; }
    if (!j || !j.ok) return;
    S.model = j.model;
    if (j.text !== S.text) { S.undo.push(S.text); S.text = j.text; LV.lastProj = 0; TL.toast('控制台换成了游戏正在执行的战术脚本（原来的可以「撤销」找回）。'); }
  }
  function record(s) {
    if (!s.script) return;
    const h = LV.hist = LV.hist || {frames: [], samples: []};
    if (h.frames.length && s.t < h.frames[h.frames.length - 1].t + 1) return;
    h.frames.push({t: s.t, gold: s.gold, wood: s.wood, foodUsed: s.foodUsed, foodCap: s.foodCap, got: s.got || [0, 0],
      units: s.units.map(u => ({id: u.id, type: u.type, x: u.x, y: u.y, hidden: u.hidden, role: u.role === 'gold' || u.role === 'wood' ? u.role : u.type === 'hpea' && u.task === '空闲' ? 'idle' : 'build'})),
      buildings: s.buildings.map(b => ({id: b.id, type: b.type, x: b.x, y: b.y, done: b.done, progress: b.progress}))});
    if (!s.got) return;
    const nat = Budget.NATURALS[S.start], near = u => Math.hypot(u.x - nat[0], u.y - nat[1]) < 1500, home = DATA.starts[S.start];
    const ps = s.units.filter(u => u.type === 'hpea');
    h.samples.push({t: s.t, got: s.got, miners: ps.filter(u => u.role === 'gold' && !near(u)).length, natMiners: ps.filter(u => u.role === 'gold' && near(u)).length,
      jacks: ps.filter(u => u.role === 'wood').length,
      natHall: s.buildings.some(b => ['htow', 'hkee', 'hcas'].includes(b.type) && b.done && Math.hypot(b.x - home.x, b.y - home.y) > 2000)});
    if (h.samples.length > 400) h.samples.shift();
    LV.rates = Budget.ratesFrom(h.samples) || LV.rates;
  }
  /* the game so far and the rest from now: what the timeline and the sandbox show while connected */
  function project(force) {
    const s = LV.state, h = LV.hist; if (!s || !h || !h.frames.length) return;
    if (!force && performance.now() - LV.lastProj < 2000) return;
    LV.lastProj = performance.now();
    let j, ideal;
    try { j = budget(S.text, S.start, {live: s, rates: LV.rates, end: Math.max(600, Math.ceil(s.t) + 300)}); ideal = budget(S.text, S.start); } catch (e) { return; }
    const F = perSecond(h.frames.filter(f => f.t < j.now).concat(j.frames));
    const nowSec = Math.ceil(s.t); if (F[nowSec] && j.frames[0]) F[nowSec] = {...j.frames[0], t: nowSec}; // the red line: the game as it is
    const D = toData(j.timeline, F);
    D.baseline = new Map(); for (const L of ideal.timeline.lanes) L.steps.forEach((x, k) => { if (x.start != null) D.baseline.set(L.label + '|' + k + '|' + x.raw, {start: x.start, done: x.done}); });
    S.busy = true; try { show(D); } finally { S.busy = false; }
    liveBox();
  }
  function liveFrame() {
    const s = LV.state;
    if (!s) { $('clock').textContent = '…'; return; }
    project(false);
    const now = s.t, held = performance.now() < LV.hold;
    if (!held) TL.t = now;
    $('clock').textContent = fmt(now); $('backNow').hidden = !held;
    $('orderBtn').textContent = held && TL.t > now + 1 ? `在 ${fmt(TL.t)} 下令` : '现在下令';
    const pj = $('proj'); pj.hidden = false; pj.style.left = TL.xOf(now) + 'px'; pj.style.width = Math.max(0, TL.xOf(TL.END) - TL.xOf(now)) + 'px';
    pj.style.top = TL.rowsTop() + 'px'; pj.style.height = TL.rowsH() + 'px';
    $('stSub').textContent = STATE.live.sub() + (LV.rates ? ` · 实测：每人每秒金 ${(LV.rates.gold || Budget.RATES.gold).toFixed(2)} 木 ${(LV.rates.wood || Budget.RATES.wood).toFixed(2)}` : '');
  }
  const userMoved = () => { if (S.state === 'live') LV.hold = performance.now() + 10000; };
  ['nowline', 'ruler', 'res', 'foodStrip', 'scrub', 'scrubMarks'].forEach(id => $(id).addEventListener('pointerdown', userMoved));
  document.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') userMoved(); });
  function liveBox() {
    const s = LV.state; if (!s) return;
    const steps = TL.lanes.flatMap(L => L.steps.map(st => ({L, s: st}))).filter(x => x.s.start != null && x.s.orig && x.s.orig.start != null);
    const d = x => Math.round(x.s.start - x.s.orig.start);
    const word = v => (Math.abs(v) < 3 ? ['', '和计划一样'] : v > 0 ? ['late', `慢 ${v} 秒`] : ['early', `快 ${-v} 秒`]);
    const past = steps.filter(x => x.s.start <= s.t).sort((a, b) => b.s.start - a.s.start).slice(0, 6), next = steps.filter(x => x.s.start > s.t && /^(建造|升级)/.test(x.s.body)).sort((a, b) => a.s.start - b.s.start).slice(0, 4);
    const avg = past.length ? Math.round(past.reduce((a, x) => a + d(x), 0) / past.length) : 0, [c, w] = word(avg);
    $('liveBox').hidden = false;
    $('liveBox').innerHTML = `<h2>实战 · 和理想计划比</h2><p class="lv">最近开始的 ${past.length} 步：<b class="${c}">${w}</b></p>` +
      next.map(x => { const [c2, w2] = word(d(x)); return `<div class="it"><b>${esc(x.L.label)}</b>${esc(x.s.body)}<span class="${c2}">预计 ${fmt(x.s.start)} · ${w2}</span></div>`; }).join('') +
      '<p class="tiny">红线之前是游戏里的真实时间；之后按实测采集速度推算，每两秒更新。理想计划 = 同一份脚本从 0:00 的预算。</p>';
  }
  /* an edit while connected: the game takes the script at once, or refuses it (a step it has begun) */
  async function sendLive(text, msg, isVersion) {
    if (LV.sending) return; LV.sending = true;
    let j; try { j = await api('POST', '/api/script/live', {text}); } catch (_) { j = {ok: false, errors: ['连不上本地服务']}; }
    LV.sending = false;
    if (!j.ok) {
      if (isVersion) { /* undo/redo refused: put the stacks back */ if (msg && msg.startsWith('撤销')) S.undo.push(S.redo.pop()); else S.redo.push(S.undo.pop()); }
      LV.lastProj = 0; project(true); TL.toast('没发给游戏（已撤回）：' + (j.errors || []).join('；'));
      return;
    }
    if (!isVersion) { S.undo.push(S.text); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
    S.text = text; LV.lastProj = 0; project(true); checkSoon();
    TL.toast((msg || '改动') + '已发给游戏，马上生效（脚本文件还没改，点「保存」才写进去）。');
  }

  /* ---------- 回放 ---------- */
  async function openRuns() {
    let j; try { j = await api('GET', '/api/runs'); } catch (_) { TL.toast('读不到录下的对局'); return; }
    const runs = (j.runs || []).filter(r => r.hasState);
    $('runList').innerHTML = runs.length ? runs.map(r => `<button type="button" class="run" data-run="${esc(r.id)}"><b>${esc((r.began || r.id).replace('T', ' ').slice(5, 16))}</b> ${esc(r.name || '')}${r.speed > 1 ? ' · ' + r.speed + '×' : ''}${r.feedback ? ' · ' + r.feedback + ' 条意见' : ''}</button>`).join('') : '<p class="note">还没有录下的对局（连上游戏打一局就有了）。</p>';
    $('runDlg').hidden = false;
  }
  $('runList').onclick = e => { const b = e.target.closest('[data-run]'); if (b) { $('runDlg').hidden = true; openRun(b.dataset.run); } };
  $('runClose').onclick = () => { $('runDlg').hidden = true; };
  async function openRun(id) {
    let j; try { j = await api('GET', '/api/runs/' + encodeURIComponent(id)); } catch (_) { TL.toast('读不到这一局'); return; }
    if (!j.ok || !j.frames || !j.frames.length) { TL.toast('这一局没有可以回放的记录' + (j.error ? '：' + j.error : '')); return; }
    const st = j.state || {};
    if (!st.script || !(st.script.lanes || []).length) { TL.toast('这一局不是按战术脚本打的，请用「更多 → 旧控制台」回放'); return; }
    if (st.start != null) { S.start = st.start; await layoutOf(S.start); }
    // each step's real times: began (the decision record), work / done / site (the game's events)
    const act = Budget.actualOf(st), hall = DATA.starts[S.start];
    const lanes = st.script.lanes.map(L => ({label: L.label, kind: L.kind, line: L.line, dead: L.dead, steps: L.steps.map((raw, k) => {
      const a = (act[L.label] || [])[k] || {}, next = ((act[L.label] || []).slice(k + 1).find(x => x && x.start != null) || {}).start;
      return {raw, start: a.start ?? null, work: a.work ?? null, done: a.done ?? null, end: next ?? a.done ?? null, at: a.at || null};
    })}));
    const T = {lanes, places: st.script.positions || {}, hall: [hall.x, hall.y], mine: mineOf([hall.x, hall.y]), natural: Budget.NATURALS[S.start], units: {}};
    RP = {id, meta: j.meta || {}, data: toData(T, perSecond(j.frames))};
    setState('replay'); TL.stop(); TL.t = 0;
    S.busy = true; try { show(RP.data); } finally { S.busy = false; }
    TL.toast(`回放：${RP.meta.name || id}。拖时间条或点「播放」看过程；回放不能改，点「回到编排」改脚本。`);
  }
  $('backPlan').onclick = () => { RP = null; setState('plan'); recompute(); TL.toast('回到编排'); };

  /* ---------- menus ---------- */
  const MENUS = [['moreBtn', 'moreMenu'], ['showBtn', 'showMenu'], ['helpBtn', 'helpMenu']];
  function closeMenus(except) { for (const [b, m] of MENUS) if (m !== except) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); } }
  for (const [b, m] of MENUS) $(b).onclick = e => { e.stopPropagation(); const open = $(m).hidden; closeMenus(m); $(m).hidden = !open; $(b).setAttribute('aria-expanded', open); };
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenus(); $('textDlg').hidden = true; $('runDlg').hidden = true; $('connDlg').hidden = true; } });
  $('moreMenu').onclick = e => {
    const b = e.target.closest('[data-m]'); if (!b) return; closeMenus();
    const m = b.dataset.m;
    if (m === 'text') { $('textArea').value = S.text; $('textErr').textContent = ''; $('textDlg').hidden = false; $('textArea').focus(); return; }
    if (m === 'old') { location.href = 'old.html'; return; }
    if (m === 'replay') { if (S.state === 'live') { TL.toast('连着游戏时不能回放，先点「断开」'); return; } openRuns(); return; }
    if (m === 'revert') { if (S.text === S.saved) { TL.toast('没有没保存的改动'); return; } if (S.state === 'live') sendLive(S.saved, '回到上次保存的脚本：'); else { setText(S.saved, true); TL.toast('回到了上次保存的脚本（可以撤销）'); } return; }
    TL.toast({saveas: '另存为：现在只有一份战术脚本，之后再接。', load: '载入：现在只有一份战术脚本，之后再接。',
      full: '完整跑一遍（假游戏）：之后再接；现在可以「连接游戏」直接跑假游戏看。'}[m] || '');
  };
  /* the script as text: for big changes, copy and paste */
  $('textApply').onclick = async () => {
    const text = $('textArea').value;
    let j; try { j = await api('PUT', '/api/script', {text, dryRun: true}); } catch (_) { $('textErr').textContent = '连不上本地服务'; return; }
    if (j.errors && j.errors.length) { $('textErr').textContent = '有错：' + j.errors.slice(0, 3).join('；'); return; }
    $('textDlg').hidden = true; S.model = j.model;
    if (S.state === 'live') sendLive(text, '按文本改的脚本'); else { setText(text, true); TL.toast('脚本按文本更新了（未保存；可以撤销）'); }
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
    const key = Math.floor(TL.t) + '|' + S.text.length + '|' + S.undo.length + '|' + S.state;
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
      html += `<div class="cv-row"><div class="cv-lab">${esc(label)}${g.lanes.length > 1 ? `<small>${g.lanes.length} 人一起</small>` : ''}${L0.muted ? '<small>暂停执行</small>' : ''}${L0.dead ? '<small>阵亡</small>' : ''}</div><div class="cv-steps">${cards}</div></div>`;
    }
    $('cvRows').innerHTML = html;
  }
  $('cvRows').onclick = e => { const c = e.target.closest('.cv-card'); if (!c) return; if (c.dataset.t === '') { TL.toast('这一步不会开始：它的条件一直没满足。'); return; } if (S.state === 'live') userMoved(); TL.t = +c.dataset.t; renderCards(true); };

  /* ---------- start ---------- */
  window.CONSOLE = {lanesToText, get text() { return S.text; }, get errors() { return S.errors; }, get state() { return S.state; }}; // for checks from the browser
  (async function init() {
    setState('plan');
    if (location.protocol === 'file:') { $('errs').hidden = false; $('errs').innerHTML = '<b>这个页面要从本地服务打开</b>：运行 <code>python -m commander_bridge</code> 后打开 http://127.0.0.1:8790/'; return; }
    let j; try { j = await api('GET', '/api/script'); } catch (_) { $('errs').hidden = false; $('errs').innerHTML = '<b>连不上本地服务</b>：战术脚本读不到。'; return; }
    S.text = S.saved = j.text; S.model = j.model;
    await layoutOf(S.start);
    recompute(); showErrors(j.errors || []);
    requestAnimationFrame(loop);
    let h = {}; try { h = await api('GET', '/api/health'); } catch (_) { /* offline */ }
    LV.backend = h.backend || '';
    $('connect').textContent = h.backend === 'fake' ? '连接假游戏' : '连接游戏';
    if (h.running) { TL.toast('有一局游戏正在进行：点「连接游戏」加入，时间轴会跟着游戏走。'); return; }
    TL.toast('编排：时间轴和沙盘都是这份战术脚本的预算。选中单位后右键下令、Shift+右键接在最后；改了马上重算，Ctrl+Z 撤销，Ctrl+S 保存。');
  })();
})();
