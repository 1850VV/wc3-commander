/* Tactic-script editor (战术脚本): strategies/战术脚本-人族速矿二本.txt shown as lanes of step cards.
 * One lane per peasant (or several peasants with the same life), per building and per hero; the cards
 * run left to right, each waiting for its [condition]. Drag a card to reorder it or hand it to another
 * lane, drag from the palette to add one, click to edit it. 「预演」 plays the script on the bridge's
 * fake world and lays the cards out on the timeline at the moment each began; a live or replayed
 * game does the same from its decision record. The text file stays the source: 保存 writes it back,
 * and the next game plays it. Needs the bridge (GET/PUT /api/script, POST /api/script/preview). */
(function () {
  'use strict';
  const HEROES = ['大法师', '山丘之王'];
  const BT = {国王祭坛: 'halt', 祭坛: 'halt', 农场: 'hhou', 兵营: 'hbar', 伐木场: 'hlum', 神秘藏宝室: 'hvlt', 藏宝室: 'hvlt', 神秘圣所: 'hars', 神秘圣地: 'hars',
    圣所: 'hars', 侦察塔: 'hwtw', 城镇大厅: 'htow', 分基地: 'htow', 铁匠铺: 'hbla', 车间: 'harm', 狮鹫笼: 'hgra', 奥术塔: 'hatw', 防御塔: 'hatw'};
  const PALETTE = [
    ['peasant', ['采金 主矿', '伐木 主矿', '采金 分矿', '伐木 分矿', '建造 农场 @自动', '协助 #分基地', '敲钟', '集合 @前方空地', '清野 @分矿', '待命 @分矿']],
    ['building', ['农民N', '步兵 ×1', '集结点 @前方空地', '升级 主城']],
    ['hero', ['学 水元素', '集合 @前方空地', '清野 @分矿', '待命 @分矿']],
  ];
  const KIND_NAME = {peasant: '农民', building: '建筑', hero: '英雄'};
  const SECTIONS = [['peasant', '农民（每人的一生）'], ['building', '建筑（生产顺序）'], ['hero', '英雄']];
  const COND_PRESETS = ['1:30', '金≥385 木≥205', '#分基地 开工', '#分基地 完成', '大法师 出生', '大法师剩余 ≤ 集合用时', '清野 完成', '人口剩 ≤ 4'];
  const EXPR_HINTS = ['布局.国王祭坛', '布局.农场1', '布局.兵营', '布局.神秘藏宝室', '布局.神秘圣所1', '分矿.城镇大厅', '分矿.侦察塔', '本方向分矿',
    '祭坛 前方 400', '分矿 后方 640', '坐标 0,0'];
  const ACT_CLASS = {采金: 'gold', 伐木: 'wood', 建造: 'build', 协助: 'assist', 敲钟: 'bell', 集合: 'bell', 清野: 'fight', 待命: 'wait', 农民: 'train',
    学: 'learn', 集结点: 'rally', 升级: 'upgrade'};
  const T_END = 600, MIN_W = 74;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const pct = t => (Math.max(0, Math.min(T_END, t)) / T_END * 100) + '%';

  let api = null, root = null, M = null; // M: {header, positions: [{name, expr, note}], lanes: [{head, note, steps: [{raw}]}], reserves: [{raw, note}]}
  const S = {active: false, saved: true, loadedText: '', errors: {general: [], lane: {}, pos: {}, res: {}}, map: {}, sel: null, view: 'flow',
    preview: null, busy: false, undo: [], drag: null, check: 0, showText: false, lastTick: 0, timingKey: '', timing: null};

  /* ---------- the script's pieces ---------- */
  function laneKind(head) { return /^农民/.test(head) ? 'peasant' : HEROES.includes(head) ? 'hero' : 'building'; }
  function laneCids(head) { const m = /^农民([\d、,，\s]+)$/.exec(head); return m ? m[1].split(/[、,，\s]+/).filter(Boolean).map(Number) : []; }
  function splitStep(raw) {
    let s = String(raw).trim(), cond = '', pos = '', tag = '';
    if (s.startsWith('[')) { const i = s.indexOf(']'); if (i > 0) { cond = s.slice(1, i).trim(); s = s.slice(i + 1).trim(); } }
    const t = (' ' + s).match(/\s#(\S+)\s*$/); if (t) { tag = t[1]; s = (' ' + s).slice(0, t.index).trim(); }
    const p = s.match(/@(\S+)/); if (p) { pos = p[1]; s = (s.slice(0, p.index) + s.slice(p.index + p[0].length)).trim(); }
    s = s.replace(/\s+/g, ' ');
    return {cond, body: s, pos, tag, act: /^农民\d+$/.test(s) ? '农民' : (s.split(' ')[0] || '')};
  }
  function joinStep(o) { return ((o.cond ? `[${o.cond}] ` : '') + o.body + (o.pos ? ' @' + o.pos : '') + (o.tag ? ' #' + o.tag : '')).trim(); }
  function stepClass(raw) {
    const o = splitStep(raw);
    return ACT_CLASS[o.act] || (/×|^\S+$/.test(o.body) ? 'train' : 'wait');
  }
  function toText() {
    const out = [], map = {};
    const push = (line, ref) => { out.push(line); if (ref) map[out.length] = ref; };
    for (const h of (M.header || '').split('\n').filter(Boolean)) push('# ' + h);
    push('# ---------- 位置 ----------');
    M.positions.forEach((p, i) => { if (p.note) push('# ' + p.note); push(`位置 ${p.name} = ${p.expr}`, {type: 'pos', i}); });
    for (const [kind, title] of [['peasant', '农民'], ['building', '建筑生产顺序'], ['hero', '英雄']]) {
      push(''); push(`# ---------- ${title} ----------`);
      M.lanes.forEach((ln, i) => {
        if (laneKind(ln.head) !== kind) return;
        if (ln.note) push('# ' + ln.note);
        const st = ln.steps.map(s => s.raw.trim()), rows = [];
        for (let k = 0; k < st.length; k += 4) rows.push(st.slice(k, k + 4));
        push(ln.head + '：' + (rows[0] || []).join(' → '), {type: 'lane', i});
        for (const r of rows.slice(1)) push('      → ' + r.join(' → '));
      });
    }
    push(''); push('# ---------- 留钱 ----------');
    M.reserves.forEach((r, i) => { if (r.note) push('# ' + r.note); push(r.raw.trim(), {type: 'res', i}); });
    return {text: out.join('\n') + '\n', map};
  }
  function fromModel(model) {
    return {header: model.header || '', positions: (model.positions || []).map(p => ({name: p.name, expr: p.expr, note: p.note || ''})),
      lanes: (model.lanes || []).map(l => ({head: l.head, note: l.note || '', steps: l.steps.map(s => ({raw: s.raw}))})),
      reserves: (model.reserves || []).map(r => ({raw: r.raw, note: r.note || ''}))};
  }
  /* lanes in display order: by kind (the file's order), keeping each lane's index in M */
  const lanesOf = kind => M.lanes.map((ln, i) => ({ln, i})).filter(x => laneKind(x.ln.head) === kind);

  /* ---------- server ---------- */
  async function api_(method, path, body) {
    const r = await fetch(path, {method, headers: {'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return r.json();
  }
  async function load() {
    let j;
    try { j = await api_('GET', '/api/script'); } catch (_) { return false; }
    if (!j || !j.ok) return false;
    M = fromModel(j.model); S.loadedText = j.text; S.saved = true; S.undo = [];
    if (j.errors && j.errors.length) { S.showText = true; S.textDraft = j.text; api.say('脚本文件有错，先在「文本」里改好：' + j.errors[0], true); }
    return true;
  }
  function scheduleCheck() { clearTimeout(S.check); S.check = setTimeout(check, 350); }
  async function check() {
    const {text, map} = toText(); S.map = map; S.text = text;
    let j; try { j = await api_('PUT', '/api/script', {text, dryRun: true}); } catch (_) { return; }
    const E = {general: [], lane: {}, pos: {}, res: {}};
    for (const e of j.errors || []) {
      const m = /^第 (\d+) 行：(.*)$/.exec(e), ref = m && map[+m[1]];
      if (ref) (E[ref.type === 'lane' ? 'lane' : ref.type][ref.i] = E[ref.type === 'lane' ? 'lane' : ref.type][ref.i] || []).push(m[2]);
      else E.general.push(e);
    }
    S.errors = E; showErrors();
  }
  async function save() {
    const {text} = toText();
    let j; try { j = await api_('PUT', '/api/script', {text}); } catch (_) { api.say('没保存：连不上本地服务', true); return; }
    if (!j.saved) { api.say('脚本有错，没有保存：' + (j.errors || [])[0], true); check(); return; }
    S.loadedText = j.text; S.saved = true; render();
    api.say('已保存战术脚本（strategies/战术脚本-人族速矿二本.txt），下一局按它打');
  }
  async function preview() {
    if (S.busy) return;
    const start = api.startIndex(), {text, map} = toText();
    S.busy = true; render();
    api.say(`正在用假游戏预演${api.startName(start)}（约 10 秒）…`);
    let j;
    try { j = await api_('POST', '/api/script/preview', {text, start}); } catch (_) { j = {ok: false, error: '连不上本地服务'}; }
    S.busy = false;
    if (!j.ok) { render(); api.say('预演没跑成：' + (j.error || (j.errors || [])[0] || '未知原因'), true); return; }
    S.preview = {...j, start, text, map}; S.view = 'time'; S.timingKey = ''; render();
    const dead = (j.script.lanes || []).filter(l => l.dead).map(l => l.label);
    api.say(`预演完成（${api.startName(start)}，到 ${api.fmt(j.t)}）：卡片按开始时间排在时间轴上。假游戏的采集和战斗数值是估计的，时间只作参考。` + (dead.length ? ` 阵亡：${dead.join('、')}` : ''));
  }

  /* ---------- changes (with undo) ---------- */
  function change(fn, msg) {
    S.undo.push(JSON.stringify(M)); if (S.undo.length > 60) S.undo.shift();
    fn(); S.saved = false; S.timingKey = ''; render(); scheduleCheck();
    if (msg) api.say(msg);
  }
  function undo() {
    if (!S.undo.length) { api.say('没有可以撤销的修改'); return; }
    M = JSON.parse(S.undo.pop()); S.saved = false; S.sel = null; S.timingKey = ''; render(); scheduleCheck(); api.say('已撤销上一步修改');
  }
  function nextPeasant() {
    let n = 5;
    for (const ln of M.lanes) {
      for (const c of laneCids(ln.head)) n = Math.max(n, c);
      for (const s of ln.steps) { const m = /^农民(\d+)$/.exec(splitStep(s.raw).body); if (m) n = Math.max(n, +m[1]); }
    }
    return n + 1;
  }
  function ensurePeasantLane(n) {
    if (M.lanes.some(ln => laneCids(ln.head).includes(n))) return;
    const lastP = M.lanes.reduce((a, ln, i) => (laneKind(ln.head) === 'peasant' ? i : a), -1);
    M.lanes.splice(lastP + 1, 0, {head: '农民' + n, note: '', steps: [{raw: '伐木 主矿'}]});
    if (S.dropLane != null && S.dropLane > lastP) S.dropLane++;
  }
  function setTime(l, s, t) {
    const o = splitStep(M.lanes[l].steps[s].raw), mm = Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0');
    const terms = o.cond ? o.cond.split(/\s*且\s*/).filter(x => !/^\d+:\d{2}$/.test(x.trim())) : [];
    o.cond = [mm, ...terms].join(' 且 ');
    change(() => { M.lanes[l].steps[s].raw = joinStep(o); S.sel = {l, s}; },
      `「${o.body}」改成最早 ${mm} 开始（还要等上一步做完、其他条件满足）。点「预演」看新的时间`);
  }

  /* ---------- timing from a game: live, replay or preview ---------- */
  function source() {
    const L = api.live();
    if (L.on && L.state && L.state.script) return {kind: 'live', T: L.state.t, decisions: L.state.decisions || [], script: L.state.script, label: '实机'};
    if (L.replay && L.replay.state && L.replay.state.script) return {kind: 'replay', T: L.replay.t, decisions: L.replay.state.decisions || [], script: L.replay.state.script, label: '回放'};
    if (S.preview) return {kind: 'preview', T: S.preview.t, decisions: S.preview.decisions, script: S.preview.script, label: '预演 · ' + api.startName(S.preview.start)};
    return null;
  }
  function timing() {
    const src = source();
    if (!src) return null;
    const key = src.kind + '|' + src.decisions.length + '|' + Math.floor(src.T) + '|' + S.undo.length + '|' + (S.preview ? S.preview.t : '');
    if (key === S.timingKey) return S.timing;
    const byLabel = {};
    for (const d of src.decisions) {
      if (!/^L\d+$/.test(d.rule || '')) continue;
      const m = /^第 (\d+) 行第 (\d+) 步/.exec(d.why || ''), ci = (d.action || '').indexOf('：');
      if (m && ci > 0) {
        const r = byLabel[d.action.slice(0, ci)] || (byLabel[d.action.slice(0, ci)] = {starts: []}), k = +m[2] - 1;
        if (r.starts[k] == null) r.starts[k] = d.t;
        continue;
      }
      const dm = /^(.+) 不在了（阵亡）$/.exec(d.action || ''), km = /停在第 (\d+) 步/.exec(d.why || '');
      if (dm && km) (byLabel[dm[1]] || (byLabel[dm[1]] = {starts: []})).dead = {k: +km[1] - 1, t: d.t};
    }
    const runLanes = src.script.lanes || [];
    const lines = {}; for (const [n, ref] of Object.entries((src.kind === 'preview' && S.preview.map) || {})) if (ref.type === 'lane') lines[ref.i] = +n;
    const lanes = M.lanes.map((ln, i) => {
      const kind = laneKind(ln.head), cids = laneCids(ln.head);
      const match = runLanes.filter(x => x.kind === kind && (kind === 'peasant' ? cids.includes(+x.label.replace('农民', ''))
        : x.line === lines[i] || x.label === ln.head || (BT[ln.head] && api.name(BT[ln.head]) === x.label)));
      return ln.steps.map((st, k) => {
        const who = [];
        let stale = false;
        for (const x of match) {
          if (x.steps[k] !== st.raw.trim()) { // the card changed since that game: keep its old time, marked, while the lane still lines up
            if (x.steps.length !== ln.steps.length) continue;
            stale = true;
          }
          const r = byLabel[x.label] || {starts: []};
          let cur = -1; r.starts.forEach((t, j) => { if (t != null && t <= src.T) cur = j; });
          const dead = r.dead && r.dead.t <= src.T && r.dead.k === k;
          who.push({label: x.label, t: r.starts[k], state: dead ? 'dead' : k < cur ? 'done' : k === cur ? 'cur' : 'todo'});
        }
        const ts = who.map(w => w.t).filter(t => t != null && t <= src.T);
        return {t: ts.length ? Math.min(...ts) : null, who, matched: who.length > 0, stale};
      });
    });
    S.timing = {src, lanes}; S.timingKey = key;
    return S.timing;
  }
  function cardState(info) {
    if (!info || !info.matched) return '';
    if (info.stale) return 'stale';
    const st = info.who.map(w => w.state);
    if (st.includes('dead')) return 'dead';
    if (st.includes('cur')) return 'cur';
    if (st.every(s => s === 'done')) return 'done';
    return 'todo';
  }

  /* ---------- map markers (app.js draws them while this tab is open) ---------- */
  /* the layout the script plays on: 人族速矿二本 · <start> (fetched once per start), else what the console has loaded */
  const layouts = {};
  function layoutGroups(start) {
    if (!(start in layouts)) {
      layouts[start] = null;
      api_('GET', '/api/strategies/' + encodeURIComponent('人族速矿二本 · ' + api.startName(start)))
        .then(j => { if (j && j.ok) { layouts[start] = j.plan.groups; S.timingKey = ''; } }).catch(() => {});
    }
    return layouts[start] || api.groups();
  }
  function approxPositions() {
    const builds = layoutGroups(api.startIndex()).flatMap(g => g.children).filter(e => e.kind === 'build').sort((a, b) => a.start - b.start || (a.seq || 0) - (b.seq || 0));
    const pools = {};
    for (const e of builds) { const site = e.at || e.site; if (site) (pools[(e.near === 'natural' ? 'natural:' : '') + e.btype] = pools[(e.near === 'natural' ? 'natural:' : '') + e.btype] || []).push({site, exact: !!e.at}); }
    const hall = api.hall(), nat = api.natural(), memo = {};
    const toward = (a, b, d) => { const dx = b.x - a.x, dy = b.y - a.y, n = Math.hypot(dx, dy) || 1; return {x: a.x + dx / n * d, y: a.y + dy / n * d}; };
    function resolve(expr, depth) {
      const e = expr.replace(/\s+/g, '');
      let m;
      if ((m = /^布局\.(\D+?)(\d*)$/.exec(e))) { const p = (pools[BT[m[1]]] || [])[(+m[2] || 1) - 1]; return p && {x: p.site[0], y: p.site[1], exact: p.exact}; }
      if ((m = /^分矿\.(\D+)$/.exec(e))) { const p = (pools['natural:' + BT[m[1]]] || [])[0]; return p && {x: p.site[0], y: p.site[1], exact: p.exact}; }
      if (e === '本方向分矿') return nat && {x: nat.x, y: nat.y, exact: false};
      if ((m = /^分矿后方(\d+)$/.exec(e))) {
        if (!nat) return null;
        const h = (pools['natural:htow'] || [])[0], hp = h ? {x: h.site[0], y: h.site[1]} : nat;
        return {...toward(nat, hp, Math.hypot(hp.x - nat.x, hp.y - nat.y) + +m[1]), exact: false};
      }
      if ((m = /^坐标(-?\d+)[,，](-?\d+)$/.exec(e))) return {x: +m[1], y: +m[2], exact: true};
      if ((m = /^(\S+?)前方(\d+)$/.exec(e)) && depth < 4) { const b = get(m[1], depth + 1); return b && {...toward(b, hall, +m[2]), exact: false}; }
      return null;
    }
    function get(name, depth) {
      if (name in memo) return memo[name];
      const p = M.positions.find(q => q.name === name);
      return (memo[name] = p ? resolve(p.expr, depth) : null);
    }
    const out = {}; for (const p of M.positions) { const r = get(p.name, 0); if (r) out[p.name] = r; }
    return out;
  }
  function markers() {
    if (!M) return [];
    const src = source(), start = api.startIndex();
    const fromGame = src && src.script.positions && (src.kind !== 'preview' || S.preview.start === start) ? src.script.positions : null;
    const approx = approxPositions();
    return M.positions.map(p => {
      const g = fromGame && fromGame[p.name], a = approx[p.name];
      const at = /^坐标/.test(p.expr.trim()) ? a : g ? {x: g[0], y: g[1], exact: true} : a;
      return at && {name: p.name, x: at.x, y: at.y, exact: !!at.exact || !!g, editable: /^坐标/.test(p.expr.trim()), sel: S.selPos === p.name};
    }).filter(Boolean);
  }
  function markerAt(wx, wy, r) {
    let best = null, bd = r;
    for (const m of markers()) { const d = Math.hypot(m.x - wx, m.y - wy); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  function moveMarker(name, x, y) {
    const p = M.positions.find(q => q.name === name); if (!p) return;
    const sx = Math.round(x / 32) * 32, sy = Math.round(y / 32) * 32;
    change(() => { p.expr = `坐标 ${sx},${sy}`; }, `位置「${name}」移到 ${sx},${sy}（坐标写死，只对这个出生点准确）`);
  }
  function selectPos(name) {
    S.selPos = name; S.open = true; render();
    const el = root.querySelector(`.se-pos [data-name="${CSS.escape(name)}"]`); if (el) el.scrollIntoView({block: 'nearest'});
    const p = M.positions.find(q => q.name === name);
    api.say(`位置「${name}」= ${p ? p.expr : '?'}` + (p && !/^坐标/.test(p.expr) ? '。布局里的工地在地图上直接拖（改的是这个出生点的布局，记得点上面的「保存」）；这里只有「坐标 x,y」的位置能拖。' : ''));
  }

  /* ---------- rendering ---------- */
  function cardHTML(raw, info) {
    const o = splitStep(raw);
    const who = info && info.who.length > 1 ? `<span class="who">${info.who.map(w => `<i class="${w.state}" title="${esc(w.label)}">${esc(w.label.replace('农民', ''))}</i>`).join('')}</span>` : '';
    return (o.cond ? `<span class="c" title="开始条件">${esc(o.cond)}</span>` : '') + `<b>${esc(o.body)}</b>` +
      (o.pos ? `<span class="p">@${esc(o.pos)}</span>` : '') + (o.tag ? `<span class="g">#${esc(o.tag)}</span>` : '') +
      (info && info.t != null ? `<span class="tm" title="${info.stale ? '改过：这是改之前的时间，点「预演」更新' : '这一步开始的时间'}">${api.fmt(info.t)}${info.stale ? '?' : ''}</span>` : '') + who;
  }
  function render() {
    if (!root || !M) return;
    const T = timing(), src = T && T.src, time = S.view === 'time' && !!T;
    const errN = S.errors.general.length + Object.keys(S.errors.lane).length + Object.keys(S.errors.pos).length + Object.keys(S.errors.res).length;
    let h = `<div class="se-bar">
      <span class="seg"><button type="button" data-view="flow" class="${S.view === 'flow' ? 'on' : ''}">顺序</button><button type="button" data-view="time" class="${S.view === 'time' ? 'on' : ''}" ${T ? '' : 'disabled title="先点「预演」，或连接游戏 / 打开回放"'}>时间</button></span>
      <button type="button" class="btn" data-act="preview" ${S.busy ? 'disabled' : ''}>${S.busy ? '预演中…' : '预演（' + esc(api.startName(api.startIndex())) + '）'}</button>
      <button type="button" class="btn ${S.saved ? '' : 'on'}" data-act="save">保存</button>
      <button type="button" class="btn" data-act="undo" ${S.undo.length ? '' : 'disabled'}>撤销</button>
      <button type="button" class="btn ${S.showText ? 'on' : ''}" data-act="text">文本</button>
      <span class="se-state ${errN ? 'bad' : S.saved ? '' : 'warn'}">${errN ? errN + ' 处要改' : S.saved ? '已保存' : '未保存'}</span>
      <span class="se-src">${src ? '时间来自：' + esc(src.label) + ' · ' + api.fmt(src.T) : '还没有时间：点「预演」'}</span></div>`;
    h += '<div class="se-pal"><span class="hint">拖到一行里（或先点一行再点这里）：</span>' + PALETTE.map(([kind, items]) =>
      `<span class="grp"><em>${KIND_NAME[kind]}</em>${items.map(r => `<span class="chip-step k-${stepClass(r)}" draggable="true" data-raw="${esc(r)}" data-kind="${kind}">${esc(r === '农民N' ? '农民（新编号）' : r)}</span>`).join('')}</span>`).join('') + '</div>';
    h += `<div class="se-errs">${errorsHTML()}</div>`;
    h += `<div class="se-lanes ${time ? 'time' : 'flow'}">`;
    if (time) {
      h += '<div class="se-row ruler"><div class="se-lab hint">一行 ／ 时间</div><div class="se-track">';
      for (let t = 0; t < T_END; t += 60) h += `<span class="tick" style="left:${pct(t)}">${api.fmt(t)}</span>`;
      h += `<span class="now" style="left:${pct(src.T)}"></span></div></div>`;
    }
    for (const [kind, title] of SECTIONS) {
      h += `<div class="se-sec"><span>${title}</span><button type="button" class="link" data-act="addlane" data-kind="${kind}">＋ 加一行</button></div>`;
      for (const {ln, i} of lanesOf(kind)) {
        const err = S.errors.lane[i], selL = S.sel && S.sel.l === i;
        const timedInfo = T ? T.lanes[i] : null;
        h += `<div class="se-row k-${kind} ${selL && S.sel.s == null ? 'sel' : ''} ${err ? 'err' : ''}" data-l="${i}">`;
        h += `<div class="se-lab" data-l="${i}" title="${esc((ln.note ? ln.note + '\n' : '') + (err ? err.join('\n') : '点一下编辑这一行'))}"><b>${esc(ln.head)}</b>` +
          (ln.note ? '<i class="note">注</i>' : '') + (err ? '<i class="bad">!</i>' : '') + '</div>';
        h += `<div class="se-track" data-l="${i}">`;
        let hidden = 0;
        ln.steps.forEach((st, s) => {
          const info = timedInfo && timedInfo[s], cls = `sc k-${stepClass(st.raw)} ${cardState(info)} ${selL && S.sel.s === s ? 'sel' : ''}`;
          if (time) {
            if (!info || info.t == null) { hidden++; return; }
            const next = timedInfo.slice(s + 1).find(x => x && x.t != null), end = next ? next.t : src.T;
            h += `<div class="${cls}" data-l="${i}" data-s="${s}" style="left:${pct(info.t)};width:max(${MIN_W}px, calc(${pct(end)} - ${pct(info.t)}))" title="${esc(st.raw)}">${cardHTML(st.raw, info)}</div>`;
          } else {
            h += `<div class="${cls}" draggable="true" data-l="${i}" data-s="${s}" title="${esc(st.raw)}">${cardHTML(st.raw, info)}</div>`;
          }
        });
        if (time && hidden) h += `<span class="se-more" title="还没开始的步骤；切到「顺序」看全部">+${hidden} 步未开始</span>`;
        if (!time) h += `<button type="button" class="se-add" data-l="${i}" title="在这一行最后加一步">＋</button>`;
        h += '</div></div>';
      }
    }
    h += '</div>';
    h += editorHTML();
    h += positionsHTML();
    h += reservesHTML();
    if (S.showText) h += `<div class="se-textbox"><textarea spellcheck="false" id="seText">${esc(S.textDraft != null ? S.textDraft : toText().text)}</textarea>
      <div><button type="button" class="btn" data-act="fromtext">按文本更新卡片</button><span class="hint">直接改文本也行；更新时会检查写法。</span></div></div>`;
    h += `<div class="hint se-help">卡片从左到右一件一件做；方括号是这一步的开始条件（最早时间、资源、#建筑 开工/完成、大法师剩余 ≤ 集合用时…）。` +
      `写在上面的行先花钱。拖卡片调整先后或换给别人；在「时间」视图里左右拖一张卡片 = 给它加「到这个时间才开始」。` +
      `地图上的菱形是脚本里的位置。保存写回 strategies/战术脚本-人族速矿二本.txt，下一局按它打。</div>`;
    root.innerHTML = h;
    S.textDraft = null;
  }
  /* every mistake, named by the lane or place it is in; a click selects that lane */
  function errorsHTML() {
    const E = S.errors, out = [];
    for (const [i, es] of Object.entries(E.lane)) if (M.lanes[i]) for (const e of es) out.push(`<button type="button" class="link bad" data-errlane="${i}">${esc(M.lanes[i].head)}：${esc(e)}</button>`);
    for (const [i, es] of Object.entries(E.pos)) if (M.positions[i]) for (const e of es) out.push(`<div>位置 ${esc(M.positions[i].name)}：${esc(e)}</div>`);
    for (const [i, es] of Object.entries(E.res)) for (const e of es) out.push(`<div>留钱第 ${+i + 1} 条：${esc(e)}</div>`);
    return out.concat(E.general.map(e => `<div>${esc(e)}</div>`)).join('');
  }
  function editorHTML() {
    if (!S.sel || !M.lanes[S.sel.l]) return '';
    const ln = M.lanes[S.sel.l], kind = laneKind(ln.head);
    if (S.sel.s == null || !ln.steps[S.sel.s]) {
      return `<div class="se-edit"><div class="ttl">编辑这一行 · ${KIND_NAME[kind]}</div>
        <label>谁<input data-f="head" value="${esc(ln.head)}" placeholder="农民9、10、12 ／ 城镇大厅 ／ #分基地 ／ 大法师"></label>
        <label>备注<input data-f="note" value="${esc(ln.note)}" placeholder="写给自己看的说明（存成注释）"></label>
        <div class="row"><button type="button" class="btn" data-act="laneup">上移</button><button type="button" class="btn" data-act="lanedown">下移</button>
        <button type="button" class="btn" data-act="lanedup">复制这一行</button><button type="button" class="btn bad" data-act="lanedel">删除这一行</button>
        <span class="hint">上面的行先花钱；农民行、建筑行、英雄行各自排序。</span></div></div>`;
    }
    const o = splitStep(ln.steps[S.sel.s].raw), names = M.positions.map(p => p.name);
    const opts = ['', '自动', ...names].map(n => `<option value="${esc(n)}" ${n === o.pos ? 'selected' : ''}>${n ? '@' + esc(n) : '（不用位置）'}</option>`).join('')
      + (o.pos && !names.includes(o.pos) && o.pos !== '自动' ? `<option selected value="${esc(o.pos)}">@${esc(o.pos)}（没定义）</option>` : '');
    return `<div class="se-edit"><div class="ttl">${esc(ln.head)} · 第 ${S.sel.s + 1} 步</div>
      <label>开始条件<input data-f="cond" value="${esc(o.cond)}" placeholder="不写 = 上一步做完马上开始"></label>
      <div class="presets">${COND_PRESETS.map(c => `<button type="button" class="chip-step" data-cond="${esc(c)}">${esc(c)}</button>`).join('')}<button type="button" class="link" data-cond="">清空</button></div>
      <label>做什么<input data-f="body" value="${esc(o.body)}" placeholder="${kind === 'building' ? '农民12 ／ 步兵 ×6 ／ 升级 主城 ／ 集结点' : kind === 'hero' ? '学 水元素 ／ 集合 ／ 清野' : '采金 主矿 ／ 建造 农场 ／ 协助 ／ 敲钟'}"></label>
      <label>位置<select data-f="pos">${opts}</select></label>
      <label>起名<input data-f="tag" value="${esc(o.tag)}" placeholder="给建造的建筑起名，别处用 #名字 引用"></label>
      <div class="row"><code class="raw">${esc(joinStep(o))}</code></div>
      <div class="row"><button type="button" class="btn" data-act="stepdup">复制一份</button><button type="button" class="btn bad" data-act="stepdel">删除这一步</button>
      <span class="hint">选中卡片时按 Delete 也能删；Ctrl+Z 撤销。</span></div></div>`;
  }
  function positionsHTML() {
    const rows = M.positions.map((p, i) => `<div class="se-prow ${S.errors.pos[i] ? 'err' : ''} ${S.selPos === p.name ? 'sel' : ''}" data-pi="${i}" data-name="${esc(p.name)}">
      <input data-pf="name" value="${esc(p.name)}" aria-label="位置名"><span>=</span><input data-pf="expr" list="seExpr" value="${esc(p.expr)}" aria-label="在哪">
      <input data-pf="note" value="${esc(p.note)}" placeholder="备注" aria-label="备注"><button type="button" class="link" data-act="posshow">地图</button><button type="button" class="link bad" data-act="posdel">删</button>
      ${S.errors.pos[i] ? `<div class="bad">${esc(S.errors.pos[i].join('；'))}</div>` : ''}</div>`).join('');
    return `<details class="se-pos" ${S.open ? 'open' : ''}><summary>位置（${M.positions.length}）· 地图上的菱形</summary>
      <datalist id="seExpr">${EXPR_HINTS.map(x => `<option value="${esc(x)}">`).join('')}</datalist>${rows}
      <button type="button" class="link" data-act="posadd">＋ 新位置</button>
      <div class="hint">「布局.农场1」取自当前出生点的布局（四个方向通用）；「坐标 x,y」写死，只有它能在地图上拖。改名会同时改掉引用它的 @名字。</div></details>`;
  }
  function reservesHTML() {
    const rows = M.reserves.map((r, i) => `<div class="se-prow ${S.errors.res[i] ? 'err' : ''}" data-ri="${i}"><input data-rf="raw" value="${esc(r.raw)}" aria-label="留钱">
      <input data-rf="note" value="${esc(r.note)}" placeholder="备注" aria-label="备注"><button type="button" class="link bad" data-act="resdel">删</button>
      ${S.errors.res[i] ? `<div class="bad">${esc(S.errors.res[i].join('；'))}</div>` : ''}</div>`).join('');
    return `<details class="se-res" open><summary>留钱（${M.reserves.length}）</summary>${rows}
      <button type="button" class="link" data-act="resadd">＋ 留钱</button>
      <div class="hint">「留钱 金385 木205 给 #分基地 从 [清野 完成]」：从条件满足到 #分基地 开工，这笔钱不给排在它后面的事花（按采集速度，不会让它更晚的花费照常放行）。</div></details>`;
  }
  function showErrors() {
    if (!root) return;
    const errN = S.errors.general.length + Object.keys(S.errors.lane).length + Object.keys(S.errors.pos).length + Object.keys(S.errors.res).length;
    const st = root.querySelector('.se-state');
    if (st) { st.className = 'se-state ' + (errN ? 'bad' : S.saved ? '' : 'warn'); st.textContent = errN ? errN + ' 处要改' : S.saved ? '已保存' : '未保存'; }
    const box = root.querySelector('.se-errs'); if (box) box.innerHTML = errorsHTML();
    root.querySelectorAll('.se-row[data-l]').forEach(r => {
      const e = S.errors.lane[+r.dataset.l]; r.classList.toggle('err', !!e);
      const lab = r.querySelector('.se-lab'); let b = lab.querySelector('.bad');
      if (e && !b) { b = document.createElement('i'); b.className = 'bad'; b.textContent = '!'; lab.appendChild(b); }
      if (!e && b) b.remove();
      lab.title = (M.lanes[+r.dataset.l].note || '') + (e ? '\n' + e.join('\n') : '');
    });
    root.querySelectorAll('.se-pos .se-prow').forEach(r => r.classList.toggle('err', !!S.errors.pos[+r.dataset.pi]));
    root.querySelectorAll('.se-res .se-prow').forEach(r => r.classList.toggle('err', !!S.errors.res[+r.dataset.ri]));
  }
  /* live / replay: only the cards' state and times change, so update them in place (no re-render) */
  function refresh() {
    if (!root || !M) return;
    const T = timing();
    if (!T) return;
    if (S.view === 'time') { if (!root.contains(document.activeElement) || document.activeElement === document.body) render(); return; }
    root.querySelectorAll('.sc[data-l]').forEach(el => {
      const l = +el.dataset.l, s = +el.dataset.s, info = T.lanes[l] && T.lanes[l][s];
      const st = cardState(info);
      for (const c of ['done', 'cur', 'dead', 'todo', 'stale']) el.classList.toggle(c, c === st);
      const html = cardHTML(M.lanes[l].steps[s].raw, info); if (el.innerHTML !== html) el.innerHTML = html;
    });
    const sr = root.querySelector('.se-src'); if (sr) sr.textContent = '时间来自：' + T.src.label + ' · ' + api.fmt(T.src.T);
  }

  /* ---------- input ---------- */
  function onClick(ev) {
    const t = ev.target.closest('button, .sc, .se-lab, .chip-step, .se-add');
    if (!t || !root.contains(t)) return;
    const act = t.dataset.act;
    if (t.dataset.errlane != null) { S.sel = {l: +t.dataset.errlane}; render(); root.querySelector(`.se-row[data-l="${t.dataset.errlane}"]`).scrollIntoView({block: 'nearest'}); return; }
    if (t.dataset.view) { if (t.dataset.view === 'time' && !timing()) return; S.view = t.dataset.view; render(); return; }
    if (t.dataset.cond != null && S.sel && S.sel.s != null) { // a condition preset: add it (or clear)
      const l = S.sel.l, s = S.sel.s, o = splitStep(M.lanes[l].steps[s].raw);
      o.cond = t.dataset.cond === '' ? '' : o.cond ? o.cond + ' 且 ' + t.dataset.cond : t.dataset.cond;
      change(() => { M.lanes[l].steps[s].raw = joinStep(o); });
      return;
    }
    if (t.classList.contains('chip-step') && t.dataset.raw) { // palette click: append to the selected lane
      if (!S.sel) { api.say('先点一行（左边的名字），再点要加的步骤；或者直接拖进去'); return; }
      addFromPalette(S.sel.l, M.lanes[S.sel.l].steps.length, t.dataset.raw, t.dataset.kind);
      return;
    }
    if (t.classList.contains('sc')) { S.sel = {l: +t.dataset.l, s: +t.dataset.s}; render(); return; }
    if (t.classList.contains('se-lab')) { S.sel = {l: +t.dataset.l}; render(); return; }
    if (t.classList.contains('se-add')) {
      const l = +t.dataset.l, kind = laneKind(M.lanes[l].head), raw = kind === 'building' ? '步兵 ×1' : kind === 'hero' ? '待命 @分矿' : '伐木 主矿';
      change(() => { M.lanes[l].steps.push({raw}); S.sel = {l, s: M.lanes[l].steps.length - 1}; });
      return;
    }
    const sel = S.sel, ln = sel && M.lanes[sel.l];
    switch (act) {
      case 'preview': preview(); break;
      case 'save': save(); break;
      case 'undo': undo(); break;
      case 'text': S.showText = !S.showText; render(); break;
      case 'fromtext': fromText(); break;
      case 'addlane': addLane(t.dataset.kind); break;
      case 'laneup': case 'lanedown': moveLane(act === 'laneup' ? -1 : 1); break;
      case 'lanedup': change(() => { M.lanes.splice(sel.l + 1, 0, JSON.parse(JSON.stringify(ln))); S.sel = {l: sel.l + 1}; }, '已复制这一行；记得改「谁」'); break;
      case 'lanedel': if (confirm(`删除「${ln.head}」这一整行？`)) change(() => { M.lanes.splice(sel.l, 1); S.sel = null; }, `已删除「${ln.head}」`); break;
      case 'stepdup': change(() => { ln.steps.splice(sel.s + 1, 0, {raw: ln.steps[sel.s].raw}); S.sel = {l: sel.l, s: sel.s + 1}; }); break;
      case 'stepdel': deleteStep(); break;
      case 'posadd': change(() => { let n = 1; while (M.positions.some(p => p.name === '新位置' + n)) n++; M.positions.push({name: '新位置' + n, expr: '布局.农场1', note: ''}); S.open = true; }); break;
      case 'posdel': { const i = +t.closest('[data-pi]').dataset.pi, p = M.positions[i]; change(() => M.positions.splice(i, 1), `已删除位置「${p.name}」`); break; }
      case 'posshow': { const p = M.positions[+t.closest('[data-pi]').dataset.pi], mk = markers().find(m => m.name === p.name);
        if (mk) { api.focus(mk.x, mk.y); selectPos(p.name); } else api.say(`「${p.name}」在当前出生点算不出位置（${p.expr}）`, true); break; }
      case 'resadd': change(() => M.reserves.push({raw: '留钱 金0 木0 给 #分基地', note: ''})); break;
      case 'resdel': { const i = +t.closest('[data-ri]').dataset.ri; change(() => M.reserves.splice(i, 1)); break; }
    }
  }
  function deleteStep() {
    const {l, s} = S.sel, raw = M.lanes[l].steps[s].raw;
    change(() => { M.lanes[l].steps.splice(s, 1); S.sel = M.lanes[l].steps.length ? {l, s: Math.min(s, M.lanes[l].steps.length - 1)} : {l}; }, `已删除「${raw}」（Ctrl+Z 撤销）`);
  }
  function moveLane(d) {
    const i = S.sel.l, kind = laneKind(M.lanes[i].head);
    let j = i + d;
    while (j >= 0 && j < M.lanes.length && laneKind(M.lanes[j].head) !== kind) j += d;
    if (j < 0 || j >= M.lanes.length) return;
    change(() => { const [x] = M.lanes.splice(i, 1); M.lanes.splice(j, 0, x); S.sel = {l: j}; });
  }
  function addLane(kind) {
    if (kind === 'peasant') {
      const n = nextPeasant();
      change(() => { ensurePeasantLane(n); S.sel = {l: M.lanes.findIndex(ln => laneCids(ln.head).includes(n))}; },
        `加了 农民${n} 的一行；还要在某座建筑那一行里加「农民${n}」训练他`);
      return;
    }
    const def = kind === 'hero' ? '山丘之王' : '神秘圣所', head = prompt(kind === 'hero' ? '哪个英雄？（大法师 / 山丘之王）' : '哪座建筑？（城镇大厅、国王祭坛、兵营、神秘圣所，或 #名字）', def);
    if (!head || !head.trim()) return;
    const raw = kind === 'hero' ? '待命 @分矿' : '步兵 ×1';
    change(() => {
      const last = M.lanes.reduce((a, ln, i) => (laneKind(ln.head) === kind ? i : a), kind === 'hero' ? M.lanes.length - 1 : M.lanes.reduce((a, ln, i) => (laneKind(ln.head) === 'peasant' ? i : a), -1));
      M.lanes.splice(last + 1, 0, {head: head.trim(), note: '', steps: [{raw}]}); S.sel = {l: last + 1};
    });
  }
  function addFromPalette(l, idx, raw, kinds) {
    const kind = laneKind(M.lanes[l].head);
    if (kinds !== kind) { api.say(`「${raw === '农民N' ? '农民（新编号）' : raw}」是${KIND_NAME[kinds]}那一类的步骤，${M.lanes[l].head} 是${KIND_NAME[kind]}`, true); return; }
    let msg = '';
    change(() => {
      if (raw === '农民N') {
        const n = nextPeasant(); raw = '农民' + n; S.dropLane = l;
        ensurePeasantLane(n); l = S.dropLane; S.dropLane = null;
        msg = `${M.lanes[l].head} 训练 农民${n}；他的一生已经加在农民那一栏（先写成「伐木 主矿」，按需要改）`;
      }
      M.lanes[l].steps.splice(idx, 0, {raw}); S.sel = {l, s: idx};
    });
    if (msg) api.say(msg);
  }
  async function fromText() {
    const ta = root.querySelector('#seText'), text = ta ? ta.value : '';
    let j; try { j = await api_('PUT', '/api/script', {text, dryRun: true}); } catch (_) { api.say('连不上本地服务', true); return; }
    if (j.errors && j.errors.length) { S.textDraft = text; S.errors = {general: j.errors, lane: {}, pos: {}, res: {}}; render(); api.say('文本里有错，卡片没变：' + j.errors[0], true); return; }
    change(() => { M = fromModel(j.model); S.sel = null; }, '已按文本更新卡片');
  }
  function onInput(ev) {
    const f = ev.target.dataset.f, pf = ev.target.dataset.pf, rf = ev.target.dataset.rf;
    if (f && S.sel) {
      const ln = M.lanes[S.sel.l];
      if (!S.editing) { S.undo.push(JSON.stringify(M)); S.editing = true; } // one undo step per editing session
      if (S.sel.s == null) { ln[f] = ev.target.value; const lab = root.querySelector(`.se-lab[data-l="${S.sel.l}"] b`); if (lab && f === 'head') lab.textContent = ln.head; }
      else {
        const o = splitStep(ln.steps[S.sel.s].raw); o[f] = ev.target.value.trim(); ln.steps[S.sel.s].raw = joinStep(o);
        const card = root.querySelector(`.sc[data-l="${S.sel.l}"][data-s="${S.sel.s}"]`); if (card) { card.innerHTML = cardHTML(ln.steps[S.sel.s].raw, null); card.className = card.className.replace(/k-\w+/, 'k-' + stepClass(ln.steps[S.sel.s].raw)); }
        const raw = root.querySelector('.se-edit .raw'); if (raw) raw.textContent = ln.steps[S.sel.s].raw;
      }
    } else if (pf) {
      const p = M.positions[+ev.target.closest('[data-pi]').dataset.pi];
      if (!S.editing) { S.undo.push(JSON.stringify(M)); S.editing = true; S.oldName = p.name; }
      p[pf] = ev.target.value.trim();
    } else if (rf) {
      const r = M.reserves[+ev.target.closest('[data-ri]').dataset.ri];
      if (!S.editing) { S.undo.push(JSON.stringify(M)); S.editing = true; }
      r[rf] = ev.target.value;
    } else return;
    S.saved = false; S.timingKey = ''; scheduleCheck();
    const st = root.querySelector('.se-state'); if (st && !st.classList.contains('bad')) { st.className = 'se-state warn'; st.textContent = '未保存'; }
  }
  function onChange(ev) { // an edit is finished (blur / select): settle it and redraw
    if (!S.editing && ev.target.tagName !== 'SELECT') return;
    if (ev.target.tagName === 'SELECT' && !S.editing) { S.undo.push(JSON.stringify(M)); onInput(ev); }
    const pf = ev.target.dataset.pf;
    if (pf === 'name' && S.oldName && S.oldName !== ev.target.value.trim()) { // a renamed place: its @references follow
      const from = S.oldName, to = ev.target.value.trim(); let n = 0;
      for (const ln of M.lanes) for (const st of ln.steps) { const o = splitStep(st.raw); if (o.pos === from) { o.pos = to; st.raw = joinStep(o); n++; } }
      for (const p of M.positions) p.expr = p.expr.replace(new RegExp('^' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s*前方)'), to + '$1');
      if (n) api.say(`位置改名「${from}」→「${to}」，${n} 处 @引用一起改了`);
    }
    const redraw = ev.target.tagName === 'SELECT' || pf === 'name' || ev.target.dataset.f === 'head';
    S.editing = false; S.oldName = null;
    if (redraw) render(); // other fields already updated their card in place; a redraw would drop the focus
  }
  function onKey(ev) {
    if (!S.active) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !typing) { ev.preventDefault(); undo(); return; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing && S.sel && S.sel.s != null) { ev.preventDefault(); deleteStep(); }
  }

  /* drag and drop: cards between lanes (order view), palette into lanes */
  let ins = null;
  function clearIns() { if (ins) ins.remove(); ins = null; root.querySelectorAll('.se-track.over').forEach(x => x.classList.remove('over')); }
  function placeIns(track, x, y) {
    if (!ins) { ins = document.createElement('span'); ins.className = 'se-ins'; }
    const cards = [...track.querySelectorAll('.sc')].filter(c => !c.classList.contains('dragging'));
    let before = null;
    for (const c of cards) { const r = c.getBoundingClientRect(); if (y < r.top - 3 || (y <= r.bottom + 3 && x < r.left + r.width / 2)) { before = c; break; } }
    track.insertBefore(ins, before || track.querySelector('.se-add'));
    root.querySelectorAll('.se-track.over').forEach(x2 => x2 !== track && x2.classList.remove('over')); track.classList.add('over');
  }
  function insIndex(track) { let n = 0; for (const c of track.children) { if (c === ins) return n; if (c.classList.contains('sc') && !c.classList.contains('dragging')) n++; } return n; }
  function onDragStart(ev) {
    const c = ev.target.closest('.sc[draggable="true"], .chip-step[draggable="true"]');
    if (!c) return;
    S.drag = c.classList.contains('sc') ? {from: {l: +c.dataset.l, s: +c.dataset.s}} : {raw: c.dataset.raw, kind: c.dataset.kind};
    ev.dataTransfer.effectAllowed = 'copyMove'; ev.dataTransfer.setData('text/plain', c.title || c.dataset.raw || '');
    if (S.drag.from) setTimeout(() => c.classList.add('dragging'), 0);
  }
  function onDragOver(ev) {
    if (!S.drag) return;
    const track = ev.target.closest('.se-lanes.flow .se-track');
    if (!track) { clearIns(); return; }
    ev.preventDefault(); ev.dataTransfer.dropEffect = S.drag.from ? 'move' : 'copy';
    placeIns(track, ev.clientX, ev.clientY);
  }
  function onDrop(ev) {
    const d = S.drag, track = ev.target.closest('.se-lanes.flow .se-track');
    if (!d || !track) return;
    ev.preventDefault();
    const l = +track.dataset.l, idx = insIndex(track);
    clearIns(); S.drag = null;
    if (d.raw) { addFromPalette(l, idx, d.raw, d.kind); return; }
    const from = M.lanes[d.from.l], raw = from.steps[d.from.s].raw, k1 = laneKind(from.head), k2 = laneKind(M.lanes[l].head);
    if (k1 !== k2) { api.say(`「${raw}」是${KIND_NAME[k1]}的步骤，不能放进 ${M.lanes[l].head}（${KIND_NAME[k2]}）`, true); render(); return; }
    if (d.from.l === l && (idx === d.from.s)) { render(); return; }
    change(() => { const [st] = from.steps.splice(d.from.s, 1); M.lanes[l].steps.splice(idx, 0, st); S.sel = {l, s: idx}; },
      d.from.l === l ? `「${raw}」挪到第 ${idx + 1} 步` : `「${raw}」从 ${from.head} 交给 ${M.lanes[l].head}（第 ${idx + 1} 步）`);
  }
  function onDragEnd() { clearIns(); S.drag = null; root.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging')); }
  /* time view: drag a card sideways = "not before this time" */
  function onPointerDown(ev) {
    const c = ev.target.closest('.se-lanes.time .sc');
    if (!c || ev.button !== 0) return;
    const track = c.parentElement, tr = track.getBoundingClientRect(), x0 = ev.clientX, left0 = c.offsetLeft;
    let moved = false;
    c.setPointerCapture(ev.pointerId);
    const mv = e => { const dx = e.clientX - x0; if (Math.abs(dx) > 4) moved = true; if (moved) { c.style.left = (left0 + dx) + 'px'; c.classList.add('dragging'); } };
    const up = e => {
      c.removeEventListener('pointermove', mv); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up);
      if (!moved) return; // a click: onClick selects it
      const t = Math.max(0, Math.min(T_END - 1, (left0 + e.clientX - x0) / tr.width * T_END));
      S.suppressClick = true; setTimeout(() => { S.suppressClick = false; }, 0);
      setTime(+c.dataset.l, +c.dataset.s, Math.round(t));
    };
    c.addEventListener('pointermove', mv); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  }

  /* ---------- the tab next to 事件时间轴 ---------- */
  function setActive(on) {
    S.active = on; api.tl.classList.toggle('script-mode', on);
    api.tl.querySelectorAll('.se-tab').forEach(b => b.classList.toggle('on', (b.dataset.tab === 'script') === on));
    root.hidden = !on;
    if (on) render();
  }
  async function init(a) {
    api = a;
    if (location.protocol === 'file:' || !(await load())) return; // needs the bridge
    const head = api.tl.querySelector('.tl-head h2');
    const tabs = document.createElement('span'); tabs.className = 'se-tabs';
    tabs.innerHTML = '<button type="button" class="se-tab on" data-tab="timeline">事件时间轴</button><button type="button" class="se-tab" data-tab="script">战术脚本</button>';
    head.replaceWith(tabs);
    tabs.onclick = e => { const b = e.target.closest('.se-tab'); if (b) setActive(b.dataset.tab === 'script'); };
    root = document.createElement('div'); root.className = 'se'; root.hidden = true;
    api.tl.querySelector('.tl-head').after(root);
    root.addEventListener('click', e => { if (!S.suppressClick) onClick(e); });
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    scheduleCheck();
  }
  function tick(now) { // from app.js's frame loop: keep the cards in step with a live or replayed game
    if (!S.active || now - S.lastTick < 500 || S.drag) return;
    S.lastTick = now;
    const src = source();
    if (src && src.kind !== 'preview') refresh();
  }

  window.ScriptEditor = {init, tick, markers, markerAt, moveMarker, selectPos, active: () => S.active,
    _test: {splitStep, joinStep, laneKind, laneCids, toText: () => toText(), model: () => M}};
})();
