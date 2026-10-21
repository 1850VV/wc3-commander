"""End to end without a game: commander engine -> wc3env GameSession -> FakeServer -> Lost Temple test world.

The session, RPC client, protocol validation and FakeServer are wc3env's own code, so this
exercises the same path as the real game except for the injected DLL.

Run from the repository root:
  WC3ENV_SRC=../wc3env-127a/src python -m unittest discover -s bridge/tests -t bridge
"""
from __future__ import annotations

import json
import math
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


def play(plan_file: str, seconds: int, start: int, edit=None, each=None, **world):
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
            if each:
                each(commander, obs["game_time_seconds"])  # e.g. the console's tactic switch
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


class TacticSwitchTest(unittest.TestCase):
    def test_off_only_watches_and_on_resumes_the_plan(self):
        sent_off = []

        def switch(c, t):
            c.enabled = t >= 30  # off for the first 30 seconds, then on
            if not c.enabled:
                sent_off.append(len(c.sent))

        c, rejected = play("default-plan-s0.json", 90, 0, each=switch)
        self.assertEqual(sent_off[-1], 0)  # no order at all while off
        self.assertGreater(c.snapshot()["t"], 29)  # but the game was still read
        self.assertTrue(c.sent)  # orders start once it is on
        self.assertEqual(rejected, [])
        self.assertTrue(c.snapshot()["enabled"])


