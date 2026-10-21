/* The budget model (预算): the tactic script turned into its ideal timeline by arithmetic, in a few
 * milliseconds. Build, train and upgrade times are the game's fixed data; what varies is income, so
 * the model keeps a running account: miners and lumberjacks bring gold and lumber at a per-worker
 * rate (five miners per mine at most), builds and trains pay when they start, earlier script lines
 * spend first, 留钱 holds money back from the lines after it. Walking is distance / speed in a
 * straight line, a clear takes CLEAR seconds after the army arrives. Every step's begin / work /
 * done time comes out, plus one frame a second (resources, where each unit roughly is, buildings)
 * for the sandbox. Estimates: connected to the game the rates are replaced by what it measures.
 * A time [9:30] is when the step is under way (the unit leaves early by its walk), [9:30 出发] when it
 * sets off; a squad (队伍 名字) moves whoever has joined it (加入 名字) until 解散.
 *
 * Runs in the browser (window.Budget) and in Node (module.exports) for the tests. */
(function (root) {
  'use strict';
  const RATES = {gold: 1.4, wood: 0.4, perMine: 5, farNatural: 0.2, peasant: 190, militia: 270, hero: 320, foot: 270,
    bell: 2, militia_s: 45, clear: 25, assist: 0.6, heroFree: true, startGold: 500, startWood: 150};
  const NAMES = {农民: 'hpea', 民兵: 'hmil', 步兵: 'hfoo', 大法师: 'Hamg', 山丘之王: 'Hmkg', 牧师: 'hmpr', 女巫: 'hsor', 破法者: 'hspt', 水元素: 'hwat',
    城镇大厅: 'htow', 分基地: 'htow', 主城: 'hkee', 城堡: 'hcas', 国王祭坛: 'halt', 祭坛: 'halt', 兵营: 'hbar', 农场: 'hhou', 伐木场: 'hlum',
    神秘藏宝室: 'hvlt', 藏宝室: 'hvlt', 神秘圣所: 'hars', 神秘圣地: 'hars', 圣所: 'hars', 侦察塔: 'hwtw', 奥术塔: 'hatw', 防御塔: 'hatw', 铁匠铺: 'hbla', 车间: 'harm', 狮鹫笼: 'hgra'};
  const HEROES = {大法师: 'Hamg', 山丘之王: 'Hmkg'};
  const NATURALS = [[-3776, -7488], [-6912, 2176], [4480, 6912], [7040, -2944]];
  const ONGOING = ['采金', '伐木', '集合', '待命'];
  const HALLS = ['htow', 'hkee', 'hcas'];
  const UPGRADES = ['hkee', 'hcas', 'hatw', 'hgtw', 'hctw'];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');

  /* ---------- reading the script (the editor's model: lanes of raw steps) ---------- */
  function parseCond(text) {
    const out = [];
    for (const part of String(text || '').split(/\s*且\s*/).map(x => x.replace(/\s+/g, '')).filter(Boolean)) {
      let m;
      const res = [...part.matchAll(/(金|木)(?:≥|>=)(\d+)/g)];
      if (res.length && /^(?:(?:金|木)(?:≥|>=)\d+)+$/.test(part)) res.forEach(r => out.push({kind: r[1] === '金' ? 'gold' : 'wood', n: +r[2]}));
      else if ((m = /^(\d+)[:：](\d{2})(出发)?$/.exec(part))) out.push(m[3] ? {kind: 'time', t: +m[1] * 60 + +m[2]} : {kind: 'time', t: +m[1] * 60 + +m[2], arrive: true});
      else if ((m = /^上一步完成后(\d+)秒$/.exec(part))) out.push({kind: 'after_prev', s: +m[1]});
      else if ((m = /^大法师出生前(\d+)秒$/.exec(part))) out.push({kind: 'hero_before', s: +m[1]});
      else if ((m = /^#(.+?)(开工|完成)$/.exec(part))) out.push({kind: m[2] === '开工' ? 'started' : 'done', tag: m[1]});
      else if ((m = /^(大法师|山丘之王)出生$/.exec(part))) out.push({kind: 'born', hero: HEROES[m[1]]});
      else if (/^大法师剩余(≤|<=)集合用时$/.test(part)) out.push({kind: 'eta'});
      else if (part === '清野完成') out.push({kind: 'cleared'});
      else if ((m = /^人口剩(≤|<=)(\d+)$/.exec(part))) out.push({kind: 'food', n: +m[2]});
    }
    return out;
  }
  function parseStep(raw) {
    let s = String(raw).trim(), cond = '';
    if (s.startsWith('[')) { const i = s.indexOf(']'); cond = s.slice(1, i); s = s.slice(i + 1).trim(); }
    const tag = ((' ' + s).match(/\s#(\S+)\s*$/) || [])[1] || '';
    if (tag) s = (' ' + s).replace(/\s#\S+\s*$/, '').trim();
    const pos = (s.match(/@(\S+)/) || [])[1] || '';
    s = s.replace(/@\S+/, '').replace(/\s+/g, ' ').trim();
    const w = s.split(' '), st = {raw: String(raw).trim(), cond: parseCond(cond), act: w[0], pos, tag};
    let m;
    if (st.act === '采金' || st.act === '伐木') st.mine = w[1] === '分矿' ? 'natural' : 'main';
    else if (st.act === '建造') st.btype = NAMES[w[1]] || 'hhou';
    else if (st.act === '学') st.skill = w[1];
    else if (st.act === '加入') st.squad = w[1];
    else if ((m = /^农民(\d+)$/.exec(st.act))) { st.act = '农民'; st.peasant = +m[1]; }
    else if (st.act === '升级') st.to = NAMES[w[1]];
    else if (st.act === '集结点') st.rallyHero = HEROES[w[1]] || null; // 集结点 大法师 waits for him
    else if (NAMES[st.act] && !['采金', '伐木', '协助', '敲钟', '集合', '清野', '待命', '移动', '攻击移动'].includes(st.act)) {
      st.unit = NAMES[st.act]; st.count = +((s.match(/[×x*](\d+)/) || [])[1] || 1); st.act = '训练';
    }
    return st;
  }
  function laneHead(head) {
    let m;
    head = String(head).trim();
    if ((m = /^农民([\d、,，\s]+)$/.exec(head))) return {kind: 'peasant', cids: m[1].split(/[、,，\s]+/).filter(Boolean).map(Number)};
    if (HEROES[head]) return {kind: 'hero', hero: HEROES[head]};
    if (head === '步兵' || head === '部队') return {kind: 'army'};
    if ((m = /^队伍\s*(\S+)$/.exec(head))) return {kind: 'squad', name: m[1]};
    if (head.startsWith('#')) return {kind: 'building', tag: head.slice(1)};
    return {kind: 'building', btype: NAMES[head]};
  }
  /* the script as text -> {lanes, positions, reserves} (the tests read the shipped file with it) */
  function fromText(text) {
    const out = {lanes: [], positions: [], reserves: []}, lines = [];
    String(text).split('\n').forEach((raw, n) => {
      const s = raw.trim();
      if (!s || (s.startsWith('#') && !s.startsWith('#⏸') && !/^#\S+[：:]/.test(s))) return;
      if (/^\s/.test(raw) || s.startsWith('→')) { if (lines.length) lines[lines.length - 1].s += ' ' + s; return; }
      lines.push({s, n: n + 1});
    });
    for (let {s, n} of lines) {
      let m;
      if ((m = /^位置\s*(\S+)\s*=\s*(.+)$/.exec(s))) { out.positions.push({name: m[1], expr: m[2].trim()}); continue; }
      if (s.startsWith('留钱')) { out.reserves.push({raw: s}); continue; }
      const muted = s.startsWith('#⏸'); if (muted) s = s.slice(2).trim();
      const i = s.search(/[：:]/); if (i < 0) continue;
      out.lanes.push({head: s.slice(0, i).trim(), line: n, muted, steps: s.slice(i + 1).split(/\s*→\s*/).map(x => x.trim()).filter(Boolean).map(raw => ({raw}))});
    }
    return out;
  }
  /* named places: 布局.X[n] / 分矿.X from the start's layout (a strategy's groups), the rest relative */
  function resolvePlaces(positions, groups, hall, natural) {
    const builds = (groups || []).flatMap(g => g.children || []).filter(e => e.kind === 'build').sort((a, b) => a.start - b.start || (a.seq || 0) - (b.seq || 0));
    const pools = {};
    for (const e of builds) { const site = e.at || e.site; if (site) (pools[(e.near === 'natural' ? 'natural:' : '') + e.btype] = pools[(e.near === 'natural' ? 'natural:' : '') + e.btype] || []).push(site); }
    const out = {}, toward = (a, b, d) => { const n = dist(a, b) || 1; return [a[0] + (b[0] - a[0]) / n * d, a[1] + (b[1] - a[1]) / n * d]; };
    const byName = Object.fromEntries(positions.map(p => [p.name, p.expr]));
    function res(expr, depth) {
      const e = String(expr).replace(/\s+/g, ''); let m;
      if ((m = /^布局\.(\D+?)(\d*)$/.exec(e))) return (pools[NAMES[m[1]]] || [])[(+m[2] || 1) - 1] || null;
      if ((m = /^分矿\.(\D+)$/.exec(e))) return (pools['natural:' + NAMES[m[1]]] || [])[0] || null;
      if (e === '本方向分矿') return natural ? toward(natural, hall, 500) : null;
      if ((m = /^分矿后方(\d+)$/.exec(e))) { const h = (pools['natural:htow'] || [])[0] || natural; return natural ? toward(natural, h, dist(natural, h) + +m[1]) : null; }
      if ((m = /^坐标(-?\d+)[,，](-?\d+)$/.exec(e))) return [+m[1], +m[2]];
      if ((m = /^(\S+?)前方(\d+)$/.exec(e)) && depth < 4 && byName[m[1]]) { const b = res(byName[m[1]], depth + 1); return b ? toward(b, hall, +m[2]) : null; }
      return null;
    }
    for (const p of positions) { const r = res(p.expr, 0); if (r) out[p.name] = [Math.round(r[0]), Math.round(r[1])]; }
    out.__pools = pools;
    return out;
  }

  /* ---------- what the game has done (the same reading as the server's timeline_of) ---------- */
  /* per lane label, each step's start (decision record: 「第 N 行第 K 步」) and work / done / site (events) */
  function actualOf(S) {
    const out = {}, cell = (label, k) => ((out[label] = out[label] || [])[k] = out[label][k] || {});
    for (const d of S.decisions || []) {
      const m = /^第 (\d+) 行第 (\d+) 步/.exec(d.why || ''), ci = (d.action || '').indexOf('：');
      if (!m || ci < 0) continue;
      const c = cell(d.action.slice(0, ci), +m[2] - 1); if (c.start == null) c.start = d.t;
    }
    const rts = S.events || {};
    for (const e of S.arbEvents || []) {
      if (e.phase == null || e.step == null) continue;
      const rt = rts[e.id] || {}, c = cell(e.phase, e.step);
      if (rt.bStart != null) c.work = rt.bStart; else if (rt.trainStart != null) c.work = rt.trainStart;
      if (rt.aEnd != null) c.done = rt.aEnd;
      if (rt.builtAt || e.site) c.at = rt.builtAt || e.site;
    }
    return out;
  }
  /* gathering speed per worker, measured: samples of the live game {t, got: [gold, wood], miners, natMiners,
   * natHall, jacks}; over the last `window` seconds, what came in divided by worker-seconds (the same
   * counting as the model: 5 a mine, a natural with no hall at farNatural). Null until there is enough. */
  function ratesFrom(samples, window = 90) {
    const S = samples.filter(x => x.t >= samples[samples.length - 1].t - window);
    if (S.length < 2) return null;
    let gw = 0, ww = 0;
    for (let i = 0; i + 1 < S.length; i++) {
      const a = S[i], dt = S[i + 1].t - a.t; if (dt <= 0 || dt > 10) continue;
      gw += (Math.min(a.miners, RATES.perMine) + Math.min(a.natMiners, RATES.perMine) * (a.natHall ? 1 : RATES.farNatural)) * dt;
      ww += a.jacks * dt;
    }
    const first = S[0], last = S[S.length - 1], out = {};
    if (gw >= 60) out.gold = Math.max(0.8, Math.min(3.5, (last.got[0] - first.got[0]) / gw));
    if (ww >= 60) out.wood = Math.max(0.2, Math.min(1.2, (last.got[1] - first.got[1]) / ww));
    return Object.keys(out).length ? out : null;
  }

  /* ---------- the run ---------- */
  function run(opts) {
    const eco = opts.eco, start = opts.start || 0, R = {...RATES, ...(opts.rates || {})}, END = opts.end || 600, DT = 0.5;
    const hall = opts.hall, mine = opts.mine, natural = opts.natural || NATURALS[start];
    const places = {...opts.places, 分矿: (opts.places || {}).分矿 || natural, 主矿: mine};
    const pools = (opts.places || {}).__pools || {}, usedSites = new Set();
    let gold = R.startGold, wood = R.startWood, got = [0, 0], t = 0, nextId = 101;
    const units = new Map(), buildings = [], frames = [], tags = {}; // tag -> building
    const awayFromMine = (() => { const n = dist(hall, mine) || 1; return [hall[0] + (hall[0] - mine[0]) / n * 700, hall[1] + (hall[1] - mine[1]) / n * 700]; })();
    const treeSpot = where => where === 'natural' ? (places.分矿木场 || [natural[0] + 500, natural[1] + 300]) : awayFromMine;
    function addBuilding(type, at, tag, done) { const b = {id: 'b' + buildings.length, type, x: at[0], y: at[1], tag, work: done ? -1 : t, done: done ? 0 : null, prog: done ? 1 : 0, helpers: new Set(), busy: null, queueFree: true}; buildings.push(b); if (tag) tags[tag] = b; return b; }
    let mainHall = addBuilding('htow', hall, null, true);
    for (let c = 1; c <= 5; c++) units.set(c, {id: c, type: 'hpea', x: hall[0] + (mine[0] - hall[0]) * 0.3 + (c - 3) * 40, y: hall[1] + (mine[1] - hall[1]) * 0.3, job: {kind: 'idle'}, walk: null});
    const foodCap = () => buildings.reduce((a, b) => a + (b.done != null && b.done <= t ? (eco[b.type] || {}).foodMade || 0 : 0), 0);
    let foodUsed = 5;

    // lanes: peasants one per cid, in the script's order (earlier lines spend first)
    const lanes = [];
    (opts.lanes || []).forEach((ln, i) => {
      const line = ln.line != null ? ln.line : i + 1;
      if (ln.muted) return;
      const h = laneHead(ln.head), steps = () => ln.steps.map(s => parseStep(s.raw));
      const base = {line, i: 0, on: false, done: false, rec: null, kind: h.kind};
      if (h.kind === 'peasant') h.cids.forEach(c => lanes.push({...base, cid: c, label: '农民' + c, steps: steps()}));
      else if (h.kind === 'hero') lanes.push({...base, hero: h.hero, label: ln.head, steps: steps()});
      else if (h.kind === 'army') lanes.push({...base, label: '步兵', steps: steps()});
      else if (h.kind === 'squad') lanes.push({...base, name: h.name, label: '队伍·' + h.name, steps: steps()});
      else lanes.push({...base, tag: h.tag, btype: h.btype, label: h.tag ? '#' + h.tag : (eco[h.btype] || {}).name || ln.head, steps: steps()});
    });
    lanes.forEach(L => { L.rec = L.steps.map(() => ({start: null, work: null, done: null, at: null})); });
    const tagPrio = {}; lanes.forEach(L => L.steps.forEach(s => { if (s.tag && tagPrio[s.tag] == null) tagPrio[s.tag] = L.line; }));
    const reserves = (opts.reserves || []).map(r => { const m = /留钱\s*金\s*(\d+)\s*木\s*(\d+)\s*给\s*#(\S+)(?:\s*从\s*\[(.+)\])?/.exec(r.raw) || []; return {gold: +m[1] || 0, wood: +m[2] || 0, tag: m[3], cond: parseCond(m[4]), on: false, off: false}; });
    let clear = null; // {start, end, done}
    const heroOf = type => [...units.values()].find(u => u.type === type);
    let heroTrain = null; // {start, end}

    // ---- money: earlier lines first; 留钱 held from lines after the reserved one
    function afford(g, w, line) {
      let hg = 0, hw = 0;
      for (const r of reserves) if (r.on && !r.off && (tagPrio[r.tag] ?? 1e9) < line) { hg += r.gold; hw += r.wood; }
      return gold - (g ? hg : 0) >= g && wood - (w ? hw : 0) >= w;
    }
    function pay(g, w) { gold -= g; wood -= w; }
    function holds(conds, L, st) {
      for (const c of conds) {
        if (c.kind === 'time' && t < c.t - (c.arrive ? walkOf(L, st) : 0)) return false;
        if (c.kind === 'after_prev') { const at = L ? (L.doneAt ?? L.prevDone) : null; if (at == null || t < at + c.s) return false; }
        if (c.kind === 'hero_before' && !heroOf('Hamg')) { const eta = heroTrain ? heroTrain.end : null; if (eta == null || t < eta - c.s) return false; }
        if (c.kind === 'gold' && gold < c.n) return false;
        if (c.kind === 'wood' && wood < c.n) return false;
        if (c.kind === 'started' && !(tags[c.tag] && tags[c.tag].work != null && tags[c.tag].work <= t)) return false;
        if (c.kind === 'done' && !(tags[c.tag] && tags[c.tag].done != null && tags[c.tag].done <= t)) return false;
        if (c.kind === 'born' && !heroOf(c.hero)) return false;
        if (c.kind === 'cleared' && !(clear && clear.end != null && clear.end <= t)) return false;
        if (c.kind === 'food' && foodCap() - foodUsed > c.n) return false;
        if (c.kind === 'eta') {
          const eta = heroOf('Hamg') ? t : heroTrain ? heroTrain.end : null; if (eta == null) return false;
          const u = L && units.get(L.cid), gather = nextPlace(L) || hall;
          const lead = (u ? dist([u.x, u.y], hall) / R.peasant : 5) + R.bell + dist(hall, gather) / R.militia;
          if (t < eta - lead) return false;
        }
      }
      return true;
    }
    /* where a step takes place, and how long the lane's unit walks there */
    function targetOf(L, st) {
      const a = st.act;
      if (a === '采金') return st.mine === 'natural' ? natural : mine;
      if (a === '伐木') return treeSpot(st.mine);
      if (a === '建造') return peekSite(st);
      if (a === '协助') { const b = tags[st.tag]; return b ? [b.x, b.y] : null; }
      if (a === '敲钟') return hall;
      if (a === '清野') return natural;
      if (a === '加入') return squadPlace(st.squad);
      return places[st.pos] || null;
    }
    function walkOf(L, st) {
      if (!L || !st || (L.kind !== 'peasant' && L.kind !== 'hero')) return 0;
      const u = L.kind === 'peasant' ? units.get(L.cid) : heroOf(L.hero), to = u && targetOf(L, st);
      return to ? dist([u.x, u.y], to) / speedOf(u) : 0;
    }
    const speedOf = u => (/^H/.test(u.type) ? R.hero : u.type === 'hmil' ? R.militia : u.type === 'hfoo' ? R.foot : R.peasant);
    function peekSite(st) {
      if (st.pos && st.pos !== '自动' && places[st.pos]) return places[st.pos];
      for (const s of pools[st.btype] || []) if (!usedSites.has(s.join()) && !Object.values(places).some(p => p && p[0] === s[0] && p[1] === s[1])) return s;
      return [hall[0] + 400, hall[1] - 400];
    }
    /* ---- squads: their steps move whoever has joined; the first waits for every member */
    const squadLane = name => lanes.find(Q => Q.kind === 'squad' && Q.name === name);
    function squadPlace(name) {
      const Q = squadLane(name); if (!Q) return null;
      const st = Q.on && !Q.done ? Q.steps[Q.i] : null;
      if (st && (st.act === '清野' ? natural : places[st.pos])) return st.act === '清野' ? natural : places[st.pos];
      const first = Q.steps.find(x => x.act === '清野' || places[x.pos]); return first ? (first.act === '清野' ? natural : places[first.pos]) : null;
    }
    function squadMembers(Q) {
      const isJoin = x => x.act === '加入' && x.squad === Q.name;
      const members = lanes.filter(M => (M.kind === 'peasant' || M.kind === 'hero') && !M.dead && M.steps.some(isJoin));
      const joined = members.filter(M => !M.done && M.on && isJoin(M.steps[M.i]));
      const waiting = members.filter(M => !M.done && !joined.includes(M) && M.steps.some((x, j) => isJoin(x) && j >= M.i));
      return {members, joined, waiting};
    }
    function squadGive(Q, st) { // the step to everyone in the squad now (late joiners too)
      const p = st.act === '清野' ? natural : places[st.pos]; if (!p) return;
      for (const M of squadMembers(Q).joined) {
        const u = M.kind === 'peasant' ? units.get(M.cid) : heroOf(M.hero); if (!u || Q.given.has(u.id)) continue;
        Q.given.add(u.id); u.job = {kind: st.act === '清野' ? 'clear' : 'squad'};
        Q.arrive = Math.max(Q.arrive || t, walkTo(u, p, speedOf(u)));
      }
    }
    function nextPlace(L) { if (!L) return null; for (let k = L.i + 1; k < L.steps.length; k++) if (L.steps[k].pos && places[L.steps[k].pos]) return places[L.steps[k].pos]; return null; }
    function walkTo(u, to, speed) { const from = [u.x, u.y], d = dist(from, to); u.walk = {from, to, t0: t, t1: t + d / speed}; return u.walk.t1; }
    function siteFor(st) {
      if (st.pos && st.pos !== '自动' && places[st.pos]) return places[st.pos];
      const pool = pools[st.btype] || [];
      for (const s of pool) { const k = s.join(); if (!usedSites.has(k) && !Object.values(places).some(p => p && p[0] === s[0] && p[1] === s[1])) { usedSites.add(k); return s; } }
      return [hall[0] + 400, hall[1] - 400];
    }

    // ---- one step of a lane: begin it, and say whether it is finished
    function begin(L, st, rec) {
      const u = L.kind === 'peasant' ? units.get(L.cid) : L.kind === 'hero' ? heroOf(L.hero) : null, a = st.act;
      if (L.kind === 'peasant') {
        if (['采金', '伐木', '建造', '协助', '敲钟'].includes(a) && u.type !== 'hpea') return false; // still a militia
        if (a === '采金') { u.job = {kind: 'gold', mine: st.mine}; walkTo(u, st.mine === 'natural' ? natural : mine, R.peasant); }
        else if (a === '伐木') { u.job = {kind: 'wood'}; walkTo(u, treeSpot(st.mine), R.peasant); }
        else if (a === '建造') { const site = siteFor(st); rec.at = site; u.job = {kind: 'build', site, arrive: walkTo(u, site, R.peasant)}; }
        else if (a === '协助') { const b = tags[st.tag]; if (!b || b.work == null || b.work > t) return false; u.job = {kind: 'assist', b, arrive: walkTo(u, [b.x, b.y], R.peasant)}; rec.at = [b.x, b.y]; }
        else if (a === '敲钟') { const arr = walkTo(u, hall, R.peasant); u.job = {kind: 'bell', at: arr + R.bell}; }
        else if (a === '集合' || a === '待命' || a === '移动') { const p = places[st.pos]; if (!p) return false; u.job = {kind: a === '移动' ? 'move' : 'hold', arrive: walkTo(u, p, u.type === 'hmil' ? R.militia : R.peasant)}; }
        else if (a === '清野') { if (!clear) return false; u.job = {kind: 'clear'}; walkTo(u, natural, u.type === 'hmil' ? R.militia : R.peasant); }
        else if (a === '加入') { const p = squadPlace(st.squad); u.job = {kind: 'squad'}; if (p) walkTo(u, p, speedOf(u)); }
        return true;
      }
      if (L.kind === 'squad') {
        const {joined, waiting} = squadMembers(L);
        if (L.i === 0 && (waiting.length || !joined.length)) return false; // everyone first
        if (a === '解散') { L.done = true; return true; }
        if (a === '清野' && !clear) return false; // the hero's lane starts the clear
        L.given = new Set(); L.arrive = t; squadGive(L, st); return true;
      }
      if (L.kind === 'hero') {
        if (!u) return false;
        if (a === '学') return true;
        if (a === '加入') { const p = squadPlace(st.squad); u.job = {kind: 'squad'}; if (p) walkTo(u, p, R.hero); return true; }
        if (a === '清野') { const arr = walkTo(u, natural, R.hero); clear = {start: t, end: arr + R.clear}; u.job = {kind: 'clear'}; return true; }
        const p = places[st.pos]; if (!p) return false;
        u.job = {kind: a === '移动' || a === '攻击移动' ? 'move' : 'hold', arrive: walkTo(u, p, R.hero)}; return true;
      }
      if (L.kind === 'army') {
        const p = places[st.pos], army = [...units.values()].filter(x => x.type === 'hfoo'); if (!p || !army.length) return false;
        let arr = t; for (const f of army) { f.job = {kind: st.act === '集合' || st.act === '待命' ? 'hold' : 'move'}; arr = Math.max(arr, walkTo(f, p, R.foot)); }
        L.arrive = arr; return true;
      }
      // a building's lane: train / upgrade / rally on its producers
      if (a === '集结点') return !st.rallyHero || !!heroOf(st.rallyHero);
      L.queued = 0; L.made = 0;
      if (a === '农民' || a === '训练') return trainOne(L, st, rec);
      const prods = producers(L).filter(b => !b.busy);
      if (!prods.length) return false;
      const b = prods[0];
      return upgrade(L, st, rec, b);
    }
    function trainOne(L, st, rec) {
      const b = producers(L).find(x => !x.busy); if (!b) return false;
      const ut = st.act === '农民' ? 'hpea' : st.unit, c = eco[ut] || {gold: 0, wood: 0, food: 1, time: 20};
      const free = R.heroFree && /^H/.test(ut) && !heroOf('Hamg') && !heroOf('Hmkg') && !heroTrain;
      const g = free ? 0 : c.gold, w = free ? 0 : c.wood;
      if (foodUsed + (c.food || 0) > foodCap() || !afford(g, w, L.line)) return false;
      pay(g, w); foodUsed += c.food || 0;
      b.busy = {kind: 'train', ut, as: st.peasant, end: t + c.time, L, k: L.i}; if (rec.work == null) rec.work = t; L.queued++;
      if (ut === 'Hamg') heroTrain = {start: t, end: t + c.time};
      return true;
    }
    function upgrade(L, st, rec, b) {
      const from = eco[b.type] || {gold: 0, wood: 0}, to = eco[st.to] || {gold: 0, wood: 0, time: 60};
      const g = Math.max(0, to.gold - from.gold), w = Math.max(0, to.wood - from.wood);
      if (!afford(g, w, L.line)) return false;
      pay(g, w); b.busy = {kind: 'upgrade', to: st.to, end: t + to.time, L, k: L.i}; rec.work = t;
      if (st.tag) tags[st.tag] = b.busy.mark = {work: t, done: null, x: b.x, y: b.y};
      return true;
    }
    function finished(L, st, rec) {
      const a = st.act;
      if (ONGOING.includes(a)) return true;
      if (a === '加入') { const Q = squadLane(st.squad); return !Q || Q.done; }
      if (L.kind === 'squad') return a === '解散' || (a === '清野' ? !!(clear && clear.end <= t) : t >= (L.arrive || 0));
      if (L.kind === 'peasant') {
        const u = units.get(L.cid);
        if (a === '建造' || a === '协助') return rec.done != null;
        if (a === '敲钟') return u.type === 'hmil';
        if (a === '移动') return u.walk == null || t >= u.walk.t1;
        if (a === '清野') return clear && clear.end <= t;
      }
      if (L.kind === 'hero') {
        if (a === '学') return true;
        if (a === '清野') return clear && clear.end <= t;
        const u = heroOf(L.hero); return !u || !u.walk || t >= u.walk.t1;
      }
      if (L.kind === 'army') return a !== '移动' && a !== '攻击移动' ? true : t >= (L.arrive || 0);
      if (a === '集结点') return true;
      if (a === '升级') return rec.work != null;
      return (L.made || 0) >= (st.count || 1); // 训练 ×N, 农民N: once they are out
    }
    /* ---- the game as it is: what each lane has done (its real times), units where they stand,
     * buildings with their progress and queues, the money in the bank; the clock goes on from there */
    function restore(S) {
      t = Math.ceil((S.t || 0) / DT) * DT;
      gold = S.gold || 0; wood = S.wood || 0; if (S.got) got = [S.got[0], S.got[1]];
      const act = actualOf(S);
      units.clear();
      for (const u of S.units || []) if (u.id) units.set(u.id, {id: u.id, type: u.type, x: u.x, y: u.y, job: {kind: 'idle'}, walk: null, milEnd: t + R.militia_s / 2});
      for (const id of units.keys()) if (id > 100) nextId = Math.max(nextId, id + 1);
      buildings.length = 0; for (const k of Object.keys(tags)) delete tags[k];
      const typeOfName = {}; for (const [k, v] of Object.entries(eco)) if (v && v.name && !(v.name in typeOfName)) typeOfName[v.name] = k;
      for (const x of S.buildings || []) {
        const b = addBuilding(x.type, [x.x, x.y], null, x.done);
        if (!x.done) { b.prog = x.progress || 0; b.work = t - b.prog * ((eco[x.type] || {}).time || 60); }
        const ut = x.train && typeOfName[x.train.name];
        if (ut) b.busy = UPGRADES.includes(ut) ? {kind: 'upgrade', to: ut, end: t + (x.train.left || 0), L: null} : {kind: 'train', ut, end: t + (x.train.left || 0), L: null};
      }
      const halls = buildings.filter(b => HALLS.includes(b.type));
      if (halls.length) mainHall = halls.reduce((a, b) => (dist([a.x, a.y], hall) <= dist([b.x, b.y], hall) ? a : b));
      const nearest = (type, at, open) => buildings.filter(b => b.type === type && (!open || b.done == null))
        .reduce((a, b) => (!a || (at && dist([b.x, b.y], at) < dist([a.x, a.y], at)) ? b : a), null);
      const live = Object.fromEntries(((S.script || {}).lanes || []).map(x => [x.label, x]));
      // what has happened: real times, tags, sites taken, the clear
      for (const L of lanes) {
        const X = live[L.label], A = act[L.label] || [];
        L.steps.forEach((st, k) => {
          const a = A[k] || {}, rec = L.rec[k];
          for (const f of ['start', 'work', 'done']) if (a[f] != null && a[f] <= t) rec[f] = a[f];
          if (a.at) { rec.at = a.at; usedSites.add(a.at.join()); }
          if (st.tag && rec.work != null) {
            if (st.act === '建造') { const b = nearest(st.btype, rec.at); if (b) { tags[st.tag] = b; b.tag = st.tag; if (b.done == null) { b.L = L; b.k = k; } } }
            else if (st.act === '升级') tags[st.tag] = {work: rec.work, done: rec.done != null ? rec.done : null, x: mainHall.x, y: mainHall.y};
          }
        });
        if (!X) continue;
        L.i = Math.max(0, Math.min(X.i, L.steps.length - 1)); L.on = !!X.on; L.done = !!X.done;
        if (X.dead) { L.done = true; L.dead = true; units.delete(L.cid); }
        if (L.kind === 'hero') {
          const ci = L.steps.findIndex(x => x.act === '清野'), r = L.rec[ci];
          if (ci >= 0 && r && r.start != null) {
            const u = heroOf(L.hero), next = L.rec[ci + 1] && L.rec[ci + 1].start;
            if (L.i > ci || r.done != null) clear = {start: r.start, end: r.done != null ? r.done : next != null ? next : t};
            else clear = {start: r.start, end: t + (u ? dist([u.x, u.y], natural) / R.hero : 0) + Math.max(5, R.clear - (t - r.start))};
          }
        }
      }
      for (const b of buildings) if (b.busy && b.busy.ut === 'Hamg') heroTrain = {start: t, end: b.busy.end};
      // what is going on: give each unit his step again from where he stands, queues to their lanes
      for (const L of lanes) {
        if (L.done || !L.on) continue;
        const st = L.steps[L.i], rec = L.rec[L.i];
        if (L.kind === 'peasant') {
          const u = units.get(L.cid); if (!u) { L.on = false; continue; } // in training
          if (st.act === '建造' && rec.work != null) { const b = nearest(st.btype, rec.at, true); u.job = {kind: 'build', site: rec.at || [u.x, u.y], arrive: t, b}; continue; }
          if (st.act === '建造' && rec.at) { u.job = {kind: 'build', site: rec.at, arrive: walkTo(u, rec.at, R.peasant)}; continue; }
          if (u.type === 'hmil' && st.act === '敲钟') continue;
          if (!begin(L, st, rec) && !ONGOING.includes(st.act)) L.on = false;
          continue;
        }
        if (L.kind === 'squad') { if (st.act === '解散') L.done = true; else { L.given = new Set(); L.arrive = t; squadGive(L, st); } continue; }
        if (L.kind === 'hero' || L.kind === 'army') { if (st.act === '清野') { const u = heroOf(L.hero); if (u) { u.job = {kind: 'clear'}; walkTo(u, natural, R.hero); } } else if (!begin(L, st, rec) && !ONGOING.includes(st.act)) L.on = false; continue; }
        // a building's lane: its queue is already in the building
        if (st.act === '训练' || st.act === '农民') {
          const ut = st.act === '农民' ? 'hpea' : st.unit, b = producers(L).find(x => x.busy && x.busy.kind === 'train' && x.busy.ut === ut && !x.busy.L);
          const earlier = L.steps.slice(0, L.i).filter(x => x.unit === ut).reduce((a, x) => a + (x.count || 1), 0);
          L.made = st.act === '农民' ? 0 : Math.max(0, Math.min((st.count || 1) - (b ? 1 : 0), [...units.values()].filter(u => u.type === ut).length - earlier));
          L.queued = L.made + (b ? 1 : 0);
          if (b) Object.assign(b.busy, {L, k: L.i, as: st.peasant});
        } else if (st.act === '升级') {
          const b = producers(L).find(x => x.busy && x.busy.kind === 'upgrade' && !x.busy.L) || buildings.find(x => x.busy && x.busy.kind === 'upgrade' && x.busy.to === st.to && !x.busy.L);
          if (b) { Object.assign(b.busy, {L, k: L.i}); if (st.tag && tags[st.tag] && tags[st.tag].done == null) b.busy.mark = tags[st.tag]; }
        }
      }
      for (const r of reserves) if (tags[r.tag] && tags[r.tag].work != null) r.off = true;
    }
    function producers(L) {
      if (L.tag) { const b = tags[L.tag]; return b && b.done != null && b.done <= t ? [b] : []; }
      if (HALLS.includes(L.btype)) return [mainHall];
      return buildings.filter(b => b.type === L.btype && b.done != null && b.done <= t);
    }

    if (opts.live) restore(opts.live);
    const now = t;
    if (opts.live) { foodUsed = opts.live.foodUsed != null ? opts.live.foodUsed : foodUsed; frames.push({...frame(), t: opts.live.t, gold: Math.floor(gold), wood: Math.floor(wood)}); } // the game as it is, before the model moves

    // ---- the clock
    for (; t <= END + 1e-9; t = Math.round((t + DT) * 100) / 100) {
      // income
      let nm = 0, nn = 0, nw = 0;
      for (const u of units.values()) {
        if (u.type !== 'hpea' || (u.walk && t < u.walk.t1)) continue;
        if (u.job.kind === 'gold') u.job.mine === 'natural' ? nn++ : nm++;
        else if (u.job.kind === 'wood') nw++;
      }
      const natHall = buildings.some(b => HALLS.includes(b.type) && b !== mainHall && b.done != null && b.done <= t);
      const dg = (Math.min(nm, R.perMine) + Math.min(nn, R.perMine) * (natHall ? 1 : R.farNatural)) * R.gold * DT, dw = nw * R.wood * DT;
      gold += dg; wood += dw; got[0] += dg; got[1] += dw;
      // buildings: construction (helpers speed it up), training, upgrades
      for (const b of buildings) {
        if (b.done == null && b.work != null && b.work <= t) {
          const helpers = [...units.values()].filter(u => u.job.kind === 'assist' && u.job.b === b && t >= u.job.arrive).length;
          b.prog += DT * (1 + R.assist * helpers) / ((eco[b.type] || {}).time || 60);
          if (b.prog >= 1) { b.done = t; b.prog = 1; for (const u of units.values()) if ((u.job.kind === 'build' && u.job.b === b) || (u.job.kind === 'assist' && u.job.b === b)) u.job.doneAt = t; if (b.L) b.L.rec[b.k].done = t; for (const L of lanes) L.steps.forEach((s, k) => { if (s.act === '协助' && s.tag && tags[s.tag] === b && L.rec[k].start != null && L.rec[k].done == null) L.rec[k].done = t; }); }
        }
        if (b.busy && t >= b.busy.end) {
          const bz = b.busy; b.busy = null;
          if (bz.kind === 'train') {
            const id = bz.ut === 'hpea' && bz.as ? bz.as : nextId++;
            units.set(id, {id, type: bz.ut, x: b.x + 120, y: b.y - 120, job: {kind: 'idle'}, walk: null});
            if (bz.L) { bz.L.rec[bz.k].done = t; bz.L.made = (bz.L.made || 0) + 1; }
            if (bz.ut === 'Hamg') heroTrain = null;
          } else { b.type = bz.to; if (bz.L) bz.L.rec[bz.k].done = t; if (bz.mark) bz.mark.done = t; }
        }
      }
      // militia: change at the hall, turn back 45 s later
      for (const u of units.values()) {
        if (u.job.kind === 'bell' && t >= u.job.at && u.type === 'hpea') { u.type = 'hmil'; u.milEnd = t + R.militia_s; }
        if (u.type === 'hmil' && t >= u.milEnd) {
          u.type = 'hpea';
          const L = lanes.find(x => x.cid === u.id && x.on && !x.done);
          if (L && (L.steps[L.i].act === '采金' || L.steps[L.i].act === '伐木')) begin(L, L.steps[L.i], L.rec[L.i]);
        }
      }
      for (const r of reserves) { if (!r.on && !r.off && holds(r.cond)) r.on = true; if (r.on && !r.off && tags[r.tag] && tags[r.tag].work != null) r.off = true; }
      // lanes, earlier lines first
      for (const L of lanes) {
        if (L.done) continue;
        if (L.kind === 'peasant' && !units.has(L.cid)) continue; // not trained yet
        if (L.kind === 'hero' && !heroOf(L.hero)) continue;
        if (L.kind === 'building' && !producers(L).length) continue; // not built yet
        for (let guard = 0; guard < 4; guard++) {
          const st = L.steps[L.i], rec = L.rec[L.i];
          if (!L.on) {
            if (!holds(st.cond, L, st) || !begin(L, st, rec)) break;
            L.on = true; rec.start = t;
          }
          // a build pays when its builder arrives (and the money is there), then the building stands
          if (L.kind === 'peasant' && st.act === '建造' && rec.work == null) {
            const u = units.get(L.cid);
            if (t >= u.job.arrive) { const c = eco[st.btype] || {gold: 0, wood: 0}; if (afford(c.gold, c.wood, L.line)) { pay(c.gold, c.wood); const b = addBuilding(st.btype, u.job.site, st.tag || null, false); b.L = L; b.k = L.i; u.job.b = b; rec.work = t; } }
          }
          if ((st.act === '训练' || st.act === '农民') && L.on && L.queued < (st.count || 1)) trainOne(L, st, rec); // the rest of ×N; a queue the game had not started yet
          if (L.kind === 'squad' && L.on && !L.done) squadGive(L, st);
          if (!finished(L, st, rec)) break;
          if (L.doneAt == null) L.doneAt = t; // for 上一步完成后 N 秒
          if (rec.done == null && !ONGOING.includes(st.act) && st.act !== '训练' && st.act !== '农民' && st.act !== '升级') rec.done = t;
          if (L.i + 1 >= L.steps.length) { if (!ONGOING.includes(st.act)) L.done = true; break; }
          if (!holds(L.steps[L.i + 1].cond, L, L.steps[L.i + 1])) break;
          if (rec.end == null) rec.end = t;
          L.i++; L.on = false; L.prevDone = L.doneAt; L.doneAt = null;
        }
      }
      // food in use: peasants 1, footmen 2, heroes 5 (training counted when it starts)
      foodUsed = [...units.values()].reduce((a, u) => a + ((eco[u.type === 'hmil' ? 'hpea' : u.type] || {}).food || 0), 0) +
        buildings.reduce((a, b) => a + (b.busy && b.busy.kind === 'train' ? (eco[b.busy.ut] || {}).food || 0 : 0), 0);
      if (Math.abs(t - Math.round(t)) < 1e-6) frames.push(frame());
    }
    function frame() {
      const us = [...units.values()].map(u => {
        let x = u.x, y = u.y;
        if (u.walk) { const k = Math.min(1, (t - u.walk.t0) / Math.max(0.01, u.walk.t1 - u.walk.t0)); x = u.walk.from[0] + (u.walk.to[0] - u.walk.from[0]) * k; y = u.walk.from[1] + (u.walk.to[1] - u.walk.from[1]) * k; if (k >= 1) { u.x = x; u.y = y; } }
        const role = u.type !== 'hpea' ? 'idle' : u.walk && t < u.walk.t1 ? (u.job.kind === 'gold' ? 'gold' : u.job.kind === 'wood' ? 'wood' : 'build') : u.job.kind === 'gold' ? 'gold' : u.job.kind === 'wood' ? 'wood' : u.job.kind === 'idle' ? 'idle' : 'build';
        return {id: u.id, type: u.type, x: Math.round(x), y: Math.round(y), hidden: false, role, task: ''};
      });
      return {t, gold: Math.floor(gold), wood: Math.floor(wood), foodUsed, foodCap: foodCap(), got: [Math.round(got[0]), Math.round(got[1])], units: us,
        buildings: buildings.filter(b => b.work != null && b.work <= t).map(b => ({id: b.id, type: b.type, x: b.x, y: b.y, done: b.done != null && b.done <= t, progress: Math.min(1, b.prog)}))};
    }
    // ---- the timeline, in the shape the console draws (same as the server's)
    const tl = lanes.map(L => ({label: L.label, kind: L.kind, line: L.line, dead: false, steps: L.steps.map((s, k) => {
      const r = L.rec[k], nxt = L.rec.slice(k + 1).find(x => x.start != null);
      const out = {raw: s.raw, start: r.start, end: nxt ? nxt.start : r.done};
      if (r.work != null && (s.act === '建造' || s.act === '训练' || s.act === '农民' || s.act === '升级')) out.work = r.work;
      if (r.done != null) out.done = r.done;
      if (r.at) out.at = r.at;
      return out;
    })}));
    for (const ln of (opts.lanes || []).filter(x => x.muted)) {
      const h = laneHead(ln.head), labels = h.kind === 'peasant' ? h.cids.map(c => '农民' + c) : h.kind === 'squad' ? ['队伍·' + h.name] : [ln.head];
      for (const label of labels) tl.push({label, kind: h.kind, line: ln.line != null ? ln.line : (opts.lanes || []).indexOf(ln) + 1, muted: true, dead: false, steps: ln.steps.map(s => ({raw: s.raw, start: null, end: null}))});
    }
    tl.sort((a, b) => a.line - b.line);
    const decisions = [];
    for (const L of lanes) L.steps.forEach((s, k) => { if (L.rec[k].start != null) decisions.push({t: L.rec[k].start, rule: 'L' + L.line, why: `第 ${L.line} 行第 ${k + 1} 步`, action: `${L.label}：${s.raw}`}); });
    decisions.sort((a, b) => a.t - b.t);
    const types = {}; for (const u of units.values()) types[u.id] = u.type === 'hmil' ? 'hpea' : u.type;
    const cleanPlaces = Object.fromEntries(Object.entries(places).filter(([k, v]) => k !== '__pools' && v));
    const last = frames[frames.length - 1] || {gold, wood, foodUsed, foodCap: foodCap()};
    return {ok: true, budget: true, t: END, now, frames, timeline: {lanes: tl, places: cleanPlaces, hall, mine, natural, mineGold: 12500, units: types},
      gold: last.gold, wood: last.wood, foodUsed: last.foodUsed, foodCap: last.foodCap, decisions, script: {lanes: tl.map(l => ({label: l.label, kind: l.kind, line: l.line, i: 0, on: false, done: false, dead: false, muted: !!l.muted, steps: l.steps.map(s => s.raw)})), positions: cleanPlaces},
      meta: {name: '预算 · 出生点 ' + start, start, preview: true, budget: true},
      state: {start, arbiter: false, decisions, arbEvents: [], events: {}, consistency: null, script: {lanes: [], positions: cleanPlaces}},
      rates: R};
  }

  const Budget = {run, actualOf, ratesFrom, fromText, parseStep, parseCond, laneHead, resolvePlaces, RATES, NATURALS, fmt};
  if (typeof module !== 'undefined' && module.exports) module.exports = Budget;
  else root.Budget = Budget;
})(typeof window !== 'undefined' ? window : globalThis);
