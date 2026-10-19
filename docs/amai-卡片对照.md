# AMAI 人族规则 → wc3-commander 卡片对照

研究对象固定在 AMAI 提交 [`de97fae`][amai]（TFT 版本、人族）。下文所有「出处」都指向这个提交里的具体行，点开就能对照源码。AMAI 源码没有放进本仓库；要自己读，可以用参考仓库 `warcraft-commander` 的 `scripts/fetch_amai.py`，或者：

```sh
git init amai && cd amai && git remote add origin https://github.com/SMUnlimited/AMAI.git
git fetch --depth=1 origin de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15 && git checkout --detach FETCH_HEAD
```

本文只整理规则、讨论怎么搬过来，不改代码。文中的数量和时间都是 AMAI 自己的设定，**没有在 1.27a 实机上核对过**。

---

## 0. 先弄清两边的思路差别

| | AMAI | wc3-commander 现在 |
|---|---|---|
| 一条指令长什么样 | 「我要**总共** N 个某单位，优先级 P」（`BuildUnit(8, uFOOTMAN, 65)`） | 「第 t 秒做一次某事」（`build` / `gather` / `train`，各带 `start`） |
| 什么时候执行 | 没有时间表。每隔几秒把所有目标按优先级从高到低排一遍，买得起就开工 | 到了 `start` 时间就尝试开始，开始不了就等 |
| 前置建筑 | 自动补：要步兵就会自动加一条「兵营」，优先级比步兵高一点（[RefreshNeeded][c-refresh]） | 不补，只在备注里写「需要 XX」 |
| 钱不够时 | 最高优先级的东西买不起，就**停下整轮、攒钱给它**，不会先拿钱去买便宜的低优先级东西（[OneBuildLoopAM][c-loop-exit]） | 各事件各自等，谁先凑够钱谁先开工 |
| 农民、农场、分矿 | 由固定的「后台规则」每轮自动处理（[农场][c-farm]、[农民][c-peon]、[分矿][c-expa]），策略文件里不用写 | 要手动一张张排 |

AMAI 每轮都会重新执行一次策略里的语句（[build_sequence_all][r-bsall]），已经达成的目标会自然消失。所以它更像一组**持续生效的规则**，不是一张排好时间的清单。往我们的卡片上搬时，要么把它「摊平」成时间轴上的一次性卡片，要么新加「持续规则」类型的卡片。下文第 2 节逐条标明是哪一种。

时间单位：AMAI 里的 `ai_time` 是**游戏秒数除以 5**（[TimeKeeper][c-time]）。比如 `AddBlock` 的期限写 36，指的是游戏开始后 180 秒左右。

---

## 1. 人族一本 / 二本相关的 AMAI 策略

### 1.1 所有人族策略都会叠加的公共规则

这些写在 `global_init_strategy` / `global_build_sequence` 和底层后台规则里，不管选哪个策略都生效。

