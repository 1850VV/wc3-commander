"""The player's orchestration (strategies/编排-人族速矿二本.md) read and played on the fake Lost Temple world.

Run from the repository root:
  WC3ENV_SRC=../wc3env-127a/src python -m unittest discover -s bridge/tests -t bridge
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from commander_bridge import strategies  # noqa: E402
from commander_bridge.data import load_data  # noqa: E402
from commander_bridge.orchestration import parse  # noqa: E402
from commander_bridge.orchestrator import Orchestrator  # noqa: E402
from commander_bridge.server import make_session  # noqa: E402

ORCH = (HERE.parents[1] / "strategies" / "编排-人族速矿二本.md").read_text(encoding="utf-8")


def play(seconds, text=ORCH, start=0):
    data = load_data()
    c = Orchestrator(data)
    plan = strategies.load("人族速矿二本 · " + data["starts"][start]["name"])["plan"]
    c.set_plan(dict(plan, orchestration=text))
    session = make_session("fake", data, start, "none")
    try:
        obs = session.reset()[0]
        rejected = []
        while obs["game_time_seconds"] < seconds:
            actions = c.tick(obs)
            observations, done, info = session.step({0: actions}, ms=250)
            c.feedback(actions, info["placements"][0], info["rejected"][0])
            rejected += info["rejected"][0]
            obs = observations[0]
        c.tick(obs)
        return c, rejected
    finally:
        session.close()


class ParseTest(unittest.TestCase):
    def test_the_shipped_orchestration_reads_cleanly(self):
        rows, errors = parse(ORCH)
        self.assertEqual(errors, [])
        self.assertEqual(len(rows), 26)
        r15 = next(r for r in rows if r["no"] == 15)
        self.assertEqual((r15["steps"][0]["btype"], r15["steps"][0]["helpers"], r15["steps"][0]["then"]), ("htow", 3, "natural"))
        self.assertEqual(r15["start"], [{"kind": "row_done", "row": 12}])

    def test_mistakes_are_reported_by_row(self):
        text = ORCH.replace("| 5 | 开局 | 0:00 |", "| 5 | 开局 | 等一会 |").replace("M6 升级（城镇大厅 → 主城）", "M6 升级（城镇大厅）")
        _, errors = parse(text)
        self.assertTrue(any(e.startswith("第 5 行") and "等一会" in e for e in errors), errors)
        self.assertTrue(any(e.startswith("第 20 行") for e in errors), errors)
        _, errors = parse("| 行 | 启动 | 元策略（参数） | 停止 | 优先级 |\n|---|---|---|---|---|\n| 1 | 0:00 | M4 建造（金字塔） | 完工 | 50 |")
        self.assertTrue(any("金字塔" in e for e in errors), errors)


class PlayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c, cls.rejected = play(240)

    def test_rows_start_in_the_written_order(self):
        started = [d for d in self.c.decisions if d["action"].startswith("第 ")and "行开始" in d["action"]]
        nos = [int(d["rule"][1:]) for d in started]
        for a, b in ((5, 8), (8, 10), (11, 12), (12, 15)):
            if b in nos:
                self.assertLess(nos.index(a), nos.index(b), f"row {a} before row {b}")
        self.assertIn(5, nos)
        self.assertIn(8, nos)

    def test_opening_builds_and_hero(self):
        c = self.c
        for no in (5, 6, 7):
            self.assertEqual(c.row_state[no], "done", f"row {no}")
        self.assertTrue(any(u["type_id"] == "Hamg" for u in c.units()))

    def test_every_order_has_a_row_or_rule_and_none_rejected(self):
        self.assertEqual([x for x in self.c.order_log if not x["rule"]], [])
        self.assertEqual(self.rejected, [])

    def test_standing_rows_set_the_worker_counts(self):
        self.assertEqual(self.c.gold_cap["main"], 5)
        self.assertEqual(self.c.wood_cap, 8)

    def test_an_orchestration_with_errors_plays_nothing(self):
        c = Orchestrator(load_data())
        c.set_plan({"groups": [], "orchestration": "| 行 | 启动 | 元策略（参数） | 停止 | 优先级 |\n|---|---|---|---|---|\n| 1 | 明天 | M1 采金（主矿，5 人） | 不停 | 90 |"})
        self.assertTrue(c.errors)


if __name__ == "__main__":
    unittest.main()
