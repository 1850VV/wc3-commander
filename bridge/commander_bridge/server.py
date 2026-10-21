"""Local HTTP server: serves the console (web/) and connects it to a wc3env game.

  GET  /api/health    which backend is configured, whether a game is running
  GET  /api/plan      the plan the game is running (a console joining a running game adopts it)
  POST /api/plan      the console's timeline (groups of events)
  POST /api/control   {"action": "start", "start": 0} or {"action": "stop"}
                      or {"action": "tactic", "on": true|false}: run the plan or only watch
                      or {"action": "launch", "on": true|false}: test switch, see Runner.launch
  GET  /api/stream    server-sent events: {"type": "state"} snapshots, {"type": "log"} lines and
                      {"type": "plan"} when the bridge picks the plan itself (the console adopts it)
  GET  /api/feedback  the player's feedback on this game's arbiter decisions
  POST /api/feedback  {event, rule, action, t, score: "good"|"bad", prio: "up"|"down", comment, run?}: one more line
                      (run: a recorded game's id, for feedback given while replaying it)
  GET  /api/runs      recorded arbiter games, newest first
  GET  /api/runs/<id> one of them: meta, final state (decisions, orders, game events, consistency), frames, feedback
  GET  /api/strategies          saved strategies (name, time, start, event count)
  GET  /api/strategies/<name>   one saved strategy {name, saved, plan}
  PUT  /api/strategies/<name>   save the console plan in the body under that name
  GET  /api/script              the tactic script (strategies/战术脚本-人族速矿二本.txt): {text, model, errors}
  PUT  /api/script              {text} or {model}: check it and, without mistakes, save it ({dryRun: true} only checks)
  POST /api/script/preview      {text, start, from?}: play it on the fake world (about 10 s), or go on from the save point
                                before `from` when the script changed there (a few seconds); a recorded game + timeline

Binds to 127.0.0.1 unless --host says otherwise. There is no login: anyone who can reach the port
can start the game, so only open it to a trusted home network. Uses the standard library; wc3env
is the only dependency.
"""
from __future__ import annotations

import copy
import json
import math
import queue
import re
import threading
import time
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PureWindowsPath
from urllib.parse import unquote

from . import attach, strategies
from .data import load_data
from .arbiter import Arbiter
from . import script as tactic_script
from .script_runner import ScriptRunner
from .orchestrator import Orchestrator
from .engine import NATURALS, Commander

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / "bridge" / "runs"  # one folder per arbiter game: meta, state (decisions, orders, game events), frames, feedback, replay.w3g
RUN_NAME = re.compile(r"\d{8}-\d{6}-[a-z]+")
WEB = ROOT / "web"
MAX_BODY = 1 << 20
SCRIPT = strategies.STORE / "战术脚本-人族速矿二本.txt"  # the tactic script the console edits and attach mode plays
_UNSET = object()  # distinguishes "no name in the request" from an explicit null (no current layout)


class FakeGame:
    """What GameSession expects from a launched game, backed by wc3env's in-process FakeServer."""

    def __init__(self, map_name, server):
        from wc3env.rpc import LocalTransport, RpcClient

        self.map = map_name
        self.server = server
        self.rpc = RpcClient(LocalTransport(server))

    def close(self):
        try:
            self.rpc.quit()
        finally:
            self.rpc.close()


def make_session(backend: str, data: dict, start: int, opponent: str, window: str = "background", seed: int = 1,
                 speed_factor: float = 0.0, render: bool = True, human_slot: int = 0, restore=None, **world):
    from wc3env import GameConfig, GameSession, MatchSetup, PlayerConfig

    if backend == "fake":
        from wc3env.fake_server import FakeServer

        from .testworld import LostTempleWorld

        config = GameConfig(map="(4)LostTemple.w3m", players=(PlayerConfig(0, "human"), PlayerConfig(1, control="computer")), mode="stepping", step_ms=250)
        # world: test-only options; restore: a saved world to go on from (a preview's save point)
        server = FakeServer(world_factory=(lambda: restore) if restore is not None else (lambda: LostTempleWorld(data, start, **world)))
        session = GameSession(config, game_factory=lambda cfg: FakeGame(cfg.map, server))
        session.fake_server = server  # the preview saves its world
        return session
    # The start point is the player slot on Lost Temple: slot 0 south, 1 west, 2 north, 3 east. Put the
    # human at the requested slot; every other slot is an agent (AI off) so the map's default computer
    # in slot 1 cannot attack from its own base.
    others = [s for s in range(4) if s != human_slot]
    players = [PlayerConfig(human_slot, "human")]
    difficulty = None
    if opponent != "none":
        players.append(PlayerConfig(others[0], control="computer"))
        difficulty = {"easy": 0, "normal": 1, "insane": 2}[opponent]
    else:
        for s in others:
            players.append(PlayerConfig(s, control="agent"))
    # "background" keeps a visible window that does not pause when you switch to the browser;
    # "interactive" is the normal game window (you can play, but it may pause without focus).
    # speed_factor > 1 is a test switch: stepping mode plus wc3env's debug clock, so the console at
    # :8790 follows the same game at N times speed.
    stepping = speed_factor > 1 and window != "interactive"
    config = GameConfig(map="(4)LostTemple.w3m", players=players,
                        mode="stepping" if stepping else "realtime",
                        window_mode=window, background_visible=window == "background" and render, render=render,
                        ai_difficulty=difficulty, setup=MatchSetup(seed=seed),
                        **({"step_ms": 250} if stepping else {}))
    return GameSession(config)


