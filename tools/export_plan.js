// node tools/export_plan.js [start] > plan.json : default plan with build sites resolved by sim.js
global.window = global;
require('../web/data/lost-temple.js');
const Sim = require('../web/sim.js');
const start = +(process.argv[2] || 0);
const W = new Sim.World(window.LT_DATA), groups = Sim.defaultPlan();
Sim.run(W, start, groups, 0);
const plan = {start, groups: groups.map(g => ({id: g.id, name: g.name, src: g.src, children: g.children.map(({rt, ...e}) => e)}))};
process.stdout.write(JSON.stringify(plan, null, 1) + '\n');
