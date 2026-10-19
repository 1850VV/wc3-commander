// node --test web/tests  — offline simulation rules
const test = require('node:test');
const assert = require('node:assert');
global.window = global;
require('../data/lost-temple.js');
const Sim = require('../sim.js');
const W = new Sim.World(window.LT_DATA);
const byName = (g, p) => g.events.find(e => e.name.startsWith(p));

test('default opening finishes on all four start locations', () => {
  for (let s = 0; s < 4; s++) {
    const g = Sim.run(W, s, Sim.defaultPlan(), 130);
    for (const p of ['建造 国王祭坛', '建造 农场 · 农民2', '建造 兵营', '训练 大法师']) assert.equal(byName(g, p).rt.status, 'done', `${W.starts[s].name} ${p}`);
    assert.equal(g.counts().idle, 0);
  }
});

test('replay is deterministic', () => {
  const a = Sim.run(W, 1, Sim.defaultPlan(), 150), b = Sim.run(W, 1, Sim.defaultPlan(), 150);
  assert.deepEqual([a.gold, a.wood, a.units.length], [b.gold, b.wood, b.units.length]);
});

test('build times follow 1.27a data', () => {
  const g = Sim.run(W, 0, Sim.defaultPlan(), 100), e = byName(g, '建造 国王祭坛');
  assert.ok(Math.abs(e.rt.aEnd - e.rt.bStart - window.LT_DATA.economy.units.halt.time) < 0.2);
});

test('construction pauses without a builder and resumes', () => {
  const plan = Sim.defaultPlan();
  plan[3].children.push(Sim.ev('gather', '采金 · 农民3', 20, {units: [3], res: 'gold'}));
  const bar = Sim.run(W, 0, plan, 25).buildings.find(b => b.type === 'hbar');
  assert.match(byName(Sim.run(W, 0, plan, 35), '建造 兵营').rt.note, /暂停/);
  plan[3].children.push(Sim.ev('build', '继续建造 兵营', 40, {btype: 'hbar', at: [bar.x, bar.y], resume: true}));
  const e = byName(Sim.run(W, 0, plan, 120), '建造 兵营');
  assert.equal(e.rt.status, 'done');
  assert.ok(e.rt.aEnd > 80, 'finished later than the uninterrupted 64 s');
});

test('training reports a missing requirement', () => {
  const plan = Sim.defaultPlan();
  plan[3].children.push(Sim.ev('train', '训练火枪手', 100, {utype: 'hrif'}));
  assert.match(byName(Sim.run(W, 0, plan, 125), '训练火枪手').rt.note, /铁匠铺/);
});

test('placement keeps the mining lane clear', () => {
  const g = Sim.run(W, 0, Sim.defaultPlan(), 0);
  const [x, y] = W.snap('hhou', (g.hall.x + g.mine.x) / 2, (g.hall.y + g.mine.y) / 2);
  assert.equal(g.canPlace('hhou', x, y, []).ok, false);
  for (const e of g.events.filter(e => e.kind === 'build')) assert.ok(e.site, e.name);
});

test('a placed site is reserved first and built exactly there', () => {
  const plan = Sim.defaultPlan(), first = byName(Sim.run(W, 0, plan, 0), '建造 农场 · 农民2');
  const spot = first.site.slice(), later = plan[1].children.find(e => e.name === '建造 农场');
  later.at = spot.slice(); // the 0:50 farm takes the spot the 0:00 farm would have used
  const g = Sim.run(W, 0, plan, 130);
  assert.deepEqual(later.site, spot);
  assert.notDeepEqual(byName(g, '建造 农场 · 农民2').site, spot);
  assert.equal(later.siteNote, undefined);
  assert.equal(later.rt.status, 'done');
  assert.ok(g.buildings.some(b => b.type === 'hhou' && b.x === spot[0] && b.y === spot[1]));
});

test('a placed site that cannot be built moves nearby with a note', () => {
  const plan = Sim.defaultPlan(), g0 = Sim.run(W, 0, plan, 0);
  const lane = W.snap('hhou', (g0.hall.x + g0.mine.x) / 2, (g0.hall.y + g0.mine.y) / 2);
  const farm = plan[1].children.find(e => e.name === '建造 农场');
  farm.at = lane;
  Sim.run(W, 0, plan, 0);
  assert.match(farm.siteNote, /指定位置不能建/);
  assert.ok(farm.site && (farm.site[0] !== lane[0] || farm.site[1] !== lane[1]));
});

test('gap sizes follow collision: peasant and footman 2 cells, heroes 3', () => {
  assert.deepEqual([16, 31, 32, 48].map(Sim.cellsFor), [2, 2, 3, 4]);
  assert.equal(Sim.WALL.worker, Sim.cellsFor(31));
  assert.equal(Sim.WALL.hero, Sim.cellsFor(32));
});

test('the default layout does not wall in the mining route', () => {
  const plan = Sim.defaultPlan(), g = Sim.run(W, 0, plan, 0);
  const sites = plan.flatMap(x => x.children).filter(e => e.kind === 'build').map(e => ({type: e.btype, x: e.site[0], y: e.site[1]}));
  const r = g.wallCheck({sites});
  assert.equal(r.verdict, 'open');
  assert.ok(r.K >= Sim.WALL.hero && r.mineOK && r.choke);
});

test('auto wall seals the south base with an altar, a barracks and three farms', () => {
  const plan = Sim.defaultPlan();
  plan[1].children.push(Sim.ev('build', '建造 农场', 70, {unit: null, btype: 'hhou'}));
  const r = Sim.autoWall(W, 0, plan);
  assert.equal(r.before.verdict, 'open');
  assert.equal(r.after.verdict, 'walled');
  assert.equal(r.after.K, Sim.WALL.worker);
  assert.ok(r.after.mineOK);
  for (const p of r.placed) p.e.at = p.pos;
  const g = Sim.run(W, 0, plan, 200);
  for (const p of r.placed) {
    assert.deepEqual(p.e.site, p.pos, 'pinned wall piece kept its spot');
    assert.equal(p.e.siteNote, undefined);
    assert.equal(p.e.rt.status, 'done', p.e.name);
    assert.ok(g.buildings.some(b => b.type === p.e.btype && b.x === p.pos[0] && b.y === p.pos[1]));
  }
});

test('auto wall leaves started buildings alone', () => {
  const plan = Sim.defaultPlan(), altar = plan[0].children[0];
  const r = Sim.autoWall(W, 0, plan, {skip: new Set([altar.id])});
  assert.ok(!r.placed.some(p => p.e === altar));
});
