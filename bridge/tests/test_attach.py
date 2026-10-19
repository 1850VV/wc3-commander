"""Taking over a game the player started: map names, start detection, picking the strategy.
No game or wc3env needed.

Run from the repository root:
  python -m unittest discover -s bridge/tests -t bridge
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from commander_bridge import attach  # noqa: E402
from commander_bridge.server import Runner  # noqa: E402


def hall_at(x, y, type_id="htow"):
    return {"units": [{"unit_id": 1, "type_id": type_id, "structure": True, "x": x, "y": y}]}


class MapNameTest(unittest.TestCase):
    def test_any_lost_temple_map(self):
        for name in (r"Maps\FrozenThrone\(4)LostTemple.w3m", r"C:\x\Maps\Download\Lost Temple LV4.w3x",
                     "lost_temple_v2.w3x", "(4)Lost-Temple.w3m"):
            self.assertTrue(attach.is_lost_temple(name), name)
        for name in (r"Maps\FrozenThrone\(2)EchoIsles.w3x", "", r"C:\LostTemple\(4)TurtleRock.w3x"):
            self.assertFalse(attach.is_lost_temple(name), name)


class ChoosePlanTest(unittest.TestCase):
    def setUp(self):
        self.r = Runner("wc3env", 1.0, "none")
        self.logs = []
        self.r.log = lambda text, level="info": self.logs.append((level, text))
        self.starts = self.r.data["starts"]

    def test_lost_temple_start_picks_its_fast_expand_strategy(self):
        for i, s in enumerate(self.starts):
            self.r._choose_plan(hall_at(s["x"] + 100, s["y"] - 50), r"Maps\Lost Temple LV4.w3x", False)
            self.assertTrue(self.r.tactic and self.r.commander.enabled)
            self.assertEqual(self.r.plan["start"], i)
            self.assertIn("人族速矿二本 · " + s["name"], self.logs[-1][1])
            builds = [e for g in self.r.plan["groups"] for e in g["children"] if e["kind"] == "build"]
            self.assertTrue(builds and all(e.get("site") for e in builds))  # no console resolves them here

    def test_other_map_or_race_only_watches(self):
        s = self.starts[0]
        for obs, map_name in ((hall_at(s["x"], s["y"]), r"Maps\(2)EchoIsles.w3x"),
                              (hall_at(s["x"], s["y"], "ogre"), r"Maps\(4)LostTemple.w3m"),
                              (hall_at(s["x"] + 3000, s["y"]), r"Maps\(4)LostTemple.w3m")):
            self.r._choose_plan(obs, map_name, False)
            self.assertFalse(self.r.tactic or self.r.commander.enabled, map_name)
            self.assertEqual(self.logs[-1][0], "error")


if __name__ == "__main__":
    unittest.main()
