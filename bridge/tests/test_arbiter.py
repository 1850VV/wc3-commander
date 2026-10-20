"""The rule-driven arbiter on the fake Lost Temple world: it plays the fast expand from the rule
table (docs/规则表-人族速矿二本.md) and explains each decision.

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
from commander_bridge.arbiter import Arbiter  # noqa: E402
from commander_bridge.data import load_data  # noqa: E402
from commander_bridge.server import make_session  # noqa: E402


def play(seconds, start=0):
    data = load_data()
    c = Arbiter(data)
    c.set_plan(strategies.load("人族速矿二本 · " + data["starts"][start]["name"])["plan"])
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


class ArbiterOpeningTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c, cls.rejected = play(240)

    def rules(self):
        return [d["rule"] for d in self.c.decisions]

    def test_opening_rules_fire_in_order_with_reasons(self):
        r = self.rules()
        for rule in ("B1", "B2", "B3", "B4", "B6", "A5"):
            self.assertIn(rule, r)
        self.assertLess(r.index("B2"), r.index("B6"))
        self.assertTrue(all(d["why"] for d in self.c.decisions))

    def test_altar_and_barracks_are_built(self):
        for rule in ("B2", "B4"):
            e = next(e for e in self.c.events if e["rule"] == rule)
            self.assertEqual(self.c.rt[e["id"]]["status"], "done", rule)

    def test_farms_come_from_food_not_from_the_clock(self):
        farms = [d for d in self.c.decisions if d["rule"] == "A6"]
        self.assertTrue(farms)
        self.assertTrue(all("人口" in d["why"] for d in farms))

    def test_no_orders_rejected(self):
        self.assertEqual(self.rejected, [])


if __name__ == "__main__":
    unittest.main()
