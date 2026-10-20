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

test('an automatic builder does not take a peasant a later event names', () => {
  const plan = Sim.defaultPlan();
  plan[3].children.push(Sim.ev('build', '建造 农场', 0, {unit: null, btype: 'hhou'})); // 0:00, before the 0:01 barracks with peasant 3
  const g = Sim.run(W, 0, plan, 150), farm = plan[3].children[0];
  assert.equal(farm.rt.status, 'done', farm.rt.note);
  assert.notEqual(farm.rt.builder, 3);
  assert.equal(byName(g, '建造 兵营').rt.builder, 3);
});

test('after: an event waits for the one it depends on', () => {
  const plan = Sim.defaultPlan(), bar = plan[0].children.find(e => e.btype === 'hbar');
  const farm = Sim.ev('build', '建造 农场（兵营后）', 0, {unit: null, btype: 'hhou', after: bar.id});
  plan[3].children.push(farm);
  Sim.run(W, 0, plan, 140);
  assert.equal(bar.rt.status, 'done');
  assert.ok(farm.rt.aStart >= bar.rt.aEnd, `${farm.rt.aStart} >= ${bar.rt.aEnd}`);
  assert.equal(farm.rt.status, 'done');
});

test('after: a deleted dependency no longer holds an event back', () => {
  const plan = Sim.defaultPlan(), farm = Sim.ev('build', '建造 农场', 20, {unit: 4, btype: 'hhou', after: 'gone'});
  plan[3].children.push(farm);
  Sim.run(W, 0, plan, 25);
  assert.equal(farm.rt.aStart, 20);
});

test('upgrade: town hall to keep takes 140 s, costs the difference and holds the queue', () => {
  const plan = Sim.defaultPlan(), up = Sim.ev('upgrade', '升级 主城', 150, {to: 'hkee'}), peon = Sim.ev('train', '训练农民', 151, {utype: 'hpea'});
  plan[3].children.push(up, peon);
  const g = Sim.run(W, 0, plan, 320);
  assert.equal(up.rt.status, 'done');
  assert.equal(g.hall.type, 'hkee');
  assert.ok(Math.abs(up.rt.aEnd - up.rt.trainStart - 140) < 0.2);
  assert.ok(peon.rt.trainStart >= up.rt.aEnd - 0.1, 'the peasant waits behind the upgrade');
  const eco = window.LT_DATA.economy.units;
  assert.deepEqual(g.upgradeCost({type: 'htow'}, 'hkee'), [eco.hkee.gold - eco.htow.gold, eco.hkee.wood - eco.htow.wood]);
  assert.deepEqual(g.upgradeCost({type: 'htow'}, 'hkee'), [320, 210]);
});

test('expansion: hall beside the natural, helpers speed it up, builders then mine there', () => {
  const run = helpers => {
    const plan = Sim.defaultPlan(), hall = Sim.ev('build', '建造 分基地', 100, {unit: null, btype: 'htow', near: 'natural', helpers, then: 'natural'});
    plan[3].children.push(hall);
    const g = Sim.run(W, 0, plan, 0);
    while (g.t < 600 && hall.rt.status !== 'done') { if (Math.abs(g.t - 150) < 0.05) { g.gold += 2000; g.wood += 2000; } g.step(); }
    for (let k = 0; k < 400; k++) g.step(); // 40 s of mining afterwards
    return {g, hall};
  };
  const solo = run(0), crew = run(3);
  for (const {g, hall} of [solo, crew]) {
    assert.equal(hall.rt.status, 'done');
    assert.ok(Math.hypot(hall.site[0] - g.natural.x, hall.site[1] - g.natural.y) < 900, 'hall beside the natural mine');
    assert.ok(g.mineGold.get(g.natural.id) < 12500, 'gold mined at the natural');
  }
  assert.equal(Math.round(solo.hall.rt.aEnd - solo.hall.rt.bStart), 180);
  assert.ok(crew.hall.rt.aEnd - crew.hall.rt.bStart < 100, 'three helpers cut the build time');
  assert.ok(crew.g.units.filter(u => u.task.kind === 'gather' && u.task.mine === crew.g.natural).length >= 4);
});

test('gather at the natural sends workers to that mine', () => {
  const plan = Sim.defaultPlan(), go = Sim.ev('gather', '采金 · 分矿', 30, {count: 2, res: 'gold', mine: 'natural'});
  plan[3].children.push(go);
  const early = Sim.run(W, 0, plan, 40); // later build events may borrow one of them as a builder
  assert.equal(go.rt.status, 'active');
  assert.equal(early.units.filter(u => u.task.kind === 'gather' && u.task.mine === early.natural).length, 2);
  assert.ok(Sim.run(W, 0, plan, 120).mineGold.get(early.natural.id) < 12500);
});

