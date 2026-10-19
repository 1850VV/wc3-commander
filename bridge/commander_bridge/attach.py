"""Take over a Warcraft III game the player started by hand (Windows only).

The player opens Warcraft with the desktop shortcut 「魔兽争霸三（指挥官）」 (tools/windows/war3_commander.py),
which starts it with wc3hook.dll loaded and no map: the player picks a map in Warcraft's own menus.
That hook (wc3env-127a branch claude/attach-menu-game) freezes the new game at 0:01 and waits; here we
find the process, connect to its pipe, and release the game in realtime with `create_game(map="*",
players="loaded")`. A Warcraft opened any other way has no hook and cannot be read.
"""
from __future__ import annotations

import csv
import io
import math
import os
import re
import subprocess
from pathlib import PurePath

HALLS = {"htow", "hkee", "hcas"}
START_MATCH = 600  # a start location farther than this from our town hall means another map
PIPE_DIR = "\\\\.\\pipe\\"


def is_lost_temple(map_path: str) -> bool:
    """Any map whose file name says Lost Temple: "(4)LostTemple.w3m", "Lost Temple LV4.w3x", ..."""
    return "losttemple" in re.sub(r"[\s_\-.]+", "", PurePath(map_path.replace("\\", "/")).name.lower())


def war3_pids() -> list[int]:
    out = subprocess.run(["tasklist", "/FO", "CSV", "/NH", "/FI", "IMAGENAME eq War3.exe"], capture_output=True,
                         text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    return [int(row[1]) for row in csv.reader(io.StringIO(out)) if len(row) > 1 and row[1].isdigit()]


def hooked_pids() -> set[int]:
    try:
        names = os.listdir(PIPE_DIR)
    except OSError:
        return set()
    return {int(n[len("wc3hook-"):]) for n in names if n.startswith("wc3hook-") and n[len("wc3hook-"):].isdigit()}


def connect(pid: int):
    from wc3env.pipe import HookPipe
    from wc3env.rpc import RpcClient

    return RpcClient(HookPipe(pid).connect(timeout=3), timeout=30)


def start_of(obs: dict, starts: list[dict]) -> tuple[int | None, float]:
    """Index of the start location under one of our town halls, and how far it is (None without a hall).
    Rejoining later there may be an expansion too; the main hall is the one on a start location."""
    halls = [u for u in obs["units"] if u["structure"] and u["type_id"] in HALLS]
    if not halls:
        return None, math.inf
    d, i = min((math.hypot(s["x"] - h["x"], s["y"] - h["y"]), i) for h in halls for i, s in enumerate(starts))
    return i, d


class AttachedGame:
    """Realtime play on a game we did not launch: send orders, then read the next observation."""

    def __init__(self, rpc, pid: int):
        self.rpc, self.pid = rpc, pid

    def take_over(self) -> dict:
        """Release the held game (once) and return the first observation."""
        if self.rpc.info() and self.rpc.status == "launched":
            self.rpc.call("create_game", map="*", players="loaded", mode="realtime")
        return self.rpc.observe(0)

    def step(self, actions: list[dict]) -> tuple[dict, bool, dict]:
        from wc3env.protocol import normalize_actions

        ack = {"rejected": [], "placements": []}
        if actions:
            ack = self.rpc.act(0, [a.to_dict() for a in normalize_actions(actions)])
        obs = self.rpc.observe(0)
        return obs, self.rpc.status == "ended", ack

    def close(self) -> None:
        self.rpc.close()  # only our end of the pipe: the player's game keeps running
