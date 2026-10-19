# wc3-commander

魔兽争霸三（1.27a）指挥官控制台：把人族运营拆成事件（建造 / 采集 / 生产）排在时间轴上，程序通过 wc3env 替玩家下命令。和用户交流用中文；用户是独立开发者，有 C/Python 基础但不算熟练，解释时少用术语。

## 结构

- `web/`：浏览器控制台。`sim.js` 是模拟核心（失落神庙网格、A* 寻路、选址、经济、事件执行），浏览器和 Node 共用；`app.js` 是界面；`data/lost-temple.js` 由 `tools/build_data.py` 生成，不要手改。
- `bridge/commander_bridge/`：本地服务。`engine.py` 把时间轴事件翻译成 wc3env 命令，并按观测和事件（construct_start/finish、train_start/finish）更新状态；`server.py` 是 HTTP + 服务器推送 + 游戏会话线程；`testworld.py` 是给 wc3env FakeServer 用的失落神庙经济世界。
- 依赖仓库：`1850VV/wc3env-127a`（游戏接口；在非 Windows 上需要 `cross-platform-import` 分支）。参考仓库：`1850VV/warcraft-commander`（旧实现，地图与数值数据的来源，AMAI 研究文档在 `docs/amai.md`）。

## 命令

```sh
node --test web/tests/sim.test.js                                                 # 模拟器（必须写到文件名）
WC3ENV_SRC=../wc3env-127a/src python -m unittest discover -s bridge/tests -t bridge  # 端到端（假服务器）
cd bridge && WC3ENV_SRC=../../wc3env-127a/src python -m commander_bridge --backend fake   # 本地看效果
python -m commander_bridge --backend wc3env                                         # 真游戏，仅 Windows（用 wc3env-127a\.venv 的 Python）
tools/pc.sh start | status | log | stop | pull                                       # 从 Mac 经 ssh pc 远程操作；start 走计划任务，游戏窗口才在桌面上
```

改了 `web/sim.js` 的默认计划或选址规则后，用 `node tools/export_plan.js 0 > bridge/tests/fixtures/default-plan-s0.json`（以及 `2`）重新生成测试夹具。

## 规则

- 命令被 wc3env 接受不等于执行成功；事件状态只能根据后续观测和游戏事件改变。
- 事件字段：`after`（等哪个事件完成，模拟器 `ready()`/引擎 `ready()`）；`kind: 'upgrade'` + `to`（可选 `from`、`at`），升级占建筑队列、扣差价，引擎下 `train type_id=to`，按 `upgrade_start/finish` 改状态；建造的 `near: 'natural'`、`helpers: N`、`then: 'natural'`；采集的 `mine: 'natural'`。分矿 = 离主基地最近的另一座金矿（sim `natural`，引擎 `natural()`）。协助建造的速度和费用 `ASSIST` 是推算值。
- 引擎 `tick()` 先清空动作列表再处理游戏事件（`_ingest`），处理事件时下的命令才不会丢。
- 自动挑农民（`pickBuilder`/`pickWorkers`，引擎 `pick_builder`/`pick_workers`）会避开还没开始的事件点名要用的农民（`reserved`）。
- 策略：`strategies/<名字>.json`（`strategies.py`），保存的是计划本身。工地坐标是绝对坐标，所以一套布局只对一个出生点有效；目前四个出生点各存一套。
- 工地：`sim.js` 的 `planSites` 先给带 `at` 的事件占位，再按开始时间给自动工地选址；`at` 放不下时就近改位置并写 `e.siteNote`。控制台在建筑开工（`rt.bid`）前都允许拖动工地（`app.js` 的 `movable`）。
- 封家（`sim.js` 的 `wallCheck`/`autoWall`，常量 `WALL`）：从采金路线出发找通往检查窗口边界的最宽路，K 是最窄处能放下的最大空方块边长（格）。单位需要 `floor(碰撞半径/16)+1` 格：碰撞半径取自 wc3env 的 `runs/reference-127a.json`（农民 16、步兵 31、英雄/苦工/火枪手 32），所以 2 格 = 封家、3 格英雄能进；这个换算是推断，待实机验证。建筑放在 64 单位网格上；祭坛、兵营、城镇大厅四周有 2 格可走的边，只有农场是实心的。`canPlace` 的 `margin` 参数：自动选址留 32，玩家放的和自动封家用 0（可以贴着放）。
- 建造：事件带 `at`（玩家在地图上放的）或 `exact: true` 时按精确坐标建造、不加 `auto_place`；否则加 `auto_place`，游戏可能挪开几百距离。新建筑先按农民的命令目标认领，再按 `info["placements"]` 回报的坐标，都没有才用 700 的宽半径。`server.Runner` 每步后要调用 `engine.feedback`。已下令后工地坐标或精确/自动方式变了，引擎会重新下令（`_site_changed`）。
- 不能给 `inside`（金矿里）的单位下命令，否则 wc3env 会让会话进入故障状态；`engine.tick` 已经过滤。
- 模拟器和测试世界里的数值假设（矿内 1 秒、每棵树 50 木）未校准，改动时同步更新 README 和页面底部说明。
- 只用于离线单机，不要加任何联网对局相关功能。控制台默认只监听 127.0.0.1；`--host 0.0.0.0`（`bridge.ps1 -Lan`）只为家里局域网访问，控制台没有登录保护，不要做成默认。
- 不要在没有用户同意的情况下启动游戏、推送到别人的仓库或改动 wc3env-127a 主分支。

## 现状（2026-10-19）

- 真游戏已跑通默认开局（`docs/validation/` 下三份记录）：五个开局事件按时完成；第二个农场被游戏挪远后重复建造的问题已修复并在真游戏复验通过。
- 分阶段计划（用户已同意）：阶段 1 在控制台里拖动和预摆工地 → 阶段 2 封家检查和自动封家 → 阶段 3 `after` 依赖和延迟原因 → 阶段 4 策略库（`strategies/`，经服务端接口）→ 阶段 5 运行中补救卡片 → 阶段 6 二本数矿（等用户给 timing）→ 阶段 7 AMAI 规则对照表。每个阶段做完都要测试、提交推送，然后停下来等用户确认。
- 不做 Agent 候选审核；「AI 建议」暂时保持规则版。
- 采金时间等数值仍未用实机数据校准。
