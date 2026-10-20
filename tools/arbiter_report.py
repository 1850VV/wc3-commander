"""Decision record (Markdown) from a recorded bridge stream of an arbiter run.

  python tools/arbiter_report.py stream.tsv 南方 > docs/决策记录/<date>-南方.md

The stream is the bridge's /api/stream saved as lines of "<unix time>\t<json>".
"""
import json
import sys
from collections import Counter

path, start_name = sys.argv[1], sys.argv[2]
states = []
for line in open(path, encoding="utf-8"):
    m = json.loads(line.split("\t", 1)[1])
    if m["type"] == "state" and m["state"].get("arbiter"):
        states.append(m["state"])
end = states[-1]
dec, ev = end["decisions"], end["events"]


def mmss(t):
    return "—" if t is None else f"{int(t // 60)}:{int(t % 60):02d}"


def first(rule, n=0):
    ds = [d for d in dec if d["rule"] == rule and d.get("event")]
    return ev.get(ds[n]["event"], {}) if len(ds) > n else {}


checks = [
    ("C1 国王祭坛完成", first("B2").get("aEnd"), (55, 65)),
    ("C2 大法师出生", first("B6").get("aEnd"), (115, 125)),
    ("C3 第 2 个步兵出生", first("A7", 1).get("aEnd"), (105, 125)),
    ("C4 清完近矿", first("B13").get("aEnd"), (135, 190)),
    ("C5 分基地开工", first("B19").get("bStart"), (180, 220)),
    ("C6 分矿开始采金", first("B19").get("aEnd"), (240, 285)),
    ("C7 开始升二本", first("B24").get("trainStart"), None),
    ("C8 二本完成", first("B24").get("aEnd"), None),
    ("C9 山丘之王开始训练", first("B27").get("trainStart"), None),
    ("C10 第一个法师开始训练", first("B30").get("trainStart"), (540, 600)),
]
print(f"# 决策记录 · 人族速矿二本 · {start_name}（仲裁器第 1 版，16 倍速真游戏）\n")
print(f"跑到游戏时间 {mmss(end['t'])}。共 {len(dec)} 条决策。\n")
print("## 检查点\n\n| 检查点 | 实际 | 目标 | 结果 |\n|---|---|---|---|")
for name, t, win in checks:
    if win is None:
        verdict, target = ("—" if t is None else "按规则尽快"), "—"
    else:
        target = f"{mmss(win[0])}–{mmss(win[1])}"
        verdict = "未达成" if t is None else "按时" if win[0] <= t <= win[1] else f"晚 {t - win[1]:.0f} 秒" if t > win[1] else f"早 {win[0] - t:.0f} 秒"
    print(f"| {name} | {mmss(t)} | {target} | {verdict} |")

print("\n## 经济（每分钟）\n\n| 时间 | 金 | 木 | 人口 | 农民分工 | 步兵 |\n|---|---|---|---|---|---|")
mark = 60
for s in states:
    if s["t"] >= mark:
        c = Counter(u.get("role") or "idle" for u in s["units"] if u["type"] == "hpea")
        roles = "、".join(f"{ {'gold': '采金', 'wood': '伐木', 'build': '建造', 'crew': '分矿小组', 'idle': '空闲', 'militia': '民兵'}.get(k, k)} {v}" for k, v in c.items())
        foot = sum(1 for u in s["units"] if u["type"] == "hfoo")
        print(f"| {mmss(s['t'])} | {s['gold']} | {s['wood']} | {s['foodUsed']}/{s['foodCap']} | {roles} | {foot} |")
        mark += 60

print("\n## 全部决策\n\n| 时间 | 规则 | 决定 | 依据 | 结果 |\n|---|---|---|---|---|")
for d in dec:
    r = ev.get(d.get("event"), {}) if d.get("event") else {}
    out = ""
    if r:
        out = {"done": "完成", "running": "进行中", "waiting": "等待中", "pending": "未开始", "active": "进行中"}.get(r.get("status"), r.get("status") or "")
        if r.get("aEnd") is not None and r.get("status") == "done":
            out += f" {mmss(r['aEnd'])}"
        if r.get("failed"):
            out += " 失败"
        if r.get("status") != "done" and r.get("note"):
            out += f"（{r['note'][:24]}）"
    print(f"| {mmss(d['t'])} | {d['rule']} | {d['action']} | {d['why']} | {out} |")
