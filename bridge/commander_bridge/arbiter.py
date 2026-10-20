"""The arbiter: one decision maker driven by docs/规则表-人族速矿二本.md (version 2).

The timeline commander (engine.Commander) plays a fixed list of timed events, and its standing
helpers (worker balance, money reserve) fought with that list. Here the rules decide, every tick,
what to start and why; each decision becomes an ordinary event that the proven Commander machinery
carries out (build, train, militia, clear, upgrade), and a line in the decision log:

    {"t": 64.0, "rule": "B6", "action": "训练 大法师", "why": "国王祭坛完成"}

Rule ids match the table, so the player can veto a line or change a priority by its number.
Priorities (bigger first) order both who starts and who spends; a money reserve only holds back
lower-priority items (A8 hall 100, A9 keep 70). The plan (a 人族速矿二本 strategy) only lends
its sites: wall pieces and the natural's hall/tower; its times are ignored.
"""
from __future__ import annotations

import math

from .engine import GOLD_PER_MINE, HALLS, WOOD_TARGET, Commander, dist

HERO_TIME = 55.0                         # the first Archmage trains in 55 s
PEASANT_SPEED, MILITIA_SPEED = 190.0, 270.0
CALL_TO_ARMS = 2.0                       # seconds for a peasant to change once he reaches the hall
FOOD_MARGIN = 4                          # A6: build a farm when this little food is left
FOOTMEN = 6                              # A7
CASTERS = {"hspt": 6, "hmpr": 3, "hsor": 3}  # B30: breakers, priests, sorceresses
VAULT_AT = 405.0                         # B26: the build order's 6:45
PRIO = {"A5": 90, "A6": 80, "A7": 60, "B2": 100, "B3": 100, "B4": 95, "B6": 100, "B11": 95, "B13": 95,
        "B19": 100, "B20": 75, "B23": 40, "B24": 70, "B25": 45, "B26": 40, "B27": 90, "B28": 85,
        "B29": 50, "B30": 60}


