"""Clearing a creep camp with a small army: hero, footmen, militia and water elementals.

One Clear runs per "clear" event. Every tick it reads the observation and gives orders:
  march   attack-move everyone to the camp
  fight   focus fire on one creep (healers first), summon water elementals when the hero can,
          (militia never walk home: they stay to build the expansion), retreat everyone if the hero drops below
          HERO_RETREAT (the event fails)
  done    no living creep seen near the camp for CLEAR_QUIET seconds
A unit the player is steering by hand (its order is not the last one we gave it) is left alone
for MANUAL_PAUSE seconds. Accepted orders prove nothing; the fight is judged from what is seen.

Order names and ability ids still to be confirmed in the real game sit in ORDERS.
"""
from __future__ import annotations

import math

NEUTRAL_HOSTILE = 12
ORDERS = {"water": "waterelemental", "water_ability": "AHwe"}
CAMP_RADIUS = 900           # creeps this close to the camp point belong to it
ENGAGE = 1100               # start fighting when a camp creep is this close to the army
HERO_LEAD = 900.0           # the militia do not start the fight until the hero is this close
MILITIA_RETREAT = 0.0       # militia below this share of hit points walk home: off. The player wants all five to
                            # stay at the natural, wait there and build the hall and the tower (2026-10-20)
HERO_RETREAT = 0.30         # hero below this: everyone home, event failed
CLEAR_QUIET = 3.0           # seconds without a visible camp creep after the fight = cleared
TIMEOUT = 240.0             # seconds from the start of the march (the west camp takes ~2.5 min)
MANUAL_PAUSE = 5.0
REORDER = 1.5               # do not repeat the same order to a unit more often than this
# Lost Temple natural camps are forest trolls: healers and trappers die first, then the weakest.
PRIORITY = ("nfsp", "nftk", "nfsh", "nftt", "nftb", "nftr")


def dist(a, b) -> float:
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


