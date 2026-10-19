"""Local HTTP server: serves the console (web/) and connects it to a wc3env game.

  GET  /api/health    which backend is configured, whether a game is running
  POST /api/plan      the console's timeline (groups of events)
  POST /api/control   {"action": "start", "start": 0} or {"action": "stop"}
  GET  /api/stream    server-sent events: {"type": "state"} snapshots and {"type": "log"} lines

Binds to 127.0.0.1 only. Uses the standard library; wc3env is the only dependency.
"""
from __future__ import annotations

import json
import queue
import threading
import time
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
    # "background" keeps a visible window that does not pause when you switch to the browser;
    # "interactive" is the normal game window (you can play, but it may pause without focus).
    config = GameConfig(map="(4)LostTemple.w3m", players=players, mode="realtime", window_mode=window,
                        background_visible=window == "background", render=True, ai_difficulty=difficulty,
                        setup=MatchSetup(seed=seed))
    return GameSession(config)


class Runner:
    """Owns the game session on one thread; the HTTP threads only post plans and read snapshots."""

    def __init__(self, backend: str, speed: float, opponent: str, window: str = "background", seed: int = 1):
        self.backend, self.speed, self.opponent, self.window, self.seed = backend, speed, opponent, window, seed
        self.data = load_data()
        self.lock = threading.Lock()
        self.commander = Commander(self.data)
        self.plan: dict = {"groups": []}
        self.state: dict = self.commander.snapshot()
        self.thread: threading.Thread | None = None
        self.stop_flag = threading.Event()
        self.listeners: list[queue.Queue] = []
        self.running = False

    def log(self, text: str, level: str = "info") -> None:
        for q in list(self.listeners):
            q.put({"type": "log", "level": level, "text": text})

    def set_plan(self, plan: dict) -> None:
        with self.lock:
            self.plan = plan
            self.commander.set_plan(plan)

    def start(self, start: int) -> None:
        self.stop()
        self.stop_flag.clear()
        with self.lock:
            self.commander = Commander(self.data)
            self.commander.set_plan(self.plan)
        self.thread = threading.Thread(target=self._run, args=(start,), daemon=True)
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
                observations, done, info = session.step({0: actions}, ms=step_ms) if self.backend == "fake" else session.step({0: actions})
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
            return self._json(200, {"ok": True, "backend": self.runner.backend, "running": self.runner.running})
        if self.path == "/api/stream":
            return self._stream()
        return super().do_GET()

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


def serve(backend: str = "fake", port: int = 8790, speed: float = 1.0, opponent: str = "none", window: str = "background", seed: int = 1) -> None:
    runner = Runner(backend, speed, opponent, window, seed)
    handler = partial(type("BoundHandler", (Handler,), {"runner": runner}), directory=str(WEB))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    print(f"指挥官控制台：http://127.0.0.1:{port}/  （后端：{backend}，Ctrl+C 退出）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop()
        httpd.server_close()
