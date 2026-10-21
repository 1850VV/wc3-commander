"""The player's own micro during a clear: a right-click, stop or another target wins over the clear
controller for combat.MANUAL_PAUSE seconds after he last steered the unit, then the unit is ours again."""
import unittest

from commander_bridge import combat
from commander_bridge.combat import Clear


class Cmd:
    def __init__(self):
        self.orders = []

    def order(self, uid, command, **arguments):
        self.orders.append((uid, command, arguments))

    def to(self, uid):
        return [o for o in self.orders if o[0] == uid]


CAMP = (1000.0, 1000.0)


def unit(uid, type_id, x, y, hp=220, max_hp=220, hero=False, order=None):
    return {"unit_id": uid, "type_id": type_id, "x": x, "y": y, "hp": hp, "max_hp": max_hp, "hero": hero,
            "structure": False, "order": order, "abilities": []}


def creep(uid, type_id, x, y, hp=240):
    return {"unit_id": uid, "type_id": type_id, "owner": 12, "x": x, "y": y, "hp": hp, "max_hp": 240}


class HandMicro(unittest.TestCase):
    def setUp(self):
        self.clear = Clear(CAMP, (0.0, 0.0), [1, 2], t=0.0)
        self.creeps = [creep(50, "nftr", 1050, 1000), creep(51, "nftr", 1100, 1050)]

    def obs(self, militia_order=None, hp=220):
        hero = unit(1, "Hamg", 950, 950, hp=450, max_hp=450, hero=True, order={"name": "attack", "target_id": 50})
        return {"units": [hero, unit(2, "hmil", 1000, 980, hp=hp, order=militia_order)], "visible_enemies": self.creeps}

    def tick(self, t, **kw):
        cmd = Cmd()
        self.clear.tick(cmd, self.obs(**kw), t)
        return cmd

    def test_right_click_pull_is_left_alone_then_resumed(self):
        cmd = self.tick(0.0)  # the fight begins: everyone hits the same creep
        self.assertEqual(cmd.to(2)[-1][1], "attack")
        pull = {"name": "smart", "target_id": None, "x": 600.0, "y": 600.0}  # the player right-clicks the ground
        for t in (2.0, 4.0, 6.0, 8.0, 9.5):
            self.assertEqual(self.tick(t, militia_order=pull).to(2), [], f"ordered at {t}")
        # he stopped steering at 9.5 (the militia stands idle): ours again 8 s later, not before
        self.assertEqual(self.tick(12.0).to(2), [])
        self.assertEqual(self.tick(17.6).to(2)[-1][1], "attack")

    def test_stop_hold_and_spells_count_as_the_player(self):
        self.tick(0.0)
        for name in ("stop", "holdposition", "patrol", "blizzard"):
            self.clear.manual.clear()
            self.assertEqual(self.tick(3.0, militia_order={"name": name}).to(2), [], name)

    def test_another_live_target_is_the_player(self):
        self.tick(0.0)
        focus = self.clear.focus
        other = 51 if focus == 50 else 50
        self.assertEqual(self.tick(2.0, militia_order={"name": "attack", "target_id": other}).to(2), [])

    def test_our_own_orders_are_not_mistaken_for_the_player(self):
        self.tick(0.0)
        focus = self.clear.focus
        cmd = self.tick(2.0, militia_order={"name": "attack", "target_id": focus})
        self.assertNotIn(2, self.clear.manual)
        self.assertEqual(cmd.to(2)[-1][1], "attack")  # the same order again after REORDER

    def test_auto_pull_waits_for_the_player(self):
        if not hasattr(combat, "MILITIA_PULL"):
            self.skipTest("hurt militia do not step out on their own in this version")
        self.tick(0.0)
        hurt = combat.MILITIA_PULL * 220 - 10
        self.tick(2.0, militia_order={"name": "smart", "x": 900.0, "y": 900.0}, hp=hurt)
        self.assertNotIn(2, self.clear.pulled)  # he is pulling it himself: no automatic step-out


if __name__ == "__main__":
    unittest.main()
