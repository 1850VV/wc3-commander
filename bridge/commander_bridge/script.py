"""The tactic script (docs/战术脚本-草稿.md): positions, every peasant's life, every building's queue.

    位置 祭坛 = 布局.国王祭坛
    农民4：建造 国王祭坛 @祭坛 → 伐木 主矿
    城镇大厅：农民6 → 农民7 → [#分基地 开工] 升级 主城 #主城
    大法师：学 水元素 → 集合 @前方空地 → 清野 @分矿
    步兵：[3:30] 攻击移动 @分矿 → 待命 @分矿
    留钱 金385 木205 给 #分基地 从 [清野 完成]

A lane written as「#⏸ 农民8：…」is paused: kept in the script (the console shows it greyed) but not
played. parse(text) -> (model, errors); to_text(model) writes the same script back (the console edits the
model and saves it as text). A model is plain JSON so the console can drag steps around.
Errors name the line, in Chinese.
"""
from __future__ import annotations

import re

from .orchestration import NAMES, SKILLS

PEASANT_ACTS = ("采金", "伐木", "建造", "协助", "敲钟", "集合", "清野", "待命", "移动")
HERO_ACTS = ("学", "集合", "清野", "待命", "攻击移动", "移动")
ARMY_ACTS = ("集合", "攻击移动", "待命", "移动")  # 移动: walk there, the step is done on arrival (集合/待命 stay until the next step's condition)  # the 步兵 lane: every footman not busy clearing
MINES = {"主矿": "main", "分矿": "natural"}
HEROES = {"大法师": "Hamg", "山丘之王": "Hmkg"}


class ScriptError(ValueError):
    pass


# ---- conditions -----------------------------------------------------------------------------------
def parse_cond(text: str) -> list[dict]:
    """「金≥385 木≥205」「#分基地 开工」「大法师剩余 ≤ 集合用时」… -> [{kind...}]"""
    out = []
    t = text.strip()
    parts = [p for p in re.split(r"\s*且\s*", t) if p]
    for part in parts:
        p = part.replace(" ", "")
        # several resource terms in one bracket: 金≥385木≥205
        res = re.findall(r"(金|木)(?:≥|>=)(\d+)", p)
        if res and re.fullmatch(r"(?:(?:金|木)(?:≥|>=)\d+)+", p):
            out += [{"kind": "gold" if k == "金" else "wood", "n": int(n)} for k, n in res]
        elif m := re.fullmatch(r"(\d+):(\d{2})", p):
            out.append({"kind": "time", "t": int(m[1]) * 60 + int(m[2])})
        elif m := re.fullmatch(r"#(.+?)(开工|完成)", p):
            out.append({"kind": "tag_started" if m[2] == "开工" else "tag_done", "tag": m[1]})
        elif m := re.fullmatch(r"(大法师|山丘之王)出生", p):
            out.append({"kind": "hero_born", "hero": HEROES[m[1]]})
        elif re.fullmatch(r"大法师剩余(≤|<=)集合用时", p):
            out.append({"kind": "hero_eta"})
        elif p == "清野完成":
            out.append({"kind": "clear_done"})
        elif m := re.fullmatch(r"人口剩(≤|<=)(\d+)", p):
            out.append({"kind": "food_left", "n": int(m[2])})
        else:
            raise ScriptError(f"看不懂条件「{part}」")
    return out


def cond_text(conds: list[dict]) -> str:
    out = []
    for c in conds:
        k = c["kind"]
        out.append({"time": lambda: f"{c['t'] // 60}:{c['t'] % 60:02d}", "gold": lambda: f"金≥{c['n']}", "wood": lambda: f"木≥{c['n']}",
                    "tag_started": lambda: f"#{c['tag']} 开工", "tag_done": lambda: f"#{c['tag']} 完成",
                    "hero_born": lambda: f"{next(n for n, t in HEROES.items() if t == c['hero'])} 出生",
                    "hero_eta": lambda: "大法师剩余 ≤ 集合用时", "clear_done": lambda: "清野 完成",
                    "food_left": lambda: f"人口剩 ≤ {c['n']}"}[k]())
    # resources read best together: 金≥385 木≥205
    return " 且 ".join(x for x in out if not x.startswith(("金", "木"))) + (
        (" 且 " if any(not x.startswith(("金", "木")) for x in out) and any(x.startswith(("金", "木")) for x in out) else "")
        + " ".join(x for x in out if x.startswith(("金", "木"))))