| 规则 | 它做什么 | 关键数量和顺序 | 出处 |
|---|---|---|---|
| 祭坛优先 | 前 80 秒内，**开始建**祭坛之前，不建商店、农场、兵营 | 期限 16（≈80 秒）；只要开工即可，不必建成 | [BuildSequence.ai L7–L11][bs-g-altar] |
| 建筑先后关系 | 兵营开工后才建伐木场、铁匠铺（≈100 秒内有效）；兵营**建成**后才建商店（≈180 秒）；有 2 个**建成**的农场才建商店（≈180 秒）；铁匠铺开工后才建哨塔（≈180 秒） | 见左 | [BuildSequence.ai L12–L16][bs-g-blocks] |
| 民兵开矿时先开矿再升本 | 如果正在用民兵开矿，≈180 秒内没有 2 个城镇大厅就不升主城 | 期限 36 | [BuildSequence.ai L20–L22][bs-g-militia] |
| 升本前先把兵出够 | 一本和二本阶段：只要有一种要求的兵种还没达到目标数的 75%，并且人口还不到 60（二本是 90），就不升下一级主城；正在开矿（矿少于 3 个）时也不升。例外：金或木任一项超过升级费用的 4 倍时不拦 | 75%、人口 60 / 90 | [BuildSequence.ai L5–L6][bs-g-tier]、[common.eai L10070–L10077][c-tierblock]、[L12341–L12344][c-loop-tier]、[L12388–L12390][c-loop-tierflag] |
| 自动补农场 | 剩余人口 ≤ `farm_food` 时补 1 个农场，优先级 400（全场最高）。`farm_food` 由性格表决定，人族两个性格是 6 和 7 | 优先级 400；剩余人口阈值 5–7 | [common.eai L11904–L11924][c-farm]、[Settings.txt L8–L9][hs-farm]、[Profiles.txt L1][pf-head]、[L41–L42][pf-human] |
| 自动补农民 | 1 座矿时目标 14 个，2 座 18 个，更多 22 个；木头多时逐步减少（木头 ≤ 200 按上限，≥ 2000 按下限 8 / 14 / 19）。出生点附近有 2 座金矿时目标再加 3 个 | 14 / 18 / 22，下限 8 / 14 / 19，优先级 280 | [common.eai L9933–L9950][c-peontarget]、[L11941–L11984][c-peon]、[Settings.txt L10–L19][hs-peon]、[GlobalSettings.txt L59–L60][gs-wood] |
| 金矿人数 | 主矿 5 人（先派 4 个、再派伐木、再补 1 个）；分矿一般 5 人，金多木少时 3 人。矿上超过上限的农民会被叫停 | 5 人 / 矿 | [common.eai L14594–L14684][c-assign]、[GlobalSettings.txt L91][gs-gold]、[HARVEST_CHECK.eai L33–L61][j-harvest] |
| 伐木人数 | 按金木比例算：先固定 1 人伐木，再按金木差额加派（一般 2 人），木 < 200 时伐木补到约 7 人；其余农民最后全部去伐木 | 见左 | [common.eai L14608–L14634][c-assign-wood]、[L14683][c-assign-rest] |
| 分矿时机 | 主矿农民补满后才开分矿，同时预先多训练下一座矿要的农民；首次开矿时间 = 策略表的 35 + 性格调整（≈175 秒前后）。人族每轮都有 50% 机会跳过等待，直接开矿 | 优先级 280；没矿或矿里剩金 < 2500 时紧急开矿，优先级 500 | [common.eai L12003–L12211][c-expa]、[L9955–L9980][c-expa-peon]、[L7407–L7417][c-fastexpa]、[Strategy.txt L1–L2][st-normal] |
| 分矿协建 | 新城镇大厅开工后，按手头金木（取较少的那个）叫 1–4 个最近的农民一起修，加快建造 | <250→1，<350→2，<450→3，否则 4 | [FAST_BUILD.eai L14–L32][j-fast-n]、[L51–L83][j-fast] |
| 自动维修 | 农民多于 6 个（被攻击时多于 8 个）才打开农民的自动维修 | 6 / 8 | [REPAIR_CONTROL.eai L4–L15][j-repair]、[GlobalSettings.txt L9–L10][gs-repair] |
| 英雄复活 | 英雄死了自动复活，优先级 200 / 180 / 150 | 见左 | [common.eai L12216–L12229][c-revive]、[Settings.txt L2–L4][hs-revive] |
| 防快攻塔 | 离敌人出生点近（「快攻系数」< 5000）时，建 2 座奥术塔、矿边 1 座防御塔 | 见左 | [BuildSequence.ai L90–L93][bs-g-rush]、[common.eai L7007–L7009][c-rush] |
| 有钱就建塔 | 金 > 550 时前线建防御塔、奥术塔各 1；金 > 1000 时防御塔 2 | 见左 | [BuildSequence.ai L94–L100][bs-g-gold] |
| 买物品 | 回复卷轴、治疗卷轴、加速鞋等，一本买小回城，二本买回城和治疗药 | 见左 | [BuildSequence.ai L116–L130][bs-g-items] |
| 二本加牧师 | 二本后至少 2 个牧师（雇佣治疗兵也算）；研究伐木场木材升级 1 | 见左 | [BuildSequence.ai L239–L242][bs-g-t2] |
| 科技升级 | 按已有兵种数量**随机**决定是否研究：例如步兵多就可能研究防御、攻击、护甲 | 见左 | [BuildSequence.ai L227–L250][bs-g-upg]、[common.eai L10355–L10372][c-advupg2] |
| 按敌军配兵 | 用「敌方各类兵力强度」给克制兵种打分，自动混合生产 | 见左 | [BuildSequence.ai L138–L219][bs-g-dyn] |

