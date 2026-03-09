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
  const ORDERS_LS = 'pionex_direct_orders';
  const CREDS_LS = 'pionex_api_creds';
  const LAST_REAL_ORDER_TS_LS = 'pionex_last_real_order_ts';

  async function _getPionexCreds() {
    try {
      if (typeof CryptoStore !== 'undefined') {
        const raw = await CryptoStore.load(CREDS_LS);
        if (raw) {
          const parsed = JSON.parse(raw);
          const apiKey = String(parsed?.apiKey || '').trim();
          const apiSecret = String(parsed?.apiSecret || '').trim();
          if (apiKey || apiSecret) return { apiKey, apiSecret };
        }
      }
    } catch {}

    return {
      apiKey: (localStorage.getItem('pionex_api_key') || '').trim(),
      apiSecret: (localStorage.getItem('pionex_api_secret') || '').trim(),
    };
  }

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
        amount:    t.amount,
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

  /* ── HMAC-SHA256 con Web Crypto API ───────────────────────────── */
  async function _hmacHex(secret, message) {
    const enc = new TextEncoder();
    const k   = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ── Balances autenticados ──────────────────────────────────── */
  async function getBalance() {
    const { apiKey, apiSecret } = await _getPionexCreds();
    if (!apiKey || !apiSecret) {
      const e = new Error('NO_KEYS');
      throw e;
    }
    const timestamp   = Date.now().toString();
    const path        = '/api/v1/account/balances';
    const queryString = `timestamp=${timestamp}`;

    // Pionex admite dos variantes de firma; probar ambas (igual que createOrder).
    // Si el fetch directo es bloqueado por CORS (entorno GitHub Pages / browser),
    // reintenta automáticamente vía corsproxy.io que:
    //  · Responde al preflight OPTIONS con Access-Control-Allow-Headers: *
    //  · Reenvía PIONEX-KEY a Pionex en una llamada servidor→servidor (sin CORS)
    // Seguridad: la clave secreta nunca sale del navegador (solo se usa para el HMAC local).
    async function tryFetch(signMsg, viaCorsProxy = false) {
      const signature = await _hmacHex(apiSecret, signMsg);
      const targetUrl = `${BASE}/account/balances?${queryString}&signature=${signature}`;
      const fetchUrl  = viaCorsProxy ? CPROXY + encodeURIComponent(targetUrl) : targetUrl;
      const resp = await fetch(fetchUrl, {
        headers: { 'PIONEX-KEY': apiKey, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(viaCorsProxy ? 16000 : 12000),
      });
      return resp;
    }

    async function tryWithFallback(signMsg) {
      try {
        return await tryFetch(signMsg, false);
      } catch {
        // Fallo de red / CORS → reintento transparente vía corsproxy.io
        return tryFetch(signMsg, true);
      }
    }

    // Intento 1: firma solo sobre queryString
    let resp = await tryWithFallback(queryString);

    // Intento 2: si la firma falla, probar con path incluido
    if (!resp.ok) {
      const body1 = await resp.json().catch(() => ({}));
      const msg1  = String(body1?.message || '').toLowerCase();
      if (msg1.includes('signature') || resp.status === 401 || resp.status === 403) {
        resp = await tryWithFallback(`${path}?${queryString}`);
      }
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody?.message || `HTTP ${resp.status}`);
      }
    }

    const data = await resp.json();
    const balances = {};
    (data?.data?.balances ?? data?.balances ?? []).forEach(b => {
      const coin = b.coinType ?? b.coin ?? b.currency;
      if (coin) balances[coin] = { free: b.free ?? '0', locked: b.frozen ?? b.locked ?? '0' };
    });
    return { balances };
  }

  function _loadDirectOrders() {
    try {
      const raw = localStorage.getItem(ORDERS_LS);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function _saveDirectOrder(entry) {
    try {
      const cur = _loadDirectOrders();
      cur.unshift(entry);
      localStorage.setItem(ORDERS_LS, JSON.stringify(cur.slice(0, 100)));
    } catch {}
  }

  async function createOrder(payload = {}) {
    const { apiKey, apiSecret } = await _getPionexCreds();
    if (!apiKey || !apiSecret) {
      throw new Error('Configura API Key y API Secret de Pionex para operar en real.');
    }

    const side = String(payload.side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) {
      throw new Error('Lado de orden inválido. Debe ser BUY o SELL.');
    }

    const orderBody = {
      symbol: payload.symbol,
      side,
      type: payload.type || 'MARKET',
    };

    if (payload.amount != null && Number(payload.amount) > 0) {
      orderBody.amount = String(payload.amount);
    }
    if (payload.size != null && Number(payload.size) > 0) {
      orderBody.size = String(payload.size);
    }
    if (!orderBody.amount && !orderBody.size) {
      throw new Error('Orden inválida: falta amount o size.');
    }

    const timestamp = Date.now().toString();
    const queryString = `timestamp=${timestamp}`;
    async function submitWithSignature(basePayload) {
      const signature = await _hmacHex(apiSecret, basePayload);
      const resp = await fetch(`${BASE}/trade/order?${queryString}&signature=${signature}`, {
        method: 'POST',
        headers: {
          'PIONEX-KEY': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(orderBody),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json().catch(() => ({}));
      const ok = resp.ok && data?.result !== false;
      return { ok, resp, data };
    }

    // Algunos entornos usan firma sobre query+body y otros solo query.
    let submit = await submitWithSignature(`${queryString}${JSON.stringify(orderBody)}`);
    if (!submit.ok) {
      const msg = String(submit.data?.message || '').toLowerCase();
      if (msg.includes('signature') || submit.resp.status === 401 || submit.resp.status === 403) {
        submit = await submitWithSignature(queryString);
      }
    }
    if (!submit.ok) {
      throw new Error(submit.data?.message || `HTTP ${submit.resp.status}`);
    }

    const data = submit.data;

    _saveDirectOrder({
      timestamp: Date.now(),
      symbol: orderBody.symbol,
      side: orderBody.side,
      status: 'SENT',
      price: payload.price ?? null,
      amount: orderBody.amount ?? null,
      size: orderBody.size ?? null,
      orderId: data?.data?.orderId || null,
      source: 'direct',
    });
    localStorage.setItem(LAST_REAL_ORDER_TS_LS, String(Date.now()));

    return data?.result !== undefined ? data : { result: true, data };
  }

  /**
   * Router único — acepta el mismo path+querystring que apiFetch().
   */
  async function handle(path, opts = {}) {
    const sep      = path.indexOf('?');
    const pathname = sep >= 0 ? path.slice(0, sep) : path;
    const q        = Object.fromEntries(new URLSearchParams(sep >= 0 ? path.slice(sep + 1) : ''));
    const method   = String(opts.method || 'GET').toUpperCase();

    if (pathname === '/api/health')     return { status: 'ok', mode: 'direct' };
    if (pathname === '/api/tickers')    return getTickers();
    if (pathname === '/api/klines')     return getKlines(q.symbol || 'BTC_USDT', q.interval || '15M', q.limit);
    if (pathname === '/api/indicators') return getIndicators(q.symbol || 'BTC_USDT', q.interval || '15M');
    if (pathname === '/api/symbols')    return getTickers().then(list => list.map(t => t.symbol));
    if (pathname === '/api/balances')   return getBalance();
    if (pathname === '/api/order' && method === 'POST') {
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body || '{}') : (opts.body || {});
      return createOrder(body);
    }

    if (pathname === '/api/orders') return { orders: _loadDirectOrders() };
    if (pathname === '/api/ai/trades') return { trades: _loadDirectOrders() };
    if (pathname.startsWith('/api/')) return [];

    throw new Error(`Ruta no soportada en modo directo: ${pathname}`);
  }

  return { handle, getTickers, getKlines, getIndicators, getBalance };

})();
