// The budget model (web/budget.js): the shipped tactic script turned into its timeline by arithmetic.
// node --test web/tests/budget.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
global.window = {};
require(path.join(ROOT, 'web', 'data', 'lost-temple.js'));
const D = window.LT_DATA;
const Budget = require(path.join(ROOT, 'web', 'budget.js'));
const SCRIPT = fs.readFileSync(path.join(ROOT, 'strategies', '战术脚本-人族速矿二本.txt'), 'utf8');
const NAMES = ['南方', '西方', '北方', '东方'];

function budget(text = SCRIPT, start = 0, rates) {
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies', `人族速矿二本 · ${NAMES[start]}.json`), 'utf8'));
  const s = D.starts[start], hall = [s.x, s.y];
  const mine = D.mines.map(m => [m.x, m.y]).sort((a, b) => Math.hypot(a[0] - hall[0], a[1] - hall[1]) - Math.hypot(b[0] - hall[0], b[1] - hall[1]))[0];
  const m = Budget.fromText(text);
  const places = Budget.resolvePlaces(m.positions, (plan.plan || plan).groups, hall, Budget.NATURALS[start]);
  return Budget.run({eco: D.economy.units, start, hall, mine, lanes: m.lanes, reserves: m.reserves, places, rates});
}
const lane = (r, label) => r.timeline.lanes.find(l => l.label === label);
const step = (r, label, k) => lane(r, label).steps[k];

test('the shipped script, south: the opening lands where the fake game put it', () => {
  const t0 = Date.now(), r = budget();
  assert.ok(Date.now() - t0 < 500, 'a few milliseconds, not a game');
  const altar = step(r, '农民4', 0), hero = step(r, '国王祭坛', 1), hall = step(r, '农民8', 6), keep = step(r, '城镇大厅', 14);
  assert.ok(altar.done >= 60 && altar.done <= 70, 'altar ' + altar.done);
  assert.ok(hero.done >= 115 && hero.done <= 125, 'hero ' + hero.done);
  assert.ok(hall.work >= 210 && hall.work <= 260, 'natural hall begins ' + hall.work);
  assert.ok(hall.done <= 330, 'natural hall stands ' + hall.done);
  assert.ok(keep.done != null && keep.done <= 510, 'keep ' + keep.done);
  assert.deepStrictEqual(altar.at, r.timeline.places['祭坛'], 'built on the layout\'s altar site');
});

test('conditions: tags begun / done, the hero, the clear', () => {
  const r = budget();
  const hallBegins = step(r, '农民8', 6).work;
  assert.strictEqual(step(r, '农民9', 6).start, hallBegins, '协助 begins when #分基地 begins');
  assert.ok(step(r, '城镇大厅', 14).start >= hallBegins, 'the keep waits for #分基地 to begin');
  assert.strictEqual(step(r, '国王祭坛', 2).start, step(r, '城镇大厅', 14).done, '山丘之王 waits for #主城 to be done');
  assert.ok(step(r, '兵营', 0).start >= step(r, '国王祭坛', 1).done, '集结点 大法师 waits for him');
  const clear = step(r, '大法师', 2);
  assert.strictEqual(step(r, '农民9', 4).start, clear.done, 'the militia go on once the clear is done');
  assert.ok(step(r, '农民8', 4).start >= clear.done, 'building waits until he is a peasant again');
});

