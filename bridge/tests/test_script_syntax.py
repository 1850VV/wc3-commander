"""The tactic script's timing words and squads, read and played on the fake world.

  [9:30] 建造 X          under way at 9:30: he leaves early by his walk
  [9:30 出发] 建造 X     he sets off at 9:30
  [上一步完成后 10 秒]    10 s after the step before is finished (an ongoing one: after it began)
  [大法师出生前 12 秒]    12 s before the archmage comes out
  队伍 清野小队：集合 @前方空地 → 清野 @分矿 → 解散      members join with 「加入 清野小队」

Run from the repository root:
  WC3ENV_SRC=../wc3env-127a/src python -m unittest discover -s bridge/tests -t bridge
"""
from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, os.environ.get("WC3ENV_SRC", str(HERE.parents[2] / "wc3env-127a" / "src")))

from commander_bridge.data import load_data  # noqa: E402
from commander_bridge.script import parse, to_text  # noqa: E402
from commander_bridge.server import preview_script  # noqa: E402

SCRIPT = (HERE.parents[1] / "strategies" / "战术脚本-人族速矿二本.txt").read_text(encoding="utf-8")
CREW = "敲钟 → 集合 @前方空地 → 清野 @分矿"
SQUAD = SCRIPT.replace(CREW, "敲钟 → 加入 清野小队").rstrip() + "\n队伍 清野小队：集合 @前方空地 → 清野 @分矿 → 解散\n"


def starts(r, label):
    """When each step of a lane began, from the decision record."""
    out = {}
    for d in r["decisions"]:
        m = re.match(r"第 \d+ 行第 (\d+) 步", d.get("why") or "")
        if m and d["action"].startswith(label + "："):
            out.setdefault(int(m[1]) - 1, d["t"])
    return out


class SyntaxTest(unittest.TestCase):
    def test_new_words_read_and_write_back(self):
        model, errors = parse(SQUAD.replace("[1:30] 建造 农场 @农场3", "[1:30 出发] 建造 农场 @农场3")
                              .replace("农民21：伐木 主矿 → [6:45]", "农民21：伐木 主矿 → [上一步完成后 20 秒] 伐木 主矿 → [大法师出生前 5 秒]"))
        self.assertEqual(errors, [])
        conds = [c for ln in model["lanes"] for st in ln["steps"] for c in st["cond"]]
        self.assertIn({"kind": "time", "t": 90}, conds, "出发: no arrive flag")
        self.assertIn({"kind": "time", "t": 60, "arrive": True}, conds, "a plain time is when the step is under way")
        self.assertIn({"kind": "after_prev", "s": 20}, conds)
        self.assertIn({"kind": "hero_before", "s": 5}, conds)
        squad = next(ln for ln in model["lanes"] if ln["kind"] == "squad")
        self.assertEqual((squad["name"], [st["act"] for st in squad["steps"]]), ("清野小队", ["集合", "清野", "解散"]))
        text = to_text(model)
        self.assertIn("队伍 清野小队：集合 @前方空地 → 清野 @分矿 → 解散", text)
        self.assertIn("[1:30 出发] 建造 农场", text)
        again, errors = parse(text)
        self.assertEqual(errors, [])
        self.assertEqual(len(again["lanes"]), len(model["lanes"]))

    def test_squad_mistakes_are_named(self):
        _, errors = parse(SCRIPT.replace(CREW, "敲钟 → 加入 不存在的队"))
        self.assertTrue(any("队伍 不存在的队" in e for e in errors), errors)
        _, errors = parse(SCRIPT.rstrip() + "\n队伍 空队：集合 @前方空地 → 解散\n")
        self.assertTrue(any("还没有成员" in e for e in errors), errors)
        _, errors = parse(SQUAD.replace("集合 @前方空地 → 清野 @分矿 → 解散", "采金 主矿 → 解散"))
        self.assertTrue(any("队伍不会「采金」" in e for e in errors), errors)


class PlayTest(unittest.TestCase):
    """On the fake world (preview_script plays the script as the commander would)."""

    def test_a_time_is_when_he_is_there(self):
        arrive = SCRIPT.replace("农民7：采金 主矿", "农民7：采金 主矿 → [3:25] 移动 @前方空地 → 采金 主矿")
        leave = SCRIPT.replace("农民7：采金 主矿", "农民7：采金 主矿 → [3:25 出发] 移动 @前方空地 → 采金 主矿")
        a, b = preview_script(load_data(), arrive, 0, seconds=240), preview_script(load_data(), leave, 0, seconds=240)
        sa, sb = starts(a, "农民7")[1], starts(b, "农民7")[1]
        self.assertEqual(sb, 205.0, "出发: he sets off at 3:25")
        self.assertLess(sa, 203.0, "a plain 3:25: he sets off earlier, to be there at 3:25")
        back = starts(a, "农民7")[2]
        self.assertAlmostEqual(back, 205.0, delta=3.0, msg="and he is there (the move is over) about 3:25")

    def test_after_the_step_before_and_before_the_hero(self):
        text = SCRIPT.replace("农民11：伐木 主矿 → [1:30] 建造 农场 @农场3", "农民11：伐木 主矿 → [1:30 出发] 移动 @前方空地 → [上一步完成后 15 秒] 建造 农场 @农场3") \
            .replace("农民9、10、12：伐木 主矿 → [大法师剩余 ≤ 集合用时] 敲钟", "农民9、10、12：伐木 主矿 → [大法师出生前 12 秒] 敲钟")
        r = preview_script(load_data(), text, 0, seconds=200)
        s11 = starts(r, "农民11")
        self.assertEqual(s11[1], 90.0)
        self.assertGreaterEqual(s11[2] - s11[1], 15.0, "the farm waits 15 s after he got there")
        born = next(d["t"] for d in r["decisions"] if d["action"].startswith("大法师：学"))
        self.assertAlmostEqual(starts(r, "农民9")[1], born - 12, delta=2.5, msg="he rings 12 s before the archmage is out")

    def test_a_squad_clears_together_then_breaks_up(self):
        r = preview_script(load_data(), SQUAD, 0, seconds=330)
        self.assertTrue(r["ok"], r)
        sq = starts(r, "队伍·清野小队")
        self.assertEqual(sorted(sq), [0, 1, 2], "集合, 清野 and 解散 all happened")
        joins = {c: starts(r, f"农民{c}")[2] for c in (8, 9, 10, 12, 13)}
        self.assertLessEqual(max(joins.values()), sq[0], "the squad gathers once every member has joined")
        self.assertTrue(any(d["action"] == "清野完成" for d in r["decisions"]), "the clear was won")
        mill = starts(r, "农民8")[3]
        self.assertGreaterEqual(mill, sq[2], "after 解散 each goes on with his own steps: 农民8 builds the lumber mill")
        lane = next(x for x in r["timeline"]["lanes"] if x["label"] == "队伍·清野小队")
        self.assertEqual([s["raw"] for s in lane["steps"]], ["集合 @前方空地", "清野 @分矿", "解散"])


if __name__ == "__main__":
    unittest.main()
