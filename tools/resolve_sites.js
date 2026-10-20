// node tools/resolve_sites.js [strategies/<name>.json ...] : redo the automatic build sites of saved strategies.
//
// A strategy stores every build event's `site` because the bridge may pick it with no console to resolve
// sites (a game you start yourself). Sites the player placed (`at`) are kept as they are; the automatic
// ones are worked out again for the strategy's own start with the console's rules (Sim.run -> planSites).
// Run it after changing a strategy's start, its natural, or the site rules. Default: the 人族速矿二本 strategies (wall layouts keep their own placed sites).
global.window = global;
require('../web/data/lost-temple.js');
const Sim = require('../web/sim.js');
const fs = require('fs'), path = require('path');
const W = new Sim.World(window.LT_DATA);
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(path.join(__dirname, '..', 'strategies')).filter(f => f.startsWith('人族速矿二本') && f.endsWith('.json')).map(f => path.join(__dirname, '..', 'strategies', f));

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8'), doc = JSON.parse(raw), plan = doc.plan;
  if (plan.start == null || !Array.isArray(plan.groups)) continue;
  const events = plan.groups.flatMap(g => g.children), before = new Map(events.map(e => [e.id, JSON.stringify(e.site)]));
  for (const e of events) if (e.kind === 'build' && !e.at && !e.resume) delete e.site;
  Sim.run(W, plan.start, plan.groups, 0);
  const changed = [];
  for (const e of events) {
    delete e.rt; delete e.siteNote;
    if (e.kind === 'build' && JSON.stringify(e.site) !== before.get(e.id)) changed.push(`${e.name} ${before.get(e.id)} -> ${JSON.stringify(e.site)}`);
  }
  if (!changed.length) continue;
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  console.log(path.basename(file) + '\n  ' + changed.join('\n  '));
}
