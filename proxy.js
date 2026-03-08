#!/usr/bin/env node
/**
 * Pionex Trader — CORS Proxy
 * ──────────────────────────────────────────────────────────────
 * Uso LOCAL:
 *   node proxy.js          →  http://localhost:8000
 *   PORT=3000 node proxy.js
 *
 * Uso en la NUBE (GitHub Pages + servidor gratis):
 *   1. Sube este repo a GitHub.
 *   2. Despliega en Render.com / Railway / Fly.io como "Node service".
 *      - Build command: (ninguno)
 *      - Start command: node proxy.js
 *   3. En la app → Ajustes → URL del backend → pon la URL pública.
 *
 * Qué hace:
 *   · /api/tickers    → proxea Pionex public API (market/tickers)
 *   · /api/klines     → proxea Pionex public API (market/klines)
 *   · /api/indicators → calcula RSI, MACD, Bollinger, EMA desde klines
 *   · /api/health     → status check
 *   · resto           → sirve archivos estáticos (local dev)
 *   · Agrega headers CORS para que el navegador no bloquee nada.
 *
 * Dependencias: CERO — solo módulos built-in de Node.js ≥ 16
 * ──────────────────────────────────────────────────────────────
 */
'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const PORT        = Number(process.env.PORT) || 8000;
const PIONEX_HOST = 'api.pionex.com';
const PIONEX_BASE = '/api/v1';
const ROOT        = __dirname;

/* ── MIME types ──────────────────────────────────────────────── */
const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.json':  'application/json',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
};

/* ── CORS headers ────────────────────────────────────────────── */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Content-Type', 'Authorization', 'x-api-key',
    'anthropic-version', 'anthropic-dangerous-direct-browser-access',
  ].join(', '),
};

/* ── Helpers ─────────────────────────────────────────────────── */
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

/** Fetch JSON from Pionex public API (HTTPS, no auth). */
function pionexGet(apiPath, cb) {
  const req = https.request(
    {
      hostname: PIONEX_HOST,
      port: 443,
      path: PIONEX_BASE + apiPath,
      method: 'GET',
      headers: { 'User-Agent': 'TraderWebProxy/1.0', Accept: 'application/json' },
    },
    (upstream) => {
      const chunks = [];
      upstream.on('data', (c) => chunks.push(c));
      upstream.on('end', () => {
        try {
          cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          cb(new Error('Upstream JSON parse error'));
        }
      });
    }
  );
  req.setTimeout(12000, () => req.destroy(new Error('Upstream timeout')));
  req.on('error', cb);
  req.end();
}

/* ── Technical indicators ────────────────────────────────────── */

/** O(n) Exponential Moving Average */
function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
  return val;
}

/** Wilder RSI — period default 14 */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

/** O(n) MACD(12,26,9) — returns { macd, signal, histogram } or null */
function macd(closes) {
  if (closes.length < 35) return null;
  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;

  let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;

  const macdLine = [];
  for (let i = 12; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    if (i >= 25) macdLine.push(e12 - e26);
  }
  if (macdLine.length < 9) return null;

  let signal = macdLine.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdLine.length; i++)
    signal = macdLine[i] * k9 + signal * (1 - k9);

  const last = macdLine[macdLine.length - 1];
  return { macd: last, signal, histogram: last - signal };
}

/** Bollinger Bands (20, ±2σ) */
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

/** Compute all indicators from an array of Pionex kline objects. */
function computeIndicators(klines) {
  const closes = klines.map((k) => parseFloat(k.close));

  const r  = rsi(closes);
  const m  = macd(closes);
  const bb = bollinger(closes);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);

  return {
    rsi: r !== null ? parseFloat(r.toFixed(4)) : null,
    macd: m
      ? {
          macd:      parseFloat(m.macd.toFixed(6)),
          signal:    parseFloat(m.signal.toFixed(6)),
          histogram: parseFloat(m.histogram.toFixed(6)),
        }
      : null,
    bollinger: bb
      ? {
          upper: parseFloat(bb.upper.toFixed(6)),
          mid:   parseFloat(bb.mid.toFixed(6)),
          lower: parseFloat(bb.lower.toFixed(6)),
        }
      : null,
    ema: {
      20: e20 !== null ? parseFloat(e20.toFixed(6)) : null,
      50: e50 !== null ? parseFloat(e50.toFixed(6)) : null,
    },
  };
}

/* ── Route handlers ──────────────────────────────────────────── */

