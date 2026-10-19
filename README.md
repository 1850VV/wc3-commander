# 魔兽指挥官控制台

把《魔兽争霸三》的运营拆成事件（建造、采集、生产），排在时间轴上，由程序替你下命令。
你在二维化的失落神庙地图上编排和调整，程序通过 [wc3env-127a](https://github.com/1850VV/wc3env-127a) 控制真实的 1.27a 游戏。

```
浏览器控制台（web/）            离线时：浏览器内模拟器预演整局
   ⇅ HTTP + 服务器推送事件
指挥官服务（bridge/）           事件 → wc3env 命令；游戏事件 → 时间轴状态
   ⇅ wc3env（实时模式）
魔兽争霸三 1.27a（Windows）
```

## 现在能做什么

- **真实地图**：失落神庙的通行网格（640×640，每格 32 游戏单位）、4392 棵树、12 座金矿、4 个出生点。
- **真实数值**：单位和建筑的造价、人口、工期、科技前置取自 1.27a 数据。
- **离线预演**：A* 寻路、建筑选址（避开采金路线）、金矿一次进一个农民、砍树和树木耗尽、人族建造需要农民在场。拖动时间轴上的事件，整局立刻按新编排重算。
- **二维指挥**：选中农民后按快捷键，在地图上点选位置放建筑；选中建筑训练单位；暂停的工地可以派人继续建。每个操作都变成时间轴上的一个事件。
- **摆工地**：地图上的工地框可以直接拖动。拖过的工地是「指定位置」（实线、带圆点），实战按这个坐标精确建造，比自动选的工地优先占位；没拖的是「自动选址」（虚线）。选中事件可以「恢复自动选址」。概览面板列出 30 秒内要开工的工地，点一下跳过去。建筑开工前都能改位置，实战中改了会重新下令。
- **封家**：概览面板按计划里全部工地的位置判断采金区能不能被英雄进来，地图上用圆圈标出最窄处。「自动封家」用计划里最早的祭坛、兵营和最多 4 个农场把采金区围起来，只留 2 格的缝（农民、步兵能过，英雄过不去），结果写成指定位置，之后还能手动拖。南方出生点 3 个农场就能封住；其他出生点在模拟里要 4 个，西方 4 个还差一点。**「2 格能过农民、3 格才过英雄」是按碰撞半径推算的（农民 16、步兵 31、英雄 32），还没在真游戏里验证。**
- **连接游戏**：指挥官服务把事件翻译成 wc3env 命令（`build`、`harvest`、`train`、`smart`），时间轴状态以游戏回报的 `construct_start/finish`、`train_start/finish` 事件为准，不把"命令被接受"当成"已完成"。
- **建筑位置**：在地图上亲手放的工地按精确坐标建造，不会被挪开；建不了会在时间轴上提示并重试，最多 4 次。其余工地交给游戏自带选址（可能挪开几百距离），引擎读取游戏回报的实际坐标来认领新建筑，不会因为挪远而重复建造。
- **AI 建议**：目前是规则引擎占位，之后换成大模型。

## 快速开始

### 1. 只看离线预演（任何系统）

```sh
cd web
python -m http.server 8000
# 打开 http://127.0.0.1:8000/
```

### 2. 用假游戏服务器跑通整条链路（任何系统，不需要魔兽）

需要 Python 3.11+ 和本地的 wc3env-127a 源码。在 Mac / Linux 上运行需要它的跨平台导入修复（`cross-platform-import` 分支：让协议、会话和假服务器不依赖 Windows 也能导入）。

```sh
git clone -b cross-platform-import https://github.com/1850VV/wc3env-127a ../wc3env-127a
cd bridge
WC3ENV_SRC=../../wc3env-127a/src python -m commander_bridge --backend fake --speed 4
# 打开 http://127.0.0.1:8790/ ，点「连接 假游戏服务器」
```

假服务器是 wc3env 自带的 `FakeServer`，配上本仓库的失落神庙测试世界（`bridge/commander_bridge/testworld.py`）：会采金、伐木、建造、训练并发出 wc3env 事件。会话、RPC 和协议校验都是 wc3env 自己的代码，和真游戏只差注入的 DLL。

### 3. 连接真游戏（Windows）

1. 按 wc3env-127a 的 README 准备：1.27a（构建号 1.27.0.52240）、64 位 Python 3.11+、编译好的 `wc3hook.dll`，在 `.env` 里设置 `WC3_GAME_DIR`，并 `pip install -e .`。
2. 确认游戏 `Maps` 目录里有 `(4)LostTemple.w3m`。
3. 启动：

```powershell
cd bridge
python -m commander_bridge --backend wc3env --opponent easy
# 打开 http://127.0.0.1:8790/ ，点「连接 魔兽争霸三」
```

默认以实时模式、后台可见窗口打开：画面照常显示，切到浏览器也不会暂停，但窗口不接收你的鼠标键盘。想自己上手一起玩，加 `--window interactive`（正常窗口，失去焦点时游戏可能暂停）。指挥官只给时间轴上涉及的单位下命令。验收步骤见 [docs/实机验收.md](docs/实机验收.md)。出生点由游戏决定，控制台会自动切换过去。**只在离线单机使用，不要用于战网或任何联网对局。**

> 2026-10-19 已通过 Windows 实机启动与浏览器连接验收，记录见 [本次报告、日志与截图](docs/validation/2026-10-19-startup/README.md)。完整开局行为、选址、寻路和时序仍需逐项验收；启动通过不代表所有游戏行为都已验证。

## 测试

```sh
node --test web/tests/sim.test.js                                  # 模拟器规则（写到文件名，只写目录会报找不到模块）
WC3ENV_SRC=../wc3env-127a/src python -m unittest discover -s bridge/tests -t bridge   # 指挥官服务端到端
```

## 目录

| 路径 | 内容 |
|---|---|
| `web/index.html`、`app.js`、`style.css` | 控制台界面：地图、小地图、状态、命令面板、时间轴、指令输入 |
| `web/sim.js` | 模拟核心：地图模型、寻路、选址、经济、事件执行；浏览器和 Node 共用 |
| `web/data/lost-temple.js` | 生成的地图与数值数据，勿手改 |
| `bridge/commander_bridge/engine.py` | 时间轴 → wc3env 命令；观测和事件 → 事件状态 |
| `bridge/commander_bridge/server.py` | 本地 HTTP 服务、游戏会话线程、服务器推送 |
| `bridge/commander_bridge/testworld.py` | 给 wc3env FakeServer 用的失落神庙经济世界 |
| `tools/build_data.py` | 从 warcraft-commander 提取的数据重新生成 `lost-temple.js` |
| `tools/export_plan.js` | 导出带工地位置的默认计划（测试夹具） |
| `tools/windows/bridge.ps1` | Windows 上启动 / 停止 / 查看指挥官服务；`install` 注册计划任务，供远程启动；加 `-Lan` 对局域网开放控制台 |
| `tools/pc.sh` | 在 Mac / Linux 上通过 SSH 远程操作游戏电脑上的服务，并转发控制台端口 |

## 数据来源与假设

- 地图网格、物件、出生点：[warcraft-commander](https://github.com/1850VV/warcraft-commander) `commander/sandbox/map-data.json`，从发布的失落神庙地图提取。
- 单位数值：同仓库 `commander/commander-economy-data.js`，取自 1.27a 的 UnitBalance 和 HumanUnitFunc。
- 每趟采金/伐木 10、伐木每下 1.1 秒来自单位数据；金矿每次进一个农民；**矿内停留 1 秒和每棵树 50 木是未校准的假设**。
- 不模拟单位之间的碰撞、战斗和维护费。

## 接下来

1. 在 Windows 上做第一次实机验收：开局五个事件能否按时完成。
2. 用实机录到的采金时间校准模拟器。
3. 把规则版 AI 建议换成大模型（参考 wc3env-127a 里的 `wc3agent`）。
4. 按 warcraft-commander 的 AMAI 研究，逐类加入新事件类型（持续补农民、资源预留、开矿任务）。

本仓库代码尚未选择开源许可证。Warcraft 是暴雪娱乐的商标，本项目与暴雪无关。