# ---- steps ------------------------------------------------------------------------------------
def _type(name):
    name = name.strip()
    if name not in NAMES:
        raise ScriptError(f"不认识「{name}」")
    return NAMES[name]


def parse_step(text: str, lane_kind: str) -> dict:
    s = text.strip()
    cond = []
    if s.startswith("["):
        end = s.index("]")
        cond, s = parse_cond(s[1:end]), s[end + 1:].strip()
    tag = None
    if m := re.search(r"\s#(\S+)\s*$", " " + s):
        tag, s = m[1], s[:len(s) - len(m[0]) + 1].strip()
    pos = None
    if m := re.search(r"@(\S+)", s):
        pos, s = m[1], (s[:m.start()] + s[m.end():]).strip()
    words = s.split()
    if not words:
        raise ScriptError("空的一步")
    act, rest = words[0], words[1:]
    step = {"cond": cond, "act": act}
    if pos:
        step["pos"] = pos
    if tag:
        step["tag"] = tag
    if lane_kind == "peasant":
        if act in ("采金", "伐木"):
            step["mine"] = MINES.get(rest[0] if rest else "主矿")
            if step["mine"] is None:
                raise ScriptError(f"{act} 后面写 主矿 或 分矿")
        elif act == "建造":
            if not rest:
                raise ScriptError("建造 后面写建筑名")
            step["btype"] = _type(rest[0])
            step.setdefault("pos", "自动")
        elif act == "协助":
            if not tag:
                raise ScriptError("协助 后面写 #建筑名，例如 协助 #分基地")
        elif act in ("敲钟",):
            pass
        elif act in ("集合", "清野", "待命", "移动"):
            if not pos:
                raise ScriptError(f"{act} 后面写 @位置")
        else:
            raise ScriptError(f"农民不会「{act}」（可以写：{'、'.join(PEASANT_ACTS)}）")
    elif lane_kind == "army":
        if act not in ARMY_ACTS:
            raise ScriptError(f"步兵不会「{act}」（可以写：{'、'.join(ARMY_ACTS)}）")
        if not pos:
            raise ScriptError(f"{act} 后面写 @位置")
    elif lane_kind == "hero":
        if act == "学":
            if not rest or rest[0] not in SKILLS:
                raise ScriptError(f"学 后面写技能（{'、'.join(SKILLS)}）")
            step["ability"], step["abilityName"] = SKILLS[rest[0]], rest[0]
        elif act in ("集合", "清野", "待命", "攻击移动", "移动"):
            if not pos:
                raise ScriptError(f"{act} 后面写 @位置")
        else:
            raise ScriptError(f"英雄不会「{act}」（可以写：{'、'.join(HERO_ACTS)}）")
    else:  # building
        if m := re.fullmatch(r"农民(\d+)", act):
            step.update(act="农民", peasant=int(m[1]))
        elif act == "集结点":
            if not pos and not rest:
                raise ScriptError("集结点 后面写 @位置 或 单位名")
            if not pos:
                step["rallyUnit"] = _type(rest[0])
        elif act == "升级":
            if not rest:
                raise ScriptError("升级 后面写目标，例如 升级 主城")
            step["to"] = _type(rest[0])
        else:
            step["unit"] = _type(act)
            n = next((int(x.lstrip("×x*")) for x in rest if re.fullmatch(r"[×x*]\d+", x)), 1)
            step["count"] = n
            step["act"] = "训练"
    step["raw"] = text.strip()
    return step


