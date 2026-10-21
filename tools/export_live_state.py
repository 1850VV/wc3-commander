"""A live game's state part-way through, and how that game went on: fixtures for the budget's projection
test (web/tests/budget.test.js). Plays the shipped tactic script on the fake world.

  python tools/export_live_state.py 200 > web/tests/fixtures/live-s0-200.json
  (with wc3env importable: WC3ENV_SRC=../wc3env-127a/src)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, os.environ.get("WC3ENV_SRC", str(ROOT.parent / "wc3env-127a" / "src")))

from commander_bridge.data import load_data  # noqa: E402
from commander_bridge.server import preview_script  # noqa: E402

KEEP = ("t", "start", "gold", "wood", "foodUsed", "foodCap", "got", "units", "buildings", "decisions", "arbEvents", "events", "script")


def main():
    at, start = float(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 0
    data, text = load_data(), (ROOT / "strategies" / "战术脚本-人族速矿二本.txt").read_text(encoding="utf-8")
    part = preview_script(data, text, start, seconds=at)
    whole = preview_script(data, text, start, seconds=600)
    state = {k: part["state"][k] for k in KEEP if k in part["state"]}
    state["events"] = {k: {f: v.get(f) for f in ("bStart", "trainStart", "aEnd", "builtAt", "status")} for k, v in state["events"].items()}
    state["units"] = [{k: u[k] for k in ("id", "type", "x", "y", "hidden", "role")} for u in state["units"]]
    later = [{"label": L["label"], "steps": [{k: s.get(k) for k in ("raw", "start", "work", "done")} for s in L["steps"]]} for L in whole["timeline"]["lanes"]]
    json.dump({"state": state, "later": later}, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
