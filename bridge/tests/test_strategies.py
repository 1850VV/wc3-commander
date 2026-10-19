"""Saved strategies: names, round trip, listing. No game or wc3env needed.

Run from the repository root:
  python -m unittest discover -s bridge/tests -t bridge
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from commander_bridge import strategies  # noqa: E402

PLAN = json.loads((HERE / "fixtures" / "default-plan-s0.json").read_text(encoding="utf-8"))


class StrategiesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Path(self.tmp.name) / "strategies"

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip_keeps_pinned_sites_and_drops_runtime_state(self):
        plan = json.loads(json.dumps(PLAN))
        farm = plan["groups"][1]["children"][3]
        farm["at"] = [1216, -7168]
        farm["rt"] = {"status": "running"}
        info = strategies.save("南方封家 1", plan, self.store)
        self.assertEqual((info["name"], info["events"]), ("南方封家 1", 13))
        doc = strategies.load("南方封家 1", self.store)
        saved = doc["plan"]["groups"][1]["children"][3]
        self.assertEqual(saved["at"], [1216, -7168])
        self.assertNotIn("rt", saved)
        self.assertEqual(doc["plan"]["start"], 0)
        self.assertTrue((self.store / "南方封家 1.json").is_file())

    def test_list_is_newest_first(self):
        strategies.save("a", PLAN, self.store)
        strategies.save("b", PLAN, self.store)
        (self.store / "a.json").touch()
        self.assertEqual([s["name"] for s in strategies.list_all(self.store)], ["a", "b"])
        self.assertEqual(strategies.list_all(Path(self.tmp.name) / "missing"), [])

    def test_unsafe_names_and_bad_plans_are_refused(self):
        for bad in ("", "  ", "../x", "a/b", "a\\b", "c:d", ".hidden", "x" * 61):
            with self.assertRaises(ValueError, msg=bad):
                strategies.save(bad, PLAN, self.store)
        with self.assertRaises(ValueError):
            strategies.save("ok", {"start": 0}, self.store)
        with self.assertRaises(FileNotFoundError):
            strategies.load("nope", self.store)


if __name__ == "__main__":
    unittest.main()
