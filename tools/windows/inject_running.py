"""Experimental: load the commander's wc3hook.dll into a Warcraft III that is already running.

  pythonw tools/windows/inject_running.py [pid]      (default: the only War3.exe running)

For a game opened without the 「魔兽争霸三（指挥官）」 shortcut. The hook normally loads before the game
starts; loaded late it notices (main.c "late attach"), keeps the normal window, and holds the game at
its next frame until the console's 「连接」 takes it over. The map name is then unknown, so the bridge
goes by the start location. Untested territory: the game may crash. Must run in the desktop session
(Windows refuses CreateRemoteThread across sessions, so not straight from SSH). Logs to
bridge/war3-launch.log like the shortcut.
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from war3_commander import HOOK, fail, note  # noqa: E402

PROCESS_ALL_ACCESS = 0x1F0FFF


def war3_pid() -> int:
    if len(sys.argv) > 1:
        return int(sys.argv[1])
    out = subprocess.run(["tasklist", "/FO", "CSV", "/NH", "/FI", "IMAGENAME eq War3.exe"], capture_output=True,
                         text=True, creationflags=subprocess.CREATE_NO_WINDOW).stdout
    pids = [int(line.split('","')[1]) for line in out.splitlines() if line.startswith('"')]
    if len(pids) != 1:
        fail(f"要正好有一个 War3.exe 在运行，现在有 {len(pids)} 个；也可以在命令行写上进程号")
    return pids[0]


def main() -> None:
    from wc3env.inject import MEM_COMMIT_RESERVE, PAGE_READWRITE, _export_rva, k32, kernel32_32_base

    pid = war3_pid()
    note(f"注入正在运行的 War3.exe 进程 {pid}：{HOOK}")
    if not HOOK.is_file():
        fail(f"找不到指挥官版的 wc3hook.dll：\n{HOOK}")
    load = kernel32_32_base() + _export_rva(os.path.join(os.environ["WINDIR"], "SysWOW64", "kernel32.dll"), b"LoadLibraryW")
    h = k32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not h:
        fail(f"打不开进程 {pid}（错误 {ctypes.get_last_error()}）")
    try:
        raw = str(HOOK).encode("utf-16-le") + b"\0\0"
        mem = k32.VirtualAllocEx(h, None, len(raw), MEM_COMMIT_RESERVE, PAGE_READWRITE)
        written = ctypes.c_size_t(0)
        if not mem or not k32.WriteProcessMemory(h, mem, raw, len(raw), ctypes.byref(written)):
            fail(f"写不进进程 {pid}（错误 {ctypes.get_last_error()}）")
        thread = k32.CreateRemoteThread(h, None, 0, ctypes.c_void_p(load), ctypes.c_void_p(mem), 0, None)
        if not thread:
            fail(f"没能在进程 {pid} 里加载组件（错误 {ctypes.get_last_error()}）")
        k32.WaitForSingleObject(thread, 15000)
        code = ctypes.c_ulong(0)
        k32.GetExitCodeThread(thread, ctypes.byref(code))
        k32.CloseHandle(thread)
        if not code.value:
            fail("LoadLibraryW 失败：组件没加载进去")
        note(f"已注入进程 {pid}")
    finally:
        k32.CloseHandle(h)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:
        note(traceback.format_exc())
        fail(f"注入出错：{exc}")