### 1.2 各策略的一本 / 二本部分

AMAI 用加权随机挑策略（[chooseStrategyRP][r-choose]），`beginning_strat = true` 的才能当开局。下面只列一本（`else` 分支，即 tier 1）和二本（`tier == 2`）。表里「8 步兵 p65」表示「总共要 8 个步兵，优先级 65」，优先级越高越先买。

| 策略（Strategy.txt 行） | 能否开局 | 一本：做什么（数量、优先级） | 二本：做什么 | 出处 |
|---|---|---|---|---|
| NormalHuman 普通（[L2][st-normal]） | 是 | 1 英雄 p80 → 8 步兵 p65 → 3 火枪 p55 → 商店 p54 → **只有 1 座矿时开分矿 p53** → 前线奥术塔 p45 → 火枪补到 4 p43 → **升主城 p42**。注释说这是暴雪原版 AI 的复刻 | 英雄 1 p80、8 步兵 p65、4 火枪 p55、商店、奥术塔、英雄 2 p50、2 迫击炮 p45、升城堡 p45 | [L449–L459][bs-normal-t1]、[L411–L420][bs-normal-t2] |
| MassSp 法师（[L3][st-all]） | 是 | 英雄 1 p80；步兵 / 火枪混合 p56（按敌情分配 16 人口，另外固定加 4 步兵）；升主城 p50；前线奥术塔 p50 | 升城堡 p30；英雄 1、2；10 女巫、10 牧师 p44；两个法师科技 1 级 p64 | [L604–L609][bs-masssp-t1]、[L563–L573][bs-masssp-t2] |
| Gryph 狮鹫（[L4][st-all]） | 是 | 同 MassSp 一本 | 8 步兵 p60、6 龙鹰 p50、升城堡 p55、英雄 1、2 | [L874–L879][bs-gryph-t1]、[L837–L844][bs-gryph-t2] |
| Knight 骑士（[L5][st-all]） | 是 | 英雄 1 p80；近战兵占 24 人口 p38（有骑士就出骑士，否则步兵）；前线防御塔 p45；升主城 p50；奥术塔 p55 | 英雄 1 p90、英雄 2 p80；近战兵 40 人口；4 牧师；2 防御塔；升城堡 p70 | [L730–L736][bs-knight-t1]、[L699–L707][bs-knight-t2]、[races.eai L489–L491][r-melee] |
| Rifle 火枪（[L6][st-all]） | 是 | **开局限制**：≈300 秒内铁匠铺开工前最多 1 个农场、最多 9 个农民，铁匠铺建成前不建商店。然后：雇佣兵 p60；步兵 / 火枪混合 p56（按敌情分配 12 人口，另外固定加 2 步兵、4 火枪）；英雄 1 p80；升主城 p50 | 15 火枪 p45、英雄 1、2、3 牧师 p67、升城堡 p50 | [L916–L918][bs-rifle-init]、[L1026–L1031][bs-rifle-t1]、[L988–L994][bs-rifle-t2] |
| Mortars 迫击炮（[L7][st-all]） | 否 | 开局限制同 Rifle；一本同 Rifle | 6 迫击炮 p62、12 火枪 p50、升城堡 | [L1069–L1071][bs-mortar-init]、[L1183–L1188][bs-mortar-t1]、[L1144–L1151][bs-mortar-t2] |
| Copters 飞行器（[L8][st-all]） | 否 | 同 MassSp 一本，没有奥术塔 | 30 飞行器 p15、两个飞行器科技 p75、升城堡 | [L1326–L1330][bs-copter-t1]、[L1292–L1300][bs-copter-t2] |
| MassSB 破法者（[L9][st-all]） | 是 | 同 MassSp 一本 | 20 破法者 p35、5 牧师 p65、升城堡 p30、2 奥术塔 | [L1494–L1499][bs-masssb-t1]、[L1449–L1457][bs-masssb-t2] |
| Dragonhawk 龙鹰（[L10][st-all]） | 否 | 同 MassSp 一本 | 15 龙鹰 p45、升城堡 p55 | [L1649–L1653][bs-dh-t1]、[L1611–L1617][bs-dh-t2] |
| BarrackMix 兵营混合（[L11][st-all]） | 是 | 步兵 / 火枪混合 p70（按敌情分配 18 人口，另外固定加 2 步兵、4 火枪）；步兵满 5 个研究防御 p55；升主城 p55；**英雄 1 p120**；商店 p55 | 混合 20 人口 p70；迫击炮 / 飞行器混合；升城堡 p45；按兵数逐级研究攻防 | [L1804–L1810][bs-bmix-t1]、[L1766–L1779][bs-bmix-t2] |
| SanctumMix 法师塔混合（[L12][st-all]） | 是 | 前线奥术塔 p75；英雄 1 p80；混合 16 人口 p56；升主城 p50 | 破法者 / 女巫混合、7 牧师、4 龙鹰、升城堡 p42 | [L1969–L1974][bs-smix-t1]、[L1924–L1937][bs-smix-t2] |
| HAntiTower 反塔（[L13][st-all]） | 否 | 同 MassSp 一本，没有奥术塔 | 10 迫击炮、14 步兵 p60、升城堡 | [L2163–L2167][bs-at-t1]、[L2116–L2122][bs-at-t2] |
| VersusOrc 对兽人（[L14][st-all]） | 是 | 同 MassSp 一本，没有奥术塔 | 15 女巫 p60、5 牧师 p80、升城堡 p60 | [L2302–L2306][bs-vo-t1]、[L2271–L2279][bs-vo-t2] |

