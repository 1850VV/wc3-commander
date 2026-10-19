"""End to end without a game: commander engine -> wc3env GameSession -> FakeServer -> Lost Temple test world.

The session, RPC client, protocol validation and FakeServer are wc3env's own code, so this
exercises the same path as the real game except for the injected DLL.

Run from the repository root:
  WC3ENV_SRC=../wc3env-127a/src python -m unittest discover -s bridge/tests -t bridge
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, os.environ.get("WC3ENV_SRC", str(HERE.parents[2] / "wc3env-127a" / "src")))

from commander_bridge.data import load_data  # noqa: E402
from commander_bridge.engine import Commander  # noqa: E402
from commander_bridge.server import make_session  # noqa: E402


def play(plan_file: str, seconds: int, start: int, edit=None):
    data = load_data()
    plan = json.loads((HERE / "fixtures" / plan_file).read_text(encoding="utf-8"))
    if edit:
        edit(plan)
    commander = Commander(data)
    commander.set_plan(plan)
    session = make_session("fake", data, start, "none")
    try:
        obs = session.reset()[0]
        rejected = []
        while obs["game_time_seconds"] < seconds:
            actions = commander.tick(obs)
            observations, done, info = session.step({0: actions}, ms=250)
            rejected += info["rejected"][0]
            obs = observations[0]
        commander.tick(obs)
        return commander, rejected
    finally:
        session.close()


def by_name(commander, prefix):
    return [commander.rt[e["id"]] | {"name": e["name"]} for e in commander.events if e["name"].startswith(prefix)]


class OpeningTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c, cls.rejected = play("default-plan-s0.json", 180, 0)

    def test_no_orders_rejected(self):
        self.assertEqual(self.rejected, [])

    def test_first_buildings_finish_from_construction_events(self):
        for prefix, seconds in (("建造 国王祭坛", 60), ("建造 兵营", 60), ("建造 农场 · 农民2", 35)):
            rt = by_name(self.c, prefix)[0]
            self.assertEqual(rt["status"], "done", rt)
            self.assertGreaterEqual(rt["aEnd"] - rt["bStart"], seconds - 1)

    def test_training_follows_train_events(self):
        peasants = by_name(self.c, "训练农民")
        self.assertEqual([r["status"] for r in peasants], ["done"] * 5)
        hero = by_name(self.c, "训练 大法师")[0]
        altar = by_name(self.c, "建造 国王祭坛")[0]
        self.assertEqual(hero["status"], "done")
        self.assertGreaterEqual(hero["trainStart"], altar["aEnd"] - 0.5)  # needs the finished altar
        self.assertLess(hero["trainStart"], altar["aEnd"] + 3)  # first hero is free: no saving up for it

    def test_workers_are_numbered_like_the_simulation(self):
        snap = self.c.snapshot()
        ids = sorted(u["id"] for u in snap["units"] if u["type"] == "hpea")
        self.assertEqual(ids[:5], [1, 2, 3, 4, 5])
        self.assertEqual(snap["start"], 0)

    def test_economy_moves(self):
        snap = self.c.snapshot()
        self.assertGreater(snap["gold"] + snap["wood"], 300)
        roles = [u["role"] for u in snap["units"] if u["type"] == "hpea"]
        self.assertIn("wood", roles)
        self.assertNotIn("idle", roles)


class EditTest(unittest.TestCase):
    def test_missing_requirement_is_reported(self):
        def add_rifleman(plan):
            plan["groups"][3]["children"].append({"id": "x1", "seq": 999, "kind": "train", "name": "训练火枪手", "start": 100, "utype": "hrif"})
        c, rejected = play("default-plan-s0.json", 130, 0, add_rifleman)
        self.assertEqual(rejected, [])
        self.assertEqual(c.rt["x1"]["status"], "waiting")
        self.assertIn("铁匠铺", c.rt["x1"]["note"])

    def test_other_start_location(self):
        c, rejected = play("default-plan-s2.json", 70, 2)
        self.assertEqual(rejected, [])
        self.assertEqual(c.snapshot()["start"], 2)
        self.assertEqual(by_name(c, "建造 农场 · 农民2")[0]["status"], "done")


if __name__ == "__main__":
    unittest.main()