def frame_of(s: dict) -> dict:
    """One second of a game for the console's replay: resources, units and buildings."""
    return {"t": s["t"], "gold": s["gold"], "wood": s["wood"], "foodUsed": s["foodUsed"], "foodCap": s["foodCap"],
            "units": [{k: (round(v) if k in ("x", "y") else v) for k, v in u.items() if k in ("id", "type", "x", "y", "hidden", "task", "role")} for u in s["units"]],
            "buildings": [{k: (round(v, 2) if k == "progress" else round(v) if k in ("x", "y") else v) for k, v in b.items() if k in ("id", "type", "x", "y", "done", "progress")} for b in s["buildings"]]}


# A troll camp at each start's natural for the preview: the fake world has no creeps of its own.
PREVIEW_CAMP = ((0, 0, "nftr"), (-60, 70, "nfsp"), (60, -50, "nftr"))
_preview_lock = threading.Lock()


SAVE_EVERY = 10.0  # seconds of game between save points of a preview
_previews: dict[int, dict] = {}  # start -> the last preview there: its text, frames and save points


def _snap(world, c, obs, data):
    """A save point: the fake game's world, the commander and the observation it was about to read.
    The static map data is shared, not copied."""
    return copy.deepcopy((world, c, obs), {id(data): data})


def timeline_of(c, data) -> dict:
    """What the console's timeline draws: each lane's steps with when they began, went to work and
    finished (from the decision record and the events), the places, and where the mines are."""
    starts = {}
    for d in c.decisions:
        m = re.match(r"第 (\d+) 行第 (\d+) 步", d.get("why") or "")
        if m and "：" in d["action"]:
            starts.setdefault(d["action"].split("：")[0], {}).setdefault(int(m[2]) - 1, d["t"])
    by_step = {}
    for e in c.events:
        if e.get("phase") is not None and e.get("step") is not None:
            by_step[(e["phase"], e["step"])] = (e, c.rt.get(e["id"], {}))
    lanes = []
    for L in sorted(c.lanes, key=lambda x: (x["line"], x["label"])):
        ss, steps = starts.get(L["label"], {}), []
        for k, st in enumerate(L["steps"]):
            nxt = next((ss[j] for j in range(k + 1, len(L["steps"])) if j in ss), None)
            step = {"raw": st["raw"], "start": ss.get(k), "end": nxt}
            ev = by_step.get((L["label"], k))
            if ev:
                e, rt = ev
                for a, b in (("bStart", "work"), ("trainStart", "work"), ("aEnd", "done")):
                    if rt.get(a) is not None:
                        step[b] = rt[a]
                if rt.get("builtAt") or e.get("site"):
                    step["at"] = rt.get("builtAt") or e.get("site")
                if step["end"] is None and step.get("done") is not None:
                    step["end"] = step["done"]
            steps.append(step)
        lanes.append({"label": L["label"], "kind": L["kind"], "line": L["line"], "steps": steps, "dead": L["dead"]})
    for ln in c.model.get("lanes", []):  # paused lanes: shown greyed, no times
        if not ln.get("muted"):
            continue
        labels = ([f"农民{x}" for x in ln["cids"]] if ln["kind"] == "peasant" else [c.eco[ln["hero"]]["name"]] if ln["kind"] == "hero"
                  else ["步兵"] if ln["kind"] == "army" else ["#" + ln["tag"] if ln.get("tag") else c.eco[ln["btype"]]["name"]])
        for label in labels:
            lanes.append({"label": label, "kind": ln["kind"], "line": ln["line"], "muted": True, "dead": False,
                          "steps": [{"raw": st["raw"], "start": None, "end": None} for st in ln["steps"]]})
    lanes.sort(key=lambda x: x["line"])
    places = {}
    for q in c.model.get("positions", []):
        try:
            p = c._pos.get(q["name"]) or c._resolve(q["expr"])
        except (KeyError, IndexError, TypeError):
            p = None
        if p:
            places[q["name"]] = [round(p["x"]), round(p["y"])]
    mine = min(data["mines"], key=lambda m: math.hypot(m["x"] - c.hall["x"], m["y"] - c.hall["y"]))
    return {"lanes": lanes, "places": places, "hall": [c.hall["x"], c.hall["y"]], "mine": [mine["x"], mine["y"]],
            "natural": list(c.natural_at) if c.natural_at else None, "mineGold": mine["gold"],
            "units": {str(c.cid[u["unit_id"]]): u["type_id"] for u in c.units() if u["unit_id"] in c.cid}}


