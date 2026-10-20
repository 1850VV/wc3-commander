/* Commander console UI. Renders either the offline simulation (sim.js) or a live game
 * state pushed by the local bridge (bridge/commander_bridge). Every command becomes an
 * event on the timeline; nothing here talks to units directly. */
(function () {
  'use strict';
  const D = window.LT_DATA, Sim = window.CommanderSim, W = new Sim.World(D), ECO = D.economy.units;
  const T_END = 600, KIND = Sim.KIND, RES = Sim.RES;
  const BUILD_NAMES = {农场: 'hhou', 兵营: 'hbar', 国王祭坛: 'halt', 祭坛: 'halt', 伐木场: 'hlum', 铁匠铺: 'hbla', 神秘藏宝室: 'hvlt', 车间: 'harm', 神秘圣地: 'hars', 狮鹫笼: 'hgra', 侦察塔: 'hwtw'};
  const UNIT_NAMES = {农民: 'hpea', 步兵: 'hfoo', 火枪手: 'hrif', 大法师: 'Hamg', 山丘之王: 'Hmkg', 牧师: 'hmpr', 女巫: 'hsor', 破法者: 'hspt'};
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  let startIndex = 0, groups = Sim.defaultPlan(), G = null, sel = null, placing = null;
  let checkpoints = []; // from a loaded strategy: [{id, name, event, at, from, to}]
  let playing = true, speed = 2, acc = 0, last = performance.now();
  const live = {on: false, state: null, backend: '', es: null, current: null, dirty: false,
    arbMode: false, arb: null, arbN: -1, feedback: [], // arbMode: the bridge's arbiter plays; the timeline shows its decisions
    replay: null}; // a recorded arbiter game being replayed: {id, meta, frames, t, end, consistency}
  const ORDER_NAME = {harvest: '采集', build: '建造', train: '训练', move: '移动', attack: '攻击', smart: '右键', cast: '施放', learn: '学技能', stop: '停止'};
  function orderText(o) {
    const a = o.args || {}, what = a.type_id ? name(a.type_id) : a.order || a.ability_id || '';
    return (ORDER_NAME[o.command] || o.command) + (o.command === 'attack' ? (a.target_id ? '目标' : '移动') : '') + (what ? ' ' + what : '')
      + (a.x != null ? ` @${Math.round(a.x)},${Math.round(a.y)}` : '');
  }
  const allEvents = () => groups.flatMap(g => g.children);
  const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  const nowT = () => Math.min(T_END - 1, Math.round(V().t));
  const name = t => (ECO[t] ? ECO[t].name : t);

  function resim(t) { G = Sim.run(W, startIndex, groups, Math.max(0, Math.min(T_END, t))); }
  function planChanged() { if (live.on) Live.pushPlan(); else resim(G.t); markDirty(); buildTimeline(); }

  /* ---------- the layout that is loaded (a saved strategy) ----------
   * 保存 writes back to this name (「另存为…」 makes a new one); the top bar and the overview show
   * it, and 未保存 while the plan differs from what was loaded or last saved. Plain DOM calls only:
   * a console opened from an older cached page must not throw here. */
  function showPlanName() {
    const nm = live.current, el = $('planName');
    if (el) {
      el.hidden = !nm;
      el.classList.toggle('on', !!nm);
      el.title = nm || '';
      el.textContent = '';
      if (nm) {
        el.appendChild(document.createTextNode('当前布局 · '));
        const b = document.createElement('b'); b.textContent = nm; el.appendChild(b);
        if (live.dirty) { const i = document.createElement('i'); i.className = 'dirty'; i.textContent = '未保存'; el.appendChild(i); }
      }
    }
    const save = $('saveBtn');
    if (save) save.title = nm ? `保存到当前布局「${nm}」（覆盖这套）` : '还没载入布局：保存时会先问名字';
  }
  function setCurrent(name) { live.current = name || null; live.dirty = false; showPlanName(); }
  function markDirty() { if (live.current && !live.dirty) { live.dirty = true; showPlanName(); } }
  function planLine() {
    if (!live.current) return '';
    return `<div class="planline">当前布局 <b>${esc(live.current)}</b>${live.dirty ? '<span class="dirty">未保存</span>' : ''}</div>`;
  }

  /* ---------- view model: same shape for sim and live ---------- */
  let vCache = null, vStamp = -1;
  function V() {
    if (live.on && live.state) return live.view;
    if (live.replay) return Replay.view();
    if (vCache && vStamp === G.t && vCache.g === G) return vCache;
    const trainOf = b => { const Q = G.queues.get(b.id); return Q && Q.cur ? {name: (Q.cur.ev.kind === 'upgrade' ? '升级为' : '') + name(Q.cur.ev.to || Q.cur.ev.utype || 'hpea'), left: Q.cur.left, total: Q.cur.total, queue: Q.q.length} : (Q && Q.q.length ? {name: '', left: 0, total: 0, queue: Q.q.length} : null); };
    vCache = {
      g: G, t: G.t, gold: G.gold, wood: G.wood, foodUsed: G.foodUsed, foodCap: G.foodCap, counts: G.counts(),
      mine: {x: G.mine.x, y: G.mine.y, gold: G.mineGoldLeft()}, hall: G.hall,
      units: G.units.map(u => ({id: u.id, type: u.type, x: u.x, y: u.y, hidden: u.hidden, carry: u.carry, amt: u.amt, task: taskText(u), dest: u.path && u.path.length ? u.path[u.path.length - 1] : null})),
      buildings: G.buildings.map(b => ({id: b.id, type: b.type, x: b.x, y: b.y, tex: b.tex, done: b.done, progress: b.progress, train: trainOf(b)})),
      treeAlive: k => G.treeWood[k] > 0,
    };
    vStamp = G.t; return vCache;
  }
  function taskText(u) {
    const t = u.task;
    if (t.kind === 'idle') return '空闲';
    if (t.kind === 'militia') return t.phase === 'toHall' ? '去城镇大厅敲钟' : '民兵';
    if (t.kind === 'march') return t.arrived ? '清野中（模拟估计）' : '前往分矿清野';
    if (t.kind === 'build') return {toSite: '前往建造 ', waitRes: '等待资源 · ', building: '正在建造 '}[t.phase] + name(t.ev.btype);
    return RES[t.res] + ' · ' + ({toRes: '前往', queue: '排队进矿', mine: '矿内', chop: '砍树', toDrop: '运回'}[t.phase] || '');
  }

  /* ---------- static map layer ---------- */
  const off = document.createElement('canvas'); off.width = W.W; off.height = W.H;
  const octx = off.getContext('2d'), img = octx.createImageData(W.W, W.H), px = new Uint32Array(img.data.buffer);
  const base = new Uint32Array(W.W * W.H);
  const rgba = (r, g, b) => (255 << 24) | (b << 16) | (g << 8) | r;
  const TILE = {Ldrt: [86, 72, 50], Ldro: [76, 64, 46], Ldrg: [74, 86, 50], Ysqd: [98, 94, 82], Yrtl: [88, 84, 74], Lgrs: [58, 84, 44], Yhdg: [52, 70, 40]};
  (function paintBase() {
    const T = D.terrain, raw = atob(T.data), tiles = T.tiles.map(n => TILE[n] || [70, 70, 60]);
    for (let gy = 0; gy < W.H; gy++) for (let gx = 0; gx < W.W; gx++) {
      const tx = Math.min(T.w - 1, Math.round((gx * 32 + 16) / 128)), ty = Math.min(T.h - 1, Math.round((gy * 32 + 16) / 128));
      const v = raw.charCodeAt(ty * T.w + tx), c = tiles[v & 15], cliff = v >> 4, i = gy * W.W + gx;
      const n = ((gx * 7349 + gy * 1931) % 9) - 4, k = W.sBlock[i] ? 0.42 : cliff ? 0.8 : 1;
      base[i] = rgba(Math.max(0, c[0] * k + n) | 0, Math.max(0, c[1] * k + n) | 0, Math.max(0, c[2] * k + n) | 0);
    }
  })();
  const treeDrawn = new Uint8Array(W.trees.length);
  function paintTree(k, alive) {
    for (const i of W.trees[k].walk) {
      const gx = i % W.W, gy = (i - gx) / W.W, o = (W.H - 1 - gy) * W.W + gx;
      px[o] = alive ? ((gx + gy + k) % 3 ? rgba(16 + (k * 13) % 10, 40 + (k * 7) % 12, 18) : rgba(28, 58, 26)) : base[i];
    }
    treeDrawn[k] = alive ? 1 : 0;
  }
  for (let gy = 0; gy < W.H; gy++) for (let gx = 0; gx < W.W; gx++) px[(W.H - 1 - gy) * W.W + gx] = base[gy * W.W + gx];
  W.trees.forEach(t => paintTree(t.id, true));
  octx.putImageData(img, 0, 0);
  function syncTrees(v) {
    if (!v.treeAlive) return;
    let dirty = false;
    for (const t of W.trees) { const a = v.treeAlive(t.id) ? 1 : 0; if (a !== treeDrawn[t.id]) { paintTree(t.id, a); dirty = true; } }
    if (dirty) octx.putImageData(img, 0, 0);
  }

  /* ---------- camera + main canvas ---------- */
  const cv = $('cv'), ctx = cv.getContext('2d'), mm = $('mm'), mctx = mm.getContext('2d');
  const cam = {x: 0, y: 0, s: 0.3};
  let CW = 0, CH = 0, dpr = 1;
  function fit() {
    const r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1; CW = r.width; CH = r.height;
    cv.width = Math.round(CW * dpr); cv.height = Math.round(CH * dpr);
  }
  new ResizeObserver(fit).observe(cv); fit();
  function home() { const s = W.starts[startIndex], m = W.nearestMine(s.x, s.y); cam.x = (s.x * 2 + m.x) / 3; cam.y = (s.y * 2 + m.y) / 3; cam.s = Math.max(0.08, Math.min(1.2, CW / 3800)); }
  const toScreen = (x, y) => [CW / 2 + (x - cam.x) * cam.s, CH / 2 + (cam.y - y) * cam.s];
  const toWorld = (sx, sy) => [cam.x + (sx - CW / 2) / cam.s, cam.y - (sy - CH / 2) / cam.s];
  function clampCam() { const B = W.bounds; cam.x = Math.max(B[0], Math.min(B[1], cam.x)); cam.y = Math.max(B[2], Math.min(B[3], cam.y)); cam.s = Math.max(Math.min(CW, CH) / 16500, Math.min(1.4, cam.s)); }
  function zoomAt(f, sx, sy) { const [wx, wy] = toWorld(sx, sy); cam.s *= f; clampCam(); const [nx, ny] = toWorld(sx, sy); cam.x += wx - nx; cam.y += wy - ny; clampCam(); }

  const font = (s, w) => `${w || 500} ${s}px ${getComputedStyle(document.body).fontFamily}`;
  function rectScreen(r) { const [x0, y0] = toScreen(r[0], r[3]), [x1, y1] = toScreen(r[2], r[1]); return [x0, y0, x1 - x0, y1 - y0]; }
  function label(text, x, y, size, color) {
    ctx.font = font(size); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(text, x, y); ctx.fillStyle = color || '#e9ecdf'; ctx.fillText(text, x, y);
  }
  function plannedReserved(exceptId) {
    return allEvents().filter(e => e.kind === 'build' && e.site && !(e.rt && e.rt.bid) && e.id !== exceptId).map(e => ({type: e.btype, x: e.site[0], y: e.site[1]}));
  }

  /* ---------- planned build sites: drag, pin, upcoming ---------- */
  // A site placed by the player (e.at) is built on that exact point; any other site is picked
  // automatically and Warcraft may still nudge it. Sites can move until the building is started.
  const UPCOMING = 30; // seconds ahead the overview lists build sites
  const siteRect = e => W.rectOf(e.site[0], e.site[1], W.buildingTex(e.btype));
  const siteBody = e => W.bodyRect(e.site[0], e.site[1], W.buildingTex(e.btype));
  const inRect = (r, x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  function movable(e) { const rt = e.rt || {}; return e.kind === 'build' && !e.resume && !!e.site && !rt.bid && rt.status !== 'done'; }
  function siteAt(wx, wy) { return allEvents().find(e => movable(e) && inRect(siteRect(e), wx, wy)); }
  function upcomingSites(t) { return allEvents().filter(e => movable(e) && e.start <= t + UPCOMING).sort((a, b) => a.start - b.start || a.seq - b.seq); }
  function siteGhost(btype, wx, wy, exceptId) {
    const pos = W.snap(btype, wx, wy), chk = placementGame().canPlace(btype, pos[0], pos[1], plannedReserved(exceptId), 0);
    return {btype, pos, ok: chk.ok, why: chk.why};
  }
  function pinSite(e, pos) {
    e.at = pos.slice(); planChanged();
    say('已把' + name(e.btype) + '的工地固定在 ' + pos.join(', ') + '，到时按这个位置精确建造');
  }
  function unpinSite(e) { delete e.at; planChanged(); renderCmd(); say(name(e.btype) + '的工地改回自动选址'); }
  /* the start's natural expansion (closest other mine), as sim.js picks it */
  let natKey = -1, natMine = null;
  function naturalMine() { if (natKey !== startIndex) { natKey = startIndex; natMine = new Sim.Game(W, {start: startIndex, events: []}).natural; } return natMine; }

  /* ---------- wall-in ---------- */
  // Checked on the plan's final layout: every build event's site (where the game actually put it,
  // once known), on an otherwise empty map around the hall. Cached until the layout changes.
  let wallKey = '', wallRes = null, wallBusy = false;
  function layoutSites() {
    return allEvents().filter(e => e.kind === 'build' && !e.resume && e.site)
      .map(e => { const p = (e.rt && e.rt.builtAt) || e.site; return {type: e.btype, x: p[0], y: p[1]}; });
  }
  function wallState() {
    const sites = layoutSites(), key = startIndex + JSON.stringify(sites);
    if (key !== wallKey) { wallKey = key; wallRes = new Sim.Game(W, {start: startIndex, events: []}).wallCheck({sites, area: true}); }
    return wallRes;
  }
  function wallText(r) {
    if (!r.mineOK) return {cls: 'bad', text: '农民到不了金矿：工地把采金路线堵住了'};
    if (r.verdict === 'sealed') return {cls: 'bad', text: `堵死了：最窄处 ${r.K} 格，农民也过不去`};
    if (r.verdict === 'walled') return {cls: 'ok', text: `已封家：最窄处 ${r.K} 格，农民和步兵能过，英雄过不去` + (r.inside ? `；墙内空地 ${r.inside} 格（约 ${Math.floor(r.inside / 16)} 个农场大小）` : '')};
    return {cls: '', text: `未封家：最窄处 ${r.K >= Sim.WALL.cap ? r.K + '+' : r.K} 格，英雄能进来（需要 ${Sim.WALL.hero} 格）`};
  }
  function autoWall() {
    if (wallBusy) return;
    wallBusy = true; say('正在计算封家布局…（几秒钟）');
    setTimeout(() => {
      try {
        const locked = new Set(allEvents().filter(e => e.kind === 'build' && !movable(e)).map(e => e.id));
        const saved = new Map(allEvents().map(e => [e.id, e.rt])); // autoWall replays the plan; keep live status
        const r = Sim.autoWall(W, startIndex, groups, {skip: locked});
        for (const e of allEvents()) if (live.on) e.rt = saved.get(e.id);
        for (const p of r.placed) p.e.at = p.pos.slice();
        planChanged(); renderCmd();
        const t = wallText(r.after);
        say(r.placed.length ? `自动封家：调整了 ${r.placed.length} 个工地。` + t.text + (r.after.verdict === 'open' ? '。可以再加一个农场，或手动拖动工地。' : '') : '没有找到能让通道变窄的位置：' + t.text, r.after.verdict !== 'walled');
      } finally { wallBusy = false; }
    }, 30);
  }
  function focusEvent(e) { sel = {type: 'event', id: e.id}; if (e.site) { cam.x = e.site[0]; cam.y = e.site[1]; } renderCmd(); markSel(); }

  function draw() {
    const v = V(); syncTrees(v);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#0f1412'; ctx.fillRect(0, 0, CW, CH);
    ctx.save(); ctx.imageSmoothingEnabled = false;
    const k = 32 * cam.s;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (CW / 2 - (cam.x - W.ox) * cam.s), dpr * (CH / 2 - (W.oy + W.H * 32 - cam.y) * cam.s));
    ctx.drawImage(off, 0, 0); ctx.restore(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (k >= 12) { // cell grid when zoomed in
      ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1; ctx.beginPath();
      const [wx0, wy1] = toWorld(0, 0), [wx1, wy0] = toWorld(CW, CH);
      for (let x = Math.floor((wx0 - W.ox) / 32) * 32 + W.ox; x < wx1; x += 32) { const s = toScreen(x, 0)[0] | 0; ctx.moveTo(s + .5, 0); ctx.lineTo(s + .5, CH); }
      for (let y = Math.floor((wy0 - W.oy) / 32) * 32 + W.oy; y < wy1; y += 32) { const s = toScreen(0, y)[1] | 0; ctx.moveTo(0, s + .5); ctx.lineTo(CW, s + .5); }
      ctx.stroke();
    }
    const ls = Math.max(10, Math.min(13, cam.s * 40));
    // other start locations
    W.starts.forEach((s, i) => { if (i === startIndex) return; const [x, y, w, h] = rectScreen(W.rectOf(s.x, s.y, W.buildingTex('htow'))); ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); label(s.name + '出生点', x + w / 2, y + h / 2, ls, '#b9c0b5'); });
    for (const m of W.mines) {
      // the 16x16 texture is the unbuildable area; only its middle 8x8 is rock, and that is what
      // the game's mine looks like. Dotted outline = placement footprint, solid = collision.
      const [fx, fy, fw, fh] = rectScreen(W.rectOf(m.x, m.y, m.tex)), [x, y, w, h] = rectScreen(W.bodyRect(m.x, m.y, m.tex));
      ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(228,193,74,.4)'; ctx.lineWidth = 1; ctx.strokeRect(fx, fy, fw, fh); ctx.setLineDash([]);
      ctx.fillStyle = '#8a7322'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#e4c14a'; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
      const mine = m.x === v.mine.x && m.y === v.mine.y, nat = naturalMine();
      const tag = m.x === nat.x && m.y === nat.y ? '分矿 · ' : '';
      if (w > 22) label(tag + (mine && v.mine.gold >= 0 ? '金矿 ' + Math.floor(v.mine.gold) : '金矿'), x + w / 2, y + h / 2, ls);
    }
    for (const n of W.neutrals) {
      const [fx, fy, fw, fh] = rectScreen(W.rectOf(n.x, n.y, n.tex)), [x, y, w, h] = rectScreen(W.bodyRect(n.x, n.y, n.tex));
      if (fw - w > 1 || fh - h > 1) { ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(160,130,190,.35)'; ctx.lineWidth = 1; ctx.strokeRect(fx, fy, fw, fh); ctx.setLineDash([]); }
      ctx.fillStyle = '#4b3a5e'; ctx.fillRect(x, y, w, h);
      if (w > 22) label(n.name, x + w / 2, y + h / 2, ls);
    }
    // planned build sites: solid body = placed by the player (exact, solid outline), dashed = automatic;
    // the dotted ring around it is the unbuildable part of the pathing texture (units can still walk there)
    const soon = new Set(upcomingSites(v.t).map(e => e.id)), dragging = drag && drag.site;
    for (const e of allEvents()) {
      if (e.kind !== 'build' || !e.site || (e.rt && e.rt.bid)) continue;
      const [fx, fy, fw, fh] = rectScreen(siteRect(e)), [x, y, w, h] = rectScreen(siteBody(e));
      const picked = sel && sel.type === 'event' && sel.id === e.id, due = soon.has(e.id);
      ctx.globalAlpha = dragging === e && drag.ghost ? 0.35 : 1;
      ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(214,160,63,.45)'; ctx.lineWidth = 1; ctx.strokeRect(fx, fy, fw, fh); ctx.setLineDash([]);
      ctx.fillStyle = due ? 'rgba(214,160,63,.24)' : 'rgba(214,160,63,.10)'; ctx.fillRect(x, y, w, h);
      if (!e.at) ctx.setLineDash([5, 4]);
      ctx.strokeStyle = picked ? '#fff' : due ? '#f0c060' : '#d6a03f'; ctx.lineWidth = due || e.at ? 2.2 : 1.5; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      if (e.at) { ctx.fillStyle = '#f0c060'; ctx.beginPath(); ctx.arc(x + 5, y + 5, 3.5, 0, Math.PI * 2); ctx.fill(); } // pin mark
      if (w > 26) label(name(e.btype) + ' · ' + fmt(e.start) + (e.at ? ' · 指定' : ''), x + w / 2, y + h / 2, ls * .9, '#e8c27a');
      ctx.globalAlpha = 1;
    }
    for (const b of v.buildings) {
      const [fx, fy, fw, fh] = rectScreen(W.rectOf(b.x, b.y, b.tex)), [x, y, w, h] = rectScreen(W.bodyRect(b.x, b.y, b.tex));
      if (fw - w > 1 || fh - h > 1) { // Simple textures keep a 2-cell walkable ring: show it faintly
        ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(74,138,214,.3)'; ctx.lineWidth = 1; ctx.strokeRect(fx, fy, fw, fh); ctx.setLineDash([]);
      }
      if (b.done) { ctx.fillStyle = '#23466e'; ctx.fillRect(x, y, w, h); }
      else { ctx.fillStyle = 'rgba(74,138,214,.15)'; ctx.fillRect(x, y, w, h); ctx.fillStyle = 'rgba(74,138,214,.55)'; ctx.fillRect(x, y + h * (1 - b.progress), w, h * b.progress); }
      ctx.strokeStyle = sel && sel.type === 'building' && sel.id === b.id ? '#d6a03f' : '#4a8ad6'; ctx.lineWidth = sel && sel.id === b.id ? 2.5 : 1.5; ctx.strokeRect(x, y, w, h);
      if (w > 22) label(name(b.type) + (b.done ? '' : ' ' + Math.floor(b.progress * 100) + '%'), x + w / 2, y + h / 2, ls);
      if (b.train && b.train.total && w > 22) { ctx.fillStyle = '#d6a03f'; ctx.fillRect(x + 3, y + h - 6, (w - 6) * (1 - b.train.left / b.train.total), 3); }
    }
    // wall-in: ring at the narrowest point of the way to the mining route
    const wr = wallState();
    if (wr.choke) {
      const [x, y] = toScreen(...wr.choke), r = Math.max(8, wr.K * 32 * cam.s / 2 + 4), col = wr.verdict === 'walled' ? '#7fb069' : wr.verdict === 'open' ? '#e0904a' : '#d0584a';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      label('最窄 ' + wr.K + ' 格', x, y - r - 9, ls * .9, col);
    }
    if (window.ScriptEditor && ScriptEditor.active()) drawScriptMarkers(ls);
    const ghost = placing && placing.pos ? placing : dragging && drag.ghost;
    if (ghost) {
      const [fx, fy, fw, fh] = rectScreen(W.rectOf(ghost.pos[0], ghost.pos[1], W.buildingTex(ghost.btype)));
      const [x, y, w, h] = rectScreen(W.bodyRect(ghost.pos[0], ghost.pos[1], W.buildingTex(ghost.btype)));
      ctx.setLineDash([2, 5]); ctx.strokeStyle = ghost.ok ? 'rgba(127,176,105,.75)' : 'rgba(208,88,74,.75)'; ctx.lineWidth = 1; ctx.strokeRect(fx, fy, fw, fh); ctx.setLineDash([]);
      ctx.fillStyle = ghost.ok ? 'rgba(127,176,105,.35)' : 'rgba(208,88,74,.35)'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = ghost.ok ? '#7fb069' : '#d0584a'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      if (!ghost.ok && ghost.why && w > 26) label(ghost.why, x + w / 2, y - 10, ls * .9, '#f0a090');
    }
    const su = sel && sel.type === 'unit' ? v.units.find(u => u.id === sel.id) : null;
    if (su && su.dest) { const a = toScreen(su.x, su.y), b = toScreen(...su.dest); ctx.setLineDash([4, 4]); ctx.strokeStyle = '#d6a03f'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); ctx.setLineDash([]); }
    for (const u of v.units) {
      if (u.hidden) continue;
      const [x, y] = toScreen(u.x, u.y), hero = /^[A-Z]/.test(u.type), r = Math.max(3.5, (hero ? 26 : 16) * cam.s);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = hero ? '#b78be0' : u.type === 'hpea' ? (u.task === '空闲' ? '#cdd6de' : '#79b0ee') : '#9fb3c4'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b1a2a'; ctx.stroke();
      if (u.amt > 0) { ctx.beginPath(); ctx.arc(x + r * .8, y - r * .8, Math.max(2, r * .45), 0, Math.PI * 2); ctx.fillStyle = u.carry === 'gold' ? '#e4c14a' : '#76a650'; ctx.fill(); }
      if (r >= 8) { ctx.fillStyle = '#0b1a2a'; ctx.font = font(Math.max(8, r * .95), 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(u.id, x, y + .5); }
      if (su && su.id === u.id) { ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.strokeStyle = '#d6a03f'; ctx.lineWidth = 2; ctx.stroke(); }
    }
    drawMini(v);
  }
  /* the tactic script's named places: a diamond each (solid = where this game put it, hollow = estimated
   * from the layout); only 「坐标 x,y」 places can be dragged, layout sites move with their build box */
  function drawScriptMarkers(ls) {
    for (const m of ScriptEditor.markers()) {
      const moving = drag && drag.mk && drag.mk.name === m.name && drag.mkPos, [x, y] = toScreen(...(moving ? drag.mkPos : [m.x, m.y])), r = 7;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      ctx.fillStyle = m.exact ? (m.sel ? '#fff' : '#c58bf0') : 'rgba(197,139,240,.18)'; ctx.fill();
      ctx.lineWidth = m.sel ? 2.5 : 1.5; ctx.strokeStyle = m.editable ? '#f0c060' : '#c58bf0'; ctx.setLineDash(m.exact ? [] : [3, 2]); ctx.stroke(); ctx.setLineDash([]);
      label('@' + m.name, x, y - r - 8, ls * .9, '#dcc0f5');
    }
  }
  function drawMini(v) {
    const S = mm.width;
    mctx.imageSmoothingEnabled = true; mctx.clearRect(0, 0, S, S); mctx.drawImage(off, 0, 0, S, S);
    const m = (x, y) => [(x - W.ox) / (W.W * 32) * S, (W.oy + W.H * 32 - y) / (W.H * 32) * S];
    mctx.fillStyle = '#e4c14a'; for (const g of W.mines) { const [x, y] = m(g.x, g.y); mctx.fillRect(x - 3, y - 3, 6, 6); }
    mctx.fillStyle = '#4a8ad6'; for (const b of v.buildings) { const [x, y] = m(b.x, b.y); mctx.fillRect(x - 3, y - 3, 6, 6); }
    mctx.fillStyle = '#cfe3ff'; for (const u of v.units) { if (u.hidden) continue; const [x, y] = m(u.x, u.y); mctx.fillRect(x - 1, y - 1, 2, 2); }
    const [a, b] = toWorld(0, 0), [c, d] = toWorld(CW, CH), [x0, y0] = m(a, b), [x1, y1] = m(c, d);
    mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5; mctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }

  /* ---------- pointer input on the map ---------- */
  let drag = null;
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect(), [wx, wy] = toWorld(e.clientX - r.left, e.clientY - r.top);
    drag = {x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false};
    const site = !placing && siteAt(wx, wy); // grabbing a planned site moves it instead of the map
    if (site) Object.assign(drag, {site, off: [wx - site.site[0], wy - site.site[1]], ghost: null});
    else if (!placing && window.ScriptEditor && ScriptEditor.active()) { const mk = ScriptEditor.markerAt(wx, wy, 12 / cam.s); if (mk) drag.mk = mk; }
  });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (placing) updateGhost(...toWorld(sx, sy));
    if (!drag) { if (!placing) cv.style.cursor = siteAt(...toWorld(sx, sy)) ? 'move' : ''; return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved || placing) return;
    if (drag.site) { const [wx, wy] = toWorld(sx, sy); drag.ghost = siteGhost(drag.site.btype, wx - drag.off[0], wy - drag.off[1], drag.site.id); cv.style.cursor = 'move'; }
    else if (drag.mk && drag.mk.editable) { drag.mkPos = toWorld(sx, sy); cv.style.cursor = 'move'; }
    else if (drag.mk) return; // a layout place: its build box is what moves
    else { cam.x = drag.cx - dx / cam.s; cam.y = drag.cy + dy / cam.s; clampCam(); cv.style.cursor = 'grabbing'; }
  });
  cv.addEventListener('pointerup', e => {
    const r = cv.getBoundingClientRect(), [wx, wy] = toWorld(e.clientX - r.left, e.clientY - r.top);
    const d = drag, click = d && !d.moved; drag = null; cv.style.cursor = '';
    if (d && d.site && d.moved && d.ghost) {
      const e2 = d.site, g = d.ghost;
      if (!movable(e2)) say(name(e2.btype) + '已经开工，不能再改位置', true);
      else if (!g.ok) say('这里不能放' + name(e2.btype) + '：' + g.why, true);
      else if (g.pos[0] !== e2.site[0] || g.pos[1] !== e2.site[1]) { pinSite(e2, g.pos); focusEvent(e2); }
      return;
    }
    if (d && d.mk) { if (d.moved && d.mkPos) ScriptEditor.moveMarker(d.mk.name, ...d.mkPos); else ScriptEditor.selectPos(d.mk.name); return; }
    if (!click) return;
    if (placing) { updateGhost(wx, wy); confirmPlace(); return; }
    pick(wx, wy);
  });
  cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, {passive: false});
  $('zIn').onclick = () => zoomAt(1.25, CW / 2, CH / 2);
  $('zOut').onclick = () => zoomAt(0.8, CW / 2, CH / 2);
  $('zHome').onclick = home;
  function miniJump(e) { const r = mm.getBoundingClientRect(); cam.x = W.ox + (e.clientX - r.left) / r.width * W.W * 32; cam.y = W.oy + W.H * 32 - (e.clientY - r.top) / r.height * W.H * 32; clampCam(); }
  mm.addEventListener('pointerdown', e => { miniJump(e); mm.setPointerCapture(e.pointerId); });
  mm.addEventListener('pointermove', e => { if (e.buttons) miniJump(e); });

  function pick(wx, wy) {
    const v = V(); let best = null, bd = Math.max(26, 10 / cam.s);
    for (const u of v.units) { if (u.hidden) continue; const d = Math.hypot(u.x - wx, u.y - wy); if (d < bd) { bd = d; best = u; } }
    if (best) sel = {type: 'unit', id: best.id};
    else {
      const b = v.buildings.find(b => { const r = W.rectOf(b.x, b.y, b.tex); return wx >= r[0] && wx <= r[2] && wy >= r[1] && wy <= r[3]; });
      const e = !b && allEvents().find(e => e.kind === 'build' && e.site && !(e.rt && e.rt.bid) && (r => wx >= r[0] && wx <= r[2] && wy >= r[1] && wy <= r[3])(W.rectOf(e.site[0], e.site[1], W.buildingTex(e.btype))));
      sel = b ? {type: 'building', id: b.id} : e ? {type: 'event', id: e.id} : null;
    }
    renderCmd(); markSel();
  }

  /* ---------- placement mode ---------- */
  const placeTip = $('placeTip');
  function startPlace(btype, unit) {
    placing = {btype, unit, pos: null, ok: false}; cv.classList.add('placing');
    placeTip.hidden = false; placeTip.textContent = '在地图上点击放置 ' + name(btype) + '（金 ' + ECO[btype].gold + ' 木 ' + ECO[btype].wood + '），Esc 取消';
    renderCmd();
  }
  function stopPlace() { placing = null; cv.classList.remove('placing'); placeTip.hidden = true; renderCmd(); }
  function placementGame() { return live.on ? Live.planGame() : G; }
  function updateGhost(wx, wy) {
    const pos = W.snap(placing.btype, wx, wy), chk = placementGame().canPlace(placing.btype, pos[0], pos[1], plannedReserved(), 0);
    placing.pos = pos; placing.ok = chk.ok; placeTip.textContent = chk.ok ? '点击确认放置 ' + name(placing.btype) + '，Esc 取消' : '这里不能放：' + chk.why;
  }
  function confirmPlace() {
    if (!placing.ok) { say('这里不能放：' + placeTip.textContent.replace('这里不能放：', ''), true); return; }
    const e = Sim.ev('build', '建造 ' + name(placing.btype) + (placing.unit ? ' · 农民' + placing.unit : ''), nowT(), {unit: placing.unit || null, btype: placing.btype, at: placing.pos.slice()});
    stopPlace(); addTo('g_user', e);
  }

  /* ---------- status + command card ---------- */
  const statusEl = $('status'), cmdEl = $('cmd'); let lastStatus = '';
  // pointerdown, not click: the panel is re-rendered every second while the countdown runs
  statusEl.addEventListener('pointerdown', p => {
    if (p.target.closest('[data-act="autowall"]')) { autoWall(); return; }
    const b = p.target.closest('[data-ev]'); const e = b && allEvents().find(x => x.id === b.dataset.ev); if (e) focusEvent(e);
  });
  function renderStatus() {
    const v = V(); let h = '';
    const item = sel && (sel.type === 'unit' ? v.units.find(u => u.id === sel.id) : sel.type === 'building' ? v.buildings.find(b => b.id === sel.id) : allEvents().find(e => e.id === sel.id));
    if (sel && !item) { sel = null; renderCmd(); }
    if (!sel) {
      const c = v.counts;
      h = `<div class="title">战局概览</div>` + planLine();
      if (live.arbMode && live.arb) {
        const o = live.arb.orders || {}, dec = live.arb.decisions || [];
        h += `<div class="subtitle">动作审计 <span class="hint">每条命令都要对应一条规则</span></div><div class="kv">
          <span>发出的命令</span><span class="num">${o.total || 0}</span>
          <span>没有出处（多余）</span><span class="num" style="color:${o.untaggedCount ? 'var(--warn)' : 'inherit'}">${o.untaggedCount || 0}</span>
          <span>重复命令</span><span class="num" style="color:${o.repeatCount ? 'var(--warn)' : 'inherit'}">${o.repeatCount || 0}</span>
          <span>被游戏拒绝</span><span class="num" style="color:${(o.rejected || []).length ? 'var(--warn)' : 'inherit'}">${(o.rejected || []).length}</span></div>`;
        const shown = live.replay ? dec.filter(d => d.t <= v.t) : dec;
        if (live.replay && live.replay.consistency) {
          const c = live.replay.consistency, list = (rows, cls) => rows.slice(0, 8).map(r => `<button type="button" class="${cls}"${r.event ? ` data-ev="${r.event}"` : ''}><b>${fmt(r.t)}</b> ${esc(r.what)} <span class="hint">${esc(r.why || '游戏里发生了，但没有对应的决策')}</span></button>`).join('');
          h += `<div class="subtitle">对账 <span class="hint">游戏回报的事件 ↔ 指挥官的决策</span></div><div class="kv">
            <span>对上的</span><span class="num">${c.matched}</span>
            <span>游戏里有、决策里没有</span><span class="num" style="color:${c.gameOnly.length ? 'var(--warn)' : 'inherit'}">${c.gameOnly.length}</span>
            <span>决策下了令、游戏里没发生</span><span class="num" style="color:${c.oursOnly.length ? 'var(--warn)' : 'inherit'}">${c.oursOnly.length}</span>
            <span>阵亡</span><span class="num">${c.deaths.length}</span></div>`
            + (c.gameOnly.length || c.oursOnly.length ? '<div class="upc">' + list(c.oursOnly, 'bad') + list(c.gameOnly, 'bad') + '</div>' : '');
        }
        h += `<div class="subtitle">最近的决策 <span class="hint">共 ${shown.length} 条，点一条看详情</span></div><div class="upc">`
          + shown.slice(-10).reverse().map(d => `<button type="button"${d.event ? ` data-ev="${d.event}"` : ''}><b>${fmt(d.t)}</b> ${d.rule} ${esc(d.action)} <span class="hint">${esc(d.why)}</span></button>`).join('') + '</div>';
      }
      h += `<div class="kv">
        <span>采金</span><span class="num">${c.gold} 名农民</span><span>伐木</span><span class="num">${c.wood} 名农民</span>
        <span>建造</span><span class="num">${c.build} 名农民</span><span>空闲</span><span class="num" style="color:${c.idle ? 'var(--warn)' : 'inherit'}">${c.idle} 名农民</span>
        <span>主矿剩余</span><span class="num">${v.mine.gold >= 0 ? Math.floor(v.mine.gold) + ' 金' : '游戏不提供'}</span></div>`;
      const wr = wallState(), wt = wallText(wr);
      h += `<div class="subtitle">封家</div><div class="wall"><span class="${wt.cls}">${wt.text}</span>`
        + `<button type="button" data-act="autowall"${wallBusy ? ' disabled' : ''}>自动封家</button></div>`
        + `<div class="hint">按计划里全部工地的位置判断；地图上的圆圈是最窄处。农民 2 格、英雄 3 格是推算值，还没在真游戏里验证。</div>`;
      if (checkpoints.length) {
        const res = checkpoints.map(cp => ({cp, r: Sim.checkpoint(cp, allEvents(), v.t)}));
        const TEXT = {ok: () => '按时', early: r => '早 ' + Math.ceil(r.by) + ' 秒', late: r => '晚 ' + Math.ceil(r.by) + ' 秒', missed: () => '没达成', pending: () => '还没到', missing: () => '计划里没有'};
        h += `<div class="subtitle">检查点 <span class="hint">${res.filter(x => x.r.state === 'ok' || x.r.state === 'early').length}/${res.length} 达成</span></div><div class="cps">`
          + res.map(({cp, r}) => `<div class="cp ${r.state}"><span class="num">${fmt(cp.from ?? 0)}–${fmt(cp.to)}</span><span>${cp.name}</span><span>${TEXT[r.state](r)}${r.value != null ? '（' + fmt(r.value) + '）' : ''}</span></div>`).join('') + '</div>';
      }
      const up = upcomingSites(v.t);
      h += `<div class="subtitle">接下来的工地 <span class="hint">（${UPCOMING} 秒内）</span></div>`;
      h += up.length ? '<div class="upc">' + up.map(e => {
        const left = Math.ceil(e.start - v.t), rt = e.rt || {};
        const when = left > 0 ? '还有 ' + left + ' 秒' : (rt.note || '等待开工');
        return `<button type="button" data-ev="${e.id}"><b>${fmt(e.start)}</b> ${name(e.btype)} <span class="${e.at ? 'pin' : 'auto'}">${e.at ? '指定' : '自动'}</span> <span class="hint">${when}</span></button>`;
      }).join('') + '</div><div class="hint">拖动地图上的工地框可以改位置；不拖就按自动位置建造。</div>'
        : '<div class="hint">没有要开工的建筑。拖动地图平移，滚轮缩放；虚线框是自动选的工地，可以拖动。</div>';
    } else if (sel.type === 'unit') {
      const u = item;
      h = `<div class="title">${name(u.type)} #${u.id}</div><div class="kv"><span>当前任务</span><span>${u.task}</span>
        <span>携带</span><span class="num">${u.amt ? u.amt + (u.carry === 'gold' ? ' 金' : ' 木') : '—'}</span><span>坐标</span><span class="num">${Math.round(u.x)}, ${Math.round(u.y)}</span></div>`;
    } else if (sel.type === 'building') {
      const b = item, e = ECO[b.type];
      h = `<div class="title">${name(b.type)}</div><div class="kv"><span>状态</span><span>${b.done ? '已完工' : '建造中 ' + Math.floor(b.progress * 100) + '%'}</span>`;
      if (e.foodMade) h += `<span>提供人口</span><span class="num">${e.foodMade}</span>`;
      if (b.train) h += `<span>生产</span><span>${b.train.total ? b.train.name + ' · 剩 ' + Math.ceil(b.train.left) + ' 秒' : '等待中'}</span><span>排队</span><span class="num">${b.train.queue}</span>`;
      h += '</div>';
      if (!b.done) h += `<div class="bar"><i style="width:${b.progress * 100}%"></i></div>`;
      else if (b.train && b.train.total) h += `<div class="bar"><i style="width:${(1 - b.train.left / b.train.total) * 100}%"></i></div>`;
    } else {
      const e = item, g = groups.find(g => g.children.includes(e));
      if (e.rule) { h = arbDetail(e); if (h !== lastStatus) { statusEl.innerHTML = h; lastStatus = h; } return; }
      h = `<div class="title">${e.name}</div><div class="kv"><span>类型</span><span>${KIND[e.kind]}事件 · ${g.name}</span>
        <span>计划开始</span><span class="num">${fmt(e.start)}${e.after ? '，并等「' + ((allEvents().find(x => x.id === e.after) || {}).name || '已删除的事件') + '」完成' : ''}</span><span>实际开始</span><span class="num">${e.rt && e.rt.aStart != null ? fmt(e.rt.aStart) : '—'}</span>
        <span>状态</span><span>${(e.rt && e.rt.note) || '计划中'}</span>${e.site ? `<span>工地</span><span class="num">${e.site.join(', ')} · ${e.at ? '指定位置（精确建造）' : '自动选址'}</span>` : ''}</div>`;
      if (e.siteNote) h += `<div class="hint" style="color:var(--warn)">${e.siteNote}</div>`;
      const extra = [e.near === 'natural' && '建在分矿', e.helpers && e.helpers + ' 个农民协助建造', e.then === 'natural' && '完工后去分矿采金', e.mine === 'natural' && '在分矿采金'].filter(Boolean);
      if (extra.length) h += `<div class="hint">${extra.join('；')}</div>`;
      if (e.rt && e.rt.placed && !e.at) h += `<div class="hint">游戏实际选址：${e.rt.placed.map(Math.round).join(', ')}</div>`;
      if (movable(e)) h += '<div class="hint">在地图上拖动这个工地框可以改位置。</div>';
    }
    if (h !== lastStatus) { statusEl.innerHTML = h; lastStatus = h; }
  }
  function arbDetail(e) {
    const rt = e.rt || {}, ords = ((live.arb && live.arb.orders && live.arb.orders.byEvent) || {})[e.id] || [];
    const fb = live.feedback.filter(f => f.event === e.id);
    const conf = rt.bStart ?? rt.trainStart ?? (['learn', 'gather', 'militia', 'clear'].includes(e.kind) ? rt.aStart : null);
    const flags = [rt.unexecuted && '游戏接受了命令，但 15 秒内没有执行', rt.rejected && '被游戏拒绝：' + rt.rejected, rt.failed && '失败'].filter(Boolean);
    return `<div class="title">${esc(e.name)}</div><div class="kv">
      <span>规则</span><span>${e.row ? '编排第 ' + e.row + ' 行' : e.rule} · 优先级 ${e.prio}</span><span>依据</span><span>${esc(e.why)}</span>
      <span>决定</span><span class="num">${fmt(e.start)}</span><span>下令</span><span class="num">${rt.ordered != null ? fmt(rt.ordered) : '—'}</span>
      <span>游戏确认</span><span class="num">${conf != null ? fmt(conf) : '—'}</span><span>完成</span><span class="num">${rt.status === 'done' && rt.aEnd != null ? fmt(rt.aEnd) : '—'}</span>
      <span>状态</span><span>${esc(rt.note || '还没开始')}</span></div>`
      + flags.map(f => `<div class="hint" style="color:var(--warn)">${esc(f)}</div>`).join('')
      + `<div class="subtitle">发出的命令 <span class="hint">共 ${rt.orders || 0} 条，显示最近 12 条</span></div><div class="orders">`
      + (ords.length ? ords.map(o => `<div${o.rejected || o.repeat || o.dropped ? ' class="bad"' : ''}><b>${fmt(o.t)}</b> ${o.cid ? '#' + o.cid + ' ' : ''}${esc(orderText(o))} <span class="hint">${o.rule}${o.rejected ? ' · 被拒绝：' + esc(o.rejected) : ''}${o.repeat ? ' · 重复' : ''}${o.dropped ? ' · ' + esc(o.dropped) : ''}</span></div>`).join('') : '<div class="hint">还没有发出命令</div>')
      + `</div><div class="subtitle">你的评价</div>`
      + (fb.length ? fb.map(f => `<div class="fb">${f.score === 'good' ? '👍 对' : f.score === 'bad' ? '👎 错' : ''}${f.prio === 'up' ? ' ⬆ 优先级调高' : f.prio === 'down' ? ' ⬇ 优先级调低' : ''}${f.comment ? ' · ' + esc(f.comment) : ''}</div>`).join('')
        : '<div class="hint">还没有。用命令面板打分、调优先级或写意见，会记进这一局的反馈。</div>');
  }
  const trainBtn = (key, ut, then) => [key, '训练' + name(ut) + (then ? (then === 'gold' ? '→金' : '→木') : ''), () => addTo('g_user', Sim.ev('train', '训练' + name(ut) + (then ? ' → ' + RES[then] : ''), nowT(), {utype: ut, then}))];
  function renderCmd() {
    let btns = [];
    const v = V(), u = sel && sel.type === 'unit' ? v.units.find(x => x.id === sel.id) : null;
    const b = sel && sel.type === 'building' ? v.buildings.find(x => x.id === sel.id) : null;
    if (u && u.type === 'hpea') {
      const id = u.id, place = (k, t) => [k, '建造' + name(t), () => startPlace(t, id), placing && placing.btype === t];
      btns = [
        ['G', '采金', () => addTo('g_user', Sim.ev('gather', '采金 · 农民' + id, nowT(), {units: [id], res: 'gold'}))],
        ['L', '伐木', () => addTo('g_user', Sim.ev('gather', '伐木 · 农民' + id, nowT(), {units: [id], res: 'wood'}))],
        place('F', 'hhou'), place('B', 'hbar'), place('A', 'halt'), place('M', 'hlum'), place('S', 'hbla'),
      ];
    } else if (b && !b.done) {
      btns = [['R', '派农民继续建造', () => addTo('g_user', Sim.ev('build', '继续建造 ' + name(b.type), nowT(), {unit: null, btype: b.type, at: [b.x, b.y], resume: true}))]];
    } else if (b && b.done) {
      const trains = (ECO[b.type].trains || []).filter(t => ECO[t]);
      if (Sim.HALLS.includes(b.type)) btns = [trainBtn('P', 'hpea', 'gold'), trainBtn('W', 'hpea', 'wood')];
      else btns = trains.map((t, i) => trainBtn('QWERTY'[i], t));
      (ECO[b.type].upgrades || []).forEach((to, i) => btns.push(['U' + (i || ''), '升级为' + name(to), () => addTo('g_user', Sim.ev('upgrade', '升级 ' + name(to), nowT(), {from: b.type, to, at: [b.x, b.y]}))]));
    } else if (sel && sel.type === 'event') {
      const e = allEvents().find(x => x.id === sel.id);
      if (e && e.rule) btns = [['Y', '👍 判断对', () => Live.rate(e, {score: 'good'})], ['N', '👎 判断错', () => Live.rate(e, {score: 'bad'})],
        ['↑', '优先级调高', () => Live.rate(e, {prio: 'up'})], ['↓', '优先级调低', () => Live.rate(e, {prio: 'down'})],
        ['C', '写意见…', () => { const c = prompt('对「' + e.name + '」的意见（记进这一局的反馈）'); if (c && c.trim()) Live.rate(e, {comment: c.trim()}); }]];
      else if (e) btns = [['←', '提前 5 秒', () => shiftEv(e, -5)], ['→', '推后 5 秒', () => shiftEv(e, 5)], ['X', '删除事件', () => delEv(e)]];
      if (e && e.at && movable(e)) btns.push(['U', '恢复自动选址', () => unpinSite(e)]);
    }
    if (placing) btns.push(['Esc', '取消放置', stopPlace]);
    cmdEl.innerHTML = '';
    const evSel = sel && sel.type === 'event' && allEvents().find(x => x.id === sel.id);
    if (evSel && !evSel.rule && (!evSel.rt || evSel.rt.status === 'pending')) { // start condition: planned time, or after another event
      const box = document.createElement('label'); box.className = 'after';
      box.append('开始条件 ');
      const s = document.createElement('select');
      s.innerHTML = '<option value="">按计划时间 ' + fmt(evSel.start) + '</option>' + allEvents().filter(x => x !== evSel && x.after !== evSel.id)
        .map(x => `<option value="${x.id}"${evSel.after === x.id ? ' selected' : ''}>等「${x.name}」完成（且不早于 ${fmt(evSel.start)}）</option>`).join('');
      s.onchange = () => setAfter(evSel, s.value); box.appendChild(s); cmdEl.appendChild(box);
    }
    if (!btns.length) { cmdEl.innerHTML = '<div class="hint" style="grid-column:1/-1">选中农民、建筑或时间轴事件后，这里出现可用命令。每个命令都会变成时间轴上的一个事件。</div>'; return; }
    const n = Math.max(9, Math.ceil(btns.length / 3) * 3);
    for (let i = 0; i < n; i++) {
      const bt = btns[i];
      if (!bt) { const d = document.createElement('div'); d.className = 'empty'; cmdEl.appendChild(d); continue; }
      const el = document.createElement('button'); el.type = 'button'; el.innerHTML = `<kbd>${bt[0]}</kbd>${bt[1]}`; el.onclick = bt[2]; el.dataset.key = bt[0];
      if (bt[3]) el.classList.add('armed'); cmdEl.appendChild(el);
    }
  }
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'Escape') { if (placing) stopPlace(); else { sel = null; renderCmd(); markSel(); } return; }
    const k = e.key.length === 1 ? e.key.toUpperCase() : ({ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Delete: 'X'})[e.key];
    const btn = k && [...cmdEl.querySelectorAll('button')].find(b => b.dataset.key === k); if (btn) { e.preventDefault(); btn.click(); }
  });

  /* ---------- editing ---------- */
  function addTo(gid, e) {
    const g = groups.find(g => g.id === gid); g.children.push(e); g.open = true;
    planChanged(); say('已加入时间轴：' + fmt(e.start) + ' ' + e.name); return e;
  }
  function shiftEv(e, d) { e.start = Math.max(0, Math.min(T_END - 1, e.start + d)); planChanged(); }
  function delEv(e) {
    groups.forEach(g => g.children = g.children.filter(x => x !== e));
    const waiting = allEvents().filter(x => x.after === e.id);
    for (const x of waiting) delete x.after; // they fall back to their planned time
    sel = null; planChanged(); renderCmd();
    say('已删除：' + e.name + (waiting.length ? '；' + waiting.map(x => '「' + x.name + '」').join('') + '不再等它，改回按计划时间开始' : ''));
  }
  function setAfter(e, id) { if (id) e.after = id; else delete e.after; planChanged(); renderCmd(); say(id ? `「${e.name}」改为等「${allEvents().find(x => x.id === id).name}」完成后再开始` : `「${e.name}」改回按计划时间开始`); }
  const msgEl = $('msg');
  function say(t, err) { msgEl.textContent = t; msgEl.className = 'msg' + (err ? ' err' : ''); }
  function parseCmd(text, gid) {
    let s = text.trim(), at = nowT(), r;
    const m = s.match(/^@\s*(\d+)\s*/); if (m) { at = Math.min(T_END - 1, +m[1]); s = s.slice(m[0].length); }
    if ((r = s.match(/^(造|训练)\s*(农民|步兵|火枪手|大法师|山丘之王|牧师|女巫|破法者)\s*(?:→|->|去|>)?\s*(采金|伐木)?/))) {
      const ut = UNIT_NAMES[r[2]], then = ut === 'hpea' ? (r[3] === '伐木' ? 'wood' : 'gold') : undefined;
      return addTo(gid, Sim.ev('train', '训练' + r[2] + (then ? ' → ' + RES[then] : ''), at, {utype: ut, then}));
    }
    if ((r = s.match(/^(?:建造|建|造)\s*分基地\s*(\d+)?/))) { const n = Math.max(0, Math.min(5, +(r[1] || 0))); return addTo(gid, Sim.ev('build', '建造 分基地' + (n ? '（' + n + ' 人协助）' : ''), at, {unit: null, btype: 'htow', near: 'natural', helpers: n || undefined, then: 'natural'})); }
    if ((r = s.match(/^采金\s*(\d+)?\s*分矿/))) { const n = Math.max(1, Math.min(12, +(r[1] || 1))); return addTo(gid, Sim.ev('gather', '采金 × ' + n + ' · 分矿', at, {count: n, res: 'gold', mine: 'natural'})); }
    if ((r = s.match(/^学\s*水元素/))) return addTo(gid, Sim.ev('learn', '大法师学水元素', at, {hero: 'Hamg', ability: 'AHwe', abilityName: '水元素'}));
    if ((r = s.match(/^敲钟\s*(\d+)?/))) { const n = Math.max(1, Math.min(8, +(r[1] || 4))); return addTo(gid, Sim.ev('militia', '敲钟 ' + n + ' 个民兵', at, {count: n, from: 'wood'})); }
    if ((r = s.match(/^清(?:野|近矿)/))) {
      const mil = allEvents().filter(x => x.kind === 'militia').sort((a, b) => b.start - a.start)[0]; // the latest bell-ringing joins
      return addTo(gid, Sim.ev('clear', '清近矿', at, {militia: mil ? mil.id : undefined}));
    }
    if ((r = s.match(/^升级\s*(主城|城堡|防御塔|炮塔)/))) { const to = {主城: 'hkee', 城堡: 'hcas', 防御塔: 'hatw', 炮塔: 'hgtw'}[r[1]]; return addTo(gid, Sim.ev('upgrade', '升级 ' + name(to), at, {to})); }
    if ((r = s.match(/^(采金|伐木)\s*(\d+)?/))) { const res = r[1] === '采金' ? 'gold' : 'wood', n = Math.max(1, Math.min(12, +(r[2] || 1))); return addTo(gid, Sim.ev('gather', r[1] + ' × ' + n, at, {count: n, res})); }
    if ((r = s.match(/^(建造|建|造)\s*(国王祭坛|神秘藏宝室|神秘圣地|农场|兵营|祭坛|伐木场|铁匠铺|车间|狮鹫笼|侦察塔)/))) { const t = BUILD_NAMES[r[2]]; return addTo(gid, Sim.ev('build', '建造 ' + name(t), at, {unit: null, btype: t})); }
    say('没看懂这条指令。支持：造农民 → 采金/伐木、训练 步兵/火枪手/大法师/牧师/女巫/破法者、采金 N、采金 N 分矿、伐木 N、建造 农场/兵营/伐木场/铁匠铺、建造 分基地 N（N 个农民协助）、升级 主城/防御塔、学 水元素、敲钟 N、清野，前面可加 @秒数 定时。', true);
    return null;
  }
  const cliIn = $('cliIn');
  function runCli() { if (cliIn.value.trim() && parseCmd(cliIn.value, 'g_user')) cliIn.value = ''; }
  $('cliGo').onclick = runCli; cliIn.addEventListener('keydown', e => { if (e.key === 'Enter') runCli(); });
  ['造农民 → 伐木', '伐木 2', '建造 农场', '@90 建造 铁匠铺', '@150 训练 火枪手'].forEach(t => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.onclick = () => { cliIn.value = t; cliIn.focus(); }; $('ex').appendChild(b); });

  /* rule-based suggestion placeholder */
  let pendingSug = null;
  function suggest() {
    const v = V(), c = v.counts, q = v.buildings.reduce((n, b) => n + (b.train ? b.train.queue + (b.train.total ? 1 : 0) : 0), 0);
    const farmOpen = allEvents().some(e => e.kind === 'build' && e.btype === 'hhou' && !(e.rt && e.rt.status === 'done'));
    if (v.foodUsed + q >= v.foodCap - 2 && !farmOpen) return {cmd: '建造 农场', why: `人口 ${v.foodUsed}/${v.foodCap} 快满了，先补农场避免卡人口。`};
    if (c.idle > 0) return {cmd: '采金 ' + c.idle, why: `有 ${c.idle} 个空闲农民。`};
    const hall = v.buildings.find(b => Sim.HALLS.includes(b.type) && b.done);
    if (hall && !hall.train && v.gold >= 75) return {cmd: '造农民 → 采金', why: '主基地没在训练，金币够。'};
    if (c.wood < 3) return {cmd: '伐木 1', why: `只有 ${c.wood} 个农民伐木，木材会卡住建筑和科技。`};
    const bar = v.buildings.find(b => b.type === 'hbar' && b.done && !b.train);
    if (bar && v.gold >= 135) return {cmd: '训练 步兵', why: '兵营空闲，补一个步兵。'};
    return {cmd: null, why: '当前分工合理，继续按计划运营。'};
  }
  $('aiAsk').onclick = () => { const s = suggest(); pendingSug = s.cmd; $('aiSug').innerHTML = s.cmd ? `建议 <b>${s.cmd}</b>：${s.why}` : s.why; $('aiTake').hidden = !s.cmd; };
  $('aiTake').onclick = () => { if (pendingSug && parseCmd(pendingSug, 'g_ai')) { pendingSug = null; $('aiTake').hidden = true; $('aiSug').textContent = '已采纳，事件放进了「AI 指令」。'; } };

  /* ---------- timeline ---------- */
  const tlBody = $('tlBody'); let barRefs = [];
  const pct = t => (Math.max(0, Math.min(T_END, t)) / T_END * 100) + '%';
  function buildTimeline() {
    tlBody.innerHTML = ''; barRefs = [];
    const ruler = document.createElement('div'); ruler.className = 'row';
    ruler.innerHTML = '<div class="lab" style="color:var(--muted);font-size:11px">事件 ／ 时间</div>';
    const rt = document.createElement('div'); rt.className = 'track ruler';
    for (let t = 0; t < T_END; t += T_END > 300 ? 60 : 30) { const k = document.createElement('div'); k.className = 'tick'; k.style.left = pct(t); k.textContent = fmt(t); rt.appendChild(k); }
    rt.addEventListener('pointerdown', seekFrom); ruler.appendChild(rt); tlBody.appendChild(ruler);
    for (const g of groups) {
      const row = document.createElement('div'); row.className = 'row grp';
      const lab = document.createElement('div'); lab.className = 'lab'; lab.innerHTML = `<span>${g.open ? '▾' : '▸'}</span><span>${g.name}</span><span class="src">${g.src}</span>`;
      lab.onclick = () => { g.open = !g.open; buildTimeline(); };
      const tr = document.createElement('div'); tr.className = 'track'; tr.addEventListener('pointerdown', seekFrom);
      const gb = document.createElement('div'); gb.className = 'ev grpbar'; gb.onclick = ev => { ev.stopPropagation(); g.open = !g.open; buildTimeline(); };
      tr.appendChild(gb); row.append(lab, tr); tlBody.appendChild(row); barRefs.push({g, el: gb});
      if (!g.open) continue;
      if (!g.children.length) { const e = document.createElement('div'); e.className = 'row'; e.innerHTML = `<div class="empty-row">${g.id === 'g_ai' ? '点下方「AI 建议」并采纳，事件会出现在这里。' : '用命令面板、地图放置或下方指令输入添加事件。'}</div>`; tlBody.appendChild(e); continue; }
      for (const e of g.children) {
        const r = document.createElement('div'); r.className = 'row child';
        r.innerHTML = `<div class="lab"><span class="chip ${e.kind}">${KIND[e.kind]}</span><span>${e.name}</span></div>`;
        const t = document.createElement('div'); t.className = 'track'; t.addEventListener('pointerdown', seekFrom);
        const b = document.createElement('div'); b.className = 'ev'; attachDrag(b, e, t); t.appendChild(b); r.appendChild(t); tlBody.appendChild(r);
        barRefs.push({e, el: b});
      }
    }
    const ph = document.createElement('div'); ph.className = 'playhead'; tlBody.appendChild(ph);
    markSel();
  }
  function seekFrom(ev) {
    if (live.on) return; // cannot rewind a live game
    if (ev.target !== ev.currentTarget && !ev.currentTarget.classList.contains('ruler')) return;
    const r = ev.currentTarget.getBoundingClientRect(), t = Math.round((ev.clientX - r.left) / r.width * T_END);
    if (live.replay) { Replay.seek(t); return; }
    resim(t);
  }
  let dragPending = null;
  function attachDrag(b, e, track) {
    b.addEventListener('pointerdown', p => {
      p.stopPropagation(); b.setPointerCapture(p.pointerId);
      const x0 = p.clientX, s0 = e.start, w = track.getBoundingClientRect().width; let moved = false;
      const started = (e.rt && e.rt.status !== 'pending' && live.on) || live.arbMode; // the arbiter decides its own times
      const mv = q => {
        if (started) return;
        const d = Math.round((q.clientX - x0) / w * T_END); if (Math.abs(q.clientX - x0) > 3) moved = true;
        const ns = Math.max(0, Math.min(T_END - 1, s0 + d));
        if (ns !== e.start) { e.start = ns; markDirty(); if (!dragPending) dragPending = requestAnimationFrame(() => { dragPending = null; if (live.on) Live.pushPlan(); else resim(G.t); }); }
      };
      const up = () => {
        b.removeEventListener('pointermove', mv); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up);
        if (moved) say('改到 ' + fmt(e.start) + ' 开始：' + e.name + (live.on ? '' : '（整局已按新编排重算）'));
        else { sel = {type: 'event', id: e.id}; renderCmd(); markSel(); if (e.site) { cam.x = e.site[0]; cam.y = e.site[1]; } }
      };
      b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    });
  }
  function markSel() { barRefs.forEach(r => r.e && r.el.classList.toggle('sel', !!(sel && sel.type === 'event' && sel.id === r.e.id))); }
  function evSpan(e) {
    const rt = e.rt || {}, s = rt.aStart ?? e.start, t = V().t;
    if (e.kind === 'gather') return [s, T_END];
    if (e.kind === 'learn') return [s, (rt.aEnd ?? s) + 2];
    if (e.kind === 'militia') return [s, rt.aEnd ?? Math.max(t, s) + 50];
    if (e.kind === 'clear') return [s, rt.aEnd ?? (rt.fightStart != null ? rt.fightStart + rt.est : Math.max(t, s) + (e.est || 40) + 30)];
    if (rt.status === 'done') return [s, Math.max(rt.aEnd, s + 1)];
    if (e.kind === 'train' || e.kind === 'upgrade') { const d = ECO[e.to || e.utype || 'hpea'].time; return [s, rt.trainStart != null ? rt.trainStart + d : Math.max(t, s) + d]; }
    const d = ECO[e.btype].time; return [s, rt.bStart != null ? rt.bStart + d : Math.max(t, s) + d + 4];
  }
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const STAT = ['pending', 'waiting', 'running', 'active', 'done'];
  function updateTimeline() {
    for (const r of barRefs) {
      if (r.e) {
        const e = r.e, [a, b] = evSpan(e), st = (e.rt && e.rt.status) || 'pending';
        r.el.style.left = pct(a); r.el.style.width = 'calc(' + pct(b) + ' - ' + pct(a) + ')';
        if (!r.el.classList.contains(st)) { r.el.classList.remove(...STAT); r.el.classList.add(st); }
        setText(r.el, st === 'pending' ? (e.rt && e.rt.note ? e.name + ' · ' + e.rt.note : e.name) : (e.rt.note || e.name));
        r.el.title = e.name + ' · ' + ((e.rt && e.rt.note) || '计划中');
        r.el.classList.toggle('future', !!live.replay && e.start > V().t); // replay: not decided yet at this moment
      } else {
        const ch = r.g.children; if (!ch.length) { r.el.hidden = true; continue; } r.el.hidden = false;
        let a = 1e9, b = 0, done = 0, liveN = 0;
        for (const e of ch) { const [x, y] = evSpan(e); a = Math.min(a, x); b = Math.max(b, y); const s = e.rt && e.rt.status; if (s === 'done') done++; if (s === 'running' || s === 'active' || s === 'waiting') liveN++; }
        r.el.style.left = pct(a); r.el.style.width = 'calc(' + pct(b) + ' - ' + pct(a) + ')';
        const st = done === ch.length ? 'done' : liveN ? 'running' : 'pending';
        if (!r.el.classList.contains(st)) { r.el.classList.remove(...STAT); r.el.classList.add(st); }
        setText(r.el, `${r.g.name} · ${done}/${ch.length} 完成`);
      }
    }
    tlBody.style.setProperty('--p', V().t / T_END);
  }

  /* ---------- replay of a recorded arbiter game (bridge/runs/<id>) ---------- */
  const Replay = {
    async list(sel) {
      try {
        const j = await (await fetch('/api/runs')).json(), keep = sel.options[0];
        sel.innerHTML = ''; sel.appendChild(keep);
        for (const r of j.runs || []) {
          const o = document.createElement('option'); o.value = r.id;
          o.textContent = `${(r.began || r.id).replace('T', ' ').slice(5, 16)} ${r.name || ''}${r.speed > 1 ? ' · ' + r.speed + '×' : ''}${r.feedback ? ' · ' + r.feedback + ' 条意见' : ''}${r.replay ? ' · 有魔兽录像' : ''}`;
          o.disabled = !r.hasState; sel.appendChild(o);
        }
      } catch (_) { /* keep */ }
    },
    async load(id) {
      if (live.on) { say('游戏连接中不能回放，先点「断开」', true); return; }
      let j;
      try { j = await (await fetch('/api/runs/' + encodeURIComponent(id))).json(); } catch (_) { say('读不到这一局的记录', true); return; }
      if (!j.ok || !j.frames.length) { say('这一局没有可以回放的记录' + (j.error ? '：' + j.error : ''), true); return; }
      const st = j.state;
      live.replay = {id, meta: j.meta, frames: j.frames, t: 0, end: j.frames[j.frames.length - 1].t, consistency: st.consistency || null, fi: 0, state: st};
      live.arbMode = false; live.arbN = -1;
      if (st.start != null) { startIndex = st.start; startSel.value = String(st.start); }
      Live.syncArbiter(st); live.feedback = j.feedback || [];
      playing = false; bPlay.textContent = '▶ 播放'; ['bPlay', 'speeds', 'bReset'].forEach(x => $(x).hidden = false);
      live.replayExit.hidden = false; $('modeTag').textContent = '回放 · ' + (j.meta.name || id); $('modeTag').classList.add('live');
      sel = null; home(); this.seek(0); renderCmd();
      say(`回放：${j.meta.name || id}，共 ${fmt(live.replay.end)}。点「播放」或拖动时间轴；点一条事件看依据、命令和游戏回报，并可以打分。` + (j.replay ? '魔兽录像在游戏的 Replay\\commander 文件夹。' : ''));
    },
    seek(t, keepPlaying) {
      const r = live.replay; if (!r) return;
      r.t = Math.max(0, Math.min(r.end, t));
      if (r.t >= r.end && !keepPlaying) { /* stay */ } else if (r.t >= r.end) { playing = false; bPlay.textContent = '▶ 重播'; }
      let i = r.fi; const F = r.frames;
      if (F[i].t > r.t) i = 0;
      while (i + 1 < F.length && F[i + 1].t <= r.t) i++;
      if (i !== r.fi || !r.view) { r.fi = i; r.view = null; }
      lastStatus = '';
    },
    view() {
      const r = live.replay;
      if (!r.view) {
        const f = r.frames[r.fi], units = f.units.map(u => ({...u, task: u.task || '', dest: null}));
        const counts = {gold: 0, wood: 0, build: 0, idle: 0};
        for (const u of units) if (u.type === 'hpea') counts[u.role || 'idle'] = (counts[u.role || 'idle'] || 0) + 1;
        r.view = {t: f.t, gold: f.gold, wood: f.wood, foodUsed: f.foodUsed, foodCap: f.foodCap, counts, units, mine: {x: 0, y: 0, gold: -1},
          buildings: f.buildings.map(b => ({...b, tex: W.buildingTex(b.type) || 'PathTextures\\8x8Default.tga'})), treeAlive: null};
      }
      return Object.assign(r.view, {t: r.t});
    },
    exit() {
      live.replay = null; live.arbMode = false; live.arb = null; live.replayExit.hidden = true; playing = false;
      groups = Sim.defaultPlan(); checkpoints = []; buildTimeline();
      $('modeTag').textContent = '离线预演'; $('modeTag').classList.remove('live'); resim(0); sel = null; renderCmd(); say('已退出回放');
    },
  };

  /* ---------- live bridge (only when served by bridge/commander_bridge) ---------- */
  const Live = {
    async probe() { // any host: the bridge may be opened over the LAN (--host / bridge.ps1 -Lan)
      if (location.protocol === 'file:') return;
      try { const r = await fetch('/api/health'); if (!r.ok) return; const h = await r.json(); if (h.ok) this.offer(h); } catch (_) { /* offline page */ }
    },
    offer(h) {
      live.backend = h.backend;
      const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = '连接 ' + (h.backend === 'fake' ? '假游戏服务器' : '魔兽争霸三');
      b.onclick = () => (live.on ? this.disconnect(b) : this.connect(b)); $('modeTag').after(b);
      const tk = live.tacticBtn = document.createElement('button'); tk.className = 'btn tactic on'; tk.type = 'button'; tk.hidden = true;
      tk.title = '开：按时间轴自动下命令；关：只看游戏、不下任何命令，你自己操作'; tk.onclick = () => this.tactic(!live.tactic); b.after(tk); this.showTactic(true);
      const sv = document.createElement('button'); sv.className = 'btn'; sv.id = 'saveBtn'; sv.type = 'button'; sv.textContent = '保存';
      sv.onclick = () => this.save(); b.after(sv);
      const sa = document.createElement('button'); sa.className = 'btn'; sa.type = 'button'; sa.textContent = '另存为…';
      sa.title = '把这套编排存成一套新布局，当前布局不变'; sa.onclick = () => this.saveAs(); sv.after(sa);
      const ld = document.createElement('select'); ld.className = 'btn'; ld.title = '载入保存过的编排（会替换当前整套编排）';
      ld.innerHTML = '<option value="">载入布局…</option>';
      ld.onfocus = ld.onpointerdown = () => this.list(ld); ld.onchange = () => { const nm = ld.value; ld.value = ''; if (nm) this.load(nm); }; sa.after(ld);
      const rp = document.createElement('select'); rp.className = 'btn'; rp.title = '回放仲裁器打过的一局：事件流、沙盘和资源跟着时间走，可以打分';
      rp.innerHTML = '<option value="">回放…</option>';
      rp.onfocus = rp.onpointerdown = () => Replay.list(rp); rp.onchange = () => { const id = rp.value; rp.value = ''; if (id) Replay.load(id); }; ld.after(rp);
      const ex = live.replayExit = document.createElement('button'); ex.className = 'btn'; ex.type = 'button'; ex.textContent = '退出回放'; ex.hidden = true;
      ex.onclick = () => Replay.exit(); rp.after(ex);
      showPlanName();
    },
    async list(ld) {
      try {
        const j = await (await fetch('/api/strategies')).json();
        const keep = ld.options[0]; ld.innerHTML = ''; ld.appendChild(keep);
        for (const s of j.strategies || []) { const o = document.createElement('option'); o.value = s.name; o.textContent = `${s.name}（${s.start != null ? W.starts[s.start].name : '?'}，${s.events} 个事件）`; ld.appendChild(o); }
      } catch (_) { /* keep the old list */ }
    },
    async load(nm) {
      if (live.on) { say('游戏连接中不能载入，先点「断开」', true); return; }
      try {
        const j = await (await fetch('/api/strategies/' + encodeURIComponent(nm))).json();
        if (!j.ok) { say('载入失败：' + j.error, true); return; }
        groups = j.plan.groups.map(g => ({...g, open: true, children: g.children.map(e => ({...e, rt: null}))}));
        checkpoints = j.plan.checkpoints || [];
        Sim.syncSeq(allEvents());
        if (j.plan.start != null) { startIndex = j.plan.start; startSel.value = String(startIndex); }
        sel = null; resim(0); buildTimeline(); renderCmd(); home(); playing = false; bPlay.textContent = '▶ 播放';
        setCurrent(j.name);
        say(`已载入「${j.name}」（${W.starts[startIndex].name}出生点，${allEvents().length} 个事件），保存于 ${j.saved}`);
      } catch (_) { say('载入失败：连不上本地服务', true); }
    },
    resolveSites() { // saved plans must carry every build site: the engine starts events from it
      if (live.on) G = Sim.run(W, startIndex, groups, 0); else resim(G.t);
    },
    async put(nm) {
      this.resolveSites();
      try {
        const r = await fetch('/api/strategies/' + encodeURIComponent(nm), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify(this.serialize())});
        const j = await r.json();
        if (!j.ok) { say('没保存成功：' + j.error, true); return null; }
        setCurrent(j.name);
        say(`已保存到「${j.name}」：${j.events} 个事件`);
        return j.name;
      } catch (_) { say('没保存成功：连不上本地服务', true); return null; }
    },
    async save() { // the plain save goes back to the loaded layout, no question asked
      if (live.current) return this.put(live.current);
      return this.saveAs();
    },
    async saveAs() {
      const d = new Date(), pad = n => String(n).padStart(2, '0');
      const def = live.current ? live.current + ' 副本' : `布局 ${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
      const nm = prompt('保存为新布局（会存成 strategies/名字.json）', def);
      if (!nm || !nm.trim()) return;
      return this.put(nm.trim());
    },
    async connect(btn) {
      let h = {};
      try { h = await (await fetch('/api/health')).json(); } catch (_) { say('连不上本地服务', true); return; }
      if (h.running || h.waiting) { // a game is already going (or awaited): join it with its plan instead of starting anew
        try { const j = await (await fetch('/api/plan')).json(); this.adopt(j.plan, j.name); } catch (_) { say('读不到正在运行的计划', true); return; }
      } else if (h.launch) this.pushPlan(); // test switch / fake server: send this plan and launch a game
      // otherwise the bridge waits for the game you start and picks the strategy for your start itself
      live.es = new EventSource('/api/stream');
      live.es.onmessage = m => { const msg = JSON.parse(m.data); if (msg.type === 'state') this.apply(msg.state); else if (msg.type === 'plan') this.adopt(msg.plan, msg.name); else if (msg.type === 'log') say(msg.text, msg.level === 'error'); };
      live.es.onerror = () => say('与本地服务的连接中断，正在重试…', true);
      live.on = true; btn.textContent = '断开'; this.showTactic(h.running ? h.tactic !== false : true); live.tacticBtn.hidden = false; ['bPlay', 'speeds', 'bReset'].forEach(id => $(id).hidden = true); $('modeTag').textContent = '实机 · ' + (live.backend === 'fake' ? '假服务器' : 'wc3env'); $('modeTag').classList.add('live');
      if (h.running) { say('已加入正在进行的游戏（' + W.starts[startIndex].name + '，' + allEvents().length + ' 个事件）'); return; }
      if (h.waiting) { say('正在等待你开游戏…'); return; }
      fetch('/api/control', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'start', start: startIndex})});
    },
    adopt(plan, nm) { // take over the plan the bridge is running, keeping the console in step with the game
      if (!plan || !Array.isArray(plan.groups) || !plan.groups.length) return;
      groups = plan.groups.map(g => ({...g, open: true, children: g.children.map(e => ({...e, rt: null}))}));
      checkpoints = plan.checkpoints || [];
      Sim.syncSeq(allEvents());
      if (plan.start != null) { startIndex = plan.start; startSel.value = String(startIndex); }
      if (nm) setCurrent(nm);
      sel = null; G = Sim.run(W, startIndex, groups, 0); buildTimeline(); renderCmd(); home();
    },
    disconnect(btn) {
      if (live.es) live.es.close(); live.on = false; live.state = null; btn.textContent = '重新连接'; live.tacticBtn.hidden = true; ['bPlay', 'speeds', 'bReset'].forEach(id => $(id).hidden = false);
      fetch('/api/control', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'stop'})});
      $('modeTag').textContent = '离线预演'; $('modeTag').classList.remove('live');
      if (live.arbMode) { live.arbMode = false; live.arb = null; groups = Sim.defaultPlan(); checkpoints = []; buildTimeline(); } // back to an editable plan
      resim(0);
    },
    showTactic(on) { live.tactic = on; const tk = live.tacticBtn; tk.textContent = on ? '战术：开' : '战术：关'; tk.classList.toggle('on', on); },
    tactic(on) { // the bridge keeps reading the game either way; off only stops it giving orders
      this.showTactic(on);
      fetch('/api/control', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'tactic', on})}).catch(() => say('开关没送到本地服务', true));
    },
    planGame() { return G; }, // placement checks use the offline model of the same map
    serialize() { return {start: startIndex, checkpoints, groups: groups.map(g => ({id: g.id, name: g.name, src: g.src, children: g.children.map(({rt, ...e}) => e)}))}; },
    pushPlan() {
      if (live.arbMode) return; // the arbiter's events are its decisions, not a plan to send back
      G.planSites && (G = Sim.run(W, startIndex, groups, 0)); // resolve build sites with the same placement rules
      fetch('/api/plan', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({...this.serialize(), name: live.current})}).catch(() => say('计划没送到本地服务', true));
    },
    syncArbiter(s) {
      live.arb = s;
      if (!live.arbMode) {
        live.arbMode = true; live.arbN = -1;
        if (!live.replay) { this.loadFeedback(); say('这局由仲裁器指挥：事件按阶段显示它的决策。点一条看依据、发出的命令和游戏回报，并在命令面板打分。'); }
      }
      const defs = s.arbEvents || [];
      if (defs.length === live.arbN) return;
      live.arbN = defs.length;
      const num = r => parseInt(r.slice(1), 10), isB = r => r[0] === 'B';
      const PH = [['g_b1', '开局', r => isB(r) && num(r) <= 9], ['g_b2', '清野', r => isB(r) && num(r) >= 10 && num(r) <= 18],
        ['g_b3', '分矿', r => isB(r) && num(r) >= 19 && num(r) <= 23], ['g_b4', '二本', r => isB(r) && num(r) >= 24 && num(r) <= 26],
        ['g_b5', '二本后', r => isB(r) && num(r) >= 27], ['g_a', '常驻规则（农民、农场、步兵）', r => !isB(r)]];
      const open = new Map(groups.map(g => [g.id, g.open]));
      const toEv = d => ({...d, name: (d.row ? '第' + d.row + '行 ' : d.rule + ' ') + d.name, rt: (s.events || {})[d.id] || null});
      if (defs.some(d => d.phase)) { // an orchestration: the player's own phases, in the order its rows use them
        const order = (s.orchestration && s.orchestration.rows || []).map(r => r.phase).concat(defs.map(d => d.phase || '其他'));
        const phases = [...new Set(order)].filter(ph => defs.some(d => (d.phase || '其他') === ph));
        groups = phases.map((ph, i) => ({id: 'g_ph' + i, name: ph, src: '编排', open: open.get('g_ph' + i) ?? true,
          children: defs.filter(d => (d.phase || '其他') === ph).map(toEv)}));
      } else {
        groups = PH.map(([id, nm, f]) => ({id, name: nm, src: '仲裁器', open: open.get(id) ?? true,
          children: defs.filter(d => f(d.rule)).map(toEv)}));
      }
      checkpoints = [];
      buildTimeline();
    },
    async loadFeedback() {
      try { const j = await (await fetch('/api/feedback')).json(); live.feedback = j.feedback || []; lastStatus = ''; } catch (_) { /* keep */ }
    },
    async rate(e, f) {
      try {
        const r = await fetch('/api/feedback', {method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({event: e.id, rule: e.rule, action: e.name, t: e.start, ...f, ...(live.replay ? {run: live.replay.id} : {})})});
        const j = await r.json();
        if (!j.ok) { say('没记下：' + j.error, true); return; }
        live.feedback = j.feedback; lastStatus = '';
        say('已记下对「' + e.name + '」的' + (f.score ? (f.score === 'good' ? '肯定' : '否定') : f.prio ? '优先级意见' : '意见'));
      } catch (_) { say('没记下：连不上本地服务', true); }
    },
    apply(s) {
      live.state = s;
      if (s.arbiter) this.syncArbiter(s);
      if (s.enabled != null && s.enabled !== live.tactic) this.showTactic(s.enabled); // a new game starts with it on
      if (s.start != null && s.start !== startIndex) { startIndex = s.start; startSel.value = String(s.start); home(); say('游戏分配的出生点是' + W.starts[s.start].name + '，已切换'); }
      const evs = new Map(allEvents().map(e => [e.id, e]));
      for (const [id, rt] of Object.entries(s.events || {})) { const e = evs.get(id); if (e) e.rt = rt; }
      const units = s.units.map(u => ({...u, task: u.task || '', dest: null}));
      const workers = units.filter(u => u.type === 'hpea'), counts = {gold: 0, wood: 0, build: 0, idle: 0};
      for (const u of workers) counts[u.role || 'idle'] = (counts[u.role || 'idle'] || 0) + 1;
      live.view = {t: s.t, gold: s.gold, wood: s.wood, foodUsed: s.foodUsed, foodCap: s.foodCap, counts, units,
        mine: s.mine || {x: 0, y: 0, gold: 0}, buildings: s.buildings.map(b => ({...b, tex: W.buildingTex(b.type) || 'PathTextures\\8x8Default.tga'})), treeAlive: null};
    },
  };

  /* ---------- loop + controls ---------- */
  const bPlay = $('bPlay');
  function togglePlay() {
    if (live.on) return;
    if (live.replay) { if (live.replay.t >= live.replay.end) Replay.seek(0); playing = !playing; bPlay.textContent = playing ? '❚❚ 暂停' : '▶ 播放'; return; }
    if (G.t >= T_END) resim(0); playing = !playing; bPlay.textContent = playing ? '❚❚ 暂停' : '▶ 播放'; }
  bPlay.onclick = togglePlay;
  [1, 2, 4, 8, 16].forEach(s => { const b = document.createElement('button'); b.className = 'btn' + (s === speed ? ' on' : ''); b.type = 'button'; b.textContent = s + '×'; b.onclick = () => { speed = s; [...$('speeds').children].forEach(x => x.classList.toggle('on', x === b)); }; $('speeds').appendChild(b); });
  $('bReset').onclick = () => { if (live.on) return; if (live.replay) { Replay.seek(0); return; } resim(0); sel = null; renderCmd(); };
  const startSel = $('startSel');
  W.starts.forEach((s, i) => { const o = document.createElement('option'); o.value = i; o.textContent = s.name; startSel.appendChild(o); });
  startSel.onchange = () => { startIndex = +startSel.value; sel = null; markDirty(); if (live.on) Live.pushPlan(); else resim(G.t); home(); renderCmd(); };
  $('foot').textContent = `地图与数值：失落神庙通行网格 ${W.W}×${W.H}、${W.trees.length} 棵树、${W.mines.length} 座金矿，单位造价与工期取自 1.27a 数据（来自 warcraft-commander 提取）。` +
    `模拟假设：每趟采金/伐木 ${Sim.TUNING.carry}，金矿每次进一个农民、矿内 ${Sim.TUNING.mineSeconds} 秒（未校准），伐木每下 ${Sim.TUNING.chopSeconds} 秒，每棵树 ${Sim.TUNING.treeWood} 木；不模拟单位碰撞和战斗。`;

  /* Paint at 10 fps beside a live game (the bridge pushes ~4 states/s) and 30 fps offline: the map
   * is redrawn from scratch, and at 4K a 60 fps repaint is what made the console feel heavy. */
  let lastPaint = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    if (live.replay) { if (playing) Replay.seek(live.replay.t + dt * speed, true); }
    else if (!live.on && playing && G.t < T_END) { acc += dt * speed; while (acc >= Sim.DT && G.t < T_END) { G.step(); acc -= Sim.DT; } }
    if (!live.on && !live.replay && G.t >= T_END && playing) { playing = false; bPlay.textContent = '▶ 重播'; }
    if (now - lastPaint < (live.on ? 100 : 33)) return;
    lastPaint = now;
    const v = V();
    draw(); renderStatus(); updateTimeline(); if (window.ScriptEditor) ScriptEditor.tick(now);
    $('rGold').textContent = Math.floor(v.gold); $('rWood').textContent = Math.floor(v.wood); $('rFood').textContent = v.foodUsed + '/' + v.foodCap; $('clock').textContent = fmt(v.t);
  }
  resim(0); buildTimeline(); renderCmd(); fit(); home(); Live.probe(); requestAnimationFrame(frame);
  if (window.ScriptEditor) ScriptEditor.init({live: () => live, groups: () => groups, startIndex: () => startIndex, startName: i => W.starts[i].name,
    hall: () => ({x: W.starts[startIndex].x, y: W.starts[startIndex].y}), natural: naturalMine, say, fmt, name, tl: document.querySelector('.tl'),
    focus: (x, y) => { cam.x = x; cam.y = y; clampCam(); }});
})();
