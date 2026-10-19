"""Take over a Warcraft III game the player started by hand (Windows only).

Any War3.exe works. One opened with the desktop shortcut 「魔兽争霸三（指挥官）」 (tools/windows/war3_commander.py)
already has wc3hook.dll; any other gets it injected here (`inject`), at the menu or mid-game. The hook
(wc3env-127a branch claude/attach-menu-game) freezes each new game at 0:01, or a running one at its next
frame, until we connect to its pipe and release it in realtime with `create_game(map="*",
players="loaded")`. A Warcraft running as administrator can only be injected by an elevated bridge.
"""
from __future__ import annotations

import csv
import ctypes
import io
import math
import os
import re
import shutil
import subprocess
from pathlib import Path, PurePath

HALLS = {"htow", "hkee", "hcas"}
START_MATCH = 600  # a start location farther than this from our town hall means another map
PIPE_DIR = "\\\\.\\pipe\\"
HOOK = Path(os.environ.get("WC3_COMMANDER_HOOK", str(
    Path.home() / "Documents" / "ChatGPT" / "wc3env-127a-attach" / "src" / "wc3env" / "native" / "wc3hook.dll"
)))
CACHE = Path(__file__).resolve().parents[1] / "hook-cache"  # one copy per injected game: a loaded DLL stays locked


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


def inject(pid: int) -> bool:
    """Load the hook into a running War3.exe. False if it already has one (the hook refuses a second
    copy). PermissionError when Windows refuses access (the game runs as administrator)."""
    from wc3env.inject import MEM_COMMIT_RESERVE, PAGE_READWRITE, _export_rva, k32, kernel32_32_base

    if not HOOK.is_file():
        raise FileNotFoundError(f"找不到指挥官版的 wc3hook.dll：{HOOK}")
    CACHE.mkdir(exist_ok=True)
    dll = CACHE / f"wc3hook-{pid}.dll"
    if not dll.is_file():
        shutil.copy2(HOOK, dll)
    load = kernel32_32_base() + _export_rva(os.path.join(os.environ["WINDIR"], "SysWOW64", "kernel32.dll"), b"LoadLibraryW")
    h = k32.OpenProcess(0x1F0FFF, False, pid)  # PROCESS_ALL_ACCESS
    if not h:
        err = ctypes.get_last_error()
        if err == 5:
            raise PermissionError(err, "access denied")
        raise OSError(err, f"OpenProcess failed: {err}")
    try:
        raw = str(dll).encode("utf-16-le") + b"\0\0"
        mem = k32.VirtualAllocEx(h, None, len(raw), MEM_COMMIT_RESERVE, PAGE_READWRITE)
        written = ctypes.c_size_t(0)
        if not mem or not k32.WriteProcessMemory(h, mem, raw, len(raw), ctypes.byref(written)):
            raise OSError(ctypes.get_last_error(), "could not write the DLL path into the game")
        thread = k32.CreateRemoteThread(h, None, 0, ctypes.c_void_p(load), ctypes.c_void_p(mem), 0, None)
        if not thread:
            err = ctypes.get_last_error()
            raise (PermissionError if err == 5 else OSError)(err, f"CreateRemoteThread failed: {err}")
        k32.WaitForSingleObject(thread, 15000)
        code = ctypes.c_ulong(0)
        k32.GetExitCodeThread(thread, ctypes.byref(code))
        k32.CloseHandle(thread)
        return bool(code.value)
    finally:
        k32.CloseHandle(h)


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