def preview_script(data: dict, text: str, start: int, seconds: float = 600.0, resume_from: float | None = None) -> dict:
    """Play a tactic script on the fake Lost Temple world (fast, no game) and return it as a recorded
    game: one frame per second, the final state and the timeline. The console opens it like a replay.

    Every SAVE_EVERY seconds the game is saved. Asked to resume from a moment (the player changed
    the script there), it restarts from the last save point before it, keeping everything before:
    a few seconds instead of a full run. If the change touches steps that had already begun by then,
    it plays from the start instead and says so. The fake world's numbers are rough, so these times
    are a preview, not a promise."""
    model, errors = tactic_script.parse(text)
    if errors:
        return {"ok": False, "errors": errors}
    name = "人族速矿二本 · " + data["starts"][start]["name"]
    plan = strategies.load(name)["plan"]
    nx, ny = NATURALS[start]
    camp = [{"type": t, "x": nx + 280 + dx, "y": ny + 230 + dy, "hp": 240 if t == "nftr" else 200, "dps": 6 if t == "nftr" else 4}
            for dx, dy, t in PREVIEW_CAMP]
    t_begin = time.time()
    with _preview_lock:  # one at a time: each takes a few seconds of CPU
        prev, point, note = _previews.get(start), None, ""
        if resume_from is not None and prev and prev["layout"] == plan.get("groups"):
            point = next((p for p in reversed(prev["points"]) if p[0] <= resume_from + 1e-6), None)
        if point:
            world, c, obs = copy.deepcopy(point[1], {id(data): data})
            bad = c.reload_script(text)
            if bad:
                note, point = "从头算（" + "；".join(bad[:2]) + "）", None
        if point:
            session = make_session("fake", data, start, "none", restore=world)
            session.reset()  # the world as saved; its first observation is the one saved with it
            frames = [f for f in prev["frames"] if f["t"] < point[0]]
            points = [p for p in prev["points"] if p[0] <= point[0]]
            next_frame, next_save = (frames[-1]["t"] + 1 if frames else 0.0), point[0] + SAVE_EVERY
            resumed = point[0]
        else:
            c = ScriptRunner(data)
            c.set_plan(dict(plan, script=text, start=start))
            session = make_session("fake", data, start, "none", creeps=camp)
            obs = session.reset()[0]
            frames, points, next_frame, next_save, resumed = [], [], 0.0, 0.0, None
        try:
            while obs["game_time_seconds"] < seconds:
                if obs["game_time_seconds"] >= next_save:
                    points.append((obs["game_time_seconds"], _snap(session.fake_server.world, c, obs, data)))
                    next_save += SAVE_EVERY
                actions = c.tick(obs)
                if c.t >= next_frame:
                    f = frame_of(c.snapshot())
                    f["got"] = [round(c._got[0]), round(c._got[1])]
                    frames.append(f)
                    next_frame = int(c.t) + 1
                observations, done, info = session.step({0: actions}, ms=250)
                c.feedback(actions, info["placements"][0], info["rejected"][0])
                obs = observations[0]
            c.tick(obs)
        finally:
            session.close()
        _previews[start] = {"layout": plan.get("groups"), "text": text, "frames": frames, "points": points}
    snap = c.snapshot()
    last = frame_of(snap)
    last["got"] = [round(c._got[0]), round(c._got[1])]
    frames.append(last)
    state = dict(snap, consistency=c.consistency())
    return {"ok": True, "errors": [], "layout": name, "t": snap["t"], "decisions": c.decisions, "script": snap["script"],
            "gold": snap["gold"], "wood": snap["wood"], "foodUsed": snap["foodUsed"], "foodCap": snap["foodCap"],
            "meta": {"name": "预演 · " + data["starts"][start]["name"], "start": start, "preview": True}, "state": state, "frames": frames,
            "timeline": timeline_of(c, data), "resumedFrom": resumed, "note": note, "seconds": round(time.time() - t_begin, 1)}


