#!/usr/bin/env python3
"""
server.py — static file server + streaming CORS proxy for AgentRouter Chat.

Why a proxy?
    Browsers block direct cross-origin calls to most LLM relays (CORS), and
    Anthropic refuses browser calls unless a special header is sent. The proxy
    forwards your request server-side and streams the SSE response straight
    back to the page, so token-by-token output keeps working.

Usage:
    python server.py                 # http://127.0.0.1:8000
    python server.py --port 9000
    python server.py --allow-any     # allow proxying to ANY host (default: allowlist)

Only stdlib is used — no pip install required.
Your API key is never stored by this script; it is passed through per request.
"""

import argparse
import http.server
import json
import os
import socketserver
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))

# Hosts the proxy is willing to talk to (suffix match). Extend freely.
ALLOWED_HOSTS = {
    "agentrouter.org",
    "api.anthropic.com",
    "api.openai.com",
    "openrouter.ai",
    "api.deepseek.com",
    "api.groq.com",
    "api.together.xyz",
    "generativelanguage.googleapis.com",
    "localhost",
    "127.0.0.1",
}

# Headers we forward upstream (anything else is dropped).
FORWARD_REQ = {
    "content-type",
    "authorization",
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "openai-organization",
    "openai-beta",
    "http-referer",
    "x-title",
    "accept",
    # client-identity headers some relays require
    "x-app",
    "x-stainless-lang",
    "x-stainless-package-version",
    "x-stainless-os",
    "x-stainless-arch",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
    "x-stainless-retry-count",
    "user-agent",
}

# Never copy these to the upstream request.
HOP_BY_HOP = {
    "host", "connection", "keep-alive", "transfer-encoding", "upgrade",
    "proxy-connection", "te", "trailer", "content-length",
}

# Relays such as AgentRouter reject "unknown clients", so identify as the
# official Anthropic CLI by default. Override per-request via x-ar-ua.
DEFAULT_UA = "claude-cli/1.0.60 (external, cli)"

ALLOW_ANY = False



def host_allowed(host: str) -> bool:
    if ALLOW_ANY:
        return True
    host = (host or "").split(":")[0].lower()
    return any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "AgentRouterChat/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # ---------- helpers ----------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _target(self):
        q = urllib.parse.urlparse(self.path).query
        url = urllib.parse.parse_qs(q).get("url", [""])[0]
        if not url:
            return None, "Missing ?url= parameter"
        p = urllib.parse.urlparse(url)
        if p.scheme not in ("http", "https"):
            return None, "Only http/https URLs are allowed"
        if not host_allowed(p.netloc):
            return None, (
                f"Host '{p.netloc}' is not in the allowlist. "
                "Restart with --allow-any to permit it."
            )
        return url, None

    # ---------- routes ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/proxy":
            return self._proxy("GET")
        if path == "/health":                       # used by the page to detect us
            return self._json(200, {"ok": True, "server": "try-and-learn"})
        if self.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()


    def do_POST(self):
        if urllib.parse.urlparse(self.path).path == "/proxy":
            return self._proxy("POST")
        self._json(404, {"error": {"message": "Not found"}})

    # ---------- the proxy ----------
    def _proxy(self, method: str):
        url, err = self._target()
        if err:
            return self._json(400, {"error": {"message": err}})

        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(length) if length else None

        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() in FORWARD_REQ and v
        }
        headers.setdefault("Content-Type", "application/json")

        # --- client identity -------------------------------------------------
        # Browsers refuse to let fetch() set User-Agent, and some relays reject
        # "unknown clients". The page passes the identity it wants via
        # x-ar-ua / x-ar-extra and we apply it here, server-side.
        ua = self.headers.get("x-ar-ua")
        headers["User-Agent"] = ua if ua else DEFAULT_UA

        extra = self.headers.get("x-ar-extra")
        if extra:
            try:
                for k, v in json.loads(extra).items():
                    if isinstance(v, str) and k.lower() not in HOP_BY_HOP:
                        headers[k] = v
            except Exception:
                pass

        # Let Anthropic accept requests that originate from a browser page.
        if "anthropic" in url or "x-api-key" in {k.lower() for k in headers}:
            headers["anthropic-dangerous-direct-browser-access"] = "true"


        req = urllib.request.Request(url, data=payload, headers=headers, method=method)

        try:
            upstream = urllib.request.urlopen(req, timeout=900)
        except urllib.error.HTTPError as e:                      # 4xx / 5xx
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        except Exception as e:                                   # DNS/TLS/timeout
            return self._json(502, {"error": {"message": f"Proxy could not reach upstream: {e}"}})

        ctype = upstream.headers.get("Content-Type", "application/json")
        streaming = "event-stream" in ctype.lower()

        self.send_response(upstream.status)
        self.send_header("Content-Type", ctype)
        self._cors()
        if streaming:
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                while True:
                    chunk = upstream.read1(4096) if hasattr(upstream, "read1") else upstream.read(4096)
                    if not chunk:
                        break
                    self.wfile.write(b"%X\r\n%s\r\n" % (len(chunk), chunk))
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass                                              # client hit Stop
            finally:
                upstream.close()
            return

        body = upstream.read()
        upstream.close()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # quieter, friendlier logs
    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/proxy" in msg or " 4" in msg or " 5" in msg:
            sys.stderr.write("  %s\n" % msg)


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    global ALLOW_ANY
    ap = argparse.ArgumentParser(description="AgentRouter Chat server + CORS proxy")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--allow-any", action="store_true", help="proxy to any host")
    args = ap.parse_args()
    ALLOW_ANY = args.allow_any

    # Windows consoles default to cp1252; keep output safe either way.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    try:
        httpd = ThreadedServer((args.host, args.port), Handler)
    except OSError as e:
        print(f"\n  Cannot bind {args.host}:{args.port} -> {e}")
        print("  Another program may be using the port. Try: python server.py --port 8080\n")
        sys.exit(1)

    with httpd:
        url = f"http://{args.host}:{args.port}/"
        hosts = "ANY" if ALLOW_ANY else ", ".join(sorted(ALLOWED_HOSTS))
        print("\n  AgentRouter Chat")
        print(f"  ->  {url}")
        print(f"  proxy: /proxy?url=...   hosts: {hosts}")
        print("  Ctrl+C to stop\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  bye\n")



if __name__ == "__main__":
    main()
