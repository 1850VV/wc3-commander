"""Read the player's orchestration: a Chinese Markdown table of meta-strategies (docs/元策略.md).

    | 行 | 阶段 | 启动 | 元策略（参数） | 停止 | 优先级 |
    |---|---|---|---|---|---|
    | 5 | 开局 | 0:00 | M4 建造（国王祭坛，布局位置，农民4） | 完工 | 100 |

parse(text) -> (rows, errors). Every error names its row, in Chinese, so the player can fix the
file. Conditions and parameters become small dicts the executor (orchestrator.py) evaluates.
"""
from __future__ import annotations

import re

# Chinese names the player writes -> Warcraft type ids
NAMES = {
    "农民": "hpea", "民兵": "hmil", "步兵": "hfoo", "大法师": "Hamg", "山丘之王": "Hmkg", "牧师": "hmpr", "女巫": "hsor",
    "破法者": "hspt", "水元素": "hwat",
    "城镇大厅": "htow", "分基地": "htow", "主城": "hkee", "城堡": "hcas", "国王祭坛": "halt", "祭坛": "halt", "兵营": "hbar",
    "农场": "hhou", "伐木场": "hlum", "神秘藏宝室": "hvlt", "藏宝室": "hvlt", "神秘圣所": "hars", "神秘圣地": "hars", "圣所": "hars",
    "侦察塔": "hwtw", "奥术塔": "hatw", "防御塔": "hatw", "铁匠铺": "hbla", "车间": "harm", "狮鹫笼": "hgra",
}
SKILLS = {"水元素": "AHwe", "暴风雪": "AHbz", "辉煌光环": "AHab", "风暴之锤": "AHtb", "雷霆一击": "AHtc", "重击": "AHbh", "天神下凡": "AHav"}
META = {1: "采金", 2: "伐木", 3: "训练农民", 4: "建造", 5: "训练单位", 6: "升级", 7: "学技能", 8: "敲钟", 9: "清野",
        10: "小组", 11: "留钱", 12: "人口", 13: "设集结点"}
SELF_DONE = ("完工", "完成", "出生", "学会", "变身完", "清完", "失败", "用完")


class OrchestrationError(ValueError):
    pass


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _num(s: str) -> int:
    m = re.search(r"\d+", s)
    if not m:
        raise OrchestrationError(f"「{s}」里没有数字")
    return int(m.group())


def _type(name: str) -> str:
    name = name.strip()
    if name in NAMES:
        return NAMES[name]
    raise OrchestrationError(f"不认识「{name}」（可以写：{'、'.join(sorted(set(NAMES)))}）")


def parse_condition(text: str, stop: bool = False) -> list[dict]:
    """「第 12 行完成 且 金 ≥ 385」 -> [{"kind": "row_done", "row": 12}, {"kind": "gold", "op": ">=", "n": 385}]."""
    text = (text or "").strip()
    if not text or text in ("—", "-"):
        return [{"kind": "self_done"}] if stop else [{"kind": "time", "t": 0}]
    if stop and text == "不停":
        return [{"kind": "never"}]
    out = []
    for part in re.split(r"\s*且\s*", text):
        p = part.replace(" ", "")
        if m := re.fullmatch(r"(\d+):(\d{2})", p):
            out.append({"kind": "time", "t": int(m[1]) * 60 + int(m[2])})
        elif m := re.fullmatch(r"第(\d+)行(完成|完工)", p):
            out.append({"kind": "row_done", "row": int(m[1])})
        elif m := re.fullmatch(r"第(\d+)行(开工|开始)", p):
            out.append({"kind": "row_started", "row": int(m[1])})
        elif m := re.fullmatch(r"大法师出生前(\d+)秒", p):
            out.append({"kind": "hero_eta", "lead": int(m[1])})
        elif p in ("大法师出生前自动", "大法师出生前"):
            out.append({"kind": "hero_eta", "lead": None})
        elif m := re.fullmatch(r"农民(\d+)出生", p):
            out.append({"kind": "peasant", "cid": int(m[1])})
        elif (m := re.fullmatch(r"(.+?)(出生|完成)", p)) and m[1] in NAMES:
            out.append({"kind": "exists", "type": _type(m[1])})
        elif m := re.fullmatch(r"(金|木)(≥|>=|＞=)(\d+)", p):
            out.append({"kind": "gold" if m[1] == "金" else "wood", "op": ">=", "n": int(m[3])})
        elif m := re.fullmatch(r"(伐木|步兵|农民|采金)(<|＜|=|＝|≥|>=)(\d+)", p):
            op = {"<": "<", "＜": "<", "=": "=", "＝": "=", "≥": ">=", ">=": ">="}[m[2]]
            out.append({"kind": "count", "what": m[1], "op": op, "n": int(m[3])})
        elif p == "资源够":
            out.append({"kind": "always"})
        elif stop and any(p.startswith(w) for w in SELF_DONE):
            out.append({"kind": "self_done"})
        else:
            raise OrchestrationError(f"看不懂条件「{part}」")
    return out