几个容易看漏的点：

- **只有 NormalHuman 在一本明确开分矿**（`BasicExpansionAM`）。其他策略都靠后台的分矿规则，只要到时间、主矿农民满了就会开。
- 一本阶段大部分策略几乎一样：英雄 + 步兵 / 火枪混合 + 升主城 p50。真正的区别在二本以后。
- 英雄：`hero[1]` 按 [Heroes.txt][he-human] 的权重随机选（大法师基础分 41、山丘 30 最高）；加点顺序在 [HeroSkills.txt][hsk]（第 2–10 行是大法师的 9 种方案，11–19 山丘，20–28 圣骑士，29–37 血法师）。

---

## 2. 每条规则对应到我们的卡片

分类说明：

- **现在就能表达**：用现有的 `build`（可带 `at` / `exact`）、`gather`、`train`（可带 `then`）排在时间轴上就行。
- **计划中的新卡片**：主会话已经计划的几种：`after` 依赖、「农民补到 N 个」、「金矿保持 N 农」、「重建被拆建筑」、「生产 N 个单位」、升级主基地、分矿、科技研究。
- **需要别的新能力**：计划清单里没有的。
- **不能照搬**：用了真人玩家看不到的信息（敌人真实位置、全部兵力）或作弊分支。只能改写成基于自己视野的版本，或者干脆不做。

