"""The tactic script (strategies/战术脚本-人族速矿二本.txt): read, written back, and played on the fake world.

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
from commander_bridge.script import parse, to_text  # noqa: E402
from commander_bridge.script_runner import ScriptRunner  # noqa: E402
from commander_bridge.server import make_session, preview_script  # noqa: E402

SCRIPT = (HERE.parents[1] / "strategies" / "战术脚本-人族速矿二本.txt").read_text(encoding="utf-8")
TROLLS = [{"type": "nftr", "x": -3500, "y": -7250, "hp": 240, "dps": 6}, {"type": "nfsp", "x": -3560, "y": -7180, "hp": 200, "dps": 4},
          {"type": "nftr", "x": -3440, "y": -7300, "hp": 240, "dps": 6}]


def play(seconds, text=SCRIPT, start=0):
    data = load_data()
    c = ScriptRunner(data)
    plan = strategies.load("人族速矿二本 · " + data["starts"][start]["name"])["plan"]
    c.set_plan(dict(plan, script=text))
    session = make_session("fake", data, start, "none", creeps=TROLLS)
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
    def test_the_shipped_script_reads_cleanly(self):
        model, errors = parse(SCRIPT)
        self.assertEqual(errors, [])
        p8 = next(ln for ln in model["lanes"] if ln["kind"] == "peasant" and ln["cids"] == [8])
        self.assertEqual([s["act"] for s in p8["steps"]], ["伐木", "敲钟", "集合", "清野", "建造", "伐木", "建造", "采金"])
        self.assertEqual(p8["steps"][1]["cond"], [{"kind": "hero_eta"}])
        self.assertEqual((p8["steps"][6]["btype"], p8["steps"][6]["tag"], p8["steps"][6]["pos"]), ("htow", "分基地", "分基地"))
        self.assertIn("敲钟的 5 个人", p8["note"])

    def test_written_back_it_reads_the_same(self):
        model, _ = parse(SCRIPT)
        again, errors = parse(to_text(model))
        self.assertEqual(errors, [])
        steps = lambda m: [(ln["kind"], [s["raw"] for s in ln["steps"]], ln.get("note")) for ln in m["lanes"]]
        self.assertEqual(steps(again), steps(model))
        self.assertEqual(again["header"], model["header"])
        self.assertEqual([(p["name"], p["expr"]) for p in again["positions"]], [(p["name"], p["expr"]) for p in model["positions"]])

    def test_a_card_moved_in_the_console_is_written_as_typed(self):
        model, _ = parse(SCRIPT)
        p4 = next(ln for ln in model["lanes"] if ln["kind"] == "peasant" and ln["cids"] == [4])
        p4["steps"].append({"raw": "[2:00] 待命 @祭坛"})
        again, errors = parse(to_text(model))
        self.assertEqual(errors, [])
        p4 = next(ln for ln in again["lanes"] if ln["kind"] == "peasant" and ln["cids"] == [4])
        self.assertEqual(p4["steps"][-1]["act"], "待命")

    def test_mistakes_name_the_line(self):
        _, errors = parse("位置 祭坛 = 布局.国王祭坛\n农民4：建造 国王祭坛 @神庙 → 跳舞\n城镇大厅：农民6")
        self.assertTrue(any(e.startswith("第 2 行") and "跳舞" in e for e in errors), errors)
        _, errors = parse("位置 祭坛 = 布局.国王祭坛\n农民4：建造 国王祭坛 @神庙\n城镇大厅：农民6")
        self.assertTrue(any("@神庙" in e for e in errors), errors)
        self.assertTrue(any("农民6" in e for e in errors), errors)

    def test_a_script_with_mistakes_plays_nothing(self):
        c = ScriptRunner(load_data())
        c.set_plan({"groups": [], "script": "农民1：跳舞"})
        self.assertTrue(c.errors)


class PlayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c, cls.rejected = play(330)

    def lane(self, label):
        return next(L for L in self.c.lanes if L["label"] == label)

    def test_every_order_comes_from_a_line_and_none_is_rejected(self):
        self.assertEqual([x for x in self.c.order_log if not x["rule"]], [])
        self.assertEqual(self.rejected, [])
        rules = {x["rule"] for x in self.c.order_log}
        self.assertFalse(rules & {"A1", "A2", "A3", "A4", "A5", "A7"}, "no automatic worker balance, peasants or footmen")

    def test_peasants_are_numbered_by_the_script(self):
        c = self.c
        trained = [d for d in c.decisions if d["action"].startswith("训练 农民")]
        self.assertEqual([d["action"] for d in trained[:3]], ["训练 农民6", "训练 农民7", "训练 农民8"])
        p8 = c.unit(8)
        self.assertIsNotNone(p8)
        self.assertEqual(p8["type_id"], "hpea")

    def test_the_opening_and_the_natural_go_as_written(self):
        c = self.c
        built = {c.eco[e["btype"]]["name"]: c.rt[e["id"]] for e in c.events if e["kind"] == "build"}
        for name in ("国王祭坛", "兵营", "伐木场"):
            self.assertEqual(built[name]["status"], "done", name)
        hall = next(e for e in c.events if e["kind"] == "build" and e["btype"] == "htow")
        self.assertEqual(hall["unit"], 8, "peasant 8 lays the natural hall")
        self.assertTrue(c.rt[hall["id"]].get("bid"))
        clear = next(e for e in c.events if e["kind"] == "clear")
        self.assertEqual(c.rt[clear["id"]]["status"], "done")
        self.assertFalse(c.rt[clear["id"]].get("failed"))
        self.assertGreaterEqual(self.lane("农民9")["i"], 6, "the crew helps the hall once it has begun")

    def test_the_bell_is_rung_ahead_of_the_hero(self):
        rung = [d for d in self.c.decisions if d["action"].endswith("敲钟")]
        self.assertEqual(len(rung), 5)
        self.assertIn("大法师还剩", rung[0]["why"])

    def test_an_automatic_site_is_a_free_layout_spot_or_the_hall(self):
        c = self.c
        p = c._auto_site("hhou")
        taken = {tuple(e["site"]) for e in c.events if e["kind"] == "build" and e.get("site")}
        self.assertNotIn((p["x"], p["y"]), taken - {(c.hall["x"], c.hall["y"])})

    def test_the_console_gets_the_lanes(self):
        s = self.c.snapshot()
        labels = [x["label"] for x in s["script"]["lanes"]]
        self.assertIn("农民8", labels)
        self.assertIn("城镇大厅", labels)
        phases = {e["phase"] for e in s["arbEvents"]}
        self.assertIn("农民8", phases)


class PreviewTest(unittest.TestCase):
    def test_the_console_preview_times_each_step_on_another_start(self):
        r = preview_script(load_data(), SCRIPT, 1, seconds=200)  # west: the camp is put at that start's natural
        self.assertTrue(r["ok"], r)
        started = {d["action"] for d in r["decisions"] if d["rule"].startswith("L")}
        self.assertIn("农民4：建造 国王祭坛 @祭坛", started)
        self.assertTrue(any(a.startswith("清野") for a in started), "the camp is cleared in the preview")
        self.assertIn("祭坛", r["script"]["positions"])
        self.assertFalse(preview_script(load_data(), "农民1：跳舞", 0)["ok"])


if __name__ == "__main__":
    unittest.main()
