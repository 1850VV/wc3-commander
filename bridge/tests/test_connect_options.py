"""How a game starts, chosen in the console at each 「连接」: launch or take over, speed, drawing, start;
taking over gives up after the time set when no Warcraft shows up. No game or wc3env needed.

Run from the repository root:
  python -m unittest discover -s bridge/tests -t bridge
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from commander_bridge import attach, server  # noqa: E402
from commander_bridge.server import Runner  # noqa: E402


class OptionsTest(unittest.TestCase):
    def test_the_console_chooses_how_the_game_starts(self):
        r = Runner("wc3env", 1.0, "none")
        r.configure({"mode": "launch", "speed": 16, "render": False, "slot": 2})
        self.assertEqual((r.launch, r.speed_factor, r.render, r.human_slot, r.stepping), (True, 16.0, False, 2, True))
        r.configure({"mode": "attach", "speed": 1, "render": True, "attachWait": 60})
        self.assertEqual((r.launch, r.speed_factor, r.render, r.attach_wait, r.stepping), (False, 0.0, True, 60.0, False), "1 = normal: realtime")
        r.configure({"speed": 2})
        self.assertTrue(r.stepping)

    def test_the_fake_game_takes_its_speed_as_game_seconds_a_second(self):
        r = Runner("fake", 2.0, "none")
        r.configure({"speed": 1})
        self.assertEqual(r.speed, 1.0)


class AttachWaitTest(unittest.TestCase):
    def test_taking_over_gives_up_after_the_time_set(self):
        r = Runner("wc3env", 1.0, "none")
        logs = []
        r.log = lambda text, level="info": logs.append((level, text))
        r.configure({"mode": "attach", "attachWait": 0.2})
        saved = (attach.war3_pids, attach.hooked_pids)
        attach.war3_pids, attach.hooked_pids = (lambda: []), (lambda: set())
        try:
            r.stop_flag.wait = lambda s: time.sleep(0.05)  # do not sleep 2 s between looks
            t0 = time.monotonic()
            r._attach()
        finally:
            attach.war3_pids, attach.hooked_pids = saved
        self.assertLess(time.monotonic() - t0, 2.0)
        self.assertFalse(r.waiting)
        self.assertEqual(logs[-1][0], "error")
        self.assertIn("秒内没有找到魔兽争霸三", logs[-1][1])


if __name__ == "__main__":
    unittest.main()