| # | AMAI 规则 | 分类 | 怎么落到卡片上 |
|---|---|---|---|
| 1 | 祭坛开工前不建农场 / 兵营 / 商店 | 现在就能表达；正式做法用 `after` | 默认计划里祭坛 0 秒、农场 0 秒、兵营 1 秒，同时开工，已经满足（AMAI 只要求「开工」）。改成 `after: 祭坛开工` 后，玩家拖动时间也不会被打乱 |
| 2 | 兵营 → 伐木场 / 铁匠铺；兵营建成 → 商店；2 个农场建成 → 商店；铁匠铺 → 哨塔 | 计划中：`after` | `after` 要能区分「开工」和「建成」两种条件，AMAI 两种都用了（`only_done`）。AMAI 的期限（80–300 秒后失效）可以先不搬 |
| 3 | Rifle 开局：铁匠铺开工前最多 1 农场、9 农民 | 计划中：`after` + 「农民补到 N 个」 | 「农民补到 9 个」→ `after: 铁匠铺开工` → 「农民补到 14 个」。注意 AMAI 的「最多」是给目标总数封顶，不是暂停训练 |
| 4 | 自动补农民 14 / 18 / 22 | 计划中：「农民补到 N 个」 | 卡片参数 N 就是**总数**（含正在训练的），不是「再训练 N 个」。AMAI 按金矿数自动切换 N，可以先做成固定 N，分矿后再放一张 N=18。木头多时减少农民的规则先不做 |
| 5 | 金矿 5 人，多余的叫停 | 计划中：「金矿保持 N 农」 | N 默认 5。AMAI 会主动把超员的农民叫停，我们也要做「多了就撤到伐木」，否则卡片只会加不会减。注意不要给矿里（`inside`）的农民下命令 |
| 6 | 伐木人数按金木比例调整 | 需要别的新能力（资源比例规则） | 现在只能用多张 `gather wood` 手动排。以后可以做「其余农民全部伐木」这种兜底卡片，对应 AMAI 的 [`HarvestWood(0,20)`][c-assign-rest] |
| 7 | 自动补农场（剩余人口 ≤ 6 时补 1 个，优先级最高） | 需要别的新能力（持续规则：防卡人口） | 现在的 `build hhou` 只能按时间排，节奏一变就会卡人口。建议做成「剩余人口 ≤ K 就补农场」的持续卡片，K 默认 6 |
| 8 | `BuildUnit(8, 步兵, 65)` 这类目标总数 | 计划中：「生产 N 个单位」 | 参数是总数。现在的 `train` 是一次一个，8 个步兵要排 8 张，而且死了不会补。新卡片每轮检查「现有 + 正在训练」< N 就再训练一个 |
| 9 | 缺前置建筑时自动补（要火枪就补铁匠铺） | 需要别的新能力（目标展开） | 先做成**检查**：卡片缺前置时在界面上提示「需要先建铁匠铺」，由玩家决定是否插卡。AMAI 自动补的做法和「玩家说了算」有冲突，不宜直接照搬 |
| 10 | 按优先级排队、买不起最高优先级时整轮攒钱 | 需要别的新能力（优先级 / 预算） | 我们现在按时间先到先得。要实现「攒钱升本」，可以先做简单版：某张卡片标记「预留资源」，其他卡片开工前先扣掉这部分钱 |
| 11 | 升主城（一本 p42–p55） | 计划中：升级主基地 | 卡片本身简单（对城镇大厅下升级命令，看 construct/upgrade 事件确认）。AMAI 的附加条件见下一行 |
| 12 | 升本前兵出够 75%、人口 < 60、钱超 4 倍可放行；开矿中不升 | 计划中：升级主基地 + `after` 的条件版 | 可以拆成：`after: 步兵 ≥ 6 且 火枪 ≥ 3` 或 `after: 分矿建成`。「75% 规则」本身需要「生产 N 个」卡片存在才有意义 |
| 13 | NormalHuman 一本开分矿 p53（只有 1 座矿时） | 计划中：分矿 | 分矿卡片 = 选矿 + 派农民 + 在矿旁精确坐标建城镇大厅（`exact`）。失落神庙的分矿位置是固定的，可以直接给 `at` |
| 14 | 后台分矿：主矿农民满了才开、提前多训练农民、到时间才开 | 计划中：分矿 + 「农民补到 N 个」 | 分矿卡片带 `after: 主矿 ≥ 5 农 且 农民总数 ≥ 14`；同时放一张「农民补到 18 个」。紧急开矿（没矿 / 剩金 < 2500）以后再做 |
| 15 | 分矿前检查矿点野怪强度 | 需要别的新能力（地图野怪数据） | AMAI 读的是野怪实际强度（[GetLocationCreepStrength][c-creep]）。失落神庙的野怪营地是固定地图数据，可以离线写进 `data/lost-temple.js`，按「这个点有没有清过」判断，不依赖隐藏信息 |
| 16 | 分矿协建（1–4 个农民一起修） | 需要别的新能力（协建 / 修理命令） | 新建筑开工后，对附近 K 个农民下「修理这栋建筑」。需要先确认 wc3env 能否对施工中的建筑下修理命令 |
| 17 | 民兵开矿（拉民兵清野、开矿） | 需要别的新能力（民兵 + 部队任务） | 牵涉民兵变身、集合清野、失败回退，范围大，放后面 |
| 18 | 自动维修开关（农民 > 6） | 需要别的新能力（技能自动施放开关） | 小功能，但要 wc3env 支持切换自动施放 |
| 19 | 英雄复活 | 需要别的新能力（「复活英雄」卡片），思路同「重建被拆建筑」 | 祭坛空闲 + 英雄死亡 → 复活。可以和「重建被拆建筑」共用「发现缺了就补」的框架 |
| 20 | 第一个英雄、第二个英雄（二本 p50–p80） | 现在就能表达 | `train Hamg` 已有。第二英雄就是二本后再排一张 `train` |
| 21 | 英雄选择（加权随机） | 不搬规则，作为策略库参数 | 由玩家在策略里选定，不要随机 |
| 22 | 英雄加点顺序（HeroSkills.txt） | 需要别的新能力（英雄加点卡片） | 表格可以直接转成卡片参数：等级 1 学 X、等级 2 学 Y…… |
| 23 | 科技研究（BuildUpgr / BuildAdvUpgr2） | 计划中：科技研究 | `BuildUpgr(2, 攻击)` 的 2 是**目标等级**，不是研究 2 次。AMAI 的随机触发不要搬，改成固定条件（如 `after: 步兵 ≥ 5` 再研究防御） |
| 24 | 有钱就建塔（金 > 550 / > 1000） | 需要别的新能力（资源条件 + 前线选址） | 资源条件可以并进 `after`。「前线」位置要另算，失落神庙可以先手动放 `at` |
| 25 | 买物品（卷轴、回城、鞋） | 需要别的新能力（购买物品卡片） | 先做固定清单：商店建成后买 X |
| 26 | 一本步兵 / 火枪按敌情混合（SetBuildReact） | **不能照搬** | 敌情来自 [GetPlayer…Strength][c-strength]，它用 `GetPlayerUnitTypeCount` 数敌人**全部**单位，包括战争迷雾里的（[UPDATE_STRENGTH][j-strength]）。改成固定比例（如 4 步兵 + 4 火枪），或以后只按自己看到的敌兵调整 |
| 27 | 全局「按敌军克制」自动配兵（DynamicBuildUnit） | **不能照搬** | 同上，依赖全图敌军统计 |
| 28 | 防快攻塔（快攻系数 < 5000） | **不能照搬** | 系数用的是敌人的**真实出生点**（[MinRangeToEnemy][c-minrange]）。失落神庙 1v1 开局时并不知道对手在哪个点。可以改成「侦察到对手位置后」的条件，或者让玩家手动决定 |
| 29 | 分矿时如果矿点有敌人就暂停（BUILD_EXPANSION 的 HARD 分支） | **不能照搬** | 源码注释自己写了这是「开图」行为（[L43–L54][j-buildexp-hard]）。普通玩家版只能用农民自身附近的敌人（同一个文件 L33–L41 那段可参考，但也要改成只看可见单位） |
| 30 | 骚扰农民（Harass） | 需要别的新能力（部队任务） | 不在运营范围内，暂缓 |
| 31 | 策略挑选（加权随机）、中途换策略（StrategyChanger） | 不搬规则，作为策略库功能 | 策略库由玩家挑，不随机；换策略可以以后做成「建议」 |