def step_text(step: dict) -> str:
    out = [f"[{cond_text(step['cond'])}]"] if step.get("cond") else []
    a = step["act"]
    if a in ("采金", "伐木"):
        out += [a, "分矿" if step.get("mine") == "natural" else "主矿"]
    elif a == "建造":
        out += [a, next(n for n, t in NAMES.items() if t == step["btype"])]
    elif a == "农民":
        out.append(f"农民{step['peasant']}")
    elif a == "训练":
        out.append(next(n for n, t in NAMES.items() if t == step["unit"]) + (f" ×{step['count']}" if step.get("count", 1) > 1 else ""))
    elif a == "升级":
        out += [a, next(n for n, t in NAMES.items() if t == step["to"])]
    elif a == "学":
        out += [a, step["abilityName"]]
    elif a == "集结点" and step.get("rallyUnit"):
        out += [a, next(n for n, t in NAMES.items() if t == step["rallyUnit"])]
    else:
        out.append(a)
    if step.get("pos") and not (a == "建造" and step["pos"] == "自动" and False):
        out.append("@" + step["pos"])
    if step.get("tag"):
        out.append("#" + step["tag"])
    return " ".join(out)


# ---- the whole script -------------------------------------------------------------------------
def _lane_head(head: str) -> dict:
    head = head.strip()
    if m := re.fullmatch(r"农民([\d、,，\s]+)", head):
        cids = [int(x) for x in re.split(r"[、,，\s]+", m[1]) if x]
        return {"kind": "peasant", "cids": cids}
    if head in HEROES:
        return {"kind": "hero", "hero": HEROES[head]}
    if head in ("步兵", "部队"):
        return {"kind": "army", "unit": "hfoo"}
    if head.startswith("#"):
        return {"kind": "building", "tag": head[1:]}
    if head in NAMES:
        return {"kind": "building", "btype": NAMES[head]}
    raise ScriptError(f"不认识「{head}」（一行的开头写 农民N、建筑名、#建筑名、英雄名 或 步兵）")


def parse(text: str) -> tuple[dict, list[str]]:
    model = {"header": "", "positions": [], "lanes": [], "reserves": []}
    errors: list[str] = []
    lines: list[tuple[int, str, str]] = []
    notes: list[str] = []      # comment lines kept with the line they stand above (the console shows them)
    header: list[str] = []     # comments at the very top, before the first section
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        s = line.strip()
        if not s or s.startswith(("# ", "#-", "//", "```")) or s == "#":
            if s.startswith(("# ", "//")) and not s.startswith("# ---"):
                notes.append(s.lstrip("#/ ").strip())
            if s.startswith("# ---") and not lines and not header:
                header, notes = notes, []
            continue
        if raw[:1] in (" ", "\t") or s.startswith("→"):
            if lines:
                lines[-1] = (lines[-1][0], lines[-1][1] + " " + s, lines[-1][2])
                continue
        lines.append((n, s, " ".join(notes)))
        notes = []
    model["header"] = "\n".join(header)
    for n, s, note in lines:
        try:
            if s.startswith("位置"):
                m = re.fullmatch(r"位置\s*(\S+)\s*=\s*(.+)", s)
                if not m:
                    raise ScriptError("位置 写成「位置 名字 = 布局.国王祭坛」")
                model["positions"].append({"name": m[1], "expr": m[2].strip(), "line": n, "note": note})
            elif s.startswith("留钱"):
                m = re.fullmatch(r"留钱\s*金\s*(\d+)\s*木\s*(\d+)\s*给\s*#(\S+)(?:\s*从\s*\[(.+)\])?", s)
                if not m:
                    raise ScriptError("留钱 写成「留钱 金385 木205 给 #分基地 从 [清野 完成]」")
                model["reserves"].append({"gold": int(m[1]), "wood": int(m[2]), "tag": m[3], "cond": parse_cond(m[4]) if m[4] else [], "line": n, "note": note, "raw": s})
            else:
                muted = s.startswith("#⏸")
                if muted:
                    s = s[2:].strip()
                head, sep, body = re.split(r"([：:])", s, maxsplit=1) if re.search(r"[：:]", s) else (s, "", "")
                if not sep:
                    raise ScriptError("每行写成「谁：第一步 → 第二步 → …」")
                lane = _lane_head(head)
                lane["line"], lane["note"], lane["head"] = n, note, head.strip()
                lane["steps"] = [parse_step(x, lane["kind"]) for x in re.split(r"\s*→\s*", body.strip()) if x.strip()]
                if not lane["steps"]:
                    raise ScriptError(f"「{head}」后面至少写一步")
                if muted:
                    lane["muted"] = True
                model["lanes"].append(lane)
        except ScriptError as exc:
            errors.append(f"第 {n} 行：{exc}")
    names = {p["name"] for p in model["positions"]}
    tags = {st["tag"] for ln in model["lanes"] for st in ln["steps"] if st.get("tag")}
    for ln in model["lanes"]:
        for st in ln["steps"]:
            if st.get("pos") and st["pos"] not in names and st["pos"] != "自动":
                errors.append(f"第 {ln['line']} 行：位置 @{st['pos']} 没有定义（先写「位置 {st['pos']} = …」）")
            for c in st["cond"]:
                if c.get("tag") and c["tag"] not in tags:
                    errors.append(f"第 {ln['line']} 行：#{c['tag']} 没有哪一步建造它")
        if ln["kind"] == "building" and ln.get("tag") and ln["tag"] not in tags:
            errors.append(f"第 {ln['line']} 行：#{ln['tag']} 没有哪一步建造它")
    trained = [st["peasant"] for ln in model["lanes"] if ln["kind"] == "building" for st in ln["steps"] if st["act"] == "农民"]
    lives = {c for ln in model["lanes"] if ln["kind"] == "peasant" for c in ln["cids"]}
    for c in sorted(set(trained)):
        if c not in lives:
            errors.append(f"农民{c} 有人训练，但没有写他的一生（加一行「农民{c}：…」）")
    for c in sorted(lives):
        if c > 5 and c not in trained:
            errors.append(f"农民{c} 写了他的一生，但没有哪座建筑训练他")
    return model, errors


