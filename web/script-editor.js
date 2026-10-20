/* Tactic-script editor (战术脚本): strategies/战术脚本-人族速矿二本.txt shown as lanes of step cards.
 * One lane per peasant (or several peasants with the same life), per building and per hero; the cards
 * run left to right, each waiting for its [condition]. Drag a card to reorder it or hand it to another
 * lane, drag from the palette to add one, click to edit it. 「预演」 plays the script on the bridge's
 * fake world and lays the cards out on the timeline at the moment each began; a live or replayed
 * game does the same from its decision record. The text file stays the source: 保存 writes it back,
 * and the next game plays it. Needs the bridge (GET/PUT /api/script, POST /api/script/preview). */
(function () {
  'use strict';
  const HEROES = ['大法师', '山丘之王'];
  const BT = {国王祭坛: 'halt', 祭坛: 'halt', 农场: 'hhou', 兵营: 'hbar', 伐木场: 'hlum', 神秘藏宝室: 'hvlt', 藏宝室: 'hvlt', 神秘圣所: 'hars', 神秘圣地: 'hars',
    圣所: 'hars', 侦察塔: 'hwtw', 城镇大厅: 'htow', 分基地: 'htow', 铁匠铺: 'hbla', 车间: 'harm', 狮鹫笼: 'hgra', 奥术塔: 'hatw', 防御塔: 'hatw'};
  const PALETTE = [
    ['peasant', ['采金 主矿', '伐木 主矿', '采金 分矿', '伐木 分矿', '建造 农场 @自动', '协助 #分基地', '敲钟', '集合 @前方空地', '清野 @分矿', '待命 @分矿']],
    ['building', ['农民N', '步兵 ×1', '集结点 @前方空地', '升级 主城']],
    ['hero', ['学 水元素', '集合 @前方空地', '清野 @分矿', '待命 @分矿', '攻击移动 @分矿']],
    ['army', ['集合 @前方空地', '攻击移动 @分矿', '待命 @分矿']],
  ];
  const KIND_NAME = {peasant: '农民', building: '建筑', hero: '英雄', army: '步兵'};
  const SECTIONS = [['peasant', '农民（每人的一生）'], ['building', '建筑（生产顺序）'], ['hero', '英雄'], ['army', '步兵（所有步兵一起）']];
  const COND_PRESETS = ['1:30', '金≥385 木≥205', '#分基地 开工', '#分基地 完成', '大法师 出生', '大法师剩余 ≤ 集合用时', '清野 完成', '人口剩 ≤ 4'];
  const EXPR_HINTS = ['布局.国王祭坛', '布局.农场1', '布局.兵营', '布局.神秘藏宝室', '布局.神秘圣所1', '分矿.城镇大厅', '分矿.侦察塔', '本方向分矿',
    '祭坛 前方 400', '分矿 后方 640', '坐标 0,0'];
  const ACT_CLASS = {采金: 'gold', 伐木: 'wood', 建造: 'build', 协助: 'assist', 敲钟: 'bell', 集合: 'bell', 清野: 'fight', 待命: 'wait', 农民: 'train',
    学: 'learn', 集结点: 'rally', 升级: 'upgrade', 攻击移动: 'fight', 移动: 'wait'};
  /* what each kind of lane can be told to do, with the choices each action takes */
  const ACTS = {
    peasant: [['移动', '走到那里，到了就接着做下一步'], ['采金', '一直采金，后面的步骤开始时才停下'], ['伐木', '一直伐木，后面的步骤开始时才停下'], ['建造', '走到工地，钱够就开工，建完才算这一步做完'],
      ['协助', '去帮忙建一座建筑（等它开工再过去），建完才算做完'], ['敲钟', '走到城镇大厅变民兵，45 秒后变回农民'], ['集合', '走到一个位置等着'],
      ['清野', '跟大法师一起清野，清完才算做完'], ['待命', '走到一个位置站着，等后面的条件']],
    building: [['农民', '训练一个指定编号的农民（他的一生写在农民那一栏）'], ['训练', '训练单位，可以连续几个'], ['集结点', '设集结点：一个位置，或跟着英雄'], ['升级', '把这座建筑升级']],
    hero: [['学', '学一个技能'], ['移动', '走到那里，到了就接着做下一步'], ['集合', '走到一个位置等着'], ['清野', '带队清野，清完才算做完'], ['待命', '走到一个位置站着，等后面的条件'], ['攻击移动', '一路打过去，到了才算做完']],
    army: [['移动', '所有步兵走到那里，都到了就接着做下一步'], ['集合', '所有步兵走到一个位置等着'], ['攻击移动', '所有步兵一路打过去，都到了才算做完'], ['待命', '所有步兵走到一个位置站着']],
  };
  const BUILD_LIST = ['农场', '兵营', '国王祭坛', '伐木场', '城镇大厅', '侦察塔', '神秘藏宝室', '神秘圣所', '铁匠铺', '车间', '狮鹫笼'];
  const UNIT_LIST = ['步兵', '牧师', '女巫', '破法者', '大法师', '山丘之王'], UPGRADE_LIST = ['主城', '城堡', '奥术塔', '防御塔'];
  const SKILL_LIST = ['水元素', '暴风雪', '辉煌光环', '风暴之锤', '雷霆一击', '重击', '天神下凡'];
  const COND_TYPES = [['time', '到某个时间'], ['res', '资源够'], ['started', '某座建筑开工'], ['done', '某座建筑完成'], ['hero', '英雄出生'],
    ['eta', '敲钟倒推（大法师剩余 ≤ 集合用时）'], ['clear', '清野完成'], ['food', '快卡人口']];
  const T_END = 600, MIN_W = 74;
  const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8], CARD_ZOOMS = [0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5];
  const store = {get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }};
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const pct = t => (Math.max(0, Math.min(T_END, t)) / T_END * 100) + '%';

  let api = null, root = null, M = null; // M: {header, positions: [{name, expr, note}], lanes: [{head, note, steps: [{raw}]}], reserves: [{raw, note}]}
  const S = {active: false, saved: true, loadedText: '', errors: {general: [], lane: {}, pos: {}, res: {}}, map: {}, sel: null, view: 'flow',
    zoom: Math.max(1, Math.min(8, +store.get('wcc.seZoom') || 1)), cardZoom: Math.max(0.7, Math.min(1.5, +store.get('wcc.seCardZoom') || 1)),
    preview: null, busy: false, undo: [], movedPos: new Set(), moved: new Set(), repreview: 0, drag: null, check: 0, showText: false, lastTick: 0, timingKey: '', timing: null};

  /* ---------- the script's pieces ---------- */
  function laneKind(head) { return /^农民/.test(head) ? 'peasant' : HEROES.includes(head) ? 'hero' : /^(步兵|部队)$/.test(head) ? 'army' : 'building'; }
  function laneCids(head) { const m = /^农民([\d、,，\s]+)$/.exec(head); return m ? m[1].split(/[、,，\s]+/).filter(Boolean).map(Number) : []; }
  function splitStep(raw) {
    let s = String(raw).trim(), cond = '', pos = '', tag = '';
    if (s.startsWith('[')) { const i = s.indexOf(']'); if (i > 0) { cond = s.slice(1, i).trim(); s = s.slice(i + 1).trim(); } }
    const t = (' ' + s).match(/\s#(\S+)\s*$/); if (t) { tag = t[1]; s = (' ' + s).slice(0, t.index).trim(); }
    const p = s.match(/@(\S+)/); if (p) { pos = p[1]; s = (s.slice(0, p.index) + s.slice(p.index + p[0].length)).trim(); }
    s = s.replace(/\s+/g, ' ');
    return {cond, body: s, pos, tag, act: /^农民\d+$/.test(s) ? '农民' : (s.split(' ')[0] || '')};
  }
  function joinStep(o) { return ((o.cond ? `[${o.cond}] ` : '') + o.body + (o.pos ? ' @' + o.pos : '') + (o.tag ? ' #' + o.tag : '')).trim(); }
  function stepFields(raw, kind) { // a card as the editor's choices
    const o = splitStep(raw), w = o.body.split(' '), f = {cond: o.cond, pos: o.pos, tag: o.tag, act: w[0]};
    if (kind === 'building') {
      if (/^农民\d+$/.test(w[0])) { f.act = '农民'; f.peasant = +w[0].slice(2); }
      else if (w[0] === '集结点') f.rally = o.pos ? '@' + o.pos : (w[1] || '大法师');
      else if (w[0] === '升级') f.to = w[1] || '主城';
      else { f.act = '训练'; f.unit = w[0]; const m = /[×x*](\d+)/.exec(o.body); f.count = m ? +m[1] : 1; }
    } else if (w[0] === '采金' || w[0] === '伐木') f.mine = w[1] || '主矿';
    else if (w[0] === '建造') f.bname = w[1] || '农场';
    else if (w[0] === '学') f.skill = w[1] || '水元素';
    return f;
  }
  function composeStep(f) {
    let body = f.act, pos = '', tag = '';
    switch (f.act) {
      case '采金': case '伐木': body += ' ' + (f.mine || '主矿'); break;
      case '建造': body += ' ' + (f.bname || '农场'); pos = f.pos || '自动'; tag = f.tag || ''; break;
      case '协助': tag = f.tag || ''; break;
      case '集合': case '待命': case '清野': case '攻击移动': case '移动': pos = f.pos || ''; break;
      case '农民': body = '农民' + (f.peasant || 6); break;
      case '训练': body = (f.unit || '步兵') + ((f.count || 1) > 1 ? ' ×' + f.count : ''); break;
      case '集结点': if (f.rally && f.rally.startsWith('@')) pos = f.rally.slice(1); else body += ' ' + (f.rally || '大法师'); break;
      case '升级': body += ' ' + (f.to || '主城'); tag = f.tag || ''; break;
      case '学': body += ' ' + (f.skill || '水元素'); break;
    }
    return joinStep({cond: f.cond, body, pos, tag});
  }
  const condTerms = c => (c || '').split(/\s*且\s*/).map(x => x.trim()).filter(Boolean);
  /* every building the script builds or upgrades: who, what, and its #name if it has one */
  function builds() {
    const out = [];
    M.lanes.forEach((ln, l) => ln.steps.forEach((st, s) => {
      const o = splitStep(st.raw), w = o.body.split(' ');
      if (o.act === '建造' || w[0] === '升级') out.push({l, s, tag: o.tag, what: w[1] || '', who: ln.head, verb: w[0] === '升级' ? '升级' : '建造'});
    }));
    return out;
  }
  function nameBuild(l, s) { // give a build a #name so others can help or wait on it
    const st = M.lanes[l].steps[s], o = splitStep(st.raw);
    if (o.tag) return o.tag;
    const taken = new Set(builds().map(b => b.tag).filter(Boolean)), base = o.pos && o.pos !== '自动' ? o.pos : (o.body.split(' ')[1] || '建筑');
    let name = base, n = 2; while (taken.has(name)) name = base + n++;
    o.tag = name; st.raw = joinStep(o);
    return name;
  }
  function stepClass(raw) {
    const o = splitStep(raw);
    return ACT_CLASS[o.act] || (/×|^\S+$/.test(o.body) ? 'train' : 'wait');
  }
  function toText() {
    const out = [], map = {};
    const push = (line, ref) => { out.push(line); if (ref) map[out.length] = ref; };
    for (const h of (M.header || '').split('\n').filter(Boolean)) push('# ' + h);
    push('# ---------- 位置 ----------');
    M.positions.forEach((p, i) => { if (p.note) push('# ' + p.note); push(`位置 ${p.name} = ${p.expr}`, {type: 'pos', i}); });
    for (const [kind, title] of [['peasant', '农民'], ['building', '建筑生产顺序'], ['hero', '英雄'], ['army', '部队']]) {
      if (kind === 'army' && !M.lanes.some(ln => laneKind(ln.head) === 'army')) continue; // as the bridge writes it
      push(''); push(`# ---------- ${title} ----------`);
      M.lanes.forEach((ln, i) => {
        if (laneKind(ln.head) !== kind) return;
        if (ln.note) push('# ' + ln.note);
        const st = ln.steps.map(s => s.raw.trim()), rows = [];
        for (let k = 0; k < st.length; k += 4) rows.push(st.slice(k, k + 4));
        push((ln.muted ? '#⏸ ' : '') + ln.head + '：' + (rows[0] || []).join(' → '), {type: 'lane', i});
        for (const r of rows.slice(1)) push('      → ' + r.join(' → '));
      });
    }
    push(''); push('# ---------- 留钱 ----------');
    M.reserves.forEach((r, i) => { if (r.note) push('# ' + r.note); push(r.raw.trim(), {type: 'res', i}); });
    return {text: out.join('\n') + '\n', map};
  }
  function fromModel(model) {
    return {header: model.header || '', positions: (model.positions || []).map(p => ({name: p.name, expr: p.expr, note: p.note || ''})),
      lanes: (model.lanes || []).map(l => ({head: l.head, note: l.note || '', muted: !!l.muted, steps: l.steps.map(s => ({raw: s.raw}))})),
      reserves: (model.reserves || []).map(r => ({raw: r.raw, note: r.note || ''}))};
  }
  /* lanes in display order: by kind (the file's order), keeping each lane's index in M */
  const lanesOf = kind => M.lanes.map((ln, i) => ({ln, i})).filter(x => laneKind(x.ln.head) === kind);

  /* ---------- server ---------- */
  async function api_(method, path, body) {
    const r = await fetch(path, {method, headers: {'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return r.json();
  }
  async function load() {
    let j;
    try { j = await api_('GET', '/api/script'); } catch (_) { return false; }
    if (!j || !j.ok) return false;
    M = fromModel(j.model); S.loadedText = j.text; S.saved = true; S.undo = [];
    if (j.errors && j.errors.length) { S.showText = true; S.textDraft = j.text; api.say('脚本文件有错，先在「文本」里改好：' + j.errors[0], true); }
    return true;
  }
  function scheduleCheck() { clearTimeout(S.check); S.check = setTimeout(check, 350); }
  async function check() {
    const {text, map} = toText(); S.map = map; S.text = text;
    let j; try { j = await api_('PUT', '/api/script', {text, dryRun: true}); } catch (_) { return; }
    const E = {general: [], lane: {}, pos: {}, res: {}};
    for (const e of j.errors || []) {
      const m = /^第 (\d+) 行：(.*)$/.exec(e), ref = m && map[+m[1]];
      if (ref) (E[ref.type === 'lane' ? 'lane' : ref.type][ref.i] = E[ref.type === 'lane' ? 'lane' : ref.type][ref.i] || []).push(m[2]);
      else E.general.push(e);
    }
    S.errors = E; showErrors();
  }
  async function save() {
    const {text} = toText();
    let j; try { j = await api_('PUT', '/api/script', {text}); } catch (_) { api.say('没保存：连不上本地服务', true); return; }
    if (!j.saved) { api.say('脚本有错，没有保存：' + (j.errors || [])[0], true); check(); return; }
    S.loadedText = j.text; S.saved = true; render();
    preview(api.startIndex(), '已保存。', S.demo);
  }
  /* play the script (as edited, saved or not) on the fake world; the console opens the result like a
   * replay, so the event timeline, the map and these cards all show it */
  async function preview(start, lead = '', demo = false, from = null) {
    if (S.busy || !M) return;
    if (api.live().on) { api.say('连着游戏时不能预演，先点「断开」', true); return; }
    start = start == null ? api.startIndex() : start;
    const {text, map} = toText();
    S.busy = true; render();
    api.say(lead + (from != null ? `从 ${api.fmt(from)} 的存档点接着预演…` : `正在按战术脚本预演${api.startName(start)}（假游戏跑 10 分钟，约 5 秒）…`));
    if (from != null && window.UnifiedTimeline) UnifiedTimeline.markStale(from);
    let j;
    try { j = await api_('POST', '/api/script/preview', from != null ? {text, start, from} : {text, start}); } catch (_) { j = {ok: false, error: '连不上本地服务'}; }
    if (!j.ok && window.UnifiedTimeline) UnifiedTimeline.clearStale();
    S.busy = false;
    if (!j.ok) { render(); api.say('预演没跑成：' + (j.error || (j.errors || [])[0] || '未知原因'), true); return; }
    if (api.live().on) { render(); return; } // a game started meanwhile
    S.previewMap = map; S.previewText = text; S.timingKey = ''; S.movedPos.clear(); S.moved.clear();
    S.lastPreview = j;
    const dead = (j.script.lanes || []).filter(l => l.dead).map(l => l.label);
    const tail = '假游戏的采集和战斗数值是估计的，时间只作参考。' + (dead.length ? ` 阵亡：${dead.join('、')}` : '') +
      (j.resumedFrom != null ? `（从 ${api.fmt(j.resumedFrom)} 的存档点接着算，用了 ${j.seconds} 秒）` : j.note ? `（${j.note}）` : '');
    if (S.active && !demo) { // asked from the script tab: stay in 编排, keep it for 「预演」 and the timeline tab
      render(); api.say(lead + `已按新脚本在后台预演了${api.startName(start)}；点「预演」在沙盘上演示。`);
      return;
    }
    if (S.active) { // 预演: the sandbox plays the script from 0:00
      S.demo = true; S.view = 'time';
      api.openPreview(j, true);
      render();
      api.say(lead + `演示${api.startName(start)}：沙盘从 0:00 播放这份脚本，卡片跟着时间变（拖时间轴可以跳）。点「回到编排」继续拖工地、改卡片。` + tail);
      return;
    }
    api.openPreview(j);
    render();
    api.say(lead + `按战术脚本预演了${api.startName(start)}（到 ${api.fmt(j.t)}）：事件时间轴按脚本每一行分组，地图和资源跟着时间走，拖时间轴或点「播放」看过程。` + tail);
  }
  /* 编排 (the script tab, no demo): the sandbox shows the start as it begins and every site the script
   * builds, all draggable; nothing plays until 「预演」 */
  function editing() { return !!M && S.active && !S.demo && !api.live().on; }
  function backToEdit() {
    S.demo = false; S.placing = null; S.timingKey = '';
    if (api.live().replay && api.live().replay.preview) api.exitPreview();
    api.setMode('战术脚本 · 编排');
    render(); api.say('回到编排：沙盘上是开局和脚本里的全部工地，拖动改位置；改完点「预演」再看。');
  }
  /* ---------- orders from the sandbox, edits from the timeline (timeline.js) ---------- */
  // which lane of the script a runtime lane is: 农民9 may live in 「农民9、10、12」 (split it then:
  // he gets his own life from here); buildings show the game's name (神秘圣地 for 神秘圣所)
  function laneIndexOf(label, split) {
    let i = -1;
    const m = /^农民(\d+)$/.exec(label);
    if (m) i = M.lanes.findIndex(ln => laneCids(ln.head).includes(+m[1]));
    else i = M.lanes.findIndex(ln => ln.head === label || (BT[ln.head] && api.name(BT[ln.head]) === label));
    if (i >= 0 && m && split && laneCids(M.lanes[i].head).length > 1) {
      const ln = M.lanes[i];
      M.lanes.splice(i, 1, ...laneCids(ln.head).map(c => ({head: '农民' + c, note: ln.note, steps: ln.steps.map(x => ({raw: x.raw}))})));
      i = M.lanes.findIndex(x => x.head === label);
    }
    return i;
  }
  function newPlace(base, xy) {
    let n = 1, nm; do { nm = base + n++; } while (M.positions.some(p => p.name === nm));
    M.positions.push({name: nm, expr: `坐标 ${Math.round(xy[0])},${Math.round(xy[1])}`, note: `在沙盘上点的，只对${api.startName(api.startIndex())}准确`});
    return nm;
  }
  function newTag(base) { const taken = new Set(builds().map(b => b.tag).filter(Boolean)); let n = 1, nm = base; while (taken.has(nm)) nm = base + ++n; return nm; }
  /* cids: unit numbers; t: the red line; cmd as on the command card; xy: the point clicked */
  /* when: {kind: now | started | done | money, tag, gold, wood}: what the order waits for (now = the red line) */
  function addOrder({cids, t, cmd, xy, what, assist, queue, when, place: named}) {
    if (!M) return;
    const UT = window.UnifiedTimeline, T = Math.round(t), nat = UT && UT.natural(), w = when || {kind: 'now'};
    const cond = w.kind === 'started' || w.kind === 'done' ? `[#${w.tag} ${w.kind === 'started' ? '开工' : '完成'}] ` : w.kind === 'money' ? `[金≥${w.gold || 0}${w.wood ? ' 木≥' + w.wood : ''}] ` : queue ? '' : `[${api.fmt(T)}] `;
    const done = [], notes = [];
    change(() => {
      const place = named && M.positions.some(p => p.name === named) ? named : xy && ['move', 'hold', 'attack', 'build'].includes(cmd) ? newPlace(cmd === 'build' ? what : '点', xy) : null;
      let tag = null;
      if (cmd === 'assist' && assist) { const li = laneIndexOf(assist.label, true); if (li >= 0) tag = nameBuild(li, assist.k); }
      if (cmd === 'build' && cids.length > 1) tag = newTag(what);
      let armyDone = false;
      cids.forEach((cid, n) => {
        const type = UT.typeOf(cid), runtime = type === 'hpea' || type === 'hmil' ? '农民' + cid : type === 'Hamg' ? '大法师' : type === 'Hmkg' ? '山丘之王' : type === 'hfoo' ? '步兵' : null;
        if (!runtime) return;
        let li = laneIndexOf(runtime, true);
        if (li < 0 && runtime === '步兵') { if (armyDone) return; M.lanes.push({head: '步兵', note: '在时间轴上给步兵下的命令（所有步兵一起）', steps: []}); li = M.lanes.length - 1; }
        if (li < 0) { notes.push(`${runtime} 在脚本里没有自己的一行`); return; }
        if (runtime === '步兵') { if (armyDone) return; armyDone = true; }
        const kind = laneKind(M.lanes[li].head), near = xy && nat && Math.hypot(xy[0] - nat[0], xy[1] - nat[1]) < 1800;
        let body = null;
        if (kind === 'peasant') body = {'gold-main': '采金 主矿', 'gold-nat': '采金 分矿', wood: near ? '伐木 分矿' : '伐木 主矿', bell: '敲钟', clear: '清野 @分矿',
          move: `移动 @${place}`, attack: `移动 @${place}`, hold: `待命 @${place}`,
          build: n === 0 ? `建造 ${what} @${place}${tag ? ' #' + tag : ''}` : `协助 #${tag}`, assist: tag ? `协助 #${tag}` : null}[cmd];
        else if (kind === 'hero' || kind === 'army') body = {move: `移动 @${place}`, attack: `攻击移动 @${place}`, hold: `待命 @${place}`, clear: kind === 'hero' ? '清野 @分矿' : `攻击移动 @分矿`}[cmd];
        if (!body) { notes.push(`${runtime} 不会这个命令`); return; }
        const steps = M.lanes[li].steps;
        let idx = UT.stepIndexAt(runtime, T) + 1; if (idx <= 0) idx = steps.length; idx = Math.min(idx, steps.length);
        const cur = UT.stepAt(runtime, T);
        if (cur && !queue && !/^(采金|伐木|待命|集合|跟随)/.test(cur.body)) notes.push(`${runtime} 这时在「${cur.body}」，做完才会接着做`);
        steps.splice(idx, 0, {raw: (cond + body).trim()});
        done.push(runtime);
      });
    });
    if (!done.length) { api.say('没有能接这个命令的单位' + (notes.length ? '：' + notes.join('；') : ''), true); return; }
    const lead = `${api.fmt(T)}：${done.join('、')} → ${cmd === 'build' ? '建造 ' + what : {'gold-main': '采金 主矿', 'gold-nat': '采金 分矿', wood: '伐木', bell: '敲钟', clear: '清野', move: '移动', attack: '攻击移动', hold: '待命', assist: '协助'}[cmd]}${queue ? '（排队）' : ''}，已写进脚本（未保存）。` + (notes.length ? notes.join('；') + '。' : '');
    preview(api.startIndex(), lead, false, T);
  }
  function editFromTimeline(op) { // {op: time | move | delete | raw, label, k, raw, to, at, t}
    if (!M) return;
    let ok = true;
    change(() => {
      const li = laneIndexOf(op.label, true), steps = li >= 0 ? M.lanes[li].steps : null;
      if (!steps || !steps[op.k] || steps[op.k].raw.trim() !== op.raw.trim()) { ok = false; return; }
      if (op.op === 'delete') steps.splice(op.k, 1);
      else if (op.op === 'raw') steps[op.k].raw = op.to;
      else if (op.op === 'time') { const o = splitStep(steps[op.k].raw), terms = o.cond ? o.cond.split(/\s*且\s*/).filter(x => !/^\d+:\d{2}$/.test(x.trim())) : []; o.cond = [api.fmt(op.at), ...terms].join(' 且 '); steps[op.k].raw = joinStep(o); }
      else if (op.op === 'move') {
        const ti = laneIndexOf(op.to, true); if (ti < 0) { ok = false; return; }
        const [st] = M.lanes[laneIndexOf(op.label, false)].steps.splice(op.k, 1), o = splitStep(st.raw);
        const terms = o.cond ? o.cond.split(/\s*且\s*/).filter(x => !/^\d+:\d{2}$/.test(x.trim())) : []; o.cond = [api.fmt(op.at), ...terms].join(' 且 ');
        const tsteps = M.lanes[ti].steps; let idx = window.UnifiedTimeline.stepIndexAt(op.to, op.at) + 1; if (idx <= 0) idx = tsteps.length;
        tsteps.splice(Math.min(idx, tsteps.length), 0, {raw: joinStep(o)});
      }
    });
    if (!ok) { S.undo.pop(); api.say('脚本和时间轴对不上了（可能刚改过），先等这次预演算完再改', true); return; }
    const what = {delete: '删掉了', raw: '改了', time: `改成最早 ${api.fmt(op.at || 0)} 开始：`, move: `改派给 ${op.to}：`}[op.op];
    preview(api.startIndex(), `${op.label} 的「${op.raw}」${what}（未保存）。`, false, Math.max(0, Math.floor(op.t || 0)));
  }
  function toggleMute(label) {
    if (!M) return;
    let head = '';
    change(() => { const li = laneIndexOf(label, true); if (li >= 0) { M.lanes[li].muted = !M.lanes[li].muted; head = (M.lanes[li].muted ? '暂停' : '恢复') + '「' + M.lanes[li].head + '」'; } });
    if (!head) return;
    preview(api.startIndex(), head + '（未保存）。', false, 0); // the whole game changes: from the start
  }
  function openCardOf(label, k) {
    const li = laneIndexOf(label, false); if (li < 0) return;
    api.showScript(); S.sel = {l: li, s: k}; render();
    const el = root.querySelector(`.sc[data-l="${li}"][data-s="${k}"]`); if (el) el.scrollIntoView({block: 'center', behavior: 'smooth'});
  }

  /* the plan that plays this script on a start: that start's layout + the text */
  async function planFor(start) {
    if (!M) return null;
    const name = '人族速矿二本 · ' + api.startName(start);
    try {
      const j = await api_('GET', '/api/strategies/' + encodeURIComponent(name));
      return j && j.ok ? {...j.plan, start, script: toText().text, name} : null;
    } catch (_) { return null; }
  }

  /* ---------- changes (with undo) ---------- */
  function change(fn, msg) {
    S.undo.push(JSON.stringify(M)); if (S.undo.length > 60) S.undo.shift();
    fn(); S.saved = false; S.timingKey = ''; render(); scheduleCheck();
    if (msg) api.say(msg);
  }
  function undo() {
    if (!S.undo.length) { api.say('没有可以撤销的修改'); return; }
    M = JSON.parse(S.undo.pop()); S.saved = false; S.sel = null; S.timingKey = ''; render(); scheduleCheck(); api.say('已撤销上一步修改');
  }
  function nextPeasant() {
    let n = 5;
    for (const ln of M.lanes) {
      for (const c of laneCids(ln.head)) n = Math.max(n, c);
      for (const s of ln.steps) { const m = /^农民(\d+)$/.exec(splitStep(s.raw).body); if (m) n = Math.max(n, +m[1]); }
    }
    return n + 1;
  }
  function ensurePeasantLane(n) {
    if (M.lanes.some(ln => laneCids(ln.head).includes(n))) return;
    const lastP = M.lanes.reduce((a, ln, i) => (laneKind(ln.head) === 'peasant' ? i : a), -1);
    M.lanes.splice(lastP + 1, 0, {head: '农民' + n, note: '', steps: [{raw: '伐木 主矿'}]});
    if (S.dropLane != null && S.dropLane > lastP) S.dropLane++;
  }
  function setTime(l, s, t) {
    const o = splitStep(M.lanes[l].steps[s].raw), mm = Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0');
    const terms = o.cond ? o.cond.split(/\s*且\s*/).filter(x => !/^\d+:\d{2}$/.test(x.trim())) : [];
    o.cond = [mm, ...terms].join(' 且 ');
    change(() => { M.lanes[l].steps[s].raw = joinStep(o); S.sel = {l, s}; },
      `「${o.body}」改成最早 ${mm} 开始（还要等上一步做完、其他条件满足）。点「预演」看新的时间`);
  }

  /* ---------- timing from a game: live, replay or preview ---------- */
  function source() {
    const L = api.live();
    if (L.on && L.state && L.state.script) return {kind: 'live', T: L.state.t, decisions: L.state.decisions || [], script: L.state.script, label: '实机'};
    if (L.replay && L.replay.state && L.replay.state.script) return {kind: L.replay.preview ? 'preview' : 'replay', T: L.replay.t, decisions: L.replay.state.decisions || [],
      script: L.replay.state.script, label: L.replay.preview ? '预演 · ' + api.startName(L.replay.state.start) : '回放', end: L.replay.end};
    const P = S.lastPreview; // 编排: the cards still show when each step began in the last preview
    if (P) return {kind: 'preview', T: P.t, decisions: P.decisions, script: P.script, label: '上次预演 · ' + api.startName(P.state.start), end: P.t};
    return null;
  }
  function timing() {
    const src = source();
    if (!src) return null;
    const key = src.kind + '|' + src.decisions.length + '|' + Math.floor(src.T) + '|' + S.undo.length + '|' + (src.end || '');
    if (key === S.timingKey) return S.timing;
    const byLabel = {};
    for (const d of src.decisions) {
      if (!/^L\d+$/.test(d.rule || '')) continue;
      const m = /^第 (\d+) 行第 (\d+) 步/.exec(d.why || ''), ci = (d.action || '').indexOf('：');
      if (m && ci > 0) {
        const r = byLabel[d.action.slice(0, ci)] || (byLabel[d.action.slice(0, ci)] = {starts: []}), k = +m[2] - 1;
        if (r.starts[k] == null) r.starts[k] = d.t;
        continue;
      }
      const dm = /^(.+) 不在了（阵亡）$/.exec(d.action || ''), km = /停在第 (\d+) 步/.exec(d.why || '');
      if (dm && km) (byLabel[dm[1]] || (byLabel[dm[1]] = {starts: []})).dead = {k: +km[1] - 1, t: d.t};
    }
    const runLanes = src.script.lanes || [];
    const lines = {}; for (const [n, ref] of Object.entries((src.kind === 'preview' && S.previewMap) || {})) if (ref.type === 'lane') lines[ref.i] = +n;
    const lanes = M.lanes.map((ln, i) => {
      const kind = laneKind(ln.head), cids = laneCids(ln.head);
      const match = runLanes.filter(x => x.kind === kind && (kind === 'peasant' ? cids.includes(+x.label.replace('农民', ''))
        : x.line === lines[i] || x.label === ln.head || (BT[ln.head] && api.name(BT[ln.head]) === x.label)));
      return ln.steps.map((st, k) => {
        const who = [];
        let stale = false;
        for (const x of match) {
          if (x.steps[k] !== st.raw.trim()) { // the card changed since that game: keep its old time, marked, while the lane still lines up
            if (x.steps.length !== ln.steps.length) continue;
            stale = true;
          }
          const r = byLabel[x.label] || {starts: []};
          let cur = -1; r.starts.forEach((t, j) => { if (t != null && t <= src.T) cur = j; });
          const dead = r.dead && r.dead.t <= src.T && r.dead.k === k;
          who.push({label: x.label, t: r.starts[k], state: dead ? 'dead' : k < cur ? 'done' : k === cur ? 'cur' : 'todo'});
        }
        const ts = who.map(w => w.t).filter(t => t != null && t <= src.T);
        return {t: ts.length ? Math.min(...ts) : null, who, matched: who.length > 0, stale};
      });
    });
    S.timing = {src, lanes}; S.timingKey = key;
    return S.timing;
  }
  function cardState(info) {
    if (!info || !info.matched) return '';
    if (info.stale) return 'stale';
    const st = info.who.map(w => w.state);
    if (st.includes('dead')) return 'dead';
    if (st.includes('cur')) return 'cur';
    if (st.every(s => s === 'done')) return 'done';
    return 'todo';
  }

  /* ---------- map markers (app.js draws them while this tab is open) ---------- */
  /* the layout the script plays on: 人族速矿二本 · <start> (fetched once per start), else what the console has loaded */
  const layouts = {};
  function layoutGroups(start) {
    if (!(start in layouts)) {
      layouts[start] = null;
      api_('GET', '/api/strategies/' + encodeURIComponent('人族速矿二本 · ' + api.startName(start)))
        .then(j => { if (j && j.ok) { layouts[start] = j.plan.groups; S.timingKey = ''; } }).catch(() => {});
    }
    return layouts[start] || api.groups();
  }
  function approxPositions() {
    const builds = layoutGroups(api.startIndex()).flatMap(g => g.children).filter(e => e.kind === 'build').sort((a, b) => a.start - b.start || (a.seq || 0) - (b.seq || 0));
    const pools = {};
    for (const e of builds) { const site = e.at || e.site; if (site) (pools[(e.near === 'natural' ? 'natural:' : '') + e.btype] = pools[(e.near === 'natural' ? 'natural:' : '') + e.btype] || []).push({site, exact: !!e.at}); }
    const hall = api.hall(), nat = api.natural(), memo = {};
    const toward = (a, b, d) => { const dx = b.x - a.x, dy = b.y - a.y, n = Math.hypot(dx, dy) || 1; return {x: a.x + dx / n * d, y: a.y + dy / n * d}; };
    function resolve(expr, depth) {
      const e = expr.replace(/\s+/g, '');
      let m;
      if ((m = /^布局\.(\D+?)(\d*)$/.exec(e))) { const p = (pools[BT[m[1]]] || [])[(+m[2] || 1) - 1]; return p && {x: p.site[0], y: p.site[1], exact: p.exact}; }
      if ((m = /^分矿\.(\D+)$/.exec(e))) { const p = (pools['natural:' + BT[m[1]]] || [])[0]; return p && {x: p.site[0], y: p.site[1], exact: p.exact}; }
      if (e === '本方向分矿') return nat && {x: nat.x, y: nat.y, exact: false};
      if ((m = /^分矿后方(\d+)$/.exec(e))) {
        if (!nat) return null;
        const h = (pools['natural:htow'] || [])[0], hp = h ? {x: h.site[0], y: h.site[1]} : nat;
        return {...toward(nat, hp, Math.hypot(hp.x - nat.x, hp.y - nat.y) + +m[1]), exact: false};
      }
      if ((m = /^坐标(-?\d+)[,，](-?\d+)$/.exec(e))) return {x: +m[1], y: +m[2], exact: true};
      if ((m = /^(\S+?)前方(\d+)$/.exec(e)) && depth < 4) { const b = get(m[1], depth + 1); return b && {...toward(b, hall, +m[2]), exact: false}; }
      return null;
    }
    function get(name, depth) {
      if (name in memo) return memo[name];
      const p = M.positions.find(q => q.name === name);
      return (memo[name] = p ? resolve(p.expr, depth) : null);
    }
    const out = {}; for (const p of M.positions) { const r = get(p.name, 0); if (r) out[p.name] = r; }
    return out;
  }
  function markers() {
    if (!M) return [];
    const src = source(), start = api.startIndex();
    const fromGame = !editing() && src && src.script.positions && (src.kind === 'live' || api.live().replay.state.start === start) ? src.script.positions : null;
    const approx = approxPositions();
    return M.positions.map(p => {
      const g = fromGame && fromGame[p.name], a = approx[p.name];
      const at = /^坐标/.test(p.expr.trim()) || S.movedPos.has(p.name) ? a : g ? {x: g[0], y: g[1], exact: true} : a;
      return at && {name: p.name, x: at.x, y: at.y, exact: !!at.exact || !!g, editable: /^坐标/.test(p.expr.trim()), sel: S.selPos === p.name};
    }).filter(Boolean);
  }
  /* ---------- build sites on the sandbox: every 建造 card has one ---------- */
  function runEvents() { // the game the cards follow: its events by "lane label|step"
    const L = api.live(), st = L.on && L.state ? L.state : L.replay ? L.replay.state : null;
    if (!st || !st.script) return null;
    const map = {};
    for (const d of st.arbEvents || []) if (d.phase != null && d.step != null) map[d.phase + '|' + d.step] = {d, rt: (st.events || {})[d.id] || {}};
    return {map, T: L.on ? L.state.t : L.replay.t};
  }
  function sites() {
    if (!M) return [];
    const run = editing() ? null : runEvents(), mk = Object.fromEntries(markers().map(m => [m.name, m])), out = [];
    M.lanes.forEach((ln, l) => {
      const labels = laneKind(ln.head) === 'peasant' ? laneCids(ln.head).map(c => '农民' + c) : [];
      ln.steps.forEach((st, s) => {
        const o = splitStep(st.raw), what = o.body.split(' ')[1] || '', btype = o.act === '建造' && BT[what];
        if (!btype) return;
        let x = null, y = null, exact = false, state = 'plan';
        const r = run && !S.moved.has(l + '|' + s) && labels.map(lb => run.map[lb + '|' + s]).find(Boolean);
        if (r) {
          if (r.rt.bStart != null && r.rt.bStart <= run.T) return; // standing on the map already
          const p = r.rt.builtAt || (o.pos === '自动' ? null : r.d.at || r.d.site); // @自动: the game picks the spot, known once built
          if (p && !(o.pos && S.movedPos.has(o.pos))) { x = p[0]; y = p[1]; exact = !!r.d.at; state = r.d.start <= run.T ? 'ordered' : 'plan'; }
        }
        if (x == null) { const m = o.pos && mk[o.pos]; if (!m) { if (editing() && o.pos === '自动' || !o.pos) out.push({l, s, btype, auto: true, label: (labels[0] || ln.head) + ' · ' + what}); return; } x = m.x; y = m.y; exact = m.exact; }
        out.push({l, s, btype, x, y, exact, state, pos: o.pos, label: (labels[0] || ln.head) + (labels.length > 1 ? '…' : '') + ' · ' + what + (o.pos && o.pos !== '自动' ? ' @' + o.pos : ''),
          sel: !!(S.sel && S.sel.l === l && S.sel.s === s)});
      });
    });
    return out;
  }
  /* a card or lane picked in the script: show it on the sandbox */
  function focusFor(l, s) {
    const ln = M.lanes[l], kind = laneKind(ln.head), v = api.view();
    if (s != null) {
      const site = sites().find(x => x.l === l && x.s === s);
      if (site && site.auto) {
        S.placing = {l, s, btype: site.btype};
        api.say(`「${site.label}」是自动选址（游戏自己找地方）。在沙盘上点一下给它定位置；按 Esc 取消。`);
        return;
      }
      if (site) { api.focus(site.x, site.y); return; }
      const o = splitStep(ln.steps[s].raw), mk = o.pos && markers().find(m => m.name === o.pos);
      if (mk && !/^(采金|伐木)$/.test(o.act)) { S.selPos = mk.name; api.focus(mk.x, mk.y); return; }
    }
    if (kind === 'peasant') {
      const cids = laneCids(ln.head), u = v.units.find(x => cids.includes(x.id) && !x.hidden) || v.units.find(x => cids.includes(x.id));
      if (u) { api.pickUnit(u.id); return; }
      api.say(`${ln.head} 这时${v.t > 0 ? '不在地图上（还没出生、在金矿里或已阵亡）' : '还没出生'}`);
      return;
    }
    if (kind === 'hero') { const u = v.units.find(x => x.type === {大法师: 'Hamg', 山丘之王: 'Hmkg'}[ln.head]); if (u) api.pickUnit(u.id); else api.say(`${ln.head} 这时还没出生`); return; }
    const tag = ln.head.startsWith('#') ? ln.head.slice(1) : null;
    if (tag) { // the building that step named
      for (const [i, x] of M.lanes.entries()) for (const [k, st] of x.steps.entries()) if (splitStep(st.raw).tag === tag) {
        const site = sites().find(q => q.l === i && q.s === k); if (site && !site.auto) { api.focus(site.x, site.y); return; }
      }
    }
    const types = tag ? [] : BT[ln.head] === 'htow' ? ['htow', 'hkee', 'hcas'] : [BT[ln.head]];
    const b = v.buildings.find(x => types.includes(x.type));
    if (b) api.pickBuilding(b.id); else if (!tag) api.say(`${ln.head} 这时还没建好`);
  }
  function selectStep(l, s) {
    if (!S.active) api.showScript();
    S.sel = s == null ? {l} : {l, s}; render();
    const el = root.querySelector(s == null ? `.se-lab[data-l="${l}"]` : `.sc[data-l="${l}"][data-s="${s}"]`);
    if (el) el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  }
  function selectUnit(u) { // a unit clicked on the sandbox: its lane in the script
    if (!M || !u) return;
    const hero = {Hamg: '大法师', Hmkg: '山丘之王'}[u.type];
    const l = M.lanes.findIndex(ln => (hero ? ln.head === hero : laneCids(ln.head).includes(u.id)));
    if (l < 0) return;
    S.sel = {l}; if (S.active) { render(); const el = root.querySelector(`.se-lab[data-l="${l}"]`); if (el) el.scrollIntoView({block: 'nearest', behavior: 'smooth'}); }
  }
  /* a build site dragged on the sandbox: the layout (布局./分矿. places, this start only), the
   * place's coordinates (坐标), or else a new 坐标 place for that card */
  async function moveSite(l, s, p) {
    const st = M.lanes[l].steps[s], o = splitStep(st.raw), what = o.body.split(' ')[1], btype = BT[what];
    const q = o.pos && M.positions.find(x => x.name === o.pos), expr = q ? q.expr.replace(/\s+/g, '') : '';
    const lay = /^布局\.(\D+?)(\d*)$/.exec(expr), nat = /^分矿\.(\D+)$/.exec(expr);
    const [x, y] = p.map(Math.round);
    if (lay || nat) {
      const key = lay ? BT[lay[1]] : 'natural:' + BT[nat[1]], idx = lay ? (+lay[2] || 1) - 1 : 0;
      const start = api.startIndex(), name = '人族速矿二本 · ' + api.startName(start);
      let j; try { j = await api_('GET', '/api/strategies/' + encodeURIComponent(name)); } catch (_) { j = null; }
      if (!j || !j.ok) { api.say('读不到布局「' + name + '」，没改', true); return; }
      const builds = j.plan.groups.flatMap(g => g.children).filter(e => e.kind === 'build' && (e.near === 'natural' ? 'natural:' : '') + e.btype === key)
        .sort((a, b) => a.start - b.start || (a.seq || 0) - (b.seq || 0));
      const e = builds[idx];
      if (!e) { api.say(`布局「${name}」里没有第 ${idx + 1} 个${what}`, true); return; }
      e.at = [x, y]; e.site = [x, y];
      let r; try { r = await api_('PUT', '/api/strategies/' + encodeURIComponent(name), j.plan); } catch (_) { r = null; }
      if (!r || !r.ok) { api.say('布局没保存：' + ((r && r.error) || '连不上本地服务'), true); return; }
      layouts[start] = j.plan.groups; S.movedPos.add(o.pos); S.timingKey = '';
      api.say(`「${o.pos}」（${q.expr}）移到 ${x},${y}：已存进布局「${name}」，只影响${api.startName(start)}，四个方向的脚本还是同一份。`);
    } else if (q && /^坐标/.test(expr)) {
      change(() => { q.expr = `坐标 ${x},${y}`; S.movedPos.add(q.name); }, `「${q.name}」移到 ${x},${y}`);
    } else {
      let n = 1; while (M.positions.some(z => z.name === what + n)) n++;
      const nm = what + n;
      change(() => {
        M.positions.push({name: nm, expr: `坐标 ${x},${y}`, note: '在沙盘上放的，只对' + api.startName(api.startIndex()) + '准确'});
        o.pos = nm; st.raw = joinStep(o); S.moved.add(l + '|' + s); S.sel = {l, s};
      }, `${M.lanes[l].head} 的${what}放在 ${x},${y}，新建位置「${nm}」（坐标写死，只对${api.startName(api.startIndex())}准确）`);
    }
    S.moved.add(l + '|' + s);
    if (!S.demo) return; // 编排: the player previews when ready
    const lead = document.getElementById('msg') ? document.getElementById('msg').textContent + ' ' : '';
    clearTimeout(S.repreview); S.repreview = setTimeout(() => preview(api.startIndex(), lead, true), 1500); // a demo replays with the move
  }
  function onMap() { const L = api.live(); return !!M && (S.active || (L.replay && L.replay.preview) || (L.on && L.state && L.state.script)); }

  function markerAt(wx, wy, r) {
    let best = null, bd = r;
    for (const m of markers()) { const d = Math.hypot(m.x - wx, m.y - wy); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  function moveMarker(name, x, y) {
    const p = M.positions.find(q => q.name === name); if (!p) return;
    const sx = Math.round(x / 32) * 32, sy = Math.round(y / 32) * 32;
    change(() => { p.expr = `坐标 ${sx},${sy}`; }, `位置「${name}」移到 ${sx},${sy}（坐标写死，只对这个出生点准确）`);
  }
  function selectPos(name) {
    S.selPos = name; S.open = true; render();
    const el = root.querySelector(`.se-pos [data-name="${CSS.escape(name)}"]`); if (el) el.scrollIntoView({block: 'nearest'});
    const p = M.positions.find(q => q.name === name);
    api.say(`位置「${name}」= ${p ? p.expr : '?'}` + (p && !/^坐标/.test(p.expr) ? '。布局里的工地在地图上直接拖（改的是这个出生点的布局，记得点上面的「保存」）；这里只有「坐标 x,y」的位置能拖。' : ''));
  }

  /* ---------- rendering ---------- */
  function cardHTML(raw, info) {
    const o = splitStep(raw);
    const who = info && info.who.length > 1 ? `<span class="who">${info.who.map(w => `<i class="${w.state}" title="${esc(w.label)}">${esc(w.label.replace('农民', ''))}</i>`).join('')}</span>` : '';
    return (o.cond ? `<span class="c" title="开始条件">${esc(o.cond)}</span>` : '') + `<b>${esc(o.body)}</b>` +
      (o.pos ? `<span class="p">@${esc(o.pos)}</span>` : '') + (o.tag ? `<span class="g">#${esc(o.tag)}</span>` : '') +
      `<button type="button" class="x" data-del title="删除这一步" aria-label="删除这一步">×</button>` +
      (info && info.t != null ? `<span class="tm" title="${info.stale ? '改过：这是改之前的时间，点「预演」更新' : '这一步开始的时间'}">${api.fmt(info.t)}${info.stale ? '?' : ''}</span>` : '') + who;
  }
  function render() {
    if (!root || !M) return;
    const T = timing(), src = T && T.src, time = S.view === 'time' && !!T;
    const errN = S.errors.general.length + Object.keys(S.errors.lane).length + Object.keys(S.errors.pos).length + Object.keys(S.errors.res).length;
    let h = `<div class="se-top"><div class="se-bar">
      <span class="seg"><button type="button" data-view="flow" class="${S.view === 'flow' ? 'on' : ''}">顺序</button><button type="button" data-view="time" class="${S.view === 'time' ? 'on' : ''}" ${T ? '' : 'disabled title="先点「预演」，或连接游戏 / 打开回放"'}>时间</button></span>
      <button type="button" class="btn ${S.demo ? '' : 'on'}" data-act="preview" ${S.busy ? 'disabled' : ''} title="在假游戏里跑这份脚本，沙盘从 0:00 演示">${S.busy ? '预演中…' : (S.demo ? '重新预演' : '▶ 预演') + '（' + esc(api.startName(api.startIndex())) + '）'}</button>
      ${S.demo ? '<button type="button" class="btn on" data-act="edit" title="停止演示，回到可以拖工地的编排状态">回到编排</button>' : '<span class="se-mode">编排中：沙盘上的工地可以拖</span>'}
      <button type="button" class="btn ${S.saved ? '' : 'on'}" data-act="save">保存</button>
      <button type="button" class="btn" data-act="undo" ${S.undo.length ? '' : 'disabled'}>撤销</button>
      <button type="button" class="btn ${S.showText ? 'on' : ''}" data-act="text">文本</button>
      <span class="se-state ${errN ? 'bad' : S.saved ? '' : 'warn'}">${errN ? errN + ' 处要改' : S.saved ? '已保存' : '未保存'}</span>
      <span class="zoomctl" title="缩放：「时间」视图拉宽时间轴，「顺序」视图放大卡片；也可以按住 Ctrl（Mac 用 ⌘）在卡片区滚动滚轮">
        <button class="btn" type="button" data-z="-" aria-label="缩小">－</button><b>${Math.round((time ? S.zoom : S.cardZoom) * 100)}%</b><button class="btn" type="button" data-z="+" aria-label="放大">＋</button><button class="btn" type="button" data-z="0">适应</button></span>
      <span class="se-src">${src ? '时间来自：' + esc(src.label) + ' · ' + api.fmt(src.T) : '还没有时间：点「预演」'}</span></div>`;
    h += '<div class="se-pal"><span class="hint">拖到一行里（或先点一行再点这里）：</span>' + PALETTE.map(([kind, items]) =>
      `<span class="grp"><em>${KIND_NAME[kind]}</em>${items.map(r => `<span class="chip-step k-${stepClass(r)}" draggable="true" data-raw="${esc(r)}" data-kind="${kind}">${esc(r === '农民N' ? '农民（新编号）' : r)}</span>`).join('')}</span>`).join('') + '</div>';
    h += `<div class="se-errs">${errorsHTML()}</div></div>`;
    h += `<div class="se-main"><div class="se-lanes ${time ? 'time' : 'flow'}" style="--z:${S.zoom};--cz:${S.cardZoom}">`;
    if (time) {
      h += '<div class="se-row ruler"><div class="se-lab hint">一行 ／ 时间</div><div class="se-track">';
      for (let t = 0; t < T_END; t += S.zoom >= 4 ? 10 : S.zoom >= 2 ? 30 : 60) h += `<span class="tick" style="left:${pct(t)}">${api.fmt(t)}</span>`;
      h += `<span class="now" style="left:${pct(src.T)}"></span></div></div>`;
    }
    for (const [kind, title] of SECTIONS) {
      h += `<div class="se-sec"><span>${title}</span><button type="button" class="link" data-act="addlane" data-kind="${kind}">＋ 加一行</button></div>`;
      for (const {ln, i} of lanesOf(kind)) {
        const err = S.errors.lane[i], selL = S.sel && S.sel.l === i;
        const timedInfo = T ? T.lanes[i] : null;
        h += `<div class="se-row k-${kind} ${selL && S.sel.s == null ? 'sel' : ''} ${err ? 'err' : ''} ${ln.muted ? 'muted' : ''}" data-l="${i}">`;
        h += `<div class="se-lab" data-l="${i}" title="${esc((ln.note ? ln.note + '\n' : '') + (err ? err.join('\n') : '点一下编辑这一行'))}"><b>${esc(ln.head)}</b>` +
          (ln.note ? '<i class="note">注</i>' : '') + (err ? '<i class="bad">!</i>' : '') +
          `<button type="button" class="x" data-dellane="${i}" title="删除这一行" aria-label="删除 ${esc(ln.head)} 这一行">×</button></div>`;
        h += `<div class="se-track" data-l="${i}">`;
        let hidden = 0;
        ln.steps.forEach((st, s) => {
          const info = timedInfo && timedInfo[s], cls = `sc k-${stepClass(st.raw)} ${cardState(info)} ${selL && S.sel.s === s ? 'sel' : ''}`;
          if (time) {
            if (!info || info.t == null) { hidden++; return; }
            const next = timedInfo.slice(s + 1).find(x => x && x.t != null), end = next ? next.t : src.T;
            h += `<div class="${cls}" data-l="${i}" data-s="${s}" style="left:${pct(info.t)};width:max(${MIN_W}px, calc(${pct(end)} - ${pct(info.t)}))" title="${esc(st.raw)}">${cardHTML(st.raw, info)}</div>`;
          } else {
            h += `<div class="${cls}" draggable="true" data-l="${i}" data-s="${s}" title="${esc(st.raw)}">${cardHTML(st.raw, info)}</div>`;
          }
        });
        if (time && hidden) h += `<span class="se-more" title="还没开始的步骤；切到「顺序」看全部">+${hidden} 步未开始</span>`;
        if (!time) h += `<button type="button" class="se-add" data-l="${i}" title="在这一行最后加一步">＋</button>`;
        h += '</div></div>';
      }
    }
    h += '</div>';
    h += `<aside class="se-side">${editorHTML() || '<div class="se-edit empty"><div class="ttl">编辑</div><div class="hint">点一张卡片改它的条件、动作、位置；点左边的名字改这一行（谁、备注、上下移、删除）。卡片和名字右上角的 × 直接删除，Ctrl+Z 撤销。</div></div>'}</aside></div>`;
    h += positionsHTML();
    h += reservesHTML();
    if (S.showText) h += `<div class="se-textbox"><textarea spellcheck="false" id="seText">${esc(S.textDraft != null ? S.textDraft : toText().text)}</textarea>
      <div><button type="button" class="btn" data-act="fromtext">按文本更新卡片</button><span class="hint">直接改文本也行；更新时会检查写法。</span></div></div>`;
    h += `<div class="hint se-help">卡片从左到右一件一件做；方括号是这一步的开始条件（最早时间、资源、#建筑 开工/完成、大法师剩余 ≤ 集合用时…）。` +
      `写在上面的行先花钱。拖卡片调整先后或换给别人；在「时间」视图里左右拖一张卡片 = 给它加「到这个时间才开始」。` +
      `地图上的菱形是脚本里的位置。保存写回 strategies/战术脚本-人族速矿二本.txt，下一局按它打。</div>`;
    const old = root.querySelector('.se-lanes'), sx = S.pendingScroll != null ? S.pendingScroll : old ? old.scrollLeft : 0;
    root.innerHTML = h;
    S.textDraft = null; S.pendingScroll = null;
    const nl = root.querySelector('.se-lanes'); if (nl) nl.scrollLeft = sx;
    const top = root.querySelector('.se-top'); // the side editor sticks just below the sticky toolbar
    if (top) root.style.setProperty('--se-top', top.offsetHeight + 8 + 'px');
  }
  /* every mistake, named by the lane or place it is in; a click selects that lane */
  function errorsHTML() {
    const E = S.errors, out = [];
    for (const [i, es] of Object.entries(E.lane)) if (M.lanes[i]) for (const e of es) out.push(`<button type="button" class="link bad" data-errlane="${i}">${esc(M.lanes[i].head)}：${esc(e)}</button>`);
    for (const [i, es] of Object.entries(E.pos)) if (M.positions[i]) for (const e of es) out.push(`<div>位置 ${esc(M.positions[i].name)}：${esc(e)}</div>`);
    for (const [i, es] of Object.entries(E.res)) for (const e of es) out.push(`<div>留钱第 ${+i + 1} 条：${esc(e)}</div>`);
    return out.concat(E.general.map(e => `<div>${esc(e)}</div>`)).join('');
  }
  function editorHTML() {
    if (!S.sel || !M.lanes[S.sel.l]) return '';
    const ln = M.lanes[S.sel.l], kind = laneKind(ln.head);
    if (S.sel.s == null || !ln.steps[S.sel.s]) {
      return `<div class="se-edit"><div class="ttl">编辑这一行 · ${KIND_NAME[kind]}</div>
        <label>谁<input data-f="head" value="${esc(ln.head)}" placeholder="农民9、10、12 ／ 城镇大厅 ／ #分基地 ／ 大法师"></label>
        <label>备注<input data-f="note" value="${esc(ln.note)}" placeholder="写给自己看的说明（存成注释）"></label>
        <div class="row"><button type="button" class="btn" data-act="laneup">上移</button><button type="button" class="btn" data-act="lanedown">下移</button>
        <button type="button" class="btn" data-act="lanemute">${ln.muted ? '恢复执行' : '暂停这一行'}</button><button type="button" class="btn" data-act="lanedup">复制这一行</button>${laneCids(ln.head).length > 1 ? '<button type="button" class="btn" data-act="lanesplit" title="每个人一行，之后可以分别派不同的任务">拆成每人一行</button>' : ''}<button type="button" class="btn bad" data-act="lanedel">删除这一行</button>
        <span class="hint">上面的行先花钱；农民行、建筑行、英雄行各自排序。</span></div></div>`;
    }
    return stepEditorHTML(ln, kind);
  }
  function stepEditorHTML(ln, kind) {
    const s = S.sel.s, raw = ln.steps[s].raw, f = stepFields(raw, kind), names = M.positions.map(p => p.name);
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const sel = (name, list, cur) => `<select data-sf="${name}">${list.map(x => Array.isArray(x) ? opt(x[0], x[1], cur) : opt(x, x, cur)).join('')}${cur && !list.some(x => (Array.isArray(x) ? x[0] : x) === cur) ? opt(cur, cur + '（不在列表里）', cur) : ''}</select>`;
    const acts = ACTS[kind], desc = (acts.find(a => a[0] === f.act) || [])[1] || '';
    const posSel = (cur, auto) => `<select data-sf="pos">${auto ? opt('自动', '自动（游戏自己找地方）', cur) : opt('', '（选一个位置）', cur)}${names.map(n => opt(n, '@' + n, cur)).join('')}${cur && cur !== '自动' && !names.includes(cur) ? opt(cur, '@' + cur + '（没定义）', cur) : ''}</select>`;
    let params = '';
    switch (f.act) {
      case '采金': case '伐木': params = `<label>在哪<span class="seg">${['主矿', '分矿'].map(m => `<button type="button" data-sfv="mine" data-v="${m}" class="${f.mine === m ? 'on' : ''}">${m}</button>`).join('')}</span></label>`; break;
      case '建造':
        params = `<label>建什么${sel('bname', BUILD_LIST, f.bname)}</label><label>建在哪<span class="pair">${posSel(f.pos || '自动', true)}<button type="button" class="btn" data-act="pickmap" title="在沙盘上点一下放这座建筑">沙盘点选</button></span></label>
          <label>起名<input data-sf="tag" value="${esc(f.tag || '')}" placeholder="起个名，别人才能协助它、等它开工/完成"></label>`; break;
      case '协助': {
        const list = builds().filter(b => b.verb === '建造' && !(b.l === S.sel.l && b.s === s));
        params = `<label>帮谁<select data-sf="assist"><option value="">（选一座要帮忙建的建筑）</option>${list.map(b => b.tag
          ? opt(b.tag, `#${b.tag} · ${b.who} 建造 ${b.what}`, f.tag) : opt(`new:${b.l}:${b.s}`, `${b.who} 建造 ${b.what}（还没起名，选它会自动起名）`, '')).join('')}${f.tag && !list.some(b => b.tag === f.tag) ? opt(f.tag, '#' + f.tag + '（脚本里没人建它）', f.tag) : ''}</select></label>`; break;
      }
      case '集合': case '待命': case '清野': case '攻击移动': case '移动': params = `<label>位置${posSel(f.pos || '', false)}</label>`; break;
      case '农民': params = `<label>编号<input type="number" min="6" data-sf="peasant" value="${f.peasant || 6}"></label>`; break;
      case '训练': params = `<label>训练${sel('unit', UNIT_LIST, f.unit)}</label><label>几个<input type="number" min="1" max="12" data-sf="count" value="${f.count || 1}"></label>`; break;
      case '集结点': params = `<label>集结到${sel('rally', [...names.map(n => ['@' + n, '@' + n]), ['大法师', '跟着大法师'], ['山丘之王', '跟着山丘之王']], f.rally)}</label>`; break;
      case '升级': params = `<label>升级成${sel('to', UPGRADE_LIST, f.to)}</label><label>起名<input data-sf="tag" value="${esc(f.tag || '')}" placeholder="例如 主城，别处等它 #主城 完成"></label>`; break;
      case '学': params = `<label>技能${sel('skill', SKILL_LIST, f.skill)}</label>`; break;
    }
    // conditions: chips, and a builder for one more
    const terms = condTerms(f.cond), tags = [...new Set(builds().map(b => b.tag).filter(Boolean))], ct = S.condType || 'time';
    const ctInputs = {
      time: `<input data-cv="time" value="1:30" size="5" aria-label="几分几秒">`,
      res: `金<input data-cv="gold" type="number" value="385" min="0" step="5"> 木<input data-cv="wood" type="number" value="205" min="0" step="5">`,
      started: `<select data-cv="tag">${tags.map(t => opt(t, '#' + t, '')).join('') || '<option value="">（先给要等的建筑起名）</option>'}</select>`,
      done: `<select data-cv="tag">${tags.map(t => opt(t, '#' + t, '')).join('') || '<option value="">（先给要等的建筑起名）</option>'}</select>`,
      hero: `<select data-cv="hero">${opt('大法师', '大法师', '')}${opt('山丘之王', '山丘之王', '')}</select>`,
      eta: '', clear: '', food: `剩 ≤ <input data-cv="food" type="number" value="4" min="0" max="20">`,
    }[ct];
    const conds = `<div class="conds">${terms.length ? terms.map((t, i) => `<span class="cchip">${esc(t)}<button type="button" class="x" data-delcond="${i}" aria-label="去掉这个条件">×</button></span>`).join('<i>且</i>')
      : '<span class="hint">没有条件：上一步做完马上开始</span>'}</div>
      <div class="addcond"><select data-ct="1">${COND_TYPES.map(([k, v]) => opt(k, v, ct)).join('')}</select>${ctInputs}<button type="button" class="btn" data-act="addcond">加上</button></div>`;
    // the same step for other lanes of this kind
    const others = M.lanes.map((x, i) => ({x, i})).filter(({x, i}) => i !== S.sel.l && laneKind(x.head) === kind);
    const share = others.length ? `<div class="sub">也派给</div><div class="share">${others.map(({x, i}) => `<label class="ck"><input type="checkbox" data-share="${i}">${esc(x.head)}</label>`).join('')}</div>
      <div class="row"><select data-share-at="1">${opt('same', '放在他们的第 ' + (s + 1) + ' 步', 'same')}${opt('end', '放在他们最后', '')}</select><button type="button" class="btn" data-act="share">派出</button>
      <span class="hint">每人一份，之后可以分别改。</span></div>` : '';
    return `<div class="se-edit"><div class="ttl">${esc(ln.head)} · 第 ${s + 1} 步</div>
      <label>做什么<select data-sf="act">${acts.map(([a]) => opt(a, a, f.act)).join('')}${acts.some(a => a[0] === f.act) ? '' : opt(f.act, f.act + '（看不懂）', f.act)}</select></label>
      <div class="hint desc">${esc(desc)}</div>${params}
      <div class="sub">什么时候开始</div>${conds}
      <label>整步<input data-f="raw" value="${esc(raw)}" spellcheck="false" title="也可以直接改这一步的文字"></label>
      ${share}
      <div class="row"><button type="button" class="btn" data-act="stepbefore">前面插一步</button><button type="button" class="btn" data-act="stepdup">复制一份</button>
      <button type="button" class="btn bad" data-act="stepdel">删除这一步</button><span class="hint">Delete 删、Ctrl+Z 撤销。</span></div></div>`;
  }
  function positionsHTML() {
    const rows = M.positions.map((p, i) => `<div class="se-prow ${S.errors.pos[i] ? 'err' : ''} ${S.selPos === p.name ? 'sel' : ''}" data-pi="${i}" data-name="${esc(p.name)}">
      <input data-pf="name" value="${esc(p.name)}" aria-label="位置名"><span>=</span><input data-pf="expr" list="seExpr" value="${esc(p.expr)}" aria-label="在哪">
      <input data-pf="note" value="${esc(p.note)}" placeholder="备注" aria-label="备注"><button type="button" class="link" data-act="posshow">地图</button><button type="button" class="link bad" data-act="posdel">删</button>
      ${S.errors.pos[i] ? `<div class="bad">${esc(S.errors.pos[i].join('；'))}</div>` : ''}</div>`).join('');
    return `<details class="se-pos" ${S.open ? 'open' : ''}><summary>位置（${M.positions.length}）· 地图上的菱形</summary>
      <datalist id="seExpr">${EXPR_HINTS.map(x => `<option value="${esc(x)}">`).join('')}</datalist>${rows}
      <button type="button" class="link" data-act="posadd">＋ 新位置</button>
      <div class="hint">「布局.农场1」取自当前出生点的布局（四个方向通用）；「坐标 x,y」写死，只有它能在地图上拖。改名会同时改掉引用它的 @名字。</div></details>`;
  }
  function reservesHTML() {
    const rows = M.reserves.map((r, i) => `<div class="se-prow ${S.errors.res[i] ? 'err' : ''}" data-ri="${i}"><input data-rf="raw" value="${esc(r.raw)}" aria-label="留钱">
      <input data-rf="note" value="${esc(r.note)}" placeholder="备注" aria-label="备注"><button type="button" class="link bad" data-act="resdel">删</button>
      ${S.errors.res[i] ? `<div class="bad">${esc(S.errors.res[i].join('；'))}</div>` : ''}</div>`).join('');
    return `<details class="se-res" open><summary>留钱（${M.reserves.length}）</summary>${rows}
      <button type="button" class="link" data-act="resadd">＋ 留钱</button>
      <div class="hint">「留钱 金385 木205 给 #分基地 从 [清野 完成]」：从条件满足到 #分基地 开工，这笔钱不给排在它后面的事花（按采集速度，不会让它更晚的花费照常放行）。</div></details>`;
  }
  function showErrors() {
    if (!root) return;
    const errN = S.errors.general.length + Object.keys(S.errors.lane).length + Object.keys(S.errors.pos).length + Object.keys(S.errors.res).length;
    const st = root.querySelector('.se-state');
    if (st) { st.className = 'se-state ' + (errN ? 'bad' : S.saved ? '' : 'warn'); st.textContent = errN ? errN + ' 处要改' : S.saved ? '已保存' : '未保存'; }
    const box = root.querySelector('.se-errs'); if (box) box.innerHTML = errorsHTML();
    root.querySelectorAll('.se-row[data-l]').forEach(r => {
      const e = S.errors.lane[+r.dataset.l]; r.classList.toggle('err', !!e);
      const lab = r.querySelector('.se-lab'); let b = lab.querySelector('.bad');
      if (e && !b) { b = document.createElement('i'); b.className = 'bad'; b.textContent = '!'; lab.appendChild(b); }
      if (!e && b) b.remove();
      lab.title = (M.lanes[+r.dataset.l].note || '') + (e ? '\n' + e.join('\n') : '');
    });
    root.querySelectorAll('.se-pos .se-prow').forEach(r => r.classList.toggle('err', !!S.errors.pos[+r.dataset.pi]));
    root.querySelectorAll('.se-res .se-prow').forEach(r => r.classList.toggle('err', !!S.errors.res[+r.dataset.ri]));
  }
  /* live / replay: only the cards' state and times change, so update them in place (no re-render) */
  function refresh() {
    if (!root || !M) return;
    const T = timing();
    if (!T) return;
    if (S.view === 'time') { if (!root.contains(document.activeElement) || document.activeElement === document.body) render(); return; }
    root.querySelectorAll('.sc[data-l]').forEach(el => {
      const l = +el.dataset.l, s = +el.dataset.s, info = T.lanes[l] && T.lanes[l][s];
      const st = cardState(info);
      for (const c of ['done', 'cur', 'dead', 'todo', 'stale']) el.classList.toggle(c, c === st);
      const html = cardHTML(M.lanes[l].steps[s].raw, info); if (el.innerHTML !== html) el.innerHTML = html;
    });
    const sr = root.querySelector('.se-src'); if (sr) sr.textContent = '时间来自：' + T.src.label + ' · ' + api.fmt(T.src.T);
  }

  /* ---------- zoom ---------- */
  function setZoom(z, clientX) {
    const lanes = root.querySelector('.se-lanes');
    if (S.view === 'time' && timing()) { // the time axis gets wider; keep the moment under the mouse
      z = Math.max(1, Math.min(8, z));
      const r = lanes.getBoundingClientRect(), lab = parseFloat(getComputedStyle(lanes).getPropertyValue('--label')) || 184;
      const mx = (clientX == null ? r.left + (r.width + lab) / 2 : clientX) - r.left, x = lanes.scrollLeft + mx;
      S.pendingScroll = Math.max(0, (x < lab ? x : lab + (x - lab) * z / S.zoom) - mx);
      S.zoom = z; store.set('wcc.seZoom', z);
    } else {
      S.cardZoom = Math.max(0.7, Math.min(1.5, z)); store.set('wcc.seCardZoom', S.cardZoom);
    }
    render();
  }
  function stepZoom(d) {
    const time = S.view === 'time' && timing(), list = time ? ZOOMS : CARD_ZOOMS, z = time ? S.zoom : S.cardZoom;
    if (d === 0) return setZoom(1);
    setZoom(d > 0 ? list.find(x => x > z + 1e-6) || list[list.length - 1] : [...list].reverse().find(x => x < z - 1e-6) || list[0]);
  }
  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey) || !e.target.closest('.se-lanes')) return;
    e.preventDefault();
    const f = Math.min(1.15, Math.max(1 / 1.15, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 0.002)));
    setZoom((S.view === 'time' && timing() ? S.zoom : S.cardZoom) * f, e.clientX);
  }

  /* ---------- the step editor's choices ---------- */
  function touched() {
    S.saved = false; S.timingKey = ''; scheduleCheck();
    const st = root.querySelector('.se-state'); if (st && !st.classList.contains('bad')) { st.className = 'se-state warn'; st.textContent = '未保存'; }
  }
  function cardInPlace(l, s) {
    const raw = M.lanes[l].steps[s].raw, card = root.querySelector(`.sc[data-l="${l}"][data-s="${s}"]`);
    if (card) { card.innerHTML = cardHTML(raw, null); card.className = card.className.replace(/k-\w+/, 'k-' + stepClass(raw)); }
    const box = root.querySelector('.se-edit input[data-f="raw"]'); if (box && document.activeElement !== box) box.value = raw;
  }
  function setField(name, value, redraw) { // one choice changed: rewrite the card from the editor's fields
    const {l, s} = S.sel, ln = M.lanes[l], kind = laneKind(ln.head);
    if (!S.editing) { S.undo.push(JSON.stringify(M)); if (S.undo.length > 60) S.undo.shift(); }
    S.editing = !redraw;
    let f = stepFields(ln.steps[s].raw, kind), msg = '';
    if (name === 'act') f = {cond: f.cond, act: value};
    else if (name === 'assist') {
      if (value.startsWith('new:')) { const [, bl, bs] = value.split(':').map(Number); value = nameBuild(bl, bs); msg = `给 ${M.lanes[bl].head} 建的那座起名 #${value}，${ln.head} 去协助它`; }
      f.tag = value;
    } else f[name] = name === 'peasant' || name === 'count' ? Math.max(1, parseInt(value, 10) || 1) : value;
    ln.steps[s].raw = composeStep(f);
    if (redraw && f.act === '农民' && f.peasant) { const before = M.lanes.length; ensurePeasantLane(f.peasant); if (M.lanes.length > before) msg = `农民${f.peasant} 还没有自己的一行，已加在农民那一栏（先写成「伐木 主矿」）`; }
    touched();
    if (redraw) render(); else cardInPlace(l, s);
    if (msg) api.say(msg);
  }
  function addCond() {
    const {l, s} = S.sel, ln = M.lanes[l], kind = laneKind(ln.head), v = k => (root.querySelector(`.se-edit [data-cv="${k}"]`) || {}).value;
    const ct = S.condType || 'time';
    let term = '';
    if (ct === 'time') { const t = (v('time') || '').trim(); if (!/^\d+:\d{2}$/.test(t)) { api.say('时间写成 分:秒，例如 1:30', true); return; } term = t; }
    else if (ct === 'res') { const g = +v('gold') || 0, w = +v('wood') || 0; if (!g && !w) { api.say('金和木至少写一个', true); return; } term = [g ? '金≥' + g : '', w ? '木≥' + w : ''].filter(Boolean).join(' '); }
    else if (ct === 'started' || ct === 'done') { const t = v('tag'); if (!t) { api.say('脚本里还没有起了名的建筑：先在那座建筑的「建造」步骤里起名', true); return; } term = `#${t} ${ct === 'started' ? '开工' : '完成'}`; }
    else if (ct === 'hero') term = v('hero') + ' 出生';
    else if (ct === 'eta') term = '大法师剩余 ≤ 集合用时';
    else if (ct === 'clear') term = '清野 完成';
    else if (ct === 'food') term = '人口剩 ≤ ' + (+v('food') || 0);
    const f = stepFields(ln.steps[s].raw, kind), terms = condTerms(f.cond).filter(x => x !== term);
    if (ct === 'time') terms.splice(0, terms.length, ...terms.filter(x => !/^\d+:\d{2}$/.test(x)));
    f.cond = [...terms, term].join(' 且 ');
    change(() => { ln.steps[s].raw = composeStep(f); }, `加上条件「${term}」：几个条件都满足才开始`);
  }
  function delCond(i) {
    const {l, s} = S.sel, ln = M.lanes[l], f = stepFields(ln.steps[s].raw, laneKind(ln.head)), terms = condTerms(f.cond);
    const [gone] = terms.splice(i, 1); f.cond = terms.join(' 且 ');
    change(() => { ln.steps[s].raw = composeStep(f); }, `去掉条件「${gone}」`);
  }
  function shareStep() {
    const {l, s} = S.sel, raw = M.lanes[l].steps[s].raw, at = (root.querySelector('.se-edit [data-share-at]') || {}).value || 'same';
    const to = [...root.querySelectorAll('.se-edit [data-share]:checked')].map(x => +x.dataset.share);
    if (!to.length) { api.say('先勾上要派给的人', true); return; }
    change(() => { for (const i of to) { const st = M.lanes[i].steps; st.splice(at === 'end' ? st.length : Math.min(s, st.length), 0, {raw}); } },
      `「${raw}」也派给了 ${to.map(i => M.lanes[i].head).join('、')}（${at === 'end' ? '放在最后' : '放在第 ' + (s + 1) + ' 步'}）`);
  }
  function splitLane() {
    const i = S.sel.l, ln = M.lanes[i], cids = laneCids(ln.head);
    change(() => { M.lanes.splice(i, 1, ...cids.map(c => ({head: '农民' + c, note: ln.note, steps: ln.steps.map(x => ({raw: x.raw}))}))); S.sel = {l: i}; },
      `「${ln.head}」拆成 ${cids.length} 行，每人一行，可以分别派任务`);
  }

  /* ---------- input ---------- */
  function onClick(ev) {
    const t = ev.target.closest('button, .sc, .se-lab, .chip-step, .se-add');
    if (!t || !root.contains(t)) return;
    const act = t.dataset.act;
    if (t.dataset.sfv) { setField(t.dataset.sfv, t.dataset.v, true); return; }
    if (t.dataset.delcond != null) { delCond(+t.dataset.delcond); return; }
    if (t.dataset.z != null) { stepZoom(t.dataset.z === '+' ? 1 : t.dataset.z === '-' ? -1 : 0); return; }
    if (t.dataset.del != null) { const c = t.closest('.sc'); S.sel = {l: +c.dataset.l, s: +c.dataset.s}; deleteStep(); return; }
    if (t.dataset.dellane != null) {
      const i = +t.dataset.dellane, head = M.lanes[i].head;
      change(() => { M.lanes.splice(i, 1); S.sel = null; }, `已删除「${head}」这一行（Ctrl+Z 或「撤销」恢复）`);
      return;
    }
    if (t.dataset.errlane != null) { S.sel = {l: +t.dataset.errlane}; render(); root.querySelector(`.se-row[data-l="${t.dataset.errlane}"]`).scrollIntoView({block: 'nearest'}); return; }
    if (t.dataset.view) { if (t.dataset.view === 'time' && !timing()) return; S.view = t.dataset.view; render(); return; }
    if (t.dataset.cond != null && S.sel && S.sel.s != null) { // a condition preset: add it (or clear)
      const l = S.sel.l, s = S.sel.s, o = splitStep(M.lanes[l].steps[s].raw);
      o.cond = t.dataset.cond === '' ? '' : o.cond ? o.cond + ' 且 ' + t.dataset.cond : t.dataset.cond;
      change(() => { M.lanes[l].steps[s].raw = joinStep(o); });
      return;
    }
    if (t.classList.contains('chip-step') && t.dataset.raw) { // palette click: append to the selected lane
      if (!S.sel) { api.say('先点一行（左边的名字），再点要加的步骤；或者直接拖进去'); return; }
      addFromPalette(S.sel.l, M.lanes[S.sel.l].steps.length, t.dataset.raw, t.dataset.kind);
      return;
    }
    if (t.classList.contains('sc')) { S.sel = {l: +t.dataset.l, s: +t.dataset.s}; render(); focusFor(S.sel.l, S.sel.s); return; }
    if (t.classList.contains('se-lab')) { S.sel = {l: +t.dataset.l}; render(); focusFor(S.sel.l); return; }
    if (t.classList.contains('se-add')) {
      const l = +t.dataset.l, kind = laneKind(M.lanes[l].head), raw = kind === 'building' ? '步兵 ×1' : kind === 'hero' || kind === 'army' ? '待命 @分矿' : '伐木 主矿';
      change(() => { M.lanes[l].steps.push({raw}); S.sel = {l, s: M.lanes[l].steps.length - 1}; });
      return;
    }
    const sel = S.sel, ln = sel && M.lanes[sel.l];
    switch (act) {
      case 'preview': preview(api.startIndex(), '', true); break;
      case 'edit': backToEdit(); break;
      case 'save': save(); break;
      case 'undo': undo(); break;
      case 'text': S.showText = !S.showText; render(); break;
      case 'fromtext': fromText(); break;
      case 'addlane': addLane(t.dataset.kind); break;
      case 'laneup': case 'lanedown': moveLane(act === 'laneup' ? -1 : 1); break;
      case 'lanedup': change(() => { M.lanes.splice(sel.l + 1, 0, JSON.parse(JSON.stringify(ln))); S.sel = {l: sel.l + 1}; }, '已复制这一行；记得改「谁」'); break;
      case 'lanedel': change(() => { M.lanes.splice(sel.l, 1); S.sel = null; }, `已删除「${ln.head}」这一行（Ctrl+Z 或「撤销」恢复）`); break;
      case 'stepdup': change(() => { ln.steps.splice(sel.s + 1, 0, {raw: ln.steps[sel.s].raw}); S.sel = {l: sel.l, s: sel.s + 1}; }); break;
      case 'stepdel': deleteStep(); break;
      case 'stepbefore': { const raw = laneKind(ln.head) === 'building' ? '步兵 ×1' : laneKind(ln.head) === 'hero' ? '待命 @分矿' : '伐木 主矿';
        change(() => { ln.steps.splice(sel.s, 0, {raw}); S.sel = {l: sel.l, s: sel.s}; }, '在前面插了一步，改成要做的事'); break; }
      case 'addcond': addCond(); break;
      case 'share': shareStep(); break;
      case 'lanesplit': splitLane(); break;
      case 'lanemute': change(() => { ln.muted = !ln.muted; }, ln.muted ? `「${ln.head}」暂停执行（写成 #⏸，预演和实战都跳过它）` : `「${ln.head}」恢复执行`); break;
      case 'pickmap': {
        const f = stepFields(ln.steps[sel.s].raw, laneKind(ln.head));
        if (!editing()) { api.say('先「回到编排」，再在沙盘上点选位置', true); break; }
        S.placing = {l: sel.l, s: sel.s, btype: BT[f.bname] || 'hhou'}; api.say(`在沙盘上点一下放${f.bname}；按 Esc 取消。`); break;
      }
      case 'posadd': change(() => { let n = 1; while (M.positions.some(p => p.name === '新位置' + n)) n++; M.positions.push({name: '新位置' + n, expr: '布局.农场1', note: ''}); S.open = true; }); break;
      case 'posdel': { const i = +t.closest('[data-pi]').dataset.pi, p = M.positions[i]; change(() => M.positions.splice(i, 1), `已删除位置「${p.name}」`); break; }
      case 'posshow': { const p = M.positions[+t.closest('[data-pi]').dataset.pi], mk = markers().find(m => m.name === p.name);
        if (mk) { api.focus(mk.x, mk.y); selectPos(p.name); } else api.say(`「${p.name}」在当前出生点算不出位置（${p.expr}）`, true); break; }
      case 'resadd': change(() => M.reserves.push({raw: '留钱 金0 木0 给 #分基地', note: ''})); break;
      case 'resdel': { const i = +t.closest('[data-ri]').dataset.ri; change(() => M.reserves.splice(i, 1)); break; }
    }
  }
  function deleteStep() {
    const {l, s} = S.sel, raw = M.lanes[l].steps[s].raw;
    change(() => { M.lanes[l].steps.splice(s, 1); S.sel = M.lanes[l].steps.length ? {l, s: Math.min(s, M.lanes[l].steps.length - 1)} : {l}; }, `已删除「${raw}」（Ctrl+Z 撤销）`);
  }
  function moveLane(d) {
    const i = S.sel.l, kind = laneKind(M.lanes[i].head);
    let j = i + d;
    while (j >= 0 && j < M.lanes.length && laneKind(M.lanes[j].head) !== kind) j += d;
    if (j < 0 || j >= M.lanes.length) return;
    change(() => { const [x] = M.lanes.splice(i, 1); M.lanes.splice(j, 0, x); S.sel = {l: j}; });
  }
  function addLane(kind) {
    if (kind === 'army') {
      if (M.lanes.some(ln => laneKind(ln.head) === 'army')) { api.say('步兵只有一行（管所有步兵）'); return; }
      change(() => { M.lanes.push({head: '步兵', note: '', steps: [{raw: '待命 @前方空地'}]}); S.sel = {l: M.lanes.length - 1}; }, '加了「步兵」一行：所有不在清野的步兵一起行动');
      return;
    }
    if (kind === 'peasant') {
      const n = nextPeasant();
      change(() => { ensurePeasantLane(n); S.sel = {l: M.lanes.findIndex(ln => laneCids(ln.head).includes(n))}; },
        `加了 农民${n} 的一行；还要在某座建筑那一行里加「农民${n}」训练他`);
      return;
    }
    const def = kind === 'hero' ? '山丘之王' : '神秘圣所', head = prompt(kind === 'hero' ? '哪个英雄？（大法师 / 山丘之王）' : '哪座建筑？（城镇大厅、国王祭坛、兵营、神秘圣所，或 #名字）', def);
    if (!head || !head.trim()) return;
    const raw = kind === 'hero' ? '待命 @分矿' : '步兵 ×1';
    change(() => {
      const last = M.lanes.reduce((a, ln, i) => (laneKind(ln.head) === kind ? i : a), kind === 'hero' ? M.lanes.length - 1 : M.lanes.reduce((a, ln, i) => (laneKind(ln.head) === 'peasant' ? i : a), -1));
      M.lanes.splice(last + 1, 0, {head: head.trim(), note: '', steps: [{raw}]}); S.sel = {l: last + 1};
    });
  }
  function addFromPalette(l, idx, raw, kinds) {
    const kind = laneKind(M.lanes[l].head);
    if (kinds !== kind) { api.say(`「${raw === '农民N' ? '农民（新编号）' : raw}」是${KIND_NAME[kinds]}那一类的步骤，${M.lanes[l].head} 是${KIND_NAME[kind]}`, true); return; }
    let msg = '';
    change(() => {
      if (raw === '农民N') {
        const n = nextPeasant(); raw = '农民' + n; S.dropLane = l;
        ensurePeasantLane(n); l = S.dropLane; S.dropLane = null;
        msg = `${M.lanes[l].head} 训练 农民${n}；他的一生已经加在农民那一栏（先写成「伐木 主矿」，按需要改）`;
      }
      M.lanes[l].steps.splice(idx, 0, {raw}); S.sel = {l, s: idx};
    });
    if (msg) api.say(msg);
  }
  async function fromText() {
    const ta = root.querySelector('#seText'), text = ta ? ta.value : '';
    let j; try { j = await api_('PUT', '/api/script', {text, dryRun: true}); } catch (_) { api.say('连不上本地服务', true); return; }
    if (j.errors && j.errors.length) { S.textDraft = text; S.errors = {general: j.errors, lane: {}, pos: {}, res: {}}; render(); api.say('文本里有错，卡片没变：' + j.errors[0], true); return; }
    change(() => { M = fromModel(j.model); S.sel = null; }, '已按文本更新卡片');
  }
  function onInput(ev) {
    const f = ev.target.dataset.f, pf = ev.target.dataset.pf, rf = ev.target.dataset.rf, sf = ev.target.dataset.sf;
    if (sf && ev.target.tagName === 'INPUT' && S.sel && S.sel.s != null) { setField(sf, ev.target.value, false); return; }
    if (f === 'raw' && S.sel && S.sel.s != null) {
      if (!S.editing) { S.undo.push(JSON.stringify(M)); S.editing = true; }
      M.lanes[S.sel.l].steps[S.sel.s].raw = ev.target.value; cardInPlace(S.sel.l, S.sel.s); touched(); return;
    }
    if (f && S.sel) {
      const ln = M.lanes[S.sel.l];
      if (!S.editing) { S.undo.push(JSON.stringify(M)); S.editing = true; } // one undo step per editing session
      if (S.sel.s == null) { ln[f] = ev.target.value; const lab = root.querySelector(`.se-lab[data-l="${S.sel.l}"] b`); if (lab && f === 'head') lab.textContent = ln.head; }
      else {
        const o = splitStep(ln.steps[S.sel.s].raw); o[f] = ev.target.value.trim(); ln.steps[S.sel.s].raw = joinStep(o);
        const card = root.querySelector(`.sc[data-l="${S.sel.l}"][data-s="${S.sel.s}"]`); if (card) { card.innerHTML = cardHTML(ln.steps[S.sel.s].raw, null); card.className = card.className.replace(/k-\w+/, 'k-' + stepClass(ln.steps[S.sel.s].raw)); }
        const raw = root.querySelector('.se-edit .raw'); if (raw) raw.textContent = ln.steps[S.sel.s].raw;
      }
    } else if (pf) {
      const p = M.positions[+ev.target.closest('[data-pi]').dataset.pi];
      if (!S.editing) { S.undo.push(JSON.stringify(M)); S.editing = true; S.oldName = p.name; }
      p[pf] = ev.target.value.trim();
    } else if (rf) {
      const r = M.reserves[+ev.target.closest('[data-ri]').dataset.ri];
      if (!S.editing) { S.undo.push(JSON.stringify(M)); S.editing = true; }
      r[rf] = ev.target.value;
    } else return;
    S.saved = false; S.timingKey = ''; scheduleCheck();
    const st = root.querySelector('.se-state'); if (st && !st.classList.contains('bad')) { st.className = 'se-state warn'; st.textContent = '未保存'; }
  }
  function onChange(ev) { // an edit is finished (blur / select): settle it and redraw
    const sf = ev.target.dataset.sf;
    if (sf && S.sel && S.sel.s != null) { setField(sf, ev.target.value, true); return; } // a choice: redraw the editor for it
    if (ev.target.dataset.ct) { S.condType = ev.target.value; render(); return; }
    if (ev.target.dataset.f === 'raw') { S.editing = false; render(); return; }
    if (ev.target.dataset.cv || ev.target.dataset.share != null || ev.target.dataset.shareAt) return; // read when the button is pressed
    if (!S.editing && ev.target.tagName !== 'SELECT') return;
    if (ev.target.tagName === 'SELECT' && !S.editing) { S.undo.push(JSON.stringify(M)); onInput(ev); }
    const pf = ev.target.dataset.pf;
    if (pf === 'name' && S.oldName && S.oldName !== ev.target.value.trim()) { // a renamed place: its @references follow
      const from = S.oldName, to = ev.target.value.trim(); let n = 0;
      for (const ln of M.lanes) for (const st of ln.steps) { const o = splitStep(st.raw); if (o.pos === from) { o.pos = to; st.raw = joinStep(o); n++; } }
      for (const p of M.positions) p.expr = p.expr.replace(new RegExp('^' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s*前方)'), to + '$1');
      if (n) api.say(`位置改名「${from}」→「${to}」，${n} 处 @引用一起改了`);
    }
    const redraw = ev.target.tagName === 'SELECT' || pf === 'name' || ev.target.dataset.f === 'head';
    S.editing = false; S.oldName = null;
    if (redraw) render(); // other fields already updated their card in place; a redraw would drop the focus
  }
  function onKey(ev) {
    if (!S.active) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !typing) { ev.preventDefault(); undo(); return; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing && S.sel && S.sel.s != null) { ev.preventDefault(); deleteStep(); }
  }

  /* drag and drop: cards between lanes (order view), palette into lanes */
  let ins = null;
  function clearIns() { if (ins) ins.remove(); ins = null; root.querySelectorAll('.se-track.over').forEach(x => x.classList.remove('over')); }
  function placeIns(track, x, y) {
    if (!ins) { ins = document.createElement('span'); ins.className = 'se-ins'; }
    const cards = [...track.querySelectorAll('.sc')].filter(c => !c.classList.contains('dragging'));
    let before = null;
    for (const c of cards) { const r = c.getBoundingClientRect(); if (y < r.top - 3 || (y <= r.bottom + 3 && x < r.left + r.width / 2)) { before = c; break; } }
    track.insertBefore(ins, before || track.querySelector('.se-add'));
    root.querySelectorAll('.se-track.over').forEach(x2 => x2 !== track && x2.classList.remove('over')); track.classList.add('over');
  }
  function insIndex(track) { let n = 0; for (const c of track.children) { if (c === ins) return n; if (c.classList.contains('sc') && !c.classList.contains('dragging')) n++; } return n; }
  function onDragStart(ev) {
    const c = ev.target.closest('.sc[draggable="true"], .chip-step[draggable="true"]');
    if (!c) return;
    S.drag = c.classList.contains('sc') ? {from: {l: +c.dataset.l, s: +c.dataset.s}} : {raw: c.dataset.raw, kind: c.dataset.kind};
    ev.dataTransfer.effectAllowed = 'copyMove'; ev.dataTransfer.setData('text/plain', c.title || c.dataset.raw || '');
    if (S.drag.from) setTimeout(() => c.classList.add('dragging'), 0);
  }
  function onDragOver(ev) {
    if (!S.drag) return;
    const track = ev.target.closest('.se-lanes.flow .se-track');
    if (!track) { clearIns(); return; }
    ev.preventDefault(); ev.dataTransfer.dropEffect = S.drag.from ? 'move' : 'copy';
    placeIns(track, ev.clientX, ev.clientY);
  }
  function onDrop(ev) {
    const d = S.drag, track = ev.target.closest('.se-lanes.flow .se-track');
    if (!d || !track) return;
    ev.preventDefault();
    const l = +track.dataset.l, idx = insIndex(track);
    clearIns(); S.drag = null;
    if (d.raw) { addFromPalette(l, idx, d.raw, d.kind); return; }
    const from = M.lanes[d.from.l], raw = from.steps[d.from.s].raw, k1 = laneKind(from.head), k2 = laneKind(M.lanes[l].head);
    if (k1 !== k2) { api.say(`「${raw}」是${KIND_NAME[k1]}的步骤，不能放进 ${M.lanes[l].head}（${KIND_NAME[k2]}）`, true); render(); return; }
    if (d.from.l === l && (idx === d.from.s)) { render(); return; }
    change(() => { const [st] = from.steps.splice(d.from.s, 1); M.lanes[l].steps.splice(idx, 0, st); S.sel = {l, s: idx}; },
      d.from.l === l ? `「${raw}」挪到第 ${idx + 1} 步` : `「${raw}」从 ${from.head} 交给 ${M.lanes[l].head}（第 ${idx + 1} 步）`);
  }
  function onDragEnd() { clearIns(); S.drag = null; root.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging')); }
  /* time view: drag a card sideways = "not before this time" */
  function onPointerDown(ev) {
    const c = ev.target.closest('.se-lanes.time .sc');
    if (!c || ev.button !== 0 || ev.target.closest('.x')) return;
    const track = c.parentElement, tr = track.getBoundingClientRect(), x0 = ev.clientX, left0 = c.offsetLeft;
    let moved = false;
    c.setPointerCapture(ev.pointerId);
    const mv = e => { const dx = e.clientX - x0; if (Math.abs(dx) > 4) moved = true; if (moved) { c.style.left = (left0 + dx) + 'px'; c.classList.add('dragging'); } };
    const up = e => {
      c.removeEventListener('pointermove', mv); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up);
      if (!moved) return; // a click: onClick selects it
      const t = Math.max(0, Math.min(T_END - 1, (left0 + e.clientX - x0) / tr.width * T_END));
      S.suppressClick = true; setTimeout(() => { S.suppressClick = false; }, 0);
      setTime(+c.dataset.l, +c.dataset.s, Math.round(t));
    };
    c.addEventListener('pointermove', mv); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  }

  /* ---------- the tab next to 事件时间轴 ---------- */
  function setActive(on) {
    S.active = on; api.tl.classList.toggle('script-mode', on);
    api.tl.querySelectorAll('.se-tab').forEach(b => b.classList.toggle('on', (b.dataset.tab === 'script') === on));
    root.hidden = !on;
    const L = api.live();
    if (on) { // into 编排: no demo running on the sandbox
      S.demo = false; S.timingKey = '';
      if (L.replay && L.replay.preview) api.exitPreview();
      if (!L.on && !L.replay) api.setMode('战术脚本 · 编排');
      render();
      if (!L.on) api.say('编排中：沙盘上是开局和脚本里的全部工地，可以直接拖；点卡片定位；点「预演」看演示。');
    } else { // the timeline shows the script's last preview
      S.placing = null;
      if (S.lastPreview && !L.on && !L.replay) api.openPreview(S.lastPreview);
      else if (!L.on && !L.replay) api.setMode('离线预演');
    }
  }
  async function init(a) {
    api = a;
    if (location.protocol === 'file:' || !(await load())) return; // needs the bridge
    const head = api.tl.querySelector('.tl-head h2');
    const tabs = document.createElement('span'); tabs.className = 'se-tabs';
    tabs.innerHTML = '<button type="button" class="se-tab on" data-tab="timeline">事件时间轴</button><button type="button" class="se-tab" data-tab="script">战术脚本</button>';
    head.replaceWith(tabs);
    tabs.onclick = e => { const b = e.target.closest('.se-tab'); if (b) setActive(b.dataset.tab === 'script'); };
    root = document.createElement('div'); root.className = 'se'; root.hidden = true;
    api.tl.querySelector('.tl-head').after(root);
    root.addEventListener('click', e => { if (!S.suppressClick) onClick(e); });
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('wheel', onWheel, {passive: false});
    document.addEventListener('keydown', onKey);
    scheduleCheck();
    try { // the event timeline shows the script from the start: preview it unless a game is on
      const h = await api_('GET', '/api/health');
      if (!h.running && !h.waiting && !api.live().on && !api.live().replay) preview(api.startIndex());
    } catch (_) { /* no preview */ }
  }
  function tick(now) { // from app.js's frame loop: keep the cards in step with a live or replayed game
    if (!S.active || now - S.lastTick < 500 || S.drag) return;
    S.lastTick = now;
    const src = source();
    if (src) refresh();
  }

  window.ScriptEditor = {init, tick, preview, planFor, sites, moveSite, selectStep, selectUnit, onMap, markers, editing, addOrder, editFromTimeline, openCardOf, toggleMute,
    placing: () => S.placing, cancelPlacing: () => { if (S.placing) { S.placing = null; api.say('已取消放置'); } },
    placed: (pos) => { const p = S.placing; S.placing = null; if (p) moveSite(p.l, p.s, pos); }, markerAt, moveMarker, selectPos, active: () => S.active,
    _test: {splitStep, joinStep, laneKind, laneCids, toText: () => toText(), model: () => M}};
})();