test('militia, clear (estimated) and the expansion after it', () => {
  const plan = Sim.defaultPlan();
  const L = Sim.ev('learn', '大法师学水元素', 115, {hero: 'Hamg', ability: 'AHwe', abilityName: '水元素'});
  const M = Sim.ev('militia', '敲钟', 125, {count: 4, from: 'wood'});
  const C = Sim.ev('clear', '清近矿', 126, {militia: M.id, est: 30});
  const X = Sim.ev('build', '建造 分基地', 126, {unit: null, btype: 'htow', near: 'natural', after: C.id, then: 'natural'});
  plan[3].children.push(L, M, C, X);
  const mid = Sim.run(W, 0, plan, 145); // they walk to the town hall first, then change
  assert.equal(L.rt.status, 'done');
  assert.equal(M.rt.militia.length, 4);
  assert.equal(mid.units.filter(u => u.type === 'hmil').length, 4);
  assert.ok(C.rt.aStart > M.rt.aStart, 'the army leaves once the militia have changed');
  assert.equal(mid.counts().wood + mid.counts().gold + mid.counts().build + mid.counts().idle, mid.workers().length);
  const g = Sim.run(W, 0, plan, 260);
  assert.equal(C.rt.status, 'done');
  assert.match(C.rt.note, /模拟估计/);
  assert.ok(C.rt.aEnd - C.rt.fightStart >= 29.9);
  assert.equal(M.rt.status, 'done');
  assert.equal(g.units.filter(u => u.type === 'hmil').length, 0);
  assert.ok(X.rt.aStart >= C.rt.aEnd);
  assert.ok(X.rt.builder, 'a peasant builds the hall');
});

test('fast-expand strategies: walls on their pins, key checkpoints on time in simulation', () => {
  const {plan} = require('../../tools/make_fast_expand.js');
  for (let s = 0; s < 4; s++) {
    const p = plan(s), groups = p.groups.map(g => ({...g, children: g.children.map(e => ({...e}))}));
    Sim.run(W, s, groups, 640); // the last optional build (2nd sanctum) can run a few seconds past 10:00
    const events = groups.flatMap(g => g.children), name = W.starts[s].name;
    for (const e of events.filter(e => e.kind === 'build')) {
      assert.equal(e.rt.status, 'done', `${name} ${e.name}: ${e.rt.note}`);
      if (e.at) assert.deepEqual(e.site, e.at, `${name} ${e.name} on its wall spot`);
    }
    const state = id => Sim.checkpoint(p.checkpoints.find(c => c.id === id), events, 600).state;
    for (const id of ['c1', 'c2', 'c3', 'c7', 'c8', 'c9']) assert.equal(state(id), 'ok', `${name} ${p.checkpoints.find(c => c.id === id).name}`);
    for (const id of ['c4', 'c5', 'c6']) assert.ok(['ok', 'late'].includes(state(id)), `${name} ${id} reached`);
  }
});

test('bodyRect is the solid footprint; Simple textures keep a walkable ring', () => {
  const g = Sim.run(W, 0, Sim.defaultPlan(), 0), size = r => [r[2] - r[0], r[3] - r[1]];
  const tex = t => W.buildingTex(t);
  // town hall: 16x16 texture (512) but only the middle 12x12 blocks movement (384)
  assert.deepEqual(size(W.rectOf(g.hall.x, g.hall.y, tex('htow'))), [512, 512]);
  assert.deepEqual(size(W.bodyRect(g.hall.x, g.hall.y, tex('htow'))), [384, 384]);
  // farm: SimpleSolid, body and placement footprint are the same 4x4 (128)
  assert.deepEqual(size(W.bodyRect(g.hall.x, g.hall.y, tex('hhou'))), [128, 128]);
  assert.deepEqual(size(W.rectOf(g.hall.x, g.hall.y, tex('hhou'))), [128, 128]);
  // gold mine: 16x16 unbuildable, the rock itself is the middle 8x8 (256)
  assert.deepEqual(size(W.bodyRect(g.mine.x, g.mine.y, g.mine.tex)), [256, 256]);
  assert.deepEqual(size(W.rectOf(g.mine.x, g.mine.y, g.mine.tex)), [512, 512]);
});

test('checkpoint grading', () => {
  const e = {id: 'x', rt: {status: 'done', aEnd: 70, bStart: 30}}, cp = {event: 'x', at: 'end', from: 55, to: 65};
  assert.deepEqual(Sim.checkpoint(cp, [e], 100), {state: 'late', value: 70, by: 5});
  assert.equal(Sim.checkpoint({...cp, to: 75}, [e], 100).state, 'ok');
  assert.equal(Sim.checkpoint({...cp, at: 'start', from: 40, to: 60}, [e], 100).state, 'early');
  assert.equal(Sim.checkpoint(cp, [{id: 'x', rt: {status: 'running'}}], 60).state, 'pending');
  assert.equal(Sim.checkpoint(cp, [{id: 'x', rt: {status: 'running'}}], 66).state, 'missed');
  assert.equal(Sim.checkpoint(cp, [{id: 'x', rt: {status: 'done', aEnd: 60, failed: true}}], 66).state, 'missed');
  assert.equal(Sim.checkpoint(cp, [], 66).state, 'missing');
});


test("each start's natural is Lost Temple's, not the corner mine that is closer from the west", () => {
  for (let s = 0; s < 4; s++) {
    const g = new Sim.Game(W, {start: s, events: []});
    assert.deepEqual([g.natural.x, g.natural.y], Sim.NATURALS[s], W.starts[s].name);
  }
  const west = W.starts[1], corner = W.mines.find(m => m.x === -7360 && m.y === -7488);
  assert.ok(Math.hypot(corner.x - west.x, corner.y - west.y) < Math.hypot(-6912 - west.x, 2176 - west.y)); // why the table exists
});
