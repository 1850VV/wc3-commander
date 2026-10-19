"""The layout name the console is editing: kept across plan pushes, published with the plan.

No game or wc3env needed.
"""
from __future__ import annotations

import queue
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from commander_bridge.server import Runner  # noqa: E402


class PlanNameTest(unittest.TestCase):
    def setUp(self):
        self.r = Runner("wc3env", 1.0, "none")
        self.q: queue.Queue = queue.Queue()
        self.r.listeners.append(self.q)

    def test_name_is_published_and_survives_a_push_without_one(self):
        self.r.set_plan({"groups": []}, "南方封家")
        self.assertEqual(self.r.plan_name, "南方封家")
        self.r.publish_plan()
        self.assertEqual(self.q.get_nowait()["name"], "南方封家")
        self.r.set_plan({"groups": []})  # a later push that says nothing about the layout keeps it
        self.assertEqual(self.r.plan_name, "南方封家")

    def test_explicit_null_clears_it(self):
        self.r.set_plan({"groups": []}, "南方封家")
        self.r.set_plan({"groups": []}, None)  # the console has no layout loaded
        self.assertIsNone(self.r.plan_name)
        self.r.publish_plan()
        self.assertIsNone(self.q.get_nowait()["name"])


if __name__ == "__main__":
    unittest.main()
