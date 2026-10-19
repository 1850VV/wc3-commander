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

HALLS = ("htow", "hkee", "hcas")
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
        self._ingest(obs)
        self.budget = [obs["player"]["gold"], obs["player"]["lumber"]]
        self.actions: list[dict] = []
        self.ordered: set[int] = set()
        due = sorted((e for e in self.events if self.rt[e["id"]]["status"] == "pending" and e["start"] <= self.t + 1e-6),
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
        mines = [u for u in obs.get("visible_enemies", []) if u["type_id"] == "ngol"]
        if self.hall and mines:
            self.mine = min(mines, key=lambda m: dist(m, self.hall))
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

    def reserved(self) -> set[int]:
        """Unit ids named by events that have not started: automatic picks leave them alone (a 0:00
        farm must not take peasant 3 just before the 0:01 barracks event calls for him)."""
        cids = set()
        for e in self.events:
            if self.rt[e["id"]]["status"] == "pending":
                cids.update([e["unit"]] if e.get("unit") else [])
                cids.update(e.get("units") or [])
        return {self.uid[c] for c in cids if c in self.uid}

    def pick_workers(self, n, res):
        def score(u):
            role = self.roles.get(u["unit_id"])
            return 0 if role is None else 1 if role in ("gold", "wood") and role != res else 9
        held = self.reserved()
        pool = [u for u in self.workers() if score(u) < 9 and u["unit_id"] not in self.ordered and u["unit_id"] not in held]
        return sorted(pool, key=lambda u: (score(u), self.cid[u["unit_id"]]))[:n]

    def pick_builder(self, site):
        held = self.reserved()
        pool = [u for u in self.workers() if self.roles.get(u["unit_id"]) != "build" and u["unit_id"] not in self.ordered and u["unit_id"] not in held]
        point = {"x": site[0], "y": site[1]}
        return min(pool, key=lambda u: (self.roles.get(u["unit_id"]) is not None, self.roles.get(u["unit_id"]) != "gold", dist(u, point)), default=None)

    def drop_for(self, res, near):
        opts = [b for b in self.structures() if b["type_id"] in HALLS or (res == "wood" and b["type_id"] == "hlum")]
        return min(opts, key=lambda b: dist(b, near), default=self.hall)

    def harvest(self, u, res) -> bool:
        if res == "gold":
            if not self.mine:
                return False
            self.order(u["unit_id"], "harvest", target_id=self.mine["unit_id"])
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
            us = [self.unit(c) for c in e["units"]] if e.get("units") else self.pick_workers(e.get("count", 1), e["res"])
            us = [u for u in us if u]
            if e.get("units") and not us:
                rt["note"] = "农民在金矿里，出来后再分配"
                return
            if not us:
                rt["note"] = "没有可分配的农民"
                return
            for u in us:
                self.harvest(u, e["res"])
            rt.update(status="active", aStart=self.t, note="农民" + "、".join(str(self.cid[u["unit_id"]]) for u in us) + " " + RES[e["res"]] + "中")
        elif kind == "train":
            ut = e.get("utype", "hpea")
            self.jobs[e["id"]] = {"state": "waiting", "producer": None, "hero": ut[0].isupper()}
            rt.update(status="waiting", aStart=self.t, note="排队中")

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
                worker = next((u for u in self.obs["units"] if u["unit_id"] == job["worker"]), None)
                self.roles.pop(job["worker"], None)
                if worker:
                    self.harvest(worker, "gold")
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
                self.rt[e["id"]].update(status="done", aEnd=self.t, note=f"{name}{cid} 出生" + (f" → {RES[then]}" if ev["type_id"] == "hpea" else ""))
                if ev["type_id"] == "hpea":
                    self.roles[ev["trained_id"]] = then  # ordered once it is observed on the map
                    self.last_order.pop(ev["trained_id"], None)
                del self.jobs[e["id"]]
                return

    def _keep_gathering(self):
        """Workers with a gathering role that stopped (tree gone, just trained) go back to work."""
        for u in self.workers():
            role = self.roles.get(u["unit_id"])
            if role in ("gold", "wood") and u.get("order") is None and u["unit_id"] not in self.ordered:
                if self.t - self.last_order.get(u["unit_id"], -99) >= 2:
                    self.harvest(u, role)

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
