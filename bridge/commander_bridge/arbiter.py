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
RATE_WINDOW = 30.0                       # A10: income measured over the last 30 game seconds
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
        self.game_events: list[dict] = []   # what the game itself reported, to check our record against
        self._bank: tuple | None = None     # last tick's gold/lumber, to measure what was gathered
        self._got = [0.0, 0.0]              # gathered so far (sum of increases)
        self._income: list[tuple] = []      # (t, gathered gold, gathered lumber)
        self._borrowed: set = set()         # events that used A10 once (logged once)

    def _ingest(self, obs: dict) -> None:
        for ev in obs.get("events", []):
            self.game_events.append({"t": self.t, **{k: ev[k] for k in ("kind", "unit_id", "type_id", "trained_id", "summoned_id", "ability_id") if k in ev}})
        super()._ingest(obs)

    # ---- does our record match the game's? ------------------------------------------------------
    CHECKED = {"construct_start": "开工", "construct_finish": "完工", "train_start": "开始训练", "train_finish": "训练完成",
               "upgrade_start": "开始升级", "upgrade_finish": "升级完成"}

    def consistency(self) -> dict:
        """Match every building/training/upgrade the game reported to the decision that caused it, and
        every decision that gave orders to something the game reported. Either side left over is a
        disagreement between the commander's timeline and what actually happened."""
        rt = self.rt
        bid = {r.get("bid"): eid for eid, r in rt.items() if r.get("bid")}
        trained = {r.get("trained"): eid for eid, r in rt.items() if r.get("trained")}
        rule = {e["id"]: e.get("rule") for e in self.events}
        name = lambda t: self.eco.get(t, {}).get("name", t or "?")
        matched, game_only, deaths = [], [], []
        for ge in self.game_events:
            k, eid = ge["kind"], None
            if k in ("construct_start", "construct_finish"):
                eid = bid.get("u%d" % ge.get("unit_id", 0))
            elif k in ("train_start", "upgrade_start"):
                eid = next((i for i, r in rt.items() if r.get("gameUnit") == ge.get("unit_id") and r.get("trainStart") is not None
                            and abs(r["trainStart"] - ge["t"]) < 1.0), None)
            elif k == "train_finish":
                eid = trained.get(ge.get("trained_id"))
            elif k == "upgrade_finish":
                eid = next((i for i, r in rt.items() if r.get("gameUnit") == ge.get("unit_id") and r.get("aEnd") is not None
                            and abs(r["aEnd"] - ge["t"]) < 1.0), None)
            elif k == "death":
                deaths.append({"t": ge["t"], "what": name(ge.get("type_id"))})
                continue
            else:
                continue
            row = {"t": ge["t"], "what": self.CHECKED[k] + " " + name(ge.get("type_id")), "event": eid, "rule": rule.get(eid)}
            (matched if eid else game_only).append(row)
        ours_only = []
        for e in self.events:
            r = rt[e["id"]]
            confirm = {"build": "bStart", "train": "trainStart", "upgrade": "trainStart"}.get(e["kind"])
            if confirm and r.get("ordered") is not None and r.get(confirm) is None and r.get("status") != "done":
                ours_only.append({"t": r["ordered"], "what": e["name"], "event": e["id"], "rule": e.get("rule"),
                                  "why": "下了命令，游戏里还没有发生" + ("（被拒绝：%s）" % r["rejected"] if r.get("rejected") else "")})
        return {"matched": len(matched), "gameOnly": game_only, "oursOnly": ours_only, "deaths": deaths}

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

    def _worker_target(self) -> int:
        """The timeline commander's cap on peasants does not apply: A5 decides who is short."""
        return 10 ** 6

    def _keep_wait(self) -> float:
        """Seconds until the keep (A9) could be paid for, at the current income."""
        rg, rw = self._held()
        gr, wr = self._rates()
        return max(max(0.0, rg - self.budget[0]) / gr, max(0.0, rw - self.budget[1]) / wr)

    def _target(self):
        halls = sum(1 for s in self.structures() if s["type_id"] in HALLS)
        natural_planned = any(e.get("rule") == "B19" for e in self.events)
        return GOLD_PER_MINE * max(1, halls + (1 if natural_planned and halls < 2 else 0)) + WOOD_TARGET

    def _rt(self, rule):
        e = next(iter(self._fired(rule)), None)
        return self.rt[e["id"]] if e else {}

    # ---- the rules, every tick -------------------------------------------------------------------
    # ---- A10: gold is there, the hall/keep waits on lumber -------------------------------------
    def _track_income(self):
        p = self.obs["player"]
        if self._bank:
            self._got[0] += max(0, p["gold"] - self._bank[0])
            self._got[1] += max(0, p["lumber"] - self._bank[1])
        self._bank = (p["gold"], p["lumber"])
        self._income.append((self.t, *self._got))
        while self._income and self.t - self._income[0][0] > RATE_WINDOW:
            self._income.pop(0)

    def _rates(self):
        """Gold and lumber gathered per second lately (a floor keeps a slow start from dividing by zero)."""
        if len(self._income) < 2 or self._income[-1][0] - self._income[0][0] < 5:
            return 3.0, 1.0
        (t0, g0, w0), (t1, g1, w1) = self._income[0], self._income[-1]
        return max(0.3, (g1 - g0) / (t1 - t0)), max(0.2, (w1 - w0) / (t1 - t0))

    def _held(self):
        """What the hall (A8) and keep (A9) still need, whoever asks."""
        saved, self._cur_prio = self._cur_prio, -1
        try:
            return self._reserve()
        finally:
            self._cur_prio = saved

    def waiting_on_wood(self) -> bool:
        rg, rw = self._held()
        if rw <= self.budget[1]:
            return False
        gr, wr = self._rates()
        return (rw - self.budget[1]) / wr > max(0.0, rg - self.budget[0]) / gr

    def afford(self, g, w, reserve=True) -> bool:
        if super().afford(g, w, reserve) or not reserve:
            return super().afford(g, w, reserve)
        if self.budget[0] < g or self.budget[1] < w:
            return False  # cannot pay at all
        rg, rw = self._reserve()
        if not (rg or rw):
            return False
        gr, wr = self._rates()
        b0, b1 = self.budget
        wait = lambda gold, wood: max(max(0.0, rg - gold) / gr, max(0.0, rw - wood) / wr)
        now, after = wait(b0, b1), wait(b0 - g, b1 - w)
        if after > now + 0.5:
            return False
        eid = (self.ctx or (None, None))[1]
        if eid and eid not in self._borrowed:
            self._borrowed.add(eid)
            e = next((x for x in self.events if x["id"] == eid), {})
            short_w, short_g = max(0, rw - b1), max(0, rg - b0)
            self.note("A10", "先花钱：" + e.get("name", "?"),
                      f"分基地/二本在等资源（还差木 {short_w:.0f}、金 {short_g:.0f}，约 {now:.0f} 秒）；花掉 {g} 金 {w} 木后仍约 {after:.0f} 秒，不会更晚")
        return True

    def _decide(self) -> None:
        self._track_income()
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

    def _adopt(self):
        """A peasant with no job on our books but gathering (Warcraft put a finished builder to work)
        is booked where he works, so A1-A3 count him and nobody calls him idle."""
        for u in self.workers():
            uid, order = u["unit_id"], u.get("order") or {}
            if self.roles.get(uid) is not None or order.get("name") not in ("harvest", "resumeharvesting"):
                continue
            mine = self.mines.get(order.get("target_id"))
            if mine:
                where = "natural" if self.natural() is mine else "main"
                self.roles[uid], self.mine_of[uid] = "gold", where
                self.note("A2" if where == "natural" else "A1", f"农民{self.cid.get(uid, '?')} 记入{'分矿' if where == 'natural' else '主矿'}采金", "他已经在采金（建完后游戏让他就近采集）")
            else:
                self.roles[uid] = "wood"
                self.note("A3", f"农民{self.cid.get(uid, '?')} 记入伐木", "他已经在伐木（建完后游戏让他就近采集）")
            self._last_role[uid] = "wood" if self.roles[uid] == "wood" else ("natural" if self.mine_of.get(uid) == "natural" else "gold")

    def _builders_from_wood(self) -> int:
        """Peasants away building who go back to cutting afterwards: they still count as lumberjacks
        (no replacement is trained for a builder). The clear crew building at the natural does not:
        they become the natural's miners."""
        n = 0
        for job in self.jobs.values():
            if job.get("worker") is not None and self.roles.get(job["worker"]) == "build" and job.get("prior") in (None, "wood"):
                n += 1
            for uid, prior in (job.get("helper_prior") or {}).items():
                if self.roles.get(uid) == "build" and prior in (None, "wood"):
                    n += 1
        return n

    def _gold_heads(self, where):
        """Miners at that mine now plus those on their way: builders and peasants in training sent there."""
        n = sum(1 for u in self.workers() if self.roles.get(u["unit_id"]) == "gold" and self.mine_of.get(u["unit_id"], "main") == where)
        n += sum(1 for u in self.obs.get("inside", []) if self.roles.get(u["unit_id"]) == "gold" and self.mine_of.get(u["unit_id"], "main") == where)
        then = "natural" if where == "natural" else "gold"
        return n + sum(1 for e in self.events if e.get("then") == then and self.rt[e["id"]]["status"] != "done")

    def _standing(self):
        self._adopt()
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
        keep_wait = self._keep_wait() if keep_due else 0.0
        # A10: the main hall is kept free for the keep only when the keep can start before a peasant
        # (15 s) would be done; while the keep still waits on lumber the hall trains lumberjacks.
        hold_hall = keep_due and keep_wait < self.eco["hpea"]["time"] + 1
        avoid = [self.hall["unit_id"]] if hold_hall else []
        halls = [s for s in self.structures() if s["type_id"] in HALLS and s["unit_id"] not in avoid and not s.get("queue")
                 and not any(j.get("producer") == s["unit_id"] for j in self.jobs.values())]
        queued = len([e for e in self._open("A5") if not (self.jobs.get(e["id"]) or {}).get("producer")])
        # Who is short: each mine of its five, lumber of its target counting only peasants actually
        # cutting (militia, the clear crew and builders are away) plus those already in training for it.
        main_short = max(0, GOLD_PER_MINE - self._gold_heads("main"))
        nat_short = max(0, GOLD_PER_MINE - self._gold_heads("natural")) if self.natural_ready() else 0
        boost = self.waiting_on_wood()
        wood_target = WOOD_TARGET  # A3: lumberjacks plus builders from lumber, eight in all (the player)
        cutting = sum(1 for u in self.workers() if self.roles.get(u["unit_id"]) == "wood") + self._builders_from_wood()
        incoming = sum(1 for e in self._open("A5") if e.get("then") == "wood")
        wood_short = max(0, wood_target - cutting - incoming)
        if halls and queued < len(halls) and (main_short or nat_short or wood_short) and p["food_used"] < p["food_cap"]:
            then = "natural" if nat_short else "gold" if main_short else "wood"
            why = f"主矿采金差 {main_short}" + (f"，分矿差 {nat_short}" if self.natural_ready() else "") + f"，伐木 {cutting}+{incoming}/{wood_target}"
            if boost:
                why += "（分基地/二本在等木头，金子够：先补伐木，A10）"
            if keep_due and not hold_hall:
                why += f"；二本按采集速度还要等约 {keep_wait:.0f} 秒，主基地先训练农民（A10）"
            self._add("A5", "train", "训练农民 → " + {"gold": "采金", "wood": "伐木", "natural": "分矿采金"}[then],
                      why + ("；主基地留给二本" if hold_hall else ""), utype="hpea", then=then, avoid=avoid)
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
        s["arbiter"] = True
        s["decisions"] = self.decisions
        for e in self.events:  # accepted but never carried out: ordered 15 s ago, no sign of it in the game
            r = self.rt[e["id"]]
            confirm = {"build": "bStart", "train": "trainStart", "upgrade": "trainStart"}.get(e["kind"])
            r["unexecuted"] = bool(confirm and r.get("ordered") is not None and r.get(confirm) is None
                                   and r.get("status") != "done" and self.t - r["ordered"] > 15)
        s["arbEvents"] = [{k: e.get(k) for k in ("id", "rule", "name", "kind", "start", "why", "prio")} for e in self.events]
        clean = lambda x: {k: v for k, v in x.items() if k != "_action"}
        log = self.order_log
        s["orders"] = {
            "total": len(log),
            "untagged": [clean(x) for x in log if x["rule"] is None][-20:],
            "untaggedCount": sum(1 for x in log if x["rule"] is None),
            "repeats": [clean(x) for x in log if x.get("repeat")][-20:],
            "repeatCount": sum(1 for x in log if x.get("repeat")),
            "rejected": [clean(x) for x in log if x.get("rejected")][-20:],
            "recent": [clean(x) for x in log[-40:]],
            "byEvent": self._orders_by_event(),
        }
        return s

    def _orders_by_event(self):
        """The last few orders of each event, for the console's detail panel."""
        out: dict[str, list] = {}
        for x in self.order_log:
            if x.get("event"):
                out.setdefault(x["event"], []).append({k: x.get(k) for k in ("t", "cid", "command", "args", "rule", "rejected", "repeat", "dropped")})
        return {k: v[-12:] for k, v in out.items()}
