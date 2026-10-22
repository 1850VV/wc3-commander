"""The tactic scripts kept in strategies/战术脚本-<名字>.txt: 另存为 (PUT /api/script with a name), the list
(GET /api/scripts) and 载入 (POST /api/script/use); the current one is what 「保存」 writes and a game
taken over plays. Runs on a scratch copy of the strategies folder."""
import json
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

from commander_bridge import server, strategies

HERE = Path(__file__).resolve().parent
SCRIPT = (HERE.parents[1] / "strategies" / "战术脚本-人族速矿二本.txt").read_text(encoding="utf-8")


class ScriptLibrary(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / "战术脚本-人族速矿二本.txt").write_text(SCRIPT, encoding="utf-8")
        self.store, strategies.STORE = strategies.STORE, self.dir
        runner = server.Runner("fake", 1.0, "none", "background", 1, False, 0.0, True, 0)
        handler = partial(type("H", (server.Handler,), {"runner": runner}), directory=str(server.WEB))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        strategies.STORE = self.store
        shutil.rmtree(self.dir)

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

    def test_save_as_list_and_load(self):
        self.assertEqual(self.call("GET", "/api/script")["name"], "人族速矿二本")
        changed = SCRIPT.replace("兵营：集结点 大法师 → 步兵 ×6", "兵营：集结点 大法师 → 步兵 ×8")
        j = self.call("PUT", "/api/script", {"text": changed, "name": "八步兵"})
        self.assertTrue(j["saved"])
        self.assertEqual(j["name"], "八步兵")
        self.assertEqual((self.dir / "战术脚本-人族速矿二本.txt").read_text(encoding="utf-8"), SCRIPT)  # the original is kept
        lib = self.call("GET", "/api/scripts")
        self.assertEqual(lib["current"], "八步兵")
        self.assertEqual({x["name"] for x in lib["scripts"]}, {"人族速矿二本", "八步兵"})
        self.assertIn("步兵 ×8", self.call("GET", "/api/script")["text"])  # the current one
        self.assertIn("步兵 ×8", server.script_path().read_text(encoding="utf-8"))  # what a game taken over plays
        j = self.call("POST", "/api/script/use", {"name": "人族速矿二本"})
        self.assertTrue(j["ok"])
        self.assertIn("步兵 ×6", j["text"])
        self.call("PUT", "/api/script", {"text": SCRIPT + "\n# 改过\n"})  # 「保存」 writes the current one
        self.assertIn("# 改过", (self.dir / "战术脚本-人族速矿二本.txt").read_text(encoding="utf-8"))
        self.assertNotIn("# 改过", (self.dir / "战术脚本-八步兵.txt").read_text(encoding="utf-8"))

    def test_bad_names_and_missing_scripts(self):
        for name in ("a/b", "..\\x", ".hidden", "x" * 41):
            j = self.call("PUT", "/api/script", {"text": SCRIPT, "name": name})
            self.assertFalse(j["ok"], name)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["战术脚本-人族速矿二本.txt"])
        self.assertFalse(self.call("POST", "/api/script/use", {"name": "没有这个"})["ok"])
        (self.dir / "当前战术脚本.txt").write_text("已删掉的\n", encoding="utf-8")  # the current one gone: back to the default
        self.assertEqual(self.call("GET", "/api/scripts")["current"], "人族速矿二本")


if __name__ == "__main__":
    unittest.main()
