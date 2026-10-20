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
from commander_bridge.script import parse, to_text  # noqa: E402
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


class ResumeTest(unittest.TestCase):
    """The console changes the script at a moment and goes on from the save point before it."""

    def setUp(self):  # each resume goes on from a fresh run of the shipped script (the server keeps only the last one)
        self.data = load_data()
        self.full = preview_script(self.data, SCRIPT, 0, seconds=260)

    def test_resuming_the_same_script_gives_the_same_game(self):
        again = preview_script(self.data, SCRIPT, 0, seconds=260, resume_from=200)
        self.assertEqual(again["resumedFrom"], 200.0)
        self.assertEqual([d["action"] for d in again["decisions"]], [d["action"] for d in self.full["decisions"]])
        self.assertEqual(len(again["frames"]), len(self.full["frames"]))

    def test_an_order_added_at_a_moment_runs_from_there(self):
        changed = SCRIPT.replace("农民7：采金 主矿", "农民7：采金 主矿 → [3:25] 集合 @前方空地 → [3:50] 采金 主矿")
        r = preview_script(self.data, changed, 0, seconds=260, resume_from=205)
        self.assertEqual(r["resumedFrom"], 200.0)
        lane = next(x for x in r["timeline"]["lanes"] if x["label"] == "农民7")
        self.assertEqual([s["start"] for s in lane["steps"]][1:], [205.0, 230.0])

    def test_a_move_ends_on_arrival_and_the_next_step_follows(self):
        changed = SCRIPT.replace("农民7：采金 主矿", "农民7：采金 主矿 → [3:25] 移动 @前方空地 → 采金 主矿")
        r = preview_script(self.data, changed, 0, seconds=260, resume_from=205)
        lane = next(x for x in r["timeline"]["lanes"] if x["label"] == "农民7")
        move, back = lane["steps"][1]["start"], lane["steps"][2]["start"]
        self.assertEqual(move, 205.0)
        self.assertGreater(back - move, 2, "he walked there before going back to the mine")

    def test_changing_what_already_happened_starts_over(self):
        changed = SCRIPT.replace("农民4：建造 国王祭坛 @祭坛", "农民4：建造 兵营 @祭坛")
        r = preview_script(self.data, changed, 0, seconds=120, resume_from=100)
        self.assertIsNone(r["resumedFrom"])
        self.assertIn("农民4", r["note"])


class PausedLaneTest(unittest.TestCase):
    def test_a_paused_lane_is_kept_but_not_played(self):
        text = SCRIPT.replace("农民21：", "#⏸ 农民21：")
        model, errors = parse(text)
        self.assertEqual(errors, [])
        self.assertTrue(next(l for l in model["lanes"] if l["head"] == "农民21").get("muted"))
        self.assertIn("#⏸ 农民21：", to_text(model))
        r = preview_script(load_data(), text, 0, seconds=420)
        lane = next(x for x in r["timeline"]["lanes"] if x["label"] == "农民21")
        self.assertTrue(lane["muted"])
        self.assertFalse(any("藏宝室" in d["action"] for d in r["decisions"]), "his vault is not built")


class FootmenLaneTest(unittest.TestCase):
    def test_the_footmen_lane_moves_every_footman(self):
        text = SCRIPT.rstrip() + "\n步兵：[3:40] 攻击移动 @分矿 → 待命 @分矿\n"
        r = preview_script(load_data(), text, 0, seconds=330)
        self.assertTrue(r["ok"], r)
        lane = next(x for x in r["timeline"]["lanes"] if x["label"] == "步兵")
        self.assertEqual(lane["steps"][0]["start"], 220.0)
        self.assertIsNotNone(lane["steps"][1]["start"], "the attack-move ended once they arrived")


if __name__ == "__main__":
    unittest.main()
