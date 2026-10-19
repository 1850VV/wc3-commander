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
- 建造：事件带 `at`（玩家在地图上放的）或 `exact: true` 时按精确坐标建造、不加 `auto_place`；否则加 `auto_place`，游戏可能挪开几百距离。新建筑先按农民的命令目标认领，再按 `info["placements"]` 回报的坐标，都没有才用 700 的宽半径。`server.Runner` 每步后要调用 `engine.feedback`。
- 不能给 `inside`（金矿里）的单位下命令，否则 wc3env 会让会话进入故障状态；`engine.tick` 已经过滤。
- 模拟器和测试世界里的数值假设（矿内 1 秒、每棵树 50 木）未校准，改动时同步更新 README 和页面底部说明。
- 只用于离线单机，不要加任何联网对局相关功能。控制台默认只监听 127.0.0.1；`--host 0.0.0.0`（`bridge.ps1 -Lan`）只为家里局域网访问，控制台没有登录保护，不要做成默认。
- 不要在没有用户同意的情况下启动游戏、推送到别人的仓库或改动 wc3env-127a 主分支。

## 现状（2026-10-19）

- 离线预演、假服务器端到端都已通过测试；**真游戏还没有跑过**。
- 下一步：用户按 `docs/实机验收.md` 在 Windows 上做第一次实机验收，把截图和终端输出带回来排查。
- 之后：用实机数据校准采金时间；把规则版「AI 建议」换成大模型（参考 wc3env-127a 的 `wc3agent`）；按 warcraft-commander 的 AMAI 研究增加事件类型。