class Clear:
    def __init__(self, camp: tuple[float, float], home: tuple[float, float], members: list[int], t: float, est: float | None = None):
        self.camp = {"x": camp[0], "y": camp[1]}
        self.home = {"x": home[0], "y": home[1]}
        self.members = list(members)      # unit ids: hero, footmen, militia (summons join later)
        self.started = t
        self.phase = "march"
        self.seen = False                 # any camp creep seen yet
        self.quiet_since: float | None = None
        self.retreated: set[int] = set()
        self.given: dict[int, tuple] = {}  # unit -> (order key, time) we last gave
        self.manual: dict[int, float] = {}
        self.focus: int | None = None
        self.result: str | None = None     # "done" | "failed: ..." when finished
        self.note = "部队前往野怪点"

    # ---- helpers -------------------------------------------------------------------------------
    def _creeps(self, obs):
        return [u for u in obs.get("visible_enemies", []) if u.get("owner") == NEUTRAL_HOSTILE and u.get("hp", 0) > 0
                and dist(u, self.camp) <= CAMP_RADIUS]

    def _order(self, cmd, unit, t, command, **arguments):
        key = (command, tuple(sorted(arguments.items())))
        last = self.given.get(unit["unit_id"])
        if last and last[0] == key:
            march = command == "attack" and "target_id" not in arguments
            # Warcraft keeps an attack-move going. Re-sending it every REORDER seconds restarts the
            # order and makes the column stutter, so while the unit is already attacking we leave it.
            if march and (unit.get("order") or {}).get("name") == "attack":
                return
            if t - last[1] < REORDER:
                return
        cmd.order(unit["unit_id"], command, **arguments)
        self.given[unit["unit_id"]] = (key, t)

    def _by_hand(self, unit, t) -> bool:
        """Is the player steering this unit? We told it to attack and it is moving (being pulled
        back), or we told it to move and it attacks or heads elsewhere. An attack-move that picks
        its own creep is ours. Such a unit is left alone for MANUAL_PAUSE seconds."""
        uid = unit["unit_id"]
        if t < self.manual.get(uid, -1):
            return True
        last, order = self.given.get(uid), unit.get("order") or {}
        if not last or not order or t - last[1] < 1.0:
            return False
        command, args = last[0][0], dict(last[0][1])
        name = order.get("name")
        moved_off = name == "move" and (command != "move" or "x" in args and order.get("x") is not None
                                        and math.hypot(order["x"] - args["x"], order["y"] - args["y"]) > 200)
        if (command == "attack" and moved_off) or (command == "move" and (name == "attack" or moved_off)):
            self.manual[uid] = t + MANUAL_PAUSE
            return True
        return False

    # ---- one tick ------------------------------------------------------------------------------
    def tick(self, cmd, obs, t) -> None:
        """cmd.order(unit_id, command, **arguments) gives orders; obs is the current observation."""
        if self.result:
            return
        own = {u["unit_id"]: u for u in obs["units"]}
        for ev in obs.get("events", []):  # water elementals fight with us
            if ev.get("kind") == "summon" and ev.get("unit_id") in self.members and ev.get("summoned_id"):
                self.members.append(ev["summoned_id"])
        # the second footman (or a later one) may finish training after the march began: it joins
        # where it is and walks to the camp instead of waiting at the barracks
        for u in obs["units"]:
            if u["unit_id"] in self.members or u.get("structure"):
                continue
            if u.get("hero") or u["type_id"] == "hfoo":
                self.members.append(u["unit_id"])
        army = [own[m] for m in self.members if m in own and m not in self.retreated]
        heroes = [u for u in army if u.get("hero")]
        creeps = self._creeps(obs)
        if creeps:
            self.seen, self.quiet_since = True, None
        if t - self.started > TIMEOUT:
            return self._finish(cmd, army, t, "failed: 超时")
        if not heroes and not any(own.get(m, {}).get("hero") for m in self.members):
            return self._finish(cmd, army, t, "failed: 英雄不在了")
        for h in heroes:
            if h["hp"] < HERO_RETREAT * h["max_hp"]:
                return self._finish(cmd, army, t, "failed: 英雄血量过低，全队撤回", retreat=True)

        hero_close = any(dist(h, self.camp) <= HERO_LEAD for h in heroes)
        near = creeps and hero_close and min(dist(c, u) for c in creeps for u in army) <= ENGAGE if army else False
        if self.phase == "march" and near:
            self.phase = "fight"
        if self.phase == "march":
            self.note = "大法师已到，进攻野怪点" if hero_close else "部队前往野怪点（等大法师）"
            for u in army:
                if not self._by_hand(u, t):
                    # everyone leaves the altar together and walks straight at the camp; the fight
                    # itself only starts once the hero is close, so the militia cannot clear alone
                    self._order(cmd, u, t, "attack", x=self.camp["x"], y=self.camp["y"])
            return

        # fight
        if not creeps:
            if self.quiet_since is None:
                self.quiet_since = t
            self.note = "附近没看到野怪，确认中"
            if t - self.quiet_since >= CLEAR_QUIET:
                return self._finish(cmd, army, t, "done")
            for u in army:
                if not self._by_hand(u, t):
                    self._order(cmd, u, t, "attack", x=self.camp["x"], y=self.camp["y"])
            return
        rank = {k: i for i, k in enumerate(PRIORITY)}
        target = min(creeps, key=lambda c: (rank.get(c["type_id"], len(PRIORITY)), c["hp"] / max(1, c["max_hp"]), dist(c, self.camp)))
        self.focus = target["unit_id"]
        self.note = f"清野中：集火 {target['type_id']}（剩 {len(creeps)} 个）"
        for u in army:
            if self._by_hand(u, t):
                continue
            if u["type_id"] == "hmil" and u["hp"] < MILITIA_RETREAT * u["max_hp"]:
                self._order(cmd, u, t, "move", x=self.home["x"], y=self.home["y"])
                self.retreated.add(u["unit_id"])
                continue
            if u.get("hero") and self._summon_ready(u):
                self._order(cmd, u, t, "cast", order=ORDERS["water"])
                continue
            self._order(cmd, u, t, "attack", target_id=target["unit_id"])

    @staticmethod
    def _summon_ready(hero) -> bool:
        for a in hero.get("abilities") or []:
            if a.get("ability_id") == ORDERS["water_ability"]:
                return a.get("level", 0) > 0 and a.get("cooldown_remaining", 1) <= 0 and hero.get("mana", 0) >= a.get("mana_cost", 999)
        return False

    def _finish(self, cmd, army, t, result, retreat=False) -> None:
        self.result = result
        self.note = {"done": "清完野怪"}.get(result, result.replace("failed: ", "失败："))
        # On a win the army stays where it is: the militia wait at the natural, turn back into
        # peasants there, and four of them build the hall while one raises the tower.
        if retreat:
            for u in army:
                cmd.order(u["unit_id"], "move", x=self.home["x"], y=self.home["y"])