def parse_step(text: str) -> dict:
    """「M4 建造（国王祭坛，布局位置，农民4）」 -> {"m": 4, "params": [...], ...meaning}."""
    m = re.match(r"\s*M(\d+)\s*([^（(]*)[（(](.*)[）)]\s*$", text)
    if not m:
        m2 = re.match(r"\s*M(\d+)\s*(.*)$", text)
        if not m2:
            raise OrchestrationError(f"「{text}」不是元策略（要以 M1–M13 开头）")
        code, params = int(m2[1]), []
    else:
        code, params = int(m[1]), [p.strip() for p in re.split(r"[，,]", m[3]) if p.strip()]
    if code not in META:
        raise OrchestrationError(f"没有元策略 M{code}（只有 M1–M13）")
    s = {"m": code, "name": META[code], "text": text.strip(), "params": params}
    P = params
    if code == 1:
        s["mine"] = "natural" if any("分矿" in p for p in P) else "main"
        s["count"] = _num(next((p for p in P if "人" in p), "5"))
    elif code == 2:
        s["count"] = _num(next((p for p in P if "人" in p), "8"))
    elif code == 3:
        s["base"] = "natural" if any("分基地" in p for p in P) else "main" if any("主基地" in p for p in P) else "any"
    elif code == 4:
        if not P:
            raise OrchestrationError("M4 建造要写建筑名")
        s["btype"] = _type(P[0])
        s["where"], s["builder"], s["helpers"], s["then"] = "layout", None, 0, None
        for p in P[1:]:
            q = p.replace(" ", "")
            if q.startswith(("布局位置", "封家位置", "封家第")):
                s["where"] = "layout"
            elif q == "自动":
                s["where"] = "auto"
            elif q == "分矿旁":
                s["where"] = "natural"
            elif mm := re.fullmatch(r"坐标(-?\d+)[，, ]?(-?\d+)", q):
                s["where"], s["xy"] = "xy", [int(mm[1]), int(mm[2])]
            elif mm := re.fullmatch(r"农民(\d+)", q):
                s["builder"] = int(mm[1])
            elif q.startswith("从伐木抽"):
                s["builder"] = None
            elif q.startswith("分矿组"):
                s["builder"], s["crew"] = None, True
            elif mm := re.fullmatch(r"协助(\d+)人", q):
                s["helpers"] = int(mm[1])
            elif q.startswith("完工去"):
                s["then"] = {"完工去采金": "gold", "完工去伐木": "wood", "完工去分矿采金": "natural"}.get(q)
                if not s["then"]:
                    raise OrchestrationError(f"「{p}」：完工后只能去 采金 / 伐木 / 分矿采金")
            else:
                raise OrchestrationError(f"M4 建造看不懂参数「{p}」")
    elif code == 5:
        if not P:
            raise OrchestrationError("M5 训练单位要写兵种")
        s["utype"] = _type(P[0])
        lim = next((p for p in P[1:] if "上限" in p), None)
        s["cap"] = _num(lim) if lim else None
        s["count"] = None if lim else _num(next((p for p in P[1:] if "个" in p), "1"))
    elif code == 6:
        mm = re.split(r"\s*(?:→|->)\s*", P[0]) if P else []
        if len(mm) != 2:
            raise OrchestrationError("M6 升级写成「城镇大厅 → 主城」")
        s["from"], s["to"] = _type(mm[0]), _type(mm[1])
    elif code == 7:
        if len(P) < 2 or P[1] not in SKILLS:
            raise OrchestrationError(f"M7 学技能写成「大法师，水元素」（技能可以写：{'、'.join(SKILLS)}）")
        s["hero"], s["ability"], s["abilityName"] = _type(P[0]), SKILLS[P[1]], P[1]
    elif code == 8:
        s["count"] = _num(next((p for p in P if "人" in p), "5"))
        s["from"] = "gold" if any("采金" in p for p in P) else "wood"
    elif code == 11:
        s["gold"] = _num(next((p for p in P if "金" in p), "0"))
        s["wood"] = _num(next((p for p in P if "木" in p and "伐木" not in p), "0"))
        give = next((p for p in P if "给第" in p), None)
        s["for"] = _num(give) if give else None
    elif code == 12:
        s["margin"] = _num(next((p for p in P if "剩" in p), "4"))
    elif code == 13:
        mm = re.split(r"\s*(?:→|->)\s*", P[0]) if P else []
        if len(mm) != 2:
            raise OrchestrationError("M13 设集结点写成「国王祭坛 → 城镇大厅」")
        s["building"], s["toward"] = _type(mm[0]), _type(mm[1])
    return s


def parse(text: str) -> tuple[list[dict], list[str]]:
    rows, errors, head = [], [], None
    for line in text.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = _cells(line)
        if head is None:
            if "行" in cells and "启动" in cells and any(c.startswith("元策略") for c in cells):
                head = {("元策略" if c.startswith("元策略") else c): i for i, c in enumerate(cells)}
            continue
        if all(set(c) <= set("-: ") for c in cells):
            continue  # the |---| line
        get = lambda k: cells[head[k]] if k in head and head[k] < len(cells) else ""
        no = get("行")
        try:
            n = int(no)
        except ValueError:
            errors.append(f"有一行的「行」不是数字：{line.strip()}")
            continue
        try:
            steps = [parse_step(x) for x in re.split(r"\s*[＋+]\s*(?=M\d)", get("元策略")) if x.strip()]
            if not steps:
                raise OrchestrationError("没有写元策略")
            prio = get("优先级").strip()
            rows.append({"no": n, "phase": get("阶段") or "编排", "startText": get("启动"), "stopText": get("停止"),
                         "start": parse_condition(get("启动")), "stop": parse_condition(get("停止"), stop=True),
                         "steps": steps, "prio": int(prio) if prio.isdigit() else 50, "text": get("元策略")})
        except OrchestrationError as exc:
            errors.append(f"第 {n} 行：{exc}")
    if head is None:
        errors.append("没找到编排表格（表头要有「行」「启动」「元策略（参数）」「停止」「优先级」）")
    seen = set()
    for r in rows:
        if r["no"] in seen:
            errors.append(f"第 {r['no']} 行重复了")
        seen.add(r["no"])
        for c in r["start"] + r["stop"]:
            if c.get("row") is not None and c["row"] not in {x["no"] for x in rows}:
                errors.append(f"第 {r['no']} 行：引用的第 {c['row']} 行不存在")
    return rows, errors
