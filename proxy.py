#!/usr/bin/env python3
"""
Pionex Trader — CORS Proxy (Python 3, cero dependencias)
──────────────────────────────────────────────────────────
Uso LOCAL:
  python3 proxy.py            →  http://localhost:8000
  PORT=8080 python3 proxy.py

Para GitHub Pages (servidor gratis):
  1. Sube el repo a GitHub.
  2. Despliega en Render.com / Railway / Fly.io:
       Build:  pip install -r requirements.txt    (vacío, no hay deps)
       Start:  python3 proxy.py
  3. En la app → Ajustes → URL del backend → pon la URL pública.

Endpoints:
  GET /api/health       →  OK status check
  GET /api/tickers      →  todos los pares Pionex
  GET /api/klines       →  velas (OHLCV)
  GET /api/indicators   →  RSI, MACD, Bollinger, EMA (calculados aquí)
  /api/portfolio etc.   →  vacío (requieren auth del exchange)
  Resto                 →  archivos estáticos (modo dev)
"""
import http.server
import urllib.request
import json
import os
import math
import mimetypes
import ssl
from urllib.parse import urlparse, parse_qs, urlencode

PORT        = int(os.environ.get("PORT", 8000))
PIONEX_BASE = "https://api.pionex.com/api/v1"

# macOS Python.org installers don't include the system cert bundle by default.
# For a local CORS proxy pointing to a known public API this is acceptable.
# To use verified SSL: run /Applications/Python*/Install\ Certificates.command
_SSL_CTX = ssl._create_unverified_context()   # noqa: SIM105

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": ", ".join([
        "Content-Type", "Authorization", "x-api-key",
        "anthropic-version", "anthropic-dangerous-direct-browser-access",
    ]),
}


# ── Pionex fetch ──────────────────────────────────────────────

