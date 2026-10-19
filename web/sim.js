/* Commander simulation core: Lost Temple grid, A* pathing, building placement and an
 * event-driven economy model. Runs in the browser (window.CommanderSim) and in Node
 * (module.exports) so the same rules can be tested offline.
 *
 * This is a planning model, not Warcraft: no unit collision, no combat, mining and
 * chopping times are approximations (see TUNING). The bridge uses the real game. */
(function (root) {
  'use strict';

  const DT = 0.1;
  const TUNING = {
    mineSeconds: 1.0,      // time inside the mine per trip (assumption, not calibrated)
    chopSeconds: 1.1,      // seconds per lumber hit (Peasant tree attack cooldown)
    carry: 10,             // gold or lumber per trip
    treeWood: 50,          // lumber per tree (assumption)
    startGold: 500, startWood: 150, startWorkers: 5,
  };
  const HALLS = ['htow', 'hkee', 'hcas'];
  const KIND = {build: '建造', gather: '采集', train: '生产'};
  const RES = {gold: '采金', wood: '伐木'};

  function decodeRows(rows, w, h) {
    const out = new Uint8Array(w * h);
    rows.forEach((row, y) => row.forEach(([a, b]) => out.fill(1, y * w + a, y * w + b)));
    return out;
  }

  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        for (;;) {
          let c = i * 2 + 1; if (c >= k.length) break;
          if (c + 1 < k.length && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  /* ---------------- static world ---------------- */
  class World {
    constructor(D) {
      this.D = D; this.W = D.w; this.H = D.h; this.C = D.cell; this.ox = D.origin[0]; this.oy = D.origin[1];
      this.eco = D.economy.units; this.speed = D.worker.speed; this.bounds = D.bounds;
      const N = this.W * this.H;
      this.sBlock = decodeRows(D.block, this.W, this.H);
      this.sNoBuild = decodeRows(D.noBuild, this.W, this.H);
      for (const [x, y, tex] of D.props) this._stamp(x, y, tex);
      this.mines = D.mines.map((m, i) => ({id: 'm' + i, x: m.x, y: m.y, gold: m.gold, tex: m.tex}));
      for (const m of this.mines) this._stamp(m.x, m.y, m.tex);
      this.neutrals = D.neutrals.map(n => ({...n}));
      for (const n of this.neutrals) this._stamp(n.x, n.y, n.tex);
      this.trees = [];
      for (let i = 0; i < D.trees.length; i += 2) {
        const x = D.trees[i], y = D.trees[i + 1];
        this.trees.push({id: i / 2, x, y, walk: this.cellsOf(x, y, D.treeTex, 'walk'), build: this.cellsOf(x, y, D.treeTex, 'build')});
      }
      this.N = N;
      this.starts = D.starts;
    }
    tex(name) { return this.D.textures[name]; }
    buildingTex(type) { return this.D.buildingTex[type]; }
    /* Rasterize a pathing texture centred at (x, y) onto grid cells (row 0 = south). */
    cellsOf(x, y, texName, channel) {
      const fp = this.tex(texName), C = this.C, l = x - fp.w * 16, b = y - fp.h * 16, out = [];
      fp[channel].forEach((row, ry) => row.forEach(([a, z]) => {
        const gy0 = Math.floor((b + ry * C - this.oy) / C), gy1 = Math.ceil((b + (ry + 1) * C - this.oy) / C);
        const gx0 = Math.floor((l + a * C - this.ox) / C), gx1 = Math.ceil((l + z * C - this.ox) / C);
        for (let gy = gy0; gy < gy1; gy++) for (let gx = gx0; gx < gx1; gx++)
          if (gx >= 0 && gy >= 0 && gx < this.W && gy < this.H) out.push(gy * this.W + gx);
      }));
      return out;
    }
    rectOf(x, y, texName) { const fp = this.tex(texName); return [x - fp.w * 16, y - fp.h * 16, x + fp.w * 16, y + fp.h * 16]; }
    _stamp(x, y, tex) {
      for (const i of this.cellsOf(x, y, tex, 'walk')) this.sBlock[i] = 1;
      for (const i of this.cellsOf(x, y, tex, 'build')) this.sNoBuild[i] = 1;
    }
    cellAt(x, y) {
      const gx = Math.floor((x - this.ox) / this.C), gy = Math.floor((y - this.oy) / this.C);
      return gx < 0 || gy < 0 || gx >= this.W || gy >= this.H ? -1 : gy * this.W + gx;
    }
    center(i) { return [this.ox + (i % this.W + 0.5) * this.C, this.oy + (Math.floor(i / this.W) + 0.5) * this.C]; }
    snap(type, x, y) {
      const fp = this.tex(this.buildingTex(type)), ox = fp.w * 16 % 64, oy = fp.h * 16 % 64;
      return [Math.round((x - ox) / 64) * 64 + ox, Math.round((y - oy) / 64) * 64 + oy];
    }
    nearestMine(x, y) { let best = null, d = Infinity; for (const m of this.mines) { const e = Math.hypot(m.x - x, m.y - y); if (e < d) { d = e; best = m; } } return best; }
  }

  /* ---------------- one simulated game ---------------- */
  class Game {
    constructor(world, opts) {
      const w = this.w = world, N = w.N;
      this.startIndex = opts.start || 0;
      this.t = 0; this.gold = TUNING.startGold; this.wood = TUNING.startWood;
      this.foodUsed = 0; this.foodCap = 0;
      this.treeWood = new Float32Array(w.trees.length).fill(TUNING.treeWood);
      this.treeCnt = new Uint8Array(N); this.treeNoBuild = new Uint8Array(N);
      for (const tr of w.trees) { for (const i of tr.walk) this.treeCnt[i]++; for (const i of tr.build) this.treeNoBuild[i]++; }
      this.bldCnt = new Uint8Array(N); this.bldNoBuild = new Uint8Array(N);
      this.ver = 0; this.paths = new Map();
      this.units = []; this.buildings = []; this.nextId = 1; this.queues = new Map();
      this.mineInside = new Map(); this.mineGold = new Map(w.mines.map(m => [m.id, m.gold]));
      this.log = [];
      const s = w.starts[this.startIndex];
      const [hx, hy] = [s.x, s.y];
      this.hall = this._addBuilding('htow', hx, hy, true, null);
      this.mine = w.nearestMine(hx, hy);
      this.basis = this._basis();
      const {dir, perp} = this.basis, half = w.tex(w.buildingTex('htow')).w * 16;
      for (let k = 0; k < TUNING.startWorkers; k++) {
        const p = [hx + dir[0] * (half + 40) + perp[0] * (k - 2) * 44, hy + dir[1] * (half + 40) + perp[1] * (k - 2) * 44];
        const u = this._spawn('hpea', p[0], p[1]);
        u.task = {kind: 'idle'};
      }
      this.events = opts.events || [];
      for (const e of this.events) e.rt = {status: 'pending', aStart: null, aEnd: null, note: ''};
    }
    /* direction from hall to mine and its perpendicular; used to place buildings generically */
    _basis() {
      const dx = this.mine.x - this.hall.x, dy = this.mine.y - this.hall.y, d = Math.hypot(dx, dy) || 1;
      return {dir: [dx / d, dy / d], perp: [-dy / d, dx / d]};
    }
    blocked(i) { return i < 0 || this.w.sBlock[i] || this.treeCnt[i] || this.bldCnt[i]; }
    noBuild(i) { return i < 0 || this.w.sNoBuild[i] || this.treeNoBuild[i] || this.bldNoBuild[i]; }

    _spawn(type, x, y) {
      const u = {id: this.nextId++, type, x, y, task: {kind: 'idle'}, carry: null, amt: 0, path: null, hidden: false};
      this._unstick(u); this.units.push(u);
      this.foodUsed += this.w.eco[type] ? this.w.eco[type].food : 1;
      return u;
    }
    _unstick(u) {
      let i = this.w.cellAt(u.x, u.y); if (!this.blocked(i)) return;
      const W = this.w.W;
      for (let r = 1; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const j = i + dy * W + dx; if (!this.blocked(j)) { [u.x, u.y] = this.w.center(j); u.path = null; return; }
      }
    }
    _addBuilding(type, x, y, done, ev) {
      const w = this.w, tex = w.buildingTex(type);
      const b = {id: 'b' + (this.buildings.length + 1), type, x, y, tex, done, progress: done ? 1 : 0, ev, start: this.t,
                 walk: w.cellsOf(x, y, tex, 'walk'), build: w.cellsOf(x, y, tex, 'build')};
      for (const i of b.walk) this.bldCnt[i]++; for (const i of b.build) this.bldNoBuild[i]++;
      this.buildings.push(b); this.ver++;
      if (done) this.foodCap = Math.min(100, this.foodCap + (w.eco[type].foodMade || 0));
      for (const u of this.units) this._unstick(u);
      return b;
    }
    _removeTree(k) {
      const tr = this.w.trees[k];
      for (const i of tr.walk) this.treeCnt[i]--; for (const i of tr.build) this.treeNoBuild[i]--;
      this.ver++;
    }

    /* ---------- pathing ---------- */
    _ring(rect) {
      // free cells touching a rectangle (world units), used as goal set for buildings/mines/trees
      const w = this.w, C = w.C, out = [];
      const gx0 = Math.floor((rect[0] - w.ox) / C) - 1, gx1 = Math.ceil((rect[2] - w.ox) / C);
      const gy0 = Math.floor((rect[1] - w.oy) / C) - 1, gy1 = Math.ceil((rect[3] - w.oy) / C);
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        if (gx < 0 || gy < 0 || gx >= w.W || gy >= w.H) continue;
        if (gx > gx0 && gx < gx1 && gy > gy0 && gy < gy1) continue;
        const i = gy * w.W + gx; if (!this.blocked(i)) out.push(i);
      }
      return out;
    }
    path(fromX, fromY, goals, key) {
      const w = this.w, W = w.W, start = w.cellAt(fromX, fromY);
      const ck = start + '|' + key + '|' + this.ver;
      if (this.paths.has(ck)) return this.paths.get(ck);
      if (this.paths.size > 4000) this.paths.clear();
      const res = this._astar(start, goals);
      this.paths.set(ck, res); return res;
    }
    _astar(start, goals) {
      const w = this.w, W = w.W, N = w.N;
      if (!goals.length) return null;
      if (!this._buf) this._buf = {g: new Float32Array(N), par: new Int32Array(N), seen: new Uint32Array(N), goal: new Uint32Array(N), gen: 0};
      const B = this._buf; B.gen++;
      const gen = B.gen; let tx = 0, ty = 0;
      for (const i of goals) { B.goal[i] = gen; tx += i % W; ty += Math.floor(i / W); }
      tx /= goals.length; ty /= goals.length;
      const h = i => { const dx = Math.abs(i % W - tx), dy = Math.abs(Math.floor(i / W) - ty); return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)); };
      const heap = new Heap();
      B.g[start] = 0; B.seen[start] = gen; B.par[start] = -1; heap.push(h(start), start);
      const closed = new Set(); let found = -1, guard = 0;
      while (heap.size && guard++ < 200000) {
        const i = heap.pop(); if (closed.has(i)) continue; closed.add(i);
        if (B.goal[i] === gen) { found = i; break; }
        const x = i % W, y = (i - x) / W;
        for (let d = 0; d < 8; d++) {
          const dx = [1, -1, 0, 0, 1, 1, -1, -1][d], dy = [0, 0, 1, -1, 1, -1, 1, -1][d];
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= w.H) continue;
          const j = ny * W + nx; if (this.blocked(j)) continue;
          if (dx && dy && (this.blocked(i + dx) || this.blocked(i + dy * W))) continue; // no corner cutting
          const g = B.g[i] + (dx && dy ? Math.SQRT2 : 1);
          if (B.seen[j] === gen && g >= B.g[j]) continue;
          B.seen[j] = gen; B.g[j] = g; B.par[j] = i; heap.push(g + h(j), j);
        }
      }
      if (found < 0) return null;
      const cells = []; for (let i = found; i >= 0; i = B.par[i]) cells.push(i);
      cells.reverse();
      return this._smooth(cells.map(i => w.center(i)));
    }
    _clear(a, b) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(len / 10);
      for (let k = 1; k < n; k++) {
        const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
        for (const [ox, oy] of [[0, 0], [12, 12], [-12, 12], [12, -12], [-12, -12]]) if (this.blocked(this.w.cellAt(x + ox, y + oy))) return false;
      }
      return true;
    }
    _smooth(pts) {
      if (pts.length < 3) return pts;
      const out = [pts[0]]; let i = 0;
      while (i < pts.length - 1) {
        let j = pts.length - 1;
        while (j > i + 1 && !this._clear(pts[i], pts[j])) j--;
        out.push(pts[j]); i = j;
      }
      return out;
    }
    /* walk u along a path toward goal cells; returns true on arrival */
    walk(u, goals, key) {
      if (!goals.length) return false;
      const here = this.w.cellAt(u.x, u.y);
      if (goals.includes(here)) { u.path = null; return true; }
      if (!u.path || u.pathKey !== key || u.pathVer !== this.ver) {
        const p = this.path(u.x, u.y, goals, key);
        if (!p) return false;
        u.path = p.slice(1); u.pathKey = key; u.pathVer = this.ver;
        if (!u.path.length) return true;
      }
      let step = this.w.speed * DT;
      while (step > 0 && u.path.length) {
        const [px, py] = u.path[0], d = Math.hypot(px - u.x, py - u.y);
        if (d <= step) { u.x = px; u.y = py; step -= d; u.path.shift(); }
        else { u.x += (px - u.x) / d * step; u.y += (py - u.y) / d * step; step = 0; }
      }
      if (!u.path.length) { u.path = null; return true; }
      return false;
    }

    /* ---------- placement ---------- */
    lane() { // mining lane between hall and mine; keep it clear like the native solver does
      return [[this.hall.x, this.hall.y], [this.mine.x, this.mine.y]];
    }
    canPlace(type, x, y, reserved) {
      const w = this.w, tex = w.buildingTex(type), r = w.rectOf(x, y, tex), B = w.bounds;
      if (r[0] < B[0] || r[2] > B[1] || r[1] < B[2] || r[3] > B[3]) return {ok: false, why: '超出地图边界'};
      for (const i of w.cellsOf(x, y, tex, 'build')) if (this.noBuild(i)) return {ok: false, why: '地形、树木或建筑占用'};
      const [a, b] = this.lane();
      if (segRectDist([a, b], r) < 150) return {ok: false, why: '挡住采金路线'};
      for (const o of reserved || []) {
        const q = w.rectOf(o.x, o.y, w.buildingTex(o.type));
        if (r[0] < q[2] + 32 && r[2] > q[0] - 32 && r[1] < q[3] + 32 && r[3] > q[1] - 32) return {ok: false, why: '与计划中的建筑重叠'};
      }
      return {ok: true};
    }
    findSite(type, ax, ay, reserved) {
      const [sx, sy] = this.w.snap(type, ax, ay);
      for (let r = 0; r <= 24; r++) {
        let best = null, bd = Infinity;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx * 64, y = sy + dy * 64;
          if (!this.canPlace(type, x, y, reserved).ok) continue;
          const d = Math.hypot(x - ax, y - ay); if (d < bd) { bd = d; best = [x, y]; }
        }
        if (best) return best;
      }
      return null;
    }
    /* generic anchor relative to the hall, rotated by the hall->mine direction */
    anchor(type, k) {
      const {dir, perp} = this.basis, h = this.hall;
      const at = (back, side) => [h.x - dir[0] * back + perp[0] * side, h.y - dir[1] * back + perp[1] * side];
      const table = {halt: [380, 420], hbar: [420, -460], hlum: [-80, 620], hbla: [700, 40], hvlt: [700, 300], hars: [760, -300], hwtw: [-200, -420]};
      if (type === 'hhou') return at(-160 + 140 * (k % 5), -560 - 140 * Math.floor(k / 5));
      return at(...(table[type] || [600, 0]));
    }

    /* ---------- events ---------- */
    /* Resolve every build event's site. Player-placed sites (e.at) are reserved first, so an
     * earlier auto-placed building never takes a spot the player picked; auto sites keep their
     * anchor numbering by start order. e.siteNote explains a placed site that had to move. */
    planSites() {
      const reserved = [], counts = {}, nth = new Map();
      const builds = this.events.filter(e => e.kind === 'build').sort((a, b) => a.start - b.start || a.seq - b.seq);
      for (const e of builds) {
        delete e.siteNote;
        if (e.resume) { e.site = e.at; continue; }
        nth.set(e, counts[e.btype] = (counts[e.btype] || 0) + 1);
      }
      for (const e of [...builds.filter(e => e.at && !e.resume), ...builds.filter(e => !e.at && !e.resume)]) {
        let site = null;
        if (e.at) {
          const [x, y] = this.w.snap(e.btype, e.at[0], e.at[1]), chk = this.canPlace(e.btype, x, y, reserved);
          if (chk.ok) site = [x, y]; else e.siteNote = '指定位置不能建（' + chk.why + '），改到旁边';
        }
        if (!site) { const [ax, ay] = e.at || this.anchor(e.btype, nth.get(e) - 1); site = this.findSite(e.btype, ax, ay, reserved); }
        e.site = site;
        if (site) reserved.push({type: e.btype, x: site[0], y: site[1]});
      }
    }
    unit(id) { return this.units.find(u => u.id === id); }
    workers() { return this.units.filter(u => u.type === 'hpea'); }
    pickWorkers(n, res) {
      const sc = u => u.task.kind === 'idle' ? 0 : u.task.kind === 'gather' && u.task.res !== res ? 1 : 9;
      return this.workers().filter(u => u.task.kind !== 'build' && sc(u) < 9).sort((a, b) => sc(a) - sc(b) || a.id - b.id).slice(0, n);
    }
    pickBuilder(site) {
      const pool = this.workers().filter(u => u.task.kind !== 'build' && !u.hidden);
      pool.sort((a, b) => (a.task.kind === 'idle' ? 0 : 1) - (b.task.kind === 'idle' ? 0 : 1) || (a.task.res === 'gold' ? 0 : 1) - (b.task.res === 'gold' ? 0 : 1) || a.amt - b.amt ||
        (site ? Math.hypot(a.x - site[0], a.y - site[1]) - Math.hypot(b.x - site[0], b.y - site[1]) : 0) || a.id - b.id);
      return pool[0] || null;
    }
    gatherTask(res) { return {kind: 'gather', res, phase: 'toRes'}; }
    tryStart(e) {
      const rt = e.rt;
      if (e.kind === 'build' && e.resume) {
        const b = this.buildings.find(b => !b.done && b.type === e.btype && b.x === e.at[0] && b.y === e.at[1]);
        if (!b) { Object.assign(rt, {status: 'done', aStart: this.t, aEnd: this.t, note: '没有找到暂停的' + this.w.eco[e.btype].name}); return; }
        const u = e.unit ? this.unit(e.unit) : this.pickBuilder(e.at);
        if (!u || u.hidden) { rt.note = '没有可用农民'; return; }
        u.task = {kind: 'build', ev: b.ev, phase: 'toSite'}; u.path = null; b.ev.rt.builder = u.id;
        Object.assign(rt, {status: 'done', aStart: this.t, aEnd: this.t, note: '农民' + u.id + ' 去继续建造'});
        return;
      }
      if (e.kind === 'build') {
        if (!e.site) { rt.note = '找不到可建造的位置'; return; }
        const u = e.unit ? this.unit(e.unit) : this.pickBuilder(e.site);
        if (!u) { rt.note = '没有可用农民'; return; }
        if (u.hidden) { rt.note = '农民' + u.id + ' 在金矿里'; return; }
        u.task = {kind: 'build', ev: e, phase: 'toSite'}; u.path = null;
        Object.assign(rt, {status: 'running', aStart: this.t, note: '农民' + u.id + ' 前往工地', builder: u.id});
      } else if (e.kind === 'gather') {
        const us = e.units ? e.units.map(id => this.unit(id)).filter(Boolean) : this.pickWorkers(e.count || 1, e.res);
        if (!us.length) { rt.note = '没有可分配的农民'; return; }
        for (const u of us) if (!(u.task.kind === 'gather' && u.task.res === e.res)) { u.task = this.gatherTask(e.res); u.path = null; }
        Object.assign(rt, {status: 'active', aStart: this.t, note: '农民' + us.map(u => u.id).join('、') + ' ' + RES[e.res] + '中'});
      } else if (e.kind === 'train') {
        const ut = e.utype || 'hpea';
        const prods = this.buildings.filter(b => b.done && (this.w.eco[b.type].trains || []).includes(ut));
        if (!prods.length) { rt.note = '还没有能生产' + this.w.eco[ut].name + '的建筑'; return; }
        const p = prods.sort((a, b) => this.qlen(a) - this.qlen(b))[0];
        if (!this.queues.has(p.id)) this.queues.set(p.id, {cur: null, q: []});
        this.queues.get(p.id).q.push(e);
        Object.assign(rt, {status: 'waiting', aStart: this.t, note: '排队中 · ' + this.w.eco[p.type].name, producer: p.id});
      }
    }
    qlen(b) { const q = this.queues.get(b.id); return q ? q.q.length + (q.cur ? 1 : 0) : 0; }
    heroCount() { return this.units.filter(u => /^[A-Z]/.test(u.type)).length; }
    costOf(ut) {
      const e = this.w.eco[ut];
      if (/^[A-Z]/.test(ut) && this.heroCount() === 0 && !this._heroQueued && this.w.D.economy.assumptions.first_hero_free) return [0, 0, e.food];
      return [e.gold, e.wood, e.food];
    }

    step() {
      const due = this.events.filter(e => e.rt.status === 'pending' && e.start <= this.t + 1e-9).sort((a, b) => a.start - b.start || a.seq - b.seq);
      for (const e of due) this.tryStart(e);
      this._production(); this._units(); this._construction();
      this.t = Math.round((this.t + DT) * 10) / 10;
    }
    _production() {
      for (const b of this.buildings) {
        const Q = this.queues.get(b.id); if (!Q) continue;
        if (Q.cur) {
          Q.cur.left -= DT; const e = Q.cur.ev;
          e.rt.note = '训练中 ' + Math.ceil(Math.max(0, Q.cur.left)) + '秒';
          if (Q.cur.left <= 1e-6) {
            const ut = e.utype || 'hpea', {dir} = this.basis, half = this.w.tex(b.tex).w * 16;
            const u = {id: this.nextId++, type: ut, x: b.x + dir[0] * (half + 40), y: b.y + dir[1] * (half + 40), task: {kind: 'idle'}, carry: null, amt: 0, path: null, hidden: false};
            this._unstick(u); this.units.push(u);
            if (ut === 'hpea') u.task = this.gatherTask(e.then || 'gold');
            Object.assign(e.rt, {status: 'done', aEnd: this.t, note: this.w.eco[ut].name + u.id + ' 出生' + (ut === 'hpea' ? ' → ' + RES[e.then || 'gold'] : '')});
            Q.cur = null;
          }
        }
        if (!Q.cur && Q.q.length) {
          const e = Q.q[0], ut = e.utype || 'hpea', [g, l, f] = this.costOf(ut);
          const missing = (this.w.eco[ut].requires || []).filter(r => !this.buildings.some(b => b.done && b.type === r));
          if (missing.length) e.rt.note = '需要 ' + missing.map(r => this.w.eco[r] ? this.w.eco[r].name : r).join('、');
          else if (this.foodUsed + f > this.foodCap) e.rt.note = '人口不足 ' + this.foodUsed + '/' + this.foodCap;
          else if (this.gold < g || this.wood < l) e.rt.note = '等待资源 金' + Math.floor(this.gold) + '/' + g + (l ? ' 木' + Math.floor(this.wood) + '/' + l : '');
          else {
            this.gold -= g; this.wood -= l; this.foodUsed += f; Q.q.shift(); if (/^[A-Z]/.test(ut)) this._heroQueued = true;
            Q.cur = {ev: e, left: this.w.eco[ut].time, total: this.w.eco[ut].time};
            Object.assign(e.rt, {status: 'running', trainStart: this.t, note: '训练中'});
          }
        }
      }
    }
    dropFor(res, u) {
      const opts = this.buildings.filter(b => b.done && (HALLS.includes(b.type) || (res === 'wood' && b.type === 'hlum')));
      opts.sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y));
      return opts[0] || this.hall;
    }
    nearestTree(x, y, avoid) {
      let best = -1, bd = Infinity;
      for (const tr of this.w.trees) {
        if (this.treeWood[tr.id] <= 0) continue;
        const d = Math.hypot(tr.x - x, tr.y - y) + (avoid.get(tr.id) || 0) * 96;
        if (d < bd && this._ring(this.w.rectOf(tr.x, tr.y, this.w.D.treeTex)).length) { bd = d; best = tr.id; }
      }
      return best;
    }
    _units() {
      const w = this.w, mineRect = w.rectOf(this.mine.x, this.mine.y, this.mine.tex);
      const tgt = new Map(); for (const u of this.units) if (u.task.tree != null) tgt.set(u.task.tree, (tgt.get(u.task.tree) || 0) + 1);
      for (const u of this.units) {
        const t = u.task;
        if (t.kind === 'gather') {
          if (t.phase === 'toRes') {
            if (u.amt > 0 && u.carry !== t.res) { t.phase = 'toDrop'; continue; }
            if (u.amt >= TUNING.carry) { t.phase = 'toDrop'; continue; }
            if (t.res === 'gold') {
              if (this.walk(u, this._ring(mineRect), 'mine')) t.phase = 'queue';
            } else {
              if (t.tree == null || this.treeWood[t.tree] <= 0) { const d = this.dropFor('wood', u); t.tree = this.nearestTree(d.x, d.y, tgt); if (t.tree < 0) { u.task = {kind: 'idle'}; continue; } tgt.set(t.tree, (tgt.get(t.tree) || 0) + 1); u.path = null; }
              const tr = w.trees[t.tree];
              if (this.walk(u, this._ring(w.rectOf(tr.x, tr.y, w.D.treeTex)), 'tree' + t.tree)) { t.phase = 'chop'; t.timer = TUNING.chopSeconds; }
            }
          } else if (t.phase === 'queue') {
            const inside = this.mineInside.get(this.mine.id);
            if (inside == null && this.mineGold.get(this.mine.id) > 0) { this.mineInside.set(this.mine.id, u.id); u.hidden = true; t.phase = 'mine'; t.timer = TUNING.mineSeconds; }
          } else if (t.phase === 'mine') {
            t.timer -= DT;
            if (t.timer <= 1e-6) {
              const g = Math.min(TUNING.carry, this.mineGold.get(this.mine.id)); this.mineGold.set(this.mine.id, this.mineGold.get(this.mine.id) - g);
              u.carry = 'gold'; u.amt = g; u.hidden = false; this.mineInside.delete(this.mine.id); t.phase = 'toDrop';
              const ring = this._ring(mineRect); // exit on the side facing the hall
              let best = ring[0], bd = Infinity; for (const i of ring) { const [x, y] = w.center(i), d = Math.hypot(x - this.hall.x, y - this.hall.y); if (d < bd) { bd = d; best = i; } }
              [u.x, u.y] = w.center(best); u.path = null;
            }
          } else if (t.phase === 'chop') {
            if (this.treeWood[t.tree] <= 0) { t.phase = u.amt ? 'toDrop' : 'toRes'; t.tree = null; continue; }
            t.timer -= DT;
            if (t.timer <= 1e-6) {
              t.timer += TUNING.chopSeconds; u.carry = 'wood'; u.amt += 1; this.treeWood[t.tree] -= 1;
              if (this.treeWood[t.tree] <= 0) { this._removeTree(t.tree); this.log.push({t: this.t, kind: 'tree', id: t.tree}); }
              if (u.amt >= TUNING.carry || this.treeWood[t.tree] <= 0) { t.phase = 'toDrop'; if (this.treeWood[t.tree] <= 0) t.tree = null; }
            }
          } else if (t.phase === 'toDrop') {
            const d = this.dropFor(u.carry || t.res, u);
            if (this.walk(u, this._ring(w.rectOf(d.x, d.y, d.tex)), 'drop' + d.id)) {
              if (u.carry === 'gold') this.gold += u.amt; else if (u.carry === 'wood') this.wood += u.amt;
              u.amt = 0; u.carry = null; t.phase = 'toRes';
            }
          }
        } else if (t.kind === 'build') {
          const e = t.ev, tex = w.buildingTex(e.btype);
          if (t.phase === 'toSite') {
            if (this.walk(u, this._ring(w.rectOf(e.site[0], e.site[1], tex)), 'site' + e.id)) t.phase = 'waitRes';
          }
          if (t.phase === 'waitRes' && e.rt.bid) t.phase = 'building'; // resuming an existing site
          if (t.phase === 'waitRes') {
            const c = w.eco[e.btype];
            if (this.gold >= c.gold && this.wood >= c.wood) {
              if (!this.canPlace(e.btype, e.site[0], e.site[1], []).ok) { e.rt.note = '工地被占用'; continue; }
              this.gold -= c.gold; this.wood -= c.wood;
              const b = this._addBuilding(e.btype, e.site[0], e.site[1], false, e);
              e.rt.bStart = this.t; e.rt.bid = b.id; t.phase = 'building';
            } else e.rt.note = '等待资源 金' + Math.floor(this.gold) + '/' + c.gold + ' 木' + Math.floor(this.wood) + '/' + c.wood;
          }
        }
      }
    }
    _construction() {
      for (const b of this.buildings) {
        if (b.done) continue;
        const c = this.w.eco[b.type], e = b.ev;
        // Human construction needs a peasant working on it; it pauses when the builder leaves.
        if (!this.units.some(u => u.task.kind === 'build' && u.task.ev === e && u.task.phase === 'building')) { e.rt.note = '暂停 ' + Math.floor(b.progress * 100) + '%：没有农民在建造'; continue; }
        b.progress += DT / c.time;
        e.rt.note = '建造中 ' + Math.min(99, Math.floor(b.progress * 100)) + '%';
        if (b.progress >= 1 - 1e-6) {
          b.progress = 1; b.done = true; this.foodCap = Math.min(100, this.foodCap + (c.foodMade || 0));
          Object.assign(e.rt, {status: 'done', aEnd: this.t, note: '完工'});
          const u = this.unit(e.rt.builder);
          if (u && u.task.kind === 'build' && u.task.ev === e) { u.task = this.gatherTask('gold'); u.path = null; }
        }
      }
    }
    counts() {
      const c = {gold: 0, wood: 0, build: 0, idle: 0};
      for (const u of this.workers()) { if (u.task.kind === 'gather') c[u.task.res]++; else if (u.task.kind === 'build') c.build++; else c.idle++; }
      return c;
    }
    mineGoldLeft() { return this.mineGold.get(this.mine.id); }
  }

  function segRectDist([a, b], r) {
    // distance between segment ab and rectangle r=[l,b,r,t]
    const inside = (x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    if (inside(...a) || inside(...b)) return 0;
    const segs = [[[r[0], r[1]], [r[2], r[1]]], [[r[2], r[1]], [r[2], r[3]]], [[r[2], r[3]], [r[0], r[3]]], [[r[0], r[3]], [r[0], r[1]]]];
    let m = Infinity;
    for (const [p, q] of segs) m = Math.min(m, segSegDist(a, b, p, q));
    return m;
  }
  function ptSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function segSegDist(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    if (o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)) return 0;
    return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
  }

  /* ---------------- plan helpers ---------------- */
  let seq = 0;
  function ev(kind, name, start, params) { return Object.assign({id: 'e' + (++seq), seq, kind, name, start, rt: null}, params); }
  function defaultPlan() {
    return [
      {id: 'g_open', name: '人族标准开局', src: '预设', open: true, children: [
        ev('build', '建造 国王祭坛 · 农民1', 0, {unit: 1, btype: 'halt'}),
        ev('build', '建造 农场 · 农民2', 0, {unit: 2, btype: 'hhou'}),
        ev('build', '建造 兵营 · 农民3', 1, {unit: 3, btype: 'hbar'}),
        ev('gather', '采金 · 农民4、5', 0, {units: [4, 5], res: 'gold'}),
        ev('train', '训练农民 → 采金', 0, {utype: 'hpea', then: 'gold'}),
      ]},
      {id: 'g_eco', name: '经济运营', src: '预设', open: false, children: [
        ev('train', '训练农民 → 伐木', 15, {utype: 'hpea', then: 'wood'}),
        ev('train', '训练农民 → 伐木', 30, {utype: 'hpea', then: 'wood'}),
        ev('train', '训练农民 → 采金', 45, {utype: 'hpea', then: 'gold'}),
        ev('build', '建造 农场', 50, {unit: null, btype: 'hhou'}),
        ev('train', '训练农民 → 伐木', 60, {utype: 'hpea', then: 'wood'}),
      ]},
      {id: 'g_army', name: '首发英雄与兵力', src: '预设', open: false, children: [
        ev('train', '训练 大法师', 62, {utype: 'Hamg'}),
        ev('train', '训练 步兵', 75, {utype: 'hfoo'}),
        ev('train', '训练 步兵', 95, {utype: 'hfoo'}),
      ]},
      {id: 'g_user', name: '我的指令', src: '手动', open: true, children: []},
      {id: 'g_ai', name: 'AI 指令', src: 'AI', open: true, children: []},
    ];
  }
  /* run a fresh game with these groups up to time t (deterministic replay) */
  function run(world, startIndex, groups, t) {
    const events = groups.flatMap(g => g.children);
    const game = new Game(world, {start: startIndex, events});
    game.planSites();
    while (game.t + 1e-9 < t) game.step();
    return game;
  }

  const api = {World, Game, run, ev, defaultPlan, TUNING, DT, KIND, RES, HALLS, decodeRows};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CommanderSim = api;
})(typeof globalThis === 'undefined' ? window : globalThis);