class Arbiter(Commander):
    def __init__(self, data: dict):
        super().__init__(data)
        self.decisions: list[dict] = []
        self.sites: dict[str, list] = {}
        self.done: set[str] = set()      # one-shot rules that have fired
        self._n = 0
        self._cur_prio = 0
        self._last_role: dict[int, str] = {}

    # ---- plan: only its sites ------------------------------------------------------------------
    def set_plan(self, plan: dict) -> None:
        builds = sorted((e for g in plan.get("groups", []) for e in g.get("children", []) if e.get("kind") == "build"),
                        key=lambda e: (e.get("start", 0), e.get("seq", 0)))
        self.sites = {}
        for e in builds:
            site = e.get("at") or e.get("site")
            if site:
                key = "natural:" + e["btype"] if e.get("near") == "natural" else e["btype"]
                self.sites.setdefault(key, []).append({"site": list(site), "at": bool(e.get("at"))})
        self.plan_start = plan.get("start")

    def _site(self, key):
        pool = self.sites.get(key) or []
        return pool.pop(0) if pool else None

    def _place(self, key) -> dict:
        """Event fields for the next site of this kind: exact ("at") where the strategy placed it."""
        s = self._site(key)
        if not s:
            return {}
        return {"site": s["site"], "at": s["site"]} if s["at"] else {"site": s["site"]}

    # ---- decisions -----------------------------------------------------------------------------
    def _add(self, rule, kind, name, why, **fields) -> dict:
        self._n += 1
        e = {"id": f"r{self._n}", "seq": 1000 + self._n, "kind": kind, "name": name, "start": self.t, "rule": rule,
             "prio": PRIO.get(rule, 50), "why": why, **fields}
        self.events.append(e)
        self.rt[e["id"]] = {"status": "pending", "aStart": None, "aEnd": None, "note": ""}
        self.note(rule, name, why, event=e["id"])
        return e

    def note(self, rule, action, why, event=None) -> None:
        d = {"t": round(self.t, 1), "rule": rule, "action": action, "why": why}
        if event:
            d["event"] = event  # its progress is in the snapshot's events under this id
        self.decisions.append(d)

    def _once(self, key) -> bool:
        if key in self.done:
            return False
        self.done.add(key)
        return True

    @staticmethod
    def _order_key(e):
        return (-e.get("prio", 0), e["start"], e.get("seq", 0))

    def _advance(self, e):
        self._cur_prio = e.get("prio", 0)
        try:
            super()._advance(e)
        finally:
            self._cur_prio = 0

    def _reserve(self):
        """A8 / A9: the hall's and then the keep's cost, held only from items of lower priority."""
        g = w = 0
        for e in self.events:
            if e.get("prio", 0) <= self._cur_prio or e["id"] not in self.jobs and self.rt[e["id"]]["status"] != "pending":
                continue
            job = self.jobs.get(e["id"]) or {}
            if e.get("rule") == "B19" and (self.rt[e["id"]]["status"] == "pending" or job.get("state") == "wait_res"):
                g, w = g + self.eco["htow"]["gold"], w + self.eco["htow"]["wood"]
            if e.get("rule") == "B24" and job.get("state") == "waiting":
                g, w = g + self.eco["hkee"]["gold"] - self.eco["htow"]["gold"], w + self.eco["hkee"]["wood"] - self.eco["htow"]["wood"]
        return g, w

    # ---- helpers ---------------------------------------------------------------------------------
    def _have(self, type_id, done=True):
        return [s for s in self.structures(done=done) if s["type_id"] == type_id]

    def _open(self, rule):
        """Events of this rule that have not finished."""
        return [e for e in self.events if e.get("rule") == rule and self.rt[e["id"]]["status"] != "done"]

    def _fired(self, rule):
        return [e for e in self.events if e.get("rule") == rule]

    def _peasants(self):
        return [u for u in self.units() if u["type_id"] in ("hpea", "hmil")] + [u for u in self.obs.get("inside", []) if u["type_id"] in ("hpea", "hmil")]

    def _target(self):
        halls = sum(1 for s in self.structures() if s["type_id"] in HALLS)
        natural_planned = any(e.get("rule") == "B19" for e in self.events)
        return GOLD_PER_MINE * max(1, halls + (1 if natural_planned and halls < 2 else 0)) + WOOD_TARGET

    def _rt(self, rule):
        e = next(iter(self._fired(rule)), None)
        return self.rt[e["id"]] if e else {}

    # ---- the rules, every tick -------------------------------------------------------------------
    def _decide(self) -> None:
        if not self.hall:
            return
        self._opening()
        self._clear_phase()
        self._expansion()
        self._tech()
        self._standing()

    def _opening(self):
        if self._once("B1"):
            self._add("B1", "gather", "采金 · 农民1、2、3", "开局 3 人采金", units=[1, 2, 3], res="gold")
        if self._once("B2"):
            place = self._place("halt")
            self._add("B2", "build", "建造 国王祭坛 · 农民4", "开局：尽快出大法师", unit=4, btype="halt",
                      **place)
        if self._once("B3"):
            place = self._place("hhou")
            self._add("B3", "build", "建造 农场 1 · 农民5", "开局：人口 12 → 18，建完去采金", unit=5, btype="hhou", then="gold",
                      **place)
        if 6 in self.uid and self.uid[6] in {u["unit_id"] for u in self.units()} and self._once("B4"):
            place = self._place("hbar")
            self._add("B4", "build", "建造 兵营 · 农民6", "第 1 个新农民出生", unit=6, btype="hbar",
                      **place)
        if self._have("halt") and not any(u.get("hero") for u in self.units()) and self._once("B6"):
            self._add("B6", "train", "训练 大法师（首发免费）", "国王祭坛完成", utype="Hamg")

    def _hero_eta(self):
        hero = next((u for u in self.units() if u["type_id"] == "Hamg"), None)
        if hero:
            return self.t
        rt = self._rt("B6")
        return rt["trainStart"] + HERO_TIME if rt.get("trainStart") is not None else None

    def _clear_phase(self):
        hero = next((u for u in self.units() if u["type_id"] == "Hamg"), None)
        if hero and self._once("B10"):
            self._add("B10", "learn", "大法师学水元素", "大法师出生", hero="Hamg", ability="AHwe", abilityName="水元素")
        eta = self._hero_eta()
        altar = next(iter(self._have("halt")), None)
        if eta is not None and altar and "B11" not in self.done:
            wood = sorted((u for u in self.workers() if self.roles.get(u["unit_id"]) == "wood"), key=lambda u: dist(u, self.hall))[:5]
            if len(wood) >= 5:
                lead = dist(wood[-1], self.hall) / PEASANT_SPEED + CALL_TO_ARMS + dist(self.hall, altar) / MILITIA_SPEED
                if self.t >= eta - lead:
                    self.done.add("B11")
                    to = self._toward(altar, self.hall, 200)
                    self._add("B11", "militia", "敲钟：5 个伐木农民变民兵",
                              f"大法师约 {eta:.0f} 秒出生；走到大厅、变身、走到祭坛约需 {lead:.0f} 秒",
                              count=5, **{"from": "wood"}, to=to)
        militia = next(iter(self._fired("B11")), None)
        if hero and militia and self._once("B13"):
            side = {0: "左边", 1: "上边", 2: "右边", 3: "下边"}.get(self.start_index, "")
            self._add("B13", "clear", "清近矿（大法师 + 步兵 + 民兵）", f"大法师出生、民兵已敲钟；目标：本出生点{side}的分矿",
                      militia=militia["id"])

    @staticmethod
    def _toward(a, b, d):
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        n = math.hypot(dx, dy) or 1
        return [round(a["x"] + dx / n * d), round(a["y"] + dy / n * d)]

    def _expansion(self):
        clear = self._rt("B13")
        if clear.get("status") == "done" and clear.get("failed") and self._once("B17"):
            self.note("B17", "不开分基地", "清野失败：" + (clear.get("note") or ""))
        if clear.get("status") == "done" and not clear.get("failed"):
            if self._once("B19"):
                place = self._place("natural:htow")
                self._add("B19", "build", "建造 分基地（1 人放 + 3 人协助）", "野怪清完；留出 385 金 / 205 木（A8）", unit=None,
                          btype="htow", near="natural", helpers=3, then="natural", **place)
            if self._once("B20"):
                place = self._place("natural:hwtw")
                self._add("B20", "build", "建造 侦察塔（清野小组第 5 人）", "和分基地同时开工", unit=None, btype="hwtw",
                          near="natural", then="natural", **place)
        if self._have("hwtw") and self._once("B23"):
            self._add("B23", "upgrade", "侦察塔升级为奥术塔", "侦察塔建完", **{"from": "hwtw"}, to="hatw")

    def _tech(self):
        hall_ev = next(iter(self._fired("B19")), None)
        if hall_ev and self.rt[hall_ev["id"]].get("bid") and self._once("B24"):
            self._add("B24", "upgrade", "升级 主城（二本）", "分基地已开工；攒齐 320 金 / 210 木就升（A9 留钱，分矿补农民优先）",
                      **{"from": "htow"}, to="hkee", at=[self.hall["x"], self.hall["y"]])
        if hall_ev and self.rt[hall_ev["id"]]["status"] == "done" and self._once("B25"):
            place = self._place("hlum")
            self._add("B25", "build", "建造 伐木场", "双矿运转", unit=None, btype="hlum", then="wood",
                      **place)
        if self.t >= VAULT_AT and self._once("B26"):
            place = self._place("hvlt")
            self._add("B26", "build", "建造 神秘藏宝室", "到了 6:45", unit=None, btype="hvlt",
                      **place)
        if self._have("hkee"):
            if self._once("B27"):
                self._add("B27", "train", "训练 山丘之王（二发英雄）", "主城完成", utype="Hmkg")
            for rule, n in (("B28", "1"), ("B29", "2")):
                if self._once(rule):
                    place = self._place("hars")
                    self._add(rule, "build", "建造 神秘圣所 " + n, "主城完成" + ("" if rule == "B28" else "；木材够再建（优先级低）"),
                              unit=None, btype="hars", **place)
        sanctums = [s for s in self._have("hars") if not s.get("queue") and not any(j.get("producer") == s["unit_id"] for j in self.jobs.values())]
        if sanctums and not self._open("B30"):
            have = {t: sum(1 for u in self.units() if u["type_id"] == t) + sum(1 for e in self._fired("B30") if e.get("utype") == t and self.rt[e["id"]]["status"] != "done") for t in CASTERS}
            short = [t for t in CASTERS if have[t] < CASTERS[t] and all(any(s["type_id"] == r for s in self.structures()) for r in self.eco[t].get("requires", []))]
            if short:
                t = min(short, key=lambda t: have[t] / CASTERS[t])
                self._add("B30", "train", "训练 " + self.eco[t]["name"], f"圣所空闲；{self.eco[t]['name']} {have[t]}/{CASTERS[t]}", utype=t)

    def _standing(self):
        p = self.obs["player"]
        # A6: a farm before food runs out
        building_farm = self._open("A6") or self._open("B3")
        if p["food_cap"] < 100 and p["food_cap"] - p["food_used"] <= FOOD_MARGIN and not building_farm and "B3" in self.done:
            place = self._place("hhou") or {"site": [self.hall["x"], self.hall["y"]]}  # past the plan's farms: the game picks a spot
            self._add("A6", "build", "建造 农场", f"人口 {p['food_used']}/{p['food_cap']}，只剩 {p['food_cap'] - p['food_used']}",
                      unit=None, btype="hhou", then="wood", **place)
        # A5: peasants, one per idle hall; the main hall stays free once the keep is due
        keep = next(iter(self._open("B24")), None)
        keep_due = keep is not None and (self.jobs.get(keep["id"]) or {}).get("state") == "waiting"
        avoid = [self.hall["unit_id"]] if keep_due else []
        halls = [s for s in self.structures() if s["type_id"] in HALLS and s["unit_id"] not in avoid and not s.get("queue")
                 and not any(j.get("producer") == s["unit_id"] for j in self.jobs.values())]
        queued = len([e for e in self._open("A5") if not (self.jobs.get(e["id"]) or {}).get("producer")])
        if halls and queued < len(halls) and len(self._peasants()) + queued < self._target() and p["food_used"] < p["food_cap"]:
            main_gold = sum(1 for r, m in ((self.roles.get(u["unit_id"]), self.mine_of.get(u["unit_id"], "main")) for u in self.workers()) if r == "gold" and m == "main")
            nat_gold = sum(1 for u in self.workers() if self.roles.get(u["unit_id"]) == "gold" and self.mine_of.get(u["unit_id"]) == "natural")
            then = "natural" if self.natural_ready() and nat_gold < GOLD_PER_MINE else "gold" if main_gold < GOLD_PER_MINE else "wood"
            self._add("A5", "train", "训练农民 → " + {"gold": "采金", "wood": "伐木", "natural": "分矿采金"}[then],
                      f"农民 {len(self._peasants())}/{self._target()}" + ("；主基地留给二本" if keep_due else ""), utype="hpea", then=then, avoid=avoid)
        # A7: footmen up to six
        bars = [s for s in self._have("hbar") if not s.get("queue") and not any(j.get("producer") == s["unit_id"] for j in self.jobs.values())]
        if bars and self._footmen() < FOOTMEN and not self._open("A7"):
            self._add("A7", "train", f"训练 步兵（第 {self._footmen() + 1} 个）", f"兵营空闲；步兵 {self._footmen()}/{FOOTMEN}", utype="hfoo")

    # ---- worker moves are decisions too (A1-A4) -----------------------------------------------
    def harvest(self, u, res, where: str = "main") -> bool:
        ok = super().harvest(u, res, where)
        if ok:
            uid = u["unit_id"]
            role = "wood" if res == "wood" else ("natural" if self.mine_of.get(uid) == "natural" else "gold")
            if self._last_role.get(uid) != role:
                self._last_role[uid] = role
                rule, why = {"gold": ("A1", "主矿采金 5 人"), "natural": ("A2", "分矿采金 5 人"), "wood": ("A3", "其余伐木")}[role]
                self.note(rule, f"农民{self.cid.get(uid, '?')} → {'伐木' if role == 'wood' else '分矿采金' if role == 'natural' else '采金'}", why)
        return ok

    def snapshot(self) -> dict:
        s = super().snapshot()
        s["decisions"] = self.decisions
        s["arbiter"] = True
        return s
