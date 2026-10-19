"""Live order probe: how wc3env commands behave in the real Warcraft III 1.27a game.

Answers, for the commander's planned event kinds, which action JSON works and what it does:
  militia   peasant -> militia (cast order names on a peasant and on the town hall), how long it
            lasts and how it ends (militiaoff / townbelloff / timeout)
  hero      Archmage from an altar (cost of the first hero), learn AHwe, cast waterelemental
            (summoned type, mana, cooldown, lifetime)
  upgrade   town hall -> keep (train hkee), scout tower -> arcane tower (train hatw): events,
            cost, duration
  assist    one peasant builds, 0-3 more right-click (smart) the site: duration and cost

Runs its own offline stepping session on Lost Temple (player 0 human, no opponent) with debug
staging: the starting peasants are removed, buildings and peasants are spawned, resources are set
and the clock runs fast. It does not touch the commander bridge on port 8790.

Run on the game PC with wc3env-127a's own Python (only after the user agrees to start the game):
  ..\\wc3env-127a\\.venv\\Scripts\\python.exe tools\\probe_orders.py --out probe-out
Writes <out>/log.jsonl (every action, reply, event and watched change) and <out>/summary.json.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import traceback
from pathlib import Path


class Probe:
    def __init__(self, session, out: Path, speed: float):
        self.session = session
        self.c = session.game.rpc
        self.out = out
        self.logf = (out / "log.jsonl").open("w", encoding="utf-8")
        self.summary: dict = {}
        self.events: list[dict] = []
        self.obs: dict = {}
        self.section = "setup"
        self.c.debug("speed", factor=speed)
        self.observe()

    # ---- plumbing -------------------------------------------------------------------------------
    def log(self, tag: str, /, **data) -> None:
        rec = {"t": self.t, "section": self.section, "tag": tag, **data}
        self.logf.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self.logf.flush()
        brief = json.dumps(data, ensure_ascii=False)
        print(f"[{self.t:7.2f}] {self.section:8} {tag}: {brief[:300]}", flush=True)

    @property
    def t(self) -> float:
        return float(self.obs.get("game_time_seconds", 0.0))

    def observe(self) -> dict:
        self.obs = self.c.observe(0)
        for e in self.obs.get("events", []):
            if e.get("kind") == "attacked":
                continue
            e = {**e, "t": self.t}
            self.events.append(e)
            self.log("event", **e)
        return self.obs

    def step(self, ms: int = 250) -> dict:
        self.c.step(ms)
        return self.observe()

    def act(self, uid: int, command: str, **arguments) -> dict:
        action = {"unit_id": uid, "command": command, "arguments": arguments}
        reply = self.c.act(0, [action])
        self.log("act", action=action, rejected=reply.get("rejected", []), placements=reply.get("placements", []))
        return reply

    def debug(self, op: str, **args) -> dict:
        reply = self.c.debug(op, **args)
        self.log("debug", op=op, args=args, reply=reply)
        return reply

    def unit(self, uid: int) -> dict | None:
        for u in self.obs.get("units", []):
            if u["unit_id"] == uid:
                return u
        for u in self.obs.get("inside", []):
            if u["unit_id"] == uid:
                return {**u, "inside": True}
        return None

    def free(self, uid: int) -> bool:
        """Present on the map (not inside a mine or building), so it can be given orders."""
        u = self.unit(uid)
        return u is not None and not u.get("inside")

    def res(self) -> dict:
        p = self.obs["player"]
        return {"gold": p["gold"], "lumber": p["lumber"], "food_used": p["food_used"], "food_cap": p["food_cap"]}

    def set_res(self, gold: int = 5000, lumber: int = 5000) -> None:
        self.debug("resources", player=0, gold=gold, lumber=lumber)
        self.observe()

    def look(self, uid: int) -> dict | None:
        u = self.unit(uid)
        if u is None:
            return None
        keys = ("type_id", "x", "y", "hp", "max_hp", "mana", "order", "state", "state_seconds", "queue",
                "queue_seconds", "abilities", "inside")
        return {k: u[k] for k in keys if k in u}

    def snapshot(self, uid: int) -> tuple:
        u = self.unit(uid)
        if u is None:
            return ("gone",)
        order = (u.get("order") or {}).get("name")
        return (u["type_id"], bool(u.get("inside")), order, u.get("state"))

    def watch(self, uids, seconds: float, until=None, ms: int = 250, every: float | None = None) -> float | None:
        """Step for up to `seconds` of game time, logging each change of a watched unit's type,
        inside-ness, order or state. Returns the game time `until()` first held, else None."""
        last = {uid: self.snapshot(uid) for uid in uids}
        end = self.t + seconds
        next_res = self.t
        while self.t < end:
            self.step(ms)
            for uid in uids:
                now = self.snapshot(uid)
                if now != last[uid]:
                    u = self.unit(uid)
                    self.log("change", unit_id=uid, before=list(last[uid]), after=list(now),
                             pos=[round(u["x"]), round(u["y"])] if u else None)
                    last[uid] = now
            if every is not None and self.t >= next_res:
                self.log("resources", **self.res())
                next_res = self.t + every
            if until is not None and until():
                return self.t
        return None

    def events_since(self, t0: float, kind: str, **match) -> list[dict]:
        return [e for e in self.events if e["t"] >= t0 and e["kind"] == kind
                and all(e.get(k) == v for k, v in match.items())]

    def cost(self, before: dict, after: dict) -> dict:
        return {"gold": before["gold"] - after["gold"], "lumber": before["lumber"] - after["lumber"]}

    # ---- geometry --------------------------------------------------------------------------------
    def setup_home(self) -> None:
        units = self.obs["units"]
        self.hall = next(u for u in units if u["type_id"] == "htow")["unit_id"]
        hall = self.unit(self.hall)
        mines = [u for u in self.obs.get("visible_enemies", []) if u["type_id"] == "ngol"]
        b = self.obs["map"]["bounds"]
        cx, cy = (b["min_x"] + b["max_x"]) / 2, (b["min_y"] + b["max_y"]) / 2
        hx, hy = hall["x"], hall["y"]
        d = math.hypot(cx - hx, cy - hy) or 1.0
        self.home = (hx, hy)
        self.dir = ((cx - hx) / d, (cy - hy) / d)
        self.log("home", hall=self.hall, x=hx, y=hy, toward_center=self.dir,
                 mines=[[m["unit_id"], round(m["x"]), round(m["y"])] for m in mines],
                 starting=[[u["unit_id"], u["type_id"]] for u in units])

    def pt(self, dist: float, side: float = 0.0) -> tuple[float, float]:
        (hx, hy), (ux, uy) = self.home, self.dir
        return hx + ux * dist - uy * side, hy + uy * dist + ux * side

    def spawn(self, type_id: str, dist: float, side: float = 0.0, n: int = 1) -> list[int]:
        x, y = self.pt(dist, side)
        ids = self.debug("spawn", type_id=type_id, player=0, x=x, y=y, n=n)["unit_ids"]
        self.observe()
        return ids

    def remove(self, uids) -> None:
        for uid in uids:
            if self.unit(uid) is not None:
                try:
                    self.debug("remove", unit_id=uid)
                except Exception as exc:  # already gone or not removable
                    self.log("remove_failed", unit_id=uid, error=str(exc))
        self.observe()

    def clear_starting_workers(self) -> None:
        """Remove the five starting peasants so mining does not move gold during measurements."""
        for _ in range(40):
            workers = [u["unit_id"] for u in self.obs["units"] if u["type_id"] == "hpea"]
            if workers:
                self.remove(workers)
            if not self.obs.get("inside") and not workers:
                break
            self.step(250)
        self.log("cleared", units=[[u["unit_id"], u["type_id"]] for u in self.obs["units"]],
                 inside=self.obs.get("inside", []), **self.res())

    # ---- sections --------------------------------------------------------------------------------
    def militia(self) -> dict:
        r: dict = {}
        hall = self.hall
        self.set_res(500, 500)
        near = self.spawn("hpea", 350, -250)[0]
        mid = self.spawn("hpea", 450, 250)[0]
        far = self.spawn("hpea", 1300, 0)[0]
        peas = [near, mid, far]
        r["peasant_abilities"] = [a["ability_id"] for a in self.unit(near).get("abilities", [])]
        r["hall_abilities"] = [a["ability_id"] for a in self.unit(hall).get("abilities", [])]
        self.log("abilities", peasant=self.look(near), hall=self.look(hall))
        is_mil = lambda uid: (self.unit(uid) or {}).get("type_id") == "hmil"  # noqa: E731

        # A: single peasant, candidate orders.
        tried = []
        for order, args in (("militia", {}), ("militiaconvert", {"target_id": hall}), ("militia", {"target_id": hall})):
            t0 = self.t
            reply = self.act(near, "cast", order=order, **args)
            hit = self.watch(peas, 12, until=lambda: is_mil(near))
            tried.append({"order": order, "args": args, "rejected": reply.get("rejected"),
                          "became_militia_after": None if hit is None else round(hit - t0, 2)})
            if hit is not None:
                break
        r["single_peasant"] = tried
        t0 = self.t
        reply = self.act(far, "cast", order="militia")
        hit = self.watch(peas, 15, until=lambda: is_mil(far))
        r["single_far_peasant"] = {"rejected": reply.get("rejected"), "distance": 1300,
                                   "became_militia_after": None if hit is None else round(hit - t0, 2), "unit": self.look(far)}

        # B: town hall Call to Arms for everyone (the far peasant has to walk).
        t0 = self.t
        res0 = self.res()
        reply = self.act(hall, "cast", order="townbellon")
        hit = self.watch(peas, 25, until=lambda: all(is_mil(p) for p in peas))
        r["townbellon"] = {"rejected": reply.get("rejected"), "all_militia_after": None if hit is None else round(hit - t0, 2),
                           "types": {p: self.snapshot(p) for p in peas}, "cost": self.cost(res0, self.res()),
                           "hall": self.look(hall)}

        # C: one militia sent back alone, the rest by the hall's Back to Work.
        militia = [p for p in peas if is_mil(p) and self.free(p)]
        if militia:
            m = militia[0]
            t0 = self.t
            tries = []
            for order in ("militiaoff", "militiaunconvert"):
                reply = self.act(m, "cast", order=order)
                hit = self.watch(peas, 15, until=lambda: (self.unit(m) or {}).get("type_id") == "hpea")
                tries.append({"order": order, "rejected": reply.get("rejected"),
                              "peasant_again_after": None if hit is None else round(hit - t0, 2), "unit": self.look(m)})
                if hit is not None or not self.free(m):
                    break
            r["single_back"] = tries
        t0 = self.t
        reply = self.act(hall, "cast", order="townbelloff")
        hit = self.watch(peas, 25, until=lambda: not any(is_mil(p) for p in peas))
        r["townbelloff"] = {"rejected": reply.get("rejected"), "all_peasant_after": None if hit is None else round(hit - t0, 2),
                            "types": {p: self.snapshot(p) for p in peas}}

        # D: let militia expire on their own, away from the hall.
        self.watch(peas, 3)
        reply = self.act(hall, "cast", order="townbellon")
        made = self.watch(peas, 25, until=lambda: any(is_mil(p) for p in peas))
        mil = [p for p in peas if is_mil(p)]
        for p in mil:
            if self.free(p):
                x, y = self.pt(900, 600)
                self.act(p, "move", x=x, y=y)
        t0 = made or self.t
        gone = self.watch(peas, 90, ms=500, until=lambda: not any(is_mil(p) for p in mil))
        r["expire"] = {"rejected": reply.get("rejected"), "militia": mil,
                       "reverted_after": None if gone is None else round(gone - t0, 2),
                       "after": {p: self.look(p) for p in peas}}
        self.remove(peas)
        return r

    def hero(self) -> dict:
        r: dict = {}
        altar = self.spawn("halt", 650, 650)[0]
        self.watch([altar], 1)
        self.log("altar", unit=self.look(altar))
        self.set_res(1000, 1000)
        res0, t0 = self.res(), self.t
        reply = self.act(altar, "train", type_id="Hamg")
        done = self.watch([altar], 90, ms=500, until=lambda: bool(self.events_since(t0, "train_finish", unit_id=altar)))
        started = self.events_since(t0, "train_start", unit_id=altar)
        finished = self.events_since(t0, "train_finish", unit_id=altar)
        r["train"] = {"rejected": reply.get("rejected"), "train_start": started, "train_finish": finished,
                      "seconds": None if done is None or not started else round(finished[0]["t"] - started[0]["t"], 2),
                      "cost_first_hero": self.cost(res0, self.res())}
        if not finished:
            return r
        hero = finished[0]["trained_id"]
        self.log("hero", unit=self.look(hero))
        r["hero_before"] = self.look(hero)

        t0 = self.t
        reply = self.act(hero, "learn", ability_id="AHwe")
        self.watch([hero], 1)
        r["learn"] = {"rejected": reply.get("rejected"), "hero_learn": self.events_since(t0, "hero_learn"),
                      "abilities": self.look(hero)["abilities"]}

        h = self.unit(hero)
        x, y = h["x"] + 200, h["y"]
        tries, summons = [], []
        for args in ({}, {"x": x, "y": y}, {"target_id": hero}):
            mana0, t0 = self.unit(hero)["mana"], self.t
            reply = self.act(hero, "cast", order="waterelemental", **args)
            self.watch([hero], 3)
            summons = self.events_since(t0, "summon", unit_id=hero)
            ability = next((a for a in self.unit(hero)["abilities"] if a["ability_id"] == "AHwe"), None)
            tries.append({"args": args, "rejected": reply.get("rejected"), "summon": summons,
                          "spell_effect": self.events_since(t0, "spell_effect"), "mana_before": mana0,
                          "mana_after": self.unit(hero)["mana"], "ability": ability})
            if summons:
                break
        r["cast"] = tries
        if summons:
            # A second cast right away should do nothing while on cooldown.
            t1 = self.t
            reply = self.act(hero, "cast", order="waterelemental", **tries[-1]["args"])
            self.watch([hero], 2)
            r["recast_on_cooldown"] = {"rejected": reply.get("rejected"), "summon": self.events_since(t1, "summon", unit_id=hero),
                                       "mana": self.unit(hero)["mana"]}
        if summons:
            elem = summons[0]["summoned_id"]
            r["elemental"] = self.look(elem)
            born = summons[0]["t"]
            gone = self.watch([elem, hero], 90, ms=500, until=lambda: self.unit(elem) is None)
            r["elemental_lifetime"] = None if gone is None else round(gone - born, 2)
            r["elemental_death_event"] = self.events_since(born, "death", unit_id=elem)
            r["ability_after"] = next((a for a in self.unit(hero)["abilities"] if a["ability_id"] == "AHwe"), None)
        self.hero_id, self.altar = hero, altar
        return r

    def upgrade_one(self, building: int, target: str, timeout: float) -> dict:
        self.set_res(5000, 5000)
        res0, t0 = self.res(), self.t
        tries = []
        for command in ("train", "research"):
            reply = self.act(building, command, type_id=target)
            self.watch([building], 3)
            started = self.events_since(t0, "upgrade_start", unit_id=building)
            tries.append({"command": command, "rejected": reply.get("rejected"), "upgrade_start": started,
                          "building": self.look(building)})
            if started:
                break
        r = {"tries": tries, "cost": self.cost(res0, self.res())}
        started = self.events_since(t0, "upgrade_start", unit_id=building)
        if not started:
            return r
        done = self.watch([building], timeout, ms=500,
                          until=lambda: bool(self.events_since(t0, "upgrade_finish", unit_id=building)))
        finish = self.events_since(t0, "upgrade_finish", unit_id=building)
        r.update(upgrade_finish=finish, seconds=None if done is None else round(finish[0]["t"] - started[0]["t"], 2),
                 after=self.look(building), cost_total=self.cost(res0, self.res()))
        return r

    def upgrade(self) -> dict:
        r: dict = {"keep": self.upgrade_one(self.hall, "hkee", 200)}
        tower = self.spawn("hwtw", 700, -700)[0]
        self.watch([tower], 1)
        r["tower_unit"] = self.look(tower)
        r["arcane"] = self.upgrade_one(tower, "hatw", 120)
        if not r["arcane"].get("upgrade_finish"):
            sanctum = self.spawn("hars", 1000, -900)[0]  # in case the arcane tower needs a prerequisite
            self.watch([sanctum], 1)
            r["arcane_with_sanctum"] = self.upgrade_one(tower, "hatw", 120)
        return r

    def assist_one(self, type_id: str, helpers: int, command: str, dist: float) -> dict:
        self.set_res(5000, 5000)
        anchor = self.pt(dist, 0)
        crew = self.spawn("hpea", dist - 250, -150, n=1 + helpers)
        builder, rest = crew[0], crew[1:]
        res0, t0 = self.res(), self.t
        reply = self.act(builder, "build", type_id=type_id, x=anchor[0], y=anchor[1], auto_place=True)
        r = {"type_id": type_id, "helpers": helpers, "command": command, "rejected": reply.get("rejected"),
             "placements": reply.get("placements")}
        hit = self.watch(crew, 30, until=lambda: bool(self.events_since(t0, "construct_start", type_id=type_id)))
        if hit is None:
            r["error"] = "no construct_start"
            self.remove(crew)
            return r
        start = self.events_since(t0, "construct_start", type_id=type_id)[0]
        site = start["unit_id"]
        r["cost_at_start"] = self.cost(res0, self.res())
        res1 = self.res()
        for h in rest:
            if command == "smart":
                self.act(h, "smart", target_id=site)
            else:
                self.act(h, "cast", order=command, target_id=site)
        done = self.watch([site, *crew], 300, ms=500, every=5,
                          until=lambda: bool(self.events_since(t0, "construct_finish", unit_id=site)))
        r.update(construct_start=start["t"], site=self.look(site) if done is None else None,
                 seconds=None if done is None else round(self.events_since(t0, "construct_finish", unit_id=site)[0]["t"] - start["t"], 2),
                 extra_cost_during=self.cost(res1, self.res()),
                 crew_orders={h: (self.unit(h) or {}).get("order") for h in crew})
        self.remove([site, *crew])
        return r

    def assist(self) -> dict:
        trials = [("hhou", 0, "smart"), ("hhou", 1, "smart"), ("hhou", 2, "smart"), ("hhou", 3, "smart"),
                  ("hhou", 2, "repair"), ("htow", 0, "smart"), ("htow", 3, "smart")]
        out = []
        for type_id, helpers, command in trials:
            dist = 1500 if type_id == "htow" else 1000
            try:
                out.append(self.assist_one(type_id, helpers, command, dist))
            except Exception as exc:
                self.log("error", trial=[type_id, helpers, command], error=repr(exc), trace=traceback.format_exc())
                out.append({"type_id": type_id, "helpers": helpers, "command": command, "error": repr(exc)})
            self.log("trial", **out[-1])
        return {"trials": out}

    def calm(self) -> None:
        """Lost Temple keeps its other slots as computer players: pause their AI and make ours
        invulnerable, or an enemy hero walks in after about five minutes."""
        others = [p["id"] for p in self.obs.get("players", []) if p.get("controller") == "computer"]
        for pid in others:
            try:
                self.debug("ai", player=pid, paused=1)
            except Exception as exc:
                self.log("ai_pause_failed", player=pid, error=str(exc))
        self.debug("invulnerable", player=0, on=1)
        self.log("players", players=self.obs.get("players", []))

    def run(self, sections) -> dict:
        self.calm()
        self.setup_home()
        self.clear_starting_workers()
        for name in sections:
            self.section = name
            wall = time.time()
            try:
                self.summary[name] = getattr(self, name)()
            except Exception as exc:
                self.log("error", error=repr(exc), trace=traceback.format_exc())
                self.summary[name] = {"error": repr(exc)}
            self.summary[name]["wall_seconds"] = round(time.time() - wall, 1)
            self.log("result", **self.summary[name])
        return self.summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default="probe-out", help="output folder (created)")
    ap.add_argument("--sections", default="militia,hero,upgrade,assist")
    ap.add_argument("--speed", type=float, default=32, help="game clock multiplier (debug speed)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--render", action="store_true", help="draw the game (needs a desktop session)")
    ap.add_argument("--window", choices=("background", "interactive"), default="background")
    args = ap.parse_args()

    from wc3env.session import GameConfig, GameSession, MatchSetup, PlayerConfig

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    config = GameConfig(map="(4)LostTemple.w3m", players=(PlayerConfig(0, "human"),), mode="stepping", step_ms=250,
                        window_mode=args.window, render=args.render, sound=False,
                        background_visible=args.render and args.window == "background", setup=MatchSetup(seed=args.seed))
    sections = [s for s in args.sections.split(",") if s]
    with GameSession(config) as session:
        session.reset()
        probe = Probe(session, out, args.speed)
        probe.log("info", info=session.game.rpc.info(), args=vars(args))
        summary = probe.run(sections)
        probe.logf.close()
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out / 'summary.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
