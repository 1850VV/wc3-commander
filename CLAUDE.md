# wc3-commander

魔兽争霸三（1.27a）指挥官控制台：把人族运营拆成事件（建造 / 采集 / 生产）排在时间轴上，程序通过 wc3env 替玩家下命令。和用户交流用中文；用户是独立开发者，有 C/Python 基础但不算熟练，解释时少用术语。

## 结构

- `web/index.html` + `web/console/`：新控制台（2026-10-21，按原型 v8）。`console/shell.js` 管页面状态、顶栏和菜单、脚本版本（撤销/重做）、保存；编排时把 `GET /api/script` 的脚本和出生点布局交给 `budget.js`，结果转成时间轴数据交给 `TL.load`；时间轴和沙盘的每次修改触发 `script-edited`，`lanesToText` 把各条轨道写回脚本文本（保留原脚本的顺序、注释和位置；同一行的农民步骤相同就合写，不同就拆开；沙盘上点出的地点写成「位置 点N = 坐标 x,y」），再重算重载。`console/timeline.js` 是时间轴（原型 app，`TL` 接口），`console/sandbox.js` 是沙盘（生命周期路线、Shift 接在最后、步骤条件、队伍、编队、时间条、小地图），`data/sandbox-map.js` 由 `tools/bake_sandbox_map.js` 生成（整张地图、建筑占地、金矿），不要手改。实战（`shell.js` 的 `connect`/`onState`/`project`）：连上后先换成游戏正在执行的脚本（`GET /api/script/live`），每秒记一帧，`Budget.ratesFrom` 算实测速度，每 2 秒 `Budget.run({live})` 推算剩下的，红线 = 现在（拖开 10 秒后回来），色块阴影和「和理想计划比」对的是同一份脚本从 0:00 的预算（`D.baseline`）；修改走 `POST /api/script/live`，游戏拒绝就撤回。回放（`openRun`）：`GET /api/runs/<id>` 的帧加上 `Budget.actualOf` 读出的每步真实时间，只看不改。沙盘在实战（红线及以前）和回放里画游戏自己的帧（`D.real`，`sandbox.js` 的 `realAt`）：真实建筑和进度（按类型和距离对上脚本的建造步骤）、全部单位（含水元素、民兵、手动造的）、看得到的野怪和其他玩家单位；红线处用最新状态（`CONSOLE.liveState`，每秒 4 次）；还没开工的计划工地画虚框；红线以后才是预算推算。录像帧（`server.frame_of`）从 2026-10-21 起带 `creeps`/`enemies`，更早的录像野怪仍是示意。点建筑 = 建筑命令卡（`sandbox.js` 的 `pickBuilding`/`queueOn`/`buildingCardHTML`）：训练（大厅 农民，兵营 步兵，祭坛 大法师/山丘之王，圣所 破法者/牧师/女巫）、升级（主城、城堡、奥术塔）、集结点（点地面或英雄）；点 = 从红线起排在正在做的后面（写成「[m:ss] …」），Shift = 排到队列最后，同兵种连点合成 ×N；训练农民同时加一行「农民N：采金 主矿/分矿」；没有生产队列的建筑第一次排产时新加一行（同类第二座给它的建造步骤加标签，如 `#圣所2`）；`lanesToText` 会写出脚本里还没有的农民行和建筑行。「更多」里：另存为 / 载入战术脚本（`strategies/战术脚本-<名字>.txt`；当前那份记在 `strategies/当前战术脚本.txt`，不进 git；`server.script_path()`/`script_name()`；「保存」和接管的游戏都用当前那份；接口 `GET /api/scripts`、`POST /api/script/use`、`PUT /api/script` 带 `name`），完整跑一遍（`POST /api/script/preview`，像回放一样只读打开，色块阴影和 ± 对的是预算，`shell.js` 的 `fullRun`/`showRun`）。旧控制台留在 `old.html`（下面说的 `app.js`、`script-editor.js`、`timeline.js`），新页面不再用它们。
- `web/`：浏览器控制台。`sim.js` 是模拟核心（失落神庙网格、A* 寻路、选址、经济、事件执行），浏览器和 Node 共用；`app.js` 是界面；`data/lost-temple.js` 由 `tools/build_data.py` 生成，不要手改。
- `bridge/commander_bridge/`：本地服务。`engine.py` 把时间轴事件翻译成 wc3env 命令，并按观测和事件（construct_start/finish、train_start/finish）更新状态；`server.py` 是 HTTP + 服务器推送 + 游戏会话线程；`testworld.py` 是给 wc3env FakeServer 用的失落神庙经济世界。
- 依赖仓库：`1850VV/wc3env-127a`（游戏接口；在非 Windows 上需要 `cross-platform-import` 分支）。参考仓库：`1850VV/warcraft-commander`（旧实现，地图与数值数据的来源，AMAI 研究文档在 `docs/amai.md`）。