---

## 3. 迁移时必须保留的语义

1. **数量都是总数，不是增量。** `BuildUnit(8, 步兵)` 的意思是「让步兵总数达到 8」，已经有 3 个就只再训练 5 个，死了 2 个会补回来。判断时，正在训练、正在建造的也算进总数（[SetBuildAllAMCore][c-core] 用的是 `TownCountTown`，包含未完成的）。「农民补到 N」「生产 N 个」「金矿保持 N 农」都要按这个来做，否则会重复生产。
2. **计数会合并同类。** 城镇大厅的计数包含主城和城堡，农民的计数包含民兵（[StandardUnits.txt][su-human] 的「add for counting」列）。「城镇大厅 ≥ 2」在升本以后仍然成立。
3. **升级 / 研究的数量是目标等级。** `BuildUpgr(2, 攻击)` = 研究到 2 级；已经 2 级就什么都不做（[L10166–L10169][c-core-upg]）。
4. **「开工」和「建成」是两种条件。** `AddBlock` 的 `only_done` 区分了这两者：祭坛只要开工，商店要等兵营建成。我们的 `after` 也要能写清楚是哪种。
5. **限制规则是给目标数封顶，不是暂停。** `AddBlock(…, 0, 商店, …)` 是「条件不满足时，商店目标数最多为 0」；条件满足或过了期限就自动解除。
6. **优先级越高越先，且会随等待时间上涨。** 每轮没买到的条目优先级 +1（[L12398][c-loop-aging]、`prio_t_inc`）。同一个 `BuildUnit` 里，第 1 个单位比第 8 个优先级高 14（每个差 2，`prio_q_inc`）；自动补的前置建筑比原条目高 2–6（`prio_n_inc`）。如果我们以后做优先级，要保留「高优先级买不起时不让低优先级抢钱」这一条，否则「攒钱升本」不成立。
7. **农民目标随矿数切换。** 14 / 18 / 22 按「正在采的金矿数」切换，分矿建成前就会提前把目标调到下一档（[QueueExpansionPeonsIfNeeded][c-expa-peon]）。
8. **时间单位是 5 秒。** `AddBlock` 期限、`strat_minimum_time`、首次开矿时间都按 `ai_time` 算，换算成秒要乘 5。
9. **随机的部分要固定下来。** 策略选择、英雄选择、科技是否研究、人族跳过开矿等待（50%）、民兵开矿（60%）都是随机的。拿 AMAI 当参照比较时，要先把这些固定成某一个结果。
10. **命令被接受 ≠ 成功。** AMAI 每轮按实际单位数重新算，天然不会因为一次命令失败而卡住。我们的新卡片也要按观测和游戏事件更新状态（见 CLAUDE.md 的规则），不能下完命令就标记完成。

