"""Saved strategies: a console plan (groups of events, with pinned sites) stored as one JSON file
per name in the repository's strategies/ folder, so it travels between machines with git.

Only the plan is stored, never a game's runtime state.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

STORE = Path(__file__).resolve().parents[2] / "strategies"
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')  # not allowed in Windows or Unix file names


def safe_name(name: str) -> str:
    name = (name or "").strip()
    if not name or len(name) > 60 or _BAD.search(name) or name.startswith(".") or name.endswith("."):
        raise ValueError("策略名不能为空、不能超过 60 个字，也不能含 \\ / : * ? \" < > |")
    return name


def _path(store: Path, name: str) -> Path:
    return store / (safe_name(name) + ".json")


def save(name: str, plan: dict, store: Path = STORE) -> dict:
    if not isinstance(plan, dict) or not isinstance(plan.get("groups"), list):
        raise ValueError("计划格式不对：缺少 groups")
    clean = {"start": plan.get("start"), "groups": [
        {**{k: v for k, v in g.items() if k != "children"}, "children": [{k: v for k, v in e.items() if k != "rt"} for e in g.get("children", [])]}
        for g in plan["groups"]]}
    if plan.get("checkpoints"):  # [{id, name, event, at, from, to}]: targets the console grades a run against
        clean["checkpoints"] = plan["checkpoints"]
    doc = {"name": safe_name(name), "saved": time.strftime("%Y-%m-%dT%H:%M:%S"), "plan": clean}
    store.mkdir(parents=True, exist_ok=True)
    _path(store, name).write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"name": doc["name"], "saved": doc["saved"], "events": sum(len(g["children"]) for g in clean["groups"])}


def load(name: str, store: Path = STORE) -> dict:
    p = _path(store, name)
    if not p.is_file():
        raise FileNotFoundError(name)
    return json.loads(p.read_text(encoding="utf-8"))


def list_all(store: Path = STORE) -> list[dict]:
    out = []
    for p in sorted(store.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True) if store.is_dir() else []:
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        plan = doc.get("plan") or {}
        out.append({"name": doc.get("name", p.stem), "saved": doc.get("saved"), "start": plan.get("start"),
                    "events": sum(len(g.get("children", [])) for g in plan.get("groups", []))})
    return out