## 命令

```sh
node --test web/tests/sim.test.js                                                 # 模拟器（必须写到文件名）
node --test web/tests/script-editor.test.js                                       # 战术脚本编辑器的卡片拆分
node --test web/tests/budget.test.js                                              # 预算模型（战术脚本 → 时间轴，数学估算）
WC3ENV_SRC=../wc3env-127a/src python -m unittest discover -s bridge/tests -t bridge  # 端到端（假服务器）
cd bridge && WC3ENV_SRC=../../wc3env-127a/src python -m commander_bridge --backend fake   # 本地看效果
python -m commander_bridge --backend wc3env                                         # 真游戏，仅 Windows（用 wc3env-127a\.venv 的 Python）
python -m commander_bridge --backend wc3env --launch --speed-factor 16 --no-render  # 加速测试（16×、不画游戏窗口），控制台仍同步
python -m commander_bridge --backend wc3env --launch --speed-factor 4 --no-render --human-slot 2  # 指定出生点槽位（0 南/1 西/2 北/3 东）
tools/pc.sh start | status | log | stop | pull                                       # 从 Mac 经 ssh pc 远程操作；start 走计划任务，游戏窗口才在桌面上
```

改了 `web/sim.js` 的默认计划或选址规则后，用 `node tools/export_plan.js 0 > bridge/tests/fixtures/default-plan-s0.json`（以及 `2`）重新生成测试夹具。

## 规则