function handleTickers(res) {
  pionexGet('/market/tickers', (err, json) => {
    if (err) return sendJSON(res, 502, { detail: err.message });
    const tickers = json?.data?.tickers ?? [];
    const out = tickers.map((t) => {
      const o = parseFloat(t.open  || 0);
      const c = parseFloat(t.close || 0);
      const change24h = o ? String(+((c - o) / o * 100).toFixed(4)) : '0';
      return { symbol: t.symbol, close: t.close, change24h, volume24h: t.volume, high24h: t.high, low24h: t.low };
    });
    sendJSON(res, 200, out);
  });
}

function handleKlines(res, q) {
  const sym      = (q.symbol   || 'BTC_USDT').replace(/[^A-Z0-9_]/g, '');
  const interval = (q.interval || '15M').replace(/[^A-Z0-9]/g, '');
  const limit    = Math.min(Math.max(parseInt(q.limit) || 200, 1), 500);

  pionexGet(
    `/market/klines?symbol=${sym}&interval=${interval}&limit=${limit}`,
    (err, json) => {
      if (err) return sendJSON(res, 502, { detail: err.message });
      const klines = (json?.data?.klines ?? []).map((k) => ({
        time:   Math.floor(k.time / 1000), // ms → s (LightweightCharts)
        open:   k.open,
        high:   k.high,
        low:    k.low,
        close:  k.close,
        volume: k.volume,
      }));
      sendJSON(res, 200, { klines });
    }
  );
}

function handleIndicators(res, q) {
  const sym      = (q.symbol   || 'BTC_USDT').replace(/[^A-Z0-9_]/g, '');
  const interval = (q.interval || '15M').replace(/[^A-Z0-9]/g, '');

  pionexGet(
    `/market/klines?symbol=${sym}&interval=${interval}&limit=200`,
    (err, json) => {
      if (err) return sendJSON(res, 502, { detail: err.message });
      const klines     = json?.data?.klines ?? [];
      const indicators = computeIndicators(klines);
      sendJSON(res, 200, { indicators });
    }
  );
}

function handleStatic(res, pathname) {
  const filePath = path.resolve(path.join(ROOT, pathname === '/' ? 'index.html' : pathname));

  // Guard: prevent path-traversal attacks
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, CORS_HEADERS);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback → serve index.html
        fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404, CORS_HEADERS); res.end('Not Found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
          res.end(html);
        });
      } else {
        res.writeHead(500, CORS_HEADERS);
        res.end('Server Error');
      }
      return;
    }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, ...CORS_HEADERS });
    res.end(content);
  });
}

/* ── Main server ─────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  // Block non-GET/POST/OPTIONS to reduce attack surface
  if (!['GET', 'POST', 'OPTIONS'].includes(req.method)) {
    res.writeHead(405, CORS_HEADERS);
    res.end('Method Not Allowed');
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const q        = parsed.query;

  if (pathname === '/health' || pathname === '/api/health') {
    return sendJSON(res, 200, { status: 'ok', proxy: 'trader-proxy', version: '1.0.0' });
  }

  if (pathname === '/api/tickers')    return handleTickers(res);
  if (pathname === '/api/klines')     return handleKlines(res, q);
  if (pathname === '/api/indicators') return handleIndicators(res, q);

  // Authed endpoints: proxy no maneja claves Pionex, devuelve vacío
  if (pathname === '/api/portfolio' || pathname === '/api/balance') {
    return sendJSON(res, 200, { balance: 0, equity: 0, note: 'Configura Pionex API en Ajustes' });
  }
  if (pathname === '/api/positions') return sendJSON(res, 200, []);
  if (pathname === '/api/orders')    return sendJSON(res, 200, { orders: [] });

  // Anything else → static file (local dev)
  handleStatic(res, pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ El puerto ${PORT} ya está en uso.`);
    console.error(`    Prueba: PORT=8080 node proxy.js\n`);
  } else {
    console.error('\n  Error del servidor:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const w = 44;
  console.log('\n  ╔' + '═'.repeat(w) + '╗');
  console.log('  ║' + '  Pionex Trader — CORS Proxy'.padEnd(w) + '║');
  console.log('  ╠' + '═'.repeat(w) + '╣');
  console.log('  ║' + `  Local  →  http://localhost:${PORT}`.padEnd(w) + '║');
  console.log('  ║' + '  Market →  api.pionex.com (proxied)'.padEnd(w) + '║');
  console.log('  ║' + '  AI     →  directo (client-side)'.padEnd(w) + '║');
  console.log('  ╠' + '═'.repeat(w) + '╣');
  console.log('  ║' + '  Para GitHub Pages: despliega este'.padEnd(w) + '║');
  console.log('  ║' + '  archivo en Render/Railway y pon'.padEnd(w) + '║');
  console.log('  ║' + '  la URL en Ajustes → URL backend.'.padEnd(w) + '║');
  console.log('  ╚' + '═'.repeat(w) + '╝');
  console.log('\n  Ctrl+C para detener\n');
});
