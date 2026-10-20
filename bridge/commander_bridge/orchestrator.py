"""Play the player's orchestration (strategies/编排-*.md): meta-strategies M1-M13 started and stopped by
the conditions on each row, ordered and paid by each row's priority.

Each row is pending until its start condition holds, then active until its stop condition holds:
one-shot meta-strategies (build, train N, upgrade, learn, call to arms, clear, rally) end when their
work is done; standing ones (gold, lumber, peasants, train up to a cap, hold money, food) run until
the stop condition. Everything they decide goes through the arbiter (arbiter.py): the decision record
(rule = "R<row>"), order attribution, money reserve with A10, the consistency check and the replay.
"""
from __future__ import annotations

from .arbiter import Arbiter
from .engine import HALLS, dist
from .orchestration import parse

HERO_TIME = 55.0
PEASANT_SPEED, MILITIA_SPEED, CALL_TO_ARMS = 190.0, 270.0, 2.0


class Orchestrator(Arbiter):
    def __init__(self, data: dict):
        super().__init__(data)
        self.rows: list[dict] = []
        self.errors: list[str] = []
        self.row_state: dict[int, str] = {}          # row -> pending | active | done
        self.row_events: dict[int, list] = {}    # row -> its events
        self.made: dict[tuple, int] = {}         # (row, step) -> units ordered so far (M5 N 个)
        self._crew_seen = False
        self._worker_rules = {"gold": ("A1", "主矿采金"), "natural": ("A2", "分矿采金"), "wood": ("A3", "伐木")}

    def set_plan(self, plan: dict) -> None:
        super().set_plan(plan)  # the layout's sites
        self.rows, self.errors = parse(plan.get("orchestration") or "")
        self.rows.sort(key=lambda r: r["no"])
        self.row_state = {r["no"]: "pending" for r in self.rows}
        self.row_events = {r["no"]: [] for r in self.rows}

    # ---- events and records ------------------------------------------------------------------
    def _emit(self, row, kind, name, why, **fields) -> dict:
        e = self._add("R%d" % row["no"], kind, name, why, **fields)
        e.update(prio=row["prio"], phase=row["phase"], row=row["no"])
        self.row_events[row["no"]].append(e)
        return e

    def worker_rule(self, role):
        rule, what = self._worker_rules[role]
        return rule, what

    def _rt_of(self, e):
        return self.rt[e["id"]]

    def _started(self, e) -> bool:
        r = self._rt_of(e)
        if e["kind"] == "build":
            return bool(r.get("bid")) or r.get("status") == "done"
        if e["kind"] in ("train", "upgrade"):
            return r.get("trainStart") is not None or r.get("status") == "done"
        return r.get("status") not in (None, "pending")

    def _row_started(self, no) -> bool:
        evs = self.row_events.get(no, [])
        if evs:
            return any(self._started(e) for e in evs)
        return self.row_state.get(no) in ("active", "done")

    def _row_finished(self, row) -> bool:
        """A row's own work is done: all its events finished (standing meta-strategies never are)."""
        if any(s["m"] in (1, 2, 3, 11, 12) or (s["m"] == 5 and s.get("cap")) for s in row["steps"]):
            return False
        if any(s["m"] == 10 for s in row["steps"]):
            return not any(self.roles.get(u["unit_id"]) == "crew" for u in self.workers()) and self.t > 0 and self._crew_seen
        if any(s["m"] == 5 and s.get("count") and self.made.get((row["no"], i), 0) < s["count"] for i, s in enumerate(row["steps"])):
            return False
        if any(s["m"] == 13 and not self.made.get((row["no"], i)) for i, s in enumerate(row["steps"])):
            return False
        evs = self.row_events[row["no"]]
        return bool(evs) and all(self._rt_of(e).get("status") == "done" for e in evs)

    # ---- conditions --------------------------------------------------------------------------
    def _hero_eta(self):
        if any(u["type_id"] == "Hamg" for u in self.units()):
            return self.t
        for e in self.events:
            r = self._rt_of(e)
            if e.get("utype") == "Hamg" and r.get("trainStart") is not None:
                return r["trainStart"] + HERO_TIME
        return None

    def _militia_lead(self):
        altar = next(iter(self._have("halt")), None)
        wood = sorted((u for u in self.workers() if self.roles.get(u["unit_id"]) == "wood"), key=lambda u: dist(u, self.hall))[:5]
        if not altar or not wood:
            return None
        return dist(wood[-1], self.hall) / PEASANT_SPEED + CALL_TO_ARMS + dist(self.hall, altar) / MILITIA_SPEED

    def _count(self, what) -> int:
        if what == "伐木":
            return sum(1 for u in self.workers() if self.roles.get(u["unit_id"]) == "wood") + self._builders_from_wood()
        if what == "步兵":
            return sum(1 for u in self.units() if u["type_id"] == "hfoo")
        if what == "农民":
            return len(self._peasants())
        return sum(1 for u in self.workers() if self.roles.get(u["unit_id"]) == "gold")

    def _holds(self, c, row) -> bool:
        k = c["kind"]
        if k == "time":
            return self.t >= c["t"]
        if k == "row_done":
            return self.row_state.get(c["row"]) == "done"
        if k == "row_started":
            return self._row_started(c["row"])
        if k == "hero_eta":
            eta = self._hero_eta()
            if eta is None:
                return False
            lead = c["lead"] if c["lead"] is not None else self._militia_lead()
            return lead is not None and self.t >= eta - lead
        if k == "peasant":
            uid = self.uid.get(c["cid"])
            return uid is not None and any(u["unit_id"] == uid for u in self.units())
        if k == "exists":
            return any(u["type_id"] == c["type"] for u in self.units()) or bool(self._have(c["type"]))
        if k in ("gold", "wood"):
            return self.budget[0 if k == "gold" else 1] >= c["n"]
        if k == "count":
            n = self._count(c["what"])
            return n < c["n"] if c["op"] == "<" else n == c["n"] if c["op"] == "=" else n >= c["n"]
        if k == "always":
            return True
        if k == "self_done":
            return self._row_finished(row)
        return False  # never

    # ---- the rows, every tick ----------------------------------------------------------------
    def _decide(self) -> None:
        self._track_income()
        if not self.hall or self.errors:
            return
        self._crew_seen = getattr(self, "_crew_seen", False) or any(self.roles.get(u["unit_id"]) == "crew" for u in self.workers())
        self._caps()
        for row in self.rows:
            no = row["no"]
            if self.row_state[no] == "pending" and all(self._holds(c, row) for c in row["start"]):
                self.row_state[no] = "active"
                self.note("R%d" % no, f"第 {no} 行开始：{row['text']}", f"启动条件「{row['startText'] or '0:00'}」满足")
                self._caps()
                for i, step in enumerate(row["steps"]):
                    self._begin(row, i, step)
            if self.row_state[no] == "active":
                for i, step in enumerate(row["steps"]):
                    self._run_step(row, i, step)
                if all(self._holds(c, row) for c in row["stop"]):
                    self.row_state[no] = "done"
                    self.note("R%d" % no, f"第 {no} 行结束", f"停止条件「{row['stopText'] or '做完'}」满足")
                    self._caps()

    def _caps(self):
        """Standing M1/M2 rows set how many mine each mine and how many cut wood."""
        self.gold_cap = {"main": 0, "natural": 0}
        self.wood_cap = 0
        for row in self.rows:
            if self.row_state.get(row["no"]) != "active":
                continue
            for s in row["steps"]:
                if s["m"] == 1:
                    self.gold_cap[s["mine"]] = s["count"]
                    self._worker_rules["natural" if s["mine"] == "natural" else "gold"] = ("R%d" % row["no"], f"{'分矿' if s['mine'] == 'natural' else '主矿'}采金 {s['count']} 人")
                elif s["m"] == 2:
                    self.wood_cap = s["count"]
                    self._worker_rules["wood"] = ("R%d" % row["no"], f"伐木 {s['count']} 人（含去建造的）")

    def _natural_builds_left(self):
        """Builds the clear crew still has to do (M4 with 分矿组 that are not done)."""
        return [r for r in self.rows if self.row_state.get(r["no"]) != "done" and any(s["m"] == 4 and s.get("crew") for s in r["steps"])]

    def _site_for(self, step) -> dict:
        w = step["where"]
        if w == "xy":
            return {"site": step["xy"], "at": step["xy"]}
        if w == "natural":
            place = self._place("natural:" + step["btype"])
            return dict(place, near="natural") if place else {"near": "natural", "site": list(self.natural_at)}
        place = self._place(step["btype"])
        if place:
            return place if w == "layout" else {"site": place["site"]}
        return {"site": [self.hall["x"], self.hall["y"]]}  # no layout site left: the game picks a spot nearby

    # ---- starting a meta-strategy (one-shot ones create their event here) ----------------------
    def _begin(self, row, i, s):
        why = f"第 {row['no']} 行：{s['text']}"
        m = s["m"]
        if m == 4:
            fields = {"unit": s["builder"], "btype": s["btype"], **self._site_for(s)}
            if s.get("helpers"):
                fields["helpers"] = s["helpers"]
            if s.get("then"):
                fields["then"] = s["then"]
            if s.get("crew"):
                fields["near"] = "natural"
            who = f"农民{s['builder']}" if s["builder"] else ("分矿组" if s.get("crew") else "伐木农民")
            self._emit(row, "build", f"建造 {self.eco[s['btype']]['name']} · {who}", why, **fields)
        elif m == 5 and s.get("count"):
            self._train_next(row, i, s, why)
        elif m == 6:
            fields = {"from": s["from"], "to": s["to"]}
            if s["from"] in HALLS:
                fields["at"] = [self.hall["x"], self.hall["y"]]  # the main hall, not the expansion
            self._emit(row, "upgrade", f"升级 {self.eco[s['from']]['name']} → {self.eco[s['to']]['name']}", why, **fields)
        elif m == 7:
            self._emit(row, "learn", f"{self.eco[s['hero']]['name']}学{s['abilityName']}", why, hero=s["hero"], ability=s["ability"], abilityName=s["abilityName"])
        elif m == 8:
            altar = next(iter(self._have("halt")), None)
            to = self._toward(altar, self.hall, 200) if altar else None
            self._emit(row, "militia", f"敲钟：{s['count']} 个{'采金' if s['from'] == 'gold' else '伐木'}农民变民兵", why,
                       count=s["count"], **{"from": s["from"]}, **({"to": to} if to else {}))
        elif m == 9:
            mil = next((e for e in reversed(self.events) if e["kind"] == "militia"), None)
            self._emit(row, "clear", "清野（本方向分矿）", why, **({"militia": mil["id"]} if mil else {}))

    def _train_next(self, row, i, s, why):
        key = (row["no"], i)
        self.made[key] = self.made.get(key, 0) + 1
        n = self.made[key]
        self._emit(row, "train", f"训练 {self.eco[s['utype']]['name']}" + (f"（{n}/{s['count']}）" if s["count"] > 1 else ""), why, utype=s["utype"])

    # ---- running a meta-strategy every tick (standing ones work here) -------------------------
    def _run_step(self, row, i, s):
        m, why = s["m"], f"第 {row['no']} 行：{s['text']}"
        key = (row["no"], i)
        if m == 3:
            self._peasant(row, s, why)
        elif m == 5 and s.get("cap"):
            self._train_cap(row, s, why)
        elif m == 5 and s.get("count") and self.made.get(key, 0) < s["count"]:
            last = [e for e in self.row_events[row["no"]] if e.get("utype") == s["utype"]][-1:]
            if not last or self._started(last[0]):
                self._train_next(row, i, s, why)
        elif m == 12:
            self._food(row, s, why)
        elif m == 13 and not self.made.get(key):
            b = next(iter(self._have(s["building"])), None)
            toward = self.hall if s["toward"] in HALLS else next(iter(self._have(s["toward"])), None)
            if b and toward:
                self._in(("R%d" % row["no"], None), lambda: self.order(b["unit_id"], "cast", order="setrally", x=toward["x"], y=toward["y"]))
                self.made[key] = 1
                self.note("R%d" % row["no"], f"设集结点：{self.eco[s['building']]['name']} → {self.eco[s['toward']]['name']}", why)

    def _free(self, b) -> bool:
        return not b.get("queue") and not any(j.get("producer") == b["unit_id"] for j in self.jobs.values())

    def _peasant(self, row, s, why):
        p = self.obs["player"]
        keep = next((e for e in self.events if e["kind"] == "upgrade" and e.get("to") in HALLS and self._rt_of(e).get("status") == "waiting"), None)
        keep_wait = self._keep_wait() if keep else 0.0
        hold_hall = keep is not None and keep_wait < self.eco["hpea"]["time"] + 1
        halls = [b for b in self.structures() if b["type_id"] in HALLS and self._free(b)]
        if s["base"] == "main":
            halls = [b for b in halls if b["unit_id"] == self.hall["unit_id"]]
        elif s["base"] == "natural":
            halls = [b for b in halls if b["unit_id"] != self.hall["unit_id"]]
        if hold_hall:
            halls = [b for b in halls if b["unit_id"] != self.hall["unit_id"]]
        queued = [e for e in self.row_events[row["no"]] if self._rt_of(e).get("status") != "done" and not (self.jobs.get(e["id"]) or {}).get("producer")]
        if not halls or len(queued) >= len(halls) or p["food_used"] >= p["food_cap"]:
            return
        main_short = max(0, self.gold_cap["main"] - self._gold_heads("main"))
        nat_short = max(0, self.gold_cap["natural"] - self._gold_heads("natural")) if self.natural_ready() else 0
        cutting = self._count("伐木")
        incoming = sum(1 for e in self.row_events[row["no"]] if e.get("then") == "wood" and self._rt_of(e).get("status") != "done")
        wood_short = max(0, self.wood_cap - cutting - incoming)
        if not (main_short or nat_short or wood_short):
            return
        then = "natural" if nat_short else "gold" if main_short else "wood"
        note = f"主矿采金差 {main_short}" + (f"，分矿差 {nat_short}" if self.natural_ready() else "") + f"，伐木 {cutting}+{incoming}/{self.wood_cap}"
        if keep is not None and not hold_hall:
            note += f"；二本还要等约 {keep_wait:.0f} 秒，主基地先训练农民（A10）"
        self._emit(row, "train", "训练农民 → " + {"gold": "采金", "wood": "伐木", "natural": "分矿采金"}[then], note,
                   utype="hpea", then=then, avoid=[self.hall["unit_id"]] if hold_hall else [])

    def _train_cap(self, row, s, why):
        ut = s["utype"]
        open_ = [e for e in self.row_events[row["no"]] if e.get("utype") == ut and self._rt_of(e).get("status") != "done"]
        have = sum(1 for u in self.units() if u["type_id"] == ut) + len(open_)
        prods = [b for b in self.structures() if ut in (self.eco.get(b["type_id"], {}).get("trains") or []) and self._free(b)]
        if have < s["cap"] and prods and len([e for e in open_ if not (self.jobs.get(e["id"]) or {}).get("producer")]) < len(prods):
            self._emit(row, "train", f"训练 {self.eco[ut]['name']}（第 {have + 1} 个）", f"{why}；现有 {have}/{s['cap']}", utype=ut)

    def _food(self, row, s, why):
        p = self.obs["player"]
        farms = [e for e in self.events if e.get("btype") == "hhou" and self._rt_of(e).get("status") != "done"]
        if p["food_cap"] < 100 and p["food_cap"] - p["food_used"] <= s["margin"] and not farms:
            place = self._place("hhou") or {"site": [self.hall["x"], self.hall["y"]]}
            self._emit(row, "build", "建造 农场", f"人口 {p['food_used']}/{p['food_cap']}，只剩 {p['food_cap'] - p['food_used']}（{why}）",
                       unit=None, btype="hhou", then="wood", **place)

    # ---- money held by M11 rows ---------------------------------------------------------------
    def _reserve(self):
        g = w = 0
        for row in self.rows:
            if self.row_state.get(row["no"]) != "active" or row["prio"] <= self._cur_prio:
                continue
            for s in row["steps"]:
                if s["m"] == 11:
                    g, w = g + s["gold"], w + s["wood"]
        return g, w

    def snapshot(self) -> dict:
        s = super().snapshot()
        s["orchestration"] = {"errors": self.errors,
                              "rows": [{"no": r["no"], "phase": r["phase"], "text": r["text"], "start": r["startText"], "stop": r["stopText"],
                                        "prio": r["prio"], "state": self.row_state.get(r["no"])} for r in self.rows]}
        return s