- 命令被 wc3env 接受不等于执行成功；事件状态只能根据后续观测和游戏事件改变。
- 事件字段：`after`（等哪个事件完成，模拟器 `ready()`/引擎 `ready()`）；`kind: 'upgrade'` + `to`（可选 `from`、`at`），升级占建筑队列、扣差价，引擎下 `train type_id=to`，按 `upgrade_start/finish` 改状态；建造的 `near: 'natural'`、`helpers: N`、`then: 'natural'`；采集的 `mine: 'natural'`。分矿 = 离主基地最近的另一座金矿（sim `natural`，引擎 `natural()`）。协助建造的速度和费用 `ASSIST` 是推算值。
- 民兵和清野：`kind: 'learn'`（`hero`、`ability`）、`'militia'`（`count`、`from`）、`'clear'`（`militia` 指向敲钟事件、`est` 模拟时长）。实机命令已由探针确认（`docs/validation/2026-10-19-probe-orders`，在分支 claude/nice-moore-a8bdef）：农民 `cast militia`（先走回大厅才变身，45 秒原地变回，同一 unit_id）、`learn AHwe`、`cast waterelemental` 不能带坐标、升级用 `train`。清野控制器在 `combat.py`；失败的事件带 `rt.failed`，等它的事件不会开始。清野时玩家可以自己微操（`Clear._by_hand`）：单位当前命令不是控制器会下的（`combat.OURS` = attack/move/水元素；右键在游戏里读出来是 `smart`，还有停止、保持、巡逻、施法），或让它打 A 它却在打另一个活着的野怪，就当玩家在操作，直到他最后一次操作后 `MANUAL_PAUSE`=8 秒再接回来；其他单位照常按策略打。假游戏 `testworld.py` 有简单战斗（可传入 `creeps`）。
- 速矿策略由 `tools/make_fast_expand.js` 生成（改打法改这里再运行）；检查点格式 `{id, name, event, at: 'end'|'start', from, to}`，评估在 `sim.js` 的 `checkpoint()`。建造的 `then` 也可以是 `'wood'`，训练的 `then` 可以是 `'natural'`。
- 失落神庙的大厅默认在玩家 1 放一个电脑；不在配置里的槽位会保持这个状态（探针第一次运行约 5 分钟被它打掉）。所以 `--opponent none` 把玩家 1 配成 agent 槽位：基地还在，AI 不启动，不进攻；每一步都要给它一个空的动作批次（`server.Runner`）。旧项目的单人图 Lost Temple - Solo Economy 已不在这台电脑上，重做要 StormLib。
- 引擎 `tick()` 先清空动作列表再处理游戏事件（`_ingest`），处理事件时下的命令才不会丢。
- 自动挑农民（`pickBuilder`/`pickWorkers`，引擎 `pick_builder`/`pick_workers`）会避开还没开始的事件点名要用的农民（`reserved`）。
- 策略：`strategies/<名字>.json`（`strategies.py`），保存的是计划本身。工地坐标是绝对坐标，所以一套布局只对一个出生点有效；目前四个出生点各存一套。
- 控制台保存布局：载入后顶部显示当前布局名，「保存」写回这套、「另存为…」建新的（`app.js` 的 `setCurrent`/`put`）；改过显示「未保存」。计划推给服务时带 `name`（`/api/plan` 和 SSE 的 `plan` 消息），加入正在进行的游戏时控制台据此显示服务挑的策略；`Runner.set_plan(plan, name)` 用 `server._UNSET` 区分「没提名字」和「明确没有载入」。
- 工地：`sim.js` 的 `planSites` 先给带 `at` 的事件占位，再按开始时间给自动工地选址；`at` 放不下时就近改位置并写 `e.siteNote`。控制台在建筑开工（`rt.bid`）前都允许拖动工地（`app.js` 的 `movable`）。
- 建筑占地（`sim.js` 的 `rectOf` / `bodyRect`）：整张寻路贴图是「不可建」范围（`build` 格），`walk` 格才是挡路的建筑本体。真实数据是 `UnitData.slk` 的 `pathTex` + MPQ 里的 TGA：1 像素 = 1 格 = 32 单位，品红 `(255,0,255)` 挡路，蓝 `(0,0,255)` 能走不能建；`Simple` 贴图外圈 2 格缓冲（金矿 4 格），`SimpleSolid` 没有。地图上实心画建筑、虚框画不可建范围。
- 封家（`sim.js` 的 `wallCheck`/`autoWall`，常量 `WALL`）：从采金路线出发找通往检查窗口边界的最宽路，K 是最窄处能放下的最大空方块边长（格）。单位需要 `floor(碰撞半径/16)+1` 格：碰撞半径取自 wc3env 的 `runs/reference-127a.json`（农民 16、步兵 31、英雄/苦工/火枪手 32），所以 2 格 = 封家、3 格英雄能进；这个换算是推断，待实机验证。建筑放在 64 单位网格上；祭坛、兵营、城镇大厅四周有 2 格可走的边，只有农场是实心的。`canPlace` 的 `margin` 参数：自动选址留 32，玩家放的和自动封家用 0（可以贴着放）。
- 建造：事件带 `at`（玩家在地图上放的）或 `exact: true` 时按精确坐标建造、不加 `auto_place`；否则加 `auto_place`，游戏可能挪开几百距离。新建筑先按农民的命令目标认领，再按 `info["placements"]` 回报的坐标，都没有才用 700 的宽半径。`server.Runner` 每步后要调用 `engine.feedback`。已下令后工地坐标或精确/自动方式变了，引擎会重新下令（`_site_changed`）。
- 连接（`attach.py`，`server.Runner._attach`）：默认一直等任何 War3.exe。没有钩子的，发现 5 秒后 `attach.inject` 注入（DLL 来自 wc3env-127a 分支 `claude/attach-menu-game`，PC 上的 `wc3env-127a-attach` 工作树；每个进程复制一份到 `bridge/hook-cache/`；钩子用互斥量拒绝重复加载）；快捷方式「魔兽争霸三（指挥官）」（`tools/windows/war3_commander.py`）一开始就带钩子。钩子在每局 0:01（或中途注入后的下一帧）停住，服务用 `create_game(map="*", players="loaded", mode="realtime")` 接管；地图名含 lost temple（读不到时看城镇大厅是否在失落神庙出生点上）就按出生点载入 `人族速矿二本 · <方向>` 并开战术，否则只观察。同一进程里一局接一局（钩子发现游戏时间倒退就当新局）。超时、断线只记普通日志并重连；同一局重新接上保留指挥官进度（`Runner.attached`）。以管理员权限运行的魔兽，普通权限的服务注入会被拒绝（错误 5）；让服务以管理员权限运行属于安全设置，由用户决定。`--launch`（测试开关，默认关）恢复由服务启动游戏的旧流程，自动验收时用它。新控制台的「连接游戏」每次先弹「连接设置」（`shell.js` 的 `connect`/`join`，选择记在浏览器里）：由指挥官启动魔兽（wc3env 开一局，同 `--launch`）或接管已经打开的魔兽；游戏速度 1×（正常，不跳帧）/2×/4×/16×；是否画魔兽窗口；接管最多等几秒（默认 60，`Runner.attach_wait`，到时没找到魔兽就报错并停止等待，0 = 一直等）。这些随 `POST /api/control {action:'start', opts}` 送到 `Runner.configure`。等待期间服务的推送仍是上一局的状态，控制台忽略（`LV.waiting`），按 `/api/health` 的 `waitLeft` 倒计时。
- 编排（用户自己写打法）：`strategies/编排-人族速矿二本.md` 是中文 Markdown 表格，每行「启动条件 → 元策略 M1–M13（参数）→ 停止条件 → 优先级」，写法见 `docs/元策略.md`。`orchestration.py` 解析（错误按行报中文），`orchestrator.Orchestrator`（继承仲裁器 `arbiter.Arbiter`）执行：决策记录的规则名是 `R<行号>`；采金/伐木人数由 M1/M2 行设到 `engine.gold_cap`/`wood_cap`；留钱是 M11 行。计划带 `orchestration` 文本就用它；用户自己开的游戏自动读这份文件。编排有错时不开打并逐条提示。
- 战术脚本（`strategies/战术脚本-人族速矿二本.txt`，写法见 `docs/战术脚本-草稿.md`）：`script.py` 解析/写回，`script_runner.py`（`ScriptRunner`，继承仲裁器）逐行执行，没有自动分工、自动补农民/农场/步兵；只保留 4 个安全动作（不给金矿里的单位下令、建造者站工地外、T2 换树、T3 叫回建造者）。农民按脚本编号（初始 1–5，训练时按 `as_cid` 指定），其他单位从 101 起。决策记录的规则号是 `L<行号>`，`why` 以「第 N 行第 K 步」开头（控制台据此把时间对到卡片上）。死掉的农民那一行停住标红。计划里带 `script` 时服务端用它；接管模式下文件存在就优先于编排表。`@自动` = 布局里没被占用的同类工地，没有就交给游戏在城镇大厅附近找。
- 脚本的时间和队伍（2026-10-21）：`[9:30]` = 9:30 这一步已经在做（按走路距离提前出发：`ScriptRunner._walk`/`_step_target`，`budget.js` 的 `walkOf`/`targetOf`），`[9:30 出发]` = 9:30 才出发（控制台红线下令、拖卡片都写这种）；`[上一步完成后 N 秒]`（上一步完成的时刻存在车道的 `done_at`/`prev_done`，预算是 `doneAt`/`prevDone`；一直做的步骤从开始算）；`[大法师出生前 N 秒]`（按祭坛训练进度）。队伍：`队伍 名字：集合 @X → 清野 @分矿 → 解散` 一行（`kind: 'squad'`，时间轴标签「队伍·名字」），成员那一行写 `加入 名字`，持续到解散；队伍第一步等所有成员（包括还没出生的）都加入；之后加入的人接上当前步骤（`ScriptRunner._squad`、`budget.js` 的 `squadMembers`/`squadGive`）。测试：`bridge/tests/test_script_syntax.py`、`web/tests/budget.test.js`。
- 控制台「战术脚本」标签（`web/script-editor.js`）：每行一个农民/建筑/英雄，步骤是卡片，可拖动排序、跨行交给别人（同类行之间）、从工具栏拖入；「时间」视图按开始时间排卡片，横拖 = 改「最早几点开始」条件。时间来自实机 > 回放 > 预演（`POST /api/script/preview`，在假世界跑 10 分钟，约 8 秒；假世界给每个出生点的分矿放一组巨魔）。保存走 `PUT /api/script`，有错不存。
- 预算（`web/budget.js`，浏览器和 Node 共用）：控制台的时间轴默认就是战术脚本的预算，不用再点「预演」。按固定的建造/训练时间、每人每秒采金 1.4 / 伐木 0.4（2026-10-21 真游戏实测，见 `docs/validation/2026-10-21-new-console`；假游戏采得快，约 2.0 / 0.52，和假游戏比的测试要传这个速度）（每矿最多 5 人，分矿大厅造好前只算 0.2）、直线距离 ÷ 移动速度、清野 = 英雄走到分矿 + 25 秒来算；钱按脚本行号先后分配，`留钱` 挡住后面的行；`集结点 大法师` 等英雄出生，建筑那几行等建筑造好。每次改脚本（`change`/`undo`）200 毫秒后重算（约 20 毫秒），输出和服务端预演同样的形状（`timeline`、每秒 `frames`、带「第 N 行第 K 步」的 `decisions`），所以时间轴、沙盘、卡片照常显示。数值是估计，和假游戏的开局差 20 秒以内；「战术脚本」标签的「完整跑一遍（假游戏）」仍走 `POST /api/script/preview`，结果上的 ±秒 就是和预算的差。`run({rates})` 留给连上游戏后换成实测速度。
- 实机时间轴（连着游戏时，`app.js` 的 `Live.record`/`projectLive`）：控制台每秒记一帧游戏状态（快照里的 `got` = 累计采集，`arbiter.snapshot`），`Budget.ratesFrom` 用最近 90 秒算每人每秒的采金/伐木速度；每 2 秒 `ScriptEditor.project(state, rates)` = `Budget.run({live: state})`：`restore` 把已经发生的步骤换成真实时间（`Budget.actualOf`，和 `server.timeline_of` 同样的读法），单位、建筑进度和训练队列、钱都从游戏里来，从此刻往后按模型推算（至少推到此刻后 5 分钟）。时间轴红线 = 此刻（拖动后 10 秒回到此刻），红线右边打斜线表示推算；色块上的 ± 秒和侧栏「实机 · 和理想计划比」都是和从 0 算的理想预算比。实战中下令：沙盘框选/右键、命令卡、「现在下令」窗口、时间轴上拖动/删除/⏸ 都照常写进脚本（`addOrder`/`editFromTimeline`/`toggleMute` 走 `commit`），连着游戏时不重算预算而是 `POST /api/script/live` → `Runner.reload_script`（持锁调用 `ScriptRunner.reload_script`，下一帧生效，决策记录多一条「战术脚本在实战中更新」）；游戏拒绝（改了已经开始的步骤、删了已经开始的行）就撤回控制台里的改动并提示。「战术脚本」标签里的修改在游戏中 0.8 秒后自动发过去（被拒只提示不撤回）。还没开始的行（`i=0` 且没 on）整行都可以改。连上后控制台先 `GET /api/script/live` 换成游戏正在执行的脚本（`adoptLive`）。下令时刻 = 此刻，红线拖到将来就是那个时刻。脚本文件只有点「保存」才写。测试夹具 `web/tests/fixtures/live-s0-200.json` 由 `tools/export_live_state.py 200` 生成（假游戏跑到 3:20 的状态加整局结果）。
- 时间轴编排（`web/timeline.js`，「事件时间轴」标签显示脚本的预算或预演）：每个农民/建筑/英雄一条轨道，步骤是色块，红线 = 沙盘显示的时刻，拖红线前进或回溯。数据来自预演的 `timeline`（`server.timeline_of`：各步开始/开工/完成时间）和 `frames`（每秒一帧，带 `got` 累计采集）。沙盘在预演里可框选（左键拖框，Ctrl 选同类，Shift 加选）、右键下令（金矿=采金，树=伐木，在建建筑=协助，分矿野点=清野，地面=移动；Shift=排队），命令卡在右下角；命令由 `ScriptEditor.addOrder` 写进脚本：插在该单位红线时刻正在做的那一步后面，写成「[时刻] 动作」（排队则不带时刻），共用一行的农民会先拆开；时间轴上拖色块/删除/改写走 `editFromTimeline`。改完调 `POST /api/script/preview` 带 `from`：预演每 `SAVE_EVERY`=10 秒存一个存档点（`copy.deepcopy` 假游戏世界 + 指挥官 + 观测），从 `from` 之前最近的存档点接着跑，`ScriptRunner.reload_script` 换上新脚本（已经开始的步骤变了就退回从头跑并在 `note` 里说明）；只保留每个出生点最近一次预演的存档。控制台在打开脚本预演时换成 v4 布局（`body.v4`）：沙盘在左、命令卡 `#card4` 在右，旧的小地图/概览/命令面板收起；顶栏「在 m:ss 下令」和双击轨道打开时间轴侧栏的下令窗口（选单位、编队、覆盖/排队、什么时候开始：此刻/某建筑开工或完成/钱够了，下令前在时间轴上画白色虚线预览）。轨道名旁的 ⏸ 把那一行写成 `#⏸ 农民8：…`：保留在脚本里但不执行（`script.parse` 标 `muted`，`ScriptRunner` 跳过，时间轴显示为灰），切换后从头重算。脚本新增：`步兵` 一行（所有不在清野的步兵一起：集合/移动/攻击移动/待命）、英雄的 `攻击移动`、`移动 @位置`（到了才算做完，后面的步骤接着做）。
- 不能给 `inside`（金矿里）的单位下命令，否则 wc3env 会让会话进入故障状态；`engine.tick` 已经过滤。
- 模拟器和测试世界里的数值假设（矿内 1 秒、每棵树 50 木）未校准，改动时同步更新 README 和页面底部说明。
- 只用于离线单机，不要加任何联网对局相关功能。控制台默认只监听 127.0.0.1；`--host 0.0.0.0`（`bridge.ps1 -Lan`）只为家里局域网访问，控制台没有登录保护，不要做成默认。
- 不要在没有用户同意的情况下启动游戏、推送到别人的仓库或改动 wc3env-127a 主分支。

