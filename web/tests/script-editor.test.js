// node --test web/tests/script-editor.test.js — the tactic-script editor's step cards
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
global.window = global;
require('../script-editor.js');
const {splitStep, joinStep, laneKind, laneCids} = window.ScriptEditor._test;

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../strategies/战术脚本-人族速矿二本.txt'), 'utf8');
function steps(text) { // every step of every lane, the way the bridge's parser cuts them
  const lines = [];
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (!s || s.startsWith('#') && !/^#\S+[：:]/.test(s)) continue;
    if (/^\s/.test(raw) || s.startsWith('→')) { lines[lines.length - 1] += ' ' + s; continue; }
    lines.push(s);
  }
  return lines.filter(l => /[：:]/.test(l) && !/^(位置|留钱)/.test(l)).flatMap(l => l.split(/[：:]/).slice(1).join('：').split(/\s*→\s*/).filter(Boolean));
}

test('every card of the shipped script splits into its parts and joins back', () => {
  const all = steps(SCRIPT);
  assert.ok(all.length > 60, all.length);
  for (const raw of all) assert.equal(joinStep(splitStep(raw)), raw.replace(/\s+/g, ' ').trim(), raw);
});

test('a card has a condition, an action, a place and a name', () => {
  assert.deepEqual(splitStep('[金≥385 木≥205] 建造 城镇大厅 @分基地 #分基地'),
    {cond: '金≥385 木≥205', body: '建造 城镇大厅', pos: '分基地', tag: '分基地', act: '建造'});
  assert.deepEqual(splitStep('农民12'), {cond: '', body: '农民12', pos: '', tag: '', act: '农民'});
  assert.equal(joinStep({cond: '1:30', body: '建造 农场', pos: '农场3', tag: ''}), '[1:30] 建造 农场 @农场3');
});

test('lanes are told apart by their head', () => {
  assert.equal(laneKind('农民9、10、12'), 'peasant');
  assert.deepEqual(laneCids('农民9、10、12'), [9, 10, 12]);
  assert.equal(laneKind('大法师'), 'hero');
  assert.equal(laneKind('#分基地'), 'building');
  assert.equal(laneKind('城镇大厅'), 'building');
});
