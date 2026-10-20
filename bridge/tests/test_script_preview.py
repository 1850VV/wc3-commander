"""The console's script preview: a recorded game it opens like a replay (timeline, map, cards).

Run from the repository root:
  WC3ENV_SRC=../wc3env-127a/src python -m unittest discover -s bridge/tests -t bridge
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from commander_bridge.data import load_data  # noqa: E402
from commander_bridge.server import preview_script  # noqa: E402

SCRIPT = (HERE.parents[1] / "strategies" / "战术脚本-人族速矿二本.txt").read_text(encoding="utf-8")


class PreviewRecordTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = preview_script(load_data(), SCRIPT, 0, seconds=150)

    def test_one_frame_a_second_with_the_map(self):
        frames = self.r["frames"]
        self.assertGreaterEqual(len(frames), 150)
        self.assertEqual([f["t"] for f in frames[:3]], [0.0, 1.0, 2.0])
        self.assertTrue(any(u["type"] == "hpea" for u in frames[-1]["units"]))
        self.assertTrue(self.r["meta"]["preview"])

    def test_events_carry_their_lane_step_and_site(self):
        st = self.r["state"]
        altar = next(e for e in st["arbEvents"] if e.get("btype") == "halt")
        self.assertEqual((altar["phase"], altar["step"]), ("农民4", 0))
        self.assertTrue(altar["site"])
        self.assertTrue(st["events"][altar["id"]].get("builtAt"))
        farm3 = next(e for e in st["arbEvents"] if e.get("phase") == "农民11" and e["kind"] == "build")
        self.assertEqual(farm3["step"], 1)  # 农民11：伐木 主矿 → [1:30] 建造 农场 → …


if __name__ == "__main__":
    unittest.main()
