#!/usr/bin/env python3
"""Road Trace 開発用サーバー（キャッシュ無効化版）。
ブラウザがJSモジュールを古いままにしないよう Cache-Control: no-store を付ける。
通常の利用は start.command（python3 -m http.server）で十分。これは開発・検証用。"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Road Trace (no-cache) serving on http://localhost:{PORT}")
    httpd.serve_forever()