def pionex_get(path: str) -> dict:
    """Fetches JSON from Pionex public API."""
    req = urllib.request.Request(
        PIONEX_BASE + path,
        headers={"User-Agent": "TraderWebProxy/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=12, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ── Technical indicators ──────────────────────────────────────

def _ema(arr: list, period: int):
    if len(arr) < period:
        return None
    k = 2.0 / (period + 1)
    val = sum(arr[:period]) / period
    for v in arr[period:]:
        val = v * k + val * (1 - k)
    return val


def calc_rsi(closes: list, period: int = 14):
    if len(closes) < period + 1:
        return None
    gains = losses = 0.0
    for i in range(len(closes) - period, len(closes)):
        d = closes[i] - closes[i - 1]
        if d > 0:
            gains += d
        else:
            losses -= d
    ag, al = gains / period, losses / period
    if al == 0:
        return 100.0
    return 100.0 - 100.0 / (1 + ag / al)


def calc_macd(closes: list):
    if len(closes) < 35:
        return None
    k12, k26, k9 = 2/13, 2/27, 2/10

    e12 = sum(closes[:12]) / 12
    e26 = sum(closes[:26]) / 26
    macd_line = []
    for i in range(12, len(closes)):
        e12 = closes[i] * k12 + e12 * (1 - k12)
        e26 = closes[i] * k26 + e26 * (1 - k26)
        if i >= 25:
            macd_line.append(e12 - e26)

    if len(macd_line) < 9:
        return None

    signal = sum(macd_line[:9]) / 9
    for v in macd_line[9:]:
        signal = v * k9 + signal * (1 - k9)

    last = macd_line[-1]
    return {"macd": last, "signal": signal, "histogram": last - signal}


def calc_bollinger(closes: list, period: int = 20, mult: float = 2.0):
    if len(closes) < period:
        return None
    sl  = closes[-period:]
    mid = sum(sl) / period
    std = math.sqrt(sum((v - mid) ** 2 for v in sl) / period)
    return {"upper": mid + mult * std, "mid": mid, "lower": mid - mult * std}


def compute_indicators(klines: list) -> dict:
    closes = [float(k["close"]) for k in klines]
    r  = calc_rsi(closes)
    m  = calc_macd(closes)
    bb = calc_bollinger(closes)
    e20 = _ema(closes, 20)
    e50 = _ema(closes, 50)

    return {
        "rsi":  round(r, 4) if r is not None else None,
        "macd": {
            "macd":      round(m["macd"], 6),
            "signal":    round(m["signal"], 6),
            "histogram": round(m["histogram"], 6),
        } if m else None,
        "bollinger": {
            "upper": round(bb["upper"], 6),
            "mid":   round(bb["mid"], 6),
            "lower": round(bb["lower"], 6),
        } if bb else None,
        "ema": {
            "20": round(e20, 6) if e20 is not None else None,
            "50": round(e50, 6) if e50 is not None else None,
        },
    }


# ── Request handler ───────────────────────────────────────────

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    server_version  = "TraderProxy/1.0"
    sys_version     = ""
    ROOT = os.path.dirname(os.path.abspath(__file__))

    # Silence noisy default logs for /api routes
    def log_message(self, fmt, *args):
        if not args[0].startswith('"GET /api'):
            super().log_message(fmt, *args)

    def _send_cors_json(self, code: int, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    # ── OPTIONS ──────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    # ── GET ───────────────────────────────────────────────────
    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        qs     = parse_qs(parsed.query)

        def qp(key, default=""):
            vals = qs.get(key, [default])
            # Sanitize: only alphanumeric + safe chars
            return "".join(c for c in vals[0] if c.isalnum() or c in "-_.")

        try:
            if path in ("/health", "/api/health"):
                return self._send_cors_json(200, {"status": "ok", "proxy": "trader-proxy", "version": "1.0.0"})

            if path == "/api/tickers":
                data    = pionex_get("/market/tickers")
                tickers = data.get("data", {}).get("tickers", [])
                def _chg(t):
                    o = float(t["open"] or 0)
                    c = float(t["close"] or 0)
                    return str(round((c - o) / o * 100, 4)) if o else "0"

                out = [
                    {
                        "symbol":    t["symbol"],
                        "close":     t["close"],
                        "change24h": _chg(t),
                        "volume24h": t["volume"],
                        "high24h":   t["high"],
                        "low24h":    t["low"],
                    }
                    for t in tickers
                ]
                return self._send_cors_json(200, out)

            if path == "/api/klines":
                sym      = qp("symbol", "BTC_USDT")
                interval = qp("interval", "15M")
                limit    = min(max(int(qs.get("limit", ["200"])[0]), 1), 500)
                params   = urlencode({"symbol": sym, "interval": interval, "limit": limit})
                data     = pionex_get(f"/market/klines?{params}")
                klines   = data.get("data", {}).get("klines", [])
                out = [
                    {
                        "time":   k["time"] // 1000,  # ms → s
                        "open":   k["open"],
                        "high":   k["high"],
                        "low":    k["low"],
                        "close":  k["close"],
                        "volume": k["volume"],
                    }
                    for k in klines
                ]
                return self._send_cors_json(200, {"klines": out})

            if path == "/api/indicators":
                sym      = qp("symbol", "BTC_USDT")
                interval = qp("interval", "15M")
                params   = urlencode({"symbol": sym, "interval": interval, "limit": 200})
                data     = pionex_get(f"/market/klines?{params}")
                klines   = data.get("data", {}).get("klines", [])
                return self._send_cors_json(200, {"indicators": compute_indicators(klines)})

            if path in ("/api/portfolio", "/api/balance"):
                return self._send_cors_json(200, {"balance": 0, "equity": 0, "note": "Configura Pionex API en Ajustes"})

            if path == "/api/positions":
                return self._send_cors_json(200, [])

            if path == "/api/orders":
                return self._send_cors_json(200, {"orders": []})

            # ── static file serving ─────────────────────────
            self._serve_static(path)

        except urllib.error.URLError as e:
            self._send_cors_json(502, {"detail": f"Upstream error: {e.reason}"})
        except Exception as e:
            self._send_cors_json(500, {"detail": str(e)})

    def _serve_static(self, path: str):
        # Prevent path-traversal attacks
        safe  = os.path.normpath(path).lstrip("/")
        fname = "index.html" if not safe or safe == "." else safe
        full  = os.path.realpath(os.path.join(self.ROOT, fname))
        if not full.startswith(self.ROOT):
            self.send_response(403); self.end_headers(); return

        if not os.path.isfile(full):
            # SPA fallback
            full = os.path.join(self.ROOT, "index.html")
            if not os.path.isfile(full):
                self.send_response(404); self.end_headers(); return

        mime, _ = mimetypes.guess_type(full)
        mime    = mime or "application/octet-stream"
        with open(full, "rb") as f:
            body = f.read()

        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)


# ── Entry point ───────────────────────────────────────────────
if __name__ == "__main__":
    w = 46
    print(f"\n  {'╔' + '═'*w + '╗'}")
    print(f"  {'║'}{' Pionex Trader — CORS Proxy (Python)'.ljust(w)}{'║'}")
    print(f"  {'╠' + '═'*w + '╣'}")
    print(f"  {'║'}{f'  Local  →  http://localhost:{PORT}'.ljust(w)}{'║'}")
    print(f"  {'║'}{'  Market →  api.pionex.com (proxied)'.ljust(w)}{'║'}")
    print(f"  {'║'}{'  AI     →  directo (client-side)'.ljust(w)}{'║'}")
    print(f"  {'╠' + '═'*w + '╣'}")
    print(f"  {'║'}{'  GitHub Pages: despliega en Render.com'.ljust(w)}{'║'}")
    print(f"  {'║'}{'  y configura la URL en Ajustes.'.ljust(w)}{'║'}")
    print(f"  {'╚' + '═'*w + '╝'}\n  Ctrl+C para detener\n")

    with http.server.ThreadingHTTPServer(("", PORT), ProxyHandler) as srv:
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n  Proxy detenido.\n")