---

## 4. 建议先接入的 5 条

都围绕第一个正式策略「人族二本数矿」，并且不需要隐藏信息。

| 顺序 | 接什么 | 对应卡片 | 为什么先做 |
|---|---|---|---|
| 1 | 农民补到 N 个（14 → 开矿后 18） | 计划中：「农民补到 N 个」 | 数矿策略的基础。现在默认计划里农民是一张张手排的，节奏一变就乱。语义清楚（总数），只需要数「农民 + 训练中」，最容易验证 |
| 2 | 金矿保持 5 农 + 多余的去伐木 | 计划中：「金矿保持 N 农」 | 开分矿后必须有。AMAI 的数值（每矿 5 人）简单明确；一并补上「矿里的农民不能下命令」的保护 |
| 3 | 自动补农场（剩余人口 ≤ 6） | 新的持续规则卡片 | AMAI 给它全场最高优先级（400），说明卡人口是运营最常见的问题。规则只有一个阈值，做起来很小，却能让后面所有「生产 N 个」不再卡住 |
| 4 | `after` 依赖，先覆盖 AMAI 的建筑先后关系 | 计划中：`after` | 第 2 节的 #1–#3、#12、#14 都要用到它。AMAI 已经给了一套现成的人族先后关系（祭坛 → 兵营 → 铁匠铺 / 伐木场，2 农场 → 商店），可以直接拿来当测试用例 |
| 5 | 升级主基地 + 分矿，带 AMAI 的放行条件 | 计划中：升级主基地、分矿 | 二本数矿的两张核心卡片。可以先用 NormalHuman 一本当模板：英雄 → 步兵 / 火枪 → 商店 → 「只有 1 座矿时开分矿」→ 「兵出够了再升主城」，再换成用户给的具体 timing |

暂时不做：按敌情配兵、防快攻塔、开图分支（都依赖隐藏信息）；骚扰、民兵开矿、买物品、英雄加点（离运营核心远，或者需要 wc3env 新命令）。

