"""python -m commander_bridge [--backend fake|wc3env] [--port 8790]

--backend fake    wc3env's FakeServer with a Lost Temple economy world; runs on any OS.
--backend wc3env  the real game (Windows, Warcraft III 1.27a, built wc3hook.dll, WC3_GAME_DIR set).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser(prog="commander_bridge")
    p.add_argument("--backend", choices=("fake", "wc3env"), default="fake")
    p.add_argument("--port", type=int, default=8790)
    p.add_argument("--speed", type=float, default=2.0, help="fake backend only: game seconds per real second")
    p.add_argument("--opponent", choices=("none", "easy", "normal", "insane"), default="none", help="wc3env backend: computer opponent in slot 1")
    p.add_argument("--wc3env", type=Path, default=Path(os.environ.get("WC3ENV_SRC", Path(__file__).resolve().parents[3] / "wc3env-127a" / "src")),
                   help="path to wc3env-127a/src when wc3env is not pip-installed")
    args = p.parse_args()
    try:
        import wc3env  # noqa: F401
    except ImportError:
        if not (args.wc3env / "wc3env").is_dir():
            sys.exit(f"找不到 wc3env：请 pip install wc3env-127a，或用 --wc3env 指向 wc3env-127a/src（当前：{args.wc3env}）")
        sys.path.insert(0, str(args.wc3env))
    from .server import serve

    serve(args.backend, args.port, args.speed, args.opponent)


if __name__ == "__main__":
    main()
