"""Turns the commander's timeline into wc3env orders and reads the results back.

The browser sends a plan: groups of events (build / gather / train) with planned start
times and, for buildings, a site chosen with the same placement rules as the offline
simulation. Each tick the engine reads one wc3env observation, starts due events, keeps
running jobs moving, and reports every event's status from what the game shows.

Rules kept from wc3env's contract: an accepted order proves nothing, so status changes
come from observations and events (construct_start/finish, train_start/finish); units
inside a mine cannot be ordered; Warcraft decides legality.
"""
from __future__ import annotations

import math

from .combat import Clear

HALLS = ("htow", "hkee", "hcas")
# Call to Arms for one peasant; to be confirmed by the native probe (tools/probe_orders.py)
MILITIA_ORDER = "militia"
MILITIA_SECONDS = 45
RES = {"gold": "采金", "wood": "伐木"}
ROLE_TEXT = {"gold": "采金", "wood": "伐木", "build": "建造"}
SITE_MATCH = 96          # a new structure this close to the expected point is the one we ordered
AUTO_PLACE_MATCH = 700   # fallback when an auto-placed site was never reported back


def dist(a, b) -> float:
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


class Commander:
    def __init__(self, data: dict):
        self.data = data
        self.eco = data["economy"]["units"]
        self.events: list[dict] = []
        self.rt: dict[str, dict] = {}
        self.cid: dict[int, int] = {}       # wc3env unit_id -> commander id (农民1, 农民2 ...)
        self.uid: dict[int, int] = {}       # commander id -> unit_id
        self.next_cid = 1
        self.roles: dict[int, str] = {}     # unit_id -> gold | wood | build
        self.jobs: dict[str, dict] = {}     # event id -> job state
        self.t0: float | None = None
        self.t = 0.0
        self.start_index: int | None = None
        self.hall = None
        self.mine = None
        self.mines: dict[int, dict] = {}         # gold mines seen so far, by unit_id
        self.natural_at: tuple | None = None     # map position of the natural expansion's mine
        self.mine_of: dict[int, str] = {}        # gold worker -> "main" | "natural"
        self.built_at: dict[int, float] = {}     # structure unit_id -> construct_start time
        self.train_at: dict[int, float] = {}     # producer unit_id -> train_start time
        self.last_order: dict[int, float] = {}
        self.log: list[tuple[str, str]] = []
        self.obs: dict | None = None

    # ---- plan --------------------------------------------------------------------------------
    def set_plan(self, plan: dict) -> None:
        events = [dict(e) for g in plan.get("groups", []) for e in g.get("children", [])]
        for e in events:
            self.rt.setdefault(e["id"], {"status": "pending", "aStart": None, "aEnd": None, "note": ""})
        keep = {e["id"] for e in events}
        for eid in list(self.rt):
            if eid not in keep and self.rt[eid]["status"] == "pending":
                del self.rt[eid]
        self.events = events

    # ---- per-tick ----------------------------------------------------------------------------
    def tick(self, obs: dict) -> list[dict]:
        self.obs = obs
        if self.t0 is None:
            self.t0 = obs["game_time_seconds"]
        self.t = round(obs["game_time_seconds"] - self.t0, 2)
        self.budget = [obs["player"]["gold"], obs["player"]["lumber"]]
        self.actions: list[dict] = []  # before _ingest: orders given while handling events must be kept
        self.ordered: set[int] = set()
        self._ingest(obs)
        due = sorted((e for e in self.events if self.rt[e["id"]]["status"] == "pending" and e["start"] <= self.t + 1e-6 and self.ready(e)),
                     key=lambda e: (e["start"], e.get("seq", 0)))
        for e in due:
            self._start(e)
        for e in sorted(self.events, key=lambda e: (e["start"], e.get("seq", 0))):
            if e["id"] in self.jobs:
                self._advance(e)
        self._keep_gathering()
        commandable = {u["unit_id"] for u in obs["units"]}
        return [a for a in self.actions if a["unit_id"] in commandable]

    def _ingest(self, obs: dict) -> None:
        own = [u for u in obs["units"] if not u["structure"]] + [dict(u, structure=False, _inside=True) for u in obs.get("inside", [])]
        if not self.cid:  # initial workers in a stable order become 农民1..5
            for u in sorted((u for u in own if u["type_id"] == "hpea"), key=lambda u: u["unit_id"]):
                self._map(u["unit_id"])
        if self.hall is None:
            halls = [u for u in obs["units"] if u["structure"] and u["type_id"] in HALLS]
            if halls:
                self.hall = halls[0]
                starts = self.data["starts"]
                self.start_index = min(range(len(starts)), key=lambda i: math.hypot(starts[i]["x"] - self.hall["x"], starts[i]["y"] - self.hall["y"]))
        for m in obs.get("visible_enemies", []):
            if m["type_id"] == "ngol":
                self.mines[m["unit_id"]] = m
        if self.hall and self.mines:
            self.mine = min(self.mines.values(), key=lambda m: dist(m, self.hall))
        if self.hall and self.natural_at is None:  # the closest other mine on the map is the natural
            spots = sorted(self.data["mines"], key=lambda m: math.hypot(m["x"] - self.hall["x"], m["y"] - self.hall["y"]))
            if len(spots) > 1:
                self.natural_at = (spots[1]["x"], spots[1]["y"])
        for ev in obs.get("events", []):
            k = ev["kind"]
            if k == "construct_start":
                self.built_at[ev["unit_id"]] = self.t
                self._bind_construction(ev)
            elif k == "construct_finish":
                self._finish_construction(ev)
            elif k == "train_start":
                self.train_at[ev["unit_id"]] = self.t
                self._bind_training(ev)
            elif k == "train_finish":
                self._map(ev["trained_id"])
                self._finish_training(ev)
            elif k == "upgrade_start":
                self._bind_upgrade(ev)
            elif k == "upgrade_finish":
                self._finish_upgrade(ev)
            elif k == "death":
                self.roles.pop(ev["unit_id"], None)
        for u in own:
            if u["unit_id"] not in self.cid:
                self._map(u["unit_id"])

    def _map(self, unit_id: int) -> int:
        if unit_id not in self.cid:
            self.cid[unit_id] = self.next_cid
            self.uid[self.next_cid] = unit_id
            self.next_cid += 1
        return self.cid[unit_id]

    # ---- helpers -----------------------------------------------------------------------------
    def units(self):
        return [u for u in self.obs["units"] if not u["structure"]]

    def structures(self, done=True):
        return [u for u in self.obs["units"] if u["structure"] and (not done or u.get("state") is None)]

    def unit(self, cid):
        uid = self.uid.get(cid)
        return next((u for u in self.obs["units"] if u["unit_id"] == uid), None)

    def inside(self, cid) -> bool:
        uid = self.uid.get(cid)
        return any(u["unit_id"] == uid for u in self.obs.get("inside", []))

    def order(self, unit_id, command, **arguments):
        self.actions.append({"unit_id": unit_id, "command": command, "arguments": arguments})
        self.ordered.add(unit_id)
        self.last_order[unit_id] = self.t

    def workers(self):
        return [u for u in self.units() if u["type_id"] == "hpea"]

    def ready(self, e) -> bool:
        """An event with "after" waits until that event is finished (built, trained, upgraded,
        cleared; gathering counts once it has begun). A deleted dependency no longer holds it back."""
        dep = e.get("after")
        if not dep:
            return True
        d = next((x for x in self.events if x["id"] == dep), None)
        rt = self.rt[e["id"]]
        if d is None:
            rt["note"] = "依赖的事件已删除，按时间开始"
            return True
        status = self.rt[dep]["status"]
        if self.rt[dep].get("failed"):
            rt["note"] = f"「{d['name']}」失败了，不会自动开始"
            return False
        if status == "done" or (d["kind"] == "gather" and status == "active"):
            return True
        rt["note"] = f"等「{d['name']}」完成"
        return False

    def reserved(self) -> set[int]:
        """Unit ids named by events that have not started: automatic picks leave them alone (a 0:00
        farm must not take peasant 3 just before the 0:01 barracks event calls for him)."""
        cids = set()
        for e in self.events:
            if self.rt[e["id"]]["status"] == "pending":
                cids.update([e["unit"]] if e.get("unit") else [])
                cids.update(e.get("units") or [])
        return {self.uid[c] for c in cids if c in self.uid}

    def pick_workers(self, n, res, where="main"):
        def score(u):  # idle first, then workers on the other resource or at the other mine
            role = self.roles.get(u["unit_id"])
            elsewhere = role != res or (res == "gold" and self.mine_of.get(u["unit_id"], "main") != where)
            return 0 if role is None else 1 if role in ("gold", "wood") and elsewhere else 9
        held = self.reserved()
        pool = [u for u in self.workers() if score(u) < 9 and u["unit_id"] not in self.ordered and u["unit_id"] not in held]
        return sorted(pool, key=lambda u: (score(u), self.cid[u["unit_id"]]))[:n]

    def pick_builder(self, site):
        held = self.reserved()
        pool = [u for u in self.workers() if self.roles.get(u["unit_id"]) != "build" and u["unit_id"] not in self.ordered and u["unit_id"] not in held]
        point = {"x": site[0], "y": site[1]}
        return min(pool, key=lambda u: (self.roles.get(u["unit_id"]) is not None, self.roles.get(u["unit_id"]) != "gold", dist(u, point)), default=None)

    def drop_for(self, res, near):
        opts = [b for b in self.obs["units"] if b["structure"] and b.get("state") != "constructing"  # an upgrading hall still takes returns
                and (b["type_id"] in HALLS or (res == "wood" and b["type_id"] == "hlum"))]
        return min(opts, key=lambda b: dist(b, near), default=self.hall)

    def natural(self):
        """The natural expansion's mine, once it has been seen."""
        if not self.natural_at:
            return None
        return next((m for m in self.mines.values() if math.hypot(m["x"] - self.natural_at[0], m["y"] - self.natural_at[1]) < 256), None)

    def harvest(self, u, res, where: str = "main") -> bool:
        if res == "gold":
            mine = self.natural() if where == "natural" else self.mine
            if not mine:
                return False
            self.order(u["unit_id"], "harvest", target_id=mine["unit_id"])
            self.mine_of[u["unit_id"]] = where
        else:
            drop = self.drop_for("wood", u) or u
            trees = [d for d in self.obs.get("destructables", []) if d.get("resource") == "lumber"]
            if not trees:
                return False
            tree = min(trees, key=lambda d: dist(d, drop))
            self.order(u["unit_id"], "harvest", target_id=tree["id"])
        self.roles[u["unit_id"]] = res
        return True

    def cost(self, ut, job=None):
        c = self.eco[ut]
        hero = ut[0].isupper()
        other_hero = any(j.get("hero") and j is not job and j["state"] in ("ordered", "training") for j in self.jobs.values())
        if hero and not any(u["hero"] for u in self.obs["units"]) and not other_hero and self.data["economy"]["assumptions"].get("first_hero_free"):
            return 0, 0, c["food"]
        return c["gold"], c["wood"], c["food"]

    def afford(self, g, w) -> bool:
        return self.budget[0] >= g and self.budget[1] >= w

    def spend(self, g, w):
        self.budget[0] -= g
        self.budget[1] -= w

    # ---- starting events ---------------------------------------------------------------------
    def _start(self, e):
        rt = self.rt[e["id"]]
        kind = e["kind"]
        if kind == "build" and e.get("resume"):
            site = {"x": e["at"][0], "y": e["at"][1]}
            b = min((s for s in self.structures(done=False) if s.get("state") == "constructing" and s["type_id"] == e["btype"]),
                    key=lambda s: dist(s, site), default=None)
            if not b:
                rt.update(status="done", aStart=self.t, aEnd=self.t, note="没有找到暂停的建筑")
                return
            u = self.unit(e["unit"]) if e.get("unit") else self.pick_builder(e["at"])
            if not u:
                rt["note"] = "没有可用农民"
                return
            self.order(u["unit_id"], "smart", target_id=b["unit_id"])
            self.roles[u["unit_id"]] = "build"
            rt.update(status="done", aStart=self.t, aEnd=self.t, note=f"农民{self.cid[u['unit_id']]} 去继续建造")
        elif kind == "build":
            if not e.get("site"):
                rt["note"] = "找不到可建造的位置"
                return
            u = self.unit(e["unit"]) if e.get("unit") else self.pick_builder(e["site"])
            if not u:
                rt["note"] = ("农民%s 在金矿里" % e["unit"]) if e.get("unit") and self.inside(e["unit"]) else "没有可用农民"
                return
            self.roles[u["unit_id"]] = "build"
            self.jobs[e["id"]] = {"state": "wait_res", "worker": u["unit_id"], "tries": 0}
            rt.update(status="running", aStart=self.t, builder=self.cid[u["unit_id"]], note="等待资源")
        elif kind == "gather":
            us = [self.unit(c) for c in e["units"]] if e.get("units") else self.pick_workers(e.get("count", 1), e["res"], e.get("mine", "main"))
            us = [u for u in us if u]
            if e.get("units") and not us:
                rt["note"] = "农民在金矿里，出来后再分配"
                return
            if not us:
                rt["note"] = "没有可分配的农民"
                return
            where = e.get("mine", "main")
            if e["res"] == "gold" and where == "natural" and not self.natural():
                rt["note"] = "还看不到分矿的金矿，稍后再派"
                return
            for u in us:
                self.harvest(u, e["res"], where)
            rt.update(status="active", aStart=self.t, note="农民" + "、".join(str(self.cid[u["unit_id"]]) for u in us) + " " + RES[e["res"]] + "中")
        elif kind == "train":
            ut = e.get("utype", "hpea")
            self.jobs[e["id"]] = {"state": "waiting", "producer": None, "hero": ut[0].isupper()}
            rt.update(status="waiting", aStart=self.t, note="排队中")
        elif kind == "upgrade":
            self.jobs[e["id"]] = {"state": "waiting", "producer": None}
            rt.update(status="waiting", aStart=self.t, note="排队中")
        elif kind == "learn":
            self.jobs[e["id"]] = {"state": "waiting"}
            rt.update(status="waiting", aStart=self.t, note="等英雄")
        elif kind == "militia":
            self._start_militia(e, rt)
        elif kind == "clear":
            self._start_clear(e, rt)

    # ---- advancing jobs ----------------------------------------------------------------------
    def _advance(self, e):
        job, rt = self.jobs[e["id"]], self.rt[e["id"]]
        if e["kind"] == "build":
            c = self.eco[e["btype"]]
            if job["state"] == "wait_res":
                worker = next((u for u in self.units() if u["unit_id"] == job["worker"]), None)
                if worker is None:
                    rt["note"] = "建造农民在金矿里或不在场"
                    if self.inside_uid(job["worker"]):
                        return
                    job["worker"] = (self.pick_builder(e["site"]) or {}).get("unit_id")
                    return
                if not self.afford(c["gold"], c["wood"]):
                    rt["note"] = f"等待资源 金{int(self.budget[0])}/{c['gold']} 木{int(self.budget[1])}/{c['wood']}"
                    return
                self.spend(c["gold"], c["wood"])
                exact = self.exact(e)
                # exact: build on the planned point or not at all; otherwise the site is only an anchor
                # for Warcraft's own search, which may move it several hundred units (see feedback()).
                args = dict(type_id=e["btype"], x=float(e["site"][0]), y=float(e["site"][1]))
                self.order(job["worker"], "build", **(args if exact else dict(args, auto_place=True)))
                job.update(state="ordered", ordered=self.t, tries=job["tries"] + 1, action=self.actions[-1], placed=None)
                rt["note"] = f"农民{self.cid[job['worker']]} 前往工地" + ("（指定位置）" if exact else "")
            elif job["state"] == "ordered" and self._site_changed(e, job):
                # the player moved the site (or pinned/unpinned it) after the order went out: order again
                job.update(state="wait_res", tries=max(0, job["tries"] - 1))
                rt["note"] = "工地位置改了，重新下令"
            elif job["state"] == "ordered":
                self.spend(c["gold"], c["wood"])  # keep the money aside until construction starts
                worker = next((u for u in self.units() if u["unit_id"] == job["worker"]), None)
                if worker and worker.get("order") is None and self.t - job["ordered"] > 1.5:
                    if job["tries"] >= 4:
                        rt.update(status="done", aEnd=self.t, note="建造失败：游戏没有接受（位置或资源）")
                        self.roles.pop(job["worker"], None)
                        del self.jobs[e["id"]]
                    else:
                        job["state"] = "wait_res"
                        rt["note"] = "游戏没有在指定位置开工，重试" if self.exact(e) else "游戏没有开工，重试"
            elif job["state"] == "constructing":
                b = next((s for s in self.obs["units"] if s["unit_id"] == job["building"]), None)
                if b is None:
                    rt.update(status="done", aEnd=self.t, note="建筑消失（被取消或摧毁）")
                    del self.jobs[e["id"]]
                    return
                start = self.built_at.get(b["unit_id"], self.t)
                pct = min(99, int((self.t - start) / max(1.0, b.get("state_seconds") or c["time"]) * 100))
                worker = next((u for u in self.units() if u["unit_id"] == job["worker"]), None)
                building = worker and worker.get("order") and worker["order"].get("target_id") == b["unit_id"]
                rt["note"] = f"建造中 {pct}%" if building or worker is None else f"可能暂停 {pct}%：农民没在建造"
        elif e["kind"] == "upgrade":
            self._advance_upgrade(e, job, rt)
        elif e["kind"] == "learn":
            self._advance_learn(e, job, rt)
        elif e["kind"] == "militia":
            self._advance_militia(e, job, rt)
        elif e["kind"] == "clear":
            self._advance_clear(e, job, rt)
        elif e["kind"] == "train":
            ut = e.get("utype", "hpea")
            if job["state"] == "waiting":
                missing = [r for r in self.eco[ut]["requires"] if not any(s["type_id"] == r for s in self.structures())]
                if missing:
                    rt["note"] = "需要 " + "、".join(self.eco[r]["name"] if r in self.eco else r for r in missing)
                    return
                prods = [s for s in self.structures() if ut in (self.eco.get(s["type_id"], {}).get("trains") or []) and not s.get("queue")
                         and not any(j.get("producer") == s["unit_id"] for j in self.jobs.values() if j is not job)]
                if not prods:
                    rt["note"] = "等待空闲的" + ("生产建筑" if not self.structures() else self._producer_name(ut))
                    return
                g, w, f = self.cost(ut, job)
                p = self.obs["player"]
                if p["food_used"] + f > p["food_cap"]:
                    rt["note"] = f"人口不足 {p['food_used']}/{p['food_cap']}"
                    return
                if not self.afford(g, w):
                    rt["note"] = f"等待资源 金{int(self.budget[0])}/{g}" + (f" 木{int(self.budget[1])}/{w}" if w else "")
                    return
                self.spend(g, w)
                prod = prods[0]
                self.order(prod["unit_id"], "train", type_id=ut)
                job.update(state="ordered", producer=prod["unit_id"], ordered=self.t)
                rt.update(note="已下令 · " + self.eco[prod["type_id"]]["name"])
            elif job["state"] == "ordered" and self.t - job["ordered"] > 3:
                prod = next((s for s in self.obs["units"] if s["unit_id"] == job["producer"]), None)
                if not prod or not prod.get("queue"):
                    job.update(state="waiting", producer=None)
                    rt["note"] = "游戏没有开始训练，重试"
            elif job["state"] == "training":
                left = (self.eco[ut]["time"]) - (self.t - job["started"])
                rt["note"] = f"训练中 {max(0, math.ceil(left))}秒"

    def inside_uid(self, uid) -> bool:
        return any(u["unit_id"] == uid for u in self.obs.get("inside", []))

    def _producer_name(self, ut):
        names = [self.eco[k]["name"] for k, v in self.eco.items() if ut in (v.get("trains") or [])]
        return names[0] if names else "生产建筑"

    def _bind_construction(self, ev):
        """Claim a new structure for the build job that caused it.

        Strongest evidence first: the job's worker is ordered onto this structure; then the site
        Warcraft reported choosing (feedback); then the planned point. Only when an auto-placed
        build has no reported site is the old wide radius used, because the game may move it.
        """
        b = next((u for u in self.obs["units"] if u["unit_id"] == ev["unit_id"]), None)
        best = None
        for e in self.events:
            job = self.jobs.get(e["id"])
            if not (job and e["kind"] == "build" and job["state"] == "ordered" and e["btype"] == ev["type_id"]):
                continue
            worker = next((u for u in self.units() if u["unit_id"] == job["worker"]), None)
            if worker and (worker.get("order") or {}).get("target_id") == ev["unit_id"]:
                best = (-1.0, e)
                break
            if b is None:
                continue
            point, radius = (job["placed"], SITE_MATCH) if job.get("placed") else (e["site"], SITE_MATCH if self.exact(e) else AUTO_PLACE_MATCH)
            d = math.hypot(b["x"] - point[0], b["y"] - point[1])
            if d <= radius and (best is None or d < best[0]):
                best = (d, e)
        if best is None:
            return
        e = best[1]
        self.jobs[e["id"]].update(state="constructing", building=ev["unit_id"])
        self.rt[e["id"]].update(bStart=self.t, bid="u%d" % ev["unit_id"], note="建造中 0%")
        if b is not None:
            self.rt[e["id"]]["builtAt"] = [b["x"], b["y"]]
        if e.get("helpers") and b is not None:
            self._send_helpers(e, self.jobs[e["id"]], b)

    def _send_helpers(self, e, job, b):
        """Power build: e["helpers"] more peasants join a started construction (right-click on it).
        Warcraft charges the extra cost while they build."""
        held = self.reserved() | {job["worker"]}
        pool = [u for u in self.workers() if self.roles.get(u["unit_id"]) in ("gold", "wood") and u["unit_id"] not in held and u["unit_id"] not in self.ordered]
        job["helpers"] = []
        for u in sorted(pool, key=lambda u: dist(u, b))[: e["helpers"]]:
            self.order(u["unit_id"], "smart", target_id=b["unit_id"])
            self.roles[u["unit_id"]] = "build"
            job["helpers"].append(u["unit_id"])

    def _site_changed(self, e, job) -> bool:
        a = (job.get("action") or {}).get("arguments") or {}
        if "x" not in a:
            return False
        return (a["x"], a["y"]) != (float(e["site"][0]), float(e["site"][1])) or ("auto_place" in a) == self.exact(e)

    @staticmethod
    def exact(e) -> bool:
        """A site the player placed (or a plan marked exact) is built on that point, never moved."""
        return bool(e.get("exact", e.get("at") is not None and not e.get("resume")))

    def feedback(self, actions: list[dict], placements: list[dict], rejected: list[dict]) -> None:
        """Read the reply to the actions tick() returned: where Warcraft placed auto-placed builds
        and which build orders it refused outright."""
        jobs = {id(j["action"]): (eid, j) for eid, j in self.jobs.items() if j.get("action") is not None}
        for p in placements:
            hit = jobs.get(id(actions[p["index"]])) if 0 <= p["index"] < len(actions) else None
            if hit:
                eid, job = hit
                job["placed"] = (p["x"], p["y"])
                self.rt[eid]["placed"] = [p["x"], p["y"]]
        for r in rejected:
            hit = jobs.get(id(actions[r["index"]])) if 0 <= r["index"] < len(actions) else None
            if not hit or hit[1]["state"] != "ordered":
                continue
            eid, job = hit
            e = next((e for e in self.events if e["id"] == eid), None)
            if e is None or e["kind"] != "build":
                continue
            where = "指定位置" if self.exact(e) else "附近"
            if job["tries"] >= 4:
                self.rt[eid].update(status="done", aEnd=self.t, note=f"建造失败：游戏拒绝在{where}建造（{r['reason']}）")
                self.roles.pop(job["worker"], None)
                del self.jobs[eid]
            else:
                job["state"] = "wait_res"
                self.rt[eid]["note"] = f"游戏拒绝在{where}建造（{r['reason']}），重试"

    def _finish_construction(self, ev):
        for e in self.events:
            job = self.jobs.get(e["id"])
            if job and job.get("building") == ev["unit_id"]:
                self.rt[e["id"]].update(status="done", aEnd=self.t, note="完工")
                where = "natural" if e.get("then") == "natural" else "main"
                for uid in [job["worker"], *job.get("helpers", [])]:  # builders go back to work: then = natural | wood | main gold
                    self.roles.pop(uid, None)
                    worker = next((u for u in self.obs["units"] if u["unit_id"] == uid), None)
                    if worker and e.get("then") == "wood":
                        self.harvest(worker, "wood")
                    elif worker and not self.harvest(worker, "gold", where):
                        self.harvest(worker, "gold")
                del self.jobs[e["id"]]
                return

    # ---- upgrades (town hall -> keep, scout tower -> arcane tower ...) ---------------------------
    # Warcraft takes the upgrade as a train order with the target type; it occupies the building,
    # costs the price difference, and reports upgrade_start/finish for the structure.
    def _advance_upgrade(self, e, job, rt):
        to = e["to"]
        if job["state"] == "waiting":
            busy = {j.get("producer") for j in self.jobs.values() if j is not job}
            opts = [s for s in self.structures() if to in (self.eco.get(s["type_id"], {}).get("upgrades") or [])
                    and (not e.get("from") or s["type_id"] == e["from"]) and not s.get("queue") and s["unit_id"] not in busy]
            if e.get("at"):
                opts = [s for s in opts if math.hypot(s["x"] - e["at"][0], s["y"] - e["at"][1]) < 64]
            if not opts:
                rt["note"] = "等待空闲的可升级建筑"
                return
            missing = [r for r in self.eco[to]["requires"] if not any(s["type_id"] == r for s in self.structures())]
            if missing:
                rt["note"] = "需要 " + "、".join(self.eco[r]["name"] if r in self.eco else r for r in missing)
                return
            b = opts[0]
            g, w = self.eco[to]["gold"] - self.eco[b["type_id"]]["gold"], self.eco[to]["wood"] - self.eco[b["type_id"]]["wood"]
            if not self.afford(g, w):
                rt["note"] = f"等待资源 金{int(self.budget[0])}/{g} 木{int(self.budget[1])}/{w}"
                return
            self.spend(g, w)
            self.order(b["unit_id"], "train", type_id=to)
            job.update(state="ordered", producer=b["unit_id"], ordered=self.t)
            rt["note"] = "已下令 · " + self.eco[b["type_id"]]["name"]
        elif job["state"] == "ordered" and self.t - job["ordered"] > 3:
            job.update(state="waiting", producer=None)
            rt["note"] = "游戏没有开始升级，重试"
        elif job["state"] == "upgrading":
            left = self.eco[to]["time"] - (self.t - job["started"])
            rt["note"] = f"升级中 {max(0, math.ceil(left))}秒"

    # ---- hero skills -----------------------------------------------------------------------------
    def _advance_learn(self, e, job, rt):
        hero = next((u for u in self.units() if u["type_id"] == e.get("hero", "Hamg")), None)
        if hero is None:
            rt["note"] = "等" + self.eco.get(e.get("hero", "Hamg"), {}).get("name", "英雄") + "出生"
            return
        if any(a.get("ability_id") == e["ability"] and a.get("level", 0) > 0 for a in hero.get("abilities") or []):
            rt.update(status="done", aEnd=self.t, note="学会 " + e.get("abilityName", e["ability"]))
            del self.jobs[e["id"]]
            return
        if job["state"] == "waiting" or self.t - job.get("ordered", 0) > 3:
            self.order(hero["unit_id"], "learn", ability_id=e["ability"])
            job.update(state="ordered", ordered=self.t)
            rt["note"] = "已下令学 " + e.get("abilityName", e["ability"])

    # ---- militia (Call to Arms) -------------------------------------------------------------------
    def _start_militia(self, e, rt):
        held = self.reserved()
        pool = [u for u in self.workers() if self.roles.get(u["unit_id"]) in ("gold", "wood") and u["unit_id"] not in held and u["unit_id"] not in self.ordered]
        pool.sort(key=lambda u: (self.roles.get(u["unit_id"]) != e.get("from", "wood"), self.cid[u["unit_id"]]))
        us = pool[: e.get("count", 4)]
        if not us:
            rt["note"] = "没有能敲钟的农民"
            return
        job = {"units": {}, "seen": set(), "reverted": {}}
        for u in us:
            job["units"][u["unit_id"]] = self.roles.get(u["unit_id"])
            self.roles[u["unit_id"]] = "militia"
            self.order(u["unit_id"], "cast", order=MILITIA_ORDER)
        self.jobs[e["id"]] = job
        rt.update(status="active", aStart=self.t, note="敲钟：农民" + "、".join(str(self.cid[u["unit_id"]]) for u in us), militia=[self.cid[u["unit_id"]] for u in us])

    def _advance_militia(self, e, job, rt):
        here = {u["unit_id"]: u for u in self.units()}
        for uid, prev in job["units"].items():
            u = here.get(uid)
            if u and u["type_id"] == "hmil":
                job["seen"].add(uid)
            elif u and uid in job["seen"] and uid not in job["reverted"]:  # a peasant again: free a moment for a builder
                job["reverted"][uid] = self.t
                if self.roles.get(uid) == "militia":
                    self.roles.pop(uid, None)
            elif uid in job["reverted"] and self.t - job["reverted"][uid] >= 3 and uid not in self.roles and u:
                self.harvest(u, prev or "gold", self.mine_of.get(uid, "main"))  # nobody needed him: old job
        if not job["seen"] and self.t - rt["aStart"] > 3:
            rt["note"] = "游戏没有把农民变成民兵（命令可能不对）"
        elif job["seen"]:
            rt["note"] = f"民兵 {len(job['seen']) - len(job['reverted'])} 个"
        if len(job["reverted"]) == len(job["units"]) and all(self.t - t >= 3 for t in job["reverted"].values()) or self.t - rt["aStart"] > MILITIA_SECONDS + 30:
            rt.update(status="done", aEnd=self.t, note="民兵已变回农民")
            for uid in job["units"]:
                if self.roles.get(uid) == "militia":
                    self.roles.pop(uid, None)
            del self.jobs[e["id"]]

    # ---- clearing a creep camp (combat.Clear) ----------------------------------------------------
    def _start_clear(self, e, rt):
        if not self.natural_at or not self.hall:
            rt["note"] = "还不知道分矿在哪"
            return
        heroes = [u for u in self.units() if u.get("hero")]
        if not heroes:
            rt["note"] = "等英雄出生"
            return
        mjob = self.jobs.get(e.get("militia") or "")
        if e.get("militia") and self.rt.get(e["militia"], {}).get("status") == "pending":
            rt["note"] = "等民兵事件开始"
            return
        if mjob and len(mjob["seen"]) < len(mjob["units"]) and self.t - self.rt[e["militia"]]["aStart"] < 20:
            rt["note"] = "等民兵在城镇大厅变身"  # peasants walk to the hall before they change (native probe)
            return
        mil = mjob["units"] if mjob else {}
        members = [u["unit_id"] for u in self.units() if u.get("hero") or u["type_id"] == "hfoo" or (u["type_id"] == "hmil" and (not mil or u["unit_id"] in mil))]
        self.jobs[e["id"]] = {"clear": Clear(self.natural_at, (self.hall["x"], self.hall["y"]), members, self.t)}
        rt.update(status="running", aStart=self.t, note="部队前往分矿", army=[self.cid.get(m, 0) for m in members])

    def _advance_clear(self, e, job, rt):
        c = job["clear"]
        c.tick(self, self.obs, self.t)
        rt["note"] = c.note
        if c.result:
            rt.update(status="done", aEnd=self.t, failed=c.result != "done")
            del self.jobs[e["id"]]

    def _bind_upgrade(self, ev):
        for e in self.events:
            job = self.jobs.get(e["id"])
            if job and e["kind"] == "upgrade" and job["state"] == "ordered" and job["producer"] == ev["unit_id"]:
                job.update(state="upgrading", started=self.t)
                self.rt[e["id"]].update(status="running", trainStart=self.t, note="升级中")
                return

    def _finish_upgrade(self, ev):
        for e in self.events:
            job = self.jobs.get(e["id"])
            if job and e["kind"] == "upgrade" and job.get("producer") == ev["unit_id"] and job["state"] == "upgrading":
                self.rt[e["id"]].update(status="done", aEnd=self.t, note="升级为" + self.eco[e["to"]]["name"])
                del self.jobs[e["id"]]
                return

    def _bind_training(self, ev):
        for e in self.events:
            job = self.jobs.get(e["id"])
            if job and e["kind"] == "train" and job["state"] == "ordered" and job["producer"] == ev["unit_id"] and e.get("utype", "hpea") == ev["type_id"]:
                job.update(state="training", started=self.t)
                self.rt[e["id"]].update(status="running", trainStart=self.t, note="训练中")
                return

    def _finish_training(self, ev):
        for e in self.events:
            job = self.jobs.get(e["id"])
            if job and e["kind"] == "train" and job["state"] == "training" and job["producer"] == ev["unit_id"]:
                cid = self.cid[ev["trained_id"]]
                then = e.get("then") or "gold"
                name = self.eco[ev["type_id"]]["name"]
                self.rt[e["id"]].update(status="done", aEnd=self.t, note=f"{name}{cid} 出生" + (f" → {'分矿采金' if then == 'natural' else RES[then]}" if ev["type_id"] == "hpea" else ""))
                if ev["type_id"] == "hpea":
                    self.roles[ev["trained_id"]] = "gold" if then == "natural" else then  # ordered once it is observed on the map
                    if then == "natural":
                        self.mine_of[ev["trained_id"]] = "natural"
                    self.last_order.pop(ev["trained_id"], None)
                del self.jobs[e["id"]]
                return

    def _keep_gathering(self):
        """Workers with a gathering role that stopped (tree gone, just trained) go back to work."""
        for u in self.workers():
            role = self.roles.get(u["unit_id"])
            if role in ("gold", "wood") and u.get("order") is None and u["unit_id"] not in self.ordered:
                if self.t - self.last_order.get(u["unit_id"], -99) >= 2:
                    self.harvest(u, role, self.mine_of.get(u["unit_id"], "main"))

    # ---- state for the browser ---------------------------------------------------------------
    def snapshot(self) -> dict:
        o = self.obs
        if o is None:
            return {"t": 0, "gold": 0, "wood": 0, "foodUsed": 0, "foodCap": 0, "units": [], "buildings": [], "events": self.rt}
        units = []
        for u in self.units() + [dict(x, _inside=True) for x in o.get("inside", [])]:
            role = self.roles.get(u["unit_id"])
            order = u.get("order") or {}
            name = order.get("name")
            if u.get("_inside"):
                task = "矿内"
            elif name in self.eco:
                task = "前往建造 " + self.eco[name]["name"]
            elif name == "repair":
                task = "正在建造"
            elif name in ("harvest", "returnresources"):
                task = ROLE_TEXT.get(role, "采集") + (" · 运回" if name == "returnresources" else "")
            elif name:
                task = name
            else:
                task = "空闲"
            units.append({"id": self.cid.get(u["unit_id"], 0), "type": u["type_id"], "x": u["x"], "y": u["y"],
                          "hidden": bool(u.get("_inside")), "task": task, "role": role or "idle", "carry": None, "amt": 0})
        buildings = []
        for s in o["units"]:
            if not s["structure"]:
                continue
            constructing = s.get("state") == "constructing"
            start = self.built_at.get(s["unit_id"])
            progress = 1.0 if not constructing else (min(0.99, (self.t - start) / max(1.0, s.get("state_seconds") or 1)) if start is not None else 0.0)
            train = None
            if s.get("queue"):
                total = s.get("queue_seconds") or 0
                began = self.train_at.get(s["unit_id"], self.t)
                train = {"name": self.eco.get(s["queue"][0], {}).get("name", s["queue"][0]), "left": max(0, total - (self.t - began)), "total": total, "queue": len(s["queue"]) - 1}
            buildings.append({"id": "u%d" % s["unit_id"], "type": s["type_id"], "x": s["x"], "y": s["y"], "done": not constructing, "progress": progress, "train": train})
        p = o["player"]
        return {
            "t": self.t, "start": self.start_index, "gold": p["gold"], "wood": p["lumber"], "foodUsed": p["food_used"], "foodCap": p["food_cap"],
            "units": units, "buildings": buildings,
            "mine": {"x": self.mine["x"], "y": self.mine["y"], "gold": -1} if self.mine else None,
            "events": self.rt,
        }
