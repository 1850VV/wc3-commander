/* The console's timeline: a lane per peasant, building, hero and squad of the tactic script, its steps as
   bars on one time axis, a red line that is the moment the sandbox shows. Data: TL.load(D) with what
   console/shell.js makes from the budget model (or the game): lanes with each step's start / work / done,
   one economy row a second, every unit's position a second. Edits change the lanes and fire
   「script-edited」; the shell writes them into the script, recomputes, and loads the result again. */
(function () {
  'use strict';
  const D = {lanes: [], eco: [[0, 500, 150, 5, 12, 0, 0, 0, 0, 0, 0, 0, 0]], pos: {}, units: {}, places: {}, hall: [0, 0], mine: [0, 0], natural: [0, 0], mineGold: 12500};
  let END = 600;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const fmt = t => (t < 0 ? '-' : '') + Math.floor(Math.abs(t) / 60) + ':' + String(Math.floor(Math.abs(t) % 60)).padStart(2, '0');
  const parseT = s => { const m = /^(\d+):(\d{1,2})$/.exec(String(s).trim()); return m ? +m[1] * 60 + +m[2] : null; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const store = {get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private */ } }};
  const ACTC = {采金: 'gold', 伐木: 'wood', 建造: 'build', 协助: 'assist', 敲钟: 'bell', 集合: 'bell', 清野: 'fight', 待命: 'wait', 移动到: 'wait', 学: 'learn', 集结点: 'rally', 升级: 'upgrade', 跟随大法师: 'fight', 攻击移动: 'fight', 加入: 'squad', 解散: 'squad'};
  const BUILD = {农场: 35, 兵营: 60, 国王祭坛: 60, 伐木场: 60, 城镇大厅: 180, 侦察塔: 25, 神秘藏宝室: 60, 神秘圣所: 70, 铁匠铺: 70};
  const COST = {农场: [80, 20], 兵营: [160, 60], 国王祭坛: [180, 50], 伐木场: [120, 0], 城镇大厅: [385, 205], 侦察塔: [30, 20], 神秘藏宝室: [130, 30], 神秘圣所: [150, 140], 铁匠铺: [140, 60]};
  const ASSIST = [1, 0.63, 0.46, 0.36, 0.29];
  const SPEED = {hpea: 190, hmil: 270, Hamg: 320, Hmkg: 270, hfoo: 270};
  const LANE_OF_BUILDING = {国王祭坛: '国王祭坛', 兵营: '兵营', 神秘圣所: '神秘圣地'};

  function split(raw) {
    let s = raw.trim(), cond = '';
    if (s.startsWith('[')) { const i = s.indexOf(']'); cond = s.slice(1, i).trim(); s = s.slice(i + 1).trim(); }
    const tag = (s.match(/\s#(\S+)$/) || [])[1] || '', pos = (s.match(/@(\S+)/) || [])[1] || '';
    const body = s.replace(/\s#\S+$/, '').replace(/@\S+/, '').replace(/\s+/g, ' ').trim(), w = body.split(' ')[0];
    return {cond, body, pos, tag, cls: ACTC[w] || 'train'};
  }
  const condTerms = c => (c || '').split(/\s*且\s*/).map(x => x.trim()).filter(Boolean);
  const ongoing = s => /^(采金|伐木|待命|集合|跟随)/.test(s.body);
  const stepEnd = s => s.done != null ? s.done : s.end != null ? s.end : (ongoing(s) ? END : null);

  /* ---------- lanes ---------- */
  const lanes = [];
  const unitType = cid => D.units[cid] || (cid < 100 ? 'hpea' : 'hfoo');
  function buildLanes() {
    const before = new Map(); for (const L of lanes) L.steps.forEach((s, k) => before.set(L.label + '|' + k + '|' + s.raw, {start: s.start, done: s.done}));
    const lines = [...new Set(D.lanes.map(l => l.line))].sort((a, b) => a - b);
    lanes.length = 0;
    D.lanes.forEach(L => lanes.push({...L, id: 'L:' + L.label, prio: lines.indexOf(L.line) + 1, steps: L.steps.map((s, k) => {
      const key = L.label + '|' + k + '|' + s.raw, b = (D.baseline && D.baseline.get(key)) || before.get(key), x = {...s, ...split(s.raw)}; // connected: the plan from 0:00
      x.orig = b && b.start != null ? b : {start: s.start, done: s.done}; // the last plan: for the before/after shadow
      return x;
    })}));
  }
  const HERO_T = {大法师: 'Hamg', 山丘之王: 'Hmkg'};
  const cidOfLane = L => L.kind === 'peasant' ? +L.label.slice(2) : L.kind === 'army' ? L.cid : L.kind === 'hero' ? +Object.keys(D.units).find(c => D.units[c] === HERO_T[L.label]) : null;
  const laneOfCid = cid => lanes.find(L => cidOfLane(L) === cid);

  /* ---------- economy ---------- */
  let E = D.eco;
  const mined = [[0, 0]];
  function computeMined() { mined.length = 1; for (let i = 1; i < E.length; i++) { const d = Math.max(0, E[i][5] - E[i - 1][5]), m = E[i][7], n = E[i][8], k = m + n || 1; mined.push([mined[i - 1][0] + d * m / k, mined[i - 1][1] + d * n / k]); } }
  const at = T => Math.max(0, Math.min(E.length - 1, Math.floor(T)));
  const overrides = {}; // cid -> [{t0, t1, walk, from, to}]: where an order given here sends him (the real one re-simulates)
  function posAt(cid, T) {
    const ov = overrides[cid];
    if (ov) for (let i = ov.length - 1; i >= 0; i--) {
      const o = ov[i];
      if (T >= o.t0 && T <= o.t1) { const k = Math.min(1, (T - o.t0) / Math.max(0.01, o.walk)); return [o.from[0] + (o.to[0] - o.from[0]) * k, o.from[1] + (o.to[1] - o.from[1]) * k]; }
    }
    return basePos(cid, T);
  }
  function basePos(cid, T) {
    const tr = D.pos[cid]; if (!tr || tr[0][0] > T) return null;
    let p = tr[0]; for (const q of tr) { if (q[0] > T) break; p = q; }
    return p[0] < T - 6 && tr[tr.length - 1][0] < T - 6 ? null : [p[1], p[2]];
  }

  /* ---------- bottlenecks: food blocked, the hall idle, builds waiting for money, idle peasants ---------- */
  const bnecks = [];
  function computeBnecks() {
    bnecks.length = 0;
    let a = null;
    for (let i = 0; i <= E.length; i++) { const full = i < E.length && E[i][3] >= E[i][4]; if (full && a == null) a = i; if (!full && a != null) { if (i - a >= 2) bnecks.push({s: a, e: i, type: 'food', text: `卡人口 ${i - a}s（${E[a][3]}/${E[a][4]}）`}); a = null; } }
    a = null;
    for (let i = 3; i <= E.length; i++) { const idle = i < E.length && E[i][12] > 0; if (idle && a == null) a = i; if (!idle && a != null) { if (i - a >= 3) bnecks.push({s: a, e: i, type: 'idle', text: `农民空闲 ${i - a}s`}); a = null; } }
    const hall = lanes.find(L => L.kind === 'building' && L.label === '城镇大厅');
    if (hall) for (let k = 1; k < hall.steps.length; k++) {
      const p = hall.steps[k - 1], q = hall.steps[k], s = p.done ?? p.end, e = q.work ?? q.start;
      if (s != null && e != null && e - s > 1.5) { const r = E[at(s + 0.5)]; bnecks.push({s, e, type: 'hall', text: `城镇大厅空闲 ${Math.round(e - s)}s（${r[3] >= r[4] ? '卡人口' : r[1] < 75 ? '等钱' : q.cond ? '等条件 ' + q.cond : '没排上'}）`}); }
    }
    for (const L of lanes) L.steps.forEach(s => {
      if (!/^建造/.test(s.body) || s.start == null || s.work == null) return;
      const what = s.body.split(' ')[1], c = COST[what] || [0, 0], cid = cidOfLane(L), p = cid != null && posAt(cid, s.start), site = s.at || D.places[s.pos];
      const walk = p && site ? dist(p, site) / 190 : 5, wait = s.work - s.start - walk;
      if (wait > 3) { const r = E[at(s.start + walk)]; const type = r[1] < c[0] ? 'gold' : r[2] < c[1] ? 'wood' : 'idle';
        bnecks.push({s: s.start + walk, e: s.work, type, text: `${L.label} 的${what}等了 ${Math.round(wait)}s（${type === 'gold' ? '缺金' : type === 'wood' ? '缺木' : '别的原因'}）`}); }
    });
  }
  const lossSum = type => Math.round(bnecks.filter(b => b.type === type).reduce((a, b) => a + (b.e - b.s), 0));

  /* ---------- state ---------- */
  let t = 160, playing = false, speed = 16, zoom = 1, byPrio = false, view = 'unit', filters = new Set(), sel = null, last = performance.now();
  let rows = [], pinPicked = true, dimOthers = false, critOn = false, goalKey = 'keep';
  const pick = new Set(), muted = new Set();
  let groups = []; try { groups = JSON.parse(store.get('wcc.groups.v6') || 'null'); } catch (_) { groups = null; }
  if (!Array.isArray(groups)) groups = [];
  const saveGroups = () => store.set('wcc.groups.v6', JSON.stringify(groups));
  const scroll = $('scroll'), canvas = $('canvas'), rowsEl = $('rows'), ROW = 34;
  const LABEL = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label')) || 200;
  const pps = () => Math.max(0.6, (scroll.clientWidth - LABEL() - 8) / END) * zoom;
  const X = sec => LABEL() + sec * pps();

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

  /* ---------- the critical path: which chain of steps sets a goal's time ---------- */
  function findTag(tag) { for (const L of lanes) for (const [k, s] of L.steps.entries()) if (s.tag === tag) return {L, k}; return null; }
  function findBody(laneLabel, re) { const L = lanes.find(x => x.label === laneLabel); if (!L) return null; const k = L.steps.findIndex(s => re.test(s.body)); return k < 0 ? null : {L, k}; }
  function trainOf(n) { for (const L of lanes) if (L.kind === 'building') { const k = L.steps.findIndex(s => s.body === '农民' + n); if (k >= 0) return {L, k}; } return null; }
  const GOALS = {
    keep: ['二本（主城）完成', () => { const n = findBody('城镇大厅', /^升级 主城/); return n && {...n, field: 'done'}; }],
    nat: ['分基地开工', () => { const n = findTag('分基地'); return n && {...n, field: 'work'}; }],
    am: ['大法师出生', () => { const n = findBody('国王祭坛', /^大法师/); return n && {...n, field: 'done'}; }],
    mk: ['山丘之王出生', () => { const n = findBody('国王祭坛', /^山丘之王/); return n && {...n, field: 'done'}; }],
    caster: ['第一个法师开始训练', () => { const L = lanes.find(x => x.label === '神秘圣地'); return L && {L, k: 0, field: 'work'}; }],
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
  function chainTo(goal) {
    if (!goal) return [];
    const out = []; let cur = goal, field = goal.field;
    for (let guard = 0; guard < 40 && cur; guard++) {
      const s = cur.L.steps[cur.k], ds = deps(cur.L, cur.k), node = {L: cur.L, k: cur.k, s, field, t: timeOf(cur, field)};
      if (s.work != null && (field === 'done' || field === 'work')) node.inside = s.work - s.start;
      out.push(node);
      if (!ds.length) { node.why = s.start <= 1 ? '开局就开始' : '条件一满足就开始'; break; }
      const best = ds.reduce((a, b) => (b.t > a.t ? b : a)), gap = s.start - best.t;
      node.why = best.why + (gap > 2 ? `，之后又等了 <b>${Math.round(gap)}s</b>（${econWhy(best.t)}）` : '');
      cur = best.node; field = best.field;
    }
    return out.reverse();
  }
  function econWhy(T) { const r = E[at(T + 1)]; return r[3] >= r[4] ? '卡人口' : r[1] < 150 ? '金不够' : r[2] < 100 ? '木不够' : '钱或条件'; }
  let chain = [], chainKey = '';
  const onChain = (L, k) => chain.some(n => n.L === L && n.k === k);

  /* ---------- rows ---------- */
  function buildRowsSpec() {
    if (view === 'unit') return lanes.map(L => ({key: L.id, kind: L.kind, label: L.label, prio: L.prio, lane: L, items: L.steps.map((step, k) => ({step, lane: L, k}))}));
    const out = [], used = new Set();
    const hall = lanes.find(L => L.kind === 'building' && L.label === '城镇大厅');
    out.push({key: 'B-hall', kind: 'bld', label: '城镇大厅', sub: '开局就有', prio: 0, order: -1, items: hall.steps.map((step, k) => ({step, lane: hall, k}))});
    lanes.filter(L => L.kind === 'peasant').forEach(L => L.steps.forEach((s, k) => {
      if (!/^建造/.test(s.body) || s.start == null) return;
      const what = s.body.split(' ')[1];
      let prod = s.tag ? lanes.find(x => x.kind === 'building' && x.label === '#' + s.tag) : null;
      if (!prod && LANE_OF_BUILDING[what]) prod = lanes.find(x => x.kind === 'building' && x.label === LANE_OF_BUILDING[what] && !used.has(x.id));
      if (prod) used.add(prod.id);
      out.push({key: 'B-' + L.id + '-' + k, kind: 'bld', label: what + (s.tag ? ' #' + s.tag : ''), sub: `${L.label} 建` + (s.done != null ? ` · ${fmt(s.done)} 完成` : ''), prio: L.prio, order: s.start,
        items: [{step: s, lane: L, k, build: L.label}].concat(prod ? prod.steps.map((step, j) => ({step, lane: prod, k: j})) : [])});
    }));
    return out.sort((a, b) => a.order - b.order);
  }
  const bneckRow = {key: 'BN', kind: 'bneck', label: '瓶颈', items: [], special: true};
  const divRow = {key: 'DIV', kind: 'divider', label: '', items: [], special: true};
  function buildRows() {
    rows = buildRowsSpec(); rowsEl.innerHTML = '';
    for (const R of [bneckRow, divRow, ...rows]) {
      const r = document.createElement('div'); r.className = 'row k-' + R.kind + (R.kind === 'bneck' ? ' bneck' : R.kind === 'divider' ? ' divider' : ''); r.dataset.key = R.key;
      if (R.kind === 'bneck') r.innerHTML = `<div class="lab"><b>瓶颈</b><small>卡人口·卡钱·空闲</small></div><div class="track"></div>`;
      else if (R.kind === 'divider') r.innerHTML = `<div class="lab">▲ 选中的单位 ・ 以下是其他轨道</div>`;
      else r.innerHTML = `<div class="lab">${R.kind === 'bld' ? '' : `<span class="prio" title="优先级：脚本里越靠前越先花钱">P${R.prio}</span>`}<b class="click" title="点一下选中，Ctrl/Shift 多选">${esc(R.label)}</b>${R.sub ? `<small>${esc(R.sub)}</small>` : ''}<span class="rank"></span><span class="state"></span>${R.lane && R.kind !== 'bld' ? `<button type="button" class="mute" data-mute="${R.lane.id}" title="这条线暂停执行（预演时跳过）">⏸</button>` : ''}</div><div class="track"></div>`;
      rowsEl.appendChild(r); R.el = r; R.stateEl = r.querySelector('.state'); R.rankEl = r.querySelector('.rank'); R.track = r.querySelector('.track');
    }
    drawBars(); buildFilters(); ghostKey = '';
  }
  function drawBars() {
    const w = END * pps();
    canvas.style.width = (LABEL() + w + 8) + 'px';
    bneckRow.track.style.width = w + 'px';
    bneckRow.track.innerHTML = bnecks.map(b => `<div class="bseg ${b.type}" style="left:${b.s * pps()}px;width:${Math.max(3, (b.e - b.s) * pps())}px" title="${esc(fmt(b.s) + ' ' + b.text)}"></div>`).join('');
    for (const R of rows) {
      R.track.style.width = w + 'px'; R.track.innerHTML = '';
      if (R.lane && R.kind === 'peasant') { const s0 = R.lane.steps.find(s => s.start != null); if (s0 && s0.start > 1) R.track.insertAdjacentHTML('beforeend', `<div class="birth" style="left:${s0.start * pps()}px" title="${fmt(s0.start)} 出生"></div>`); }
      for (const it of R.items) {
        const s = it.step; if (s.start == null) continue;
        const e = stepEnd(s) ?? s.start + 20, b = document.createElement('div');
        b.className = `bar c-${s.cls}${s.edited ? ' edited' : ''}${s.order ? ' order' : ''}${s.conflict ? ' conflict' : ''}`;
        b.dataset.lane = it.lane.id; b.dataset.step = it.k;
        b.style.left = s.start * pps() + 'px'; b.style.width = Math.max(6, (e - s.start) * pps()) + 'px';
        const wait = s.work != null ? Math.max(0, (s.work - s.start) * pps()) : 0;
        const text = it.build ? `建造 · ${it.build}` : s.body + (s.pos ? ' @' + s.pos : '') + (s.tag ? ' #' + s.tag : '');
        const d = s.orig && s.orig.start != null && s.start != null ? Math.round(s.start - s.orig.start) : 0;
        b.innerHTML = (wait ? `<div class="wait" style="width:${wait}px"></div>` : '') + (s.work != null ? `<div class="fill" style="left:${wait}px;width:0"></div>` : '') +
          `<div class="txt">${s.cond && !it.build ? '<em>[' + esc(s.cond) + ']</em>' : ''}<span>${esc(text)}</span>${d ? `<span class="delta ${d > 0 ? 'late' : 'early'}" title="和改之前比">${d > 0 ? '+' : ''}${d}s</span>` : ''}<em class="cd"></em></div>`;
        b.title = `${it.lane.label} 第 ${it.k + 1} 步：${s.raw}\n开始 ${fmt(s.start)}` + (s.work != null ? `，开工 ${fmt(s.work)}` : '') + (s.done != null ? `，完成 ${fmt(s.done)}` : '') + (d ? `\n改之前 ${fmt(s.orig.start)} 开始` : '');
        if (d) R.track.insertAdjacentHTML('beforeend', `<div class="origghost" style="left:${s.orig.start * pps()}px;width:${Math.max(6, ((s.orig.done ?? e - s.start + s.orig.start) - s.orig.start) * pps())}px" title="改之前的位置"></div>`);
        if (/^敲钟/.test(s.body)) R.track.insertAdjacentHTML('beforeend', `<div class="band mil" style="left:${(s.start + 3) * pps()}px;width:${45 * pps()}px" title="民兵 45 秒"></div>`);
        R.track.appendChild(b); it.el = b;
      }
      R.el.classList.toggle('muted', !!(R.lane && muted.has(R.lane.id)));
    }
    const ruler = $('ruler'); ruler.querySelectorAll('.tick').forEach(x => x.remove());
    const step = zoom >= 4 ? 10 : zoom >= 2 ? 30 : 60;
    for (let s = 0; s <= END; s += step) { const k = document.createElement('div'); k.className = 'tick'; k.style.left = X(s) + 'px'; k.textContent = fmt(s); ruler.appendChild(k); }
    drawRes(); drawFood(); ghostKey = ''; chainKey = '';
  }
  function svgIn(host) { let svg = host.querySelector('svg'); if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); host.appendChild(svg); } const w = END * pps(); svg.setAttribute('width', w); svg.style.left = LABEL() + 'px'; return {svg, w}; }
  function drawRes() {
    const {svg, w} = svgIn($('res')), h = 46, mg = E[E.length - 1][5] || 1, mw = E[E.length - 1][6] || 1;
    const line = (i, max) => E.filter((_, j) => j % 3 === 0).map(r => `${(r[0] * pps()).toFixed(1)},${(h - 4 - r[i] / max * (h - 10)).toFixed(1)}`).join(' ');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<polyline points="${line(5, mg)}" fill="none" stroke="var(--gold)" stroke-width="1.5" opacity=".85"/><polyline points="${line(6, mw)}" fill="none" stroke="var(--wood)" stroke-width="1.5" opacity=".85"/>`;
  }
  function drawFood() { // used vs cap, with the upkeep lines at 50 and 80
    const {svg, w} = svgIn($('foodStrip')), h = 40, max = 90, y = v => (h - 3 - v / max * (h - 6)).toFixed(1);
    const step = (i) => { let d = ''; let prev = null; for (const r of E.filter((_, j) => j % 2 === 0)) { const x = (r[0] * pps()).toFixed(1); d += prev == null ? `M${x},${y(r[i])}` : `H${x}V${y(r[i])}`; prev = r[i]; } return d; };
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<rect x="0" y="${y(80)}" width="${w}" height="${y(50) - y(80)}" fill="var(--warn)" opacity=".08"/><rect x="0" y="0" width="${w}" height="${y(80)}" fill="var(--bad)" opacity=".08"/>
      <line x1="0" x2="${w}" y1="${y(50)}" y2="${y(50)}" stroke="var(--warn)" stroke-dasharray="4 4" opacity=".7"/><line x1="0" x2="${w}" y1="${y(80)}" y2="${y(80)}" stroke="var(--bad)" stroke-dasharray="4 4" opacity=".7"/>
      <text x="4" y="${+y(50) - 2}" fill="var(--warn)" font-size="9">51 起 金 −30%</text><text x="4" y="${+y(80) - 2}" fill="var(--bad)" font-size="9">81 起 金 −60%</text>
      <path d="${step(4)}" fill="none" stroke="var(--team-2)" stroke-dasharray="3 3" opacity=".7"/><path d="${step(3)}" fill="none" stroke="var(--team-2)" stroke-width="1.6"/>`;
  }

  /* ---------- filters ---------- */
  const FILTERS = [['农民', R => R.kind === 'peasant'], ['采金·主矿', R => R.kind === 'peasant' && activity(R.lane, t) === '采金·主矿'], ['采金·分矿', R => R.kind === 'peasant' && activity(R.lane, t) === '采金·分矿'],
    ['伐木', R => R.kind === 'peasant' && activity(R.lane, t) === '伐木'], ['建造中', R => R.kind === 'peasant' && activity(R.lane, t) === '建造'],
    ['清野小组', R => R.kind === 'peasant' && R.lane.steps.some(s => /^敲钟/.test(s.body))], ['英雄', R => R.kind === 'hero'], ['部队', R => R.kind === 'army'], ['建筑生产', R => R.kind === 'building'],
    ['关键路径上', R => R.lane && chain.some(n => n.L === R.lane)]];
  function buildFilters() {
    const el = $('filters');
    if (view === 'bld') { el.innerHTML = '<span class="lbl">按建筑：每座建筑一条，按下令的先后排；先是谁去建、什么时候建好，然后是它生产的东西。</span>'; return; }
    el.innerHTML = '<span class="lbl">只看</span><button type="button" class="fchip ' + (filters.size ? '' : 'on') + '" data-f="">全部</button>' +
      FILTERS.map(([n]) => `<button type="button" class="fchip ${filters.has(n) ? 'on' : ''}" data-f="${n}">${n}<b></b></button>`).join('') +
      (groups.length ? '<span class="lbl gl">编队</span>' : '') + [...groups].sort((a, b) => (a.key || 9) - (b.key || 9)).map(g => `<button type="button" class="fchip gchip ${filters.has('g:' + g.name) ? 'on' : ''}" data-g="${esc(g.name)}" title="只看这个编队，并选中他们（按数字 ${g.key || ''} 也能选）">${g.key ? `<kbd>${g.key}</kbd>` : '◆ '}${esc(g.name)}<b>${g.cids.length}</b></button>`).join('');
  }
  $('filters').onclick = e => {
    const g = e.target.closest('[data-g]'); if (g) { const G = groups.find(x => x.name === g.dataset.g); if (G) { const f = 'g:' + G.name; filters.has(f) ? filters.delete(f) : filters.add(f); pick.clear(); if (filters.has(f)) G.cids.forEach(c => pick.add(c)); buildFilters(); syncOrder(); if (window.MAP) window.MAP.picked(); } return; }
    const b = e.target.closest('[data-f]'); if (!b) return;
    if (!b.dataset.f) filters.clear(); else filters.has(b.dataset.f) ? filters.delete(b.dataset.f) : filters.add(b.dataset.f);
    buildFilters();
  };
  const inGroup = R => groups.some(g => filters.has('g:' + g.name) && R.lane && g.cids.includes(cidOfLane(R.lane)));
  const visible = R => view === 'bld' || !filters.size || FILTERS.some(([n, f]) => filters.has(n) && f(R)) || inGroup(R) || isPicked(R);
  const isPicked = R => !!(R.lane && view === 'unit' && pick.has(cidOfLane(R.lane)));

  /* ---------- every frame ---------- */
  function status(R) {
    const {cur, next} = current(R.items, t);
    if (R.lane && muted.has(R.lane.id)) return {g: 5, cls: 'wait', text: '暂停执行'};
    if (cur) {
      const s = cur.step, waiting = s.work != null && t < s.work, e = stepEnd(s);
      return {g: 0, cur, cls: waiting ? 'wait' : 'act',
        text: waiting ? (cur.build ? cur.build + ' 走过去/等钱' : '等资源 · ' + s.body) : (cur.build ? '建造中' : s.body) + (e != null && !ongoing(s) ? ` · 剩 ${Math.ceil(e - t)}s` : '')};
    }
    if (next) return {g: next.step.start - t <= 30 ? 1 : 2, next, cls: '', text: `${Math.ceil(next.step.start - t)}s 后：${next.build ? '开始建' : next.step.body}`};
    return {g: 3, cls: '', text: R.kind === 'bld' ? '' : '这一行做完了'};
  }
  function tick() {
    const st = new Map(rows.map(R => [R, status(R)]));
    let shown = rows.filter(visible);
    const prioOrder = [...rows].sort((a, b) => st.get(a).g - st.get(b).g || (st.get(a).g === 1 ? st.get(a).next.step.start - st.get(b).next.step.start : 0) || a.prio - b.prio);
    if (byPrio && view === 'unit') shown = prioOrder.filter(R => shown.includes(R));
    const picked = shown.filter(isPicked);
    let order = shown;
    if (picked.length && pinPicked) order = [...picked, divRow, ...shown.filter(R => !isPicked(R))];
    order = [bneckRow, ...order];
    rows.forEach(R => R.el.classList.toggle('hide', !order.includes(R)));
    divRow.el.classList.toggle('hide', !order.includes(divRow));
    order.forEach((R, i) => { R.el.style.top = i * ROW + 'px'; R.y = i; });
    rowsEl.style.height = order.length * ROW + 'px';
    rowsEl.classList.toggle('dimmed', dimOthers && pick.size > 0);
    const x = X(t);
    $('nowline').style.left = x + 'px'; $('nowline').dataset.t = fmt(t); $('shade').style.left = LABEL() + 'px'; $('shade').style.width = (x - LABEL()) + 'px';
    $('clock').textContent = fmt(t); $('orderBtn').textContent = `在 ${fmt(t)} 下令`;
    canvas.querySelectorAll('.dot').forEach(d => d.remove());
    const top0 = rowsEl.offsetTop, rank = new Map(prioOrder.map((R, i) => [R, i + 1]));
    for (const R of order) {
      if (R.special) continue;
      const s0 = st.get(R); R.stateEl.textContent = s0.text; R.stateEl.className = 'state ' + s0.cls;
      R.el.classList.toggle('picked', isPicked(R));
      if (R.rankEl) R.rankEl.textContent = isPicked(R) && !pinPicked ? `第 ${rank.get(R)}/${rows.length}` : '';
      for (const it of R.items) {
        const s = it.step; if (!it.el) continue;
        const e = stepEnd(s), isNow = s.start <= t && (e == null || t < e), past = e != null && e <= t;
        it.el.classList.toggle('now', isNow); it.el.classList.toggle('past', past && !isNow); it.el.classList.toggle('future', s.start > t);
        it.el.classList.toggle('crit', critOn && onChain(it.lane, it.k));
        const fill = it.el.querySelector('.fill');
        if (fill && s.work != null && s.done != null) fill.style.width = Math.max(0, Math.min(1, (t - s.work) / (s.done - s.work))) * (s.done - s.work) * pps() + 'px';
        it.el.querySelector('.cd').textContent = isNow && e != null && !ongoing(s) ? '剩 ' + Math.ceil(e - t) + 's' : s.start > t && s.start - t <= 30 ? Math.ceil(s.start - t) + 's 后' : '';
        if (isNow) { const d = document.createElement('div'); d.className = 'dot'; d.style.left = x + 'px'; d.style.top = (top0 + R.y * ROW + ROW / 2) + 'px'; canvas.appendChild(d); }
      }
    }
    if (view === 'unit') $('filters').querySelectorAll('[data-f]').forEach(b => { const f = FILTERS.find(q => q[0] === b.dataset.f); if (f) b.querySelector('b').textContent = rows.filter(f[1]).length; });
    canvas.classList.toggle('critmode', critOn);
    drawGhosts(); drawArrows(order); hud(); sideLists(st);
  }
  let hudKey = '';
  function hud() {
    const i = at(t), r = E[i], k = Math.max(0, i - 30), rg = (r[5] - E[k][5]) / Math.max(1, i - k) * 60, rw = (r[6] - E[k][6]) / Math.max(1, i - k) * 60;
    if (i === hudKey) return; hudKey = i;
    const food = r[3], upk = food > 80 ? ['high', '高维持费：金 −60%'] : food > 50 ? ['low', '低维持费：金 −30%'] : ['none', '无维持费'];
    const mm = Math.round(D.mineGold - mined[i][0]), nm = Math.round(D.mineGold - mined[i][1]);
    const W = [['主矿', r[7], 'var(--gold)'], ['分矿', r[8], '#b89a2e'], ['伐木', r[9], 'var(--wood)'], ['建造', r[10], 'var(--team)'], ['民兵', r[11], 'var(--warn)'], ['空闲', r[12], 'var(--muted)']];
    const tot = W.reduce((a, w) => a + w[1], 0) || 1, toUpk = 51 - food;
    $('hud').innerHTML = `<div class="hcell gold"><h3>金 · ${fmt(t)}</h3><div class="big">${r[1]}</div><div class="sm">采集 <b>+${Math.round(rg)}</b>/分 · 累计 ${r[5]}</div></div>
      <div class="hcell wood"><h3>木</h3><div class="big">${r[2]}</div><div class="sm">采集 <b>+${Math.round(rw)}</b>/分 · 累计 ${r[6]}</div></div>
      <div class="hcell food"><h3>人口</h3><div class="big">${food}/${r[4]}</div><div class="sm">还能造 <b>${r[4] - food}</b><span class="upk ${upk[0]}" title="51–80 人口采到的金少 30%，81 以上少 60%">${upk[1]}</span>${toUpk > 0 && toUpk <= 8 ? ` · 再 ${toUpk} 人口进维持费` : ''}</div></div>
      <div class="hcell"><h3>金矿余量（估算）</h3><div class="sm">主矿 <b>${mm}</b> · ${r[7]}/5 人</div><div class="sm">分矿 <b>${mined[i][1] > 0 ? nm : '未开采'}</b> · ${r[8]}/5 人</div></div>
      <div class="hcell"><h3>农民在做什么</h3><div class="meter">${W.map(w => `<i style="width:${w[1] / tot * 100}%;background:${w[2]}" title="${w[0]} ${w[1]}"></i>`).join('')}</div>
        <div class="sm">${W.filter(w => w[1]).map(w => `${w[0]} <b>${w[1]}</b>`).join(' · ')}</div></div>
      <div class="hcell"><h3>整局损失（瓶颈轨道）</h3><div class="loss">卡人口 <b>${lossSum('food')}s</b> · 大厅空闲 <b>${lossSum('hall')}s</b></div><div class="loss">建筑等钱 <b>${lossSum('gold') + lossSum('wood')}s</b> · 农民空闲 <b>${lossSum('idle')}s</b></div></div>`;
  }
  let sideKey = '';
  function sideLists(st) {
    const vis = rows.filter(visible);
    const now = vis.filter(R => st.get(R).g === 0).sort((a, b) => a.prio - b.prio);
    const next = vis.filter(R => st.get(R).g === 1).sort((a, b) => st.get(a).next.step.start - st.get(b).next.step.start);
    const key = Math.floor(t) + '|' + view + '|' + now.map(R => R.key).join() + '|' + next.map(R => R.key).join();
    if (key === sideKey) return; sideKey = key;
    $('nowList').innerHTML = now.length ? now.map(R => {
      const it = st.get(R).cur, s = it.step, e = stepEnd(s), p = s.work != null && s.done != null ? Math.max(0, Math.min(1, (t - s.work) / (s.done - s.work))) : null, waiting = s.work != null && t < s.work;
      return `<div class="item c-${s.cls}" data-lane="${it.lane.id}" data-step="${it.k}"><span class="p">${R.kind === 'bld' ? '' : 'P' + R.prio}</span><span class="w">${esc(R.label)} · ${esc(it.build ? '建造中' : s.body)}</span>
        <span class="cd">${e != null && !ongoing(s) ? '剩 ' + Math.ceil(e - t) + 's' : '持续'}</span><span class="sub">${waiting ? '走过去 / 等资源' : p != null ? '进行中 ' + Math.round(p * 100) + '%' : '进行中'}${s.cond ? ' · 条件 [' + esc(s.cond) + ']' : ''}</span>
        ${p != null ? `<span class="pg"><i style="width:${p * 100}%"></i></span>` : ''}</div>`;
    }).join('') : '<div class="empty">没有正在做的事</div>';
    $('nextList').innerHTML = next.length ? next.map(R => {
      const n = st.get(R).next;
      return `<div class="item c-${n.step.cls}" data-lane="${n.lane.id}" data-step="${n.k}"><span class="p">${R.kind === 'bld' ? '' : 'P' + R.prio}</span><span class="w">${esc(R.label)} · ${esc(n.build ? '开始建' : n.step.body)}</span><span class="cd">${Math.ceil(n.step.start - t)}s 后</span>
        <span class="sub">${n.step.cond ? '等 [' + esc(n.step.cond) + ']' : '上一步做完就开始'}</span></div>`;
    }).join('') : '<div class="empty">30 秒内没有新的事</div>';
  }

  /* ---------- critical path: panel and arrows ---------- */
  function goalNode() { return GOALS[goalKey][1](); }
  function updateChain() {
    const g = goalNode(); chain = critOn ? chainTo(g) : [];
    const gt = g ? timeOf(g, g.field) : null, gs = g ? g.L.steps[g.k] : null, before = gs && gs.orig ? (g.field === 'done' ? gs.orig.done : gs.orig.start) : null;
    $('goalT').textContent = gt != null ? fmt(gt) + (before != null && Math.round(gt - before) ? ` （改之前 ${fmt(before)}，${gt > before ? '+' : ''}${Math.round(gt - before)}s）` : '') : '';
    const box = $('critBox'); box.hidden = !critOn;
    if (!critOn) return;
    box.innerHTML = `<h2>关键路径 · 决定「${esc(GOALS[goalKey][0])}」${gt != null ? fmt(gt) : ''} 的步骤</h2><div class="crit-list">${chain.map((n, i) => `<div data-lane="${n.L.id}" data-step="${n.k}"><span>${esc(n.L.label)} · ${esc(n.s.body)}</span><span class="t">${fmt(n.t)}</span>
      <span class="why">${n.why || ''}${n.inside > 8 && /^(建造|升级|农民)/.test(n.s.body) ? ` · 下令后 <b>${Math.round(n.inside)}s</b> 才开工（${econWhy(n.s.work - 2)}）` : ''}</span></div>`).join('')}</div>
      <p class="note" style="margin:6px 0 0">这串里任何一步晚 5 秒，目标就晚 5 秒；不在这串上的步骤（变暗的）晚一点不影响它。<b>橙色秒数</b>是白等的时间，最值得优化。</p>`;
  }
  function drawArrows(order) {
    const svg = $('arrows'), key = critOn + '|' + chain.map(n => n.L.id + n.k).join() + '|' + order.map(R => R.key).join() + '|' + pps();
    if (key === chainKey) return; chainKey = key;
    svg.setAttribute('width', canvas.scrollWidth); svg.setAttribute('height', canvas.scrollHeight);
    if (!critOn || view !== 'unit') { svg.innerHTML = ''; return; }
    const top0 = rowsEl.offsetTop, rowOf = L => order.find(R => R.lane === L);
    let h = '<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#fff"/></marker></defs>';
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i], ra = rowOf(a.L), rb = rowOf(b.L); if (!ra || !rb) continue;
      const x1 = X(a.t), y1 = top0 + ra.y * ROW + ROW / 2, x2 = X(b.s.start), y2 = top0 + rb.y * ROW + ROW / 2;
      if (ra === rb) continue;
      h += `<path d="M${x1},${y1} C${x1 + 30},${y1} ${x2 - 30},${y2} ${x2},${y2}" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="5 3" marker-end="url(#ah)" opacity=".85"/>`;
    }
    svg.innerHTML = h;
  }
  $('crit').onclick = () => { critOn = !critOn; $('crit').setAttribute('aria-checked', critOn); updateChain(); buildFilters(); if (critOn) toast('关键路径：亮的是决定这个目标时间的那串步骤，箭头是「谁在等谁」，橙色秒数是白等的时间。换目标在右边下拉。'); };
  $('goal').innerHTML = Object.entries(GOALS).map(([k, g]) => `<option value="${k}">${g[0]}</option>`).join('');
  $('goal').onchange = e => { goalKey = e.target.value; updateChain(); };
  $('critBox').addEventListener('click', e => { const it = e.target.closest('[data-lane]'); if (!it) return; const L = lanes.find(x => x.id === it.dataset.lane), s = L.steps[+it.dataset.step]; scroll.scrollLeft = Math.max(0, X(s.start) - LABEL() - 80); t = s.start; });

  /* ---------- time ---------- */
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (playing) { t = Math.min(END, t + dt * speed); if (t >= END) { playing = false; $('play').textContent = '▶ 重播'; } follow(); }
    tick();
  }
  function follow() { const x = X(t), w = scroll.clientWidth; if (x > scroll.scrollLeft + w - 120 || x < scroll.scrollLeft + LABEL()) scroll.scrollLeft = Math.max(0, x - LABEL() - 120); }
  $('play').onclick = () => { if (t >= END) t = 0; playing = !playing; $('play').textContent = playing ? '❚❚ 暂停' : '▶ 播放'; };
  document.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => { speed = +b.dataset.speed; document.querySelectorAll('[data-speed]').forEach(x => x.classList.toggle('on', x === b)); });
  function scrubFrom(e) {
    e.preventDefault(); playing = false; $('play').textContent = '▶ 播放'; document.body.classList.add('scrubbing');
    const move = q => { const r = canvas.getBoundingClientRect(); t = Math.max(0, Math.min(END, (q.clientX - r.left - LABEL()) / pps()));
      const sr = scroll.getBoundingClientRect(); if (q.clientX > sr.right - 30) scroll.scrollLeft += 12; else if (q.clientX < sr.left + LABEL() + 20) scroll.scrollLeft -= 12; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('scrubbing'); if (!$('orderBox').hidden) { ord.T = Math.round(t); renderOrder(); } };
    move(e); addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
  $('nowline').addEventListener('pointerdown', scrubFrom);
  $('ruler').addEventListener('pointerdown', scrubFrom);
  $('res').addEventListener('pointerdown', scrubFrom);
  $('foodStrip').addEventListener('pointerdown', scrubFrom);
  document.addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); t = Math.max(0, Math.min(END, Math.round(t) + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1))); follow(); if (!$('orderBox').hidden) { ord.T = Math.round(t); renderOrder(); } }
    if (e.key === 'Escape') { closePop(); closeOrder(); }
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  });
  $('prio').onclick = () => { byPrio = !byPrio; $('prio').setAttribute('aria-checked', byPrio); toast(byPrio ? '按优先级排序：此刻在做的事按优先级排在最上面，快开始的跟在后面，做完的沉到底。' : '按脚本顺序排列'); };
  $('view').onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; view = b.dataset.v; $('view').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); buildRows(); };
  function setZoom(z, cx) {
    const r = scroll.getBoundingClientRect(), mx = (cx == null ? r.left + r.width / 2 : cx) - r.left, sec = (scroll.scrollLeft + mx - LABEL()) / pps();
    zoom = Math.max(1, Math.min(8, z)); drawBars(); scroll.scrollLeft = Math.max(0, LABEL() + sec * pps() - mx);
  }
  $('zin').onclick = () => setZoom(zoom * 1.5); $('zout').onclick = () => setZoom(zoom / 1.5); $('zfit').onclick = () => setZoom(1);
  scroll.addEventListener('wheel', e => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); setZoom(zoom * Math.min(1.15, Math.max(1 / 1.15, Math.exp(-e.deltaY * 0.002))), e.clientX); }, {passive: false});
  addEventListener('resize', () => drawBars());
  let toastT = 0;
  function toast(msg) { const el = $('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 5200); }

  /* ---------- picking units: lane names, box, groups ---------- */
  rowsEl.addEventListener('click', e => {
    const m = e.target.closest('[data-mute]');
    if (m) { const id = m.dataset.mute; muted.has(id) ? muted.delete(id) : muted.add(id); drawBars(); window.dispatchEvent(new CustomEvent('script-edited')); toast(muted.has(id) ? `${lanes.find(L => L.id === id).label} 这条线暂停执行：预演和实战都跳过它（像剪辑软件里静音一条轨道）。` : '恢复执行'); return; }
    const nameEl = e.target.closest('.lab b.click'); if (!nameEl) return;
    const R = rows.find(x => x.key === nameEl.closest('.row').dataset.key); if (!R || !R.lane) return;
    const c = cidOfLane(R.lane); if (c == null || Number.isNaN(c)) { toast('建筑那一行请在「按建筑」里看；下令选的是单位'); return; }
    if (e.ctrlKey || e.metaKey || e.shiftKey) pick.has(c) ? pick.delete(c) : pick.add(c);
    else { const only = pick.size === 1 && pick.has(c); pick.clear(); if (!only) pick.add(c); }
    syncOrder(); if (window.MAP) window.MAP.focusPicked();
  });
  canvas.addEventListener('pointerdown', e => { // box select on empty track space
    if (e.button !== 0 || e.target.closest('.bar') || e.target.closest('.lab') || e.target.closest('.nowline') || !e.target.closest('.rows')) return;
    const r0 = canvas.getBoundingClientRect(), x0 = e.clientX - r0.left, y0 = e.clientY - r0.top, box = document.createElement('div'); box.className = 'boxsel'; canvas.appendChild(box);
    let moved = false;
    const mv = q => { const x = q.clientX - r0.left, y = q.clientY - r0.top; if (Math.hypot(x - x0, y - y0) > 6) moved = true;
      Object.assign(box.style, {left: Math.min(x, x0) + 'px', top: Math.min(y, y0) + 'px', width: Math.abs(x - x0) + 'px', height: Math.abs(y - y0) + 'px'}); };
    const up = q => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); box.remove();
      if (!moved) return;
      const y1 = Math.min(q.clientY - r0.top, y0), y2 = Math.max(q.clientY - r0.top, y0), top0 = rowsEl.offsetTop;
      const hit = rows.filter(R => !R.el.classList.contains('hide') && R.lane && top0 + R.y * ROW + ROW > y1 && top0 + R.y * ROW < y2);
      if (!(q.ctrlKey || q.metaKey || q.shiftKey)) pick.clear();
      hit.forEach(R => { const c = cidOfLane(R.lane); if (c != null && !Number.isNaN(c)) pick.add(c); });
      syncOrder(); toast(`框选了 ${pick.size} 个单位`);
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  function syncOrder() { ghostKey = ''; if ($('orderBox').hidden && pick.size) openOrder(t, null); else renderOrder(); }

  /* ---------- the order window ---------- */
  const ord = {T: 0, cmd: null, what: '农场', place: '农场3', target: '0', mode: 'override', when: 'now', whenTag: '分基地'};
  const PLACE = n => n === '主矿' ? D.mine : n === '分矿' ? D.natural : n === '城镇大厅' ? D.hall : D.places[n];
  function unitsAt(T) { return Object.keys(D.pos).map(Number).filter(c => posAt(c, T)).sort((a, b) => a - b).map(c => ({cid: c, type: unitType(c), lane: laneOfCid(c)})); }
  const uname = u => u.type === 'hpea' ? '农民' + u.cid : u.type === 'Hamg' ? '大法师' : u.type === 'Hmkg' ? '山丘之王' : (u.lane ? u.lane.label : '步兵');
  function openOrder(T, cids) { ord.T = Math.round(T); if (cids) { pick.clear(); cids.forEach(c => pick.add(c)); } $('orderBox').hidden = false; renderOrder(); }
  function closeOrder() { $('orderBox').hidden = true; ord.cmd = null; ghostKey = ''; }
  function commandsFor(us) {
    const p = us.length && us.every(u => u.type === 'hpea'), c = [];
    if (p) c.push(['gold-main', '采金 主矿', 'gold'], ['gold-nat', '采金 分矿', 'gold'], ['wood', '伐木', 'wood'], ['build', '建造…', 'build'], ['assist', '协助…', 'assist'], ['bell', '敲钟变民兵', 'bell']);
    if (us.length) c.push(['move', '移动到…', 'wait'], ['attack', '攻击移动到…', 'fight'], ['clear', '去分矿清野', 'fight'], ['hold', '待命', 'wait']);
    return c;
  }
  function builds() { const out = []; lanes.forEach(L => L.steps.forEach((s, k) => { if (/^建造/.test(s.body) && s.start != null) out.push({L, k, s, label: `${s.body.split(' ')[1]}${s.tag ? ' #' + s.tag : ''} · ${L.label} · ${fmt(s.start)} 开始`}); })); return out; }
  const tags = () => [...new Set(lanes.flatMap(L => L.steps.map(s => s.tag)).filter(Boolean))];
  function startTimeFor(u, cost) { // 什么时候开始 + 覆盖/排队 → when this unit begins
    let S = ord.T;
    if (ord.mode === 'queue' && u.lane) { const cur = current(u.lane.steps.map(step => ({step})), ord.T).cur; if (cur && !ongoing(cur.step)) S = Math.max(S, stepEnd(cur.step) ?? S); }
    if (ord.when === 'started' || ord.when === 'done') { const n = findTag(ord.whenTag); if (n) S = Math.max(S, timeOf(n, ord.when === 'started' ? 'work' : 'done')); }
    if (ord.when === 'money' && cost) { let i = at(S); while (i < E.length - 1 && (E[i][1] < cost[0] || E[i][2] < cost[1])) i++; S = Math.max(S, E[i][0]); }
    return S;
  }
  function condText(cost) {
    const q = ord.mode === 'queue' ? '（排队：手上的做完再做）' : '';
    if (ord.when === 'started' || ord.when === 'done') return `[#${ord.whenTag} ${ord.when === 'started' ? '开工' : '完成'}]` + q;
    if (ord.when === 'money') return cost ? `[金≥${cost[0]}${cost[1] ? ' 木≥' + cost[1] : ''}]` + q : q;
    return `[${fmt(ord.T)} 出发]` + q;
  }
  /* a building others help with needs a name (#): give it one the first time */
  function tagOf(s) {
    if (s.tag) return s.tag;
    const what = s.body.split(' ')[1] || '建筑', taken = new Set(lanes.flatMap(L => L.steps.map(x => x.tag)).filter(Boolean));
    let n = 1; while (taken.has(what + n)) n++;
    s.tag = what + n; s.raw = `${s.cond ? '[' + s.cond + '] ' : ''}${s.body}${s.pos ? ' @' + s.pos : ''} #${s.tag}`; return s.tag;
  }
  function planOrder() {
    const us = unitsAt(ord.T).filter(u => pick.has(u.cid)), res = [], n = us.length;
    const cost = ord.cmd === 'build' ? COST[ord.what] : null;
    us.forEach((u, i) => {
      const T = startTimeFor(u, i === 0 ? cost : null), p = posAt(u.cid, T) || posAt(u.cid, ord.T), sp = SPEED[u.type] || 270;
      let target = null, work = 0, body = '', pos = '', on = false, note = '';
      switch (ord.cmd) {
        case 'gold-main': target = D.mine; body = '采金 主矿'; on = true; break;
        case 'gold-nat': target = D.natural; body = '采金 分矿'; on = true; break;
        case 'wood': target = ord.woodAt || [D.hall[0] - 500, D.hall[1] + 400]; body = dist(target, D.natural) < 1500 ? '伐木 分矿' : '伐木 主矿'; on = true; break;
        case 'attack': target = PLACE(ord.place); pos = ord.place; body = '攻击移动'; break;
        case 'build': target = PLACE(ord.place); pos = ord.place; body = (i === 0 ? '建造 ' : '协助 ') + ord.what; work = (BUILD[ord.what] || 60) * ASSIST[Math.min(n, 5) - 1]; if (i > 0) note = `帮 ${uname(us[0])} 一起建`; break;
        case 'assist': { const b = builds()[+ord.target]; if (b) { target = b.s.at || PLACE(b.s.pos) || D.hall; body = '协助 #' + tagOf(b.s); work = Math.max(5, (b.s.done ?? T + 30) - T); note = '建好为止'; } break; }
        case 'bell': target = D.hall; body = '敲钟'; work = 45; note = '变民兵 45 秒'; break;
        case 'move': target = PLACE(ord.place); pos = ord.place; body = '移动'; break;
        case 'clear': target = D.natural; body = '清野'; pos = '分矿'; work = 40; note = '估计 40 秒'; break;
        case 'hold': target = PLACE(ord.place); pos = ord.place; body = '待命'; on = true; break;
      }
      if (!body || !p) return;
      const walk = target ? Math.round(dist(p, target) / sp) : 0, L = u.lane;
      const nextFixed = L ? L.steps.filter(s => s.start != null && s.start > T && !ongoing(s)).sort((a, b) => a.start - b.start)[0] : null;
      const end = on ? (nextFixed ? nextFixed.start : END) : T + walk + work;
      const cur = L ? current(L.steps.map(step => ({step})), T).cur : null;
      const was = cur && ongoing(cur.step) ? cur.step : null, wasEnd = was ? stepEnd(was) : null;
      const bump = L ? L.steps.filter(s => s.start != null && !ongoing(s) && s.start < end && (stepEnd(s) ?? s.start) > T) : [];
      res.push({u, L, T, body, pos, walk, work, end, on, note, was, wasEnd, bump, from: p, target});
    });
    return res;
  }
  let ghostKey = '';
  function drawGhosts() { // the order before it is given: dashed bars on the picked lanes, what it bumps in red
    const plan = !$('orderBox').hidden && ord.cmd ? planOrder() : [];
    const key = JSON.stringify(plan.map(p => [p.u.cid, p.T, p.end, p.body, p.walk])) + pps() + view;
    if (key === ghostKey) return; ghostKey = key;
    canvas.querySelectorAll('.bar.ghost').forEach(g => g.remove()); canvas.querySelectorAll('.bar.bumped').forEach(b => b.classList.remove('bumped'));
    for (const p of plan) {
      const R = rows.find(x => x.lane === p.L); if (!R) continue;
      const g = document.createElement('div'); g.className = 'bar ghost';
      g.style.left = p.T * pps() + 'px'; g.style.width = Math.max(8, (p.end - p.T) * pps()) + 'px';
      g.innerHTML = (p.walk ? `<div class="wait" style="width:${p.walk * pps()}px;--c:#fff"></div>` : '') + `<div class="txt"><span>预览：${esc(p.body)}${p.pos ? ' @' + esc(p.pos) : ''}</span><em>${fmt(p.T)}–${fmt(p.end)}</em></div>`;
      R.track.appendChild(g);
      if (p.was && !p.on && p.wasEnd > p.end) { const b = document.createElement('div'); b.className = 'bar ghost back'; b.style.left = p.end * pps() + 'px'; b.style.width = Math.max(8, (Math.min(p.wasEnd, p.end + 120) - p.end) * pps()) + 'px'; b.innerHTML = `<div class="txt"><span>回去${esc(p.was.body)}</span></div>`; R.track.appendChild(b); }
      for (const s of p.bump) { const it = R.items.find(x => x.step === s); if (it && it.el) it.el.classList.add('bumped'); }
    }
  }
  function renderOrder() {
    if ($('orderBox').hidden) return;
    const us = unitsAt(ord.T), sel = us.filter(u => pick.has(u.cid)), cmds = commandsFor(sel);
    if (ord.cmd && !cmds.some(c => c[0] === ord.cmd)) ord.cmd = null;
    const groupsU = [['农民', us.filter(u => u.type === 'hpea' || u.type === 'hmil')], ['英雄', us.filter(u => /^H/.test(u.type))], ['部队', us.filter(u => u.type === 'hfoo')]];
    const needPlace = ['build', 'move', 'hold', 'attack'].includes(ord.cmd), places = Object.keys(D.places), plan = ord.cmd ? planOrder() : [];
    const cost = ord.cmd === 'build' ? COST[ord.what] : null;
    $('orderBox').innerHTML = `<div class="ttl">在 <input id="oT" value="${fmt(ord.T)}" aria-label="下令时刻"> 下令<button class="btn" type="button" data-o="close" aria-label="关闭">×</button></div>
      <div class="row3"><label class="sw2"><input type="checkbox" id="oPin" ${pinPicked ? 'checked' : ''}>选中的挤到最前面</label><label class="sw2"><input type="checkbox" id="oDim" ${dimOthers ? 'checked' : ''}>其他轨道变暗</label></div>
      <div class="sub">选单位（这一刻在做什么） · 已选 ${sel.length}</div>
      ${groupsU.filter(g => g[1].length).map(([n, list]) => `<div class="uchips">${list.map(u => `<button type="button" class="uchip ${pick.has(u.cid) ? 'on' : ''}" data-u="${u.cid}">${esc(uname(u))}<small>${esc(activity(u.lane, ord.T))}</small></button>`).join('')}</div>`).join('')}
      <div class="quick"><button type="button" data-q="采金·主矿">采金的</button><button type="button" data-q="伐木">伐木的</button><button type="button" data-q="空闲">空闲的</button><button type="button" data-q="清野小组">清野小组</button><button type="button" data-q="">清空</button>
        ${groups.map(g => `<button type="button" data-grp="${esc(g.name)}">◆ ${esc(g.name)}</button>`).join('')}</div>
      <div class="row3"><input class="gname" id="oGname" placeholder="编队名" aria-label="编队名"><button class="btn" type="button" data-o="savegrp" ${sel.length ? '' : 'disabled'}>存为编队</button></div>
      <div class="sub">做什么</div>
      ${cmds.length ? `<div class="cmds">${cmds.map(([k, n, c]) => `<button type="button" class="c-${c} ${ord.cmd === k ? 'on' : ''}" data-c="${k}">${n}</button>`).join('')}</div>` : '<div class="empty">先选单位：点上面的名字，或在时间轴上点轨道名、框选轨道</div>'}
      ${ord.cmd === 'build' ? `<select id="oWhat">${Object.keys(BUILD).map(b => `<option ${b === ord.what ? 'selected' : ''}>${b}</option>`).join('')}</select>` : ''}
      ${needPlace ? `<select id="oPlace">${places.map(p => `<option ${p === ord.place ? 'selected' : ''}>${p}</option>`).join('')}</select>` : ''}
      ${ord.cmd === 'assist' ? `<select id="oTarget">${builds().map((b, i) => `<option value="${i}" ${String(i) === ord.target ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}</select>` : ''}
      ${ord.cmd ? `<div class="sub">怎么下</div><div class="radio">${[['override', '覆盖：打断手上的事'], ['queue', '排队：手上的做完再做（Shift）']].map(([k, n]) => `<button type="button" data-mode="${k}" class="${ord.mode === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="sub">什么时候开始</div><div class="radio">${[['now', '此刻 ' + fmt(ord.T)], ['started', '某建筑开工后'], ['done', '某建筑完成后'], ['money', cost ? `钱够了（金${cost[0]} 木${cost[1]}）` : '钱够了']].map(([k, n]) => `<button type="button" data-when="${k}" class="${ord.when === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        ${ord.when === 'started' || ord.when === 'done' ? `<select id="oWhenTag">${tags().map(g => `<option ${g === ord.whenTag ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>` : ''}` : ''}
      ${plan.length ? `<div class="sub">预计（时间轴上的白色虚线条就是它）</div><div class="plan">${plan.map(p => `<div><b>${esc(uname(p.u))}</b><span class="w">${fmt(p.T)} 开始 · 走 ${p.walk}s${p.work ? ' + ' + Math.round(p.work) + 's' : ''} → ${p.on ? '一直做到 ' + fmt(p.end) : fmt(p.end) + ' 做完'}</span>${p.note ? `<span class="w">${esc(p.note)}</span>` : ''}</div>` +
        (p.bump.length ? `<div class="bad">会和他原来的「${esc(p.bump.map(s => s.body).join('、'))}」重叠（红框）</div>` : '') + (p.was && !p.on ? `<div class="w">做完回去「${esc(p.was.body)}」</div>` : '')).join('')}</div>
        <div class="w" style="font-size:11.5px;color:var(--muted)">写进脚本：${esc(condText(cost))} ${esc(plan[0].body)}${plan[0].pos ? ' @' + esc(plan[0].pos) : ''}</div>` : ''}
      <button type="button" class="go" data-o="go" ${plan.length ? '' : 'disabled'}>下令（${plan.length} 个单位）</button>`;
    ghostKey = '';
  }
  $('orderBtn').onclick = () => openOrder(t, null);
  $('orderBox').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.o === 'close') { closeOrder(); return; }
    if (b.dataset.u) { const c = +b.dataset.u; pick.has(c) ? pick.delete(c) : pick.add(c); renderOrder(); return; }
    if (b.dataset.q != null) {
      const us = unitsAt(ord.T); pick.clear();
      if (b.dataset.q) us.filter(u => u.type === 'hpea' && (b.dataset.q === '清野小组' ? u.lane && u.lane.steps.some(s => /^敲钟/.test(s.body)) : activity(u.lane, ord.T) === b.dataset.q)).forEach(u => pick.add(u.cid));
      renderOrder(); return;
    }
    if (b.dataset.grp) { const G = groups.find(x => x.name === b.dataset.grp); pick.clear(); G.cids.forEach(c => pick.add(c)); renderOrder(); return; }
    if (b.dataset.o === 'savegrp') { const nm = ($('oGname').value || '').trim() || '编队' + (groups.length + 1); groups = groups.filter(g => g.name !== nm).concat([{name: nm, cids: [...pick]}]); saveGroups(); buildFilters(); renderOrder(); toast(`存了编队「${nm}」（${pick.size} 个单位），上面的筛选条和这里都能一键选中`); return; }
    if (b.dataset.c) { ord.cmd = b.dataset.c; renderOrder(); return; }
    if (b.dataset.mode) { ord.mode = b.dataset.mode; renderOrder(); return; }
    if (b.dataset.when) { ord.when = b.dataset.when; if (!tags().includes(ord.whenTag)) ord.whenTag = tags()[0]; renderOrder(); return; }
    if (b.dataset.o === 'go') giveOrder();
  });
  $('orderBox').addEventListener('change', e => {
    const id = e.target.id;
    if (id === 'oWhat') ord.what = e.target.value;
    if (id === 'oPlace') ord.place = e.target.value;
    if (id === 'oTarget') ord.target = e.target.value;
    if (id === 'oWhenTag') ord.whenTag = e.target.value;
    if (id === 'oPin') pinPicked = e.target.checked;
    if (id === 'oDim') dimOthers = e.target.checked;
    if (id === 'oT') { const v = parseT(e.target.value); if (v != null) { ord.T = Math.min(END - 1, v); t = ord.T; } }
    if (id !== 'oGname') renderOrder();
  });
  function giveOrder() {
    const plan = planOrder(), cost = ord.cmd === 'build' ? COST[ord.what] : null, ct = condText(cost).replace(/（.*）$/, '');
    for (const p of plan) {
      if (!p.L) continue;
      const step = {raw: `${ct} ${p.body}${p.pos ? ' @' + p.pos : ''}`.trim(), ...split(`${p.body}${p.pos ? ' @' + p.pos : ''}`), cond: ct.replace(/^\[|\]$/g, ''), start: p.T, end: p.end, order: true, edited: true, orig: null};
      if (p.work) { step.work = p.T + p.walk; step.done = p.end; }
      for (const s of p.bump) s.conflict = true;
      if (p.from && p.target) (overrides[p.u.cid] = overrides[p.u.cid] || []).push({t0: p.T, t1: p.on ? p.end : p.end, walk: Math.max(0.5, p.walk), from: p.from, to: p.target});
      const st = p.L.steps, cur = current(st.map(x => ({step: x})), p.T).cur;
      let i = st.findIndex(s => s.start != null && s.start > p.T); if (i < 0) i = st.length;
      if (cur && ongoing(cur.step)) {
        const origEnd = stepEnd(cur.step); cur.step.end = p.T; cur.step.done = null;
        if (!p.on && origEnd > p.end) st.splice(i, 0, {...cur.step, start: p.end, end: origEnd, el: null, edited: true, orig: null});
      }
      st.splice(i, 0, step);
    }
    toast(`${plan.map(p => uname(p.u)).join('、')} → ${plan[0] ? plan[0].body : ''}，写进脚本「${ct} …」。`); window.dispatchEvent(new CustomEvent('script-edited'));
    ord.cmd = null; ord.woodAt = null; buildRows(); if (critOn) updateChain(); renderOrder(); markStale(Math.min(...plan.map(p => p.T)));
    return plan;
  }
  /* an order changes everything after it: mark that part as being recomputed (the real one resumes the
     preview from a save point at that moment, a few seconds in the background) */
  let staleT = null;
  function markStale(T) { return; // v5: the budget recomputes at once

    let el = $('stale'); if (!el) { el = document.createElement('div'); el.id = 'stale'; el.className = 'stale'; canvas.appendChild(el); }
    el.style.left = X(T) + 'px'; el.style.width = (X(END) - X(T)) + 'px'; el.style.top = rowsEl.offsetTop + 'px'; el.style.height = rowsEl.offsetHeight + 'px';
    el.innerHTML = `<span>从 ${fmt(T)} 的存档点重新计算中…</span>`; el.hidden = false; clearTimeout(staleT);
    staleT = setTimeout(() => { el.hidden = true; toast(`${fmt(T)} 之后已更新（原型用估算；真实版从 ${fmt(T)} 的存档点接着跑假游戏，约 3–5 秒）`); }, 2600);
  }
  canvas.addEventListener('dblclick', e => {
    const row = e.target.closest('.row'); if (!row) return;
    const r = canvas.getBoundingClientRect(), T = Math.max(0, Math.min(END - 1, (e.clientX - r.left - LABEL()) / pps())), R = rows.find(x => x.key === row.dataset.key);
    t = T; const cid = R && R.lane ? cidOfLane(R.lane) : null;
    openOrder(T, cid != null && !Number.isNaN(cid) && posAt(cid, T) ? [cid] : null);
  });

  /* ---------- editing a bar ---------- */
  canvas.addEventListener('pointerdown', e => {
    const b = e.target.closest('.bar'); if (!b || b.classList.contains('ghost') || e.button !== 0 || e.detail > 1) return;
    const L = lanes.find(x => x.id === b.dataset.lane), k = +b.dataset.step, s = L.steps[k], x0 = e.clientX, y0 = e.clientY, left0 = b.offsetLeft;
    let moved = false, target = L, ghost = null;
    b.setPointerCapture(e.pointerId);
    const mv = q => {
      const dx = q.clientX - x0, dy = q.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true; b.classList.add('drag'); b.style.left = (left0 + dx) + 'px'; b.style.transform = `translateY(${dy}px)`;
      const nt = Math.max(0, Math.min(END - 1, (left0 + dx) / pps()));
      if (!ghost) { ghost = document.createElement('div'); ghost.className = 'ghost-t'; b.appendChild(ghost); }
      ghost.textContent = '最早 ' + fmt(nt); ghost.style.left = '0';
      const rr = rowsEl.getBoundingClientRect(), yi = Math.floor((q.clientY - rr.top) / ROW), over = rows.find(x => !x.el.classList.contains('hide') && x.y === yi);
      rows.forEach(x => x.el.classList.toggle('droprow', x === over && x.lane && x.lane !== L && x.lane.kind === L.kind));
      target = view === 'unit' && over && over.lane && over.lane.kind === L.kind ? over.lane : L;
    };
    const up = q => {
      b.removeEventListener('pointermove', mv); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up);
      rows.forEach(x => x.el.classList.remove('droprow'));
      if (!moved) { openEditor(L, k, q); return; }
      const nt = Math.round(Math.max(0, Math.min(END - 1, (left0 + q.clientX - x0) / pps())));
      if (target !== L) moveStep(L, k, target, nt); else retime(L, k, nt);
      drawBars(); if (critOn) updateChain();
    };
    b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  });
  function setCond(s, nt) { const terms = condTerms(s.cond).filter(x => !/^\d+:\d{2}(\s*出发)?$/.test(x)); s.cond = [fmt(nt) + ' 出发', ...terms].join(' 且 '); s.raw = `[${s.cond}] ${s.body}${s.pos ? ' @' + s.pos : ''}${s.tag ? ' #' + s.tag : ''}`; s.edited = true; window.dispatchEvent(new CustomEvent('script-edited')); }
  function retime(L, k, nt) {
    const s = L.steps[k], d = nt - s.start; if (!d) return;
    setCond(s, nt);
    const shift = new Set([s]);
    for (const x of L.steps.slice(k)) shift.add(x);
    // whatever waits on this step (its #name) moves with it: a crude stand-in for the real re-preview
    if (s.tag) for (const M of lanes) M.steps.forEach((x, j) => { if (condTerms(x.cond).some(c => c.startsWith('#' + s.tag))) M.steps.slice(j).forEach(y => shift.add(y)); });
    for (const x of shift) for (const f of ['start', 'end', 'work', 'done']) if (x[f] != null) x[f] = Math.max(0, x[f] + d);
    if (k > 0 && L.steps[k - 1].end != null) L.steps[k - 1].end = s.start;
    toast(`「${s.body}」改成最早 ${fmt(nt)}（条件 [${fmt(nt)}]）。等它的步骤一起平移了；打开「关键路径」看目标晚了多少。真实版会重新预演。`);
  }
  function moveStep(L, k, T, nt) {
    const [s] = L.steps.splice(k, 1); const dur = (stepEnd(s) ?? s.start + 20) - s.start; setCond(s, nt);
    for (const f of ['work', 'done']) if (s[f] != null) s[f] = s[f] - s.start + nt;
    s.start = nt; s.end = nt + dur;
    let i = T.steps.findIndex(x => x.start != null && x.start > nt); if (i < 0) i = T.steps.length;
    T.steps.splice(i, 0, s);
    toast(`「${s.body}」从 ${L.label} 改派给 ${T.label}，最早 ${fmt(nt)}。`);
  }
  function openEditor(L, k, ev) {
    sel = {L, k}; const s = L.steps[k], pop = $('pop');
    pop.innerHTML = `<div class="ttl">${esc(L.label)} · 第 ${k + 1} 步<button class="btn" type="button" data-x="close" aria-label="关闭">×</button></div>
      <label>条件<span class="chips">${s.cond ? condTerms(s.cond).map(c => `<span class="chip">${esc(c)}</span>`).join('') : '<span class="hint">上一步做完马上开始</span>'}</span></label>
      <label>整步<input id="pRaw" value="${esc(s.raw)}"></label>
      <div class="hint">开始 ${fmt(s.start)}${s.work != null ? ' · 开工 ' + fmt(s.work) : ''}${s.done != null ? ' · 完成 ' + fmt(s.done) : ''}${s.order ? ' · 这是你下的令' : ''}${s.orig && s.orig.start != null && s.orig.start !== s.start ? ` · 改之前 ${fmt(s.orig.start)}` : ''}</div>
      <div class="row2"><button class="btn" type="button" data-x="apply">改好了</button><button class="btn bad" type="button" data-x="del">删除这一步</button></div>
      <div class="hint">和「战术脚本」里点卡片打开的是同一个编辑框（那边是完整版：做什么、帮谁、条件、也派给）。</div>`;
    pop.hidden = false;
    const r = pop.getBoundingClientRect();
    pop.style.left = Math.min(innerWidth - r.width - 16, Math.max(16, ev.clientX + 12)) + 'px'; pop.style.top = Math.min(innerHeight - r.height - 16, Math.max(16, ev.clientY + 12)) + 'px';
  }
  $('pop').addEventListener('click', e => {
    const a = e.target.closest('[data-x]'); if (!a || !sel) return;
    const {L, k} = sel, s = L.steps[k];
    if (a.dataset.x === 'close') closePop();
    else if (a.dataset.x === 'del') { L.steps.splice(k, 1); closePop(); buildRows(); toast(`删掉了 ${L.label} 的「${s.body}」`); }
    else if (a.dataset.x === 'apply') { const raw = $('pRaw').value.trim(); Object.assign(s, split(raw), {raw, edited: true}); closePop(); drawBars(); }
  });
  function closePop() { $('pop').hidden = true; sel = null; }
  document.addEventListener('pointerdown', e => { if (!$('pop').hidden && !e.target.closest('#pop') && !e.target.closest('.bar')) closePop(); });
  for (const id of ['nowList', 'nextList']) $(id).addEventListener('click', e => {
    const it = e.target.closest('.item'); if (!it) return;
    const L = lanes.find(x => x.id === it.dataset.lane), s = L.steps[+it.dataset.step];
    scroll.scrollLeft = Math.max(0, X(s.start) - LABEL() - 80); openEditor(L, +it.dataset.step, e);
  });

  /* the map (map4.js) drives the same orders and reads the same time */
  let placeN = 1;
  function load(nd) {
    for (const k of Object.keys(D)) delete D[k];
    Object.assign(D, nd); END = nd.end || 600; E = D.eco;
    for (const k of Object.keys(overrides)) delete overrides[k];
    buildLanes(); computeMined(); computeBnecks();
    t = Math.max(0, Math.min(END, t)); buildRows(); buildFilters(); if (critOn) updateChain();
  }
  window.TL = {
    load, get E() { return E; }, get END() { return END; },
    get t() { return t; }, set t(v) { t = Math.max(0, Math.min(END, v)); follow(); }, get playing() { return playing; },
    stop() { playing = false; $('play').textContent = '▶ 播放'; }, xOf: T => X(T), redraw: () => drawBars(),
    rowsTop: () => rowsEl.offsetTop, rowsH: () => rowsEl.offsetHeight, muted, split, ongoing, condTerms, BUILD,
    rebuild(quiet) { buildRows(); if (critOn) updateChain(); if (!quiet) window.dispatchEvent(new CustomEvent('script-edited')); },
    groups: () => groups,
    setGroup(key, cids, name) { // Ctrl+number: these units are group N (a unit sits in one numbered group at a time, as in the game it may sit in several: keep it simple)
      const old = groups.find(g => g.key === key), nm = name || (old && !old.example ? old.name : '编队' + key);
      groups = groups.filter(g => g.key !== key && g.name !== nm).concat([{key, name: nm, cids: [...cids]}]); saveGroups(); buildFilters();
    },
    selectGroup(key) { const G = groups.find(g => g.key === key); if (!G) return null; pick.clear(); G.cids.forEach(c => pick.add(c)); syncOrder(); return G; },
    pick, lanes, D, posAt, basePos, unitsAt, uname, laneOfCid, cidOfLane, current, stepEnd, ongoing, fmt, toast, unitType, builds,
    syncOrder: () => { ghostKey = ''; renderOrder(); },
    /* one order from the map, given at the red line: cmd as in the order window; xy a ground point */
    issue({cmd, xy, what, assist, queue}) {
      ord.T = Math.round(t); ord.cmd = cmd; ord.when = 'now'; ord.mode = queue ? 'queue' : 'override';
      if (xy) { // a new named place for this point; never reuse a name the script already has
        const base = cmd === 'build' ? what : '点'; let nm; do { nm = base + placeN++; } while (nm in D.places);
        D.places[nm] = [Math.round(xy[0]), Math.round(xy[1])]; ord.place = nm;
      }
      if (what) ord.what = what;
      if (assist != null) ord.target = String(assist);
      if (cmd === 'wood' && xy) ord.woodAt = xy;
      const plan = giveOrder();
      return plan;
    },
  };
  t = 0;
  requestAnimationFrame(() => { scroll.scrollLeft = Math.max(0, X(t) - LABEL() - 200); });
  requestAnimationFrame(frame);
})();
