"""Play a tactic script (script.py): every peasant's life and every building's queue, as written.

No automatic worker balance, no automatic peasants or farms, no footmen up to a cap: only what the
script says, each step waiting for its condition and its money. Lanes earlier in the file spend
first; 留钱 holds money with the A10 rule (spend what does not make the held item later).

Kept, because they are about the game rather than the tactic, and recorded when they act:
orders never go to a unit inside a mine; a builder waits beside the site (T3); a lumberjack whose
tree is gone or out of reach gets another nearby (T2); a builder who stops is sent back (T3).

Peasants are numbered as the script numbers them (农民1-5 at the start, the rest as the script trains
them); other units get 101 and up, so a hero never takes a peasant's number. The decision record
uses rule "L<line>" and the timeline groups events by lane (农民8, 城镇大厅, ...).
"""
from __future__ import annotations

import math
import re

from .arbiter import Arbiter
from .engine import Commander
from .combat import Clear
from .engine import HALLS, MILITIA_ORDER, dist
from .orchestration import NAMES
from .script import parse

HERO_TIME = 55.0
QUEUE_LEAD = 1.0  # the next unit in a building's lane is ordered this long before the current one comes out
PEASANT_SPEED, MILITIA_SPEED, CALL_TO_ARMS = 190.0, 270.0, 2.0
ONGOING = ("采金", "伐木", "集合", "待命")


