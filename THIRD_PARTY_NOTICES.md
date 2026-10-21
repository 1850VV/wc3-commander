# 第三方内容与授权范围

根目录的 [MIT 许可证](LICENSE) 适用于 1850VV 有权授权的本项目原创代码和文档。下列第三方权利不因本项目采用 MIT 而改变；本文也不是对这些材料的再授权。

## 游戏及派生数据

Warcraft、Warcraft III 及相关商标属于 Blizzard Entertainment。本项目与 Blizzard Entertainment 无关联，也未获其背书。连接游戏需要使用者自行准备合法安装。

下列材料包含从游戏或地图提取、转换或观察得到的信息，不应据本项目的 MIT 许可证推定获得其第三方内容的权利：

- `web/data/lost-temple.js`：地图网格、物件、出生点、建筑占地与游戏数值。
- `web/data/sandbox-map.js`：从上述地图数据生成的沙盘表示。
- `bridge/tests/fixtures/`、`web/tests/fixtures/` 中含有的游戏或地图派生数据。
- `strategies/` 中布局所引用的地图坐标、游戏单位名称与数值，以及其中的游戏相关图片。
- `docs/validation/` 和 `docs/images/` 中截图所包含的第三方游戏元素。

生成脚本见 `tools/build_data.py` 和 `tools/bake_sandbox_map.js`；来源与假设见 [使用说明](docs/guide.md#数据来源与假设)。保留这些来源说明，不表示已完成对第三方内容分发权的全面核验。

## 外部项目

- **wc3env-127a**：<https://github.com/1850VV/wc3env-127a>。本项目通过独立 Python 环境使用它；该移植基于 [pwang724/wc3env](https://github.com/pwang724/wc3env)。遵循其 MIT 许可证及仓库中的第三方声明。不能把 wc3env、MinHook 或 yyjson 的版权归为本项目所有。
- **warcraft-commander**：<https://github.com/1850VV/warcraft-commander>。地图与经济数据的提取来源，也是早期实现与研究参考。本次许可决定只针对 wc3-commander，不改变该仓库或其第三方内容的授权状态。
- **AMAI**：<https://github.com/SMUnlimited/AMAI>。本仓库文档引用其规则与设计研究；外部 AMAI 源代码继续适用上游许可证，本项目 MIT 许可不覆盖它。

## 字体

网页通过 Google Fonts 引用 Noto Sans SC、Noto Serif SC 和 JetBrains Mono。字体不因出现在界面或截图中而改用本项目的 MIT 许可证；字体文件的使用和分发遵循各自上游许可证。

## 原型截图

`docs/images/prototype-v8/` 是用户授权发布的 Claude「指挥官控制台 v8」界面截图。截图展示交互原型；原型中的实战状态、回放和部分统计为示意数据。未包含 Claude 聊天记录、账户界面或原始临时目录。
