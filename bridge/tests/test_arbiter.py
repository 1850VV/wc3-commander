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

    def test_every_order_comes_from_a_rule(self):
        self.assertTrue(self.c.order_log)
        untagged = [x for x in self.c.order_log if not x["rule"]]
        self.assertEqual(untagged, [], "an order with no rule is an unexplained action")

    def test_decisions_record_when_they_were_ordered(self):
        altar = next(e for e in self.c.events if e["rule"] == "B2")
        rt = self.c.rt[altar["id"]]
        self.assertIsNotNone(rt.get("ordered"))
        self.assertGreaterEqual(rt["bStart"], rt["ordered"])
        snap = self.c.snapshot()
        self.assertEqual(snap["orders"]["untaggedCount"], 0)
        self.assertIn(altar["id"], snap["orders"]["byEvent"])


class ConsistencyTest(unittest.TestCase):
    def test_the_games_events_match_the_decisions(self):
        c, _ = play(240)
        r = c.consistency()
        self.assertGreater(r["matched"], 10)
        self.assertEqual(r["gameOnly"], [], "the game built or trained something no decision asked for")
        kinds = {g["kind"] for g in c.game_events}
        self.assertTrue({"construct_start", "construct_finish", "train_start", "train_finish"} <= kinds)


class FeedbackTest(unittest.TestCase):
    def test_feedback_is_kept_with_the_game(self):
        import tempfile
        from commander_bridge import server
        with tempfile.TemporaryDirectory() as tmp:
            saved, server.RUNS = server.RUNS, Path(tmp)
            try:
                r = server.Runner("fake", 1.0, "none")
                r.plan, r.plan_name = {"arbiter": True, "groups": []}, "人族速矿二本 · 南方"
                r.commander = r.new_commander()
                self.assertIsInstance(r.commander, Arbiter)
                out = r.add_feedback({"event": "r2", "rule": "B2", "action": "建造 国王祭坛", "t": 0, "score": "bad", "comment": "太晚"})
                self.assertEqual((out[-1]["rule"], out[-1]["score"], out[-1]["comment"]), ("B2", "bad", "太晚"))
                self.assertTrue((r.run_dir / "feedback.jsonl").is_file())
                run = r.run_dir.name
                r.state = {"arbiter": True, "t": 1.0, "gold": 500, "wood": 150, "foodUsed": 5, "foodCap": 12,
                           "units": [{"id": 1, "type": "hpea", "x": 1.4, "y": 2.6, "role": "gold", "task": "采金", "extra": 1}], "buildings": []}
                r.record()
                r.persist(force=True)
                listed = r.runs()
                self.assertEqual(listed[0]["id"], run)
                self.assertEqual(listed[0]["feedback"], 1)
                got = r.load_run(run)
                self.assertEqual(got["frames"][0]["units"][0], {"id": 1, "type": "hpea", "x": 1, "y": 3, "role": "gold", "task": "采金"})
                self.assertEqual(got["feedback"][0]["comment"], "太晚")
                self.assertIn("consistency", got["state"])
                r.plan = {"groups": []}
                r.commander = r.new_commander()
                with self.assertRaises(ValueError):  # a timeline game has no decisions to rate
                    r.add_feedback({"event": "x"})
                self.assertEqual(r.add_feedback({"event": "r2", "run": run, "comment": "回放时补的"})[-1]["comment"], "回放时补的")
                with self.assertRaises(ValueError):
                    r.load_run("../etc")
            finally:
                server.RUNS = saved


if __name__ == "__main__":
    unittest.main()
