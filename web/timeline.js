/* The unified timeline (时间轴编排): the tactic script's preview laid out as one lane per peasant,
 * building and hero, a bar per step at the moment it began, a red line that is the moment the
 * sandbox shows. Drag the line to go back and forth; the map (app.js) follows. Bars can be dragged
 * (earliest start, or to another lane), clicked (edit) or deleted; the map's orders land here too.
 * Every change goes into the script (script-editor.js) and the preview goes on from the save point
 * before it (POST /api/script/preview with `from`).
 *
 * Data: the preview's timeline (lanes with start / work / done per step) and its frames (one a
 * second: resources, units, buildings). Nothing here is a second model of the game. */
(function () {
  'use strict';
  const ACTC = {采金: 'gold', 伐木: 'wood', 建造: 'build', 协助: 'assist', 敲钟: 'bell', 集合: 'bell', 清野: 'fight', 待命: 'wait', 移动: 'wait', 学: 'learn', 集结点: 'rally', 升级: 'upgrade', 攻击移动: 'fight', 跟随大法师: 'fight'};
  const COST_W = {农场: [80, 20], 兵营: [160, 60], 国王祭坛: [180, 50], 伐木场: [120, 0], 城镇大厅: [385, 205], 侦察塔: [30, 20], 神秘藏宝室: [130, 30], 神秘圣所: [150, 140], 铁匠铺: [140, 60]};
  const ROW = 34, esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const fmt = t => (t < 0 ? '-' : '') + Math.floor(Math.abs(t) / 60) + ':' + String(Math.floor(Math.abs(t) % 60)).padStart(2, '0');
  const parseT = s => { const m = /^(\d+):(\d{1,2})$/.exec(String(s).trim()); return m ? +m[1] * 60 + +m[2] : null; };
  const store = {get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private */ } }};
  function split(raw) {
    let s = raw.trim(), cond = '';
    if (s.startsWith('[')) { const i = s.indexOf(']'); cond = s.slice(1, i).trim(); s = s.slice(i + 1).trim(); }
    const tag = (s.match(/\s#(\S+)$/) || [])[1] || '', pos = (s.match(/@(\S+)/) || [])[1] || '';
    const body = s.replace(/\s#\S+$/, '').replace(/@\S+/, '').replace(/\s+/g, ' ').trim(), w = body.split(' ')[0];
    return {cond, body, pos, tag, cls: ACTC[w] || 'train'};
  }
  const condTerms = c => (c || '').split(/\s*且\s*/).map(x => x.trim()).filter(Boolean);
  const ongoing = s => /^(采金|伐木|待命|集合|跟随)/.test(s.body);

  let api = null, root = null, D = null, END = 600, lanes = [], rows = [], E = [], mined = [[0, 0]];
  let zoom = Math.max(1, Math.min(8, +store.get('wcc.utZoom') || 1)), byPrio = false, view = 'unit', filters = new Set(), critOn = false, goalKey = 'keep', pinPicked = true;
  let stale = null, prevStarts = new Map(), sel = null, dimOthers = false;
  const pick = new Set();
  const $ = id => document.getElementById('ut-' + id);
  const stepEnd = s => s.done != null ? s.done : s.end != null ? s.end : (ongoing(s) ? END : null);
  const LABEL = () => 200, pps = () => Math.max(0.6, ((($('scroll') || {}).clientWidth || 900) - LABEL() - 8) / END) * zoom, X = sec => LABEL() + sec * pps();

  /* ---------- data from a preview ---------- */
  function setData(j) {
    const T = j.timeline, F = j.frames || [];
    if (!T) return;
    // what moved since the last preview: kept for the before/after badges
    if (D) for (const L of lanes) L.steps.forEach((s, k) => { if (s.start != null) prevStarts.set(L.label + '|' + k + '|' + s.raw, s.start); });
    END = Math.max(60, Math.ceil(F.length ? F[F.length - 1].t : j.t || 600));
    const lineRank = [...new Set(T.lanes.map(l => l.line))].sort((a, b) => a - b);
    lanes = T.lanes.map((L, i) => ({...L, id: 'L' + i, prio: lineRank.indexOf(L.line) + 1, steps: L.steps.map((s, k) => {
      const x = {...s, ...split(s.raw)}, before = prevStarts.get(L.label + '|' + k + '|' + s.raw);
      x.delta = before != null && x.start != null ? Math.round(x.start - before) : 0;
      return x;
    })}));
    const natural = T.natural, pos = {}, types = {...T.units};
    E = F.map(f => {
      const r = {main: 0, nat: 0, wood: 0, build: 0, mil: 0, idle: 0};
      for (const u of f.units) {
        (pos[u.id] = pos[u.id] || []).push([f.t, u.x, u.y]); types[u.id] = types[u.id] || u.type;
        if (u.type === 'hmil') r.mil++;
        else if (u.type === 'hpea') {
          if (u.role === 'gold') (natural && Math.hypot(u.x - natural[0], u.y - natural[1]) < 1500 ? r.nat++ : r.main++);
          else if (u.role === 'wood') r.wood++; else if (u.role === 'idle') r.idle++; else r.build++;
        }
      }
      const got = f.got || [0, 0];
      return [f.t, f.gold, f.wood, f.foodUsed, f.foodCap, got[0], got[1], r.main, r.nat, r.wood, r.build, r.mil, r.idle];
    });
    mined = [[0, 0]];
    for (let i = 1; i < E.length; i++) { const d = Math.max(0, E[i][5] - E[i - 1][5]), m = E[i][7], n = E[i][8], k = m + n || 1; mined.push([mined[i - 1][0] + d * m / k, mined[i - 1][1] + d * n / k]); }
    D = {places: T.places || {}, units: types, pos, hall: T.hall, mine: T.mine, natural, mineGold: T.mineGold || 12500};
    stale = null;
    computeBnecks(); buildRows(); if (critOn) updateChain();
  }
  const at = T => Math.max(0, Math.min(E.length - 1, Math.round(T)));
  function posAt(cid, T) {
    const tr = D && D.pos[cid]; if (!tr || tr[0][0] > T + 0.5) return null;
    let a = tr[0], b = null; for (const q of tr) { if (q[0] > T) { b = q; break; } a = q; }
    if (!b) return a[0] < T - 3 ? null : [a[1], a[2]];
    const k = (T - a[0]) / Math.max(0.001, b[0] - a[0]); return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }
  const typeOf = cid => (D && D.units[cid]) || (cid < 100 ? 'hpea' : 'hfoo');
  const HERO_T = {大法师: 'Hamg', 山丘之王: 'Hmkg'};
  const cidOfLane = L => L.kind === 'peasant' ? +L.label.slice(2) : L.kind === 'hero' && D ? +Object.keys(D.units).find(c => D.units[c] === HERO_T[L.label]) : null;
  const laneOfCid = cid => lanes.find(L => cidOfLane(L) === cid) || (typeOf(cid) === 'hfoo' ? lanes.find(L => L.kind === 'army') : null);

  function current(items, T) {
    let cur = null, next = null;
    for (const it of items) {
      const s = it.step; if (s.start == null) continue;
      const e = stepEnd(s);
      if (s.start <= T && (e == null || T < e)) cur = it;
      else if (s.start > T && (!next || s.start < next.step.start)) next = it;
    }
    return {cur, next};
  }
  function activity(L, T) {
    if (!L) return '空闲';
    const {cur} = current(L.steps.map(step => ({step})), T); if (!cur) return '空闲';
    const b = cur.step.body;
    if (/^采金/.test(b)) return b.includes('分矿') ? '采金·分矿' : '采金·主矿';
    if (/^伐木/.test(b)) return '伐木';
    if (/^(建造|协助)/.test(b)) return '建造';
    if (/^(敲钟|集合|清野)/.test(b)) return '民兵/清野';
    return b.split(' ')[0];
  }

  /* ---------- bottlenecks ---------- */
  let bnecks = [];
  function computeBnecks() {
    bnecks = [];
    let a = null;
    for (let i = 0; i <= E.length; i++) { const full = i < E.length && E[i][3] >= E[i][4]; if (full && a == null) a = i; if (!full && a != null) { if (i - a >= 2) bnecks.push({s: E[a][0], e: E[Math.min(i, E.length - 1)][0], type: 'food', text: `卡人口 ${i - a}s（${E[a][3]}/${E[a][4]}）`}); a = null; } }
    a = null;
    for (let i = 3; i <= E.length; i++) { const idle = i < E.length && E[i][12] > 0; if (idle && a == null) a = i; if (!idle && a != null) { if (i - a >= 3) bnecks.push({s: E[a][0], e: E[Math.min(i, E.length - 1)][0], type: 'idle', text: `农民空闲 ${i - a}s`}); a = null; } }
    const hall = lanes.find(L => L.kind === 'building' && L.label === '城镇大厅');
    if (hall) for (let k = 1; k < hall.steps.length; k++) {
      const p = hall.steps[k - 1], q = hall.steps[k], s = p.done ?? p.end, e = q.work ?? q.start;
      if (s != null && e != null && e - s > 1.5) { const r = E[at(s + 0.5)] || E[0]; bnecks.push({s, e, type: 'hall', text: `城镇大厅空闲 ${Math.round(e - s)}s（${r[3] >= r[4] ? '卡人口' : r[1] < 75 ? '等钱' : q.cond ? '等条件 ' + q.cond : '没排上'}）`}); }
    }
  }
  const lossSum = type => Math.round(bnecks.filter(b => b.type === type).reduce((x, b) => x + (b.e - b.s), 0));

  /* ---------- critical path ---------- */
  function findTag(tag) { for (const L of lanes) for (const [k, s] of L.steps.entries()) if (s.tag === tag) return {L, k}; return null; }
  function findBody(label, re) { const L = lanes.find(x => x.label === label); if (!L) return null; const k = L.steps.findIndex(s => re.test(s.body)); return k < 0 ? null : {L, k}; }
  function trainOf(n) { for (const L of lanes) if (L.kind === 'building') { const k = L.steps.findIndex(s => s.body === '农民' + n); if (k >= 0) return {L, k}; } return null; }
  const GOALS = {
    keep: ['二本（主城）完成', () => { const n = findBody('城镇大厅', /^升级 主城/); return n && {...n, field: 'done'}; }],
    nat: ['分基地开工', () => { const n = findTag('分基地'); return n && {...n, field: 'work'}; }],
    am: ['大法师出生', () => { const n = findBody('国王祭坛', /^大法师/); return n && {...n, field: 'done'}; }],
    mk: ['山丘之王出生', () => { const n = findBody('国王祭坛', /^山丘之王/); return n && {...n, field: 'done'}; }],
    caster: ['第一个法师开始训练', () => { const L = lanes.find(x => x.label === '神秘圣地'); return L && L.steps.length ? {L, k: 0, field: 'work'} : null; }],
  };
  const timeOf = (n, f) => { const s = n.L.steps[n.k]; return f === 'done' ? (s.done ?? stepEnd(s)) : f === 'work' ? (s.work ?? s.start) : s.start; };
  function deps(L, k) {
    const s = L.steps[k], out = [];
    if (k > 0) { const p = L.steps[k - 1]; if (!ongoing(p) && p.start != null) out.push({t: stepEnd(p), node: {L, k: k - 1}, field: 'done', why: '上一步做完'}); }
    else if (L.kind === 'peasant') { const tr = trainOf(+L.label.slice(2)); if (tr) out.push({t: timeOf(tr, 'done'), node: tr, field: 'done', why: L.label + ' 出生'}); }
    for (const c of condTerms(s.cond)) {
      let m;
      if ((m = /^#(\S+)\s*(开工|完成)$/.exec(c))) { const n = findTag(m[1]); if (n) { const f = m[2] === '开工' ? 'work' : 'done'; out.push({t: timeOf(n, f), node: n, field: f, why: `等 #${m[1]} ${m[2]}`}); } }
      else if ((m = /^(大法师|山丘之王)\s*出生$/.exec(c))) { const n = findBody('国王祭坛', new RegExp('^' + m[1])); if (n) out.push({t: timeOf(n, 'done'), node: n, field: 'done', why: `等${m[1]}出生`}); }
      else if (/^清野\s*完成$/.test(c)) { const n = findBody('大法师', /^清野/); if (n) out.push({t: timeOf(n, 'done'), node: n, field: 'done', why: '等清野完成'}); }
      else if (/^大法师剩余/.test(c)) { const n = findBody('国王祭坛', /^大法师/); if (n) out.push({t: timeOf(n, 'work'), node: n, field: 'work', why: '按大法师出生倒推敲钟'}); }
      else if (/^\d+:\d{2}$/.test(c)) out.push({t: parseT(c), node: null, why: '到 ' + c});
    }
    return out.filter(d => d.t != null);
  }
  function econWhy(T) { const r = E[at(T + 1)] || E[0]; return r[3] >= r[4] ? '卡人口' : r[1] < 150 ? '金不够' : r[2] < 100 ? '木不够' : '钱或条件'; }
  let chain = [];
  function chainTo(goal) {
    if (!goal) return [];
    const out = []; let cur = goal, field = goal.field;
    for (let guard = 0; guard < 40 && cur; guard++) {
      const s = cur.L.steps[cur.k]; if (s.start == null) break;
      const ds = deps(cur.L, cur.k), node = {L: cur.L, k: cur.k, s, field, t: timeOf(cur, field)};
      if (s.work != null) node.inside = s.work - s.start;
      out.push(node);
      if (!ds.length) { node.why = s.start <= 1 ? '开局就开始' : '条件一满足就开始'; break; }
      const best = ds.reduce((x, y) => (y.t > x.t ? y : x)), gap = s.start - best.t;
      node.why = esc(best.why) + (gap > 2 ? `，之后又等了 <b>${Math.round(gap)}s</b>（${econWhy(best.t)}）` : '');
      cur = best.node; field = best.field;
    }
    return out.reverse();
  }
  const onChain = (L, k) => chain.some(n => n.L === L && n.k === k);
  function updateChain() {
    const g = critOn ? GOALS[goalKey][1]() : null; chain = critOn ? chainTo(g) : [];
    const gt = g ? timeOf(g, g.field) : null;
    $('goalT').textContent = gt != null ? fmt(gt) : '';
    const box = $('crit'); box.hidden = !critOn;
    if (!critOn) return;
    box.innerHTML = `<h3>关键路径 · 决定「${esc(GOALS[goalKey][0])}」${gt != null ? fmt(gt) : ''} 的步骤</h3><div class="u-crit">${chain.map(n => `<div data-lane="${n.L.id}" data-step="${n.k}"><span>${esc(n.L.label)} · ${esc(n.s.body)}</span><span class="t">${fmt(n.t)}</span>
      <span class="why">${n.why || ''}${n.inside > 8 && /^(建造|升级|农民)/.test(n.s.body) ? ` · 下令后 <b>${Math.round(n.inside)}s</b> 才开工（${econWhy(n.s.work - 2)}）` : ''}</span></div>`).join('')}</div>
      <p class="hint">这串里任何一步晚 5 秒，目标就晚 5 秒；变暗的步骤晚一点不影响它。<b>橙色秒数</b>是白等的时间。</p>`;
  }

  /* ---------- rows ---------- */
  const isPicked = R => !!(R.lane && view === 'unit' && pick.has(cidOfLane(R.lane)));
  const FILTERS = [['农民', R => R.kind === 'peasant'], ['采金·主矿', R => R.kind === 'peasant' && activity(R.lane, now()) === '采金·主矿'], ['采金·分矿', R => R.kind === 'peasant' && activity(R.lane, now()) === '采金·分矿'],
    ['伐木', R => R.kind === 'peasant' && activity(R.lane, now()) === '伐木'], ['建造中', R => R.kind === 'peasant' && activity(R.lane, now()) === '建造'],
    ['清野小组', R => R.kind === 'peasant' && R.lane.steps.some(s => /^敲钟/.test(s.body))], ['英雄', R => R.kind === 'hero'], ['步兵', R => R.kind === 'army'], ['建筑生产', R => R.kind === 'building'],
    ['关键路径上', R => R.lane && chain.some(n => n.L === R.lane)]];
  const visible = R => view === 'bld' || !filters.size || FILTERS.some(([n, f]) => filters.has(n) && f(R)) || isPicked(R);
  const LANE_OF_BUILDING = {国王祭坛: '国王祭坛', 兵营: '兵营', 神秘圣所: '神秘圣地'};
  function rowsSpec() {
    if (view === 'unit') return lanes.map(L => ({key: L.id, kind: L.kind, label: L.label, prio: L.prio, lane: L, items: L.steps.map((step, k) => ({step, lane: L, k}))}));
    const out = [], used = new Set(), hall = lanes.find(L => L.kind === 'building' && L.label === '城镇大厅');
    if (hall) out.push({key: 'B-hall', kind: 'bld', label: '城镇大厅', sub: '开局就有', prio: 0, order: -1, items: hall.steps.map((step, k) => ({step, lane: hall, k}))});
    lanes.filter(L => L.kind === 'peasant').forEach(L => L.steps.forEach((s, k) => {
      if (!/^建造/.test(s.body) || s.start == null) return;
      const what = s.body.split(' ')[1];
      let prod = s.tag ? lanes.find(x => x.kind === 'building' && x.label === '#' + s.tag) : null;
      if (!prod && LANE_OF_BUILDING[what]) prod = lanes.find(x => x.kind === 'building' && x.label === LANE_OF_BUILDING[what] && !used.has(x.id));
      if (prod) used.add(prod.id);
      out.push({key: 'B-' + L.id + '-' + k, kind: 'bld', label: what + (s.tag ? ' #' + s.tag : ''), sub: `${L.label} 建` + (s.done != null ? ` · ${fmt(s.done)} 完成` : ''), prio: L.prio, order: s.start,
        items: [{step: s, lane: L, k, build: L.label}].concat(prod ? prod.steps.map((step, j) => ({step, lane: prod, k: j})) : [])});
    }));
    return out.sort((x, y) => x.order - y.order);
  }
  const bneckRow = {key: 'BN', kind: 'bneck', special: true, items: []}, divRow = {key: 'DIV', kind: 'divider', special: true, items: []};
  function buildRows() {
    if (!root || !D) return;
    rows = rowsSpec(); const host = $('rows'); host.innerHTML = '';
    for (const R of [bneckRow, divRow, ...rows]) {
      const r = document.createElement('div'); r.className = 'u-row u-k-' + R.kind; r.dataset.key = R.key;
      if (R.kind === 'bneck') r.innerHTML = `<div class="u-lab"><b>瓶颈</b><small>卡人口·大厅空闲·农民空闲</small></div><div class="u-track"></div>`;
      else if (R.kind === 'divider') r.innerHTML = `<div class="u-lab u-divlab">▲ 选中的单位 ・ 以下是其他轨道</div>`;
      else r.innerHTML = `<div class="u-lab">${R.kind === 'bld' ? '' : `<span class="u-prio" title="优先级：脚本里越靠前越先花钱">P${R.prio}</span>`}<b class="u-name" title="点一下选中，Ctrl/Shift 多选；沙盘跟着定位">${esc(R.label)}</b>${R.sub ? `<small>${esc(R.sub)}</small>` : ''}<span class="u-rank"></span><span class="u-state"></span>${R.lane && R.kind !== 'bld' && R.kind !== 'building' ? `<button type="button" class="u-mute" data-mute="${esc(R.label)}" title="${R.lane.muted ? '恢复执行' : '这条线暂停执行（写成 #⏸，预演和实战都跳过）'}">⏸</button>` : ''}</div><div class="u-track"></div>`;
      if (R.lane && R.lane.muted) r.classList.add('u-muted');
      host.appendChild(r); R.el = r; R.stateEl = r.querySelector('.u-state'); R.rankEl = r.querySelector('.u-rank'); R.track = r.querySelector('.u-track');
    }
    drawBars(); buildFilters();
  }
  function drawBars() {
    const w = END * pps(), canvas = $('canvas');
    canvas.style.width = (LABEL() + w + 8) + 'px';
    bneckRow.track.style.width = w + 'px';
    bneckRow.track.innerHTML = bnecks.map(b => `<div class="u-bseg ${b.type}" style="left:${b.s * pps()}px;width:${Math.max(3, (b.e - b.s) * pps())}px" title="${esc(fmt(b.s) + ' ' + b.text)}"></div>`).join('');
    for (const R of rows) {
      R.track.style.width = w + 'px'; R.track.innerHTML = '';
      if (R.lane && R.kind === 'peasant') { const s0 = R.lane.steps.find(s => s.start != null); if (s0 && s0.start > 1) R.track.insertAdjacentHTML('beforeend', `<div class="u-birth" style="left:${s0.start * pps()}px" title="${fmt(s0.start)} 出生"></div>`); }
      for (const it of R.items) {
        const s = it.step; if (s.start == null) continue;
        const e = stepEnd(s) ?? s.start + 20, b = document.createElement('div');
        b.className = `u-bar c-${s.cls}`; b.dataset.lane = it.lane.id; b.dataset.step = it.k;
        b.style.left = s.start * pps() + 'px'; b.style.width = Math.max(6, (e - s.start) * pps()) + 'px';
        const wait = s.work != null ? Math.max(0, (s.work - s.start) * pps()) : 0;
        const text = it.build ? `建造 · ${it.build}` : s.body + (s.pos ? ' @' + s.pos : '') + (s.tag ? ' #' + s.tag : '');
        b.innerHTML = (wait ? `<div class="u-wait" style="width:${wait}px"></div>` : '') + (s.work != null ? `<div class="u-fill" style="left:${wait}px;width:0"></div>` : '') +
          `<div class="u-txt">${s.cond && !it.build ? '<em>[' + esc(s.cond) + ']</em>' : ''}<span>${esc(text)}</span>${s.delta ? `<span class="u-delta ${s.delta > 0 ? 'late' : 'early'}" title="和上一次预演比">${s.delta > 0 ? '+' : ''}${s.delta}s</span>` : ''}<em class="u-cd"></em><button type="button" class="u-x" data-del title="删除这一步">×</button></div>`;
        b.title = `${it.lane.label} 第 ${it.k + 1} 步：${s.raw}\n开始 ${fmt(s.start)}` + (s.work != null ? `，开工 ${fmt(s.work)}` : '') + (s.done != null ? `，完成 ${fmt(s.done)}` : '');
        if (/^敲钟/.test(s.body)) R.track.insertAdjacentHTML('beforeend', `<div class="u-band" style="left:${(s.start + 3) * pps()}px;width:${45 * pps()}px" title="民兵 45 秒"></div>`);
        R.track.appendChild(b); it.el = b;
      }
    }
    const ruler = $('ruler'); ruler.querySelectorAll('.u-tick').forEach(x => x.remove());
    const step = zoom >= 4 ? 10 : zoom >= 2 ? 30 : 60;
    for (let s = 0; s <= END; s += step) { const k = document.createElement('div'); k.className = 'u-tick'; k.style.left = X(s) + 'px'; k.textContent = fmt(s); ruler.appendChild(k); }
    drawStrips();
  }
  function svgIn(host) { let svg = host.querySelector('svg'); if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); host.appendChild(svg); } const w = END * pps(); svg.setAttribute('width', w); svg.style.left = LABEL() + 'px'; return {svg, w}; }
  function drawStrips() {
    if (!E.length) return;
    let {svg, w} = svgIn($('res')); let h = 40;
    const mg = Math.max(1, E[E.length - 1][5]), mw = Math.max(1, E[E.length - 1][6]);
    const line = (i, max) => E.filter((_, j) => j % 3 === 0).map(r => `${(r[0] * pps()).toFixed(1)},${(h - 4 - r[i] / max * (h - 10)).toFixed(1)}`).join(' ');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<polyline points="${line(5, mg)}" fill="none" stroke="var(--gold)" stroke-width="1.5" opacity=".85"/><polyline points="${line(6, mw)}" fill="none" stroke="var(--wood)" stroke-width="1.5" opacity=".85"/>`;
    ({svg, w} = svgIn($('food'))); h = 36;
    const max = 90, y = v => (h - 3 - v / max * (h - 6)).toFixed(1);
    const stepPath = i => { let d = '', first = true; for (const r of E.filter((_, j) => j % 2 === 0)) { const x = (r[0] * pps()).toFixed(1); d += first ? `M${x},${y(r[i])}` : `H${x}V${y(r[i])}`; first = false; } return d; };
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<rect x="0" y="${y(80)}" width="${w}" height="${y(50) - y(80)}" fill="var(--warn)" opacity=".08"/><rect x="0" y="0" width="${w}" height="${y(80)}" fill="var(--bad)" opacity=".08"/>
      <line x1="0" x2="${w}" y1="${y(50)}" y2="${y(50)}" stroke="var(--warn)" stroke-dasharray="4 4" opacity=".7"/><line x1="0" x2="${w}" y1="${y(80)}" y2="${y(80)}" stroke="var(--bad)" stroke-dasharray="4 4" opacity=".7"/>
      <text x="4" y="${+y(50) - 2}" fill="var(--warn)" font-size="9">51 起 金 −30%</text><text x="4" y="${+y(80) - 2}" fill="var(--bad)" font-size="9">81 起 金 −60%</text>
      <path d="${stepPath(4)}" fill="none" stroke="var(--team-2)" stroke-dasharray="3 3" opacity=".7"/><path d="${stepPath(3)}" fill="none" stroke="var(--team-2)" stroke-width="1.6"/>`;
  }
  function buildFilters() {
    const el = $('filters');
    if (view === 'bld') { el.innerHTML = '<span class="hint">按建筑：每座建筑一条，按下令的先后排；先是谁去建、什么时候建好，然后是它生产的东西。</span>'; return; }
    el.innerHTML = '<span class="hint">只看</span><button type="button" class="u-fchip ' + (filters.size ? '' : 'on') + '" data-f="">全部</button>' +
      FILTERS.map(([n]) => `<button type="button" class="u-fchip ${filters.has(n) ? 'on' : ''}" data-f="${n}">${n}<b></b></button>`).join('') +
      groups().map(g => `<button type="button" class="u-fchip" data-g="${esc(g.name)}" title="编队：点一下选中">◆ ${esc(g.name)}<b>${g.cids.length}</b></button>`).join('');
  }
  function groups() { try { return JSON.parse(store.get('wcc.groups') || '[]'); } catch (_) { return []; } }

  /* ---------- every frame ---------- */
  const now = () => api ? api.getT() : 0;
  function status(R, t) {
    if (R.lane && R.lane.muted) return {g: 5, cls: 'wait', text: '暂停执行'};
    const {cur, next} = current(R.items, t);
    if (cur) {
      const s = cur.step, waiting = s.work != null && t < s.work, e = stepEnd(s);
      return {g: 0, cur, cls: waiting ? 'wait' : 'act', text: waiting ? (cur.build ? cur.build + ' 走过去/等钱' : '等资源 · ' + s.body) : (cur.build ? '建造中' : s.body) + (e != null && !ongoing(s) ? ` · 剩 ${Math.ceil(e - t)}s` : '')};
    }
    if (next) return {g: next.step.start - t <= 30 ? 1 : 2, next, cls: '', text: `${Math.ceil(next.step.start - t)}s 后：${next.build ? '开始建' : next.step.body}`};
    return {g: 3, cls: '', text: R.kind === 'bld' ? '' : '这一行做完了'};
  }
  let lastKey = '';
  function tick() {
    if (!root || !D || root.hidden) return;
    const t = now(), st = new Map(rows.map(R => [R, status(R, t)]));
    let shown = rows.filter(visible);
    const prioOrder = [...rows].sort((a, b) => st.get(a).g - st.get(b).g || (st.get(a).g === 1 ? st.get(a).next.step.start - st.get(b).next.step.start : 0) || a.prio - b.prio);
    if (byPrio && view === 'unit') shown = prioOrder.filter(R => shown.includes(R));
    const picked = shown.filter(isPicked);
    let order = picked.length && pinPicked ? [...picked, divRow, ...shown.filter(R => !isPicked(R))] : shown;
    order = [bneckRow, ...order];
    rows.forEach(R => R.el.classList.toggle('u-hide', !order.includes(R)));
    divRow.el.classList.toggle('u-hide', !order.includes(divRow));
    order.forEach((R, i) => { R.el.style.top = i * ROW + 'px'; R.y = i; });
    $('rows').style.height = order.length * ROW + 'px';
    $('rows').classList.toggle('u-dimmed', dimOthers && pick.size > 0);
    const x = X(t), line = $('now');
    line.style.left = x + 'px'; line.dataset.t = fmt(t); $('shade').style.left = LABEL() + 'px'; $('shade').style.width = Math.max(0, x - LABEL()) + 'px';
    const canvas = $('canvas'); canvas.querySelectorAll('.u-dot').forEach(d => d.remove());
    const top0 = $('rows').offsetTop, rank = new Map(prioOrder.map((R, i) => [R, i + 1]));
    for (const R of order) {
      if (R.special) continue;
      const s0 = st.get(R); R.stateEl.textContent = s0.text; R.stateEl.className = 'u-state ' + s0.cls;
      R.el.classList.toggle('u-picked', isPicked(R));
      if (R.rankEl) R.rankEl.textContent = isPicked(R) && !pinPicked ? `第 ${rank.get(R)}/${rows.length}` : '';
      for (const it of R.items) {
        const s = it.step; if (!it.el) continue;
        const e = stepEnd(s), isNow = s.start <= t && (e == null || t < e), past = e != null && e <= t;
        it.el.classList.toggle('now', isNow); it.el.classList.toggle('past', past && !isNow); it.el.classList.toggle('future', s.start > t);
        it.el.classList.toggle('crit', critOn && onChain(it.lane, it.k));
        const fill = it.el.querySelector('.u-fill');
        if (fill && s.work != null && s.done != null) fill.style.width = Math.max(0, Math.min(1, (t - s.work) / (s.done - s.work))) * (s.done - s.work) * pps() + 'px';
        it.el.querySelector('.u-cd').textContent = isNow && e != null && !ongoing(s) ? '剩 ' + Math.ceil(e - t) + 's' : s.start > t && s.start - t <= 30 ? Math.ceil(s.start - t) + 's 后' : '';
        if (isNow) { const d = document.createElement('div'); d.className = 'u-dot'; d.style.left = x + 'px'; d.style.top = (top0 + R.y * ROW + ROW / 2) + 'px'; canvas.appendChild(d); }
      }
    }
    if (view === 'unit') $('filters').querySelectorAll('[data-f]').forEach(b => { const f = FILTERS.find(q => q[0] === b.dataset.f); if (f) b.querySelector('b').textContent = rows.filter(f[1]).length; });
    canvas.classList.toggle('u-critmode', critOn);
    const st2 = $('stale'); if (stale != null) { st2.hidden = false; st2.style.left = X(stale) + 'px'; st2.style.width = (X(END) - X(stale)) + 'px'; st2.style.top = top0 + 'px'; st2.style.height = $('rows').offsetHeight + 'px'; } else st2.hidden = true;
    drawGhosts();
    const key = Math.floor(t) + '|' + order.map(R => R.key).join() + '|' + pps() + '|' + chain.length;
    if (key !== lastKey) { lastKey = key; hud(t); sideLists(st, t); drawArrows(order); }
  }
  function hud(t) {
    const i = at(t), r = E[i]; if (!r) return;
    const k = Math.max(0, i - 30), rg = (r[5] - E[k][5]) / Math.max(1, r[0] - E[k][0]) * 60, rw = (r[6] - E[k][6]) / Math.max(1, r[0] - E[k][0]) * 60;
    const food = r[3], upk = food > 80 ? ['high', '高维持费：金 −60%'] : food > 50 ? ['low', '低维持费：金 −30%'] : ['none', '无维持费'];
    const W = [['主矿', r[7], 'var(--gold)'], ['分矿', r[8], '#b89a2e'], ['伐木', r[9], 'var(--wood)'], ['建造/其他', r[10], 'var(--team)'], ['民兵', r[11], 'var(--warn)'], ['空闲', r[12], 'var(--muted)']];
    const tot = W.reduce((a, w) => a + w[1], 0) || 1;
    $('hud').innerHTML = `<div class="u-cell gold"><h3>金 · ${fmt(t)}</h3><div class="big">${r[1]}</div><div class="sm">采集 <b>+${Math.round(rg)}</b>/分</div></div>
      <div class="u-cell wood"><h3>木</h3><div class="big">${r[2]}</div><div class="sm">采集 <b>+${Math.round(rw)}</b>/分</div></div>
      <div class="u-cell food"><h3>人口</h3><div class="big">${food}/${r[4]}</div><div class="sm"><span class="u-upk ${upk[0]}" title="51–80 人口采到的金少 30%，81 以上少 60%">${upk[1]}</span></div></div>
      <div class="u-cell"><h3>金矿余量（估算）</h3><div class="sm">主矿 <b>${Math.round(D.mineGold - mined[i][0])}</b> · ${r[7]}/5 人</div><div class="sm">分矿 <b>${mined[i][1] > 0 ? Math.round(D.mineGold - mined[i][1]) : '未开采'}</b> · ${r[8]}/5 人</div></div>
      <div class="u-cell"><h3>农民在做什么</h3><div class="u-meter">${W.map(w => `<i style="width:${w[1] / tot * 100}%;background:${w[2]}" title="${w[0]} ${w[1]}"></i>`).join('')}</div><div class="sm">${W.filter(w => w[1]).map(w => `${w[0]} <b>${w[1]}</b>`).join(' · ')}</div></div>
      <div class="u-cell"><h3>整局损失</h3><div class="sm">卡人口 <b>${lossSum('food')}s</b> · 大厅空闲 <b>${lossSum('hall')}s</b> · 农民空闲 <b>${lossSum('idle')}s</b></div></div>`;
  }
  function sideLists(st, t) {
    const vis = rows.filter(visible);
    const nowR = vis.filter(R => st.get(R).g === 0).sort((a, b) => a.prio - b.prio);
    const next = vis.filter(R => st.get(R).g === 1).sort((a, b) => st.get(a).next.step.start - st.get(b).next.step.start);
    $('nowList').innerHTML = nowR.length ? nowR.map(R => {
      const it = st.get(R).cur, s = it.step, e = stepEnd(s), p = s.work != null && s.done != null ? Math.max(0, Math.min(1, (t - s.work) / (s.done - s.work))) : null, waiting = s.work != null && t < s.work;
      return `<div class="u-item c-${s.cls}" data-lane="${it.lane.id}" data-step="${it.k}"><span class="p">${R.kind === 'bld' ? '' : 'P' + R.prio}</span><span class="w">${esc(R.label)} · ${esc(it.build ? '建造中' : s.body)}</span>
        <span class="cd">${e != null && !ongoing(s) ? '剩 ' + Math.ceil(e - t) + 's' : '持续'}</span><span class="sub">${waiting ? '走过去 / 等资源' : p != null ? '进行中 ' + Math.round(p * 100) + '%' : '进行中'}${s.cond ? ' · [' + esc(s.cond) + ']' : ''}</span>
        ${p != null ? `<span class="pg"><i style="width:${p * 100}%"></i></span>` : ''}</div>`;
    }).join('') : '<div class="hint">没有正在做的事</div>';
    $('nextList').innerHTML = next.length ? next.map(R => {
      const n = st.get(R).next;
      return `<div class="u-item c-${n.step.cls}" data-lane="${n.lane.id}" data-step="${n.k}"><span class="p">${R.kind === 'bld' ? '' : 'P' + R.prio}</span><span class="w">${esc(R.label)} · ${esc(n.build ? '开始建' : n.step.body)}</span><span class="cd">${Math.ceil(n.step.start - t)}s 后</span>
        <span class="sub">${n.step.cond ? '等 [' + esc(n.step.cond) + ']' : '上一步做完就开始'}</span></div>`;
    }).join('') : '<div class="hint">30 秒内没有新的事</div>';
  }
  function drawArrows(order) {
    const svg = $('arrows'), canvas = $('canvas');
    svg.setAttribute('width', canvas.scrollWidth); svg.setAttribute('height', canvas.scrollHeight);
    if (!critOn || view !== 'unit') { svg.innerHTML = ''; return; }
    const top0 = $('rows').offsetTop, rowOf = L => order.find(R => R.lane === L);
    let h = '<defs><marker id="ut-ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#fff"/></marker></defs>';
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i], ra = rowOf(a.L), rb = rowOf(b.L); if (!ra || !rb || ra === rb) continue;
      const x1 = X(a.t), y1 = top0 + ra.y * ROW + ROW / 2, x2 = X(b.s.start), y2 = top0 + rb.y * ROW + ROW / 2;
      h += `<path d="M${x1},${y1} C${x1 + 30},${y1} ${x2 - 30},${y2} ${x2},${y2}" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="5 3" marker-end="url(#ut-ah)" opacity=".85"/>`;
    }
    svg.innerHTML = h;
  }

  /* ---------- the order window (在此刻下令): pick units, an order, how and when; see it before giving it ---------- */
  const BUILD_T = {农场: 35, 兵营: 60, 国王祭坛: 60, 伐木场: 60, 城镇大厅: 180, 侦察塔: 25, 神秘藏宝室: 60, 神秘圣所: 70, 铁匠铺: 70};
  const ASSIST = [1, 0.63, 0.46, 0.36, 0.29], SPEED = {hpea: 190, hmil: 270, Hamg: 320, Hmkg: 270, hfoo: 270};
  const ord = {open: false, T: 0, cmd: null, what: '农场', place: '', target: '0', mode: 'override', when: 'now', whenTag: ''};
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const uname = c => { const ty = typeOf(c); return ty === 'hpea' || ty === 'hmil' ? '农民' + c : ty === 'Hamg' ? '大法师' : ty === 'Hmkg' ? '山丘之王' : '步兵' + c; };
  function unitsAt(T) { return D ? Object.keys(D.pos).map(Number).filter(c => posAt(c, T)).sort((a, b) => a - b) : []; }
  function builds() { const out = []; lanes.forEach(L => L.steps.forEach((s, k) => { if (/^建造/.test(s.body) && s.start != null) out.push({L, k, s, label: `${s.body.split(' ')[1]}${s.tag ? ' #' + s.tag : ''} · ${L.label} · ${fmt(s.start)} 开始`}); })); return out; }
  const tags = () => [...new Set(lanes.flatMap(L => L.steps.map(s => s.tag)).filter(Boolean))];
  const PLACE = n => n === '主矿' ? D.mine : n === '分矿' ? D.natural : D.places[n];
  function startFor(c, cost) {
    let S = ord.T; const L = laneOfCid(c);
    if (ord.mode === 'queue' && L) { const cur = current(L.steps.map(step => ({step})), ord.T).cur; if (cur && !ongoing(cur.step)) S = Math.max(S, stepEnd(cur.step) ?? S); }
    if (ord.when === 'started' || ord.when === 'done') { const n = findTag(ord.whenTag); if (n) S = Math.max(S, timeOf(n, ord.when === 'started' ? 'work' : 'done') ?? S); }
    if (ord.when === 'money' && cost) { let i = at(S); while (i < E.length - 1 && (E[i][1] < cost[0] || E[i][2] < cost[1])) i++; S = Math.max(S, E[i][0]); }
    return S;
  }
  function plan() {
    if (!ord.open || !ord.cmd || !D) return [];
    const us = unitsAt(ord.T).filter(c => pick.has(c)), out = [], n = us.length, cost = ord.cmd === 'build' ? COST_W[ord.what] : null;
    us.forEach((c, i) => {
      const ty = typeOf(c), peas = ty === 'hpea' || ty === 'hmil';
      if (['gold-main', 'gold-nat', 'wood', 'build', 'assist', 'bell'].includes(ord.cmd) && !peas) return;
      const T = startFor(c, i === 0 ? cost : null), p = posAt(c, T) || posAt(c, ord.T), sp = SPEED[ty] || 270;
      let target = null, work = 0, body = '', on = false, note = '';
      switch (ord.cmd) {
        case 'gold-main': target = D.mine; body = '采金 主矿'; on = true; break;
        case 'gold-nat': target = D.natural; body = '采金 分矿'; on = true; break;
        case 'wood': target = [D.hall[0] - 500, D.hall[1] + 400]; body = '伐木'; on = true; break;
        case 'build': target = PLACE(ord.place); body = (i === 0 ? '建造 ' : '协助 ') + ord.what; work = (BUILD_T[ord.what] || 60) * ASSIST[Math.min(n, 5) - 1]; if (i > 0) note = `帮 ${uname(us[0])} 一起建`; break;
        case 'assist': { const b = builds()[+ord.target]; if (b) { target = b.s.at || PLACE(b.s.pos) || D.hall; body = '协助 ' + b.s.body.split(' ')[1]; work = Math.max(5, (b.s.done ?? T + 30) - T); note = '建好为止'; } break; }
        case 'bell': target = D.hall; body = '敲钟'; work = 45; note = '变民兵 45 秒'; break;
        case 'move': target = PLACE(ord.place); body = '移动'; break;
        case 'attack': target = PLACE(ord.place); body = '攻击移动'; break;
        case 'clear': target = D.natural; body = '清野'; work = 40; note = '估计 40 秒'; break;
        case 'hold': target = PLACE(ord.place); body = '待命'; on = true; break;
      }
      if (!body || !p) return;
      const walk = target ? Math.round(dist(p, target) / sp) : 0, L = laneOfCid(c);
      const nextFixed = L ? L.steps.filter(s => s.start != null && s.start > T && !ongoing(s)).sort((a, b) => a.start - b.start)[0] : null;
      const end = on ? (nextFixed ? nextFixed.start : END) : T + walk + work;
      const cur = L ? current(L.steps.map(step => ({step})), T).cur : null;
      out.push({c, L, T, body, walk, work, end, on, note, was: cur && ongoing(cur.step) ? cur.step : null, busy: cur && !ongoing(cur.step) && ord.mode === 'override' ? cur.step : null});
    });
    return out;
  }
  let ghostKey = '';
  function drawGhosts() {
    const P = plan(), key = JSON.stringify(P.map(p => [p.c, p.T, p.end, p.body])) + pps() + view;
    if (key === ghostKey) return; ghostKey = key;
    $('canvas').querySelectorAll('.u-ghost').forEach(g => g.remove());
    for (const p of P) {
      const R = rows.find(x => x.lane === p.L); if (!R) continue;
      const g = document.createElement('div'); g.className = 'u-bar u-ghost';
      g.style.left = p.T * pps() + 'px'; g.style.width = Math.max(8, (p.end - p.T) * pps()) + 'px';
      g.innerHTML = (p.walk ? `<div class="u-wait" style="width:${p.walk * pps()}px;--c:#fff"></div>` : '') + `<div class="u-txt"><span>预览：${esc(p.body)}</span><em>${fmt(p.T)}–${fmt(p.end)}</em></div>`;
      R.track.appendChild(g);
    }
  }
  function openOrder(T, cids) {
    ord.open = true; ord.T = Math.round(T == null ? now() : T); if (cids) { pick.clear(); cids.forEach(c => pick.add(c)); }
    if (!ord.whenTag) ord.whenTag = tags()[0] || '';
    if (!ord.place || !(ord.place in D.places || ord.place === '主矿' || ord.place === '分矿')) ord.place = '分矿';
    $('order').hidden = false; renderOrder(); lastKey = '';
  }
  function closeOrder() { ord.open = false; ord.cmd = null; $('order').hidden = true; ghostKey = ''; }
  function syncOrder() { if (!D) return; if (!ord.open && pick.size) openOrder(now(), null); else if (ord.open) renderOrder(); }
  function commandsFor(cs) {
    const peas = cs.length && cs.every(c => typeOf(c) === 'hpea' || typeOf(c) === 'hmil'), out = [];
    if (peas) out.push(['gold-main', '采金 主矿', 'gold'], ['gold-nat', '采金 分矿', 'gold'], ['wood', '伐木', 'wood'], ['build', '建造…', 'build'], ['assist', '协助…', 'assist'], ['bell', '敲钟变民兵', 'bell']);
    if (cs.length) out.push(['move', '移动到…', 'wait'], ['attack', '攻击移动到…', 'fight'], ['clear', '去分矿清野', 'fight'], ['hold', '待命在…', 'wait']);
    return out;
  }
  function renderOrder() {
    if (!ord.open || !D) return;
    const us = unitsAt(ord.T), sel2 = us.filter(c => pick.has(c)), cmds = commandsFor(sel2);
    if (ord.cmd && !cmds.some(x => x[0] === ord.cmd)) ord.cmd = null;
    const grp = [['农民', us.filter(c => typeOf(c) === 'hpea' || typeOf(c) === 'hmil')], ['英雄', us.filter(c => /^H/.test(typeOf(c)))], ['步兵', us.filter(c => typeOf(c) === 'hfoo')]];
    const needPlace = ['build', 'move', 'hold', 'attack'].includes(ord.cmd), places = ['分矿', '主矿', ...Object.keys(D.places)], P = plan(), cost = ord.cmd === 'build' ? COST_W[ord.what] : null;
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    $('order').innerHTML = `<div class="ttl">在 <input id="ut-oT" value="${fmt(ord.T)}" aria-label="下令时刻"> 下令<button class="btn" type="button" data-o="close" aria-label="关闭">×</button></div>
      <div class="u-row3"><label class="u-sw2"><input type="checkbox" id="ut-oPin" ${pinPicked ? 'checked' : ''}>选中的挤到最前面</label><label class="u-sw2"><input type="checkbox" id="ut-oDim" ${dimOthers ? 'checked' : ''}>其他轨道变暗</label></div>
      <div class="sub">选单位（这一刻在做什么） · 已选 ${sel2.length}</div>
      ${grp.filter(g => g[1].length).map(([, list]) => `<div class="u-uchips">${list.map(c => `<button type="button" class="u-uchip ${pick.has(c) ? 'on' : ''}" data-u="${c}">${esc(uname(c))}<small>${esc(activity(laneOfCid(c), ord.T))}</small></button>`).join('')}</div>`).join('')}
      <div class="u-quick"><button type="button" data-q="采金·主矿">采金的</button><button type="button" data-q="伐木">伐木的</button><button type="button" data-q="空闲">空闲的</button><button type="button" data-q="清野小组">清野小组</button><button type="button" data-q="">清空</button>
        ${groups().map(g => `<button type="button" data-grp="${esc(g.name)}">◆ ${esc(g.name)}</button>`).join('')}</div>
      <div class="u-row3"><input class="u-gname" id="ut-oG" placeholder="编队名" aria-label="编队名"><button class="btn" type="button" data-o="savegrp" ${sel2.length ? '' : 'disabled'}>存为编队</button></div>
      <div class="sub">做什么</div>
      ${cmds.length ? `<div class="u-cmds">${cmds.map(([k, n, c]) => `<button type="button" class="c-${c} ${ord.cmd === k ? 'on' : ''}" data-c="${k}">${n}</button>`).join('')}</div>` : '<div class="hint">先选单位：点上面的名字，或在沙盘上框选，或在时间轴上点轨道名</div>'}
      ${ord.cmd === 'build' ? `<select id="ut-oWhat">${Object.keys(BUILD_T).map(b => opt(b, b, ord.what)).join('')}</select>` : ''}
      ${needPlace ? `<select id="ut-oPlace">${places.map(p => opt(p, '@' + p, ord.place)).join('')}</select>` : ''}
      ${ord.cmd === 'assist' ? `<select id="ut-oTarget">${builds().map((b, i) => opt(String(i), b.label, ord.target)).join('')}</select>` : ''}
      ${ord.cmd ? `<div class="sub">怎么下</div><div class="u-radio">${[['override', '覆盖：打断手上的事'], ['queue', '排队：手上的做完再做（Shift）']].map(([k, n]) => `<button type="button" data-mode="${k}" class="${ord.mode === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="sub">什么时候开始</div><div class="u-radio">${[['now', '此刻 ' + fmt(ord.T)], ['started', '某建筑开工后'], ['done', '某建筑完成后'], ['money', cost ? `钱够了（金${cost[0]} 木${cost[1]}）` : '钱够了']].map(([k, n]) => `<button type="button" data-when="${k}" class="${ord.when === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        ${ord.when === 'started' || ord.when === 'done' ? `<select id="ut-oWhenTag">${tags().map(g => opt(g, '#' + g, ord.whenTag)).join('')}</select>` : ''}` : ''}
      ${P.length ? `<div class="sub">预计（时间轴上的白色虚线条就是它）</div><div class="u-plan">${P.map(p => `<div><b>${esc(uname(p.c))}</b><span class="w">${fmt(p.T)} 开始 · 走 ${p.walk}s${p.work ? ' + ' + Math.round(p.work) + 's' : ''} → ${p.on ? '一直做到 ' + fmt(p.end) : fmt(p.end) + ' 做完'}</span>${p.note ? `<span class="w">${esc(p.note)}</span>` : ''}</div>` +
        (p.busy ? `<div class="bad">他这时在「${esc(p.busy.body)}」，做完才会接着做</div>` : '') + (p.was && !p.on ? `<div class="w">做完回去「${esc(p.was.body)}」</div>` : '')).join('')}</div>` : ''}
      <button type="button" class="u-go" data-o="go" ${P.length ? '' : 'disabled'}>下令（${P.length} 个单位）</button>`;
    ghostKey = '';
  }
  function giveOrder() {
    const P = plan(); if (!P.length) return;
    const cost = ord.cmd === 'build' ? COST_W[ord.what] : null;
    const when = ord.when === 'started' || ord.when === 'done' ? {kind: ord.when, tag: ord.whenTag} : ord.when === 'money' && cost ? {kind: 'money', gold: cost[0], wood: cost[1]} : {kind: 'now'};
    const extra = {what: ord.what, queue: ord.mode === 'queue', when};
    if (['build', 'move', 'hold', 'attack'].includes(ord.cmd)) { extra.place = ord.place in D.places || ord.place === '分矿' ? ord.place : null; extra.xy = PLACE(ord.place); }
    if (ord.cmd === 'assist') { const b = builds()[+ord.target]; if (b) extra.assist = {label: b.L.label, k: b.k}; }
    api.order({cids: P.map(p => p.c), t: ord.T, cmd: ord.cmd, ...extra});
    ord.cmd = null; renderOrder();
  }
  function onOrderClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.o === 'close') { closeOrder(); return; }
    if (b.dataset.u) { const c = +b.dataset.u; pick.has(c) ? pick.delete(c) : pick.add(c); lastKey = ''; api.picked(false); renderOrder(); return; }
    if (b.dataset.q != null) {
      pick.clear();
      if (b.dataset.q) unitsAt(ord.T).filter(c => typeOf(c) === 'hpea' && (b.dataset.q === '清野小组' ? (laneOfCid(c) || {steps: []}).steps.some(s => /^敲钟/.test(s.body)) : activity(laneOfCid(c), ord.T) === b.dataset.q)).forEach(c => pick.add(c));
      lastKey = ''; api.picked(false); renderOrder(); return;
    }
    if (b.dataset.grp) { const G = groups().find(x => x.name === b.dataset.grp); pick.clear(); G.cids.forEach(c => pick.add(c)); lastKey = ''; api.picked(false); renderOrder(); return; }
    if (b.dataset.o === 'savegrp') {
      const nm = ($('oG').value || '').trim() || '编队' + (groups().length + 1), gs = groups().filter(g => g.name !== nm).concat([{name: nm, cids: [...pick]}]);
      store.set('wcc.groups', JSON.stringify(gs)); buildFilters(); renderOrder(); api.say(`存了编队「${nm}」（${pick.size} 个单位）：筛选条和这里都能一键选中`); return;
    }
    if (b.dataset.c) {
      ord.cmd = b.dataset.c;
      if (ord.cmd === 'build' && !(ord.place in D.places)) ord.place = Object.keys(D.places).find(n => /农场/.test(n)) || Object.keys(D.places)[0] || ord.place; // a building site, not the camp
      renderOrder(); return;
    }
    if (b.dataset.mode) { ord.mode = b.dataset.mode; renderOrder(); return; }
    if (b.dataset.when) { ord.when = b.dataset.when; if (!tags().includes(ord.whenTag)) ord.whenTag = tags()[0] || ''; renderOrder(); return; }
    if (b.dataset.o === 'go') giveOrder();
  }
  function onOrderChange(e) {
    const id = e.target.id;
    if (id === 'ut-oWhat') ord.what = e.target.value;
    if (id === 'ut-oPlace') ord.place = e.target.value;
    if (id === 'ut-oTarget') ord.target = e.target.value;
    if (id === 'ut-oWhenTag') ord.whenTag = e.target.value;
    if (id === 'ut-oPin') { pinPicked = e.target.checked; $('pin').setAttribute('aria-checked', pinPicked); lastKey = ''; }
    if (id === 'ut-oDim') { dimOthers = e.target.checked; lastKey = ''; }
    if (id === 'ut-oT') { const v = parseT(e.target.value); if (v != null) { ord.T = Math.min(END - 1, v); api.setT(ord.T); follow(); } }
    if (id !== 'ut-oG') renderOrder();
  }

  /* ---------- input ---------- */
  function setZoom(z, cx) {
    const sc = $('scroll'), r = sc.getBoundingClientRect(), mx = (cx == null ? r.left + r.width / 2 : cx) - r.left, sec = (sc.scrollLeft + mx - LABEL()) / pps();
    zoom = Math.max(1, Math.min(8, z)); store.set('wcc.utZoom', zoom); drawBars(); sc.scrollLeft = Math.max(0, LABEL() + sec * pps() - mx); lastKey = '';
    $('zl').textContent = Math.round(zoom * 100) + '%';
  }
  function follow() { const sc = $('scroll'), x = X(now()); if (x > sc.scrollLeft + sc.clientWidth - 120 || x < sc.scrollLeft + LABEL()) sc.scrollLeft = Math.max(0, x - LABEL() - 120); }
  function scrubFrom(e) {
    e.preventDefault(); api.pause(); document.body.classList.add('u-scrubbing');
    const move = q => { const r = $('canvas').getBoundingClientRect(); api.setT(Math.max(0, Math.min(END, (q.clientX - r.left - LABEL()) / pps())));
      const sr = $('scroll').getBoundingClientRect(); if (q.clientX > sr.right - 30) $('scroll').scrollLeft += 12; else if (q.clientX < sr.left + LABEL() + 20) $('scroll').scrollLeft -= 12; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('u-scrubbing'); };
    move(e); addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
  function onRowsClick(e) {
    const mu = e.target.closest('[data-mute]'); if (mu) { e.stopPropagation(); api.toggleMute(mu.dataset.mute); return; }
    const x = e.target.closest('[data-del]');
    if (x) { const b = x.closest('.u-bar'), L = lanes.find(l => l.id === b.dataset.lane), k = +b.dataset.step; e.stopPropagation(); api.editStep({op: 'delete', label: L.label, k, raw: L.steps[k].raw, t: L.steps[k].start}); return; }
    const name = e.target.closest('.u-name'); if (!name) return;
    const R = rows.find(r => r.key === name.closest('.u-row').dataset.key); if (!R || !R.lane) return;
    const c = cidOfLane(R.lane);
    if (c == null || Number.isNaN(c)) { api.say(R.kind === 'army' ? '步兵这一行管所有步兵：在沙盘上框选步兵下令' : '建筑那一行在「按建筑」里看；选中的是单位'); return; }
    if (e.ctrlKey || e.metaKey || e.shiftKey) pick.has(c) ? pick.delete(c) : pick.add(c);
    else { const only = pick.size === 1 && pick.has(c); pick.clear(); if (!only) pick.add(c); }
    lastKey = ''; api.picked(true); syncOrder();
  }
  function onBarDown(e) {
    const b = e.target.closest('.u-bar'); if (!b || e.button !== 0 || e.detail > 1 || b.classList.contains('u-ghost') || e.target.closest('[data-del]')) return;
    const L = lanes.find(x => x.id === b.dataset.lane), k = +b.dataset.step, s = L.steps[k], x0 = e.clientX, y0 = e.clientY, left0 = b.offsetLeft;
    let moved = false, target = L, ghost = null;
    b.setPointerCapture(e.pointerId);
    const mv = q => {
      const dx = q.clientX - x0, dy = q.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true; b.classList.add('drag'); b.style.left = (left0 + dx) + 'px'; b.style.transform = `translateY(${dy}px)`;
      const nt = Math.max(0, Math.min(END - 1, (left0 + dx) / pps()));
      if (!ghost) { ghost = document.createElement('div'); ghost.className = 'u-ghost-t'; b.appendChild(ghost); }
      ghost.textContent = '最早 ' + fmt(nt);
      const rr = $('rows').getBoundingClientRect(), yi = Math.floor((q.clientY - rr.top) / ROW), over = rows.find(x => !x.el.classList.contains('u-hide') && x.y === yi);
      rows.forEach(x => x.el.classList.toggle('u-drop', x === over && x.lane && x.lane !== L && x.lane.kind === L.kind));
      target = view === 'unit' && over && over.lane && over.lane.kind === L.kind ? over.lane : L;
    };
    const up = q => {
      b.removeEventListener('pointermove', mv); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up);
      rows.forEach(x => x.el.classList.remove('u-drop'));
      if (!moved) { openEditor(L, k, q); return; }
      const nt = Math.round(Math.max(0, Math.min(END - 1, (left0 + q.clientX - x0) / pps())));
      if (target !== L) api.editStep({op: 'move', label: L.label, k, raw: s.raw, to: target.label, t: Math.min(nt, s.start), at: nt});
      else if (nt !== Math.round(s.start)) api.editStep({op: 'time', label: L.label, k, raw: s.raw, at: nt, t: Math.min(nt, s.start)});
      else drawBars();
    };
    b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  }
  function openEditor(L, k, ev) {
    sel = {L, k}; const s = L.steps[k], pop = $('pop');
    pop.innerHTML = `<div class="ttl">${esc(L.label)} · 第 ${k + 1} 步<button class="btn" type="button" data-x="close" aria-label="关闭">×</button></div>
      <label>整步<input id="ut-praw" value="${esc(s.raw)}" spellcheck="false"></label>
      <div class="hint">开始 ${fmt(s.start)}${s.work != null ? ' · 开工 ' + fmt(s.work) : ''}${s.done != null ? ' · 完成 ' + fmt(s.done) : ''}${L.kind === 'peasant' && /、/.test(L.label) ? '' : ''}</div>
      <div class="row2"><button class="btn on" type="button" data-x="apply">改好了</button><button class="btn" type="button" data-x="card">在战术脚本里改</button><button class="btn bad" type="button" data-x="del">删除这一步</button></div>
      <div class="hint">改完从 ${fmt(s.start)} 的存档点接着预演。</div>`;
    pop.hidden = false;
    const r = pop.getBoundingClientRect();
    pop.style.left = Math.min(innerWidth - r.width - 16, Math.max(16, ev.clientX + 12)) + 'px'; pop.style.top = Math.min(innerHeight - r.height - 16, Math.max(16, ev.clientY + 12)) + 'px';
  }
  function closePop() { $('pop').hidden = true; sel = null; }

  /* ---------- mount ---------- */
  function mount(a, host) {
    api = a;
    root = document.createElement('div'); root.className = 'ut'; root.hidden = true;
    root.innerHTML = `<div class="u-bar2">
        <span class="u-seg" id="ut-view"><button type="button" data-v="unit" class="on">按单位</button><button type="button" data-v="bld">按建筑</button></span>
        <button class="u-switch" id="ut-prio" type="button" role="switch" aria-checked="false"><i></i>按优先级排序</button>
        <button class="u-switch" id="ut-pin" type="button" role="switch" aria-checked="true"><i></i>选中的置顶</button>
        <span class="u-goal"><button class="u-switch" id="ut-critsw" type="button" role="switch" aria-checked="false"><i></i>关键路径</button><select id="ut-goal" aria-label="目标">${Object.entries(GOALS).map(([k, g]) => `<option value="${k}">${g[0]}</option>`).join('')}</select><span class="u-gt" id="ut-goalT"></span></span>
        <span class="zoomctl"><button class="btn" type="button" id="ut-zout" aria-label="缩小">－</button><b id="ut-zl">${Math.round(zoom * 100)}%</b><button class="btn" type="button" id="ut-zin" aria-label="放大">＋</button><button class="btn" type="button" id="ut-zfit">适应</button></span>
        <span class="hint">拖<b>红线</b>（或 ← →）换时刻，沙盘跟着走；在沙盘上框选单位、右键下令，命令写进脚本，从那一刻接着预演。</span></div>
      <div class="u-hud" id="ut-hud"></div>
      <div class="u-filters" id="ut-filters"></div>
      <div class="u-main">
        <section class="u-board"><div class="u-scroll" id="ut-scroll"><div class="u-canvas" id="ut-canvas">
          <div class="u-ruler" id="ut-ruler"><div class="u-corner">轨道 ／ 时间</div></div>
          <div class="u-strip" id="ut-res"><div class="u-corner"><span style="color:var(--gold)">— 金</span><span style="color:var(--wood)">— 木</span><small>累计采集</small></div></div>
          <div class="u-strip u-food" id="ut-food"><div class="u-corner"><span style="color:var(--team-2)">人口</span><small>虚线：51 / 81 维持费</small></div></div>
          <div class="u-rows" id="ut-rows"></div>
          <svg class="u-arrows" id="ut-arrows"></svg>
          <div class="u-shade" id="ut-shade"></div>
          <div class="u-stale" id="ut-stale" hidden><span>从存档点重新计算中…</span></div>
          <div class="u-now" id="ut-now" data-t="0:00" title="拖动红线换时刻"><span class="grip"></span></div>
        </div></div></section>
        <aside class="u-side">
          <div class="u-box" id="ut-crit" hidden></div>
          <div class="u-box u-order" id="ut-order" hidden></div>
          <div class="u-box"><h3>此刻 · 正在做（按优先级）</h3><div class="u-list" id="ut-nowList"></div></div>
          <div class="u-box"><h3>接下来 · 30 秒内开始</h3><div class="u-list" id="ut-nextList"></div></div>
          <div class="u-box"><h3>图例和操作</h3><div class="u-legend">
            <span><i class="c-gold"></i>采金</span><span><i class="c-wood"></i>伐木</span><span><i class="c-build"></i>建造</span><span><i class="c-assist"></i>协助</span>
            <span><i class="c-bell"></i>敲钟/集合</span><span><i class="c-fight"></i>清野/攻击</span><span><i class="c-train"></i>训练</span><span><i class="c-upgrade"></i>升级</span>
            <span><i class="h"></i>走过去/等资源</span><span><i class="f"></i>还没开始</span></div>
            <p class="hint">拖红线换时刻（← → 一秒，Shift 十秒）· 点轨道名选中单位（沙盘跟着定位），Ctrl/Shift 多选 · 双击轨道在那一刻打开下令窗口 · 拖色块改时间或改派 · ⏸ 让这条线暂停执行</p></div>
        </aside>
      </div>
      <div class="u-pop" id="ut-pop" hidden></div>`;
    host.after(root);
    $('view').onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; view = b.dataset.v; $('view').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); buildRows(); lastKey = ''; };
    $('prio').onclick = () => { byPrio = !byPrio; $('prio').setAttribute('aria-checked', byPrio); lastKey = ''; };
    $('pin').onclick = () => { pinPicked = !pinPicked; $('pin').setAttribute('aria-checked', pinPicked); lastKey = ''; };
    $('critsw').onclick = () => { critOn = !critOn; $('critsw').setAttribute('aria-checked', critOn); updateChain(); buildFilters(); lastKey = ''; };
    $('goal').onchange = e => { goalKey = e.target.value; updateChain(); lastKey = ''; };
    $('zin').onclick = () => setZoom(zoom * 1.5); $('zout').onclick = () => setZoom(zoom / 1.5); $('zfit').onclick = () => setZoom(1);
    $('scroll').addEventListener('wheel', e => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); setZoom(zoom * Math.min(1.15, Math.max(1 / 1.15, Math.exp(-e.deltaY * 0.002))), e.clientX); }, {passive: false});
    $('now').addEventListener('pointerdown', scrubFrom); $('ruler').addEventListener('pointerdown', scrubFrom); $('res').addEventListener('pointerdown', scrubFrom); $('food').addEventListener('pointerdown', scrubFrom);
    $('filters').onclick = e => {
      const g = e.target.closest('[data-g]'); if (g) { const G = groups().find(x => x.name === g.dataset.g); if (G) { pick.clear(); G.cids.forEach(c => pick.add(c)); lastKey = ''; api.picked(true); syncOrder(); } return; }
      const b = e.target.closest('[data-f]'); if (!b) return; if (!b.dataset.f) filters.clear(); else filters.has(b.dataset.f) ? filters.delete(b.dataset.f) : filters.add(b.dataset.f); buildFilters(); lastKey = ''; };
    $('rows').addEventListener('click', onRowsClick);
    $('order').addEventListener('click', onOrderClick); $('order').addEventListener('change', onOrderChange);
    $('canvas').addEventListener('dblclick', e => {
      const row = e.target.closest('.u-row'); if (!row || !D) return;
      const r = $('canvas').getBoundingClientRect(), T = Math.max(0, Math.min(END - 1, (e.clientX - r.left - LABEL()) / pps())), R = rows.find(x => x.key === row.dataset.key);
      api.setT(T); const c = R && R.lane ? cidOfLane(R.lane) : null;
      openOrder(T, c != null && !Number.isNaN(c) && posAt(c, T) ? [c] : null);
    });
    $('canvas').addEventListener('pointerdown', onBarDown);
    $('crit').addEventListener('click', e => { const it = e.target.closest('[data-lane]'); if (!it) return; const L = lanes.find(x => x.id === it.dataset.lane); api.setT(L.steps[+it.dataset.step].start); follow(); });
    for (const id of ['nowList', 'nextList']) $(id).addEventListener('click', e => { const it = e.target.closest('.u-item'); if (!it) return; const L = lanes.find(x => x.id === it.dataset.lane); openEditor(L, +it.dataset.step, e); });
    $('pop').addEventListener('click', e => {
      const a2 = e.target.closest('[data-x]'); if (!a2 || !sel) return;
      const {L, k} = sel, s = L.steps[k];
      if (a2.dataset.x === 'close') closePop();
      else if (a2.dataset.x === 'del') { closePop(); api.editStep({op: 'delete', label: L.label, k, raw: s.raw, t: s.start}); }
      else if (a2.dataset.x === 'apply') { const raw = $('praw').value.trim(); closePop(); if (raw && raw !== s.raw) api.editStep({op: 'raw', label: L.label, k, raw: s.raw, to: raw, t: s.start}); }
      else if (a2.dataset.x === 'card') { closePop(); api.openCard(L.label, k); }
    });
    document.addEventListener('pointerdown', e => { if (!$('pop').hidden && !e.target.closest('#ut-pop') && !e.target.closest('.u-bar')) closePop(); });
    document.addEventListener('keydown', e => {
      if (root.hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); api.pause(); api.setT(Math.max(0, Math.min(END, Math.round(now()) + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1)))); follow(); }
      if (e.key === 'Escape') closePop();
    });
    addEventListener('resize', () => { if (D) drawBars(); });
    (function loop() { requestAnimationFrame(loop); if (api.playing()) follow(); tick(); })();
  }

  window.UnifiedTimeline = {
    mount, setData, pick, posAt, typeOf, laneOfCid, current, stepEnd, fmt, activity,
    has: () => !!D, show(on) { if (root) { root.hidden = !on; if (on && D) { drawBars(); lastKey = ''; } } }, shown: () => !!(root && !root.hidden),
    markStale(t) { stale = t; lastKey = ''; }, clearStale() { stale = null; lastKey = ''; },
    openOrder: (t, cids) => { if (D) openOrder(t, cids); }, syncOrder: () => { if (ord.open) renderOrder(); },
    lanes: () => lanes, places: () => (D ? D.places : {}), natural: () => D && D.natural, mine: () => D && D.mine, hall: () => D && D.hall,
    routeOf(cid, t) { // where a unit is heading at t: the place its current step names
      const L = laneOfCid(cid); if (!L || !D) return null;
      const cur = current(L.steps.map(step => ({step})), t).cur; if (!cur) return null;
      const s = cur.step, place = s.at || D.places[s.pos];
      if (/^采金/.test(s.body)) return s.body.includes('分矿') ? D.natural : D.mine;
      if (/^(建造|集合|待命|清野|攻击移动|移动)/.test(s.body)) return place || (/^清野/.test(s.body) ? D.natural : null);
      return null;
    },
    stepIndexAt(label, t) { const L = lanes.find(x => x.label === label); if (!L) return -1; let i = -1; L.steps.forEach((s, k) => { if (s.start != null && s.start <= t + 0.01) i = k; }); return i; },
    stepAt(label, t) { const L = lanes.find(x => x.label === label); if (!L) return null; const c = current(L.steps.map(step => ({step})), t).cur; return c ? c.step : null; },
    redraw() { lastKey = ''; },
  };
})();