class Runner:
    """Owns the game session on one thread; the HTTP threads only post plans and read snapshots."""

    def __init__(self, backend: str, speed: float, opponent: str, window: str = "background", seed: int = 1, launch: bool = False,
                 speed_factor: float = 0.0, render: bool = True, human_slot: int = 0):
        self.backend, self.speed, self.opponent, self.window, self.seed = backend, speed, opponent, window, seed
        self.human_slot = human_slot  # start point on Lost Temple = player slot (0 south, 1 west, 2 north, 3 east)
        self.speed_factor = speed_factor  # test switch: >1 plays the real game N times faster (stepping mode)
        # Stepping freezes the game between steps, which also freezes the mouse/keyboard. A window the
        # player is meant to use (interactive) therefore runs in realtime and takes its speed from the
        # hook's clock instead; stepping stays for unattended tests where nobody moves the camera.
        self.stepping = backend == "wc3env" and speed_factor > 1 and window != "interactive"
        self.render = render  # test switch: off = no game window, which is much faster at high speed factors
        # Test switch, off by default: on, 「连接」 launches Warcraft and creates the game itself (the old
        # way, for unattended checks). Off, it waits for a game the player starts (attach.py). The fake
        # backend always launches.
        self.launch = launch
        self.waiting = False
        self.attached: int | None = None  # War3 pid whose current game the commander is playing
        self.data = load_data()
        self.lock = threading.Lock()
        self.commander = Commander(self.data)
        self.plan: dict = {"groups": []}
        self.plan_name: str | None = None  # the saved layout the plan came from (the console shows it)
        self.state: dict = self.commander.snapshot()
        self.thread: threading.Thread | None = None
        self.stop_flag = threading.Event()
        self.listeners: list[queue.Queue] = []
        self.running = False
        self.tactic = True  # the plan runs as soon as the game is connected; the console can switch it off

    def new_commander(self):
        """The rule-driven arbiter (docs/规则表-人族速矿二本.md) for a plan marked "arbiter", else the timeline.
        Each arbiter game gets its own folder under bridge/runs for its record and the player's feedback."""
        arbiter = bool(self.plan.get("arbiter") or self.plan.get("orchestration") or self.plan.get("script"))
        start = self.plan.get("start")
        side = ("south", "west", "north", "east")[start] if isinstance(start, int) and 0 <= start < 4 else "plan"
        self.run_dir = RUNS / (time.strftime("%Y%m%d-%H%M%S") + "-" + side) if arbiter else None  # ASCII: Warcraft writes the replay here
        self._saved, self._next_frame = 0.0, 0.0
        if arbiter:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            meta = {"name": self.plan_name, "start": start, "began": time.strftime("%Y-%m-%dT%H:%M:%S"), "backend": self.backend,
                    "speed": self.speed_factor if self.launch else 1.0, "launch": self.launch}
            (self.run_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        if self.plan.get("script"):
            return ScriptRunner(self.data)
        return (Orchestrator if self.plan.get("orchestration") else Arbiter if arbiter else Commander)(self.data)

    def record(self) -> None:
        """Each tick of an arbiter game: one frame per game second for the console's replay, and the state now and then."""
        if not getattr(self, "run_dir", None) or not self.state.get("arbiter"):
            return
        s = self.state
        if s["t"] >= self._next_frame:
            self._next_frame = int(s["t"]) + 1
            frame = frame_of(s)
            try:
                with (self.run_dir / "frames.jsonl").open("a", encoding="utf-8") as f:
                    f.write(json.dumps(frame, ensure_ascii=False) + "\n")
            except OSError:
                traceback.print_exc()
        self.persist()

    def save_replay(self, rpc) -> None:
        """Warcraft's own replay of this game, next to our record and in the game's Replay\\commander folder."""
        if not getattr(self, "run_dir", None):
            return
        path = (self.run_dir / "replay.w3g").resolve()
        try:
            rpc.save_replay(str(path))
            from wc3env.settings import settings
            import shutil
            target = settings().game_dir / "Replay" / "commander" / (self.run_dir.name + ".w3g")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            self.log(f"魔兽录像已保存：Replay\\commander\\{target.name}")
        except Exception as exc:  # the record still stands without it
            self.log(f"没能保存魔兽录像：{exc}", "error")

    def persist(self, force=False) -> None:
        """Write the arbiter game's state (decisions, order audit, events) every few seconds."""
        if not getattr(self, "run_dir", None) or not self.state.get("arbiter") or (not force and time.time() - self._saved < 5):
            return
        self._saved = time.time()
        try:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            data = dict(self.state)
            if hasattr(self.commander, "consistency"):
                data["consistency"] = self.commander.consistency()
                data["gameEvents"] = self.commander.game_events
            (self.run_dir / "state.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except OSError:
            traceback.print_exc()

    def _run_folder(self, run: str | None):
        """A recorded game's folder: the named one (replay) or the current game's."""
        if run:
            if not RUN_NAME.fullmatch(run) or not (RUNS / run).is_dir():
                raise ValueError("没有这一局的记录")
            return RUNS / run
        if not getattr(self, "run_dir", None):
            raise ValueError("这局不是仲裁器在打，没有决策可以评价")
        return self.run_dir

    def add_feedback(self, item: dict) -> list:
        d = self._run_folder(item.get("run"))
        row = {k: item.get(k) for k in ("event", "rule", "action", "t", "score", "prio", "comment")}
        row["at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        d.mkdir(parents=True, exist_ok=True)
        with (d / "feedback.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return self.feedback(item.get("run"))

    def feedback(self, run: str | None = None) -> list:
        try:
            p = self._run_folder(run) / "feedback.jsonl"
        except ValueError:
            return []
        return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()] if p.is_file() else []

    @staticmethod
    def runs() -> list[dict]:
        out = []
        for d in sorted((d for d in RUNS.iterdir() if d.is_dir() and RUN_NAME.fullmatch(d.name)), reverse=True) if RUNS.is_dir() else []:
            try:
                meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                meta = {}
            fb = d / "feedback.jsonl"
            out.append({"id": d.name, **meta, "replay": (d / "replay.w3g").is_file(), "hasState": (d / "state.json").is_file(),
                        "feedback": sum(1 for line in fb.read_text(encoding="utf-8").splitlines() if line.strip()) if fb.is_file() else 0})
        return out

    def load_run(self, run: str) -> dict:
        d = self._run_folder(run)
        state = json.loads((d / "state.json").read_text(encoding="utf-8")) if (d / "state.json").is_file() else {}
        frames = [json.loads(line) for line in (d / "frames.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()] if (d / "frames.jsonl").is_file() else []
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8")) if (d / "meta.json").is_file() else {}
        return {"id": run, "meta": meta, "state": state, "frames": frames, "feedback": self.feedback(run), "replay": (d / "replay.w3g").is_file()}

    def log(self, text: str, level: str = "info") -> None:
        for q in list(self.listeners):
            q.put({"type": "log", "level": level, "text": text})

    def publish_plan(self) -> None:
        for q in list(self.listeners):
            q.put({"type": "plan", "plan": self.plan, "name": self.plan_name})

    def set_plan(self, plan: dict, name=_UNSET) -> None:
        with self.lock:
            self.plan = plan
            if name is not _UNSET:  # the console tells us which saved layout it is editing
                self.plan_name = name
            self.commander.set_plan(plan)

    def live_script(self) -> dict | None:
        """The tactic script the game is playing now (None: this game does not play one)."""
        with self.lock:
            c = self.commander
            if not self.running or not hasattr(c, "reload_script"):
                return None
            return {"text": tactic_script.to_text(c.model), "model": c.model}

    def reload_script(self, text: str) -> list[str]:
        """A script changed in the console during the game: it takes over from the next tick. Lanes
        keep their progress; steps already begun cannot change (the errors say which)."""
        with self.lock:
            c = self.commander
            if not self.running or not hasattr(c, "reload_script"):
                return ["现在没有按战术脚本进行的游戏"]
            errors = c.reload_script(text)
            if not errors:
                self.plan = dict(self.plan, script=text)
                c.note("脚本", "战术脚本在实战中更新", "控制台改了脚本：已经开始的步骤不变，后面的按新脚本执行")
                self.state = c.snapshot()
        if not errors:
            self.log("战术脚本已更新，从现在起按新脚本执行")
        return errors

    def set_tactic(self, on: bool) -> None:
        """Switch the plan on or off without leaving the game; off only watches."""
        with self.lock:
            self.tactic = on
            self.commander.enabled = on
            self.state = self.commander.snapshot()
        self.log("战术已开启：按时间轴执行" if on else "战术已关闭：只观察，不下命令")

    def start(self, start: int) -> None:
        self.stop()
        self.stop_flag.clear()
        attached = self.backend == "wc3env" and not self.launch
        if not (attached and self.attached):  # reconnecting to the game we were playing keeps its progress
            with self.lock:
                self.commander = self.new_commander()
                self.commander.set_plan(self.plan)
                self.commander.enabled = self.tactic = True  # every new game starts with the tactic on
        errors = getattr(self.commander, "errors", None)
        if errors:  # an orchestration with mistakes: say where, play nothing
            for e in errors:
                self.log("编排有错：" + e, "error")
            self.log("编排文件有错，这局不开打。改好后再点「连接」", "error")
            return
        self.thread = threading.Thread(target=self._attach if attached else self._run, args=() if attached else (start,), daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_flag.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=15)
        self.thread = None

    def _run(self, start: int) -> None:
        if self.backend == "wc3env":
            # The game starts at the player slot, and that slot decides the layout and checkpoints.
            # A start saved in the layout file may be stale: use the real direction instead.
            start = self.human_slot
            with self.lock:
                self.plan["start"] = start
            self.publish_plan()
        session = None
        try:
            self.log("正在启动魔兽争霸三…" if self.backend == "wc3env" else "正在启动假游戏服务器（失落神庙测试世界）")
            session = make_session(self.backend, self.data, start, self.opponent, self.window, self.seed,
                                   self.speed_factor, self.render, self.human_slot)
            obs = session.reset()[self.human_slot]  # the reset/step maps are keyed by player slot
            if self.backend == "wc3env" and self.speed_factor > 1:
                if self.render:
                    try:  # stepping tests get a small window; a playable one stays readable
                        w, h = (1280, 720) if self.stepping else (1600, 900)
                        session.game.resize(w, h)
                        self.log(f"加速窗口 {w}×{h}")
                    except Exception as exc:
                        self.log(f"缩小游戏窗口失败：{exc}", "error")
                session.game.rpc.debug("speed", factor=self.speed_factor)  # test switch: fast-forward the game clock
                self.log(f"加速 {self.speed_factor:g}×（{'步进' if self.stepping else '实时，可操作视角'}）")
            self.running = True
            self.log("已连接，开始按时间轴执行")
            step_ms = max(25, int(round(250 * self.speed / 25)) * 25)
            while not self.stop_flag.is_set():
                tick_start = time.perf_counter()
                with self.lock:
                    actions = self.commander.tick(obs)
                    self.state = self.commander.snapshot()
                self.record()
                batches = {slot: [] for slot in session.config.agent_slots}  # every agent slot needs a batch
                batches[self.human_slot] = actions  # ours is the human's slot, not necessarily 0
                if self.backend == "fake":
                    observations, done, info = session.step(batches, ms=step_ms)
                elif self.stepping:
                    observations, done, info = session.step(batches, ms=min(4000, int(250 * self.speed_factor)))
                else:
                    observations, done, info = session.step(batches)
                obs = observations[self.human_slot]
                with self.lock:
                    self.commander.feedback(actions, info.get("placements", {}).get(self.human_slot, []), info.get("rejected", {}).get(self.human_slot, []))
                for r in info.get("rejected", {}).get(self.human_slot, []):
                    a = actions[r["index"]]
                    self.log(f"游戏拒绝了命令 {a['command']}（{r['reason']}）", "error")
                if done:
                    self.log("本局结束")
                    break
                time.sleep(max(0.0, 0.25 - (time.perf_counter() - tick_start)))
        except Exception as exc:  # report to the console; the HTTP server keeps running
            traceback.print_exc()
            self.log(f"连接出错：{exc}", "error")
        finally:
            self.running = False
            self.persist(force=True)
            if session is not None:
                if self.backend == "wc3env":
                    self.save_replay(session.game.rpc)
                session.close()


    # ---- a game the player started (attach.py) ---------------------------------------------------
    def _attach(self) -> None:
        """Wait, as long as it takes, for any Warcraft, then for a game in it; survive pauses and drops."""
        self.waiting = True
        self.log("正在等待魔兽争霸三：打开游戏后会自动接入，开局后自动接管；中途切屏、暂停都没关系")
        seen: dict[int, float] = {}  # War3 pid -> when first seen without a hook
        told: set[int] = set()  # pids whose problem was already explained once
        try:
            while not self.stop_flag.is_set():
                game = self._find_game(seen, told)
                if game is None:
                    self.stop_flag.wait(2)
                    continue
                try:
                    self._play_attached(game)
                except TimeoutError:
                    self.log("魔兽暂时没有回应（可能在加载或切屏了），稍后自动接上")
                except Exception as exc:  # Warcraft closed or the pipe broke: wait for it again
                    traceback.print_exc()
                    gone = game.pid not in attach.war3_pids()
                    self.log("魔兽已关闭，继续等待" if gone else f"和魔兽的连接中断了（{exc}），稍后自动接上")
                    if gone:
                        self.attached = None
                finally:
                    self.running = False
                    game.close()
                self.stop_flag.wait(1)
        finally:
            self.waiting = False

    def _find_game(self, seen: dict[int, float], told: set[int]):
        hooked = attach.hooked_pids()
        for pid in attach.war3_pids():
            if pid in hooked:
                try:
                    return attach.AttachedGame(attach.connect(pid), pid)
                except (OSError, TimeoutError):
                    continue  # still starting, or another client holds it
            # Without a hook: give it one. Not straight away: the shortcut's own launch needs a moment
            # to create its pipe (a second hook would refuse to load anyway).
            first = seen.setdefault(pid, time.monotonic())
            if pid in told or time.monotonic() - first < 5:
                continue
            try:
                if attach.inject(pid):
                    self.log(f"发现魔兽（进程 {pid}），已装上指挥官组件")
                else:
                    told.add(pid)
                    self.log(f"魔兽（进程 {pid}）没能装上指挥官组件", "error")
            except PermissionError:
                told.add(pid)
                self.log(f"魔兽（进程 {pid}）是以管理员权限运行的，指挥官服务没有权限接入它。"
                         "关掉它后用桌面上的「魔兽争霸三（指挥官）」打开，或者让指挥官服务也以管理员权限运行", "error")
            except Exception as exc:
                told.add(pid)
                traceback.print_exc()
                self.log(f"给魔兽（进程 {pid}）装组件出错：{exc}", "error")
        return None

    def _play_attached(self, game: attach.AttachedGame) -> None:
        note = None
        while not self.stop_flag.is_set():  # the hook freezes a new game at 0:01 until we take it
            info = game.rpc.info()
            status = game.rpc.status
            if status == "in_game" or (status == "launched" and info.get("held")):
                break
            text = "已接入魔兽，等你开始一局游戏…" if status == "launched" else "这局已经结束，等你开下一局…"
            if text != note:
                self.log(text)
                note = text
            self.stop_flag.wait(1)
        if self.stop_flag.is_set():
            return
        info = game.rpc.info()
        resumed = game.rpc.status == "in_game"
        obs = game.take_over()
        self.running = True
        if resumed and self.attached == game.pid:  # same game after a drop: keep the plan's progress
            self.log("重新接上了，继续执行")
        else:
            self._choose_plan(obs, info.get("map") or "", resumed)
            self.attached = game.pid
        while not self.stop_flag.is_set():
            tick_start = time.perf_counter()
            with self.lock:
                actions = self.commander.tick(obs)
                self.state = self.commander.snapshot()
            self.record()
            obs, done, ack = game.step(actions)
            with self.lock:
                self.commander.feedback(actions, ack.get("placements", []), ack.get("rejected", []))
            for r in ack.get("rejected", []):
                self.log(f"游戏拒绝了命令 {actions[r['index']]['command']}（{r['reason']}）", "error")
            if done:
                with self.lock:
                    self.commander.tick(obs)
                    self.state = self.commander.snapshot()
                self.attached = None
                self.persist(force=True)
                self.save_replay(game.rpc)
                self.log("本局结束，等你开下一局")
                return
            time.sleep(max(0.0, 0.25 - (time.perf_counter() - tick_start)))

    def _choose_plan(self, obs: dict, map_name: str, resumed: bool) -> None:
        """Lost Temple: the fast-expand strategy for our start, tactic on. Anything else: watch only."""
        base = PureWindowsPath(map_name).name if map_name else "地图名未知"
        start, off = attach.start_of(obs, self.data["starts"])
        why = None
        # The map name is unknown when the hook was loaded into a game already running (inject_running.py):
        # then a town hall sitting on a Lost Temple start location is the evidence.
        if map_name and not attach.is_lost_temple(map_name):
            why = f"地图「{base}」名字里没有 Lost Temple"
        elif start is None:
            why = "没找到你的人族城镇大厅（这套战术只支持人族）"
        elif off > attach.START_MATCH:
            why = f"城镇大厅离最近的出生点 {off:.0f}，对不上失落神庙的出生点"
        plan = None
        name = None
        if why is None:
            name = "人族速矿二本 · " + self.data["starts"][start]["name"]
            try:
                plan = strategies.load(name)["plan"]
                plan["start"] = start  # the detected direction wins over a stale start saved in the layout
                plan["arbiter"] = True  # played by the rule table (arbiter.py), recorded for replay in bridge/runs
                orch = strategies.STORE / "编排-人族速矿二本.md"
                if SCRIPT.is_file():  # the player's tactic script wins over the orchestration and the built-in rules
                    plan["script"] = SCRIPT.read_text(encoding="utf-8")
                elif orch.is_file():  # the player's own orchestration wins over the built-in rules
                    plan["orchestration"] = orch.read_text(encoding="utf-8")
            except (FileNotFoundError, ValueError):
                why = f"找不到策略「{name}」"
        with self.lock:
            if plan is not None:
                self.plan = plan
                self.plan_name = name
            self.commander = self.new_commander()
            self.commander.set_plan(self.plan)
            errors = getattr(self.commander, "errors", None)
            if errors and why is None:
                why = "编排文件有错（" + "；".join(errors[:3]) + "）"
                plan = None
            self.commander.enabled = self.tactic = why is None
            self.state = self.commander.snapshot()
        if plan is not None:
            self.publish_plan()
            verb = "重新接上" if resumed else "已接管"
            self.log(f"{verb}：{base}，出生点{self.data['starts'][start]['name']}，已套用「{name}」，战术已开启")
        else:
            self.log(f"已接管：{why}。战术已关闭，只观察不下命令", "error")


class Handler(SimpleHTTPRequestHandler):
    runner: Runner

    def log_message(self, fmt, *args):  # keep the terminal quiet except for errors
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def end_headers(self):
        # The console is edited in place. Without this a browser may keep old HTML next to new
        # app.js (or the reverse), and a plain refresh then shows a page that half exists.
        if not self.path.startswith("/api/"):
            self.send_header("cache-control", "no-store")
        super().end_headers()

    def _json(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self) -> dict:
        n = int(self.headers.get("content-length") or 0)
        if n > MAX_BODY:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path == "/api/health":
            r = self.runner
            return self._json(200, {"ok": True, "backend": r.backend, "running": r.running, "tactic": r.tactic,
                                    "launch": r.launch or r.backend == "fake", "waiting": r.waiting,
                                    "speed": r.speed_factor, "render": r.render})
        if self.path == "/api/stream":
            return self._stream()
        if self.path == "/api/plan":
            with self.runner.lock:
                return self._json(200, {"ok": True, "plan": self.runner.plan, "name": self.runner.plan_name,
                                        "running": self.runner.running})
        if self.path == "/api/feedback":
            return self._json(200, {"ok": True, "feedback": self.runner.feedback(),
                                    "run": self.runner.run_dir.name if getattr(self.runner, "run_dir", None) else None})
        if self.path == "/api/runs":
            return self._json(200, {"ok": True, "runs": self.runner.runs()})
        if self.path.startswith("/api/runs/"):
            try:
                return self._json(200, {"ok": True, **self.runner.load_run(unquote(self.path[len("/api/runs/"):]))})
            except ValueError as exc:
                return self._json(404, {"ok": False, "error": str(exc)})
        if self.path == "/api/script/live":
            j = self.runner.live_script()
            return self._json(200, {"ok": True, **j} if j else {"ok": False, "error": "现在没有按战术脚本进行的游戏"})
        if self.path == "/api/script":
            text = SCRIPT.read_text(encoding="utf-8") if SCRIPT.is_file() else ""
            model, errors = tactic_script.parse(text)
            return self._json(200, {"ok": True, "text": text, "model": model, "errors": errors})
        if self.path == "/api/strategies":
            return self._json(200, {"ok": True, "strategies": strategies.list_all()})
        if self.path.startswith("/api/strategies/"):
            try:
                return self._json(200, {"ok": True, **strategies.load(unquote(self.path[len("/api/strategies/"):]))})
            except FileNotFoundError:
                return self._json(404, {"ok": False, "error": "没有这个策略"})
            except ValueError as exc:
                return self._json(400, {"ok": False, "error": str(exc)})
        return super().do_GET()

    def do_PUT(self):
        if self.path == "/api/script":
            try:
                body = self._body()
            except (ValueError, json.JSONDecodeError):
                return self._json(400, {"ok": False, "error": "请求不是有效的 JSON"})
            text = body["text"] if isinstance(body.get("text"), str) else None
            if text is None and isinstance(body.get("model"), dict):
                try:
                    text = tactic_script.to_text(body["model"])
                except (KeyError, TypeError, StopIteration) as exc:
                    return self._json(400, {"ok": False, "error": f"脚本内容不完整：{exc!r}"})
            if text is None:
                return self._json(400, {"ok": False, "error": "要给 text 或 model"})
            model, errors = tactic_script.parse(text)
            if errors or body.get("dryRun"):
                return self._json(200, {"ok": not errors, "saved": False, "text": text, "model": model, "errors": errors})
            SCRIPT.write_text(text, encoding="utf-8")
            return self._json(200, {"ok": True, "saved": True, "text": text, "model": model, "errors": []})
        if not self.path.startswith("/api/strategies/"):
            return self._json(404, {"ok": False})
        try:
            saved = strategies.save(unquote(self.path[len("/api/strategies/"):]), self._body())
        except json.JSONDecodeError:
            return self._json(400, {"ok": False, "error": "请求不是有效的 JSON"})
        except ValueError as exc:
            return self._json(400, {"ok": False, "error": str(exc)})
        return self._json(200, {"ok": True, **saved})

    def do_POST(self):
        try:
            body = self._body()
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"ok": False, "error": "请求不是有效的 JSON"})
        if self.path == "/api/script/preview":
            text = body.get("text") if isinstance(body.get("text"), str) else (SCRIPT.read_text(encoding="utf-8") if SCRIPT.is_file() else "")
            start = body.get("start", 0)
            if not isinstance(start, int) or not 0 <= start < len(self.runner.data["starts"]):
                return self._json(400, {"ok": False, "error": "出生点不对"})
            try:
                frm = body.get("from")
                frm = float(frm) if isinstance(frm, (int, float)) and not isinstance(frm, bool) else None
                return self._json(200, preview_script(self.runner.data, text, start, float(body.get("seconds") or 600), resume_from=frm))
            except FileNotFoundError:
                return self._json(400, {"ok": False, "error": "这个出生点还没有布局（人族速矿二本 · 方向）"})
            except ImportError as exc:
                return self._json(500, {"ok": False, "error": f"预演要用 wc3env 的假游戏：{exc}"})
        if self.path == "/api/script/live":
            if not isinstance(body.get("text"), str):
                return self._json(400, {"ok": False, "error": "要给 text"})
            errors = self.runner.reload_script(body["text"])
            return self._json(200, {"ok": not errors, "errors": errors})
        if self.path == "/api/plan":
            self.runner.set_plan(body, body.get("name", _UNSET))
            return self._json(200, {"ok": True, "events": len(self.runner.commander.events)})
        if self.path == "/api/feedback":
            try:
                return self._json(200, {"ok": True, "feedback": self.runner.add_feedback(body)})
            except ValueError as exc:
                return self._json(400, {"ok": False, "error": str(exc)})
        if self.path == "/api/control":
            action = body.get("action")
            if action == "start":
                self.runner.start(int(body.get("start") or 0))
            elif action == "stop":
                threading.Thread(target=self.runner.stop, daemon=True).start()
            elif action == "tactic":
                self.runner.set_tactic(bool(body.get("on", True)))
            elif action == "launch":
                self.runner.launch = bool(body.get("on", False))
            else:
                return self._json(400, {"ok": False, "error": "未知操作"})
            return self._json(200, {"ok": True})
        return self._json(404, {"ok": False})

    def _stream(self):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        q: queue.Queue = queue.Queue()
        self.runner.listeners.append(q)
        try:
            while True:
                try:
                    msg = q.get(timeout=0.25)
                except queue.Empty:
                    with self.runner.lock:
                        msg = {"type": "state", "state": self.runner.state}
                self.wfile.write(b"data: " + json.dumps(msg, ensure_ascii=False).encode() + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.runner.listeners.remove(q)


def lan_addresses() -> list[str]:
    """This machine's home-network IPv4 addresses (192.168.x.x, 10.x.x.x). 172.16-31.x.x is left out:
    on Windows those are usually Hyper-V/WSL virtual switches nobody else can reach."""
    import socket

    try:
        ips = socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        return []
    return sorted(ip for ip in set(ips) if ip.startswith(("192.168.", "10.")))


def serve(backend: str = "fake", port: int = 8790, speed: float = 1.0, opponent: str = "none", window: str = "background", seed: int = 1,
          host: str = "127.0.0.1", launch: bool = False, speed_factor: float = 0.0, render: bool = True, human_slot: int = 0) -> None:
    runner = Runner(backend, speed, opponent, window, seed, launch, speed_factor, render, human_slot)
    handler = partial(type("BoundHandler", (Handler,), {"runner": runner}), directory=str(WEB))
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    print(f"指挥官控制台：http://127.0.0.1:{port}/  （后端：{backend}，Ctrl+C 退出）")
    if host != "127.0.0.1":
        for ip in lan_addresses():
            print(f"局域网访问：http://{ip}:{port}/  （没有登录保护，只在信任的家庭网络里打开）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop()
        httpd.server_close()

