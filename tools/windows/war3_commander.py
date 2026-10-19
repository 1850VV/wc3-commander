"""「魔兽争霸三（指挥官）」: open Warcraft III with the commander's hook, at the main menu.

Run by the desktop shortcut (tools/windows/bridge.ps1 shortcut) with wc3env-127a's .venv pythonw.
You pick the map and start the game yourself; the hook freezes the game at 0:01 until the console's
「连接」 takes it over (bridge/commander_bridge/attach.py), so click 「连接」 first, or right after.

Like wc3env's own launcher, it runs a private copy of the game (War3.exe and DLLs copied, MPQs
hard-linked) under the wc3env output folder; its Maps folder is a link to your real Maps folder, so
every map you have shows up. The hook DLL comes from the wc3env worktree on branch
claude/attach-menu-game (or WC3_COMMANDER_HOOK). Offline single player only.

  --loadfile Maps\...\map.w3m   test only: skip the menus and load that map (relative to the game
                                folder), still without telling the hook which map: same takeover path
"""
from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
from pathlib import Path

LOG = Path(__file__).resolve().parents[2] / "bridge" / "war3-launch.log"
HOOK = Path(os.environ.get("WC3_COMMANDER_HOOK", str(
    Path.home() / "Documents" / "ChatGPT" / "wc3env-127a-attach" / "src" / "wc3env" / "native" / "wc3hook.dll"
)))


def note(text: str) -> None:
    import time

    with LOG.open("a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")


def fail(text: str) -> None:
    note("失败：" + text)
    ctypes.windll.user32.MessageBoxW(None, text, "魔兽争霸三（指挥官）", 0x10)
    sys.exit(1)


def main() -> None:
    try:
        from wc3env.game import user_dir
        from wc3env.inject import k32, launch_with_dll
        from wc3env.runtime import prepare_runtime
        from wc3env.settings import settings
    except ImportError as exc:
        fail(f"找不到 wc3env：请用 wc3env-127a\\.venv 里的 Python 运行。\n{exc}")
    if not HOOK.is_file():
        fail(f"找不到指挥官版的 wc3hook.dll：\n{HOOK}")
    game_dir = settings().game_dir
    note("快捷方式被打开")
    docs = user_dir()
    docs.mkdir(parents=True)
    exe = prepare_runtime(game_dir, docs / "Runtime")
    maps = exe.parent / "Maps"
    maps.rmdir()  # prepare_runtime leaves it empty; point it at the real one instead
    subprocess.run(["cmd", "/c", "mklink", "/J", str(maps), str(game_dir / "Maps")], check=True,
                   capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    dll = exe.parent / HOOK.name
    shutil.copy2(HOOK, dll)
    try:
        args = ["-window"] + (["-loadfile", sys.argv[sys.argv.index("--loadfile") + 1]] if "--loadfile" in sys.argv else [])
        pid, handle = launch_with_dll(exe, dll, args, env={
            "WC3HOOK_DOCS": str(docs), "WC3HOOK_LOG_DIR": str(docs),
            "WC3HOOK_AGENTS": "1",  # slot 0, the player's own slot, is the one the commander controls
            "WC3HOOK_WINDOW_MODE": "interactive", "WC3HOOK_RENDER": "1", "WC3HOOK_SOUND": "1",
            "WC3HOOK_BACKGROUND_VISIBLE": "0", "WC3HOOK_AGENT_AI": "0", "WC3HOOK_AI_DIFFICULTY": "", "WC3HOOK_SETUP": "",
        })  # no WC3HOOK_MAP: the hook's menu launch
    except Exception as exc:
        fail(f"魔兽没能启动：{exc}")
    k32.CloseHandle(handle)
    note(f"已启动 War3.exe 进程 {pid}（{exe}）")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:  # pythonw has no console: never fail silently
        import traceback

        note(traceback.format_exc())
        fail(f"启动出错：{exc}")
