/* The console's sandbox: the map at the red line (units, creeps, buildings, sites) and each unit's whole
   life as a route. Select and command like in the game: right-click gives an order from the red line,
   Shift+right-click puts it at the end of the unit's life; every change goes into the script through the
   timeline (window.TL, console/timeline.js), and the shell recomputes and reloads. Map: web/data/sandbox-map.js. */
(function () {
  'use strict';
  const TL = window.TL, M = window.MAPDATA, D = TL.D, $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const BT = {农场: 'hhou', 兵营: 'hbar', 国王祭坛: 'halt', 伐木场: 'hlum', 城镇大厅: 'htow', 侦察塔: 'hwtw', 神秘藏宝室: 'hvlt', 神秘圣所: 'hars', 铁匠铺: 'hbla'};
  const BUILD_LIST = ['农场', '兵营', '国王祭坛', '伐木场', '城镇大厅', '侦察塔', '神秘藏宝室', '神秘圣所', '铁匠铺'];
  const cv = $('map'), ctx = cv.getContext('2d'), img = new Image(), tex = document.createElement('canvas');
  const NEUTRALS = (window.LT_DATA && window.LT_DATA.neutrals) || [];
  let texData = null;
  img.onload = () => { tex.width = M.w; tex.height = M.h; const c = tex.getContext('2d'); c.drawImage(img, 0, 0); texData = c.getImageData(0, 0, M.w, M.h).data; };
  img.src = M.png;
  let CW = 0, CH = 0, dpr = 1;
  const cam = {x: -900, y: -7050, s: 0.14};
  let mode = null, mouse = null, box = null, flags = [], menu = 'main';

  function resize() {
    const r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1; CW = r.width; CH = r.height;
    cv.width = Math.round(CW * dpr); cv.height = Math.round(CH * dpr);
  }
  const sx = x => CW / 2 + (x - cam.x) * cam.s, sy = y => CH / 2 - (y - cam.y) * cam.s;
  const wx = px => cam.x + (px - CW / 2) / cam.s, wy = py => cam.y - (py - CH / 2) / cam.s;
  function fit() { resize(); cam.s = Math.max(0.02, Math.min(CW / (M.x1 - M.x0), CH / (M.y1 - M.y0))); cam.x = (M.x0 + M.x1) / 2; cam.y = (M.y0 + M.y1) / 2; } // the whole map
  function home() { resize(); cam.s = Math.max(0.05, CW / 6600); cam.x = (D.hall[0] * 2 + D.natural[0]) / 3; cam.y = (D.hall[1] * 2 + D.natural[1]) / 3; clampCam(); } // the base and its natural

  /* ---------- what stands where at time t ---------- */
  // 实战 up to now and 回放: what the game itself showed that second (D.real); the estimate only beyond
  const BNAME = {...Object.fromEntries(Object.entries(BT).map(([n, ty]) => [ty, n])), hkee: '主城', hcas: '城堡', hatw: '奥术塔', hgtw: '防御塔', hctw: '炮塔', hgra: '狮鹫笼', hars: '神秘圣所'};
  function realAt(t) {
    const R = D.real; if (!R || !R.frames.length || t > R.upTo + 1.5) return null;
    const ls = window.CONSOLE && CONSOLE.liveState && CONSOLE.liveState();
    if (ls && t >= ls.t - 1) return ls; // the red line: the game as it is this quarter second
    return R.frames[Math.max(0, Math.min(R.frames.length - 1, Math.floor(t)))];
  }
  function realBuildings(f, t) {
    const steps = []; // the script's build steps, to name who builds what and to click through to them
    TL.lanes.forEach(L => L.steps.forEach((st, k) => { if (!/^建造/.test(st.body)) return; const what = st.body.split(' ')[1], at = st.at || D.places[st.pos]; if (BT[what]) steps.push({L, k, s: st, what, type: BT[what], at}); }));
    const used = new Set(), out = [];
    for (const g of f.buildings) {
      const hall = Math.hypot(g.x - D.hall[0], g.y - D.hall[1]) < 200;
      const b = {type: g.type, x: g.x, y: g.y, name: hall && g.type === 'htow' ? '城镇大厅' : BNAME[g.type] || g.type, state: g.done ? 'up' : 'building', p: g.done ? 1 : Math.max(0.02, g.progress || 0), real: true};
      let best = null, bd = 900;
      for (const m of steps) if (!used.has(m) && m.type === g.type && m.s.work != null && m.s.work <= t + 2) { const d = m.at ? Math.hypot(m.at[0] - g.x, m.at[1] - g.y) : 800; if (d < bd) { bd = d; best = m; } }
      if (best) { used.add(best); Object.assign(b, {who: best.L.label, L: best.L, k: best.k, s: best.s}); }
      out.push(b);
    }
    for (const m of steps) { // planned and not begun in the game yet: the dashed site
      if (used.has(m) || !m.at || (m.s.work != null && t >= m.s.work)) continue;
      out.push({type: m.type, x: m.at[0], y: m.at[1], name: m.what, who: m.L.label, L: m.L, k: m.k, s: m.s, state: m.s.start != null && t >= m.s.start ? 'ordered' : 'plan'});
    }
    return out;
  }
  function buildingsAt(t) {
    const f = realAt(t); if (f) return realBuildings(f, t);
    const out = [{type: 'htow', x: D.hall[0], y: D.hall[1], name: '城镇大厅', p: 1, state: 'up'}];
    const keep = TL.lanes.find(L => L.label === '城镇大厅'), ks = keep && keep.steps.find(s => /^升级 主城/.test(s.body));
    if (ks && ks.done != null && t >= ks.done) { out[0].type = 'hkee'; out[0].name = '主城'; }
    else if (ks && ks.work != null && t >= ks.work) out[0].name = '城镇大厅 → 主城 ' + Math.round((t - ks.work) / (ks.done - ks.work) * 100) + '%';
    TL.lanes.forEach(L => L.steps.forEach((s, k) => {
      if (!/^建造/.test(s.body)) return;
      const what = s.body.split(' ')[1], type = BT[what], at = s.at || D.places[s.pos]; if (!type || !at) return;
      const b = {type, x: at[0], y: at[1], name: what, who: L.label, L, k, s};
      if (s.work != null && t >= s.work) { b.state = s.done != null && t >= s.done ? 'up' : 'building'; b.p = s.done != null ? Math.min(1, (t - s.work) / (s.done - s.work)) : 0.5; }
      else b.state = s.start != null && t >= s.start ? 'ordered' : 'plan';
      out.push(b);
    }));
    return out;
  }
  const rectOf = (b, which) => { const r = (M.body[b.type] || M.body.hhou)[which]; return [b.x + r[0], b.y + r[1], b.x + r[2], b.y + r[3]]; };
  function creepsUp(t) { const h = TL.lanes.find(L => L.label === '大法师'), s = h && h.steps.find(x => /^清野/.test(x.body)); return !(s && s.start != null && t >= (s.done ?? TL.stepEnd(s) ?? 1e9)); }
  function units(t) {
    const f = realAt(t);
    if (f) return f.units.filter(u => !u.hidden).map(u => ({cid: u.id, type: u.type, x: u.x, y: u.y, L: TL.laneOfCid(u.id), real: true})); // summons and militia as the game has them
    const out = Object.keys(D.pos).map(Number).map(cid => {
      const p = TL.basePos(cid, t); if (!p) return null; // the budget follows every edit: no stand-in walks
      const type = TL.unitType(cid), L = TL.laneOfCid(cid);
      const bell = L && L.steps.find(s => /^敲钟/.test(s.body) && s.start != null && t >= s.start + 3 && t <= s.start + 48);
      return {cid, type: bell ? 'hmil' : type, x: p[0], y: p[1], L};
    }).filter(Boolean);
    // the archmage's water elementals while he clears (summons: on the map, not in the script)
    const hero = out.find(u => u.type === 'Hamg'), cl = clearSpan();
    if (hero && cl && t >= cl[0] && t <= cl[0] + 60) [[-90, 70], [80, 90]].slice(0, t >= cl[0] + 18 ? 2 : 1).forEach(([dx, dy], i) => out.push({cid: 900 + i, type: 'hwat', x: hero.x + dx, y: hero.y + dy, summon: true}));
    const solid = buildingsAt(t).filter(b => b.state === 'up' || b.state === 'building').map(b => rectOf(b, 'body')), used = new Map();
    for (const u of out) {
      const r = solid.find(q => u.x > q[0] - 20 && u.x < q[2] + 20 && u.y > q[1] - 20 && u.y < q[3] + 20); if (!r) continue;
      const key = r.join(), n = used.get(key) || 0, per = Math.max(1, Math.floor((r[2] - r[0]) / 44)); used.set(key, n + 1);
      u.x = r[0] + 22 + (n % per) * 44; u.y = r[1] - 34 - Math.floor(n / per) * 42;
    }
    return out;
  }
  function clearSpan() { const h = TL.lanes.find(L => L.label === '大法师'), s = h && h.steps.find(x => /^清野/.test(x.body)); return s && s.start != null ? [s.start + 12, s.done ?? TL.stepEnd(s) ?? s.start + 40] : null; }
  /* creeps: the camp at this start's natural (what the fake game puts there), and the other camps by
     the other mines (positions are illustrative until they are read from the map file) */
  let CAMPS = [];
  function computeCamps() { CAMPS = makeCamps(); }
  function makeCamps() {
    const nat = D.natural, out = [{name: '分矿野点', main: true, units: [ // as bridge/commander_bridge/server.py PREVIEW_CAMP puts them in the fake game
      {n: '森林巨魔', lv: 3, hp: 240, at: [nat[0] + 280, nat[1] + 230]}, {n: '森林巨魔暗影祭司', lv: 2, hp: 200, at: [nat[0] + 220, nat[1] + 300]},
      {n: '森林巨魔', lv: 3, hp: 240, at: [nat[0] + 340, nat[1] + 180]}]}];
    for (const n of NEUTRALS) { const r = Math.max(4, 90 * cam.s), x = sx(n.x), y = sy(n.y); ctx.fillStyle = 'rgba(160,140,200,.55)'; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); if (r > 10) label(n.name, x, y, '#e8dcf8', 10); }
    for (const m of M.mines) {
      if (Math.hypot(m.x - D.natural[0], m.y - D.natural[1]) < 400 || Math.hypot(m.x - D.mine[0], m.y - D.mine[1]) < 400) continue;
      const k = 420 / (Math.hypot(m.x, m.y) || 1), cx = m.x - m.x * k, cy = m.y - m.y * k;
      out.push({name: '野点（位置示意）', units: [{n: '野怪', lv: 3, hp: 400, at: [cx - 60, cy]}, {n: '野怪', lv: 3, hp: 400, at: [cx + 60, cy + 30]}]});
    }
    return out;
  }
  const CREEP_HP = {}; // the most each creep type was seen with: its full health, near enough
  function creepsAt(t) {
    const f = realAt(t);
    if (f && f.creeps) { // what the game shows: the creeps in sight; camps never seen stay as sketched
      const R = D.real, nat = D.natural;
      if (R.natSeen == null) R.natSeen = R.frames.findIndex(x => (x.creeps || []).some(c => Math.hypot(c.x - nat[0], c.y - nat[1]) < 1500));
      const seen = f.creeps.map(c => { CREEP_HP[c.type] = Math.max(CREEP_HP[c.type] || 0, c.hp || 0); return {n: c.type, lv: '', x: c.x, y: c.y, hpLeft: Math.max(0.05, (c.hp || 1) / (CREEP_HP[c.type] || c.hp || 1)), camp: '', real: true}; });
      const sketch = CAMPS.filter(c => !(c.main && R.natSeen >= 0 && R.natSeen <= t) && !seen.some(u => Math.hypot(u.x - c.units[0].at[0], u.y - c.units[0].at[1]) < 900));
      return seen.concat(...sketch.map(c => c.units.map(u => ({...u, x: u.at[0], y: u.at[1], hpLeft: 1, camp: c.name}))));
    }
    const cl = clearSpan(), out = [];
    CAMPS.forEach(c => c.units.forEach((u, i) => {
      let hp = 1;
      if (c.main && cl) { const dieAt = cl[0] + (cl[1] - cl[0]) * [0.45, 0.75, 1][i]; if (t >= dieAt) return; if (t > cl[0]) hp = 1 - (t - cl[0]) / (dieAt - cl[0]); }
      out.push({...u, x: u.at[0], y: u.at[1], hpLeft: Math.max(0.05, hp), camp: c.name});
    }));
    return out;
  }
  function routeOf(u, t) { // where he is heading: the order given here, or the place his current step names
    if (!u.L) return null;
    const cur = TL.current(u.L.steps.map(step => ({step})), t).cur; if (!cur) return null;
    const s = cur.step, place = s.at || D.places[s.pos];
    if (/^采金/.test(s.body)) return s.body.includes('分矿') ? D.natural : D.mine;
    if (/^(建造|集合|待命|清野|移动到|攻击移动)/.test(s.body)) return place || (/^清野/.test(s.body) ? D.natural : null);
    return null;
  }

  const UL = {hfoo: '步', hspt: '破', hmpr: '牧', hsor: '巫', Hmkg: '山'};
  const groupOf = cid => { const g = TL.groups().filter(x => x.key).sort((a, b) => a.key - b.key).find(x => x.cids.includes(cid)); return g ? g.key : null; };
  function hpBar(x, y, w, k) { ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 4); ctx.fillStyle = k > 0.5 ? '#7fb069' : k > 0.25 ? '#e0c14a' : '#d0584a'; ctx.fillRect(x - w / 2, y, w * k, 2); }
  /* where a unit goes next: the target of the step he is on, then the steps queued after it */
  function targetOf(s) {
    if (/^加入 /.test(s.body)) { const q = squads.find(x => x.name === s.body.slice(3)); const p = q && squadPlaces(q)[0]; return p ? p.at : null; }
    const place = s.at || D.places[s.pos];
    if (/^采金/.test(s.body)) return s.body.includes('分矿') ? D.natural : D.mine;
    if (/^伐木/.test(s.body)) return s.body.includes('分矿') ? [D.natural[0] + 520, D.natural[1] + 380] : [D.hall[0] - 700, D.hall[1] + 420];
    if (/^敲钟/.test(s.body)) return D.hall;
    if (/^(建造|集合|待命|清野|移动|攻击移动)/.test(s.body)) return place || (/^清野/.test(s.body) ? [D.natural[0] + 300, D.natural[1] + 250] : null);
    return null;
  }
  function queueOf(u, t) {
    if (!u.L) return [];
    const st = u.L.steps, cur = TL.current(st.map(step => ({step})), t).cur, k0 = cur ? st.indexOf(cur.step) : st.findIndex(s => s.start == null || s.start > t);
    const out = [];
    for (let k = Math.max(0, k0); k < st.length && out.length < 4; k++) { const at = targetOf(st[k]); if (at) out.push({at, text: st[k].body.split(' ').slice(0, 2).join(' ')}); }
    return out;
  }


  /* ---------- lifecycles: a unit's steps from birth to the end, as a route on the map ----------
     Right-click gives an order from the red line (it interrupts); Shift+right-click puts it at the end
     of his lifecycle. Each step can wait for something before it starts: a moment, a delay after the
     step before, the hero's birth, a building, the money. */
  const SPD = {hpea: 190, hmil: 270, Hamg: 320, Hmkg: 270, hfoo: 270};
  const TRAIN = {农民: 15, 大法师: 55, 山丘之王: 55, 步兵: 20, 破法者: 28, 牧师: 28, 女巫: 30, 主城: 140, 城堡: 140, 奥术塔: 50, 集结点: 0};
  let lifeSel = null, lifeLane = null, showAll = false, lifeNodes = [], nodeDrag = null, placeN = 1;
  const condTerms = TL.condTerms, rawOf = s => `${s.cond ? '[' + s.cond + '] ' : ''}${s.body}${s.pos ? ' @' + s.pos : ''}${s.tag ? ' #' + s.tag : ''}`;
  function birthOf(L) { const tr = D.pos[TL.cidOfLane(L)]; return tr && tr.length ? [tr[0][1], tr[0][2]] : D.hall; }
  function lifePoints(L) {
    let at = birthOf(L); const out = [{at}];
    L.steps.forEach((s, k) => {
      const q = isJoin(s) && squadByName(s.body.slice(3));
      if (q) { squadPlaces(q).forEach((p, i) => { out.push({at: p.at, k, s, ss: p.s, moved: true, squad: q, first: i === 0}); at = p.at; }); return; }
      const to = targetOf(s); if (to) at = to; out.push({at, k, s, moved: !!to});
    });
    return out;
  }
  const heroBorn = () => { const A = TL.lanes.find(x => x.label === '国王祭坛'), s = A && A.steps.find(x => /^大法师/.test(x.body)); return s ? s.done : null; };
  const tagTime = (tag, when) => { for (const M of TL.lanes) for (const s of M.steps) if (s.tag === tag && /^(建造|升级)/.test(s.body)) return when === '开工' ? (s.work ?? s.start) : s.done; return null; };
  const clearEnd = () => { const h = TL.lanes.find(L => L.label === '大法师'), s = h && h.steps.find(x => /^清野/.test(x.body)); return s ? (s.done ?? TL.stepEnd(s)) : null; };
  const timeTerm = s => { for (const c of condTerms(s.cond)) { const m = /^(\d+):(\d{2})(\s*出发)?$/.exec(c); if (m) return {t: +m[1] * 60 + +m[2], depart: !!m[3]}; } return null; };
  function condStart(s, base, skipTime) {
    let t0 = base;
    for (const c of condTerms(s.cond)) {
      let m;
      if ((m = /^(\d+):(\d{2})(\s*出发)?$/.exec(c))) { if (!skipTime) t0 = Math.max(t0, +m[1] * 60 + +m[2]); }
      else if ((m = /^上一步完成后\s*(\d+)\s*秒$/.exec(c))) t0 = Math.max(t0, base + +m[1]);
      else if ((m = /^大法师出生前\s*(\d+)\s*秒$/.exec(c))) { const h = heroBorn(); if (h != null) t0 = Math.max(t0, h - +m[1]); }
      else if ((m = /^#(\S+?)\s*(开工|完成)$/.exec(c))) { const x = tagTime(m[1], m[2]); if (x != null) t0 = Math.max(t0, x); }
      else if (c === '清野完成') { const x = clearEnd(); if (x != null) t0 = Math.max(t0, x); }
    }
    return t0;
  }
  /* times again from step `from` on, by the same rules as the budget, roughly (the real console reruns the budget model) */
  function recalc(L, from) {
    const q = squadOfLane(L); if (q) { recalcSquad(q); return; }
    recalcUnit(L, from);
    for (const s of L.steps.slice(Math.max(0, from - 1))) if (isJoin(s)) { const q2 = squadByName(s.body.slice(3)); if (q2) recalcSquad(q2); }
  }
  function recalcUnit(L, from) {
    const unit = L.kind !== 'building', speed = SPD[TL.unitType(TL.cidOfLane(L))] || 190;
    let pos = unit ? posBefore(L, from) : null;
    for (let k = Math.max(0, from); k < L.steps.length; k++) {
      const s = L.steps[k], prev = L.steps[k - 1];
      const base = prev ? (TL.ongoing(prev) ? (prev.start ?? 0) : (prev.done ?? prev.end ?? prev.start ?? 0)) : (s.start ?? 0);
      s.start = condStart(s, base); s.work = null; s.done = null; s.end = null; s.arrive = null;
      const tt = unit && timeTerm(s), to0 = unit && targetOf(s);
      if (tt && !tt.depart && to0) { const walk0 = Math.hypot(to0[0] - pos[0], to0[1] - pos[1]) / speed; s.start = Math.max(condStart(s, base, true), tt.t - walk0); }
      const sq = unit && isJoin(s) && squadByName(s.body.slice(3));
      if (sq) { const ps = squadPlaces(sq), f = ps[0]; s.arrive = s.start + (f ? Math.hypot(f.at[0] - pos[0], f.at[1] - pos[1]) / speed : 0); s.end = s.done = breakUp(sq) ?? TL.END; if (prev && TL.ongoing(prev)) prev.end = s.start; if (ps.length) pos = ps[ps.length - 1].at; s.raw = rawOf(s); continue; }
      if (!unit) { const n = s.body.replace(/^升级\s*/, '').replace(/\s*[×x]\s*\d+$/, ''), cnt = +((s.body.match(/[×x]\s*(\d+)/) || [])[1] || 1); s.work = s.start; s.done = s.start + (TRAIN[n] || TRAIN[n.replace(/\d+$/, '')] || 20) * cnt; s.end = s.done; s.raw = rawOf(s); continue; }
      const to = targetOf(s), walk = to ? Math.hypot(to[0] - pos[0], to[1] - pos[1]) / speed : 0;
      if (to) s.arrive = s.start + walk;
      if (/^建造/.test(s.body)) { s.work = s.start + walk; s.done = s.work + (TL.BUILD[s.body.split(' ')[1]] || 60); s.end = s.done; }
      else if (/^协助/.test(s.body)) { s.end = tagTime(s.tag, '完成') ?? s.start + walk + 30; s.done = s.end; }
      else if (/^敲钟/.test(s.body)) s.end = s.start + walk + 2;
      else if (/^清野/.test(s.body)) s.end = Math.max(s.start + walk, clearEnd() ?? s.start + walk + 30);
      else if (/^(移动|攻击移动|学)/.test(s.body)) s.end = s.start + walk;
      if (prev && TL.ongoing(prev)) prev.end = s.start;
      if (to) pos = to;
      s.raw = rawOf(s);
    }
  }
  function editLane(L, from, msg) { recalc(L, from); TL.rebuild(); renderCard(); if (msg) TL.toast(msg); }

  function drawLives(us, t) {
    const show = new Map();
    if (showAll) for (const L of TL.lanes) if (L.kind === 'peasant' || L.kind === 'hero') show.set(L, false);
    for (const u of us) if (TL.pick.has(u.cid) && u.L) show.set(u.L, true);
    const marks = new Map(), single = [...show.values()].filter(Boolean).length === 1;
    for (const [L, strong] of show) {
      const pts = lifePoints(L);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i]; if (!b.moved || (b.squad && !b.first)) continue;
        const s = b.s, e = TL.stepEnd(s), st = s.start == null ? 'never' : e != null && e <= t ? 'past' : s.start <= t ? 'now' : 'future';
        const x0 = sx(a.at[0]), y0 = sy(a.at[1]), x1 = sx(b.at[0]), y1 = sy(b.at[1]); if (Math.hypot(x1 - x0, y1 - y0) < 2) continue;
        ctx.setLineDash(st === 'future' ? [6, 4] : st === 'never' ? [2, 4] : []);
        ctx.strokeStyle = !strong ? 'rgba(160,190,150,.22)' : st === 'past' ? 'rgba(127,176,105,.35)' : st === 'now' ? '#7fe08a' : st === 'never' ? 'rgba(224,144,74,.7)' : 'rgba(170,225,150,.85)';
        ctx.lineWidth = strong ? (st === 'now' ? 2.4 : 1.6) : 1; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]);
        if (strong) { const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, ang = Math.atan2(y1 - y0, x1 - x0); ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.moveTo(mx + 6 * Math.cos(ang), my + 6 * Math.sin(ang)); ctx.lineTo(mx - 5 * Math.cos(ang - 0.6), my - 5 * Math.sin(ang - 0.6)); ctx.lineTo(mx - 5 * Math.cos(ang + 0.6), my - 5 * Math.sin(ang + 0.6)); ctx.fill(); }
      }
      if (!strong) continue;
      for (const p of pts.slice(1)) {
        if (!p.moved || (p.squad && !p.first)) continue;
        const key = L.id + ':' + Math.round(p.at[0] / 48) + ',' + Math.round(p.at[1] / 48), m = marks.get(key) || {x: sx(p.at[0]), y: sy(p.at[1]), L, ks: []};
        m.ks.push(p.k); marks.set(key, m);
      }
    }
    lifeNodes = []; const boxes = []; // captions that would overlap another one are left out (the card lists every step)
    drawSquads(t, boxes);
    const nodes = [...marks.values()].sort((a, b) => (lifeSel && a.L === lifeSel.L && a.ks.includes(lifeSel.k) ? -1 : 0) - (lifeSel && b.L === lifeSel.L && b.ks.includes(lifeSel.k) ? -1 : 0) || a.ks[0] - b.ks[0]);
    for (const m of nodes) {
      const sel = lifeSel && lifeSel.L === m.L && m.ks.includes(lifeSel.k), s0 = m.L.steps[m.ks[0]], e = TL.stepEnd(m.L.steps[m.ks[m.ks.length - 1]]);
      const done = e != null && e <= t, now = m.ks.some(k => { const s = m.L.steps[k], e2 = TL.stepEnd(s); return s.start != null && s.start <= t && (e2 == null || t < e2); });
      const r = sel ? 9 : 7.5;
      ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, 7); ctx.fillStyle = sel ? '#d6a03f' : now ? '#7fe08a' : done ? '#3b5236' : '#1e2b22'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = sel ? '#fff' : now ? '#0b1a10' : '#7fb069'; ctx.stroke();
      const nums = m.ks.map(k => k + 1).join('·');
      ctx.font = `600 ${nums.length > 3 ? 8 : 10}px "JetBrains Mono",monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = sel || now ? '#0b1a10' : '#c8f0b4'; ctx.fillText(nums, m.x, m.y + 0.5);
      if (single) {
        const lines = m.ks.slice(0, 3).map(k => { const s = m.L.steps[k]; return `${k + 1} ${s.body}${s.cond ? ' [' + s.cond + ']' : ''} · ${s.start == null ? '不会开始' : s.arrive != null && s.arrive - s.start >= 2 && !TL.ongoing(s) ? TL.fmt(s.start) + ' 出发 → ' + TL.fmt(s.work ?? s.arrive) : TL.fmt(s.start)}`; });
        if (m.ks.length > 3) lines.push(`…还有 ${m.ks.length - 3} 步`);
        ctx.font = '10.5px "Noto Sans SC","PingFang SC",sans-serif';
        const w = Math.max(...lines.map(ln => ctx.measureText(ln).width)), bx = [m.x + 10, m.y - 10 - (lines.length - 1) * 13, m.x + 14 + w, m.y + 4];
        if (sel || !boxes.some(q => bx[0] < q[2] && bx[2] > q[0] && bx[1] < q[3] && bx[3] > q[1])) {
          boxes.push(bx); lines.forEach((ln, i) => labelLeft(ln, m.x + 12, m.y - 4 - (lines.length - 1 - i) * 13, sel ? '#ffe2a8' : done ? '#9fb39a' : '#e3f5dc'));
        }
      }
      lifeNodes.push(m);
    }
  }
  // left labels for node captions read better: draw them left-aligned
  const labelLeft = (text, x, y, color) => { ctx.font = '10.5px "Noto Sans SC","PingFang SC",sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y); };
  const nodeAt = (px, py) => lifeNodes.find(m => Math.hypot(m.x - px, m.y - py) < 10);

  /* Shift+right-click: what is under the mouse becomes the last step of every picked unit's lifecycle */
  function appendAt(px, py, build) {
    const x = wx(px), y = wy(py), us = pickedUnits().filter(u => u.L); if (!us.length) { TL.toast('先选单位'); return; }
    const peas = us.every(u => u.type === 'hpea' || u.type === 'hmil'), nearNat = Math.hypot(x - D.natural[0], y - D.natural[1]) < 1500;
    let body = null, pos = '', tag = '', c = '127,224,138';
    const newPlace = base => { let nm; do { nm = base + placeN++; } while (nm in D.places); D.places[nm] = [Math.round(x), Math.round(y)]; return nm; };
    if (build) { body = '建造 ' + build.what; pos = newPlace(build.what); c = '121,176,238'; }
    else {
      const mine = M.mines.find(m => x > m.body[0] - 60 && x < m.body[2] + 60 && y > m.body[1] - 60 && y < m.body[3] + 60);
      const site = buildingsAt(TL.t).find(b => b.s && b.s.tag && (r => x > r[0] && x < r[2] && y > r[1] && y < r[3])(rectOf(b, 'body')));
      if (mine && peas) { body = '采金 ' + (Math.hypot(mine.x - D.natural[0], mine.y - D.natural[1]) < 300 ? '分矿' : '主矿'); c = '228,193,74'; }
      else if (site && peas) { body = '协助'; tag = site.s.tag; c = '121,176,238'; }
      else if (creepsAt(TL.t).some(cr => Math.hypot(cr.x - x, cr.y - y) < 300)) { body = '清野'; pos = '分矿'; c = '208,88,74'; }
      else if (peas && isTree(x, y)) { body = '伐木 ' + (nearNat ? '分矿' : '主矿'); c = '118,166,80'; }
      else { body = peas ? '移动' : '攻击移动'; pos = newPlace('点'); }
    }
    const q = lifeLane && squadOfLane(lifeLane);
    if (q) {
      if (!/^(集合|移动|攻击移动|待命|清野)/.test(body)) { body = '移动'; pos = newPlace('点'); tag = ''; } // a squad only moves, holds and clears
      const k = q.L.steps.findIndex(s => /^解散/.test(s.body)), at = k < 0 ? q.L.steps.length : k;
      q.L.steps.splice(at, 0, {body, pos, tag, cond: '', cls: TL.split(body).cls, raw: '', edited: true, start: null}); recalcSquad(q);
      flags.push({x, y, at: performance.now(), c}); lifeSel = {L: q.L, k: at}; TL.rebuild(); renderCard();
      TL.toast(`${q.name}：第 ${at + 1} 步「${body}」，全队一起做（插在「解散」前）。`); return;
    }
    for (const u of us) { const L = u.L; L.steps.push({body, pos, tag, cond: '', cls: TL.split(body).cls, raw: '', edited: true, start: null}); recalc(L, L.steps.length - 1); }
    flags.push({x, y, at: performance.now(), c});
    const one = us.length === 1 ? us[0].L : null;
    if (one) lifeSel = {L: one, k: one.steps.length - 1};
    TL.rebuild(); renderCard();
    TL.toast(`${us.map(u => u.L.label).join('、')}：最后加了一步「${body}${pos && pos !== '分矿' ? ' @' + pos : pos ? ' @分矿' : ''}${tag ? ' #' + tag : ''}」，做完上一步就做。点地图上的圆点或卡片右边的列表可以给它加条件（定时、延时、等大法师……）。`);
  }

  /* the card's lifecycle list and the editor of the step that is open */
  const KINDS = [['queue', '上一步做完就做'], ['time', '最早在某个时刻'], ['delay', '上一步做完后再等几秒'], ['hero', '大法师出生前几秒'], ['tag', '等一座建筑开工 / 完成'], ['clear', '清野完成后'], ['money', '钱够了']];
  function kindOf(cond) {
    const c = condTerms(cond)[0] || '';
    if (!c) return {k: 'queue'};
    let m;
    if ((m = /^(\d+:\d{2})(\s*出发)?$/.exec(c))) return {k: 'time', v: m[1], w: m[2] ? '出发' : '到达'};
    if ((m = /^上一步完成后\s*(\d+)\s*秒$/.exec(c))) return {k: 'delay', v: m[1]};
    if ((m = /^大法师出生前\s*(\d+)\s*秒$/.exec(c))) return {k: 'hero', v: m[1]};
    if ((m = /^#(\S+?)\s*(开工|完成)$/.exec(c))) return {k: 'tag', v: m[1], w: m[2]};
    if (c === '清野完成') return {k: 'clear'};
    if (/金≥|木≥/.test(c)) return {k: 'money', g: (c.match(/金≥(\d+)/) || [])[1] || '', w: (c.match(/木≥(\d+)/) || [])[1] || ''};
    return {k: 'other', v: cond};
  }
  const tagsAll = () => { const out = []; for (const M of TL.lanes) for (const s of M.steps) if (s.tag && /^(建造|升级)/.test(s.body)) out.push(s.tag); return [...new Set(out)]; };
  function lifeHTML(us) {
    const L = lifeLane || (us.length === 1 && us[0].L) || null; if (!L) return '';
    const t = TL.t, bld = L.kind === 'building';
    let ed = '';
    if (lifeSel && lifeSel.L === L && L.steps[lifeSel.k]) {
      const s = L.steps[lifeSel.k], kd = kindOf(s.cond), k = lifeSel.k;
      ed = `<li class="ledrow"><div class="led"><div class="led-h">第 ${k + 1} 步「${esc(s.body)}」什么时候开始</div>
        <select id="ledKind">${KINDS.map(([v, n]) => `<option value="${v}" ${kd.k === v ? 'selected' : ''}>${n}</option>`).join('')}${kd.k === 'other' ? `<option value="other" selected>${esc(s.cond)}</option>` : ''}</select>
        <span class="led-in" id="ledIn">${ledInputs(kd)}</span>
        <div class="led-b"><button type="button" class="btn on" data-led="apply">应用</button><button type="button" class="btn" data-led="up" ${k ? '' : 'disabled'}>上移</button><button type="button" class="btn" data-led="down" ${k < L.steps.length - 1 ? '' : 'disabled'}>下移</button><button type="button" class="btn" data-led="close">收起</button></div></div></li>`;
    }
    const rows = L.steps.map((s, k) => {
      const e = TL.stepEnd(s), st = s.start == null ? 'never' : e != null && e <= t ? 'past' : s.start <= t ? 'now' : '', on = lifeSel && lifeSel.L === L && lifeSel.k === k;
      return `<li class="${st} ${on ? 'sel' : ''}" data-lk="${k}" title="点开改它什么时候开始"><span class="n">${k + 1}</span><span class="b">${s.cond ? `<em>[${esc(s.cond)}]</em> ` : ''}${esc(s.body)}${s.pos ? ' @' + esc(s.pos) : ''}${s.tag ? ' #' + esc(s.tag) : ''}</span><small>${s.start == null ? '不会开始' : s.arrive != null && s.arrive - s.start >= 2 && !TL.ongoing(s) ? `${TL.fmt(s.start)} 出发 · ${TL.fmt(s.work ?? s.arrive)} ${/^建造/.test(s.body) ? '开工' : '到'}${e != null && e < 600 ? '–' + TL.fmt(e) : ''}` : TL.fmt(s.start) + (e != null && e < 600 && !TL.ongoing(s) ? '–' + TL.fmt(e) : '')}</small><button type="button" class="lx" data-ldel="${k}" title="删除这一步" aria-label="删除第 ${k + 1} 步">×</button></li>` + (on ? ed : '');
    }).join('');
    const sqd = squadOfLane(L);
    return `<div class="life">${sqd ? squadCardHTML(L) : ''}<h3>${sqd ? '队伍的生命周期' : bld ? '生产队列' : '生命周期'} · ${esc(L.label)} <small>${L.steps.length} 步</small></h3><ol class="lsteps">${rows}</ol>
      <p class="hint">${bld ? '点一项改它的开始条件、上下移动；× 删除。' : '点一步（或地图上的圆点）改条件，× 删除；拖地图上的圆点改地方。<b>Shift+右键</b>地图 = 接在最后。地图左上角 ↶ ↷ 撤销、重做（Ctrl+Z）。'}</p></div>`;
  }
  function ledInputs(kd) {
    if (kd.k === 'time') return `<input id="ledV" value="${esc(kd.v || TL.fmt(TL.t))}" size="5" aria-label="时刻"> <select id="ledW" aria-label="这个时刻是"><option value="到达" ${kd.w !== '出发' ? 'selected' : ''}>到达并开始做（提前出发）</option><option value="出发" ${kd.w === '出发' ? 'selected' : ''}>从这时出发</option></select>`;
    if (kd.k === 'delay') return `再等 <input id="ledV" value="${esc(kd.v || '5')}" size="3" aria-label="秒"> 秒`;
    if (kd.k === 'hero') return `出生前 <input id="ledV" value="${esc(kd.v || '10')}" size="3" aria-label="秒"> 秒`;
    if (kd.k === 'tag') return `<select id="ledV">${tagsAll().map(g => `<option ${g === kd.v ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select><select id="ledW"><option ${kd.w === '开工' ? 'selected' : ''}>开工</option><option ${kd.w !== '开工' ? 'selected' : ''}>完成</option></select>`;
    if (kd.k === 'money') return `金 ≥ <input id="ledV" value="${esc(kd.g || '')}" size="4" aria-label="金"> 木 ≥ <input id="ledW" value="${esc(kd.w || '')}" size="4" aria-label="木">`;
    return '';
  }
  function condFromEditor() {
    const k = $('ledKind').value, v = $('ledV') ? $('ledV').value.trim() : '', w = $('ledW') ? $('ledW').value.trim() : '';
    if (k === 'queue') return '';
    if (k === 'time') { const t = v.replace('：', ':'); return /^\d+:\d{2}$/.test(t) ? t + (w === '出发' ? ' 出发' : '') : null; }
    if (k === 'delay') return /^\d+$/.test(v) ? `上一步完成后 ${v} 秒` : null;
    if (k === 'hero') return /^\d+$/.test(v) ? `大法师出生前 ${v} 秒` : null;
    if (k === 'tag') return v ? `#${v} ${w}` : null;
    if (k === 'clear') return '清野完成';
    if (k === 'money') return [v && `金≥${v}`, w && `木≥${w}`].filter(Boolean).join(' ') || null;
    return null;
  }
  function onLife(e) {
    const L0 = lifeLane || (pickedUnits().length === 1 && pickedUnits()[0].L), x = e.target.closest('[data-ldel]');
    if (x && L0) { const k = +x.dataset.ldel, s = L0.steps[k]; L0.steps.splice(k, 1); if (lifeSel && lifeSel.L === L0) lifeSel = lifeSel.k === k ? null : {L: L0, k: lifeSel.k - (lifeSel.k > k ? 1 : 0)}; editLane(L0, k, `删掉了第 ${k + 1} 步「${s.body}」，后面的步骤往前接。按 ↶ 可以撤回。`); return true; }
    if (e.target.closest('.ledrow')) { if (e.target.closest('[data-led="close"]')) { lifeSel = null; renderCard(); return true; } }
    const li = e.target.closest('[data-lk]'), L = L0;
    if (li && L) { lifeSel = {L, k: +li.dataset.lk}; const s = L.steps[lifeSel.k]; if (s.start != null) TL.t = s.start; renderCard(); return true; }
    const b = e.target.closest('[data-led]'); if (!b || !lifeSel) return false;
    const {L: LL, k} = lifeSel, s = LL.steps[k];
    if (b.dataset.led === 'apply') {
      const c = condFromEditor(); if (c == null) { TL.toast('条件没填对：时刻写成 2:30，秒数写数字'); return true; }
      s.cond = c; s.edited = true; editLane(LL, k); TL.toast(`第 ${k + 1} 步「${s.body}」：${c ? '等到 [' + c + '] 才开始' : '上一步做完就做'}，预计 ${s.start == null ? '不会开始' : TL.fmt(s.start)}。`);
    } else if (b.dataset.led === 'up' || b.dataset.led === 'down') {
      const j = b.dataset.led === 'up' ? k - 1 : k + 1; [LL.steps[k], LL.steps[j]] = [LL.steps[j], LL.steps[k]]; lifeSel.k = j; editLane(LL, Math.min(k, j));
    } else if (b.dataset.led === 'del') { LL.steps.splice(k, 1); lifeSel = null; editLane(LL, k, `删掉了第 ${k + 1} 步「${s.body}」，后面的步骤往前接。`); }
    return true;
  }
  document.addEventListener('change', e => { if (e.target.id === 'ledKind') $('ledIn').innerHTML = ledInputs({k: e.target.value}); });
  const editing = () => !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#card .led'));


  /* ---------- squads: units that do the same steps together, from joining until 解散 ----------
     The squad is a lane of its own (its steps, the last one 解散). A member's life holds one step,
     「加入 <name>」: from when he joins (now, or right after he is born) to 解散; his own steps go on after it.
     On the map the squad's route is one band whose nodes move for everyone. */
  const SQ_COL = ['#e0904a', '#5fb4e0', '#c58bf0', '#e4c14a'];
  const squads = []; let sqN = 0, inSquadCalc = false;
  const squadOfLane = L => squads.find(q => q.L === L), squadByName = n => squads.find(q => q.name === n);
  const isJoin = s => /^加入 /.test(s.body), joinIdx = (M, q) => M.steps.findIndex(s => s.body === '加入 ' + q.name);
  const membersOf = q => q.members.map(m => ({...m, M: TL.laneOfCid(m.cid)})).filter(m => m.M);
  function squadPlaces(q) { const out = []; q.L.steps.forEach((s, k) => { const to = targetOf(s); if (to) out.push({at: to, s, k}); }); return out; }
  const breakUp = q => { const s = q.L.steps.find(x => /^解散/.test(x.body)); return s && s.start != null ? s.start : null; };
  function posBefore(L, from) { let at = birthOf(L); for (const p of lifePoints(L).slice(1)) { if (p.k >= from) break; at = p.at; } return at; }
  function newSquadLane(id, name) { return {id, label: '队伍·' + name, kind: 'squad', prio: 0, line: 900 + sqN, steps: []}; }
  function squadStep(body, extra) { return {...TL.split(body), body, raw: body, cond: '', pos: '', tag: '', start: null, ...extra}; }
  /* when the members are all there, the squad's steps one after another; then each member goes on from 解散 */
  function recalcSquad(q) {
    if (inSquadCalc) return; inSquadCalc = true;
    try {
      const ms = membersOf(q), first = squadPlaces(q)[0];
      let gather = null;
      for (const {M} of ms) { const j = joinIdx(M, q); if (j < 0) continue; const s = M.steps[j]; const p = posBefore(M, j); const walk = first ? Math.hypot(first.at[0] - p[0], first.at[1] - p[1]) / 190 : 0; s.arrive = (s.start ?? 0) + walk; gather = Math.max(gather ?? 0, s.arrive); }
      let pos = first ? first.at : D.hall, prev = null;
      q.L.steps.forEach((s, k) => {
        const base = k ? (TL.ongoing(prev) ? (prev.start ?? 0) : (prev.done ?? prev.end ?? prev.start ?? 0)) : (gather ?? s.start ?? 0);
        s.start = condStart(s, base); s.work = null; s.done = null; s.end = null;
        const to = targetOf(s), walk = to ? Math.hypot(to[0] - pos[0], to[1] - pos[1]) / 190 : 0;
        if (/^解散/.test(s.body)) s.end = s.start + 2;
        else if (/^清野/.test(s.body)) s.end = Math.max(s.start + walk, clearEnd() ?? s.start + walk + 30);
        else if (/^(移动|攻击移动)/.test(s.body)) s.end = s.start + walk;
        else if (/^建造/.test(s.body)) { s.work = s.start + walk; s.done = s.work + (TL.BUILD[s.body.split(' ')[1]] || 60); s.end = s.done; }
        if (prev && TL.ongoing(prev)) prev.end = s.start;
        if (to) pos = to; s.raw = rawOf(s); prev = s;
      });
      const end = breakUp(q);
      for (const {M} of ms) { const j = joinIdx(M, q); if (j < 0) continue; const s = M.steps[j]; s.end = s.done = end ?? TL.END; recalcUnit(M, j + 1); }
    } finally { inSquadCalc = false; }
  }
  function addMember(q, cid, join) {
    const M = TL.laneOfCid(cid); if (!M || q.members.some(m => m.cid === cid)) return false;
    q.members.push({cid, join});
    let idx = 0, cond = '', start = M.steps[0] ? M.steps[0].start : 0;
    if (join === 'now') { const T = Math.round(TL.t), cur = TL.current(M.steps.map(step => ({step})), T).cur; idx = cur ? M.steps.indexOf(cur.step) + 1 : M.steps.findIndex(s => s.start != null && s.start > T); if (idx < 0) idx = M.steps.length; cond = TL.fmt(T) + ' 出发'; start = T; } // joins from the red line
    M.steps.splice(idx, 0, squadStep('加入 ' + q.name, {cond, start, edited: true}));
    recalcUnit(M, idx); return true;
  }
  function removeMember(q, cid) {
    const M = TL.laneOfCid(cid); q.members = q.members.filter(m => m.cid !== cid);
    if (M) { const j = joinIdx(M, q); if (j >= 0) { M.steps.splice(j, 1); recalcUnit(M, j); } }
    recalcSquad(q);
  }
  function makeSquad(cids) {
    let name; do { sqN++; name = '队伍' + sqN; } while (squadByName(name));
    const id = 'L:队伍·' + name, q = {id, name, color: SQ_COL[squads.length % SQ_COL.length], members: [], L: newSquadLane(id, name)};
    q.L.steps.push(squadStep('解散')); TL.lanes.push(q.L); squads.push(q);
    cids.forEach(c => addMember(q, c, 'now'));
    recalcSquad(q); return q;
  }
  function selectSquad(q, quiet) { lifeLane = q.L; lifeSel = null; TL.pick.clear(); q.members.forEach(m => TL.pick.add(m.cid)); TL.syncOrder(); renderCard(); if (!quiet) TL.toast(`${q.name}：${q.members.length} 人。Shift+右键地图 = 给整个队伍加一步（插在「解散」前）；拖队伍的大圆点 = 全队换地方。`); }
  const futureUnits = q => TL.lanes.filter(L => L.kind === 'peasant' && !q.members.some(m => m.cid === TL.cidOfLane(L)) && L.steps[0] && L.steps[0].start != null && L.steps[0].start > TL.t)
    .map(L => ({cid: TL.cidOfLane(L), born: L.steps[0].start, label: L.label}));
  function readSquads() {
    squads.length = 0;
    TL.lanes.filter(L => L.kind === 'squad').forEach((L, i) => {
      const name = L.label.replace(/^队伍·/, '');
      const members = TL.lanes.filter(M => M.kind !== 'squad' && M.steps.some(s => s.body === '加入 ' + name))
        .map(M => ({cid: TL.cidOfLane(M), join: /^加入 /.test((M.steps[0] || {}).body || '') ? 'born' : 'now'})).filter(m => m.cid != null && !Number.isNaN(m.cid));
      squads.push({id: L.id, name, color: SQ_COL[i % SQ_COL.length], members, L});
    });
    sqN = Math.max(sqN, squads.length);
  }
  function drawSquads(t, boxes) {
    for (const q of squads) {
      const on = lifeLane === q.L || q.members.some(m => TL.pick.has(m.cid)) || showAll; if (!on) continue;
      const strong = lifeLane === q.L || q.members.some(m => TL.pick.has(m.cid)), pts = squadPlaces(q);
      ctx.lineCap = 'round';
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], x0 = sx(a.at[0]), y0 = sy(a.at[1]), x1 = sx(b.at[0]), y1 = sy(b.at[1]);
        ctx.globalAlpha = strong ? 0.35 : 0.15; ctx.strokeStyle = q.color; ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.lineCap = 'butt';
      const byPlace = new Map();
      for (const p of pts) { const key = Math.round(p.at[0] / 48) + ',' + Math.round(p.at[1] / 48), m = byPlace.get(key) || {x: sx(p.at[0]), y: sy(p.at[1]), L: q.L, ks: [], squad: q}; m.ks.push(p.k); byPlace.set(key, m); }
      for (const m of byPlace.values()) {
        const sel = lifeSel && lifeSel.L === q.L && m.ks.includes(lifeSel.k), r = sel ? 12 : 10.5;
        ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, 7); ctx.fillStyle = q.color; ctx.globalAlpha = strong ? 1 : 0.5; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 2; ctx.strokeStyle = sel ? '#fff' : '#1b1408'; ctx.stroke();
        ctx.font = '700 10px "JetBrains Mono",monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#1b1408'; ctx.fillText(m.ks.map(k => k + 1).join('·'), m.x, m.y + 0.5);
        if (strong) {
          const lines = [q.name + ' · ' + q.members.length + ' 人'].concat(m.ks.map(k => { const s = q.L.steps[k]; return `${k + 1} ${s.body}${s.cond ? ' [' + s.cond + ']' : ''} · ${s.start == null ? '不会开始' : TL.fmt(s.start)}`; }));
          ctx.font = '10.5px "Noto Sans SC","PingFang SC",sans-serif';
          const w = Math.max(...lines.map(ln => ctx.measureText(ln).width)), bx = [m.x + 14, m.y - 10 - (lines.length - 1) * 13, m.x + 18 + w, m.y + 4];
          if (sel || !boxes.some(b => bx[0] < b[2] && bx[2] > b[0] && bx[1] < b[3] && bx[3] > b[1])) { boxes.push(bx); lines.forEach((ln, i) => labelLeft(ln, m.x + 15, m.y - 4 - (lines.length - 1 - i) * 13, i === 0 ? q.color : sel ? '#ffe2a8' : '#f2e6cf')); }
        }
        lifeNodes.push(m);
      }
    }
  }
  /* the card: who is in the squad, who joins later, and the buttons on a plain selection */
  function squadCardHTML(L) {
    const q = squadOfLane(L); if (!q) return '';
    const fut = futureUnits(q);
    return `<div class="sq"><div class="sq-mem">${q.members.map(m => { const M = TL.laneOfCid(m.cid), j = M ? joinIdx(M, q) : -1, s = j >= 0 ? M.steps[j] : null;
        return `<span class="sqchip" style="--q:${q.color}">${esc(M ? M.label : '#' + m.cid)}<small>${m.join === 'born' ? '出生后加入' : s && s.start != null ? TL.fmt(s.start) + ' 加入' : '加入'}</small><button type="button" data-sq="rm:${m.cid}" aria-label="把 ${esc(M ? M.label : m.cid)} 移出队伍">×</button></span>`; }).join('')}</div>
      <div class="sq-add"><select id="sqFuture" aria-label="还没出生的单位"><option value="">未来的单位…</option>${fut.map(f => { const o = squads.find(x => x !== q && x.members.some(m => m.cid === f.cid)); return `<option value="${f.cid}">${esc(f.label)}（${TL.fmt(f.born)} 出生${o ? '，也在' + esc(o.name) : ''}）</option>`; }).join('')}</select><button type="button" class="btn" data-sq="addfuture">出生后加入</button></div>
      <p class="hint">现在的单位：在沙盘上选中他，命令卡里点「加入 ${esc(q.name)}」。</p></div>`;
  }
  function squadRowHTML(us) {
    if (!us.length || lifeLane) return '';
    const inSq = squads.filter(q => us.every(u => q.members.some(m => m.cid === u.cid)));
    return `<div class="sqrow"><span>队伍</span>${squads.map(q => `<button type="button" class="btn" data-sq="${inSq.includes(q) ? 'sel' : 'join'}:${q.id}" style="--q:${q.color}"><i class="dot"></i>${inSq.includes(q) ? '看 ' : '加入 '}${esc(q.name)}</button>`).join('')}<button type="button" class="btn on" data-sq="new">组成新队伍</button></div>`;
  }
  function onSquad(e) {
    const b = e.target.closest('[data-sq]'); if (!b) return false;
    const [what, arg] = b.dataset.sq.split(':'), q = squads.find(x => x.id === arg) || squadOfLane(lifeLane);
    const us = pickedUnits().filter(u => u.L && !/^H/.test(u.type) || u.L);
    if (what === 'new') { const nq = makeSquad(us.map(u => u.cid)); TL.rebuild(); selectSquad(nq, true); TL.toast(`组成了${nq.name}（${nq.members.length} 人），从 ${TL.fmt(TL.t)} 开始。现在 Shift+右键地图给它加步骤，最后一步是「解散」，解散后每个人接着做自己的事。`); return true; }
    if (what === 'join' && q) { const n = us.filter(u => addMember(q, u.cid, 'now')).length; recalcSquad(q); TL.rebuild(); selectSquad(q, true); TL.toast(`${n} 个单位在 ${TL.fmt(TL.t)} 加入${q.name}。`); return true; }
    if (what === 'sel' && q) { selectSquad(q); return true; }
    if (what === 'rm' && q) { removeMember(q, +arg); TL.rebuild(); selectSquad(q, true); TL.toast(`移出了队伍；他的「加入」那一步删掉了，后面接着做自己的事。`); return true; }
    if (what === 'addfuture' && q) { const c = +($('sqFuture') || {}).value; if (!c) { TL.toast('先在下拉框里选一个还没出生的单位'); return true; } addMember(q, c, 'born'); recalcSquad(q); TL.rebuild(); selectSquad(q, true); TL.toast(`农民${c} 出生后直接加入${q.name}：他的第一步就是「加入 ${q.name}」，赶到队伍那里。`); return true; }
    return true;
  }

  /* ---------- drawing ---------- */
  function label(text, x, y, color, size) {
    ctx.font = `${size || 11}px "Noto Sans SC","PingFang SC",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(text, x, y); ctx.fillStyle = color || '#e8e2cf'; ctx.fillText(text, x, y);
  }
  function rect(r, fill, stroke, dash, lw) {
    const x = sx(r[0]), y = sy(r[3]), w = (r[2] - r[0]) * cam.s, h = (r[3] - r[1]) * cam.s;
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
    if (stroke) { ctx.setLineDash(dash || []); ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.5; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); }
    return [x, y, w, h];
  }
  function draw() {
    requestAnimationFrame(draw);
    if (!CW) resize();
    const t = TL.t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#0c100e'; ctx.fillRect(0, 0, CW, CH);
    ctx.imageSmoothingEnabled = false;
    if (img.complete) ctx.drawImage(img, sx(M.x0), sy(M.y1), (M.x1 - M.x0) * cam.s, (M.y1 - M.y0) * cam.s);
    for (const m of M.mines) { const [x, y, w, h] = rect(m.body, '#8a7322', '#e4c14a'); const nat = Math.hypot(m.x - D.natural[0], m.y - D.natural[1]) < 300; if (w > 18) label(nat ? '分矿金矿' : '金矿', x + w / 2, y + h / 2, '#fff2b8'); }
    for (const c of creepsAt(t)) {
      const r = Math.max(3.5, 20 * cam.s), x = sx(c.x), y = sy(c.y);
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = '#c0453a'; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = '#2a0c08'; ctx.stroke();
      hpBar(x, y - r - 5, r * 2.2, c.hpLeft);
      if (r >= 7 && c.lv) label(String(c.lv), x, y, '#ffe1dc', Math.round(r));
    }
    const rf = realAt(t);
    if (rf && rf.enemies) for (const e of rf.enemies) { const r = Math.max(3, 16 * cam.s), x = sx(e.x), y = sy(e.y); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = '#b05ad6'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#1d0c26'; ctx.stroke(); }
    for (const c of CAMPS) { const alive = creepsAt(t).filter(u => u.camp === c.name && Math.hypot(u.x - c.units[0].at[0], u.y - c.units[0].at[1]) < 400); if (alive.length && cam.s > 0.09) label(c.main ? `${c.name} · ${alive.length} 只` : c.name, sx(c.units[0].at[0]), sy(c.units[0].at[1]) + Math.max(14, 50 * cam.s), '#ffb3a8', 10); }
    const blds = buildingsAt(t), late = [];
    for (const b of blds) {
      const sel = selectedBuild && selectedBuild.L === b.L && selectedBuild.k === b.k;
      if (b.state === 'plan' || b.state === 'ordered') {
        const [x, y, w, h] = rect(rectOf(b, 'body'), b.state === 'ordered' ? 'rgba(197,139,240,.18)' : 'rgba(197,139,240,.07)', sel ? '#fff' : '#c58bf0', [5, 4], sel ? 2.5 : 1.3);
        if (w > 26) label(`${b.name} · ${b.who}${b.state === 'ordered' ? ' 去建' : ' ' + TL.fmt(b.s.start)}`, x + w / 2, y + h / 2, '#dcc0f5', 10);
      } else {
        const [x, y, w, h] = rect(rectOf(b, 'body'), b.state === 'up' ? '#23466e' : 'rgba(74,138,214,.2)', sel ? '#fff' : '#4a8ad6', null, sel ? 2.5 : 1.5);
        if (b.state === 'building') { ctx.fillStyle = 'rgba(74,138,214,.45)'; ctx.fillRect(x, y + h * (1 - b.p), w, h * b.p); }
        late.push(() => {
          if (b.state === 'building') { const bw = Math.max(w, 26), bx = x + (w - bw) / 2; ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(bx - 1, y - 9, bw + 2, 6); ctx.fillStyle = '#79b0ee'; ctx.fillRect(bx, y - 8, bw * b.p, 4); }
          if (w > 24) label(b.name + (b.state === 'building' ? ' ' + Math.round(b.p * 100) + '%' : ''), x + w / 2, y + h / 2, '#dfe9f6', 10);
          else if (b.state === 'building' && w > 8) label(Math.round(b.p * 100) + '%', x + w / 2, y - 16, '#cfe0f5', 9);
        });
      }
    }
    if (cam.s > 0.07) for (const b of blds) if (b.state === 'up' && MAKES[b.type]) { // what it is making at the red line, and how many wait
      const P = prodOf(b, t); if (!P) continue;
      const [x, y, w, h] = (r => [sx(r[0]), sy(r[3]), (r[2] - r[0]) * cam.s, (r[3] - r[1]) * cam.s])(rectOf(b, 'body'));
      late.push(() => {
        const bw = Math.max(w, 46), bx = x + (w - bw) / 2, by = y + h + 3;
        if (P.cur) { ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(bx - 1, by, bw + 2, 6); ctx.fillStyle = '#e4c14a'; ctx.fillRect(bx, by + 1, bw * P.p, 4); }
        label((P.cur ? P.cur : '空闲') + (P.wait ? ` · 后面 ${P.wait} 项` : ''), x + w / 2, by + 14, P.cur ? '#f3dc8a' : '#b7b2a0', 10);
      });
    }
    const us = units(t), picked = TL.pick;
    drawLives(us, t);
    if (false) for (const u of us) if (picked.has(u.cid)) {
      const path = queueOf(u, t); if (!path.length) continue;
      let px = sx(u.x), py = sy(u.y);
      path.forEach((p, i) => {
        const qx = sx(p.at[0]), qy = sy(p.at[1]);
        ctx.setLineDash(i ? [2, 5] : [5, 4]); ctx.strokeStyle = i ? 'rgba(127,176,105,.5)' : 'rgba(127,224,138,.9)'; ctx.lineWidth = i ? 1 : 1.4;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(qx, qy); ctx.stroke(); ctx.setLineDash([]);
        const key = Math.round(p.at[0] / 64) + ',' + Math.round(p.at[1] / 64), m = marks.get(key) || {x: qx, y: qy, items: []};
        m.items.push({i, text: p.text, who: u.cid}); marks.set(key, m); px = qx; py = qy;
      });
    }
    for (const m of []) {
      const i = Math.min(...m.items.map(x => x.i));
      ctx.fillStyle = i ? '#4f7a45' : '#7fe08a'; ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x, m.y - 14); ctx.lineTo(m.x + 10, m.y - 11); ctx.lineTo(m.x, m.y - 8); ctx.fill();
      ctx.beginPath(); ctx.arc(m.x, m.y, 2.5, 0, 7); ctx.fill();
      const kinds = [...new Set(m.items.map(x => x.text))];
      label(`${i + 1}. ${kinds.join(' / ')}${m.items.length > 1 ? ' ×' + new Set(m.items.map(x => x.who)).size : ''}`, m.x + 6, m.y - 22, i ? '#b9d6ad' : '#d8f5cf', 10);
    }
    for (const u of us) {
      const hero = /^H/.test(u.type), r = Math.max(hero ? 5 : 3.2, (hero ? 26 : 16) * cam.s), x = sx(u.x), y = sy(u.y);
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
      ctx.fillStyle = u.type === 'hwat' ? '#5fb4e0' : hero ? '#b78be0' : u.type === 'hmil' ? '#e0904a' : u.type === 'hpea' ? '#79b0ee' : '#9fb3a0'; ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = '#0b1a2a'; ctx.stroke();
      if (picked.has(u.cid)) { ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 7); ctx.strokeStyle = '#7fe08a'; ctx.lineWidth = 2; ctx.stroke(); }
      if (r >= 6) label(u.type === 'hpea' || u.type === 'hmil' ? String(u.cid) : u.type === 'hwat' ? '水' : hero ? '英' : UL[u.type] || '兵', x, y, '#0b1a2a', Math.round(r));
      const gk = groupOf(u.cid); if (gk && r >= 4) { ctx.font = '600 9px "JetBrains Mono",monospace'; ctx.fillStyle = '#d6a03f'; ctx.textAlign = 'left'; ctx.fillText(String(gk), x + r + 1, y - r + 2); }
    }
    for (const f of late) f();
    drawMini(us);
    if (nodeDrag) { const x = sx(nodeDrag.x), y = sy(nodeDrag.y); ctx.setLineDash([3, 3]); ctx.strokeStyle = '#d6a03f'; ctx.beginPath(); ctx.moveTo(nodeDrag.nd.x, nodeDrag.nd.y); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.strokeStyle = '#d6a03f'; ctx.lineWidth = 2; ctx.stroke(); }
    for (const f of flags) { const k = (performance.now() - f.at) / 600; if (k > 1) continue; ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), 6 + k * 14, 0, 7); ctx.strokeStyle = `rgba(${f.c},${1 - k})`; ctx.lineWidth = 2; ctx.stroke(); }
    flags = flags.filter(f => performance.now() - f.at < 600);
    if (bDrag && !bDrag.no) {
      const what = bDrag.b.s.body.split(' ')[1], g = placeGhost(bDrag.x, bDrag.y, what, bDrag.b.s);
      rect(rectOf(bDrag.b, 'body'), 'rgba(0,0,0,.35)', 'rgba(197,139,240,.5)', [3, 3], 1);
      const [x, y, w] = rect(g.rect, g.ok ? 'rgba(127,176,105,.35)' : 'rgba(208,88,74,.35)', g.ok ? '#7fb069' : '#d0584a', null, 2);
      label(g.ok ? `${what} 放这里（松手）` : g.why, x + w / 2, y - 10, g.ok ? '#c8f0b4' : '#ffb3a8', 11);
    } else if (box && !bDrag) { ctx.setLineDash([4, 3]); ctx.strokeStyle = '#7fe08a'; ctx.lineWidth = 1; ctx.strokeRect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0)); ctx.setLineDash([]); }
    if (mode && mode.kind === 'build' && mouse) {
      const g = placeGhost(mouse.wx, mouse.wy, mode.what); const [x, y, w, h] = rect(g.rect, g.ok ? 'rgba(127,176,105,.35)' : 'rgba(208,88,74,.35)', g.ok ? '#7fb069' : '#d0584a', null, 2);
      label(g.ok ? `放${mode.what}（Shift 排队）` : g.why, x + w / 2, y - 10, g.ok ? '#c8f0b4' : '#ffb3a8', 11);
    } else if (mode && mouse) label(mode.kind === 'attack' ? '攻击移动：点地面' : '移动：点地面', mouse.px, mouse.py - 16, mode.kind === 'attack' ? '#ffb3a8' : '#c8f0b4', 11);
    $('mapT').textContent = TL.fmt(t) + (TL.playing ? ' ▶' : '');
    if (!scrubbing && document.activeElement !== scrub) scrub.value = Math.round(t); $('scrubT').textContent = TL.fmt(t); $('scrubPlay').textContent = TL.playing ? '❚❚' : '▶';
  }
  let selectedBuild = null;

  /* ---------- moving a building that has not begun: drag it on the map ----------
     编排: any building of the script (it is all a plan); 实战: one whose builder has not set off yet
     (the game refuses a step it has begun); 回放: none. The step gets a new place (位置 X = 坐标 x,y),
     the builder's walk, the build and everything after it are worked out again. */
  let bDrag = null; // {b, x, y, g} while dragging
  function movable(b) {
    if (!b || !b.s || !b.L || !/^建造/.test(b.s.body)) return false;
    const st = window.CONSOLE && CONSOLE.state;
    if (st === 'replay') return false;
    if (st === 'live') return b.state === 'plan' && b.s.start != null && b.s.start > TL.t;
    return true;
  }
  function buildingAt(px, py) { return buildingsAt(TL.t).find(o => (rr => wx(px) > rr[0] && wx(px) < rr[2] && wy(py) > rr[1] && wy(py) < rr[3])(rectOf(o, 'body'))); }
  function dropBuilding(d) {
    const s = d.b.s, what = s.body.split(' ')[1], g = placeGhost(d.x, d.y, what, s);
    if (!g.ok) { TL.toast('这里不能放：' + g.why); return; }
    if (Math.hypot(g.x - d.b.x, g.y - d.b.y) < 32) return;
    let nm; do { nm = what + placeN++; } while (nm in D.places);
    D.places[nm] = [g.x, g.y]; s.pos = nm; s.at = null; s.edited = true;
    const L = d.b.L, k = L.steps.indexOf(s);
    editLane(L, k < 0 ? 0 : k, `${what}（${L.label} 建）换到新位置：走路、开工、完成和后面的时间都重算了。按 ↶ 可以撤回。`);
  }

  /* ---------- placing a building ---------- */
  function isTree(x, y) {
    if (!texData) return false;
    const px = Math.floor((x - M.x0) / 32), py = Math.floor((M.y1 - y) / 32); if (px < 0 || py < 0 || px >= M.w || py >= M.h) return true;
    const i = (py * M.w + px) * 4, r = texData[i], g = texData[i + 1], b = texData[i + 2];
    return g < 70 && r < 40 && b < 35;
  }
  function placeGhost(x, y, what, skip) { // skip: the build step being moved (its own old footprint does not count)
    const type = BT[what], f = M.body[type].foot, ox = ((f[2] - f[0]) / 2) % 64, oy = ((f[3] - f[1]) / 2) % 64;
    const px = Math.round((x - ox) / 64) * 64 + ox, py = Math.round((y - oy) / 64) * 64 + oy, b = {type, x: px, y: py}, r = rectOf(b, 'foot'), body = rectOf(b, 'body');
    let why = '';
    for (const o of buildingsAt(TL.t)) { if (skip && o.s === skip) continue; const q = rectOf(o, 'foot'); if (r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]) { why = `和${o.name}重叠`; break; } }
    for (const m of M.mines) { const q = m.body; if (!why && r[0] < q[2] + 96 && r[2] > q[0] - 96 && r[1] < q[3] + 96 && r[3] > q[1] - 96) why = '离金矿太近'; }
    if (!why) for (let gx = body[0] + 16; gx < body[2]; gx += 32) for (let gy = body[1] + 16; gy < body[3]; gy += 32) if (isTree(gx, gy)) { why = '压到树或悬崖'; break; }
    return {x: px, y: py, rect: body, ok: !why, why};
  }

  /* ---------- selection and orders ---------- */
  function unitAt(px, py) {
    let best = null, bd = 14;
    for (const u of units(TL.t)) { if (u.summon) continue; const d = Math.hypot(sx(u.x) - px, sy(u.y) - py); if (d < bd) { bd = d; best = u; } }
    return best;
  }
  function changed() { TL.syncOrder(); renderCard(); }
  function setPick(list, add) { bsel = null; if (!add) TL.pick.clear(); for (const c of list) TL.pick.add(c); lifeLane = null; if (lifeSel && !(TL.pick.size === 1 && pickedUnits()[0] && pickedUnits()[0].L === lifeSel.L)) lifeSel = null; changed(); }
  const pickedUnits = () => units(TL.t).filter(u => TL.pick.has(u.cid) && !u.summon);
  function give(cmd, extra) {
    if (!TL.pick.size) { TL.toast('先选单位：点一下，或拖一个框'); return; }
    const us = pickedUnits();
    const peasantsOnly = ['gold-main', 'gold-nat', 'wood', 'build', 'assist', 'bell'];
    if (peasantsOnly.includes(cmd) && us.some(u => u.type !== 'hpea')) { const keep = us.filter(u => u.type === 'hpea').map(u => u.cid); if (!keep.length) { TL.toast('这个命令只有农民能做'); return; } TL.pick.clear(); keep.forEach(c => TL.pick.add(c)); }
    const plan = TL.issue({cmd, ...extra});
    if (!plan || !plan.length) TL.toast('这一刻这些单位接不了这个命令（可能还没出生或在金矿里）');
    renderCard();
  }
  function rightClick(px, py, queue) {
    const x = wx(px), y = wy(py), us = pickedUnits(); if (!us.length) return;
    const peas = us.every(u => u.type === 'hpea');
    const mine = M.mines.find(m => x > m.body[0] - 60 && x < m.body[2] + 60 && y > m.body[1] - 60 && y < m.body[3] + 60);
    if (mine && peas) { const nat = Math.hypot(mine.x - D.natural[0], mine.y - D.natural[1]) < 300; flags.push({x: mine.x, y: mine.y, at: performance.now(), c: '228,193,74'}); give(nat ? 'gold-nat' : 'gold-main', {queue}); return; }
    const site = buildingsAt(TL.t).find(b => b.s && b.state !== 'up' && (r => x > r[0] && x < r[2] && y > r[1] && y < r[3])(rectOf(b, 'body')));
    if (site && peas) { const i = TL.builds().findIndex(q => q.L === site.L && q.k === site.k); if (i >= 0) { flags.push({x: site.x, y: site.y, at: performance.now(), c: '121,176,238'}); give('assist', {assist: i, queue}); return; } }
    if (creepsAt(TL.t).some(c => Math.hypot(c.x - x, c.y - y) < 260) && creepsUp(TL.t)) { flags.push({x, y, at: performance.now(), c: '208,88,74'}); give('clear', {queue}); return; }
    if (peas && isTree(x, y)) { flags.push({x, y, at: performance.now(), c: '118,166,80'}); give('wood', {xy: [x, y], queue}); return; }
    flags.push({x, y, at: performance.now(), c: '127,224,138'}); give('move', {xy: [x, y], queue});
  }
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    cv.setPointerCapture(e.pointerId);
    const mm = miniRect();
    if (e.button === 0 && px >= mm.x && px <= mm.x + mm.w && py >= mm.y && py <= mm.y + mm.h) { // the minimap: the view jumps there and follows the drag
      const go = q => { const rr = cv.getBoundingClientRect(); cam.x = M.x0 + (q.clientX - rr.left - mm.x) / mm.w * (M.x1 - M.x0); cam.y = M.y1 - (q.clientY - rr.top - mm.y) / mm.h * (M.y1 - M.y0); clampCam(); };
      go(e); const up = () => { cv.removeEventListener('pointermove', go); cv.removeEventListener('pointerup', up); }; cv.addEventListener('pointermove', go); cv.addEventListener('pointerup', up); return;
    }
    if (e.button === 1 || (e.button === 0 && (e.altKey || panMode))) { // pan
      const c0 = {x: cam.x, y: cam.y}, x0 = e.clientX, y0 = e.clientY;
      const mv = q => { cam.x = c0.x - (q.clientX - x0) / cam.s; cam.y = c0.y + (q.clientY - y0) / cam.s; clampCam(); };
      const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); };
      cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up); return;
    }
    if (e.button === 2) { if (mode) { mode = null; renderCard(); return; } if (e.shiftKey) appendAt(px, py); else rightClick(px, py, false); return; }
    if (e.button !== 0) return;
    if (mode && mode.kind === 'build') {
      const g = placeGhost(wx(px), wy(py), mode.what);
      if (!g.ok) { TL.toast('这里不能放：' + g.why); return; }
      if (mode.auto) {
        const u = autoBuilder(g.x, g.y); if (!u) { TL.toast(`${TL.fmt(TL.t)} 没有在采集的农民可以派`); return; }
        TL.pick.clear(); TL.pick.add(u.cid);
        flags.push({x: g.x, y: g.y, at: performance.now(), c: '121,176,238'}); give('build', {xy: [g.x, g.y], what: mode.what, queue: false});
        if (!e.shiftKey) mode = null; renderCard(); return;
      }
      if (e.shiftKey) { appendAt(sx(g.x), sy(g.y), {what: mode.what}); return; } // stays in build mode: Shift keeps adding
      flags.push({x: g.x, y: g.y, at: performance.now(), c: '121,176,238'}); give('build', {xy: [g.x, g.y], what: mode.what, queue: false});
      if (!e.shiftKey) mode = null; renderCard(); return;
    }
    if (mode && mode.kind === 'rally') { setRally(px, py, e.shiftKey); mode = null; renderCard(); return; }
    if (mode) { flags.push({x: wx(px), y: wy(py), at: performance.now(), c: mode.kind === 'attack' ? '208,88,74' : '127,224,138'}); give(mode.kind === 'attack' ? 'attack' : 'move', {xy: [wx(px), wy(py)], queue: e.shiftKey}); if (!e.shiftKey) mode = null; renderCard(); return; }
    const nd = nodeAt(px, py);
    if (nd) {
      if (nd.squad) { selectSquad(nd.squad, true); } lifeSel = {L: nd.L, k: nd.ks[nd.ks.length - 1]}; renderCard();
      const mv = q => { const rr = cv.getBoundingClientRect(); nodeDrag = {nd, x: wx(q.clientX - rr.left), y: wy(q.clientY - rr.top)}; };
      const up = () => {
        cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up);
        const d = nodeDrag; nodeDrag = null; if (!d) return;
        const k = d.nd.ks[d.nd.ks.length - 1], s = d.nd.L.steps[k];
        if (isJoin(s)) { TL.toast(`他跟着${s.body.slice(3)}走：拖队伍的大圆点，全队一起换地方`); return; }
        if (/^解散/.test(s.body)) { TL.toast('「解散」就在队伍上一步的地方，不能单独拖'); return; }
        if (/^(采金|伐木|协助|敲钟)/.test(s.body)) { TL.toast(`「${s.body}」的地方由目标决定，不能拖；要换就删掉这一步再 Shift+右键 加一个`); return; }
        if (/^建造/.test(s.body)) { const g = placeGhost(d.x, d.y, s.body.split(' ')[1]); if (!g.ok) { TL.toast('这里不能放：' + g.why); return; } let nm; do { nm = s.body.split(' ')[1] + placeN++; } while (nm in D.places); D.places[nm] = [g.x, g.y]; s.pos = nm; s.at = null; }
        else { let nm; do { nm = '点' + placeN++; } while (nm in D.places); D.places[nm] = [Math.round(d.x), Math.round(d.y)]; s.pos = nm; s.at = null; }
        s.edited = true; editLane(d.nd.L, k, `第 ${k + 1} 步「${s.body}」换了地方，走路时间和后面的时间跟着重算。`);
      };
      cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up); return;
    }
    const press = !unitAt(px, py) && buildingAt(px, py), canMove = movable(press);
    box = {x0: px, y0: py, x1: px, y1: py};
    const mv = q => {
      box.x1 = q.clientX - r.left; box.y1 = q.clientY - r.top;
      if (press && Math.hypot(box.x1 - box.x0, box.y1 - box.y0) >= 6) {
        if (!canMove) { if (!bDrag) TL.toast(CONSOLE.state === 'replay' ? '回放不能改' : '这座已经开始了（农民出发或已开工），不能再挪'); bDrag = {b: press, x: press.x, y: press.y, no: true}; return; }
        bDrag = {b: press, x: press.x + (wx(box.x1) - wx(box.x0)), y: press.y + (wy(box.y1) - wy(box.y0))};
      }
    };
    const up = q => {
      cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up);
      const b = box; box = null;
      if (bDrag) { const d = bDrag; bDrag = null; if (!d.no) dropBuilding(d); return; }
      if (Math.hypot(b.x1 - b.x0, b.y1 - b.y0) < 6) { // a click
        const u = unitAt(px, py);
        if (u && (q.ctrlKey || q.metaKey)) { setPick(units(TL.t).filter(v => v.type === u.type && sx(v.x) >= 0 && sx(v.x) <= CW && sy(v.y) >= 0 && sy(v.y) <= CH).map(v => v.cid)); return; }
        const cr = !u && creepsAt(TL.t).find(c => Math.hypot(sx(c.x) - px, sy(c.y) - py) < 14);
        if (cr) { TL.toast(`${cr.n}（${cr.lv} 级，${cr.camp}）：生命 ${Math.round(cr.hp * cr.hpLeft)}/${cr.hp}。选中自己的单位后右键它 = 去清野。`); return; }
        if (u) { if (q.shiftKey) { TL.pick.has(u.cid) ? TL.pick.delete(u.cid) : TL.pick.add(u.cid); changed(); } else setPick([u.cid]); selectedBuild = null; return; }
        const bl = buildingsAt(TL.t).find(o => (rr => wx(px) > rr[0] && wx(px) < rr[2] && wy(py) > rr[1] && wy(py) < rr[3])(rectOf(o, 'body')));
        selectedBuild = bl || null; lifeSel = null;
        bsel = bl ? pickBuilding(bl) : null;
        lifeLane = bsel && !bsel.L.fresh ? bsel.L : null;
        if (bsel) { TL.pick.clear(); mode = null; menu = 'main'; TL.syncOrder(); renderCard(); return; }
        if (bl) TL.toast(bl.s ? `${bl.name}：${bl.who} ${bl.state === 'plan' ? '计划 ' + TL.fmt(bl.s.start) + ' 去建' : bl.state === 'ordered' ? '正在走过去 / 等钱' : bl.state === 'building' ? '建造中 ' + Math.round(bl.p * 100) + '%' : '已建好'}${bl.s.done != null ? '，预计 ' + TL.fmt(bl.s.done) + ' 完成' : ''}` : `${bl.name}${bl.state === 'building' ? ' 建造中 ' + Math.round(bl.p * 100) + '%' : ''}`);
        if (!q.shiftKey) setPick([]);
        return;
      }
      const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
      let inside = units(TL.t).filter(u => !u.summon && sx(u.x) >= x0 && sx(u.x) <= x1 && sy(u.y) >= y0 && sy(u.y) <= y1);
      if (inside.some(u => u.type !== 'hpea' && u.type !== 'hmil')) { /* like the game: army first when the box holds both */ const army = inside.filter(u => u.type !== 'hpea' && u.type !== 'hmil'); if (!q.altKey) inside = army; }
      setPick(inside.map(u => u.cid), q.shiftKey);
      if (inside.length) TL.toast(`选中 ${inside.length} 个：右键下令（金矿=采金，树=伐木，在建的建筑=协助，野怪=清野，地面=移动），Shift 排队`);
    };
    cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
  });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top; mouse = {px, py, wx: wx(px), wy: wy(py)};
    cv.style.cursor = bDrag ? (bDrag.no ? 'not-allowed' : 'grabbing') : !box && !mode && !panMode && movable(buildingAt(px, py)) && !unitAt(px, py) ? 'grab' : '';
  });
  cv.addEventListener('pointerleave', () => { mouse = null; });
  cv.addEventListener('wheel', e => {
    e.preventDefault(); const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, x = wx(px), y = wy(py);
    const pad = !e.ctrlKey && e.deltaMode === 0 && (Math.abs(e.deltaX) > 0.5 || Math.abs(e.deltaY) < 40); // a trackpad's two-finger scroll moves the view; a mouse wheel or a pinch zooms
    if (pad) { cam.x += e.deltaX / cam.s; cam.y -= e.deltaY / cam.s; clampCam(); return; }
    cam.s = Math.max(0.05, Math.min(1.2, cam.s * Math.min(1.15, Math.max(1 / 1.15, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))))));
    cam.x = x - (px - CW / 2) / cam.s; cam.y = y + (py - CH / 2) / cam.s; clampCam();
  }, {passive: false});
  let panMode = false;
  function clampCam() { cam.x = Math.max(M.x0, Math.min(M.x1, cam.x)); cam.y = Math.max(M.y0, Math.min(M.y1, cam.y)); }
  function zoomBy(k) { cam.s = Math.max(0.05, Math.min(1.2, cam.s * k)); clampCam(); }
  $('zoomIn').onclick = () => zoomBy(1.4); $('zoomOut').onclick = () => zoomBy(1 / 1.4);
  $('panBtn').onclick = () => { panMode = !panMode; $('panBtn').classList.toggle('on', panMode); cv.style.cursor = panMode ? 'grab' : ''; TL.toast(panMode ? '拖动模式：左键拖地图移动镜头（选单位、下令先关掉它）。平时也可以：按住 Alt 或中键拖、触控板两指滑、点右下角小地图。' : '拖动模式关了：左键回到选单位、框选'); };
  /* the minimap: the whole map, what stands on it, and the part the view shows */
  function miniRect() { const w = Math.min(140, CW * 0.22), h = w * (M.y1 - M.y0) / (M.x1 - M.x0); return {x: CW - w - 10, y: CH - h - 54, w, h}; }
  function drawMini(us) {
    const mm = miniRect(), X = x => mm.x + (x - M.x0) / (M.x1 - M.x0) * mm.w, Y = y => mm.y + (M.y1 - y) / (M.y1 - M.y0) * mm.h;
    ctx.fillStyle = 'rgba(6,9,8,.9)'; ctx.fillRect(mm.x - 3, mm.y - 3, mm.w + 6, mm.h + 6);
    if (img.complete) { ctx.globalAlpha = 0.85; ctx.drawImage(img, mm.x, mm.y, mm.w, mm.h); ctx.globalAlpha = 1; }
    ctx.fillStyle = '#e4c14a'; for (const m of M.mines) ctx.fillRect(X(m.x) - 1.5, Y(m.y) - 1.5, 3, 3);
    ctx.fillStyle = '#4a8ad6'; for (const b of buildingsAt(TL.t)) if (b.state === 'up' || b.state === 'building') ctx.fillRect(X(b.x) - 2, Y(b.y) - 2, 4, 4);
    ctx.fillStyle = '#c0453a'; for (const c of creepsAt(TL.t)) ctx.fillRect(X(c.x) - 1, Y(c.y) - 1, 2, 2);
    ctx.fillStyle = '#a9d0f5'; for (const u of us) ctx.fillRect(X(u.x) - 1, Y(u.y) - 1, 2, 2);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(X(wx(0)), Y(wy(0)), (wx(CW) - wx(0)) / (M.x1 - M.x0) * mm.w, (wy(0) - wy(CH)) / (M.y1 - M.y0) * mm.h);
    ctx.strokeStyle = 'rgba(214,160,63,.8)'; ctx.strokeRect(mm.x - 3, mm.y - 3, mm.w + 6, mm.h + 6);
  }
  /* the time bar under the map: drag through the game; ticks where buildings begin and heroes are born */
  const scrub = $('scrub'); let scrubbing = false;
  scrub.addEventListener('input', () => { scrubbing = true; TL.stop(); TL.t = +scrub.value; });
  scrub.addEventListener('change', () => { scrubbing = false; });
  $('scrubPlay').onclick = () => $('play').click();
  $('scrubMarks').onclick = e => { const i = e.target.closest('[data-t]'); if (i) { TL.stop(); TL.t = +i.dataset.t; } };
  function renderMarks() {
    const ms = [];
    for (const L of TL.lanes) for (const s of L.steps) {
      if (s.start == null) continue;
      if (/^建造/.test(s.body)) ms.push({t: s.work ?? s.start, c: '#4a8ad6', n: `${L.label} 开始建 ${s.body.split(' ')[1]}`});
      else if (/^升级/.test(s.body)) ms.push({t: s.work ?? s.start, c: '#9fd3c7', n: `${L.label} 升级 ${s.body.split(' ')[1] || ''}`});
      else if (/^(大法师|山丘之王)$/.test(s.body) && s.done != null) ms.push({t: s.done, c: '#c9a3e8', n: s.body + ' 出生'});
      else if (/^清野/.test(s.body) && L.kind !== 'peasant' && s.done != null) ms.push({t: s.done, c: '#d0584a', n: '清野完成'});
    }
    $('scrubMarks').innerHTML = ms.filter(m => m.t <= 600).map(m => `<i style="left:${(m.t / 600 * 100).toFixed(2)}%;background:${m.c}" title="${TL.fmt(m.t)} ${esc(m.n)}" data-t="${Math.round(m.t)}"></i>`).join('');
  }
  window.addEventListener('script-edited', () => setTimeout(renderMarks, 0));
  setTimeout(renderMarks, 0);
  addEventListener('resize', resize);
  document.addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || !mapHot) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { mode = null; menu = 'main'; renderCard(); return; }
    if (/^[1-4]$/.test(k) && (e.ctrlKey || e.metaKey)) { e.preventDefault(); keepGroup(+k); return; }
    const btn = $('card').querySelector(`[data-key="${k}"]`); if (btn) { e.preventDefault(); btn.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: e.shiftKey})); return; }
    if (/^[1-4]$/.test(k) && !e.altKey) { e.preventDefault(); pickGroup(+k); }
  });
  let lastGroup = {k: 0, at: 0};
  function keepGroup(k) {
    const cids = pickedUnits().map(u => u.cid); if (!cids.length) { TL.toast('先选单位，再按 Ctrl+' + k + ' 编队'); return; }
    TL.setGroup(k, cids); renderCard(); TL.toast(`编队 ${k}：${cids.map(c => TL.uname({cid: c, type: TL.unitType(c), lane: TL.laneOfCid(c)})).join('、')}。按 ${k} 选中他们，连按两下镜头跟过去；筛选栏里也有这个编队。`);
  }
  function pickGroup(k) {
    const G = TL.selectGroup(k); if (!G) { TL.toast(`编队 ${k} 还是空的：选中单位后按 Ctrl+${k}`); return; }
    if (lastGroup.k === k && performance.now() - lastGroup.at < 450) window.MAP.focusPicked();
    lastGroup = {k, at: performance.now()}; selectedBuild = null; bsel = null; renderCard();
  }
  let mapHot = false;
  cv.addEventListener('pointerenter', () => { mapHot = true; }); $('card').addEventListener('pointerenter', () => { mapHot = true; });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#map, #card, .mapbox')) mapHot = !!e.target.closest('.board, .lower'); }); // number keys still pick groups below the map

  /* ---------- a building's card: what it makes, its upgrade, its rally point; its production line ----------
     A building with no line yet gets one with the first thing queued (「兵营：…」, or 「#兵营2：…」 with a
     tag on its build step when it is not the first of its kind). Click = from the red line, after what is
     under way; Shift = at the end of the queue. The same unit again makes it ×2, ×3. */
  const MAKES = {htow: {train: ['农民'], up: '主城'}, hkee: {train: ['农民'], up: '城堡'}, hcas: {train: ['农民']},
    hbar: {train: ['步兵']}, halt: {train: ['大法师', '山丘之王']}, hars: {train: ['破法者', '牧师', '女巫']}, hwtw: {up: '奥术塔'}};
  const MKEY = {农民: 'p', 步兵: 'f', 大法师: 'r', 山丘之王: 'k', 破法者: 'b', 牧师: 'e', 女巫: 's'};
  const LANE_NAME = {hbar: '兵营', halt: '国王祭坛', hars: '神秘圣地', hwtw: '侦察塔'};
  const HALL_T = ['htow', 'hkee', 'hcas'];
  let bsel = null; // the building picked: {b, L (its production line; L.fresh = not in the script yet), tag (to put on its build step)}
  function pickBuilding(b) {
    const lane = label => TL.lanes.find(L => L.kind === 'building' && L.label === label);
    const fresh = (label, tag) => ({b, tag, L: {id: 'L:' + label, label, kind: 'building', prio: TL.lanes.length + 1, line: 9000 + TL.lanes.length, steps: [], fresh: true}});
    if (HALL_T.includes(b.type) && Math.hypot(b.x - D.hall[0], b.y - D.hall[1]) < 200) return {b, L: lane('城镇大厅') || fresh('城镇大厅').L};
    if (b.s && b.s.tag) return {b, L: lane('#' + b.s.tag) || fresh('#' + b.s.tag).L};
    const kind = HALL_T.includes(b.type) ? null : LANE_NAME[b.type];
    if (!MAKES[b.type]) return {b, L: {id: 'L:none', label: b.name, kind: 'building', steps: [], fresh: true}, none: true};
    if (kind) { // the first of its kind in the script is the line named after it; the others get a tag
      const same = buildingsAt(TL.t).filter(o => o.type === b.type && o.s).sort((p, q) => (p.s.start ?? 1e9) - (q.s.start ?? 1e9));
      if (!b.s || same[0].s === b.s) return lane(kind) ? {b, L: lane(kind)} : b.s ? fresh(kind) : {b, L: {id: 'L:none', label: b.name, kind: 'building', steps: []}, none: true, hand: true};
    }
    if (!b.s) return {b, L: {id: 'L:none', label: b.name, kind: 'building', steps: []}, none: true, hand: true};
    let n = 2, tag; do { tag = b.name.replace(/^神秘/, '') + n++; } while (TL.lanes.some(L => L.label === '#' + tag) || TL.lanes.some(L => L.steps.some(x => x.tag === tag)));
    return fresh('#' + tag, tag);
  }
  function prodOf(b, t) { // its production line at time t: what is being made (and how far), how many after it
    const B = pickBuilding(b); if (B.none || B.L.fresh) return null;
    let cur = null, p = 0, wait = 0;
    for (const x of B.L.steps) {
      if (/^集结点/.test(x.body)) continue;
      const e = x.done ?? x.end;
      if (x.start != null && x.start <= t && e != null && t < e) { cur = x.body; p = Math.max(0, Math.min(1, (t - (x.work ?? x.start)) / Math.max(1, e - (x.work ?? x.start)))); }
      else if (x.start == null || x.start > t) wait++;
    }
    return cur || wait ? {cur, p, wait} : null;
  }
  function nextPeasant() {
    let n = 0;
    for (const L of TL.lanes) { if (L.kind === 'peasant') n = Math.max(n, +L.label.slice(2) || 0); for (const x of L.steps) { const m = /^农民(\d+)$/.exec(x.body); if (m) n = Math.max(n, +m[1]); } }
    return n + 1;
  }
  function adoptLane() { // the first thing queued puts a new line into the script
    const B = bsel, L = B.L; if (!L.fresh) return;
    delete L.fresh;
    if (B.tag && B.b.s) { B.b.s.tag = B.tag; B.b.s.raw = rawOf(B.b.s); }
    TL.lanes.push(L); lifeLane = L;
  }
  function queueOn(body, queue, extra) {
    if (!bsel || bsel.none) return;
    const L = bsel.L, t = Math.round(TL.t), cond = queue || t <= 0 ? '' : TL.fmt(t), what = body.replace(/\s*×\s*\d+$/, '');
    if (/^升级 /.test(body) && L.steps.some(x => x.body === body)) { TL.toast(`${L.label} 已经排了「${body}」`); return; }
    adoptLane();
    let k = L.steps.length;
    if (!queue) { k = 0; L.steps.forEach((x, i) => { if (x.start != null && x.start <= t) k = i + 1; }); }
    // the same unit queued the same way a moment ago (just before the end, or right after what is under way): ×2, ×3
    const j = queue ? k - 1 : k, prev = L.steps[j], pm = prev && /^(.+?)(?:\s*×\s*(\d+))?$/.exec(prev.body);
    if (pm && pm[1] === what && !/^(农民|升级|集结点|大法师|山丘之王)/.test(what) && (prev.cond || '') === cond && !extra && (prev.start == null || prev.start > TL.t - 0.5)) {
      prev.body = `${what} ×${(+pm[2] || 1) + 1}`; prev.edited = true;
      editLane(L, j, `${L.label}：第 ${j + 1} 步改成「${prev.body}」${prev.start != null ? '，预计 ' + TL.fmt(prev.start) + ' 开始' : ''}`); return;
    }
    const st = squadStep(body, {cond, ...(extra || {})}); st.raw = rawOf(st); st.edited = true;
    L.steps.splice(k, 0, st);
    editLane(L, k, null);
    const s2 = L.steps[k];
    TL.toast(`${L.label}：${queue ? '排到最后' : '从 ' + TL.fmt(t) + ' 起'}「${st.body}${st.pos ? ' @' + st.pos : ''}」${s2 && s2.start != null ? '，预计 ' + TL.fmt(s2.start) + ' 开始' : '。预算里到 ' + TL.fmt(TL.END) + ' 还开始不了：钱不够、人口满了（看「卡人口」），或建筑还没好'}`);
  }
  function trainPeasant(queue) {
    const n = nextPeasant(), atNat = Math.hypot(bsel.b.x - D.natural[0], bsel.b.y - D.natural[1]) < 1500;
    const P = {id: 'L:农民' + n, label: '农民' + n, kind: 'peasant', prio: TL.lanes.length + 1, line: 8000 + n, steps: [squadStep(atNat ? '采金 分矿' : '采金 主矿')]};
    TL.lanes.push(P);
    queueOn('农民' + n, queue);
    TL.toast(`训练农民${n}：出生后去${atNat ? '分矿' : '主矿'}采金。选中他（或在时间轴上点「农民${n}」）可以改他之后做什么。`);
  }
  function setRally(px, py, queue) {
    const x = wx(px), y = wy(py), hero = units(TL.t).find(u => /^H/.test(u.type) && Math.hypot(sx(u.x) - px, sy(u.y) - py) < 16);
    if (hero) { queueOn('集结点 ' + (hero.type === 'Hamg' ? '大法师' : '山丘之王'), queue); return; }
    let nm; do { nm = '点' + placeN++; } while (nm in D.places);
    D.places[nm] = [Math.round(x), Math.round(y)]; flags.push({x, y, at: performance.now(), c: '228,193,74'});
    queueOn('集结点', queue, {pos: nm});
  }
  function buildingCardHTML() {
    const B = bsel, b = B.b, m = MAKES[b.type] || {}, t = TL.t;
    const state = b.state === 'plan' ? `计划 ${b.s && b.s.start != null ? TL.fmt(b.s.start) + ' 开工' : '（不会开工）'}` : b.state === 'ordered' ? '农民正在走过去 / 等钱' : b.state === 'building' ? `建造中 ${Math.round(b.p * 100)}%` : '已建好';
    const btns = B.none ? [] : [...(m.train || []).map(n => [`t-${n}`, `训练 ${n}`, 'train', MKEY[n] || '']), ...(m.up ? [[`u-${m.up}`, `升级 ${m.up}`, 'build', 'u']] : []), ...((m.train || []).length ? [['rally', '集结点', 'wait', 'y']] : [])];
    const why = B.hand ? '这座是游戏里手动造的，脚本里没有它，没法给它排生产（直接在游戏里操作）。' : B.none ? '这种建筑不生产单位。' : '';
    return `<h2>选中 · ${TL.fmt(t)}</h2>
      <div class="selsum"><b>${esc(b.name)}</b>${b.who ? ` <span class="hint">${esc(b.who)} 建</span>` : ''}<div class="acts">${esc(state)}${B.L.fresh && !B.none ? ' · 还没有生产队列，点下面的按钮就加一行' : ''}</div></div>
      <div class="cmdcard">${btns.map(([k, n, c, key]) => `<button type="button" class="c-${c} ${mode && mode.key === k ? 'on' : ''}" data-cmd="${k}" data-key="${key}">${key ? `<kbd>${key.toUpperCase()}</kbd>` : ''}${esc(n)}</button>`).join('')}</div>
      ${why ? `<p class="hint">${why}</p>` : ''}
      ${B.L.fresh ? '' : lifeHTML([])}
      ${B.none ? '' : `<p class="hint">点按钮 = 从红线这一刻（${TL.fmt(t)}）起，排在正在做的后面；<b>Shift+点</b> = 排到队列最后。同一种兵连点会合成 ×2、×3。集结点：点按钮后在地图上点一下（点英雄 = 集结到英雄）。</p>`}`;
  }

  /* nothing picked: place a building and let the commander send a peasant (the nearest one gathering at
     the red line, a woodcutter first, none another step names); he goes back to his work after */
  function emptyCardHTML() {
    const t = TL.t, btns = menu === 'build' ? BUILD_LIST.map((b, i) => [`b-${b}`, b, 'build', '1234567890'[i]]).concat([['back', '返回', 'wait', 'escape']]) : [['buildmenu', '放建筑…', 'build', 'b']];
    return `<h2>选中 · ${TL.fmt(t)}</h2>
      <div class="selsum"><span class="hint">在地图上点选或拖框选单位；点建筑看它的生产队列；时间轴上点轨道名也一样</span></div>
      <div class="cmdcard">${btns.map(([k, n, c, key]) => `<button type="button" class="c-${c} ${mode && mode.key === k ? 'on' : ''}" data-cmd="${k}" data-key="${key}"><kbd>${key === 'escape' ? 'Esc' : key.toUpperCase()}</kbd>${esc(n)}</button>`).join('')}</div>
      <p class="hint">「放建筑」：选类型，在地图上点一下，指挥官从 ${TL.fmt(t)} 时在采集的农民里挑一个去建（后面没有别的任务的优先，先挑伐木的，再挑离得近的），建完回去干原来的活。没开工的建筑可以直接拖动换位置。</p>
      <div class="gslots" role="group" aria-label="编队">${[1, 2, 3, 4].map(n => { const G = TL.groups().find(g => g.key === n); const c = G ? G.cids.length : 0;
        return `<button type="button" class="gslot" data-gsel="${n}" title="${G ? '点 = 选中' + esc(G.name) : '空：选中单位后 Ctrl+' + n}"><kbd>${n}</kbd>${G ? esc(G.name) + ' <b>' + c + '</b>' : '<i>空</i>'}</button>`; }).join('')}</div>`;
  }
  function autoBuilder(x, y) { // gathering at the red line; one with a job still ahead of him (build, assist, bell, a squad) last
    const t = TL.t;
    const cands = units(t).filter(u => u.type === 'hpea' && u.L).map(u => {
      const cur = TL.current(u.L.steps.map(step => ({step})), t).cur, a = cur ? cur.step.body : '';
      const busy = u.L.steps.some(st => (st.start == null || st.start > t) && /^(建造|协助|敲钟|加入|清野|集合)/.test(st.body));
      return {u, busy, wood: /^伐木/.test(a), gather: /^(采金|伐木)/.test(a), d: Math.hypot(u.x - x, u.y - y)};
    }).filter(c => c.gather);
    cands.sort((p, q) => (p.busy - q.busy) || (q.wood - p.wood) || p.d - q.d);
    return cands[0] ? cands[0].u : null;
  }

  /* ---------- the command card ---------- */
  function renderCard() {
    if (bsel && !TL.pick.size) { $('card').innerHTML = buildingCardHTML(); return; }
    if (!TL.pick.size && !lifeLane) { $('card').innerHTML = emptyCardHTML(); return; }
    const us = pickedUnits(), peas = us.length && us.every(u => u.type === 'hpea'), t = TL.t;
    const groups = {}; for (const u of us) { const n = u.type === 'hpea' ? '农民' : u.type === 'hmil' ? '民兵' : /^H/.test(u.type) ? '英雄' : '步兵'; groups[n] = (groups[n] || 0) + 1; }
    const acts = {}; for (const u of us) if (u.L) { const a = TL.current(u.L.steps.map(step => ({step})), t).cur; const n = a ? a.step.body.split(' ').slice(0, 2).join(' ') : '空闲'; acts[n] = (acts[n] || 0) + 1; }
    let buttons;
    if (menu === 'build') buttons = BUILD_LIST.map((b, i) => [`b-${b}`, b, 'build', '1234567890'[i]]).concat([['back', '返回', 'wait', 'escape']]);
    else {
      buttons = [['move', '移动', 'wait', 'm'], ['attack', '攻击移动', 'fight', 'a'], ['hold', '待命', 'wait', 'h']];
      if (peas) buttons.push(['gold-main', '采金 主矿', 'gold', 'g'], ['gold-nat', '采金 分矿', 'gold', 'n'], ['wood', '伐木', 'wood', 'l'], ['bell', '敲钟变民兵', 'bell', 'c'], ['buildmenu', '建造…', 'build', 'b']);
      else if (us.length) buttons.push(['clear', '去分矿清野', 'fight', 'q']);
    }
    $('card').innerHTML = `<h2>选中 · ${TL.fmt(t)}</h2>
      <div class="selsum">${us.length ? Object.entries(groups).map(([n, c]) => `<b>${n} ×${c}</b>`).join(' ') + `<div class="acts">${Object.entries(acts).map(([n, c]) => `${esc(n)} ${c}`).join(' · ')}</div>` : '<span class="hint">在地图上点选或拖框；时间轴上点轨道名也一样</span>'}</div>
      <div class="cmdcard">${us.length ? buttons.map(([k, n, c, key]) => `<button type="button" class="c-${c} ${mode && mode.key === k ? 'on' : ''}" data-cmd="${k}" data-key="${key}"><kbd>${key === 'escape' ? 'Esc' : key.toUpperCase()}</kbd>${esc(n)}</button>`).join('') : ''}</div>
      ${squadRowHTML(us)}
      ${lifeHTML(us)}
      <div class="gslots" role="group" aria-label="编队">${[1, 2, 3, 4].map(n => { const G = TL.groups().find(g => g.key === n); const c = G ? G.cids.length : 0;
        return `<button type="button" class="gslot ${G && G.cids.length && G.cids.every(x => TL.pick.has(x)) ? 'on' : ''}" data-gsel="${n}" title="${G ? '点 = 选中' + esc(G.name) + '；Ctrl+点 = 把选中的单位编进来' : '空：选中单位后 Ctrl+' + n + '，或 Ctrl+点这里'}"><kbd>${n}</kbd>${G ? esc(G.name) + ' <b>' + c + '</b>' : '<i>空</i>'}</button>`; }).join('')}</div>
      <p class="hint">右键：金矿=采金，树=伐木，在建的建筑=协助，野怪=清野，地面=移动；从红线这一刻开始，打断手上的事。<b>Shift+右键</b> = 接在他生命周期的最后（地图上编号的圆点就是他的每一步）。<b>Ctrl+1–4</b> 编队，按数字选中。命令从红线这一刻开始，写进脚本是「[${TL.fmt(t)}] …」，之后可以在时间轴上点开改成条件。中键或 Alt+拖动平移，滚轮缩放。</p>`;
  }
  $('card').addEventListener('click', e => {
    const gs = e.target.closest('[data-gsel]'); if (gs) { const n = +gs.dataset.gsel; if (e.ctrlKey || e.metaKey || e.shiftKey) keepGroup(n); else pickGroup(n); return; }
    if (onSquad(e) || onLife(e)) return;
    const b = e.target.closest('[data-cmd]'); if (!b) return;
    const k = b.dataset.cmd;
    if (k === 'buildmenu') { menu = 'build'; renderCard(); return; }
    if (k === 'back') { menu = 'main'; mode = null; renderCard(); return; }
    if (k.startsWith('b-')) { const auto = !TL.pick.size; mode = {kind: 'build', what: k.slice(2), key: k, auto}; menu = 'main'; renderCard(); TL.toast(`在地图上点一下放${k.slice(2)}${auto ? '，指挥官挑一个农民去建' : ''}；${auto ? '' : 'Shift 连着放；'}右键或 Esc 取消`); return; }
    if (k === 'move' || k === 'attack') { mode = {kind: k, key: k}; renderCard(); return; }
    if (k === 'hold') { const u = pickedUnits()[0]; give('hold', {xy: u ? [u.x, u.y] : null}); return; }
    if (bsel && !TL.pick.size) {
      if (k === 't-农民') { trainPeasant(e.shiftKey); return; }
      if (k.startsWith('t-')) { queueOn(k.slice(2), e.shiftKey); return; }
      if (k.startsWith('u-')) { queueOn('升级 ' + k.slice(2), e.shiftKey); return; }
      if (k === 'rally') { mode = {kind: 'rally', key: 'rally'}; renderCard(); TL.toast('在地图上点集结点：点地面 = 那个地方，点英雄 = 跟着英雄；右键或 Esc 取消'); return; }
      return;
    }
    give(k, {});
  });
  let lastSec = -1;
  setInterval(() => { const s = Math.floor(TL.t); if (s !== lastSec && !editing()) { lastSec = s; renderCard(); } }, 250);
  let lastSelKey = '';
  new MutationObserver(() => { const key = lifeSel ? lifeSel.L.id + ':' + lifeSel.k : ''; if (key === lastSelKey) return; lastSelKey = key; const el = $('card').querySelector('.ledrow'); if (el) el.scrollIntoView({block: 'nearest'}); }).observe($('card'), {childList: true});

  window.MAP = {
    picked: () => { selectedBuild = null; bsel = null; renderCard(); },
    focusPicked() { const us = pickedUnits(); if (!us.length) return; cam.x = us.reduce((a, u) => a + u.x, 0) / us.length; cam.y = us.reduce((a, u) => a + u.y, 0) / us.length; cam.s = Math.max(cam.s, 0.22); renderCard(); },
  };
  $('mapFit').onclick = fit;
  let homeFor = null;
  window.addEventListener('data-loaded', () => {
    computeCamps(); readSquads(); renderMarks();
    if (lifeLane && !TL.lanes.includes(lifeLane)) { lifeLane = TL.lanes.find(L => L.id === lifeLane.id) || null; }
    if (bsel && !bsel.none) { const L = TL.lanes.find(x => x.id === bsel.L.id); if (L) { bsel.L = L; lifeLane = L; } else if (!bsel.L.fresh) bsel = null; }
    if (lifeSel && !TL.lanes.includes(lifeSel.L)) { const L = TL.lanes.find(x => x.id === lifeSel.L.id); lifeSel = L && L.steps[lifeSel.k] ? {L, k: lifeSel.k} : null; }
    const key = D.hall.join(); if (key !== homeFor) { homeFor = key; home(); }
    renderCard();
  });
  $('allRoutes').onclick = () => { showAll = !showAll; $('allRoutes').classList.toggle('on', showAll); TL.toast(showAll ? '淡淡的线是所有农民和英雄的路线；选中谁，谁的路线变亮、带编号。' : '只显示选中单位的路线'); };
  fit(); requestAnimationFrame(draw);
})();