def _note(x) -> list[str]:
    return [f"# {x['note']}"] if x.get("note") else []


def to_text(model: dict, header: str = "") -> str:
    """The script as text. A step that carries "raw" (what the player typed on a card) is written as it is."""
    header = header or model.get("header") or ""
    out = ["# " + h for h in header.splitlines()] if header else []
    out.append("# ---------- 位置 ----------")
    for p in model["positions"]:
        out += _note(p) + [f"位置 {p['name']} = {p['expr']}"]
    for title, kind in (("农民", "peasant"), ("建筑生产顺序", "building"), ("英雄", "hero"), ("部队", "army")):
        if kind == "army" and not any(x["kind"] == "army" for x in model["lanes"]):
            continue  # no footmen lane: the script reads as it always did
        out += ["", f"# ---------- {title} ----------"]
        for ln in (x for x in model["lanes"] if x["kind"] == kind):
            out += _note(ln)
            if kind == "peasant":
                head = "农民" + "、".join(str(c) for c in ln["cids"])
            elif kind == "hero":
                head = next(n for n, t in HEROES.items() if t == ln["hero"])
            elif kind == "army":
                head = "步兵"
            else:
                head = "#" + ln["tag"] if ln.get("tag") else next(n for n, t in NAMES.items() if t == ln["btype"])
            steps = [(st.get("raw") or step_text(st)).strip() for st in ln["steps"]]
            rows = [steps[i:i + 4] for i in range(0, len(steps), 4)] or [[]]  # long lives wrap, 4 steps a line
            out.append(("#⏸ " if ln.get("muted") else "") + f"{head}：" + " → ".join(rows[0]))
            out += ["      → " + " → ".join(r) for r in rows[1:]]
    out += ["", "# ---------- 留钱 ----------"]
    for r in model["reserves"]:
        out += _note(r)
        out += [r["raw"].strip()] if r.get("raw") else [f"留钱 金{r['gold']} 木{r['wood']} 给 #{r['tag']}" + (f" 从 [{cond_text(r['cond'])}]" if r["cond"] else "")]
    return "\n".join(out) + "\n"
