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
  // Wall-in check. A unit needs a gap of floor(collision / 16) + 1 cells (assumption, to be checked
  // in the real game): collision 16-31 (peasant 16, footman 31) needs 2 cells, collision 32 (every
  // hero, grunt, rifleman; from wc3env reference-127a.json) needs 3. Buildings sit on a 64-unit grid,
  // so gaps between them are whole multiples of 2 cells: a 2-cell gap is the human wall.
  const WALL = {radius: 40, cap: 40, lane: 64, search: 14, worker: 2, hero: 3, farms: 4};
  const cellsFor = collision => Math.floor(collision / 16) + 1;
  const WALL_NATURAL_GAP = 576; // mine centre to expansion hall centre (assumption; the native solver places it in the game)
  // Power build: each extra builder adds 0.6x speed and 15% of the price (fits the 1-5 builder
  // table for a town hall: 180/113/82/64/53 s, 385/443/500/558/613 gold), to be checked in the game.
  const ASSIST = {speed: 0.6, cost: 0.15};
  const KIND = {build: '建造', gather: '采集', train: '生产', upgrade: '升级', learn: '技能', militia: '民兵', clear: '清野'};
  // Militia lasts 45 s (Call to Arms). Clearing is not simulated: once the army reaches the camp the
  // camp counts as cleared after e.est seconds (default CLEAR_EST), marked as an estimate.
  const MILITIA_SECONDS = 45, CLEAR_EST = 40;
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
      // the natural expansion: the closest other mine
      this.natural = w.mines.filter(m => m !== this.mine).sort((a, b) => Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy))[0];
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
    /* margin: gap kept from other planned buildings (automatic placement keeps 32 for walking
     * room; a site the player places, or a wall piece, may touch them: margin 0) */
    canPlace(type, x, y, reserved, margin = 32) {
      const w = this.w, tex = w.buildingTex(type), r = w.rectOf(x, y, tex), B = w.bounds;
      if (r[0] < B[0] || r[2] > B[1] || r[1] < B[2] || r[3] > B[3]) return {ok: false, why: '超出地图边界'};
      for (const i of w.cellsOf(x, y, tex, 'build')) if (this.noBuild(i)) return {ok: false, why: '地形、树木或建筑占用'};
      const [a, b] = this.lane();
      if (segRectDist([a, b], r) < 150) return {ok: false, why: '挡住采金路线'};
      for (const o of reserved || []) {
        const q = w.rectOf(o.x, o.y, w.buildingTex(o.type));
        if (r[0] < q[2] + margin && r[2] > q[0] - margin && r[1] < q[3] + margin && r[3] > q[1] - margin) return {ok: false, why: '与计划中的建筑重叠'};
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
    /* Max-min search on a window: clearance (largest empty square touching each free cell; beyond
     * the window counts as open ground), then the best path from starts to the window border.
     * Returns K, the clearance at the path's narrowest point, and that cell (-1 when shut). */
    _wayOut(solid, S, starts, cap) {
      const N = S * S, clr = new Uint8Array(N), tmp = new Uint8Array(N);
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
          const x = sx > 0 ? S - 1 - xx : xx, y = sy > 0 ? S - 1 - yy : yy, k = y * S + x;
          if (solid[k]) { tmp[k] = 0; continue; }
          const g = (X, Y) => X < 0 || Y < 0 || X >= S || Y >= S ? cap : tmp[Y * S + X];
          tmp[k] = Math.min(cap, 1 + Math.min(g(x + sx, y), g(x, y + sy), g(x + sx, y + sy)));
          if (tmp[k] > clr[k]) clr[k] = tmp[k];
        }
      }
      const best = new Int16Array(N).fill(-1), par = new Int32Array(N).fill(-1), seen = new Uint8Array(N);
      const buckets = Array.from({length: cap + 1}, () => []);
      for (const k of starts) if (clr[k]) { best[k] = clr[k]; buckets[clr[k]].push(k); }
      let K = 0, exit = -1;
      for (let b = cap; b >= 1 && exit < 0; b--) {
        const q = buckets[b];
        while (q.length) {
          const k = q.pop(); if (best[k] !== b || seen[k]) continue; seen[k] = 1;
          const x = k % S, y = (k - x) / S;
          if (x === 0 || y === 0 || x === S - 1 || y === S - 1) { K = b; exit = k; break; }
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
            const n = Y * S + X, v = Math.min(b, clr[n]);
            if (v > best[n]) { best[n] = v; par[n] = k; buckets[v].push(n); }
          }
        }
      }
      let m = -1; // narrowest cell on that path, ignoring the window margin
      for (let k = exit; k >= 0; k = par[k]) { const x = k % S, y = (k - x) / S; if (x > 2 && y > 2 && x < S - 3 && y < S - 3 && (m < 0 || clr[k] < clr[m])) m = k; }
      return {K, choke: m >= 0 ? m : exit, clr};
    }

    /* ---------- wall-in check ----------
     * Can a unit walk from outside to the peasants on the mining route? Inside a square window
     * around the hall (the hall itself is part of the wall), every
     * free cell gets the side of the largest empty square touching it (clearance); a max-min
     * search from the mining route to the window border then gives K, the clearance at
     * the narrowest point of the best way out, and that point (the choke). Grid cells are 32
     * units; see WALL for how many cells peasants (K >= 2) and heroes (K >= 3) need.
     * opts.sites: planned buildings [{type, x, y}] counted as solid; opts.radius in cells;
     * opts.gaps: how many gap widths to report in .gaps (widest first); opts.area: also count
     * .inside, the free cells enclosed with the mining route (null when not enclosed). */
    wallCheck(opts) {
      const o = opts || {}, w = this.w, W = w.W, R = o.radius || WALL.radius, cap = WALL.cap;
      const hc = w.cellAt(this.hall.x, this.hall.y), hx = hc % W, hy = (hc - hx) / W;
      const x0 = hx - R, y0 = hy - R, S = 2 * R + 1, N = S * S;
      const solid = new Uint8Array(N), extra = new Set();
      for (const s of o.sites || []) for (const i of w.cellsOf(s.x, s.y, w.buildingTex(s.type), 'walk')) extra.add(i);
      const gi = (x, y) => (y0 + y) * W + x0 + x; // window cell -> grid cell
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = gi(x, y); solid[y * S + x] = x0 + x < 0 || y0 + y < 0 || x0 + x >= W || y0 + y >= w.H || this.blocked(i) || extra.has(i) ? 1 : 0; }
      // start: the free cells on the mining route between hall and mine, where the peasants walk
      const [la, lb] = this.lane(), lane = [];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (ptSeg(w.center(gi(x, y)), la, lb) <= WALL.lane) lane.push(y * S + x);
      const starts = lane.filter(k => !solid[k]);
      // Gap widths, widest first: find the best way out, note its narrowest point, close that gap
      // and look again. Comparing several gaps lets the greedy wall see progress when it narrows
      // one of two equally wide gaps.
      const gaps = [], blocked = solid.slice();
      let K = 0, choke = null;
      for (let n = 0; n < (o.gaps || 1); n++) {
        const r = this._wayOut(blocked, S, starts, cap);
        gaps.push(r.K);
        if (n === 0) { K = r.K; if (r.choke >= 0) choke = w.center(gi(r.choke % S, (r.choke - r.choke % S) / S)); }
        if (!r.K || r.choke < 0) break;
        const cx = r.choke % S, cy = (r.choke - cx) / S, h = r.K + 1;
        for (let y = Math.max(0, cy - h); y <= Math.min(S - 1, cy + h); y++) for (let x = Math.max(0, cx - h); x <= Math.min(S - 1, cx + h); x++) blocked[y * S + x] = 1;
      }
      // room inside the wall: cells a hero-sized unit reaches from the mining route (a gap narrower
      // than WALL.hero stops the flood); null when that reaches the window edge (not walled)
      let inside = null;
      if (o.area) {
        const clr = this._wayOut(solid, S, starts, cap).clr, seen = new Uint8Array(N), q = starts.filter(k => clr[k] >= WALL.hero);
        for (const k of q) seen[k] = 1;
        let open = false;
        for (let h = 0; h < q.length && !open; h++) {
          const k = q[h], x = k % S, y = (k - x) / S;
          if (x === 0 || y === 0 || x === S - 1 || y === S - 1) open = true;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const n = Y * S + X; if (!seen[n] && clr[n] >= WALL.hero) { seen[n] = 1; q.push(n); } }
        }
        inside = open ? null : q.length;
      }
      // workers must still reach the gold mine from the hall
      const mineCells = new Set(this._ring(w.rectOf(this.mine.x, this.mine.y, this.mine.tex)).filter(i => !extra.has(i)));
      const reach = new Uint8Array(N), q2 = starts.filter(k => !solid[k]); let mineOK = false;
      for (const k of q2) reach[k] = 1;
      for (let h = 0; h < q2.length && !mineOK; h++) {
        const k = q2[h], x = k % S, y = (k - x) / S;
        if (mineCells.has(gi(x, y))) { mineOK = true; break; }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= S || Y >= S) continue; const n = Y * S + X; if (!reach[n] && !solid[n]) { reach[n] = 1; q2.push(n); } }
      }
      return {K, gaps, choke, mineOK, inside, radius: R, box: [w.ox + x0 * w.C, w.oy + y0 * w.C, w.ox + (x0 + S) * w.C, w.oy + (y0 + S) * w.C],
              verdict: K < WALL.worker ? 'sealed' : K < WALL.hero ? 'walled' : 'open'};
    }

    /* where an expansion hall goes: beside the natural mine, on the side facing home */
    naturalAnchor() {
      const m = this.natural, dx = this.hall.x - m.x, dy = this.hall.y - m.y, d = Math.hypot(dx, dy) || 1;
      return [m.x + dx / d * WALL_NATURAL_GAP, m.y + dy / d * WALL_NATURAL_GAP];
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
          const [x, y] = this.w.snap(e.btype, e.at[0], e.at[1]), chk = this.canPlace(e.btype, x, y, reserved, 0);
          if (chk.ok) site = [x, y]; else e.siteNote = '指定位置不能建（' + chk.why + '），改到旁边';
        }
        if (!site) { const [ax, ay] = e.at || (e.near === 'natural' ? this.naturalAnchor() : this.anchor(e.btype, nth.get(e) - 1)); site = this.findSite(e.btype, ax, ay, reserved); }
        e.site = site;
        if (site) reserved.push({type: e.btype, x: site[0], y: site[1]});
      }
    }
    unit(id) { return this.units.find(u => u.id === id); }
    workers() { return this.units.filter(u => u.type === 'hpea'); }
    /* peasants named by events that have not started yet: automatic picks leave them alone, or a
     * 0:00 farm would take peasant 3 just before the 0:01 barracks event calls for him */
    reserved() {
      const ids = new Set();
      for (const e of this.events) if (e.rt.status === 'pending') { if (e.unit) ids.add(e.unit); for (const id of e.units || []) ids.add(id); }
      return ids;
    }
    pickWorkers(n, res, mine) {
      const elsewhere = u => u.task.res !== res || (res === 'gold' && u.task.mine !== (mine || this.mine)); // other resource or other mine
      const sc = u => u.task.kind === 'idle' ? 0 : u.task.kind === 'gather' && elsewhere(u) ? 1 : 9, held = this.reserved();
      return this.workers().filter(u => u.task.kind !== 'build' && sc(u) < 9 && !held.has(u.id)).sort((a, b) => sc(a) - sc(b) || a.id - b.id).slice(0, n);
    }
    pickBuilder(site) {
      const held = this.reserved(), pool = this.workers().filter(u => u.task.kind !== 'build' && !u.hidden && !held.has(u.id));
      pool.sort((a, b) => (a.task.kind === 'idle' ? 0 : 1) - (b.task.kind === 'idle' ? 0 : 1) || (a.task.res === 'gold' ? 0 : 1) - (b.task.res === 'gold' ? 0 : 1) || a.amt - b.amt ||
        (site ? Math.hypot(a.x - site[0], a.y - site[1]) - Math.hypot(b.x - site[0], b.y - site[1]) : 0) || a.id - b.id);
      return pool[0] || null;
    }
    gatherTask(res, mine) { return {kind: 'gather', res, phase: 'toRes', mine: res === 'gold' ? mine || this.mine : null}; }
    mineOf(where) { return where === 'natural' ? this.natural : this.mine; }
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
        const us = e.units ? e.units.map(id => this.unit(id)).filter(Boolean) : this.pickWorkers(e.count || 1, e.res, e.res === 'gold' ? this.mineOf(e.mine) : null);
        if (!us.length) { rt.note = '没有可分配的农民'; return; }
        const m = e.res === 'gold' ? this.mineOf(e.mine) : null;
        for (const u of us) if (!(u.task.kind === 'gather' && u.task.res === e.res && u.task.mine === m)) { u.task = this.gatherTask(e.res, m); u.path = null; }
        Object.assign(rt, {status: 'active', aStart: this.t, note: '农民' + us.map(u => u.id).join('、') + ' ' + RES[e.res] + '中'});
      } else if (e.kind === 'train') {
        const ut = e.utype || 'hpea';
        const prods = this.buildings.filter(b => b.done && (this.w.eco[b.type].trains || []).includes(ut));
        if (!prods.length) { rt.note = '还没有能生产' + this.w.eco[ut].name + '的建筑'; return; }
        const p = prods.sort((a, b) => this.qlen(a) - this.qlen(b))[0];
        if (!this.queues.has(p.id)) this.queues.set(p.id, {cur: null, q: []});
        this.queues.get(p.id).q.push(e);
        Object.assign(rt, {status: 'waiting', aStart: this.t, note: '排队中 · ' + this.w.eco[p.type].name, producer: p.id});
      } else if (e.kind === 'learn') {
        const hero = this.units.find(u => u.type === (e.hero || 'Hamg'));
        if (!hero) { rt.note = '等' + this.w.eco[e.hero || 'Hamg'].name + '出生'; return; }
        Object.assign(rt, {status: 'done', aStart: this.t, aEnd: this.t, note: this.w.eco[hero.type].name + '学会 ' + (e.abilityName || e.ability)});
      } else if (e.kind === 'militia') {
        // e.count peasants from e.from (default wood) answer Call to Arms for MILITIA_SECONDS
        const pool = this.workers().filter(u => !u.hidden && u.task.kind === 'gather' && !this.reserved().has(u.id))
          .sort((a, b) => (a.task.res === (e.from || 'wood') ? 0 : 1) - (b.task.res === (e.from || 'wood') ? 0 : 1) || a.id - b.id);
        const us = pool.slice(0, e.count || 4);
        if (!us.length) { rt.note = '没有能敲钟的农民'; return; }
        // as in the game (native probe 2026-10-19): the peasant walks to the town hall, changes there, and the 45 s start then
        for (const u of us) { u.task = {kind: 'militia', phase: 'toHall', until: Infinity, prev: u.task, ev: e}; u.path = null; }
        Object.assign(rt, {status: 'active', aStart: this.t, note: '民兵 ' + us.map(u => u.id).join('、') + '（45 秒）', militia: us.map(u => u.id)});
      } else if (e.kind === 'clear') {
        // army: heroes and footmen, plus the militia of e.militia (an event id); target: the natural
        const mil = e.militia && this.events.find(x => x.id === e.militia);
        if (mil && mil.rt.status === 'pending') { rt.note = '等「' + mil.name + '」'; return; }
        if (mil && this.units.some(u => (mil.rt.militia || []).includes(u.id) && u.task.kind === 'militia' && u.task.phase === 'toHall')) { rt.note = '等民兵在城镇大厅变身'; return; }
        const army = this.units.filter(u => /^[A-Z]/.test(u.type) || u.type === 'hfoo' || (mil && mil.rt.militia && mil.rt.militia.includes(u.id) && u.task.kind === 'militia'));
        if (!army.some(u => /^[A-Z]/.test(u.type))) { rt.note = '等英雄出生'; return; }
        const camp = this.natural, ring = this._ring(this.w.rectOf(camp.x, camp.y, camp.tex));
        for (const u of army) { u.task = {kind: 'march', goals: ring, key: 'camp' + e.id, ev: e, prev: u.task}; u.path = null; }
        Object.assign(rt, {status: 'running', aStart: this.t, note: '部队前往分矿（' + army.length + ' 个单位）', army: army.map(u => u.id), est: e.est || CLEAR_EST});
      } else if (e.kind === 'upgrade') {
        // e.to: target type; e.from (optional): which kind of building; e.at (optional): which one
        const eco = this.w.eco, can = b => b.done && (eco[b.type].upgrades || []).includes(e.to) && (!e.from || b.type === e.from);
        let opts = this.buildings.filter(can);
        if (e.at) opts = opts.filter(b => Math.hypot(b.x - e.at[0], b.y - e.at[1]) < 64);
        opts = opts.filter(b => ![...this.queues.values()].some(Q => [Q.cur && Q.cur.ev, ...Q.q].some(x => x && x.kind === 'upgrade' && x.rt.producer === b.id)));
        if (!opts.length) { rt.note = '没有可以升级成' + eco[e.to].name + '的建筑'; return; }
        const p = opts.sort((a, b) => this.qlen(a) - this.qlen(b))[0];
        if (!this.queues.has(p.id)) this.queues.set(p.id, {cur: null, q: []});
        this.queues.get(p.id).q.push(e);
        Object.assign(rt, {status: 'waiting', aStart: this.t, note: '排队中 · ' + eco[p.type].name, producer: p.id});
      }
    }
    /* what an upgrade still costs: the target's price minus what the building already cost */
    upgradeCost(b, to) { const e = this.w.eco; return [e[to].gold - e[b.type].gold, e[to].wood - e[b.type].wood]; }
    qlen(b) { const q = this.queues.get(b.id); return q ? q.q.length + (q.cur ? 1 : 0) : 0; }
    heroCount() { return this.units.filter(u => /^[A-Z]/.test(u.type)).length; }
    costOf(ut) {
      const e = this.w.eco[ut];
      if (/^[A-Z]/.test(ut) && this.heroCount() === 0 && !this._heroQueued && this.w.D.economy.assumptions.first_hero_free) return [0, 0, e.food];
      return [e.gold, e.wood, e.food];
    }

    /* e.after names an event this one waits for: it starts at its planned time or when that event
     * is finished (built, trained, upgraded, cleared; gathering counts once it has begun), whichever
     * is later. A missing event (deleted) no longer holds it back. */
    ready(e) {
      if (!e.after) return true;
      const d = this.events.find(x => x.id === e.after);
      if (!d) { e.rt.note = '依赖的事件已删除，按时间开始'; return true; }
      if (finished(d)) return true;
      e.rt.note = '等「' + d.name + '」完成';
      return false;
    }
    step() {
      const due = this.events.filter(e => e.rt.status === 'pending' && e.start <= this.t + 1e-9 && this.ready(e)).sort((a, b) => a.start - b.start || a.seq - b.seq);
      for (const e of due) this.tryStart(e);
      this._production(); this._units(); this._construction(); this._clearing();
      this.t = Math.round((this.t + DT) * 10) / 10;
    }
    _production() {
      for (const b of this.buildings) {
        const Q = this.queues.get(b.id); if (!Q) continue;
        if (Q.cur) {
          Q.cur.left -= DT; const e = Q.cur.ev;
          e.rt.note = (e.kind === 'upgrade' ? '升级中 ' : '训练中 ') + Math.ceil(Math.max(0, Q.cur.left)) + '秒';
          if (Q.cur.left <= 1e-6 && e.kind === 'upgrade') { // the building becomes the new type in place
            const from = b.type; b.type = e.to; b.tex = this.w.buildingTex(e.to) || b.tex;
            this.foodCap = Math.min(100, this.foodCap - (this.w.eco[from].foodMade || 0) + (this.w.eco[e.to].foodMade || 0));
            Object.assign(e.rt, {status: 'done', aEnd: this.t, note: this.w.eco[from].name + '升级为' + this.w.eco[e.to].name});
            Q.cur = null;
          } else if (Q.cur.left <= 1e-6) {
            const ut = e.utype || 'hpea', {dir} = this.basis, half = this.w.tex(b.tex).w * 16;
            const u = {id: this.nextId++, type: ut, x: b.x + dir[0] * (half + 40), y: b.y + dir[1] * (half + 40), task: {kind: 'idle'}, carry: null, amt: 0, path: null, hidden: false};
            this._unstick(u); this.units.push(u);
            if (ut === 'hpea') u.task = e.then === 'natural' ? this.gatherTask('gold', this.natural) : this.gatherTask(e.then || 'gold');
            Object.assign(e.rt, {status: 'done', aEnd: this.t, note: this.w.eco[ut].name + u.id + ' 出生' + (ut === 'hpea' ? ' → ' + (e.then === 'natural' ? '分矿采金' : RES[e.then || 'gold']) : '')});
            Q.cur = null;
          }
        }
        if (!Q.cur && Q.q.length && Q.q[0].kind === 'upgrade') {
          const e = Q.q[0], [g, l] = this.upgradeCost(b, e.to);
          const missing = (this.w.eco[e.to].requires || []).filter(r => !this.buildings.some(b => b.done && b.type === r));
          if (missing.length) e.rt.note = '需要 ' + missing.map(r => this.w.eco[r] ? this.w.eco[r].name : r).join('、');
          else if (this.gold < g || this.wood < l) e.rt.note = '等待资源 金' + Math.floor(this.gold) + '/' + g + ' 木' + Math.floor(this.wood) + '/' + l;
          else {
            this.gold -= g; this.wood -= l; Q.q.shift();
            Q.cur = {ev: e, left: this.w.eco[e.to].time, total: this.w.eco[e.to].time};
            Object.assign(e.rt, {status: 'running', trainStart: this.t, note: '升级中'});
          }
        } else if (!Q.cur && Q.q.length) {
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
      const w = this.w;
      const tgt = new Map(); for (const u of this.units) if (u.task.tree != null) tgt.set(u.task.tree, (tgt.get(u.task.tree) || 0) + 1);
      for (const u of this.units) {
        const t = u.task;
        if (t.kind === 'militia') {
          if (t.phase === 'toHall') {
            const hall = this.dropFor('gold', u);
            if (this.walk(u, this._ring(w.rectOf(hall.x, hall.y, hall.tex)), 'hall' + hall.id)) { t.phase = 'armed'; t.until = this.t + MILITIA_SECONDS; u.type = 'hmil'; }
          } else if (this.t >= t.until - 1e-9) this._unmilitia(u);
          continue;
        }
        if (t.kind === 'idle' && t.resume && this.t - t.since >= 3) { u.task = this.gatherTask(t.resume.res, t.resume.mine); continue; }
        if (t.kind === 'march') {
          const mil = t.prev && t.prev.kind === 'militia' ? t.prev : null;
          if (mil && this.t >= mil.until - 1e-9) { this._unmilitia(u, mil); continue; } // time up: a peasant again, out of the fight
          if (this.walk(u, t.goals, t.key)) t.arrived = true;
          continue;
        }
        if (t.kind === 'gather') {
          if (t.phase === 'toRes') {
            if (u.amt > 0 && u.carry !== t.res) { t.phase = 'toDrop'; continue; }
            if (u.amt >= TUNING.carry) { t.phase = 'toDrop'; continue; }
            if (t.res === 'gold') {
              const m = t.mine || this.mine;
              if (this.walk(u, this._ring(w.rectOf(m.x, m.y, m.tex)), 'mine' + m.id)) t.phase = 'queue';
            } else {
              if (t.tree == null || this.treeWood[t.tree] <= 0) { const d = this.dropFor('wood', u); t.tree = this.nearestTree(d.x, d.y, tgt); if (t.tree < 0) { u.task = {kind: 'idle'}; continue; } tgt.set(t.tree, (tgt.get(t.tree) || 0) + 1); u.path = null; }
              const tr = w.trees[t.tree];
              if (this.walk(u, this._ring(w.rectOf(tr.x, tr.y, w.D.treeTex)), 'tree' + t.tree)) { t.phase = 'chop'; t.timer = TUNING.chopSeconds; }
            }
          } else if (t.phase === 'queue') {
            const m = t.mine || this.mine, inside = this.mineInside.get(m.id);
            if (inside == null && this.mineGold.get(m.id) > 0) { this.mineInside.set(m.id, u.id); u.hidden = true; t.phase = 'mine'; t.timer = TUNING.mineSeconds; }
          } else if (t.phase === 'mine') {
            t.timer -= DT;
            if (t.timer <= 1e-6) {
              const m = t.mine || this.mine, g = Math.min(TUNING.carry, this.mineGold.get(m.id)); this.mineGold.set(m.id, this.mineGold.get(m.id) - g);
              u.carry = 'gold'; u.amt = g; u.hidden = false; this.mineInside.delete(m.id); t.phase = 'toDrop';
              const drop = this.dropFor('gold', m), ring = this._ring(w.rectOf(m.x, m.y, m.tex)); // exit on the side facing the drop-off
              let best = ring[0], bd = Infinity; for (const i of ring) { const [x, y] = w.center(i), d = Math.hypot(x - drop.x, y - drop.y); if (d < bd) { bd = d; best = i; } }
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
          if (t.phase === 'waitRes' && e.rt.bid && t.helper) { // a power-build helper pays its share on arrival
            const c = w.eco[e.btype], g = Math.round(c.gold * ASSIST.cost), l = Math.round(c.wood * ASSIST.cost);
            if (this.gold >= g && this.wood >= l) { this.gold -= g; this.wood -= l; t.phase = 'building'; }
            continue;
          }
          if (t.phase === 'waitRes' && e.rt.bid) t.phase = 'building'; // resuming an existing site
          if (t.phase === 'waitRes') {
            const c = w.eco[e.btype];
            if (this.gold >= c.gold && this.wood >= c.wood) {
              if (!this.canPlace(e.btype, e.site[0], e.site[1], []).ok) { e.rt.note = '工地被占用'; continue; }
              this.gold -= c.gold; this.wood -= c.wood;
              const b = this._addBuilding(e.btype, e.site[0], e.site[1], false, e);
              e.rt.bStart = this.t; e.rt.bid = b.id; t.phase = 'building';
              if (e.helpers) this._sendHelpers(e, u);
            } else e.rt.note = '等待资源 金' + Math.floor(this.gold) + '/' + c.gold + ' 木' + Math.floor(this.wood) + '/' + c.wood;
          }
        }
      }
    }
    /* e.helpers more peasants join a construction once it has started (power build) */
    _sendHelpers(e, builder) {
      const held = this.reserved();
      const pool = this.workers().filter(u => u !== builder && (u.task.kind === 'gather' || u.task.kind === 'idle') && !u.hidden && !held.has(u.id))
        .sort((a, b) => (a.task.kind === 'idle' ? 0 : 1) - (b.task.kind === 'idle' ? 0 : 1) || Math.hypot(a.x - e.site[0], a.y - e.site[1]) - Math.hypot(b.x - e.site[0], b.y - e.site[1]));
      for (const u of pool.slice(0, e.helpers)) { u.task = {kind: 'build', ev: e, phase: 'toSite', helper: true}; u.path = null; }
    }
    _construction() {
      for (const b of this.buildings) {
        if (b.done) continue;
        const c = this.w.eco[b.type], e = b.ev;
        // Human construction needs a peasant working on it; it pauses when the builders leave. Each
        // extra builder speeds it up (ASSIST).
        const crew = this.units.filter(u => u.task.kind === 'build' && u.task.ev === e && u.task.phase === 'building');
        if (!crew.length) { e.rt.note = '暂停 ' + Math.floor(b.progress * 100) + '%：没有农民在建造'; continue; }
        b.progress += DT / c.time * (1 + ASSIST.speed * (crew.length - 1));
        const waiting = this.units.filter(u => u.task.kind === 'build' && u.task.ev === e && u.task.helper && u.task.phase === 'waitRes').length;
        e.rt.note = '建造中 ' + Math.min(99, Math.floor(b.progress * 100)) + '%' + (crew.length > 1 ? ' · ' + crew.length + ' 人' : '') + (waiting ? ' · ' + waiting + ' 人等资源协助' : '');
        if (b.progress >= 1 - 1e-6) {
          b.progress = 1; b.done = true; this.foodCap = Math.min(100, this.foodCap + (c.foodMade || 0));
          Object.assign(e.rt, {status: 'done', aEnd: this.t, note: '完工'});
          // then: 'natural' (mine there), 'wood' (chop), otherwise back to the main mine
          for (const u of this.units) if (u.task.kind === 'build' && u.task.ev === e) {
            u.task = e.then === 'wood' ? this.gatherTask('wood') : this.gatherTask('gold', this.mineOf(e.then === 'natural' ? 'natural' : 'main')); u.path = null;
          }
        }
      }
    }
    /* militia time is up: a peasant again where he stands, free for a builder for a few seconds,
     * then back to his old job */
    _unmilitia(u, mil) {
      const m = mil || u.task;
      u.type = 'hpea'; u.path = null;
      u.task = m.prev && m.prev.kind === 'gather' ? {kind: 'idle', resume: m.prev, since: this.t} : {kind: 'idle'};
      const e = m.ev;
      if (e && e.rt.status === 'active' && !this.units.some(x => x.type === 'hmil' && (e.rt.militia || []).includes(x.id)))
        Object.assign(e.rt, {status: 'done', aEnd: this.t, note: '民兵已变回农民'});
    }
    /* clear events: the camp counts as cleared e.est seconds after the first unit arrives */
    _clearing() {
      for (const e of this.events) {
        if (e.kind !== 'clear' || e.rt.status !== 'running') continue;
        const army = this.units.filter(u => u.task.kind === 'march' && u.task.ev === e);
        if (e.rt.fightStart == null) {
          if (army.some(u => u.task.arrived)) { e.rt.fightStart = this.t; }
          else continue;
        }
        const left = e.rt.est - (this.t - e.rt.fightStart);
        e.rt.note = '清野中（模拟估计）' + Math.max(0, Math.ceil(left)) + '秒';
        if (left <= 1e-6) {
          Object.assign(e.rt, {status: 'done', aEnd: this.t, note: '清完（模拟估计 ' + e.rt.est + ' 秒，不模拟战斗）'});
          for (const u of army) {
            const mil = u.task.prev && u.task.prev.kind === 'militia' ? u.task.prev : null;
            if (mil && this.t >= mil.until - 1e-9) this._unmilitia(u, mil);
            else u.task = mil || {kind: 'idle'}; // militia stay until their time is up; heroes and footmen wait there
          }
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

  const finished = e => !!e.rt && (e.rt.status === 'done' || (e.kind === 'gather' && e.rt.status === 'active'));

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
  /* after loading a saved plan: new events must not reuse its ids (e14 ...) */
  function syncSeq(events) { for (const e of events) seq = Math.max(seq, e.seq || 0, +(String(e.id).match(/^e(\d+)$/) || [0, 0])[1]); }
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
  /* Greedy wall-in (after warcraft-commander/commander/layout.js auto 'wall'): take the earliest
   * altar, barracks and up to WALL.farms farms that are not pinned, and one by one
   * put each one where it narrows the way to the mining route the most (nearest the choke on ties),
   * never below what peasants need (WALL.worker) and never cutting the hall off from the mine.
   * Returns the sites to pin ({e, pos}) and the check before and after; changes nothing itself. */
  function autoWall(world, startIndex, groups, opts) {
    const g = run(world, startIndex, groups, 0), w = world;
    const builds = g.events.filter(e => e.kind === 'build' && !e.resume && e.site).sort((a, b) => a.start - b.start || a.seq - b.seq);
    const skip = (opts && opts.skip) || new Set(); // events that may not move (already started)
    const free = builds.filter(e => !e.at && !skip.has(e.id)), take = (t, n) => free.filter(e => e.btype === t).slice(0, n);
    const pieces = [...take('halt', 1), ...take('hbar', 1), ...take('hhou', WALL.farms)];
    const fixed = builds.filter(e => !pieces.includes(e)).map(e => ({type: e.btype, x: e.site[0], y: e.site[1]}));
    const siteOf = (e, pos) => ({type: e.btype, x: pos[0], y: pos[1]});
    const GAPS = 3, vec = c => c.gaps.concat(Array(GAPS).fill(0)).slice(0, GAPS);
    const less = (a, b) => { for (let i = 0; i < GAPS; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
    const before = g.wallCheck({sites: builds.map(e => siteOf(e, e.site)), gaps: GAPS});
    // compare gap widths widest first (padded), so narrowing either of two equal gaps counts
    function greedy(order) {
      const placed = [], sites = () => fixed.concat(placed.map(p => siteOf(p.e, p.pos)));
      for (const e of order) {
        const cur = g.wallCheck({sites: sites(), gaps: GAPS});
        if (cur.K < WALL.hero || !cur.choke) break;
        const [cx, cy] = w.snap(e.btype, g.hall.x, g.hall.y), here = sites();
        let best = null;
        for (let dy = -WALL.search; dy <= WALL.search; dy++) for (let dx = -WALL.search; dx <= WALL.search; dx++) {
          const x = cx + dx * 64, y = cy + dy * 64;
          if (!g.canPlace(e.btype, x, y, here, 0).ok) continue;
          const c = g.wallCheck({sites: here.concat([{type: e.btype, x, y}]), gaps: GAPS});
          if (c.K < WALL.worker || !c.mineOK) continue;
          const v = vec(c), d = Math.hypot(x - cur.choke[0], y - cur.choke[1]);
          if (!best || less(v, best.v) || (!less(best.v, v) && d < best.d)) best = {pos: [x, y], v, d};
        }
        if (best && less(best.v, vec(cur))) placed.push({e, pos: best.pos});
      }
      // pieces left over keep their automatic sites
      const after = g.wallCheck({gaps: GAPS, sites: sites().concat(pieces.filter(e => !placed.some(p => p.e === e)).map(e => siteOf(e, e.site)))});
      return {placed, after};
    }
    // two piece orders (biggest first, farms first); keep the narrowest result
    const size = e => w.tex(w.buildingTex(e.btype)).w, bySize = [...pieces].sort((a, b) => size(b) - size(a) || a.start - b.start);
    const orders = [bySize, [...bySize].reverse()];
    let best = null;
    for (const o of orders) {
      const r = greedy(o);
      if (!best || less(vec(r.after), vec(best.after)) || (!less(vec(best.after), vec(r.after)) && r.placed.length < best.placed.length)) best = r;
      if (best.after.K < WALL.hero) break;
    }
    return {placed: best.placed, before, after: best.after, pieces: pieces.length};
  }

  /* A checkpoint from a strategy: {id, name, event, at: 'end' | 'start', from, to} (seconds).
   * 'start' is when the work itself began (construction, training or upgrade, otherwise the event's
   * start); 'end' is when it finished. Result: ok | early | late (by .by s) | missed | pending. */
  function checkpoint(cp, events, t) {
    const e = events.find(x => x.id === cp.event);
    if (!e) return {state: 'missing', note: '计划里没有这个事件'};
    const rt = e.rt || {}, v = cp.at === 'start' ? rt.bStart ?? rt.trainStart ?? (rt.status !== 'pending' ? rt.aStart : null) : (rt.status === 'done' && !rt.failed ? rt.aEnd : null);
    if (v == null) return t > cp.to ? {state: 'missed'} : {state: 'pending'};
    if (cp.from != null && v < cp.from) return {state: 'early', value: v, by: cp.from - v};
    if (v <= cp.to) return {state: 'ok', value: v};
    return {state: 'late', value: v, by: v - cp.to};
  }

  /* run a fresh game with these groups up to time t (deterministic replay) */
  function run(world, startIndex, groups, t) {
    const events = groups.flatMap(g => g.children);
    const game = new Game(world, {start: startIndex, events});
    game.planSites();
    while (game.t + 1e-9 < t) game.step();
    return game;
  }

  const api = {World, Game, run, autoWall, checkpoint, WALL, cellsFor, ev, syncSeq, defaultPlan, TUNING, DT, KIND, RES, HALLS, decodeRows};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CommanderSim = api;
})(typeof globalThis === 'undefined' ? window : globalThis);