[amai]: https://github.com/SMUnlimited/AMAI/tree/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15
[bs-g-tier]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L5-L6
[bs-g-altar]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L7-L11
[bs-g-blocks]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L12-L16
[bs-g-militia]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L20-L22
[bs-g-rush]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L90-L93
[bs-g-gold]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L94-L100
[bs-g-items]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L116-L130
[bs-g-dyn]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L138-L219
[bs-g-upg]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L227-L250
[bs-g-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L239-L242
[bs-normal-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L411-L420
[bs-normal-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L449-L459
[bs-masssp-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L563-L573
[bs-masssp-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L604-L609
[bs-knight-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L699-L707
[bs-knight-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L730-L736
[bs-gryph-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L837-L844
[bs-gryph-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L874-L879
[bs-rifle-init]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L916-L918
[bs-rifle-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L988-L994
[bs-rifle-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1026-L1031
[bs-mortar-init]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1069-L1071
[bs-mortar-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1144-L1151
[bs-mortar-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1183-L1188
[bs-copter-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1292-L1300
[bs-copter-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1326-L1330
[bs-masssb-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1449-L1457
[bs-masssb-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1494-L1499
[bs-dh-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1611-L1617
[bs-dh-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1649-L1653
[bs-bmix-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1766-L1779
[bs-bmix-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1804-L1810
[bs-smix-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1924-L1937
[bs-smix-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L1969-L1974
[bs-at-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L2116-L2122
[bs-at-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L2163-L2167
[bs-vo-t2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L2271-L2279
[bs-vo-t1]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/BuildSequence.ai#L2302-L2306
[st-normal]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/Strategy.txt#L1-L2
[st-all]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/Strategy.txt#L1-L14
[hs-revive]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/Settings.txt#L2-L4
[hs-farm]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/Settings.txt#L8-L9
[hs-peon]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/Settings.txt#L10-L19
[he-human]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/Heroes.txt#L10-L13
[hsk]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Human/HeroSkills.txt#L1-L37
[pf-head]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Profiles.txt#L1
[pf-human]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/Profiles.txt#L41-L42
[gs-repair]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/GlobalSettings.txt#L9-L10
[gs-wood]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/GlobalSettings.txt#L59-L60
[gs-gold]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/GlobalSettings.txt#L91
[su-human]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/TFT/StandardUnits.txt#L10-L39
[c-strength]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L5553-L5566
[c-creep]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L5612
[c-minrange]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L6967-L6983
[c-rush]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L7007-L7009
[c-fastexpa]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L7407-L7417
[c-peontarget]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L9933-L9950
[c-expa-peon]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L9955-L9980
[c-tierblock]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L10070-L10077
[c-core]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L10160-L10216
[c-core-upg]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L10166-L10169
[c-refresh]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L10218-L10278
[c-advupg2]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L10355-L10372
[c-farm]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L11904-L11924
[c-peon]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L11941-L11984
[c-expa]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L12003-L12211
[c-revive]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L12216-L12229
[c-time]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L12234-L12244
[c-loop-tier]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L12341-L12344
[c-loop-tierflag]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L12388-L12390
[c-loop-exit]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L12391
[c-loop-aging]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L12398
[c-assign]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L14594-L14684
[c-assign-wood]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L14608-L14634
[c-assign-rest]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/common.eai#L14683
[r-choose]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/races.eai#L210-L302
[r-melee]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/races.eai#L489-L491
[r-bsall]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/races.eai#L848
[j-harvest]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/Jobs/HARVEST_CHECK.eai#L33-L61
[j-fast-n]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/Jobs/FAST_BUILD.eai#L14-L32
[j-fast]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/Jobs/FAST_BUILD.eai#L51-L83
[j-repair]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/Jobs/REPAIR_CONTROL.eai#L4-L15
[j-strength]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/Jobs/UPDATE_STRENGTH.eai#L19-L49
[j-buildexp-hard]: https://github.com/SMUnlimited/AMAI/blob/de97faeb73c420d165bd9eaf8a4c7e19e0a1bb15/Jobs/BUILD_EXPANSION.eai#L43-L54
