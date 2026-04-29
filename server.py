import datetime
import html
import http.server
import json
import os
import re
import socketserver
from urllib.parse import unquote, urlparse

PORT = 5000
ROOT = os.path.dirname(os.path.abspath(__file__))
REPOS_DIR = os.path.join(ROOT, "repos")
MAX_UPLOAD = 50 * 1024 * 1024  # 50 MB

os.makedirs(REPOS_DIR, exist_ok=True)

SAFE_NAME = re.compile(r"^[A-Za-z0-9._\- ()\[\]ぁ-んァ-ヶ一-龯]+$")


def sanitize_name(name: str) -> str | None:
    name = name.strip()
    if not name or name in (".", ".."):
        return None
    if "/" in name or "\\" in name or "\x00" in name:
        return None
    if not SAFE_NAME.match(name):
        return None
    if not name.lower().endswith(".zip"):
        name = name + ".zip"
    return name


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- API ----------
    def _handle_api_get(self, path):
        if path == "/api/repos":
            entries = []
            for fn in sorted(os.listdir(REPOS_DIR)):
                full = os.path.join(REPOS_DIR, fn)
                if not os.path.isfile(full):
                    continue
                if not fn.lower().endswith(".zip"):
                    continue
                st = os.stat(full)
                entries.append({
                    "name": fn[:-4],
                    "filename": fn,
                    "size": st.st_size,
                    "modified": int(st.st_mtime),
                })
            self._send_json(200, {"repos": entries})
            return True

        if path.startswith("/api/repo/"):
            raw = unquote(path[len("/api/repo/"):])
            name = sanitize_name(raw)
            if not name:
                self._send_json(400, {"error": "invalid name"})
                return True
            full = os.path.join(REPOS_DIR, name)
            if not os.path.isfile(full):
                self._send_json(404, {"error": "not found"})
                return True
            with open(full, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return True

        return False

    def _handle_api_put(self, path):
        if not path.startswith("/api/repo/"):
            return False
        raw = unquote(path[len("/api/repo/"):])
        name = sanitize_name(raw)
        if not name:
            self._send_json(400, {"error": "invalid name"})
            return True
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            self._send_json(413, {"error": "payload too large or empty"})
            return True
        data = self.rfile.read(length)
        # Basic zip magic check
        if not (data[:2] == b"PK"):
            self._send_json(400, {"error": "not a zip file"})
            return True
        full = os.path.join(REPOS_DIR, name)
        with open(full, "wb") as f:
            f.write(data)
        self._send_json(200, {"name": name[:-4], "filename": name, "size": len(data)})
        return True

    def _handle_api_delete(self, path):
        if not path.startswith("/api/repo/"):
            return False
        raw = unquote(path[len("/api/repo/"):])
        name = sanitize_name(raw)
        if not name:
            self._send_json(400, {"error": "invalid name"})
            return True
        full = os.path.join(REPOS_DIR, name)
        if os.path.isfile(full):
            os.remove(full)
            self._send_json(200, {"deleted": name[:-4]})
        else:
            self._send_json(404, {"error": "not found"})
        return True

    # ---------- HTTP verbs ----------
    def _render_repos_html(self):
        items = []
        for fn in sorted(os.listdir(REPOS_DIR)):
            full = os.path.join(REPOS_DIR, fn)
            if not os.path.isfile(full) or not fn.lower().endswith(".zip"):
                continue
            st = os.stat(full)
            items.append({
                "name": fn[:-4],
                "size": st.st_size,
                "modified": st.st_mtime,
            })

        def fmt_size(b):
            for unit in ("B", "KB", "MB", "GB"):
                if b < 1024:
                    return f"{b:.0f} {unit}" if unit == "B" else f"{b:.1f} {unit}"
                b /= 1024
            return f"{b:.1f} TB"

        rows = ""
        if not items:
            rows = (
                '<tr><td colspan="3" class="empty">'
                'まだリポジトリがありません。<a href="/">トップ</a> からzipをアップロードしてください。'
                '</td></tr>'
            )
        else:
            for r in items:
                modified = datetime.datetime.fromtimestamp(r["modified"]).strftime("%Y-%m-%d %H:%M")
                name_enc = html.escape(r["name"])
                rows += (
                    f'<tr><td class="name"><a href="/{html.escape(r["name"])}">'
                    f'<svg height="16" viewBox="0 0 16 16" width="16"><path fill="#57606a" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z"/></svg>'
                    f'{name_enc}</a></td>'
                    f'<td class="size">{fmt_size(r["size"])}</td>'
                    f'<td class="modified">{modified}</td></tr>'
                )

        body = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>リポジトリ一覧 - ZipHub</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans",sans-serif;background:#f6f8fa;color:#1f2328;font-size:14px;line-height:1.5}}
.topbar{{background:#24292f;color:#fff;padding:12px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #d0d7de}}
.topbar a{{color:#fff;text-decoration:none;font-weight:600}}
.topbar a:hover{{text-decoration:underline}}
.topbar .sep{{color:#6e7681}}
main{{max-width:920px;margin:32px auto;padding:0 24px}}
h1{{font-size:24px;margin:0 0 16px;display:flex;align-items:center;gap:8px}}
.count{{color:#57606a;font-size:14px;font-weight:400}}
.card{{background:#fff;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}}
table{{width:100%;border-collapse:collapse}}
th,td{{padding:10px 16px;text-align:left;border-top:1px solid #d0d7de;font-size:14px}}
th{{background:#f6f8fa;font-weight:600;color:#57606a;font-size:12px;border-top:none}}
tbody tr:hover{{background:#f6f8fa}}
td.name a{{color:#0969da;text-decoration:none;display:inline-flex;align-items:center;gap:8px;font-weight:500}}
td.name a:hover{{text-decoration:underline}}
td.size,td.modified{{color:#57606a;font-size:12px;white-space:nowrap}}
td.size{{width:120px}}
td.modified{{width:170px}}
td.empty{{text-align:center;color:#57606a;padding:40px}}
td.empty a{{color:#0969da}}
</style>
</head>
<body>
<header class="topbar">
  <a href="/">ZipHub</a>
  <span class="sep">/</span>
  <a href="/zip">zip</a>
</header>
<main>
  <h1>保存済みリポジトリ <span class="count">{len(items)} 件</span></h1>
  <div class="card">
    <table>
      <thead>
        <tr><th>名前</th><th>サイズ</th><th>更新日時</th></tr>
      </thead>
      <tbody>
        {rows}
      </tbody>
    </table>
  </div>
</main>
</body>
</html>"""
        return body.encode("utf-8")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/"):
            if not self._handle_api_get(path):
                self._send_json(404, {"error": "not found"})
            return

        # Block direct access to repos dir
        if path.startswith("/repos"):
            self.send_response(404)
            self.end_headers()
            return

        # Server-rendered repository listing
        if path == "/zip" or path == "/zip/":
            body = self._render_repos_html()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/" or path == "":
            self.path = "/index.html"
            return super().do_GET()

        local = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if local.startswith(ROOT) and os.path.isfile(local):
            return super().do_GET()

        # SPA fallback
        self.path = "/index.html"
        return super().do_GET()

    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            if not self._handle_api_put(parsed.path):
                self._send_json(404, {"error": "not found"})
            return
        self.send_response(405)
        self.end_headers()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            if not self._handle_api_delete(parsed.path):
                self._send_json(404, {"error": "not found"})
            return
        self.send_response(405)
        self.end_headers()

    def log_message(self, format, *args):
        print("[server] " + (format % args))


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving on http://0.0.0.0:{PORT}")
        print(f"Repos dir: {REPOS_DIR}")
        httpd.serve_forever()
