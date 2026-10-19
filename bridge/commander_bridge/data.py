"""Load the generated Lost Temple data shared with the browser (web/data/lost-temple.js)."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "web/data/lost-temple.js"
PREFIX = "window.LT_DATA="


@lru_cache(maxsize=1)
def load_data(path: str | None = None) -> dict:
    text = Path(path or DATA).read_text(encoding="utf-8")
    body = text[text.index(PREFIX) + len(PREFIX):].strip().rstrip(";")
    return json.loads(body)
