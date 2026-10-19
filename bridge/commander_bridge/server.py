"""Local HTTP server: serves the console (web/) and connects it to a wc3env game.

  GET  /api/health    which backend is configured, whether a game is running
  GET  /api/plan      the plan the game is running (a console joining a running game adopts it)
  POST /api/plan      the console's timeline (groups of events)
  POST /api/control   {"action": "start", "start": 0} or {"action": "stop"}
                      or {"action": "tactic", "on": true|false}: run the plan or only watch
                      or {"action": "launch", "on": true|false}: test switch, see Runner.launch
  GET  /api/stream    server-sent events: {"type": "state"} snapshots, {"type": "log"} lines and
                      {"type": "plan"} when the bridge picks the plan itself (the console adopts it)
  GET  /api/strategies          saved strategies (name, time, start, event count)
  GET  /api/strategies/<name>   one saved strategy {name, saved, plan}
  PUT  /api/strategies/<name>   save the console plan in the body under that name

Binds to 127.0.0.1 unless --host says otherwise. There is no login: anyone who can reach the port
can start the game, so only open it to a trusted home network. Uses the standard library; wc3env
is the only dependency.
"""
from __future__ import annotations

import json
import queue
import threading
import time
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PureWindowsPath
from urllib.parse import unquote

from . import attach, strategies
from .data import load_data
from .engine import Commander

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
MAX_BODY = 1 << 20


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


def make_session(backend: str, data: dict, start: int, opponent: str, window: str = "background", seed: int = 1, **world):
    from wc3env import GameConfig, GameSession, MatchSetup, PlayerConfig

    if backend == "fake":
        from wc3env.fake_server import FakeServer

        from .testworld import LostTempleWorld

        config = GameConfig(map="(4)LostTemple.w3m", players=(PlayerConfig(0, "human"), PlayerConfig(1, control="computer")), mode="stepping", step_ms=250)
        server = FakeServer(world_factory=lambda: LostTempleWorld(data, start, **world))  # world: test-only options
        return GameSession(config, game_factory=lambda cfg: FakeGame(cfg.map, server))
    players = (PlayerConfig(0, "human"),)
    difficulty = None
    if opponent != "none":
        players += (PlayerConfig(1, control="computer"),)
        difficulty = {"easy": 0, "normal": 1, "insane": 2}[opponent]
    else:
        # Lost Temple's lobby puts a computer in slot 1, and an unlisted slot keeps it (it attacked at
        # ~5 min in the native probe). As an agent slot it stays on the map with its AI off: no attacks.
        players += (PlayerConfig(1, control="agent"),)
    # "background" keeps a visible window that does not pause when you switch to the browser;
    # "interactive" is the normal game window (you can play, but it may pause without focus).
    config = GameConfig(map="(4)LostTemple.w3m", players=players, mode="realtime", window_mode=window,
                        background_visible=window == "background", render=True, ai_difficulty=difficulty,
                        setup=MatchSetup(seed=seed))
    return GameSession(config)


class Runner:
    """Owns the game session on one thread; the HTTP threads only post plans and read snapshots."""

    def __init__(self, backend: str, speed: float, opponent: str, window: str = "background", seed: int = 1, launch: bool = False):
        self.backend, self.speed, self.opponent, self.window, self.seed = backend, speed, opponent, window, seed
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
        self.state: dict = self.commander.snapshot()
        self.thread: threading.Thread | None = None
        self.stop_flag = threading.Event()
        self.listeners: list[queue.Queue] = []
        self.running = False
        self.tactic = True  # the plan runs as soon as the game is connected; the console can switch it off

    def log(self, text: str, level: str = "info") -> None:
        for q in list(self.listeners):
            q.put({"type": "log", "level": level, "text": text})

    def publish_plan(self) -> None:
        for q in list(self.listeners):
            q.put({"type": "plan", "plan": self.plan})

    def set_plan(self, plan: dict) -> None:
        with self.lock:
            self.plan = plan
            self.commander.set_plan(plan)

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
                self.commander = Commander(self.data)
                self.commander.set_plan(self.plan)
                self.commander.enabled = self.tactic = True  # every new game starts with the tactic on
        self.thread = threading.Thread(target=self._attach if attached else self._run, args=() if attached else (start,), daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_flag.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=15)
        self.thread = None

    def _run(self, start: int) -> None:
        session = None
        try:
            self.log("正在启动魔兽争霸三…" if self.backend == "wc3env" else "正在启动假游戏服务器（失落神庙测试世界）")
            session = make_session(self.backend, self.data, start, self.opponent, self.window, self.seed)
            obs = session.reset()[0]
            self.running = True
            self.log("已连接，开始按时间轴执行")
            step_ms = max(25, int(round(250 * self.speed / 25)) * 25)
            while not self.stop_flag.is_set():
                tick_start = time.perf_counter()
                with self.lock:
                    actions = self.commander.tick(obs)
                    self.state = self.commander.snapshot()
                batches = {slot: [] for slot in session.config.agent_slots}  # every agent slot needs a batch; only 0 is ours
                batches[0] = actions
                observations, done, info = session.step(batches, ms=step_ms) if self.backend == "fake" else session.step(batches)
                obs = observations[0]
                with self.lock:
                    self.commander.feedback(actions, info.get("placements", {}).get(0, []), info.get("rejected", {}).get(0, []))
                for r in info.get("rejected", {}).get(0, []):
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
            if session is not None:
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
        if why is None:
            name = "人族速矿二本 · " + self.data["starts"][start]["name"]
            try:
                plan = strategies.load(name)["plan"]
            except (FileNotFoundError, ValueError):
                why = f"找不到策略「{name}」"
        with self.lock:
            self.commander = Commander(self.data)
            if plan is not None:
                self.plan = plan
            self.commander.set_plan(self.plan)
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
                                    "launch": r.launch or r.backend == "fake", "waiting": r.waiting})
        if self.path == "/api/stream":
            return self._stream()
        if self.path == "/api/plan":
            with self.runner.lock:
                return self._json(200, {"ok": True, "plan": self.runner.plan, "running": self.runner.running})
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
        if self.path == "/api/plan":
            self.runner.set_plan(body)
            return self._json(200, {"ok": True, "events": len(self.runner.commander.events)})
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
          host: str = "127.0.0.1", launch: bool = False) -> None:
    runner = Runner(backend, speed, opponent, window, seed, launch)
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