## 现状（2026-10-19）

- 2026-10-20：新增 `--human-slot`（0 南 / 1 西 / 2 北 / 3 东）和四方向真机实测；分基地改为自动选址 + 工地外待命点 + 资源预留，金矿锁 5 / 伐木 8 / 步兵 6。未解决问题（非墙建筑 site 未同步、西方清野超时、西/东伐木路线、大厅建造者进矿等）见 `docs/已知问题-2026-10-20.md`。

- 真游戏已跑通默认开局（`docs/validation/` 下三份记录）：五个开局事件按时完成；第二个农场被游戏挪远后重复建造的问题已修复并在真游戏复验通过。
- 分阶段计划（用户已同意）：阶段 1 在控制台里拖动和预摆工地 → 阶段 2 封家检查和自动封家 → 阶段 3 `after` 依赖和延迟原因 → 阶段 4 策略库（`strategies/`，经服务端接口）→ 阶段 5 运行中补救卡片 → 阶段 6 二本数矿（等用户给 timing）→ 阶段 7 AMAI 规则对照表。每个阶段做完都要测试、提交推送，然后停下来等用户确认。
- 不做 Agent 候选审核；「AI 建议」暂时保持规则版。
- 战术脚本（2026-10-20）：真游戏 16 倍速南方整局跑通（186 条命令全有出处、0 被拒）；农民13 两局都在清野时阵亡（战斗参数待调）。
- 采金时间等数值仍未用实机数据校准。