test('assist makes the build faster', () => {
  const r = budget(), alone = budget(SCRIPT.replace(/→ \[#分基地 开工\] 协助 #分基地 /, '→ '));
  const took = x => step(x, '农民8', 6).done - step(x, '农民8', 6).work;
  assert.ok(took(r) < took(alone) * 0.6, `${took(r)} with helpers vs ${took(alone)}`);
});

test('×N trains them one after another, each paying and eating food', () => {
  const r = budget(), foot = step(r, '兵营', 1);
  assert.ok(foot.done - foot.work >= 6 * 20, 'six footmen take six training times at least');
  assert.strictEqual(Object.values(r.timeline.units).filter(t => t === 'hfoo').length, 6);
});

test('a paused lane has no times and does not play', () => {
  const r = budget(SCRIPT.replace('农民21：', '#⏸ 农民21：'));
  const l = lane(r, '农民21');
  assert.ok(l.muted);
  assert.ok(l.steps.every(s => s.start == null));
  assert.ok(!r.frames[599].buildings.some(b => b.type === 'hvlt'), 'no vault');
});

test('frames: one a second, money never below zero, units and buildings placed', () => {
  const r = budget();
  assert.strictEqual(r.frames.length, 601);
  assert.deepStrictEqual(r.frames.slice(0, 3).map(f => f.t), [0, 1, 2]);
  assert.ok(r.frames.every(f => f.gold >= 0 && f.wood >= 0 && f.foodUsed <= f.foodCap));
  const f = r.frames[300];
  assert.ok(f.units.length > 15 && f.units.every(u => Number.isFinite(u.x) && Number.isFinite(u.y)));
  assert.ok(f.buildings.some(b => b.type === 'halt' && b.done));
});

test('faster income moves the timeline earlier (live rates go in here)', () => {
  const slow = budget(SCRIPT, 0, {gold: 1.0}), fast = budget(SCRIPT, 0, {gold: 2.4});
  assert.ok(fast.frames[300].got[0] > slow.frames[300].got[0] * 1.3);
  assert.ok(step(fast, '农民8', 6).work < step(slow, '农民8', 6).work, 'the natural hall waits for its money');
});

test('every start plays the script through', () => {
  for (const s of [0, 1, 2, 3]) {
    const r = budget(SCRIPT, s);
    assert.ok(step(r, '农民8', 6).done != null, NAMES[s] + ': natural hall');
    assert.ok(step(r, '城镇大厅', 14).done != null, NAMES[s] + ': keep');
  }
});

// a fake game part-way (tools/export_live_state.py 200): what it had done, and how it went on
const LIVE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live-s0-200.json'), 'utf8'));
function project(state) {
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies', '人族速矿二本 · 南方.json'), 'utf8'));
  const s = D.starts[0], hall = [s.x, s.y], m = Budget.fromText(SCRIPT);
  const mine = D.mines.map(x => [x.x, x.y]).sort((a, b) => Math.hypot(a[0] - hall[0], a[1] - hall[1]) - Math.hypot(b[0] - hall[0], b[1] - hall[1]))[0];
  return Budget.run({eco: D.economy.units, start: 0, hall, mine, lanes: m.lanes, reserves: m.reserves,
    places: Budget.resolvePlaces(m.positions, (plan.plan || plan).groups, hall, Budget.NATURALS[0]), live: state});
}
const later = (label, k) => LIVE.later.find(l => l.label === label).steps[k];

test('from a live game: what happened keeps its real times, the rest goes on from now', () => {
  const r = project(LIVE.state);
  assert.strictEqual(r.now, 200);
  assert.strictEqual(r.frames[0].t, 200, 'frames from now on (the console has the game\'s own before)');
  const mill = step(r, '农民8', 4), real = later('农民8', 4);
  assert.deepStrictEqual([mill.start, mill.work], [real.start, real.work], 'begun before now: real times');
  assert.ok(Math.abs(mill.done - real.done) < 3, 'finishes after now: from its progress');
  assert.ok(Math.abs(step(r, '农民8', 6).start - later('农民8', 6).start) < 3, 'the hall right after the mill, as in the game');
  for (const [label, k] of [['城镇大厅', 14], ['国王祭坛', 2], ['农民22', 1]]) {
    const err = Math.abs(step(r, label, k).start - later(label, k).start);
    assert.ok(err <= 20, `${label} step ${k + 1}: ${err} s off what the game did`);
  }
});

test('measured rates: income over worker-seconds', () => {
  const S = [];
  for (let t = 0; t <= 60; t += 2) S.push({t, got: [t * 5 * 1.8, t * 4 * 0.6], miners: 5, natMiners: 0, natHall: false, jacks: 4});
  const r = Budget.ratesFrom(S);
  assert.ok(Math.abs(r.gold - 1.8) < 0.01 && Math.abs(r.wood - 0.6) < 0.01, JSON.stringify(r));
  assert.strictEqual(Budget.ratesFrom(S.slice(0, 3)), null, 'not enough yet');
});

test('from a live game: a queue the game has not started yet (no money or food then) still gets trained', () => {
  const state = JSON.parse(JSON.stringify(LIVE.state)), hallLane = state.script.lanes.find(l => l.label === '城镇大厅');
  for (const b of state.buildings) if (b.type === 'htow') b.train = null;
  const who = hallLane.steps[hallLane.i], r = project(state);
  assert.ok(lane(r, who).steps[0].start != null, `${who} is trained after all`);
});
