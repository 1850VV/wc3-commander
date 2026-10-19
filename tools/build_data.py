"""Build web/data/lost-temple.js from warcraft-commander's extracted map and economy data.

Inputs (from https://github.com/1850VV/warcraft-commander):
  commander/sandbox/map-data.json      Lost Temple pathing grid, objects, starts, terrain
  commander/commander-economy-data.js  1.27a unit/building costs and build times
Optional (wc3env-127a, generated on the game PC by its tools/prepare):
  runs/reference-127a.json             every unit's costs, build time, requirements and upgrade
                                       targets; adds units missing above (REFERENCE_UNITS) and the
                                       "upgrades" lists (town hall -> keep, scout tower -> arcane tower ...)

Usage:
  python tools/build_data.py --source ../warcraft-commander [--reference ../wc3env-127a/runs/reference-127a.json]
"""
from __future__ import annotations

import argparse
import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

NEUTRAL_NAMES = {"ngad": "地精实验室", "nfoh": "生命之泉", "ngme": "地精商店", "nmer": "雇佣兵营地", "ntav": "酒馆"}
UNIT_NAMES = {
    "htow": "城镇大厅", "hkee": "主城", "hcas": "城堡", "halt": "国王祭坛", "hbar": "兵营", "hlum": "伐木场",
    "hvlt": "神秘藏宝室", "hhou": "农场", "hwtw": "侦察塔", "hatw": "防御塔", "hgtw": "防御塔(炮)", "hctw": "炮塔",
    "hbla": "铁匠铺", "hars": "神秘圣地", "harm": "车间", "hgra": "狮鹫笼", "hpea": "农民", "hmil": "民兵",
    "hfoo": "步兵", "hrif": "火枪手", "Hamg": "大法师", "Hmkg": "山丘之王", "ngol": "金矿",
    "hmpr": "牧师", "hsor": "女巫", "hspt": "破法者",
}
REFERENCE_UNITS = ("hmpr", "hsor", "hspt")  # second-tier casters the fast-expand plan trains


def economy(source: Path, reference: Path | None = None) -> dict:
    text = (source / "commander/commander-economy-data.js").read_text(encoding="utf-8")
    match = re.search(r"const d=(\{.*?\});", text, re.S)
    if not match:
        raise SystemExit("economy data not found")
    data = json.loads(match.group(1))
    units = {}
    for key, row in data["units"].items():
        units[key] = {
            "name": UNIT_NAMES.get(key, key), "gold": row["gold"], "wood": row["lumber"], "food": row["food"],
            "foodMade": row["food_made"], "time": row["build_seconds"], "requires": row["requires"],
            "trains": row["trains"], "structure": row["structure"],
        }
    if reference:
        ref = json.loads(reference.read_text(encoding="utf-8"))["units"]
        for key in REFERENCE_UNITS:
            row = ref[key]
            units.setdefault(key, {
                "name": UNIT_NAMES.get(key, key), "gold": row["gold"], "wood": row["lumber"], "food": row["food"],
                "foodMade": row["food_made"], "time": row["build_seconds"], "requires": row["requires"],
                "trains": row["trains"], "structure": row["structure"],
            })
        for key, unit in units.items():
            if ref.get(key, {}).get("upgrades_to"):
                unit["upgrades"] = [u for u in ref[key]["upgrades_to"] if u in units]
    return {"game": data["game"], "units": units, "assumptions": data["assumptions"]}


def build(source: Path, reference: Path | None = None) -> dict:
    raw = json.loads((source / "commander/sandbox/map-data.json").read_text(encoding="utf-8"))
    grid, terrain = raw["grid"], raw["terrain"]
    used = {o["texture"] for o in raw["objects"]} | {b["texture"] for b in raw["buildings"].values()}
    textures = {name: {"w": t["width"], "h": t["height"], "walk": t["walk_rows"], "build": t["build_rows"]}
                for name, t in raw["textures"].items() if name in used}
    trees, mines, neutrals, props = [], [], [], []
    for o in raw["objects"]:
        if o["kind"] == "tree":
            trees += [int(o["x"]), int(o["y"])]
        elif o["kind"] == "mine":
            mines.append({"x": o["x"], "y": o["y"], "gold": o["gold"], "tex": o["texture"]})
        elif o["kind"] == "neutral":
            neutrals.append({"type": o["type"], "name": NEUTRAL_NAMES.get(o["type"], o["type"]), "x": o["x"], "y": o["y"], "tex": o["texture"]})
        else:
            props.append([int(o["x"]), int(o["y"]), o["texture"]])
    tiles = bytes(c[0] | (c[2] << 4) for c in terrain["cells"])  # low nibble tile, bit 4 = cliff/ramp flag
    return {
        "schema": 1,
        "name": "Lost Temple",
        "source": {"map_sha256": raw["source"]["sha256"], "from": "1850VV/warcraft-commander commander/sandbox/map-data.json"},
        "cell": grid["cell_size"], "w": grid["width"], "h": grid["height"], "origin": grid["origin"],
        "bounds": raw["bounds"], "block": grid["walk_rows"], "noBuild": grid["build_rows"],
        "textures": textures, "buildingTex": {k: v["texture"] for k, v in raw["buildings"].items()},
        "trees": trees, "treeTex": "PathTextures\\4x4Default.tga", "mines": mines, "neutrals": neutrals, "props": props,
        "starts": raw["starts"], "worker": raw["worker"],
        "terrain": {"w": terrain["width"], "h": terrain["height"], "origin": terrain["origin"], "cell": 128,
                    "tiles": terrain["tiles"], "data": base64.b64encode(tiles).decode("ascii")},
        "economy": economy(source, reference),
        "limits": raw["limitations"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT.parent / "warcraft-commander")
    parser.add_argument("--reference", type=Path, help="wc3env-127a runs/reference-127a.json (optional)")
    parser.add_argument("--out", type=Path, default=ROOT / "web/data/lost-temple.js")
    args = parser.parse_args()
    data = build(args.source, args.reference)
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    args.out.write_text("/* Generated by tools/build_data.py. Do not edit. */\nwindow.LT_DATA=" + body + ";\n", encoding="utf-8")
    print(f"wrote {args.out} ({args.out.stat().st_size // 1024} KB): {len(data['trees']) // 2} trees, {len(data['mines'])} mines")


if __name__ == "__main__":
    main()
