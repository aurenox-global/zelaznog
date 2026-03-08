/* ═══════════════════════════════════════════════════════════════
   Pionex Direct Client — acceso desde el navegador sin proxy
   ─────────────────────────────────────────────────────────────
   Usado cuando el proxy (localhost:8000) no está disponible,
   por ejemplo desde GitHub Pages o cualquier hosting estático.

   · Llama a api.pionex.com directamente (public API, sin auth)
   · Si Pionex bloquea CORS, reintenta vía corsproxy.io
   · Calcula indicadores localmente (no necesita backend)
   · Devuelve exactamente los mismos formatos que proxy.py/proxy.js
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const PionexClient = (() => {

  const BASE    = 'https://api.pionex.com/api/v1';
  const CPROXY  = 'https://corsproxy.io/?url=';   // fallback CORS proxy (solo datos públicos)

  /* ── Fetch con fallback CORS automático ────────────────────── */
  async function request(apiPath) {
    const url  = BASE + apiPath;
    const opts = { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } };
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    } catch (err) {
      // Error de red o CORS → reintenta vía proxy CORS transparente
      const r2 = await fetch(CPROXY + encodeURIComponent(url), {
        signal: AbortSignal.timeout(14000),
        headers: { Accept: 'application/json' },
      });
      if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
      return r2.json();
    }
  }

  /* ── Indicadores técnicos (mismo algoritmo que proxy.py) ───── */

  function _ema(arr, period) {
    if (arr.length < period) return null;
    const k = 2 / (period + 1);
    let v = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
    return v;
  }

  function _rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let g = 0, lo = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else lo -= d;
    }
    const ag = g / period, al = lo / period;
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }

  function _macd(closes) {
    if (closes.length < 35) return null;
    const [k12, k26, k9] = [2 / 13, 2 / 27, 2 / 10];
    let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    let e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
    const line = [];
    for (let i = 12; i < closes.length; i++) {
      e12 = closes[i] * k12 + e12 * (1 - k12);
      e26 = closes[i] * k26 + e26 * (1 - k26);
      if (i >= 25) line.push(e12 - e26);
    }
    if (line.length < 9) return null;
    let sig = line.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
    for (let i = 9; i < line.length; i++) sig = line[i] * k9 + sig * (1 - k9);
    const last = line[line.length - 1];
    return { macd: last, signal: sig, histogram: last - sig };
  }

  function _bollinger(closes, period = 20, mult = 2) {
    if (closes.length < period) return null;
    const sl  = closes.slice(-period);
    const mid = sl.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
    return { upper: mid + mult * std, mid, lower: mid - mult * std };
  }

  function _computeIndicators(rawKlines) {
    const closes = rawKlines.map(k => parseFloat(k.close));
    const r  = _rsi(closes);
    const m  = _macd(closes);
    const bb = _bollinger(closes);
    const e20 = _ema(closes, 20);
    const e50 = _ema(closes, 50);
    const fx = (v, d = 6) => (v != null ? parseFloat(v.toFixed(d)) : null);
    return {
      rsi:  fx(r, 4),
      macd: m  ? { macd: fx(m.macd), signal: fx(m.signal), histogram: fx(m.histogram) } : null,
      bollinger: bb ? { upper: fx(bb.upper), mid: fx(bb.mid), lower: fx(bb.lower) } : null,
      ema:  { 20: fx(e20), 50: fx(e50) },
    };
  }

  /* ── Normalización — mismo formato que el proxy ────────────── */

  function _normTickers(raw) {
    return (raw?.data?.tickers ?? []).map(t => {
      const o = parseFloat(t.open  || 0);
      const c = parseFloat(t.close || 0);
      const change24h = o ? String(+((c - o) / o * 100).toFixed(4)) : '0';
      return {
        symbol:    t.symbol,
        close:     t.close,
        change24h,
        volume24h: t.volume,
        high24h:   t.high,
        low24h:    t.low,
      };
    });
  }

  function _normKlines(raw) {
    return (raw?.data?.klines ?? []).map(k => ({
      time:   Math.floor(k.time / 1000),  // ms → s (LightweightCharts)
      open:   k.open,
      high:   k.high,
      low:    k.low,
      close:  k.close,
      volume: k.volume,
    }));
  }

  /* ── API expuesta ──────────────────────────────────────────── */

  async function getTickers() {
    const raw = await request('/market/tickers');
    return _normTickers(raw);
  }

  async function getKlines(symbol, interval, limit = 200) {
    const p = new URLSearchParams({ symbol, interval, limit: Math.min(+limit || 200, 500) });
    const raw = await request(`/market/klines?${p}`);
    return { klines: _normKlines(raw) };
  }

  async function getIndicators(symbol, interval) {
    const p   = new URLSearchParams({ symbol, interval, limit: 200 });
    const raw = await request(`/market/klines?${p}`);
    return { indicators: _computeIndicators(raw?.data?.klines ?? []) };
  }

  /**
   * Router único — acepta el mismo path+querystring que apiFetch().
   * Ejemplo: PionexClient.handle('/api/tickers')
   *          PionexClient.handle('/api/klines?symbol=BTC_USDT&interval=15M&limit=200')
   */
  async function handle(path) {
    const sep      = path.indexOf('?');
    const pathname = sep >= 0 ? path.slice(0, sep) : path;
    const q        = Object.fromEntries(new URLSearchParams(sep >= 0 ? path.slice(sep + 1) : ''));

    if (pathname === '/api/health')     return { status: 'ok', mode: 'direct' };
    if (pathname === '/api/tickers')    return getTickers();
    if (pathname === '/api/klines')     return getKlines(q.symbol || 'BTC_USDT', q.interval || '15M', q.limit);
    if (pathname === '/api/indicators') return getIndicators(q.symbol || 'BTC_USDT', q.interval || '15M');
    if (pathname === '/api/symbols')    return getTickers().then(list => list.map(t => t.symbol));

    // Rutas autenticadas — no disponibles en modo directo (devuelven vacío seguro)
    if (pathname === '/api/orders' || pathname === '/api/ai/trades') return { orders: [] };
    if (pathname.startsWith('/api/')) return [];

    throw new Error(`Ruta no soportada en modo directo: ${pathname}`);
  }

  return { handle, getTickers, getKlines, getIndicators };

})();