class WoodTest(unittest.TestCase):
    """Lumberjacks get trees they can stand next to, and are moved when Warcraft drops their order."""

    def setUp(self):
        self.c = Commander(load_data())
        t = self.c.data["trees"]
        self.trees = [{"id": i // 2, "x": t[i], "y": t[i + 1], "resource": "lumber"} for i in range(0, len(t), 2)]
        self.living = {(d["x"], d["y"]) for d in self.trees}

    def test_a_tree_inside_a_grove_is_not_picked(self):
        inner = next(d for d in self.trees if all((d["x"] + dx, d["y"] + dy) in self.living for dx in (-128, 0, 128) for dy in (-128, 0, 128)))
        self.assertFalse(self.c.tree_open(inner, self.living))
        for dy in (-128, 0, 128):  # the column of trees east of it is cut: now there is room
            self.living.discard((inner["x"] + 128, inner["y"] + dy))
        self.assertTrue(self.c.tree_open(inner, self.living))

    def test_lumber_order_dropped_back_to_gold_marks_the_spot_and_picks_another_tree(self):
        c, west = self.c, self.c.data["starts"][1]
        mine = {"unit_id": 900, "type_id": "ngol", "x": -7296, "y": -3328}
        hall = {"unit_id": 901, "type_id": "htow", "structure": True, "x": west["x"], "y": west["y"]}
        u = {"unit_id": 902, "type_id": "hpea", "structure": False, "x": -7200, "y": -3200, "order": None}
        c.obs = {"units": [hall, u], "destructables": self.trees, "player": {}}
        c.hall, c.mines, c.t = hall, {900: mine}, 100.0
        c.actions, c.ordered = [], set()
        self.assertTrue(c.harvest(u, "wood"))
        first = c.wood_tree[902]
        u["order"] = {"name": "harvest", "target_id": 900}  # Warcraft sent him back to the mine
        c.actions, c.ordered, c.t = [], set(), 103.0
        c._unstick_wood()
        self.assertIn(first, c.bad_wood)
        self.assertEqual(c.actions[-1]["command"], "harvest")
        self.assertGreaterEqual(math.hypot(c.wood_tree[902][0] - first[0], c.wood_tree[902][1] - first[1]), c.BAD_RADIUS)


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


class AfterTest(unittest.TestCase):
    def test_event_waits_for_its_dependency(self):
        def farm_after_barracks(plan):
            plan["groups"][3]["children"].append({"id": "x1", "seq": 999, "kind": "build", "name": "建造 农场", "start": 0, "unit": None, "btype": "hhou", "site": [1600, -6784], "after": "e3"})
        c, rejected = play("default-plan-s0.json", 120, 0, farm_after_barracks)
        self.assertEqual(rejected, [])
        self.assertEqual(c.rt["e3"]["status"], "done")
        self.assertGreaterEqual(c.rt["x1"]["aStart"], c.rt["e3"]["aEnd"])
        self.assertIn(c.rt["x1"]["status"], ("running", "done"))


class UpgradeTest(unittest.TestCase):
    def test_town_hall_becomes_a_keep_from_upgrade_events(self):
        def keep(plan):
            plan["groups"][3]["children"].append({"id": "u1", "seq": 999, "kind": "upgrade", "name": "升级 主城", "start": 120, "to": "hkee"})
        c, rejected = play("default-plan-s0.json", 330, 0, keep)
        self.assertEqual(rejected, [])
        rt = c.rt["u1"]
        self.assertEqual(rt["status"], "done", rt)
        self.assertGreaterEqual(rt["aEnd"] - rt["trainStart"], 139)
        self.assertIn("hkee", [b["type"] for b in c.snapshot()["buildings"]])


class ExpansionTest(unittest.TestCase):
    def test_expansion_with_helpers_then_mining_at_the_natural(self):
        def expand(plan):  # site as the console's sim.js would resolve it (naturalAnchor, south start)
            plan["groups"][3]["children"].append({"id": "x1", "seq": 999, "kind": "build", "name": "建造 分基地", "start": 140, "unit": None,
                                                  "btype": "htow", "near": "natural", "site": [-3200, -7424], "helpers": 2, "then": "natural"})
        c, rejected = play("default-plan-s0.json", 420, 0, expand)
        self.assertEqual(rejected, [])
        rt = c.rt["x1"]
        self.assertEqual(rt["status"], "done", rt)
        self.assertLess(rt["aEnd"] - rt["bStart"], 175)  # helpers sped it up (one builder: 180 s)
        self.assertGreaterEqual(list(c.mine_of.values()).count("natural"), 3)
        self.assertIsNotNone(c.natural())


def clear_plan(plan):
    """Archmage learns Water Elemental, three wood peasants answer Call to Arms, the army clears the
    natural, then the expansion goes up there (south start; sites as sim.js resolves them)."""
    add = plan["groups"][3]["children"].extend
    add([
        {"id": "L", "seq": 990, "kind": "learn", "name": "大法师学水元素", "start": 115, "hero": "Hamg", "ability": "AHwe"},
        {"id": "M", "seq": 991, "kind": "militia", "name": "敲钟", "start": 125, "count": 3, "from": "wood"},
        {"id": "C", "seq": 992, "kind": "clear", "name": "清近矿", "start": 126, "militia": "M"},
        {"id": "X", "seq": 993, "kind": "build", "name": "建造 分基地", "start": 126, "unit": None, "btype": "htow", "near": "natural",
         "site": [-3200, -7424], "after": "C", "then": "natural"},
    ])


TROLLS = [{"type": "nftr", "x": -3500, "y": -7250, "hp": 240, "dps": 6}, {"type": "nfsp", "x": -3560, "y": -7180, "hp": 200, "dps": 4},
          {"type": "nftr", "x": -3440, "y": -7300, "hp": 240, "dps": 6}]


class ClearTest(unittest.TestCase):
    def test_army_clears_the_natural_and_the_expansion_follows(self):
        c, rejected = play("default-plan-s0.json", 330, 0, clear_plan, creeps=TROLLS)
        self.assertEqual(rejected, [])
        self.assertEqual(c.rt["L"]["status"], "done", c.rt["L"])
        self.assertEqual(c.rt["C"]["status"], "done", c.rt["C"])
        self.assertFalse(c.rt["C"].get("failed"), c.rt["C"])
        self.assertEqual([u for u in c.obs["visible_enemies"] if u.get("owner") == 12], [])
        self.assertGreaterEqual(c.rt["X"]["aStart"], c.rt["C"]["aEnd"])
        self.assertIn(c.rt["X"]["status"], ("running", "done"))
        self.assertTrue(any(a["command"] == "cast" and a["arguments"].get("order") == "waterelemental" for a in c.sent))
        self.assertTrue(any(a["command"] == "cast" and a["arguments"].get("order") == "militia" for a in c.sent))

    def test_too_strong_a_camp_fails_and_holds_the_expansion(self):
        brutes = [{"type": "nogr", "x": -3500, "y": -7250, "hp": 9000, "dps": 90}]
        c, rejected = play("default-plan-s0.json", 300, 0, clear_plan, creeps=brutes)
        self.assertEqual(c.rt["C"]["status"], "done")
        self.assertTrue(c.rt["C"].get("failed"), c.rt["C"])
        self.assertEqual(c.rt["X"]["status"], "pending")
        self.assertIn("失败", c.rt["X"]["note"])


class FastExpandTest(unittest.TestCase):
    """The south fast-expand strategy (tools/make_fast_expand.js; sites resolved by sim.js) end to
    end in the fake game, with forest trolls at the natural."""

    def test_build_order_reaches_a_mining_expansion(self):
        c, rejected = play("fast-expand-s0.json", 330, 0, creeps=TROLLS)
        self.assertEqual(rejected, [])
        by = {e["name"]: c.rt[e["id"]] for e in c.events}
        for name in ("建造 国王祭坛 · 农民4", "建造 兵营 · 新农民", "训练 大法师（首发免费）", "大法师学水元素", "清近矿（大法师 + 步兵 + 民兵）"):
            self.assertEqual(by[name]["status"], "done", (name, by[name]))
        self.assertFalse(by["清近矿（大法师 + 步兵 + 民兵）"].get("failed"))
        hall = by["建造 分基地（3 人协助 + 1 人敲塔）"]
        self.assertIn(hall["status"], ("running", "done"), hall)
        self.assertGreater(hall["bStart"], by["清近矿（大法师 + 步兵 + 民兵）"]["aEnd"] - 0.5)


class ClearUnitTest(unittest.TestCase):
    """combat.Clear on hand-made observations."""

    class Cmd:
        def __init__(self):
            self.orders = []

        def order(self, unit_id, command, **arguments):
            self.orders.append((unit_id, command, arguments))

    def obs(self, units, creeps):
        return {"units": units, "visible_enemies": creeps, "events": []}

    def unit(self, uid, type_id, x, y, hp=1.0, order=None, hero=False):
        return {"unit_id": uid, "type_id": type_id, "x": x, "y": y, "hp": 100 * hp, "max_hp": 100, "hero": hero, "mana": 0, "order": order, "abilities": []}

    def test_healer_first_and_hands_off_a_unit_the_player_pulls_back(self):
        from commander_bridge.combat import Clear
        cl, cmd = Clear((0, 0), (2000, 0), [1, 2, 3], t=0), self.Cmd()
        creeps = [{"unit_id": 90, "type_id": "nftr", "owner": 12, "x": 50, "y": 0, "hp": 50, "max_hp": 240},
                  {"unit_id": 91, "type_id": "nfsp", "owner": 12, "x": 80, "y": 0, "hp": 200, "max_hp": 200}]
        army = [self.unit(1, "Hamg", 100, 0, hero=True), self.unit(2, "hfoo", 120, 0), self.unit(3, "hmil", 110, 0)]
        cl.tick(cmd, self.obs(army, creeps), 1.0)
        self.assertEqual({o[2].get("target_id") for o in cmd.orders if o[1] == "attack"}, {91})  # shadow priest before the weaker troll
        army[2]["order"] = {"name": "move", "target_id": None, "x": 1500, "y": 0}  # the player pulls the militia back
        cmd.orders.clear()
        cl.tick(cmd, self.obs(army, creeps), 3.0)
        self.assertNotIn(3, [o[0] for o in cmd.orders])
        army[2].update(hp=20, order=None)  # out of the pause and badly hurt: stays and fights (the player's rule)
        cmd.orders.clear()
        cl.tick(cmd, self.obs(army, creeps), 11.5)  # MANUAL_PAUSE after he last steered it (at 3.0)
        self.assertNotIn((3, "move", {"x": 2000, "y": 0}), cmd.orders)
        self.assertIn((3, "attack", {"target_id": 91}), cmd.orders)

    def test_militia_does_not_start_the_fight_before_the_hero(self):
        from commander_bridge.combat import Clear
        cl, cmd = Clear((0, 0), (2000, 0), [1, 2], t=0), self.Cmd()
        creep = {"unit_id": 90, "type_id": "nftr", "owner": 12, "x": 0, "y": 0, "hp": 100, "max_hp": 100}
        army = [self.unit(1, "Hamg", 2000, 0, hero=True), self.unit(2, "hmil", 100, 0)]
        cl.tick(cmd, self.obs(army, [creep]), 1.0)
        self.assertEqual(cl.phase, "march")
        self.assertNotIn(90, {o[2].get("target_id") for o in cmd.orders if o[1] == "attack"})
        self.assertIn((2, "attack", {"x": 0, "y": 0}), cmd.orders)  # walks at the camp, not the creep
        army[0].update(x=100, y=0)  # the hero arrives
        cmd.orders.clear()
        cl.tick(cmd, self.obs(army, [creep]), 3.0)
        self.assertEqual(cl.phase, "fight")
        self.assertIn(90, {o[2].get("target_id") for o in cmd.orders if o[1] == "attack"})

    def test_after_the_clear_the_army_stays_at_the_natural(self):
        from commander_bridge.combat import Clear
        cl, cmd = Clear((0, 0), (2000, 0), [1], t=0), self.Cmd()
        cl._finish(cmd, [self.unit(1, "Hamg", 0, 0, hero=True)], 2.0, "done")
        self.assertNotIn((1, "move", {"x": 2000, "y": 0}), cmd.orders)

    def test_a_footman_finished_after_the_march_joins_it(self):
        from commander_bridge.combat import Clear
        cl, cmd = Clear((0, 0), (2000, 0), [1], t=0), self.Cmd()
        obs = self.obs([self.unit(1, "Hamg", 100, 0, hero=True), self.unit(4, "hfoo", 300, 0)], [])
        cl.tick(cmd, obs, 1.0)
        self.assertIn(4, cl.members)
        self.assertIn(4, [o[0] for o in cmd.orders if o[1] == "attack"])

    def test_march_order_is_not_repeated_while_the_unit_is_moving(self):
        from commander_bridge.combat import Clear
        cl, cmd = Clear((0, 0), (2000, 0), [1], t=0), self.Cmd()
        u = self.unit(1, "Hamg", 100, 0, hero=True, order={"name": "attack", "target_id": None, "x": 0, "y": 0})
        cl.tick(cmd, self.obs([u], []), 1.0)
        sent = len(cmd.orders)
        cl.tick(cmd, self.obs([u], []), 2.0)
        self.assertEqual(len(cmd.orders), sent)  # re-issuing every 1.5 s is what made the column stutter


class ReservedWorkerTest(unittest.TestCase):
    def test_automatic_builder_skips_a_peasant_a_later_event_names(self):
        def early_farm(plan):  # 0:00 farm with no peasant; the 0:01 barracks calls for peasant 3
            plan["groups"][3]["children"].append({"id": "x1", "seq": 999, "kind": "build", "name": "建造 农场", "start": 0, "unit": None, "btype": "hhou", "site": [1600, -6784]})
        c, rejected = play("default-plan-s0.json", 120, 0, early_farm)
        self.assertEqual(rejected, [])
        self.assertEqual(c.rt["x1"]["status"], "done", c.rt["x1"])
        self.assertNotEqual(c.rt["x1"]["builder"], 3)
        self.assertEqual(c.rt["e3"]["builder"], 3)


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

    def test_moving_an_ordered_site_orders_again(self):
        self.c.obs["player"] = {"gold": 500, "lumber": 150, "food_used": 5, "food_cap": 12}
        self.c.budget, self.c.actions, self.c.ordered = [500, 150], [], set()
        moved = {"id": "f", "seq": 1, "kind": "build", "name": "建造 农场", "start": 0, "btype": "hhou", "site": [960, -7616], "at": [960, -7616]}
        self.c.set_plan({"groups": [{"id": "g", "children": [moved]}]})  # dragged on the console map
        e = self.c.events[0]
        self.c._advance(e)
        self.assertEqual(self.c.jobs["f"]["state"], "wait_res")
        self.assertIn("重新下令", self.c.rt["f"]["note"])
        self.assertEqual(self.c.jobs["f"]["tries"], 0)
        self.c._advance(e)
        a = self.c.actions[-1]
        self.assertEqual((a["command"], a["arguments"]), ("build", {"type_id": "hhou", "x": 960.0, "y": -7616.0}))
        self.c.actions = []
        self.c._advance(e)  # same site again: no new order
        self.assertEqual(self.c.actions, [])

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
