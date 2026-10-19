// node tools/make_fast_expand.js : write strategies/人族速矿二本 · <出生点>.json for all four starts.
//
// The user's build order (Lost Temple, human, Archmage first, militia clear the natural, two-base
// economy, keep at 5:45, then Mountain King and casters) as timeline events. The altar, barracks and
// farms go on that start's wall layout (strategies/<南|西|北|东>出生点.json), so the base is walled
// while it expands. Times are the build order's targets; the console and the game decide the rest
// (resources, food, requirements, "after" dependencies). Checkpoints grade a run against its windows.
global.window = global;
require('../web/data/lost-temple.js');
const Sim = require('../web/sim.js');
const fs = require('fs'), path = require('path');
const STORE = path.join(__dirname, '..', 'strategies'), W = new Sim.World(window.LT_DATA);
const WALLS = ['南出生点', '西出生点', '北出生点', '东出生点']; // start 0..3

function wallSites(start) {
  const doc = JSON.parse(fs.readFileSync(path.join(STORE, WALLS[start] + '.json'), 'utf8'));
  if (doc.plan.start !== start) throw new Error(WALLS[start] + ' is not start ' + start);
  const builds = doc.plan.groups.flatMap(g => g.children).filter(e => e.kind === 'build' && e.at).sort((a, b) => a.start - b.start || a.seq - b.seq);
  const of = t => builds.filter(e => e.btype === t).map(e => e.at);
  return {altar: of('halt')[0], barracks: of('hbar')[0], farms: of('hhou')};
}

