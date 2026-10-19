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


def play(plan_file: str, seconds: int, start: int, edit=None, **world):
    data = load_data()
    plan = json.loads((HERE / "fixtures" / plan_file).read_text(encoding="utf-8"))
    if edit:
        edit(plan)
    commander = Commander(data)
    commander.set_plan(plan)
    session = make_session("fake", data, start, "none", **world)
    try:
        obs = session.reset()[0]
        rejected = []
        commander.sent = []  # every action handed to the game, for assertions
        while obs["game_time_seconds"] < seconds:
            actions = commander.tick(obs)
            commander.sent += actions
            observations, done, info = session.step({0: actions}, ms=250)
            commander.feedback(actions, info["placements"][0], info["rejected"][0])  # same as server.Runner
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


class PlacementTest(unittest.TestCase):
    """2026-10-19 real run: Warcraft moved the second farm 724 units from the planned site, the
    engine never claimed it and kept re-ordering, building four farms for one event."""

    SHIFT = (724.0, 0.0)

    def farms(self, c):
        return [b for b in c.snapshot()["buildings"] if b["type"] == "hhou"]

    def test_moved_site_is_claimed_once(self):
        c, rejected = play("default-plan-s0.json", 180, 0, auto_place_shift=self.SHIFT)
        self.assertEqual(rejected, [])
        for e in c.events:
            if e["kind"] == "build":
                self.assertEqual(c.rt[e["id"]]["status"], "done", (e["name"], c.rt[e["id"]]))
                self.assertEqual(c.rt[e["id"]]["note"], "完工")
        self.assertEqual(len(self.farms(c)), 2)  # two farm events, two farms

    def test_placed_site_is_built_exactly(self):
        site = []

        def place_second_farm(plan):
            e9 = next(e for g in plan["groups"] for e in g["children"] if e["id"] == "e9")
            e9["at"] = list(e9["site"])  # as if dragged on the console map
            site.extend(e9["site"])

        c, rejected = play("default-plan-s0.json", 130, 0, place_second_farm, auto_place_shift=self.SHIFT)
        self.assertEqual(rejected, [])
        self.assertEqual(c.rt["e9"]["status"], "done", c.rt["e9"])
        self.assertIn([float(site[0]), float(site[1])], [[b["x"], b["y"]] for b in self.farms(c)])
        builds = [a for a in c.sent if a["command"] == "build" and a["arguments"]["x"] == site[0] and a["arguments"]["y"] == site[1]]
        self.assertTrue(builds)
        self.assertTrue(all("auto_place" not in a["arguments"] for a in builds))


class FeedbackTest(unittest.TestCase):
    """The engine's use of the act reply, without a game."""

    def setUp(self):
        self.c = Commander(load_data())
        self.c.set_plan({"groups": [{"id": "g", "children": [{"id": "f", "seq": 1, "kind": "build", "name": "建造 农场", "start": 0, "btype": "hhou", "site": [832, -7232]}]}]})
        self.c.t = 57.0
        self.action = {"unit_id": 7, "command": "build", "arguments": {"type_id": "hhou", "x": 832.0, "y": -7232.0, "auto_place": True}}
        self.c.jobs["f"] = {"state": "ordered", "worker": 7, "tries": 1, "action": self.action, "placed": None, "ordered": 54.0}
        self.c.cid[7] = 6
        # the worker's order no longer points at the farm, so only the site can identify it
        self.c.obs = {"units": [{"unit_id": 7, "type_id": "hpea", "x": 1424.0, "y": -7632.0, "structure": False, "order": None},
                                {"unit_id": 900, "type_id": "hhou", "x": 1344.0, "y": -7744.0, "structure": True, "state": "constructing"}]}

    def start_farm(self):
        self.c._bind_construction({"kind": "construct_start", "unit_id": 900, "type_id": "hhou"})

    def test_reported_site_claims_the_moved_farm(self):
        self.c.feedback([self.action], [{"index": 0, "x": 1344.0, "y": -7744.0}], [])
        self.assertEqual(self.c.rt["f"]["placed"], [1344.0, -7744.0])
        self.start_farm()
        self.assertEqual(self.c.rt["f"]["bid"], "u900")
        self.assertEqual(self.c.jobs["f"]["state"], "constructing")

    def test_unreported_far_site_is_not_guessed(self):
        self.start_farm()
        self.assertEqual(self.c.jobs["f"]["state"], "ordered")

    def test_refused_exact_build_retries_then_gives_up(self):
        self.c.events[0]["at"] = [832, -7232]
        self.c.feedback([self.action], [], [{"index": 0, "reason": "no_build_site"}])
        self.assertEqual(self.c.jobs["f"]["state"], "wait_res")
        self.assertIn("指定位置", self.c.rt["f"]["note"])
        self.c.jobs["f"].update(state="ordered", tries=4)
        self.c.feedback([self.action], [], [{"index": 0, "reason": "no_build_site"}])
        self.assertNotIn("f", self.c.jobs)
        self.assertEqual(self.c.rt["f"]["status"], "done")
        self.assertIn("no_build_site", self.c.rt["f"]["note"])


if __name__ == "__main__":
    unittest.main()
