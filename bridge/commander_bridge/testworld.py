"""A Lost Temple economy world for wc3env's FakeServer.

wc3env ships a FakeServer that speaks the same RPC as the injected DLL. Its default world
only walks units around. This world adds the parts the commander needs to exercise:
gold and lumber harvesting, Human construction (the builder must stay), production
queues, food, and the wc3env events (construct_start/finish, train_start/finish).

It is a test double that follows the observation and action contracts in wc3env's
docs/specs, not a Warcraft model: units walk in straight lines, combat is a crude exchange of
damage per second between our units and the creeps passed in (no armour, no collision), and
auto_place uses the requested point unless auto_place_shift is set (Warcraft's own search can
move a site several hundred units; FakeServer cannot report where, so placements stay empty).
"""
from __future__ import annotations

import math

TURN_MS = 25
MINE_SECONDS = 1.0
CHOP_SECONDS = 1.1
CARRY = 10
TREE_WOOD = 50
HALLS = ("htow", "hkee", "hcas")
NEUTRAL_HOSTILE = 12
# rough hit points / damage per second / mana, enough to exercise combat.Clear
STATS = {"Hamg": (450, 22, 285), "Hmkg": (700, 30, 225), "hfoo": (420, 12, 0), "hmil": (220, 10, 0), "hpea": (220, 4, 0), "hwat": (525, 18, 0)}
REACH, AGGRO = 110, 500        # melee reach; attack-move picks up creeps this close
WATER = {"ability": "AHwe", "order": "waterelemental", "mana": 125, "cooldown": 20.0, "life": 60.0}
MILITIA_ORDER, MILITIA_SECONDS = "militia", 45.0
SIGHT = 2200  # trees reported within this distance of own objects (fog stand-in)