class ScriptRunner(Arbiter):
    def __init__(self, data: dict):
        super().__init__(data)
        self.model: dict = {}
        self.errors: list[str] = []
        self.lanes: list[dict] = []
        self.reserves: list[dict] = []
        self.tags: dict[str, str] = {}          # 名字 -> the event that builds/upgrades it
        self.tag_prio: dict[str, int] = {}
        self._pos: dict[str, dict] = {}
        self.clear: dict | None = None
        self._next_other = 101
        self.auto_rally = False

    # ---- plan --------------------------------------------------------------------------------
    def set_plan(self, plan: dict) -> None:
        super().set_plan(plan)  # the layout's sites
        self.model, self.errors = parse(plan.get("script") or "")
        self.lanes, self.reserves = [], []
        for ln in self.model.get("lanes", []):
            prio = 100000 - ln["line"] * 10
            base = {"line": ln["line"], "prio": prio, "steps": ln["steps"], "i": 0, "on": False, "done": False, "dead": False}
            if ln["kind"] == "peasant":
                for c in ln["cids"]:
                    self.lanes.append(dict(base, kind="peasant", cid=c, label=f"农民{c}", steps=[dict(s) for s in ln["steps"]]))
            elif ln["kind"] == "hero":
                self.lanes.append(dict(base, kind="hero", hero=ln["hero"], label=self.eco[ln["hero"]]["name"]))
            else:
                label = "#" + ln["tag"] if ln.get("tag") else self.eco[ln["btype"]]["name"]
                self.lanes.append(dict(base, kind="building", btype=ln.get("btype"), tag=ln.get("tag"), label=label, made=0))
            for st in ln["steps"]:
                if st.get("tag"):
                    self.tag_prio[st["tag"]] = prio
        for r in self.model.get("reserves", []):
            self.reserves.append(dict(r, on=False, off=False))

    # ---- numbering: the script's peasant numbers ---------------------------------------------
    def _map(self, unit_id: int) -> int:
        if unit_id not in self.cid:
            self.cid[unit_id] = self._next_other
            self.uid[self._next_other] = unit_id
            self._next_other += 1
        return self.cid[unit_id]

    def _ingest(self, obs: dict) -> None:
        if not self.cid:  # the five starting peasants are 农民1-5
            for n, u in enumerate(sorted((u for u in obs["units"] if u["type_id"] == "hpea"), key=lambda u: u["unit_id"]), 1):
                self.cid[u["unit_id"]], self.uid[n] = n, u["unit_id"]
        for ev in obs.get("events", []):  # a scripted peasant gets his number the moment he is trained
            if ev.get("kind") == "train_finish" and ev.get("type_id") == "hpea":
                for e in self.events:
                    job = self.jobs.get(e["id"])
                    if job and e.get("as_cid") and job.get("state") == "training" and job.get("producer") == ev["unit_id"]:
                        self.cid[ev["trained_id"]], self.uid[e["as_cid"]] = e["as_cid"], ev["trained_id"]
                        break
        super()._ingest(obs)

    # ---- no balancing: the script decides every job -------------------------------------------
    def _balance_workers(self) -> None:
        pass

    def _keep_gathering(self) -> None:
        pass  # a gatherer who stops is sent back by his own lane (_p_keep), under its line

    def harvest(self, u, res, where: str = "main") -> bool:
        return Commander.harvest(self, u, res, where)  # the lane's own line says why; no A1-A3 notes

    # ---- events --------------------------------------------------------------------------------
    def _emit(self, L, step, kind, name, **fields) -> dict:
        e = self._add("L%d" % L["line"], kind, name, f"第 {L['line']} 行 {L['label']}：{step['raw']}", **fields)
        e.update(prio=L["prio"], phase=L["label"], row=L["line"])
        step.setdefault("_events", []).append(e["id"])
        if step.get("tag") and kind in ("build", "upgrade"):
            self.tags[step["tag"]] = e["id"]
        return e

    def _evs(self, step):
        return [self.rt[i] for i in step.get("_events", [])]

    # ---- positions -----------------------------------------------------------------------------
    def pos(self, name):
        if name in self._pos:
            return self._pos[name]
        expr = next((p["expr"] for p in self.model.get("positions", []) if p["name"] == name), None)
        p = self._resolve(expr) if expr else None
        if p:
            self._pos[name] = p
        return p

    def _resolve(self, expr):
        e = expr.replace(" ", "")
        if m := re.fullmatch(r"布局\.(\D+?)(\d*)", e):
            pool = self.sites.get(NAMES.get(m[1], ""), [])
            i = int(m[2] or 1) - 1
            return {"x": pool[i]["site"][0], "y": pool[i]["site"][1], "exact": pool[i]["at"]} if i < len(pool) else None
        if m := re.fullmatch(r"分矿\.(\D+)", e):
            pool = self.sites.get("natural:" + NAMES.get(m[1], ""), [])
            return {"x": pool[0]["site"][0], "y": pool[0]["site"][1], "exact": pool[0]["at"], "near": "natural"} if pool else None
        if e == "本方向分矿":
            p = self.crew_post()
            return {"x": p[0], "y": p[1], "exact": False, "near": "natural"} if p else None
        if m := re.fullmatch(r"分矿后方(\d+)", e):
            if not self.natural_at:
                return None
            hall = (self.sites.get("natural:htow") or [{}])[0].get("site") or list(self.natural_at)
            mine = {"x": self.natural_at[0], "y": self.natural_at[1]}
            x, y = self._toward(mine, {"x": hall[0], "y": hall[1]}, dist(mine, {"x": hall[0], "y": hall[1]}) + int(m[1]))
            return {"x": x, "y": y, "exact": False, "near": "natural"}
        if m := re.fullmatch(r"(\S+?)前方(\d+)", e):
            base = self.pos(m[1])
            return self._open_ground(base, int(m[2])) if base else None
        if m := re.fullmatch(r"坐标(-?\d+)[,，](-?\d+)", e):
            return {"x": int(m[1]), "y": int(m[2]), "exact": True}
        if e == "自动":
            return {"x": self.hall["x"], "y": self.hall["y"], "exact": False}
        return None

    def _auto_site(self, btype):
        """@自动: the layout's next site of this kind that no named position and no earlier build took,
        else beside the town hall and the game finds room (auto_place)."""
        used = {tuple(e["site"]) for e in self.events if e["kind"] == "build" and e.get("site")}
        used |= {(p["x"], p["y"]) for p in self._pos.values() if p}
        named = {(m[1], int(m[2] or 1)) for q in self.model.get("positions", [])
                 if (m := re.fullmatch(r"布局\.(\D+?)(\d*)", q["expr"].replace(" ", "")))}
        for i, x in enumerate(self.sites.get(btype, []), 1):
            if tuple(x["site"]) not in used and not any(NAMES.get(n) == btype and k == i for n, k in named):
                return {"x": x["site"][0], "y": x["site"][1], "exact": x["at"]}
        return {"x": self.hall["x"], "y": self.hall["y"], "exact": False}

    def _open_ground(self, base, r0):
        """In front of a building (towards the town hall), clear of every building and layout site."""
        taken = [(s["x"], s["y"]) for s in self.structures(done=False)] + [tuple(x["site"]) for pool in self.sites.values() for x in pool]
        ang0 = math.atan2(self.hall["y"] - base["y"], self.hall["x"] - base["x"])
        for r in (r0, r0 + 80, r0 + 160, r0 + 240, r0 + 320):
            for a in (0, 25, -25, 50, -50, 75, -75):
                p = (base["x"] + math.cos(ang0 + math.radians(a)) * r, base["y"] + math.sin(ang0 + math.radians(a)) * r)
                if min((math.hypot(p[0] - x, p[1] - y) for x, y in taken), default=9999) >= 260:
                    return {"x": round(p[0]), "y": round(p[1]), "exact": False}
        x, y = self._toward(base, self.hall, r0)
        return {"x": x, "y": y, "exact": False}

    # ---- conditions ----------------------------------------------------------------------------
    def _tag_rt(self, tag):
        eid = self.tags.get(tag)
        return self.rt.get(eid, {}) if eid else {}

    def _tag_started(self, tag):
        r = self._tag_rt(tag)
        return bool(r.get("bid") or r.get("trainStart") is not None or r.get("status") == "done")

    def _hero_eta(self):
        if any(u["type_id"] == "Hamg" for u in self.units()):
            return self.t
        for e in self.events:
            r = self.rt[e["id"]]
            if e.get("utype") == "Hamg" and r.get("trainStart") is not None:
                total = next((b["queue_seconds"] for b in self._have("halt") if (b.get("queue") or [])[:1] == ["Hamg"] and b.get("queue_seconds")), HERO_TIME)
                return r["trainStart"] + total
        return None

    def _call_lead(self):
        """Seconds from the call to arms to the militia at their gathering point: the farthest caller
        to the hall, the change, the walk to the place their next step names (the altar's front)."""
        callers, gather = [], None
        for L in self.lanes:
            if L["kind"] != "peasant" or L["done"] or L["dead"]:
                continue
            i = L["i"] + (1 if L["on"] else 0)
            if i < len(L["steps"]) and L["steps"][i]["act"] == "敲钟":
                u = self._unit(L)
                if u:
                    callers.append(u)
                nxt = L["steps"][i + 1] if i + 1 < len(L["steps"]) else None
                if nxt and nxt.get("pos"):
                    gather = self.pos(nxt["pos"])
        if not callers:
            return None
        gather = gather or next(iter(self._have("halt")), None) or self.hall
        return max(dist(u, self.hall) for u in callers) / PEASANT_SPEED + CALL_TO_ARMS + dist(self.hall, gather) / MILITIA_SPEED

    def holds(self, conds) -> bool:
        p = self.obs["player"]
        for c in conds:
            k = c["kind"]
            if k == "time" and self.t < c["t"]:
                return False
            if k == "gold" and self.budget[0] < c["n"]:
                return False
            if k == "wood" and self.budget[1] < c["n"]:
                return False
            if k == "tag_started" and not self._tag_started(c["tag"]):
                return False
            if k == "tag_done" and self._tag_rt(c["tag"]).get("status") != "done":
                return False
            if k == "hero_born" and not any(u["type_id"] == c["hero"] for u in self.units()):
                return False
            if k == "clear_done" and not (self.clear and self.clear.get("result")):
                return False
            if k == "food_left" and p["food_cap"] - p["food_used"] > c["n"]:
                return False
            if k == "hero_eta":
                eta, lead = self._hero_eta(), self._call_lead()
                if eta is None or lead is None or self.t < eta - lead - 2.0:
                    return False
                self._last_eta = (max(0, eta - self.t), lead)
        return True

    # ---- the lanes, every tick ----------------------------------------------------------------------
    def _decide(self) -> None:
        self._track_income()
        if self.errors or not self.hall:
            return
        for r in self.reserves:
            if not r["on"] and not r["off"] and self.holds(r["cond"]):
                r["on"] = True
                self.note("L%d" % r["line"], f"开始留钱 金{r['gold']} 木{r['wood']} 给 #{r['tag']}", "条件满足（按采集速度动态，A10）")
            if r["on"] and not r["off"] and self._tag_started(r["tag"]):
                r["off"] = True
                self.note("L%d" % r["line"], f"停止留钱给 #{r['tag']}", f"#{r['tag']} 已开工")
        for L in self.lanes:
            if L["done"] or L["dead"]:
                continue
            self._in(("L%d" % L["line"], None), {"peasant": self._peasant, "hero": self._hero, "building": self._building}[L["kind"]], L)
        if self.clear and not self.clear.get("result"):
            self._in(("L%d" % self.clear["line"], self.clear["event"]), self._tick_clear)

    def _unit(self, L):
        if L["kind"] == "hero":
            return next((u for u in self.units() if u["type_id"] == L["hero"]), None)
        uid = self.uid.get(L["cid"])
        return next((u for u in self.units() if u["unit_id"] == uid), None) if uid else None

    def _gone(self, L) -> bool:
        uid = self.uid.get(L["cid"]) if L["kind"] == "peasant" else None
        if uid is None:
            return False
        return not any(u["unit_id"] == uid for u in self.units()) and not any(u["unit_id"] == uid for u in self.obs.get("inside", []))

    def _next_step(self, L, done_now: bool):
        """Step i is under way; move to step i+1 once i is finished and i+1's condition holds."""
        if not done_now:
            return False
        if L["i"] + 1 >= len(L["steps"]):
            if L["steps"][L["i"]]["act"] not in ONGOING:
                L["done"] = True
            return False
        nxt = L["steps"][L["i"] + 1]
        if not self.holds(nxt["cond"]):
            return False
        L["i"] += 1
        L["on"] = False
        return True

    # ---- peasants --------------------------------------------------------------------------------
    def _peasant(self, L):
        if self._gone(L):
            L["dead"] = True
            self.note("L%d" % L["line"], f"{L['label']} 不在了（阵亡）", f"停在第 {L['i'] + 1} 步「{L['steps'][L['i']]['raw']}」，后面的步骤不再执行，请改脚本")
            return
        u = self._unit(L)
        if u is None:
            return  # not trained yet, or inside the mine for a moment
        for _ in range(3):  # a few instant steps may chain in one tick
            st = L["steps"][L["i"]]
            if not L["on"]:
                if not self.holds(st["cond"]) or not self._p_start(L, st, u):
                    return
                L["on"] = True
                self.note("L%d" % L["line"], f"{L['label']}：{st['raw']}", f"第 {L['line']} 行第 {L['i'] + 1} 步" + self._eta_note(st))
            if not self._next_step(L, self._p_done(L, st, u)):
                self._p_keep(L, st, u)
                return

    def _eta_note(self, st):
        if any(c["kind"] == "hero_eta" for c in st["cond"]) and getattr(self, "_last_eta", None):
            left, lead = self._last_eta
            return f"：大法师还剩 {left:.0f} 秒出生，敲钟集合用时约 {lead:.0f} 秒"
        return ""

    def _p_start(self, L, st, u) -> bool:
        uid, a = u["unit_id"], st["act"]
        peasant = u["type_id"] == "hpea"
        if a in ("采金", "伐木", "建造", "协助", "敲钟") and not peasant:
            return False  # still a militia: wait until he turns back
        if a == "采金":
            if st["mine"] == "natural" and not self.natural_ready():
                return False
            self.harvest(u, "gold", st["mine"])
        elif a == "伐木":
            self._cut(u, st["mine"])
        elif a == "建造":
            p = self._auto_site(st["btype"]) if st["pos"] == "自动" else self.pos(st["pos"])
            if not p:
                return False
            fields = {"unit": L["cid"], "btype": st["btype"], "site": [p["x"], p["y"]], "then": "script"}
            if p.get("exact"):
                fields["at"] = [p["x"], p["y"]]
            self.roles[uid] = "script"
            self._emit(L, st, "build", f"建造 {self.eco[st['btype']]['name']}", **fields)
        elif a == "协助":
            b = self._tag_building(st["tag"])
            if not b:
                return False
            self.roles[uid] = "script"
            self.order(uid, "smart", target_id=b["unit_id"])
        elif a == "敲钟":
            self.roles[uid] = "militia"
            self.order(uid, "cast", order=MILITIA_ORDER)
        elif a in ("集合", "待命"):
            p = self.pos(st["pos"])
            if not p:
                return False
            self.roles[uid] = "script"
            self.order(uid, "move", x=p["x"], y=p["y"])
        elif a == "清野":
            if not self.clear or self.clear.get("result"):
                return False  # the hero has not set off yet: keep standing where we are
            if uid not in self.clear["job"].members:
                self.clear["job"].members.append(uid)
        return True

    def _p_done(self, L, st, u) -> bool:
        a = st["act"]
        if a in ONGOING:
            return True
        if a == "建造":
            evs = self._evs(st)
            return bool(evs) and evs[-1].get("status") == "done"
        if a == "协助":
            return self._tag_rt(st["tag"]).get("status") == "done"
        if a == "敲钟":
            return u["type_id"] == "hmil"
        if a == "清野":
            return bool(self.clear and self.clear.get("result") == "done")
        return True

    def _p_keep(self, L, st, u):
        """Keep doing an ongoing step: back to the gathering point, back to gathering, back to helping."""
        uid, a = u["unit_id"], st["act"]
        if uid in self.ordered or self.t - self.last_order.get(uid, -99) < 3:
            return
        order = (u.get("order") or {}).get("name")
        if a in ("集合", "待命"):
            p = self.pos(st["pos"])
            if p and dist(u, p) > 300 and order != "move":  # e.g. Warcraft sent a turned-back militia to his old work
                self.order(uid, "move", x=p["x"], y=p["y"])
        elif a in ("采金", "伐木") and order is None:
            if a == "采金":
                self.harvest(u, "gold", st["mine"])
            else:
                self._cut(u, st["mine"])
        elif a == "协助" and order is None:
            b = self._tag_building(st["tag"])
            if b and b.get("state") == "constructing":
                self._in(("T3", None), lambda: self.order(uid, "smart", target_id=b["unit_id"]))

    def _cut(self, u, where):
        """Lumber at the main base or at the natural: a tree near that base's drop-off."""
        if where == "natural":
            post = self.crew_post()
            mill = min((b for b in self.structures() if b["type_id"] == "hlum"), key=lambda b: dist(b, {"x": post[0], "y": post[1]}), default=None) if post else None
            drop = mill if mill and dist(mill, {"x": post[0], "y": post[1]}) < 1500 else ({"x": post[0], "y": post[1]} if post else u)
        else:
            drop = min((b for b in self.structures() if b["type_id"] in HALLS + ("hlum",) and dist(b, self.hall) < 1200), key=lambda b: dist(b, self.hall), default=self.hall)
        tree = self.pick_tree(drop)
        if tree:
            self.order(u["unit_id"], "harvest", target_id=tree["id"])
            self.roles[u["unit_id"]] = "wood"
            self.wood_tree[u["unit_id"]] = (tree["x"], tree["y"])

    def _tag_building(self, tag):
        r = self._tag_rt(tag)
        bid = r.get("bid")
        uid = int(bid[1:]) if bid else None
        return next((s for s in self.obs["units"] if s["unit_id"] == uid), None) if uid else None

    # ---- heroes and the clear --------------------------------------------------------------------
    def _hero(self, L):
        u = self._unit(L)
        if u is None:
            return
        for _ in range(3):
            st = L["steps"][L["i"]]
            if not L["on"]:
                if not self.holds(st["cond"]):
                    return
                a = st["act"]
                if a == "学":
                    self._emit(L, st, "learn", f"{L['label']}学{st['abilityName']}", hero=L["hero"], ability=st["ability"], abilityName=st["abilityName"])
                elif a in ("集合", "待命"):
                    p = self.pos(st["pos"])
                    if not p:
                        return
                    self.order(u["unit_id"], "move", x=p["x"], y=p["y"])
                elif a == "清野":
                    self._start_clear(L, st, u)
                L["on"] = True
                self.note("L%d" % L["line"], f"{L['label']}：{st['raw']}", f"第 {L['line']} 行第 {L['i'] + 1} 步")
            a = st["act"]
            done = (a in ONGOING) or (a == "学" and self._evs(st) and self._evs(st)[-1].get("status") == "done") \
                or (a == "清野" and self.clear and self.clear.get("result"))
            if not self._next_step(L, bool(done)):
                return

    def _start_clear(self, L, st, hero):
        members = [hero["unit_id"]] + [u["unit_id"] for u in self.units() if u["type_id"] in ("hfoo", "hmil")]
        for P in self.lanes:  # peasants whose step now is the clear
            if P["kind"] == "peasant" and not P["done"] and P["steps"][P["i"]]["act"] == "清野":
                u = self._unit(P)
                if u and u["unit_id"] not in members:
                    members.append(u["unit_id"])
        e = self._emit(L, st, "clear", "清野（本方向分矿）")
        self.rt[e["id"]].update(status="running", aStart=self.t, note="部队前往分矿")  # run here, not by the timeline engine
        self.clear = {"job": Clear(self.natural_at, (self.hall["x"], self.hall["y"]), members, self.t), "event": e["id"], "line": L["line"], "result": None}

    def _tick_clear(self):
        c = self.clear
        c["job"].tick(self, self.obs, self.t)
        r = self.rt[c["event"]]
        r["note"] = c["job"].note
        if c["job"].result:
            c["result"] = "done" if c["job"].result == "done" else "failed"
            r.update(status="done", aEnd=self.t, failed=c["result"] != "done")
            self.note("L%d" % c["line"], "清野" + ("完成" if c["result"] == "done" else "失败"), c["job"].note)

    # ---- buildings ---------------------------------------------------------------------------------
    def _producers(self, L):
        if L.get("tag"):
            b = self._tag_building(L["tag"])
            return [b] if b and b.get("state") != "constructing" else []
        if L["btype"] in HALLS:
            return [self.hall]  # 城镇大厅 is the main hall (also once it is a keep)
        return self._have(L["btype"])

    def _building(self, L):
        prods = self._producers(L)
        if not prods:
            return
        for _ in range(3):
            st = L["steps"][L["i"]]
            a = st["act"]
            if not L["on"]:
                if not self.holds(st["cond"]):
                    return
                if a == "集结点":
                    target = None
                    if st.get("pos"):
                        target = self.pos(st["pos"])
                    else:
                        target = next((u for u in self.units() if u["type_id"] == st["rallyUnit"]), None)
                    if not target:
                        return
                    for b in prods:
                        if "unit_id" in target:
                            self.order(b["unit_id"], "cast", order="setrally", target_id=target["unit_id"])
                        else:
                            self.order(b["unit_id"], "cast", order="setrally", x=target["x"], y=target["y"])
                elif a == "农民":
                    self._emit(L, st, "train", f"训练 农民{st['peasant']}", utype="hpea", then="script", as_cid=st["peasant"],
                               only=[b["unit_id"] for b in prods])
                elif a == "训练":
                    st["_made"] = 1
                    self._emit(L, st, "train", f"训练 {self.eco[st['unit']]['name']}" + (f"（1/{st['count']}）" if st["count"] > 1 else ""),
                               utype=st["unit"], only=[b["unit_id"] for b in prods])
                elif a == "升级":
                    b = prods[0]
                    fields = {"from": b["type_id"], "to": st["to"], "at": [b["x"], b["y"]]}
                    self._emit(L, st, "upgrade", f"升级 {self.eco[b['type_id']]['name']} → {self.eco[st['to']]['name']}", **fields)
                L["on"] = True
                self.note("L%d" % L["line"], f"{L['label']}：{st['raw']}", f"第 {L['line']} 行第 {L['i'] + 1} 步")
            evs = self._evs(st)
            started = self._almost_out
            if a == "训练" and evs and started(evs[-1]) and st.get("_made", 0) < st["count"]:
                st["_made"] += 1
                self._emit(L, st, "train", f"训练 {self.eco[st['unit']]['name']}（{st['_made']}/{st['count']}）", utype=st["unit"],
                           only=[b["unit_id"] for b in prods])
                return
            done = a == "集结点" or (evs and started(evs[-1]) and (a != "训练" or st.get("_made", 0) >= st["count"]))
            if not self._next_step(L, bool(done)):
                return

    def _almost_out(self, r) -> bool:
        """A trained unit is (nearly) out: the next one is ordered then, so its money is not locked in
        the queue early and the building never stands idle. An upgrade counts once it has begun."""
        if r.get("status") == "done":
            return True
        if r.get("trainStart") is None:
            return False
        e = next((x for x in self.events if self.rt.get(x["id"]) is r), None)
        if e is None or e["kind"] == "upgrade":
            return True
        return self.t >= r["trainStart"] + self.eco[e["utype"]]["time"] - QUEUE_LEAD

    # ---- money held by 留钱 ------------------------------------------------------------------------
    def _reserve(self):
        g = w = 0
        for r in self.reserves:
            if r["on"] and not r["off"] and self.tag_prio.get(r["tag"], 0) > self._cur_prio:
                g, w = g + r["gold"], w + r["wood"]
        return g, w

    # ---- for the console -------------------------------------------------------------------------
    def snapshot(self) -> dict:
        s = super().snapshot()
        positions = {}
        for q in self.model.get("positions", []):  # where each named place is in this game, for the map
            try:
                p = self._pos.get(q["name"]) or (self._resolve(q["expr"]) if self.hall else None)
            except (KeyError, IndexError, TypeError):
                p = None
            if p:
                positions[q["name"]] = [round(p["x"]), round(p["y"])]
        s["script"] = {"errors": self.errors, "positions": positions, "lanes": [
            {"label": L["label"], "line": L["line"], "kind": L["kind"], "i": L["i"], "on": L["on"], "done": L["done"], "dead": L["dead"],
             "steps": [st["raw"] for st in L["steps"]]} for L in self.lanes]}
        return s