function plan(start) {
  const wall = wallSites(start), farms = wall.farms.slice();
  let n = 0;
  const ev = (kind, name, at, params) => ({id: 'f' + (++n), seq: n, kind, name, start: at, ...params});
  const farm = (name, at, params) => ev('build', name, at, {unit: null, btype: 'hhou', ...(farms.length ? {at: farms.shift()} : {}), ...params});
  const peasant = (at, then) => ev('train', '训练农民 → ' + {gold: '采金', wood: '伐木', natural: '分矿采金'}[then], at, {utype: 'hpea', then});

  // opening: P1-P3 gold, P4 altar, P5 farm, P6 barracks
  const altar = ev('build', '建造 国王祭坛 · 农民4', 0, {unit: 4, btype: 'halt', at: wall.altar});
  const barracks = ev('build', '建造 兵营 · 新农民', 16, {unit: null, btype: 'hbar', at: wall.barracks});
  const open = [
    ev('gather', '采金 · 农民1、2、3', 0, {units: [1, 2, 3], res: 'gold'}),
    altar,
    farm('建造 农场 · 农民5', 0, {unit: 5}),
    peasant(0, 'gold'), peasant(15, 'gold'),
    barracks,
    peasant(30, 'wood'),
  ];
  const hero = ev('train', '训练 大法师（首发免费）', 60, {utype: 'Hamg', after: altar.id});
  const army = [
    hero,
    ev('learn', '大法师学水元素', 115, {hero: 'Hamg', ability: 'AHwe', abilityName: '水元素'}),
    ev('train', '训练 步兵 F1', 75, {utype: 'hfoo', after: barracks.id}),
    ev('train', '训练 步兵 F2', 95, {utype: 'hfoo'}),
    ev('train', '训练 步兵 F3', 125, {utype: 'hfoo'}),
  ];
  const eco = [
    peasant(45, 'wood'),
    farm('建造 农场 2', 60, {then: 'wood'}),
    peasant(60, 'wood'), peasant(75, 'wood'),
    farm('建造 农场 3', 95, {then: 'wood'}),
    peasant(90, 'wood'), peasant(105, 'wood'), peasant(120, 'wood'),
  ];
  const militia = ev('militia', '敲钟：4 个伐木农民变民兵', 125, {count: 4, from: 'wood'});
  const clear = ev('clear', '清近矿（大法师 + 步兵 + 民兵）', 127, {militia: militia.id});
  const hall = ev('build', '建造 分基地（4 人协助）', 130, {unit: null, btype: 'htow', near: 'natural', helpers: 4, then: 'natural', after: clear.id});
  const expand = [
    militia, clear, hall,
    peasant(135, 'wood'), peasant(150, 'wood'), peasant(165, 'wood'),
    ev('build', '建造 侦察塔（分矿）', 225, {unit: null, btype: 'hwtw', near: 'natural', then: 'natural'}),
    ev('upgrade', '侦察塔升级为防御塔', 260, {from: 'hwtw', to: 'hatw'}),
    peasant(250, 'natural'), peasant(265, 'natural'), peasant(280, 'natural'),
  ];
  const keep = ev('upgrade', '升级 主城（二本）', 345, {from: 'htow', to: 'hkee', at: [W.starts[start].x, W.starts[start].y]});
  const sanctum = ev('build', '建造 神秘圣地', 485, {unit: null, btype: 'hars', after: keep.id});
  const vault = ev('build', '建造 神秘藏宝室', 405, {unit: null, btype: 'hvlt'});
  const tech = [
    ev('train', '训练 步兵 F4', 270, {utype: 'hfoo'}), ev('train', '训练 步兵 F5', 290, {utype: 'hfoo'}),
    ev('build', '建造 伐木场', 285, {unit: null, btype: 'hlum', then: 'wood'}),
    farm('建造 农场 4', 300, {}),
    keep,
    farm('建造 农场 5', 390, {}),
    vault,
    ev('train', '训练 山丘之王（二发英雄）', 485, {utype: 'Hmkg', after: keep.id}),
    sanctum,
    ev('build', '建造 神秘圣地 2', 500, {unit: null, btype: 'hars', after: keep.id}),
    ev('train', '训练 牧师', 540, {utype: 'hmpr', after: sanctum.id}),
    ev('train', '训练 女巫', 545, {utype: 'hsor', after: sanctum.id}),
    ev('train', '训练 破法者', 560, {utype: 'hspt', after: sanctum.id}),
  ];
  const groups = [
    {id: 'g_open', name: '速矿开局', src: '打法', children: open},
    {id: 'g_army', name: '英雄与步兵', src: '打法', children: army},
    {id: 'g_eco', name: '经济与农场', src: '打法', children: eco},
    {id: 'g_expand', name: '清近矿与分矿', src: '打法', children: expand},
    {id: 'g_tech', name: '二本与科技', src: '打法', children: tech},
    {id: 'g_user', name: '我的指令', src: '手动', children: []},
    {id: 'g_ai', name: 'AI 指令', src: 'AI', children: []},
  ];
  const id = name => groups.flatMap(g => g.children).find(e => e.name.startsWith(name)).id;
  const checkpoints = [ // the build order's practice checklist (its section 8), as windows in seconds
    {id: 'c1', name: '国王祭坛完成', event: altar.id, at: 'end', from: 55, to: 65},
    {id: 'c2', name: '大法师出生', event: hero.id, at: 'end', from: 115, to: 125},
    {id: 'c3', name: '第 2 个步兵出生', event: id('训练 步兵 F2'), at: 'end', from: 105, to: 125},
    {id: 'c4', name: '清完近矿', event: clear.id, at: 'end', from: 135, to: 190},
    {id: 'c5', name: '分基地开工', event: hall.id, at: 'start', from: 180, to: 220},
    {id: 'c6', name: '分基地完成，分矿采金', event: hall.id, at: 'end', from: 240, to: 285},
    {id: 'c7', name: '开始升主城', event: keep.id, at: 'start', from: 330, to: 375},
    {id: 'c8', name: '主城完成', event: keep.id, at: 'end', from: 470, to: 515},
    {id: 'c9', name: '山丘之王开始训练', event: id('训练 山丘之王'), at: 'start', from: 480, to: 600},
    {id: 'c10', name: '第一个法师开始训练', event: id('训练 牧师'), at: 'start', from: 540, to: 600},
  ];
  // Resolve every build site now, as the console does before sending a plan: when the bridge picks
  // this strategy itself (a game you started), nothing else fills in e.site for the engine.
  Sim.run(W, start, groups, 0);
  for (const g of groups) g.children = g.children.map(({rt, ...e}) => e); // run state is not part of a plan
  return {start, groups, checkpoints};
}

if (require.main === module) {
  const d = new Date(), p2 = x => String(x).padStart(2, '0'); // local time, as strategies.py writes it
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  for (let s = 0; s < 4; s++) {
    const name = '人族速矿二本 · ' + W.starts[s].name, p = plan(s);
    fs.writeFileSync(path.join(STORE, name + '.json'), JSON.stringify({name, saved: stamp, plan: p}, null, 1) + '\n');
    console.log('wrote', name, p.groups.reduce((t, g) => t + g.children.length, 0), 'events');
  }
}
module.exports = {plan};