class LostTempleWorld:
    def __init__(self, data: dict, start: int = 0, speed: float | None = None, auto_place_shift: tuple[float, float] | None = None,
                 creeps: list[dict] | None = None):
        self.eco = data["economy"]["units"]
        self.auto_place_shift = auto_place_shift
        self.speed = speed or data["worker"]["speed"]
        self.races = {0: "human", 1: "orc"}
        self.result = ""
        self.game_time_ms = 0
        self.gold, self.lumber = 500, 150
        self.units: dict[int, dict] = {}
        self.events: list[dict] = []
        self.next_id = 1000
        self.mine_inside: dict[int, int] = {}
        self.mines = {}
        for m in data["mines"]:
            mid = self._id()
            self.mines[mid] = {"unit_id": mid, "type_id": "ngol", "owner": 15, "x": m["x"], "y": m["y"], "gold": m["gold"]}
        self.trees = {}
        self._tree_key, self._tree_ids = None, []  # trees in sight, kept until the anchor moves
        flat = data["trees"]
        for k in range(0, len(flat), 2):
            tid = 50000 + k // 2
            self.trees[tid] = {"id": tid, "type_id": "LTlt", "x": float(flat[k]), "y": float(flat[k + 1]), "hp": TREE_WOOD}
        s = data["starts"][start]
        self.hall = self._unit("htow", s["x"], s["y"], structure=True)
        mine = min(self.mines.values(), key=lambda m: math.hypot(m["x"] - s["x"], m["y"] - s["y"]))
        dx, dy = mine["x"] - s["x"], mine["y"] - s["y"]
        d = math.hypot(dx, dy) or 1
        for k in range(5):
            self._unit("hpea", s["x"] + dx / d * 300 - dy / d * (k - 2) * 44, s["y"] + dy / d * 300 + dx / d * (k - 2) * 44)
        for c in creeps or []:  # {type, x, y, hp, dps}
            u = self._unit(c["type"], c["x"], c["y"], owner=NEUTRAL_HOSTILE)
            u.update(hp=c.get("hp", 300), max_hp=c.get("hp", 300), _dps=c.get("dps", 8))

    # ---- helpers -----------------------------------------------------------------------------
    def _id(self) -> int:
        self.next_id += 1
        return self.next_id

    def _unit(self, type_id, x, y, structure=False, constructing=False, owner=0):
        uid = self._id()
        hero = type_id[0].isupper()
        hp, dps, mana = STATS.get(type_id, (100, 0, 0))
        self.units[uid] = {
            "unit_id": uid, "type_id": type_id, "owner": owner, "x": float(x), "y": float(y),
            "hp": hp, "max_hp": hp, "mana": mana, "max_mana": mana, "structure": structure, "hero": hero, "_dps": dps, "_abilities": [],
            "level": 1 if hero else 0, "buffs": [],
            "_job": None, "_carry": None, "_amt": 0, "_inside": False,
            "_state": "constructing" if constructing else None, "_progress": 0.0, "_queue": [], "_qleft": 0.0,
        }
        return self.units[uid]

    def _food(self):
        used = sum(self.eco[u["type_id"]]["food"] for u in self.units.values() if not u["structure"] and u["owner"] == 0 and u["type_id"] in self.eco)
        used += sum(self.eco[u["_queue"][0]]["food"] for u in self.units.values() if u["structure"] and u["_queue"] and u["_qleft"] > 0)
        cap = sum(self.eco[u["type_id"]]["foodMade"] for u in self.units.values() if u["structure"] and u["_state"] != "constructing")
        return used, min(100, cap)

    def _walk(self, u, x, y, stop, dt):
        dx, dy = x - u["x"], y - u["y"]
        d = math.hypot(dx, dy)
        if d <= stop:
            return True
        s = min(self.speed * dt, d - stop)
        u["x"] += dx / d * s
        u["y"] += dy / d * s
        return d - s <= stop + 1e-6

    def _drop(self, u, res):
        opts = [b for b in self.units.values() if b["structure"] and b["_state"] != "constructing" and (b["type_id"] in HALLS or (res == "lumber" and b["type_id"] == "hlum"))]
        return min(opts, key=lambda b: math.hypot(b["x"] - u["x"], b["y"] - u["y"])) if opts else None

    def _half(self, type_id):
        return {"htow": 256, "hkee": 256, "hcas": 256, "ngol": 256, "hbar": 192, "halt": 160, "hlum": 160, "hhou": 64, "hbla": 128}.get(type_id, 128)

    # ---- simulation --------------------------------------------------------------------------
    def advance(self, ms: int) -> None:
        for _ in range(ms // TURN_MS):
            self.game_time_ms += TURN_MS
            self._tick(TURN_MS / 1000)

    def _combat(self, dt):
        alive = lambda u: u["unit_id"] in self.units
        creeps = [c for c in self.units.values() if c["owner"] == NEUTRAL_HOSTILE]
        ours = [u for u in self.units.values() if u["owner"] == 0 and not u["structure"] and not u["_inside"]]
        for u in ours:  # timers: summons expire, militia turn back, cooldowns run
            for a in u["_abilities"]:
                a["cooldown_remaining"] = max(0.0, a["cooldown_remaining"] - dt)
            if "_life" in u:
                u["_life"] -= dt
                if u["_life"] <= 0:
                    del self.units[u["unit_id"]]
                    continue
            if "_milleft" in u:
                u["_milleft"] -= dt
                if u["_milleft"] <= 0:
                    u["type_id"] = "hpea"
                    del u["_milleft"]
            job = u["_job"]
            if job and job["kind"] == "tohall":
                if self._walk(u, self.hall["x"], self.hall["y"], self._half("htow") + 24, dt):
                    u.update(type_id="hmil", _job=None, _milleft=MILITIA_SECONDS)
                continue
            if not job or job["kind"] not in ("attack", "attackmove"):
                continue
            target = self.units.get(job.get("target")) if job.get("target") else None
            if job["kind"] == "attackmove" and target is None:
                near = [c for c in creeps if alive(c) and math.hypot(c["x"] - u["x"], c["y"] - u["y"]) <= AGGRO]
                if near:
                    target = min(near, key=lambda c: math.hypot(c["x"] - u["x"], c["y"] - u["y"]))
                    job["target"] = target["unit_id"]
                elif self._walk(u, job["x"], job["y"], 0, dt):
                    u["_job"] = None
                    continue
            if target is None:
                if job["kind"] == "attack":
                    u["_job"] = None
                else:
                    job["target"] = None
                continue
            if self._walk(u, target["x"], target["y"], REACH, dt):
                target["hp"] -= u["_dps"] * dt
        for c in creeps:  # each creep hits the nearest of our units in reach
            if not alive(c):
                continue
            if c["hp"] <= 0:
                del self.units[c["unit_id"]]
                self.events.append({"kind": "death", "unit_id": c["unit_id"], "type_id": c["type_id"], "owner": NEUTRAL_HOSTILE})
                continue
            near = [u for u in self.units.values() if u["owner"] == 0 and not u["structure"] and not u["_inside"] and math.hypot(c["x"] - u["x"], c["y"] - u["y"]) <= 400]
            if near:
                v = min(near, key=lambda u: math.hypot(c["x"] - u["x"], c["y"] - u["y"]))
                if self._walk(c, v["x"], v["y"], REACH, dt):
                    v["hp"] -= c["_dps"] * dt
                    if v["hp"] <= 0:
                        del self.units[v["unit_id"]]
                        self.events.append({"kind": "death", "unit_id": v["unit_id"], "type_id": v["type_id"], "owner": 0})

    def _tick(self, dt):
        self._combat(dt)
        for u in list(self.units.values()):
            job = u["_job"]
            if u["structure"]:
                self._production(u, dt)
                continue
            if not job:
                continue
            kind = job["kind"]
            if kind == "move":
                if self._walk(u, job["x"], job["y"], 0, dt):
                    u["_job"] = None
            elif kind == "gold":
                self._gold(u, job, dt)
            elif kind == "lumber":
                self._lumber(u, job, dt)
            elif kind == "build":
                self._build(u, job, dt)
        for b in self.units.values():
            if b["structure"] and b["_state"] == "upgrading":
                b["_qleft"] -= dt
                if b["_qleft"] <= 0:
                    b.update(type_id=b.pop("_upgrade"), _state=None, _qleft=0.0)
                    self.events.append({"kind": "upgrade_finish", "unit_id": b["unit_id"], "type_id": b["type_id"]})
            if b["structure"] and b["_state"] == "constructing":
                builders = [u for u in self.units.values() if u["_job"] and u["_job"]["kind"] == "build" and u["_job"].get("site") == b["unit_id"]]
                if builders:  # power build: each extra builder adds 0.6x speed (assumption, as sim.js ASSIST)
                    b["_progress"] += dt / self.eco[b["type_id"]]["time"] * (1 + 0.6 * (len(builders) - 1))
                if b["_progress"] >= 1:
                    b["_state"] = None
                    self.events.append({"kind": "construct_finish", "unit_id": b["unit_id"], "type_id": b["type_id"]})
                    for w in builders:
                        w["_job"] = None  # Warcraft leaves the builder idle

    def _gold(self, u, job, dt):
        mine = self.mines.get(job["target"])
        if mine is None:
            u["_job"] = None
            return
        phase = job.setdefault("phase", "go" if u["_amt"] == 0 else "back")
        if phase == "go":
            if self._walk(u, mine["x"], mine["y"], 256 + 24, dt):
                job["phase"] = "wait"
        elif phase == "wait":
            if mine["unit_id"] not in self.mine_inside and mine["gold"] > 0:
                self.mine_inside[mine["unit_id"]] = u["unit_id"]
                u["_inside"], job["phase"], job["timer"] = True, "in", MINE_SECONDS
        elif phase == "in":
            job["timer"] -= dt
            if job["timer"] <= 0:
                g = min(CARRY, mine["gold"])
                mine["gold"] -= g
                u["_carry"], u["_amt"], u["_inside"], job["phase"] = "gold", g, False, "back"
                del self.mine_inside[mine["unit_id"]]
        elif phase == "back":
            hall = self._drop(u, "gold")
            if hall and self._walk(u, hall["x"], hall["y"], self._half(hall["type_id"]) + 24, dt):
                self.gold += u["_amt"]
                u["_amt"], u["_carry"], job["phase"] = 0, None, "go"

    def _lumber(self, u, job, dt):
        phase = job.setdefault("phase", "go" if u["_amt"] == 0 else "back")
        tree = self.trees.get(job["target"])
        if phase in ("go", "chop") and tree is None:
            near = [t for t in self.trees.values() if math.hypot(t["x"] - u["x"], t["y"] - u["y"]) < 600]
            if not near:
                u["_job"] = None  # no tree in reach: the worker stops, as in Warcraft
                return
            job["target"] = min(near, key=lambda t: math.hypot(t["x"] - u["x"], t["y"] - u["y"]))["id"]
            tree = self.trees[job["target"]]
            job["phase"] = phase = "go"
        if phase == "go":
            if self._walk(u, tree["x"], tree["y"], 72, dt):
                job["phase"], job["timer"] = "chop", CHOP_SECONDS
        elif phase == "chop":
            job["timer"] -= dt
            if job["timer"] <= 0:
                job["timer"] += CHOP_SECONDS
                u["_carry"], u["_amt"] = "lumber", u["_amt"] + 1
                tree["hp"] -= 1
                if tree["hp"] <= 0:
                    del self.trees[tree["id"]]
                if u["_amt"] >= CARRY or tree["hp"] <= 0:
                    job["phase"] = "back"
        elif phase == "back":
            drop = self._drop(u, "lumber")
            if drop and self._walk(u, drop["x"], drop["y"], self._half(drop["type_id"]) + 24, dt):
                self.lumber += u["_amt"]
                u["_amt"], u["_carry"], job["phase"] = 0, None, "go"

    def _build(self, u, job, dt):
        if job.get("site"):
            return  # standing at the site; progress is applied by the structure loop
        t = job["type_id"]
        if self._walk(u, job["x"], job["y"], self._half(t) + 24, dt):
            c = self.eco[t]
            if self.gold < c["gold"] or self.lumber < c["wood"]:
                u["_job"] = None  # Warcraft refuses the build and the peasant stops
                return
            self.gold -= c["gold"]
            self.lumber -= c["wood"]
            b = self._unit(t, job["x"], job["y"], structure=True, constructing=True)
            job["site"] = b["unit_id"]
            self.events.append({"kind": "construct_start", "unit_id": b["unit_id"], "type_id": t})

    def _production(self, b, dt):
        if b["_state"] is not None or not b["_queue"]:
            return
        ut = b["_queue"][0]
        if b["_qleft"] <= 0:  # waiting to start: food must be available
            used, cap = self._food()
            if used + self.eco[ut]["food"] > cap:
                return
            b["_qleft"] = self.eco[ut]["time"]
            self.events.append({"kind": "train_start", "unit_id": b["unit_id"], "type_id": ut})
        b["_qleft"] -= dt
        if b["_qleft"] <= 0:
            b["_queue"].pop(0)
            half = self._half(b["type_id"])
            n = self._unit(ut, b["x"] + half + 40, b["y"] - half - 40)
            self.events.append({"kind": "train_finish", "unit_id": b["unit_id"], "trained_id": n["unit_id"], "type_id": ut})

    # ---- RPC surface used by FakeServer ------------------------------------------------------
    def observe(self, player: int) -> dict:
        own, inside = [], []
        for u in self.units.values():
            if u["owner"] != player:
                continue
            pub = {k: v for k, v in u.items() if not k.startswith("_")}
            job = u["_job"]
            order = None
            if job:
                if job["kind"] == "move":
                    order = {"name": "move", "target_id": None, "x": job["x"], "y": job["y"]}
                elif job["kind"] in ("gold", "lumber"):
                    order = {"name": "harvest" if job.get("phase") != "back" else "returnresources", "target_id": job["target"], "x": u["x"], "y": u["y"]}
                elif job["kind"] == "build":
                    order = {"name": "repair", "target_id": job["site"], "x": job["x"], "y": job["y"]} if job.get("site") else {"name": job["type_id"], "target_id": None, "x": job["x"], "y": job["y"]}
                elif job["kind"] == "attack":
                    order = {"name": "attack", "target_id": job["target"], "x": u["x"], "y": u["y"]}
                elif job["kind"] == "attackmove":
                    order = {"name": "attack", "target_id": job.get("target"), "x": job["x"], "y": job["y"]}
            pub["order"] = order
            pub["abilities"] = [dict(a) for a in u["_abilities"]]
            if u["structure"]:
                pub.update(state=u["_state"], state_seconds=self.eco[u.get("_upgrade") or u["type_id"]]["time"] if u["_state"] else 0.0,
                           queue=list(u["_queue"]), queue_seconds=self.eco[u["_queue"][0]]["time"] if u["_queue"] else 0.0)
            if u["_inside"]:
                inside.append({"unit_id": u["unit_id"], "type_id": u["type_id"], "x": u["x"], "y": u["y"], "hp": u["hp"], "order": order})
            else:
                own.append(pub)
        trees = []
        if player == 0:  # which trees are in sight changes only when the first own object moves: keep the list
            key = next(((u["x"], u["y"]) for u in self.units.values() if u["owner"] == player), (0.0, 0.0))
            if key != self._tree_key:
                self._tree_key = key
                self._tree_ids = [tid for tid, t in self.trees.items() if abs(t["x"] - key[0]) < SIGHT and abs(t["y"] - key[1]) < SIGHT]
            trees = [{"id": t["id"], "type_id": t["type_id"], "x": t["x"], "y": t["y"], "hp": t["hp"], "resource": "lumber", "invulnerable": False}
                     for t in (self.trees.get(tid) for tid in self._tree_ids) if t is not None]
        used, cap = self._food()
        events, self.events = (self.events, []) if player == 0 else ([], self.events)
        mines = [{k: v for k, v in m.items() if k != "gold"} | {"hp": 1, "max_hp": 1, "mana": 0, "max_mana": 0, "structure": True, "hero": False, "level": 0, "buffs": []}
                 for m in self.mines.values()]
        return {
            "observer": player, "events_lost": 0, "chat": [], "destructables": trees if player == 0 else [],
            "map": {"bounds": {"min_x": -8192, "min_y": -8704, "max_x": 8192, "max_y": 8192}},
            "players": [{"id": p, "kind": "neutral" if p == 15 else "player", "relation": "self" if p == player else "neutral" if p == 15 else "enemy",
                         "team": p, "active": True, "controller": "human" if p == 0 else "computer", "shares_vision": p == player, "shares_control": p == player}
                        for p in (0, 1, 15)],
            "score": {}, "player": {"gold": self.gold, "lumber": self.lumber, "food_used": used, "food_cap": cap},
            "units": own, "inside": inside, "items": [], "inventory": [],
            "visible_enemies": (mines + [{k: v for k, v in c.items() if not k.startswith("_")} for c in self.units.values() if c["owner"] == NEUTRAL_HOSTILE]) if player == 0 else [],
            "events": events, "result": self.result,
        }

    def act(self, player: int, actions: list[dict]) -> list[dict]:
        rejected = []
        for i, a in enumerate(actions):
            u = self.units.get(a["unit_id"])
            args = a.get("arguments", {})
            cmd = a["command"]
            if u is None:
                rejected.append({"index": i, "reason": "unknown_unit"})
            elif u["owner"] != player:
                rejected.append({"index": i, "reason": "not_your_unit"})
            elif u["_inside"]:
                rejected.append({"index": i, "reason": "unknown_unit"})
            elif cmd == "move":
                u["_job"] = {"kind": "move", "x": float(args["x"]), "y": float(args["y"])}
            elif cmd == "attack":
                tid = args.get("target_id")
                u["_job"] = {"kind": "attack", "target": tid} if tid in self.units else {"kind": "attackmove", "x": float(args["x"]), "y": float(args["y"]), "target": None}
            elif cmd == "learn":
                if u["hero"] and not any(a["ability_id"] == args.get("ability_id") for a in u["_abilities"]):
                    u["_abilities"].append({"ability_id": args["ability_id"], "level": 1, "mana_cost": WATER["mana"], "cooldown_seconds": WATER["cooldown"], "cooldown_remaining": 0.0})
                    self.events.append({"kind": "hero_learn", "unit_id": u["unit_id"], "ability_id": args["ability_id"]})
            elif cmd == "cast" and args.get("order") == "setrally" and u["structure"]:
                u["_rally"] = (args.get("x"), args.get("y"))  # trained units are not placed by it here
            elif cmd == "cast" and args.get("order") == MILITIA_ORDER and u["type_id"] == "hpea":
                u["_job"] = {"kind": "tohall"}  # walks to the town hall and changes there (native probe)
            elif cmd == "cast" and args.get("order") == WATER["order"]:
                a = next((a for a in u["_abilities"] if a["ability_id"] == WATER["ability"]), None)
                if a and a["cooldown_remaining"] <= 0 and u["mana"] >= WATER["mana"]:
                    u["mana"] -= WATER["mana"]
                    a["cooldown_remaining"] = WATER["cooldown"]
                    w = self._unit("hwat", u["x"] + 60, u["y"])
                    w["_life"] = WATER["life"]
                    self.events.append({"kind": "summon", "unit_id": u["unit_id"], "summoned_id": w["unit_id"], "type_id": "hwat"})
            elif cmd == "stop":
                u["_job"] = None
            elif cmd in ("harvest", "smart"):
                tid = args.get("target_id")
                site = self.units.get(tid)
                if tid in self.mines:
                    u["_job"] = {"kind": "gold", "target": tid}
                elif tid in self.trees:
                    u["_job"] = {"kind": "lumber", "target": tid}
                elif site and site["structure"] and site["_state"] == "constructing" and cmd == "smart":
                    u["_job"] = {"kind": "build", "type_id": site["type_id"], "x": site["x"], "y": site["y"], "site": tid}
                else:
                    rejected.append({"index": i, "reason": "bad_arguments"})
            elif cmd == "build":
                t = args.get("type_id")
                if t not in self.eco or not self.eco[t]["structure"] or u["type_id"] != "hpea":
                    rejected.append({"index": i, "reason": "bad_arguments"})
                else:
                    dx, dy = self.auto_place_shift if args.get("auto_place") and self.auto_place_shift else (0.0, 0.0)
                    u["_job"] = {"kind": "build", "type_id": t, "x": float(args["x"]) + dx, "y": float(args["y"]) + dy}
            elif cmd == "train" and args.get("type_id") in (self.eco.get(u["type_id"], {}).get("upgrades") or []):
                t, c, now = args["type_id"], self.eco[args["type_id"]], self.eco[u["type_id"]]
                g, w = c["gold"] - now["gold"], c["wood"] - now["wood"]
                if u["_state"] is not None or u["_queue"]:
                    rejected.append({"index": i, "reason": "bad_arguments"})
                elif self.gold >= g and self.lumber >= w:  # an upgrade occupies the building
                    self.gold -= g
                    self.lumber -= w
                    u.update(_state="upgrading", _upgrade=t, _qleft=c["time"])
                    self.events.append({"kind": "upgrade_start", "unit_id": u["unit_id"], "type_id": u["type_id"]})
            elif cmd == "train":
                t = args.get("type_id")
                if not u["structure"] or u["_state"] is not None or t not in (self.eco[u["type_id"]]["trains"] or []) or t not in self.eco:
                    rejected.append({"index": i, "reason": "bad_arguments"})
                elif len(u["_queue"]) >= 7:
                    rejected.append({"index": i, "reason": "queue_full"})
                else:
                    c = self.eco[t]
                    hero_free = t[0].isupper() and not any(x["hero"] for x in self.units.values()) and not any(q[0].isupper() for x in self.units.values() for q in x["_queue"])
                    g, w = (0, 0) if hero_free else (c["gold"], c["wood"])
                    if self.gold >= g and self.lumber >= w:  # Warcraft charges when queued
                        self.gold -= g
                        self.lumber -= w
                        u["_queue"].append(t)
            else:
                rejected.append({"index": i, "reason": "unknown_command"})
        return rejected
