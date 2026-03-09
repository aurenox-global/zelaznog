/* ═══════════════════════════════════════════════════════════════
   Experimento Trader — Mobile Frontend App
   GitHub Pages · acceso directo a api.pionex.com desde el browser
   Uses CloudAI module for AI analysis via cloud providers
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════════
   Sketchware / Android WebView bridge
   ─────────────────────────────────────────────────────────────
   Sketchware: en tu Activity añade (blocks o código):

     WebView wv = (WebView) findViewById(...);
     WebSettings ws = wv.getSettings();
     ws.setJavaScriptEnabled(true);
     ws.setDomStorageEnabled(true);           // localStorage
     ws.setAllowFileAccessFromFileURLs(true); // si cargas desde assets
     ws.setAllowUniversalAccessFromFileURLs(true);
     wv.addJavascriptInterface(new TraderInterface(this), "Android");
     wv.loadUrl("file:///android_asset/index.html");

   La clase TraderInterface expone métodos con @JavascriptInterface.
   ══════════════════════════════════════════════════════════════ */
const TraderApp = (() => {
  const isWebView = !!(
    window.Android ||
    /wv\b|WebView/.test(navigator.userAgent) ||
    window.location.protocol === 'file:'
  );
  return {
    isWebView,
    /** Llamar desde Sketchware para pasar la URL real del proxy */
    setServer(url) {
      if (!url) return;
      APP.serverUrl = url.replace(/\/$/, '');
      localStorage.setItem('pionex_server', APP.serverUrl);
    },
    /** Vibración háptica (usa la API nativa si está disponible) */
    vibrate(ms = 60) {
      try { window.Android?.vibrate?.(ms); } catch {}
      try { navigator.vibrate?.(ms); } catch {}
    },
    /** Sketchware puede leer el estado de la app via callback */
    getStatus() {
      return JSON.stringify({
        connected: document.querySelector('.conn-dot.connected') !== null,
        page: APP.currentPage,
        symbol: APP.selectedSymbol,
      });
    },
  };
})();
// Expuesto globalmente para que Sketchware lo invoque con evaluateJavascript
window.TraderApp = TraderApp;

/* ── Config & State ──────────────────────────────────────────── */
const APP = {
  serverUrl: localStorage.getItem('pionex_server') || '',
  directMode: true,    // acceso directo a api.pionex.com (GitHub Pages)
  currentPage: localStorage.getItem('pionex_page') || 'dashboard',
  selectedSymbol: localStorage.getItem('pionex_sym') || 'BTC_USDT',
  selectedInterval: '15M',
  tickers: {},
  symbols: [],
  chart: null,
  candleSeries: null,
  indicatorSeries: [],
  refreshTimers: [],
  orderSide: 'BUY',
  moverTab: 'gainers',
};

/* ── Utility ─────────────────────────────────────────────────── */
function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return '—';
  const v = parseFloat(n);
  if (v >= 1e9)  return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6)  return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1000) return v.toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d });
  return v.toFixed(d);
}

function fmtPrice(n) {
  const v = parseFloat(n);
  if (isNaN(v)) return '—';
  if (v >= 10000) return v.toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (v >= 100)   return v.toFixed(2);
  if (v >= 1)     return v.toFixed(4);
  return v.toFixed(6);
}

function signClass(n)  { return parseFloat(n) >= 0 ? 'green' : 'red'; }
function signPrefix(n) { return parseFloat(n) >= 0 ? '+' : ''; }

async function apiFetch(path, opts = {}) {
  // Modo directo: rutas GET sin body van al cliente Pionex en el browser
  if (APP.directMode && !opts.method && typeof PionexClient !== 'undefined') {
    return PionexClient.handle(path);
  }
  const url = APP.serverUrl + path;
  const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(12000) });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/* ── Toast ───────────────────────────────────────────────────── */
function toast(msg, type = 'info', duration = 3000) {
  const icons = { success: 'checkmark-circle-outline', error: 'close-circle-outline', info: 'information-circle-outline' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<ion-icon name="${icons[type] || icons.info}"></ion-icon><span>${msg}</span>`;
  const container = document.getElementById('toastContainer');
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/* ── Navigation ──────────────────────────────────────────────── */
function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.bn-item').forEach(b => b.classList.remove('active'));
  const page = document.getElementById(`page-${pageId}`);
  if (page) page.classList.add('active');
  const btn = document.querySelector(`.bn-item[data-page="${pageId}"]`);
  if (btn) btn.classList.add('active');
  APP.currentPage = pageId;
  localStorage.setItem('pionex_page', pageId);
  onPageEnter(pageId);
}

function onPageEnter(pageId) {
  if (pageId === 'market') loadChart();
  if (pageId === 'trading') loadOrders();
  if (pageId === 'settings') renderSettingsPage();
  if (pageId === 'ai') syncAIPage();
}

/* ── Price formatting helpers ────────────────────────────────── */
function applyTickerData(data) {
  APP.tickers = {};
  if (Array.isArray(data)) {
    data.forEach(t => { APP.tickers[t.symbol] = t; });
  }
  updateTickerScroll();
  updateMarketCoins();
  updateOrderPreview();
}

/* ── Dashboard ───────────────────────────────────────────────── */
function updateTickerScroll() {
  const wrap = document.getElementById('tickerScroll');
  if (!wrap) return;
  const pairs = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BNB_USDT', 'XRP_USDT', 'ADA_USDT', 'DOGE_USDT', 'AVAX_USDT'];
  wrap.innerHTML = pairs.map(sym => {
    const t = APP.tickers[sym];
    if (!t) return '';
    const chg = parseFloat(t.change24h);
    const sym2 = sym.replace('_USDT', '');
    return `<div class="ticker-item">
      <span class="t-sym">${sym2}</span>
      <span class="t-price">$${fmtPrice(t.close)}</span>
      <span class="t-chg ${signClass(chg)}">${signPrefix(chg)}${chg.toFixed(2)}%</span>
    </div>`;
  }).join('');
}

function updateMarketCoins() {
  const syms = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BNB_USDT'];
  syms.forEach(sym => {
    const t = APP.tickers[sym];
    if (!t) return;
    const priceEl  = document.getElementById(`mc-${sym}`);
    const changeEl = document.getElementById(`mcch-${sym}`);
    if (priceEl)  priceEl.textContent  = `$${fmtPrice(t.close)}`;
    if (changeEl) {
      const chg = parseFloat(t.change24h);
      changeEl.textContent = `${signPrefix(chg)}${chg.toFixed(2)}%`;
      changeEl.className   = `mc-change ${signClass(chg)}`;
    }
  });
}

function renderMovers(tickers, tab) {
  const list = document.getElementById('moversList');
  if (!list) return;
  const sorted = [...tickers].sort((a, b) =>
    tab === 'gainers'
      ? parseFloat(b.change24h) - parseFloat(a.change24h)
      : parseFloat(a.change24h) - parseFloat(b.change24h)
  ).slice(0, 8);
  list.innerHTML = sorted.map((t, i) => {
    const chg = parseFloat(t.change24h);
    const sym = t.symbol.replace('_USDT', '');
    return `<div class="mover-item">
      <span class="mover-rank">${i + 1}</span>
      <div class="mover-info">
        <div class="mover-sym">${sym}/USDT</div>
        <div class="mover-vol">Vol $${fmt(t.volume24h)}</div>
      </div>
      <div class="mover-price">
        <div class="mover-pval">$${fmtPrice(t.close)}</div>
        <div class="mover-chg ${signClass(chg)}">${signPrefix(chg)}${chg.toFixed(2)}%</div>
      </div>
    </div>`;
  }).join('');
}

function updateDashboardStats(tickers) {
  const rising   = tickers.filter(t => parseFloat(t.change24h) > 0).length;
  const totalVol = tickers.reduce((s, t) => s + parseFloat(t.volume24h || 0), 0);
  const risingPct = tickers.length ? ((rising / tickers.length) * 100).toFixed(0) : '—';
  const pairsEl = document.getElementById('dbPairsCount');
  const riEl    = document.getElementById('dbRising');
  const volEl   = document.getElementById('dbVol');
  if (pairsEl) pairsEl.textContent = tickers.length;
  if (riEl)    riEl.textContent    = `${risingPct}%`;
  if (volEl)   volEl.textContent   = `$${fmt(totalVol)}`;
}

/* ── Load tickers ────────────────────────────────────────────── */
async function loadTickers() {
  try {
    const data = await apiFetch('/api/tickers');
    const list = Array.isArray(data) ? data : (data.tickers || []);
    applyTickerData(list);
    updateDashboardStats(list);
    renderMovers(list, APP.moverTab);
    updateConnStatus(true);
    // update current symbol price in chart header
    const cur = APP.tickers[APP.selectedSymbol];
    if (cur) {
      const priceEl  = document.getElementById('chartCurrentPrice');
      const changeEl = document.getElementById('chartCurrentChange');
      if (priceEl)  priceEl.textContent  = `$${fmtPrice(cur.close)}`;
      if (changeEl) {
        const chg = parseFloat(cur.change24h);
        changeEl.textContent = `${signPrefix(chg)}${chg.toFixed(2)}%`;
        changeEl.className   = `cpr-change ${signClass(chg)}`;
      }
    }
  } catch (e) {
    updateConnStatus(false);
    console.warn('Tickers error:', e.message);
  }
}

/* ── Chart ───────────────────────────────────────────────────── */
async function loadChart() {
  const container = document.getElementById('mainChart');
  if (!container) return;

  // Init chart if not yet created or container changed
  if (!APP.chart) {
    APP.chart = LightweightCharts.createChart(container, {
      layout: {
        background: { color: 'transparent' },
        textColor:  getComputedStyle(document.documentElement).getPropertyValue('--text2').trim() || '#9db0c7',
      },
      grid: {
        vertLines:  { color: 'rgba(34,50,70,.5)' },
        horzLines:  { color: 'rgba(34,50,70,.5)' },
      },
      crosshair:  { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(34,50,70,.5)' },
      timeScale: {
        borderColor:    'rgba(34,50,70,.5)',
        timeVisible:    true,
        secondsVisible: false,
      },
    });
    APP.candleSeries = APP.chart.addCandlestickSeries({
      upColor:          '#00c176',
      downColor:        '#ff5d6c',
      borderUpColor:    '#00c176',
      borderDownColor:  '#ff5d6c',
      wickUpColor:      '#00c176',
      wickDownColor:    '#ff5d6c',
    });
    // Resize observer
    const ro = new ResizeObserver(() => {
      if (APP.chart) APP.chart.applyOptions({ width: container.clientWidth });
    });
    ro.observe(container);
  }

  try {
    const data = await apiFetch(`/api/klines?symbol=${APP.selectedSymbol}&interval=${APP.selectedInterval}&limit=200`);
    const candles = (Array.isArray(data) ? data : (data.klines || [])).map(k => ({
      time:  k.time || k.openTime,
      open:  parseFloat(k.open),
      high:  parseFloat(k.high),
      low:   parseFloat(k.low),
      close: parseFloat(k.close),
    })).filter(c => c.time).sort((a, b) => a.time - b.time);

    if (candles.length) {
      APP.candleSeries.setData(candles);
      APP.chart.timeScale().fitContent();
    }

    // Load indicators for cards
    loadIndicatorCards();
  } catch (e) {
    console.warn('Chart error:', e.message);
    toast('Error cargando chart: ' + e.message, 'error');
  }
}

async function loadIndicatorCards() {
  try {
    const data = await apiFetch(`/api/indicators?symbol=${APP.selectedSymbol}&interval=${APP.selectedInterval}`);
    const inds = data.indicators || data || {};

    const rsiEl     = document.getElementById('indRsi');
    const rsiSig    = document.getElementById('indRsiSig');
    const macdEl    = document.getElementById('indMacd');
    const macdSig   = document.getElementById('indMacdSig');
    const bbEl      = document.getElementById('indBb');
    const bbSig     = document.getElementById('indBbSig');
    const emaEl     = document.getElementById('indEma');
    const emaSig    = document.getElementById('indEmaSig');

    if (inds.rsi != null) {
      const rsi = parseFloat(inds.rsi);
      if (rsiEl) rsiEl.textContent = rsi.toFixed(1);
      if (rsiSig) {
        let sig = 'Neutral';
        let cls = 'muted';
        if (rsi > 70) { sig = 'Sobrecompra'; cls = 'red'; }
        else if (rsi < 30) { sig = 'Sobreventa'; cls = 'green'; }
        else if (rsi > 55) { sig = 'Alcista'; cls = 'green'; }
        else if (rsi < 45) { sig = 'Bajista'; cls = 'red'; }
        rsiSig.textContent = sig;
        rsiSig.className = `ind-card-signal ${cls}`;
      }
    }

    const macd = inds.macd || {};
    if (macd.histogram != null) {
      const hist = parseFloat(macd.histogram);
      if (macdEl) macdEl.textContent = hist.toFixed(5);
      if (macdSig) {
        const sig = hist > 0 ? 'Alcista ▲' : 'Bajista ▼';
        macdSig.textContent = sig;
        macdSig.className = `ind-card-signal ${hist > 0 ? 'green' : 'red'}`;
      }
    }

    const bb = inds.bollinger || inds.bb || {};
    if (bb.upper != null && bb.lower != null && bb.mid != null) {
      const close = parseFloat(APP.tickers[APP.selectedSymbol]?.close || 0);
      const range = parseFloat(bb.upper) - parseFloat(bb.lower);
      const pctB  = range > 0 ? ((close - parseFloat(bb.lower)) / range * 100) : 50;
      if (bbEl) bbEl.textContent = pctB.toFixed(1) + '%';
      if (bbSig) {
        let sig = 'Neutral';
        let cls = 'muted';
        if (pctB > 85) { sig = 'Alta zona'; cls = 'red'; }
        else if (pctB < 15) { sig = 'Baja zona'; cls = 'green'; }
        bbSig.textContent = sig;
        bbSig.className = `ind-card-signal ${cls}`;
      }
    }

    const ema  = inds.ema  || {};
    const sma  = inds.sma  || {};
    const ema20 = parseFloat(ema['20'] ?? ema.ema20 ?? sma['20'] ?? 0);
    const ema50 = parseFloat(ema['50'] ?? ema.ema50 ?? sma['50'] ?? 0);
    if (ema20 && ema50) {
      const trend = ema20 > ema50 ? 'Alcista' : 'Bajista';
      if (emaEl) emaEl.textContent = trend;
      if (emaSig) {
        emaSig.textContent = `20: ${ema20.toFixed(2)} / 50: ${ema50.toFixed(2)}`;
        emaSig.className = `ind-card-signal ${ema20 > ema50 ? 'green' : 'red'}`;
      }
    }
  } catch (e) {
    console.warn('Indicators error:', e.message);
  }
}

/* ── AI Market Analysis (quick) ──────────────────────────────── */
async function loadAIAnalysis() {
  const box = document.getElementById('aiAnalysisBox');
  if (!box) return;
  const cfg = CloudAI.getConfig();
  if (!cfg.keys?.[cfg.provider]) {
    box.innerHTML = '<span class="muted">Configura un proveedor AI en Ajustes.</span>';
    return;
  }
  box.innerHTML = '<span class="muted">Analizando con ' + (CloudAI.PROVIDERS[cfg.provider]?.name || cfg.provider) + '...</span>';
  try {
    const sym = APP.selectedSymbol;
    const t   = APP.tickers[sym];
    const inds = await apiFetch(`/api/indicators?symbol=${sym}&interval=${APP.selectedInterval}`).catch(() => ({}));
    const ctx = {
      [sym]: {
        price:   t?.close || 0,
        change24h: t?.change24h || 0,
        volume24h: t?.volume24h,
        ...inds.indicators,
        rsi: inds.indicators?.rsi,
        macd: inds.indicators?.macd,
        bb: inds.indicators?.bollinger || inds.indicators?.bb,
      }
    };
    const msgs = CloudAI.buildTradingPrompt([sym], ctx, 'daytrading');
    const result = await CloudAI.chat(msgs);
    box.innerHTML = `<div style="white-space:pre-wrap;font-size:12px;line-height:1.6">${escapeHtml(result)}</div>`;
  } catch (e) {
    box.innerHTML = `<span class="red">Error: ${escapeHtml(e.message)}</span>`;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Symbol picker ───────────────────────────────────────────── */
function openSymPicker() {
  const overlay = document.getElementById('symPickerOverlay');
  const list    = document.getElementById('symPickerList');
  const search  = document.getElementById('symSearch');
  if (!overlay || !list) return;
  overlay.classList.add('open');
  search.value = '';
  renderSymPickerList('');
  search.focus();
}

function closeSymPicker() {
  document.getElementById('symPickerOverlay')?.classList.remove('open');
}

function renderSymPickerList(filter) {
  const list = document.getElementById('symPickerList');
  if (!list) return;
  const all = Object.keys(APP.tickers);
  const filtered = filter
    ? all.filter(s => s.toLowerCase().includes(filter.toLowerCase()))
    : all;
  list.innerHTML = filtered.slice(0, 40).map(sym => {
    const t = APP.tickers[sym];
    const label = sym.replace('_', '/');
    const price = t ? `$${fmtPrice(t.close)}` : '—';
    return `<div class="sym-picker-item" data-sym="${sym}">
      <span class="spi-sym">${label}</span>
      <span class="spi-price">${price}</span>
    </div>`;
  }).join('');
}

/* ── Orders & Positions ──────────────────────────────────────── */
async function loadOrders() {
  const list = document.getElementById('positionsList');
  try {
    const data = await apiFetch('/api/balances');
    renderBalanceAsPositions(data);
  } catch (e) {
    if (list) {
      if (e.message === 'NO_KEYS') {
        list.innerHTML = `<div class="empty-state"><ion-icon name="key-outline"></ion-icon><span>Configura tus Pionex API keys en Ajustes para ver el balance.</span></div>`;
      } else {
        list.innerHTML = `<div class="empty-state"><ion-icon name="cloud-offline-outline"></ion-icon><span>No se pudo obtener el balance.<br><small>${e.message}</small></span></div>`;
      }
    }
  }

  // Try to get recent orders from DB
  try {
    const trades = await apiFetch('/api/ai/trades');
    renderOrdersList(trades);
  } catch {}
}

function renderBalanceAsPositions(data) {
  const list = document.getElementById('positionsList');
  if (!list) return;
  const balances = data.balances || data || {};

  // Actualizar balance total en el dashboard
  const usdt = parseFloat(balances?.USDT?.free ?? balances?.USDT ?? 0);
  const totalVal = Object.entries(balances).reduce((sum, [coin, b]) => {
    const free  = parseFloat(b?.free ?? b ?? 0);
    const price = parseFloat(APP.tickers[`${coin}_USDT`]?.close ?? (coin === 'USDT' ? 1 : 0));
    return sum + free * price;
  }, 0);
  const balEl = document.getElementById('totalBalance');
  if (balEl && totalVal > 0) balEl.textContent = '$' + totalVal.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const items = Object.entries(balances)
    .filter(([coin, b]) => coin !== 'USDT' && parseFloat(b?.free || b || 0) > 0)
    .slice(0, 8);
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><ion-icon name="document-outline"></ion-icon><span>Sin posiciones activas</span></div>`;
    return;
  }
  list.innerHTML = items.map(([coin, b]) => {
    const amount = parseFloat(b?.free || b || 0);
    const price  = parseFloat(APP.tickers[`${coin}_USDT`]?.close || 0);
    const value  = (amount * price).toFixed(2);
    return `<div class="position-card">
      <div class="pc-header">
        <span class="pc-sym">${coin}/USDT</span>
        <span class="pc-type buy">LONG</span>
      </div>
      <div class="pc-stats">
        <span class="pc-stat">Cantidad: <strong>${amount}</strong></span>
        <span class="pc-stat">Precio: <strong>$${fmtPrice(price)}</strong></span>
        <span class="pc-stat">Valor: <strong>$${value}</strong></span>
      </div>
    </div>`;
  }).join('');
}

function renderOrdersList(trades) {
  const list = document.getElementById('ordersList');
  if (!list) return;
  const arr = Array.isArray(trades) ? trades : (trades.trades || []);
  if (!arr.length) {
    list.innerHTML = `<div class="empty-state"><ion-icon name="receipt-outline"></ion-icon><span>Sin órdenes</span></div>`;
    return;
  }
  list.innerHTML = arr.slice(0, 12).map(t => {
    const date = t.timestamp ? new Date(t.timestamp).toLocaleDateString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
    const side = t.side || t.action || '—';
    const isBuy = side.toLowerCase() === 'buy';
    return `<div class="order-row">
      <div class="or-left">
        <span class="or-sym ${isBuy ? 'green' : 'red'}">${side.toUpperCase()} ${(t.symbol || '').replace('_USDT', '')}</span>
        <span class="or-date">${date}</span>
      </div>
      <div class="or-right">
        <span class="or-price">$${fmtPrice(t.price)}</span>
        <span class="or-status ${t.status === 'FILLED' ? 'filled' : 'pending'}">${t.status || 'EXECUTED'}</span>
      </div>
    </div>`;
  }).join('');
}

/* ── Place order ─────────────────────────────────────────────── */
function updateOrderPreview() {
  const sym = document.getElementById('orderSymbol')?.value;
  if (!sym) return;
  const t = APP.tickers[sym];
  if (!t) return;
  const price = parseFloat(t.close);
  const sl = parseFloat(document.getElementById('orderSL')?.value || 0);
  const tp = parseFloat(document.getElementById('orderTP')?.value || 0);
  const isBuy = APP.orderSide === 'BUY';
  const slPrice = isBuy ? price * (1 - sl / 100) : price * (1 + sl / 100);
  const tpPrice = isBuy ? price * (1 + tp / 100) : price * (1 - tp / 100);
  const cpEl = document.getElementById('opCurrentPrice');
  const slEl = document.getElementById('opSLPrice');
  const tpEl = document.getElementById('opTPPrice');
  if (cpEl) cpEl.textContent = `$${fmtPrice(price)}`;
  if (slEl) slEl.textContent = sl ? `$${fmtPrice(slPrice)}` : '—';
  if (tpEl) tpEl.textContent = tp ? `$${fmtPrice(tpPrice)}` : '—';
}

async function placeOrder() {
  const sym    = document.getElementById('orderSymbol')?.value;
  const amount = parseFloat(document.getElementById('orderAmount')?.value);
  const sl     = parseFloat(document.getElementById('orderSL')?.value || 0);
  const tp     = parseFloat(document.getElementById('orderTP')?.value || 0);

  if (!sym || !amount || amount <= 0) {
    toast('Introduce par y cantidad.', 'error');
    return;
  }

  const t     = APP.tickers[sym];
  const price = t ? parseFloat(t.close) : 0;
  const qty   = price > 0 ? (amount / price).toFixed(6) : 0;

  // Show confirm modal
  const overlay = document.getElementById('confirmOrderOverlay');
  const titleEl = document.getElementById('confirmOrderTitle');
  const detailEl = document.getElementById('confirmOrderDetails');
  if (titleEl)  titleEl.textContent = `${APP.orderSide === 'BUY' ? 'Comprar' : 'Vender'} ${sym.replace('_', '/')}`;
  if (detailEl) detailEl.innerHTML = `
    <div class="op-row"><span>Par:</span><span><strong>${sym.replace('_', '/')}</strong></span></div>
    <div class="op-row"><span>Lado:</span><span class="${APP.orderSide === 'BUY' ? 'green' : 'red'}">${APP.orderSide}</span></div>
    <div class="op-row"><span>Monto:</span><span><strong>$${amount}</strong></span></div>
    <div class="op-row"><span>Cantidad est.:</span><span>${qty}</span></div>
    <div class="op-row"><span>Precio:</span><span>$${fmtPrice(price)}</span></div>
    ${sl ? `<div class="op-row"><span>Stop Loss:</span><span class="red">-${sl}%</span></div>` : ''}
    ${tp ? `<div class="op-row"><span>Take Profit:</span><span class="green">+${tp}%</span></div>` : ''}
  `;
  overlay?.classList.add('open');

  // Store pending order data
  APP._pendingOrder = { sym, amount, qty, sl, tp, side: APP.orderSide };
}

async function executeOrder() {
  const ord = APP._pendingOrder;
  if (!ord) return;
  document.getElementById('confirmOrderOverlay')?.classList.remove('open');
  try {
    await apiFetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol:   ord.sym,
        side:     ord.side,
        type:     'MARKET',
        amount:   ord.amount,
        stopLoss: ord.sl || undefined,
        takeProfit: ord.tp || undefined,
      }),
    });
    toast(`Orden ${ord.side} enviada: ${ord.sym}`, 'success');
    APP._pendingOrder = null;
    setTimeout(loadOrders, 1000);
  } catch (e) {
    toast('Error al enviar orden: ' + e.message, 'error');
  }
}

/* ── Bot controls (Cloud AI — BotEngine) ─────────────────────── */
function collectBotConfig() {
  const dryRun    = document.getElementById('dryRunToggle')?.checked ?? true;
  const tradeMode = document.getElementById('botMode')?.value || 'autonomous';
  const interval  = document.getElementById('botInterval')?.value || '15M';
  const cycleMins = parseInt(document.getElementById('botCycleMinutes')?.value || '5', 10);
  const maxTrades = parseInt(document.getElementById('botMaxTrades')?.value || '10', 10);
  const maxPos    = parseFloat(document.getElementById('botMaxPosition')?.value || '100');
  const riskLevel = document.getElementById('botRiskLevel')?.value || 'moderate';
  const sl        = parseFloat(document.getElementById('botStopLoss')?.value || '3');
  const tp        = parseFloat(document.getElementById('botTakeProfit')?.value || '5');
  const maxDL     = parseFloat(document.getElementById('botMaxDailyLoss')?.value || '5');
  const minProfit = parseFloat(document.getElementById('botMinProfit')?.value || '0.33');

  // Collect selected symbols (ignored in autonomous mode)
  const activeChips = [...document.querySelectorAll('.bot-sym-chip.active')];
  const symbols = activeChips.map(c => c.dataset.sym).filter(Boolean);

  return {
    dryRun, tradeMode, interval,
    cycleMinutes:    isNaN(cycleMins) ? 5  : cycleMins,
    maxTradesPerDay: isNaN(maxTrades) ? 10 : maxTrades,
    maxPositionUSD:  isNaN(maxPos)    ? 100 : maxPos,
    riskLevel, stopLossPct: isNaN(sl) ? 3 : sl,
    takeProfitPct: isNaN(tp) ? 5 : tp,
    maxDailyLossPct: isNaN(maxDL) ? 5 : maxDL,
    minProfitUsdt: isNaN(minProfit) ? 0.33 : minProfit,
    symbols: symbols.length ? symbols : ['BTC_USDT', 'ETH_USDT'],
  };
}

function startBot() {
  const cfg = collectBotConfig();
  const result = BotEngine.start(cfg);
  if (!result.ok) {
    toast('Error: ' + result.error, 'error');
    return;
  }
  toast('Bot AI Cloud iniciado' + (cfg.dryRun ? ' (simulación)' : ' ⚠️ MODO REAL'), 'success');
}

function stopBot() {
  BotEngine.stop();
  toast('Bot detenido', 'info');
}

/* ── AI Trader page ──────────────────────────────────────────── */
function syncAIPage() {
  const cfg = CloudAI.getConfig();
  // Mark active provider button
  document.querySelectorAll('.prov-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.prov === cfg.provider);
  });
  // Set model select options
  populateModelSelect(cfg.provider, cfg.model);
  // Set API key (masked)
  const keyInput = document.getElementById('aiApiKeyInput');
  if (keyInput) keyInput.value = cfg.keys?.[cfg.provider] ? '••••••••••••' : '';
  // Badge
  const badge = document.getElementById('aiProviderBadge');
  if (badge) badge.textContent = CloudAI.PROVIDERS[cfg.provider]?.name || cfg.provider;
}

function populateModelSelect(provId, currentModel) {
  const sel = document.getElementById('aiModelSelect');
  if (!sel) return;
  const models = CloudAI.getModels(provId);
  sel.innerHTML = models.map(m =>
    `<option value="${m.id}" ${m.id === currentModel ? 'selected' : ''}>${m.label}</option>`
  ).join('');
}

/* ── AI Analysis (full) ──────────────────────────────────────── */
async function runFullAnalysis() {
  const btn = document.getElementById('runAnalysisBtn');
  const msgs = document.getElementById('aiChatMessages');
  if (!msgs) return;

  // Get selected symbols
  const chips = [...document.querySelectorAll('.sym-chip.active')];
  const symbols = chips.map(c => c.dataset.sym).filter(Boolean);
  if (!symbols.length) { toast('Selecciona al menos un par', 'error'); return; }

  // Get mode
  const modeBtn = document.querySelector('.mode-btn.active');
  const mode = modeBtn?.dataset.mode || 'daytrading';

  // Set loading state
  if (btn) { btn.disabled = true; btn.innerHTML = '<ion-icon name="hourglass-outline"></ion-icon> Analizando...'; }

  // Add user message
  const chipLabels = symbols.map(s => s.replace('_USDT', '')).join(', ');
  appendChatMsg('user', `Analizar: **${chipLabels}** en modo **${mode}**`);

  // Loading indicator
  const loadId = appendLoadingMsg();

  try {
    // Fetch market data for all symbols
    const marketData = {};
    await Promise.all(symbols.map(async sym => {
      const [indsResp] = await Promise.all([
        apiFetch(`/api/indicators?symbol=${sym}&interval=15M`).catch(() => ({})),
      ]);
      const t = APP.tickers[sym];
      const inds = indsResp.indicators || indsResp || {};
      marketData[sym] = {
        price:     parseFloat(t?.close  || 0),
        change24h: parseFloat(t?.change24h || 0),
        volume24h: parseFloat(t?.volume24h || 0),
        rsi:   inds.rsi,
        macd:  inds.macd,
        bb:    inds.bollinger || inds.bb,
        ema20: inds.ema?.['20'] || inds.ema20,
        ema50: inds.ema?.['50'] || inds.ema50,
      };
    }));

    const messages = CloudAI.buildTradingPrompt(symbols, marketData, mode);
    const result   = await CloudAI.chat(messages);

    removeMsgById(loadId);
    appendChatMsg('assistant', result);
    toast('Análisis completado', 'success');
  } catch (e) {
    removeMsgById(loadId);
    appendChatMsg('error', 'Error: ' + e.message);
    toast('Error AI: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<ion-icon name="sparkles-outline"></ion-icon> Analizar con AI'; }
  }
}

async function sendChatQuestion() {
  const input = document.getElementById('chatQuestionInput');
  const question = input?.value.trim();
  if (!question) return;
  input.value = '';
  appendChatMsg('user', question);
  const loadId = appendLoadingMsg();
  try {
    // Simple chat (no extra market context for quick questions)
    const cfg = CloudAI.getConfig();
    const msgs = [
      { role: 'system',  content: 'You are a concise crypto trading expert assistant. Answer in the user\'s language.' },
      { role: 'user',    content: question },
    ];
    const result = await CloudAI.chat(msgs);
    removeMsgById(loadId);
    appendChatMsg('assistant', result);
  } catch (e) {
    removeMsgById(loadId);
    appendChatMsg('error', 'Error: ' + e.message);
  }
}

let _msgCounter = 0;
function appendChatMsg(role, content) {
  const msgs  = document.getElementById('aiChatMessages');
  if (!msgs) return;
  const id    = `msg-${++_msgCounter}`;
  const el    = document.createElement('div');
  const cls   = { user: 'ai-message-user', assistant: 'ai-message-assistant', error: 'ai-message-error' };
  el.className = `ai-message ${cls[role] || 'ai-message-system'}`;
  el.id = id;
  el.textContent = content; // safe text (no innerHTML with user content)
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}

function appendLoadingMsg() {
  const msgs = document.getElementById('aiChatMessages');
  if (!msgs) return;
  const id = `msg-${++_msgCounter}`;
  const el = document.createElement('div');
  el.className = 'ai-message ai-message-loading';
  el.id = id;
  el.innerHTML = `<span>Pensando</span><div class="typing-dots"><span></span><span></span><span></span></div>`;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}

function removeMsgById(id) {
  document.getElementById(id)?.remove();
}

/* ── Settings page ───────────────────────────────────────────── */
function renderSettingsPage() {
  const list = document.getElementById('aiKeyList');
  if (!list) return;
  const cfg = CloudAI.getConfig();
  list.innerHTML = CloudAI.providerIds.map(provId => {
    const prov = CloudAI.PROVIDERS[provId];
    const hasKey = !!cfg.keys?.[provId];
    return `<div class="ai-key-item">
      <label class="ai-key-label">${prov.name}</label>
      <input type="password" class="text-input ai-key-input" data-prov="${provId}"
        placeholder="API key para ${prov.name}"
        value="${hasKey ? '••••••••••••' : ''}"
        autocomplete="off" />
    </div>`;
  }).join('');

  // Restore server URL
  const serverInput = document.getElementById('serverUrl');
  if (serverInput) serverInput.value = APP.serverUrl;

  // Restore Pionex API keys
  const pkEl = document.getElementById('settingsPionexKey');
  const psEl = document.getElementById('settingsPionexSecret');
  const savedPk = localStorage.getItem('pionex_api_key');
  const savedPs = localStorage.getItem('pionex_api_secret');
  if (pkEl && savedPk) pkEl.value = savedPk;
  if (psEl && savedPs) psEl.value = savedPs;

  renderSecuritySettings();
}

function saveSettings() {
  // Proxy URL (optional)
  const serverInput = document.getElementById('serverUrl');
  if (serverInput) {
    APP.serverUrl = serverInput.value.trim().replace(/\/$/, '');
    localStorage.setItem('pionex_server', APP.serverUrl);
    // Si hay URL de proxy configurada, usarla; si no, modo directo
    APP.directMode = !APP.serverUrl;
  }
  // Pionex API keys — guardar en localStorage
  const pk = document.getElementById('settingsPionexKey')?.value.trim();
  const ps = document.getElementById('settingsPionexSecret')?.value.trim();
  if (pk !== undefined) {
    if (pk) localStorage.setItem('pionex_api_key', pk);
    else    localStorage.removeItem('pionex_api_key');
  }
  if (ps !== undefined) {
    if (ps) localStorage.setItem('pionex_api_secret', ps);
    else    localStorage.removeItem('pionex_api_secret');
  }
  // Cloud AI keys
  document.querySelectorAll('.ai-key-input').forEach(inp => {
    const provId = inp.dataset.prov;
    const val = inp.value.trim();
    if (val && !val.includes('•')) {
      CloudAI.setKey(provId, val);
    }
  });
  toast('Ajustes guardados', 'success');
}

async function testConnection() {
  const msg = document.getElementById('connStatusMsg');
  if (msg) msg.textContent = 'Probando...';
  try {
    await apiFetch('/api/symbols');
    if (msg) { msg.textContent = '✓ Conexión OK'; msg.className = 'conn-status-msg ok'; }
    updateConnStatus(true);
    toast('Conexión exitosa', 'success');
  } catch (e) {
    if (msg) { msg.textContent = '✗ Sin conexión: ' + e.message; msg.className = 'conn-status-msg err'; }
    updateConnStatus(false);
    toast('Sin conexión al servidor', 'error');
  }
}

function updateConnStatus(ok) {
  const dot = document.getElementById('connIndicator')?.querySelector('.conn-dot');
  if (dot) dot.className = `conn-dot ${ok ? 'connected' : 'disconnected'}`;
}

/* ── Theme ───────────────────────────────────────────────────── */
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  localStorage.setItem('pionex_theme', dark ? 'dark' : 'light');
  const icon = document.getElementById('themeIcon');
  if (icon) icon.setAttribute('name', dark ? 'moon-outline' : 'sunny-outline');
  const toggle = document.getElementById('darkModeToggle');
  if (toggle) toggle.checked = dark;
}

/* ── Seguridad — Cifrado PIN ─────────────────────────────────── */
function renderSecuritySettings() {
  const statusEl  = document.getElementById('cryptoStatusLabel');
  const removeBtn = document.getElementById('removePinBtn');
  const setPinBtn = document.getElementById('setPinBtn');
  const curRow    = document.getElementById('currentPinRow');
  if (!statusEl) return;

  if (!CryptoStore.supported) {
    statusEl.innerHTML = '<span class="red">No disponible (WebView antiguo)</span>';
    if (setPinBtn) setPinBtn.disabled = true;
    return;
  }
  const has  = CryptoStore.hasPIN();
  const open = CryptoStore.isUnlocked();
  if (has) {
    statusEl.innerHTML = open
      ? '<span class="green">&#128275; Activo — AES-GCM 256-bit</span>'
      : '<span class="red">&#128274; Bloqueado</span>';
    if (removeBtn) removeBtn.style.display = '';
    if (curRow)    curRow.style.display    = '';   // mostrar campo "PIN actual" para cambio
  } else {
    statusEl.innerHTML = '&#128275; Sin PIN (texto plano)';
    if (removeBtn) removeBtn.style.display = 'none';
    if (curRow)    curRow.style.display    = 'none';
  }
}

/**
 * Muestra el overlay de desbloqueo PIN y devuelve una Promise
 * que resuelve cuando se desbloquea o se salta.
 */
function showPinOverlay() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('pinOverlay');
    if (!overlay) return resolve();
    overlay.style.display = 'flex';

    const input   = document.getElementById('pinInput');
    const btn     = document.getElementById('pinUnlockBtn');
    const errEl   = document.getElementById('pinError');
    const skipBtn = document.getElementById('pinSkipBtn');

    async function tryUnlock() {
      const pin = input?.value?.trim();
      if (!pin) { if (errEl) errEl.textContent = 'Introduce tu PIN'; return; }
      if (errEl) errEl.textContent = 'Verificando…';
      const ok = await CryptoStore.unlock(pin);
      if (!ok) {
        if (errEl) errEl.textContent = '❌ PIN incorrecto';
        if (input) { input.value = ''; input.focus(); }
        return;
      }
      await CloudAI.init();   // re-carga config con claves descifradas
      overlay.style.display = 'none';
      resolve();
    }

    btn?.addEventListener('click', tryUnlock);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
    skipBtn?.addEventListener('click', () => { overlay.style.display = 'none'; resolve(); });
    input?.focus();
  });
}

/* ── Init & Event Bindings ───────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  // ── Crypto init: si hay PIN configurado, mostrar overlay de desbloqueo
  await CloudAI.init();
  if (typeof CryptoStore !== 'undefined' && CryptoStore.hasPIN() && !CryptoStore.isUnlocked()) {
    await showPinOverlay();
  }

  // Notificar a la app nativa (Sketchware) que la web está lista
  try { window.Android?.onAppReady?.(); } catch {}

  // Theme
  const savedTheme = localStorage.getItem('pionex_theme') || 'dark';
  applyTheme(savedTheme === 'dark');

  // Bottom nav
  document.querySelectorAll('.bn-item').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });

  // Theme toggle
  document.getElementById('themeBtn')?.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    applyTheme(!isDark);
  });
  document.getElementById('darkModeToggle')?.addEventListener('change', e => applyTheme(e.target.checked));

  // Dashboard: AI banner
  document.getElementById('goToAiBtn')?.addEventListener('click', () => navigateTo('ai'));
  document.getElementById('quickBuyBtn')?.addEventListener('click', () => {
    APP.orderSide = 'BUY';
    navigateTo('trading');
  });
  document.getElementById('quickSellBtn')?.addEventListener('click', () => {
    APP.orderSide = 'SELL';
    navigateTo('trading');
  });

  // Dashboard movers tabs
  document.querySelectorAll('.stab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      APP.moverTab = btn.dataset.tab;
      renderMovers(Object.values(APP.tickers), APP.moverTab);
    });
  });

  // Market: coin cards
  document.querySelectorAll('.market-coin-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.market-coin-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      APP.selectedSymbol = card.dataset.symbol;
      localStorage.setItem('pionex_sym', APP.selectedSymbol);
      document.getElementById('symSelectLabel').textContent = APP.selectedSymbol.replace('_', '/');
      navigateTo('market');
    });
  });

  // Market: symbol selector
  document.getElementById('symSelectBtn')?.addEventListener('click', openSymPicker);
  document.getElementById('symPickerOverlay')?.addEventListener('click', e => {
    if (e.target.id === 'symPickerOverlay') closeSymPicker();
  });
  document.getElementById('symSearch')?.addEventListener('input', e => {
    renderSymPickerList(e.target.value);
  });
  document.getElementById('symPickerList')?.addEventListener('click', e => {
    const item = e.target.closest('.sym-picker-item');
    if (!item) return;
    APP.selectedSymbol = item.dataset.sym;
    localStorage.setItem('pionex_sym', APP.selectedSymbol);
    document.getElementById('symSelectLabel').textContent = APP.selectedSymbol.replace('_', '/');
    closeSymPicker();
    loadChart();
  });

  // Market: intervals
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      APP.selectedInterval = btn.dataset.iv;
      // Destroy and recreate chart for new interval
      if (APP.chart) { APP.chart.remove(); APP.chart = null; APP.candleSeries = null; }
      loadChart();
    });
  });

  // Market: indicator chips
  document.querySelectorAll('.ind-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ind-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Market: AI analysis refresh
  document.getElementById('analysisRefreshBtn')?.addEventListener('click', loadAIAnalysis);

  // AI page: provider buttons
  document.querySelectorAll('.prov-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.prov-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const provId = btn.dataset.prov;
      const cfg = CloudAI.getConfig();
      const firstModel = CloudAI.getModels(provId)[0]?.id || '';
      populateModelSelect(provId, firstModel);
      const keyInput = document.getElementById('aiApiKeyInput');
      if (keyInput) keyInput.value = cfg.keys?.[provId] ? '••••••••••••' : '';
      const badge = document.getElementById('aiProviderBadge');
      if (badge) badge.textContent = CloudAI.PROVIDERS[provId]?.name || provId;
    });
  });

  // AI page: save provider button
  document.getElementById('saveProviderBtn')?.addEventListener('click', () => {
    const provBtn = document.querySelector('.prov-btn.active');
    const provId  = provBtn?.dataset.prov || 'claude';
    const model   = document.getElementById('aiModelSelect')?.value;
    const keyInput = document.getElementById('aiApiKeyInput');
    const key = keyInput?.value.trim();
    const cleanKey = key && !key.includes('•') ? key : null;
    CloudAI.setProvider(provId, model, cleanKey);
    toast('Configuración guardada', 'success');
  });

  // Eye button (show/hide API key)
  document.getElementById('eyeBtn')?.addEventListener('click', () => {
    const input = document.getElementById('aiApiKeyInput');
    const icon  = document.getElementById('eyeBtn');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    icon.querySelector('ion-icon')?.setAttribute('name', show ? 'eye-off-outline' : 'eye-outline');
  });

  // AI page: run analysis
  document.getElementById('runAnalysisBtn')?.addEventListener('click', runFullAnalysis);
  document.getElementById('sendChatBtn')?.addEventListener('click', sendChatQuestion);
  document.getElementById('chatQuestionInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChatQuestion();
  });

  // AI page: mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // AI page: symbol chip remove
  document.getElementById('aiSymbolChips')?.addEventListener('click', e => {
    if (e.target.classList.contains('chip-remove')) {
      e.target.closest('.sym-chip')?.remove();
    }
  });

  // AI page: add symbol
  document.getElementById('addSymbolBtn')?.addEventListener('click', () => openSymPicker());
  // When a symbol is picked in AI context, add it as a chip
  const originalPickerList = document.getElementById('symPickerList');
  if (originalPickerList) {
    originalPickerList.addEventListener('click', e => {
      if (APP.currentPage === 'ai') {
        const item = e.target.closest('.sym-picker-item');
        if (!item) return;
        const sym = item.dataset.sym;
        addAISymbolChip(sym);
        closeSymPicker();
      }
    });
  }

  // Bot controls
  document.getElementById('startBotBtn')?.addEventListener('click', startBot);
  document.getElementById('stopBotBtn')?.addEventListener('click', stopBot);

  // Bot: dryRun toggle → show/hide real-mode warning
  document.getElementById('dryRunToggle')?.addEventListener('change', e => {
    const warn = document.getElementById('realModeWarning');
    if (warn) warn.style.display = e.target.checked ? 'none' : 'block';
  });

  // Bot: mode → show/hide symbol chips (hidden in autonomous mode)
  document.getElementById('botMode')?.addEventListener('change', e => {
    const sec = document.getElementById('botSymbolsSection');
    if (sec) sec.style.display = e.target.value === 'autonomous' ? 'none' : 'block';
  });
  // Init symbol section visibility
  (() => {
    const sec = document.getElementById('botSymbolsSection');
    const modeEl = document.getElementById('botMode');
    if (sec && modeEl) sec.style.display = modeEl.value === 'autonomous' ? 'none' : 'block';
  })();

  // Bot symbol chips toggle
  document.querySelectorAll('.bot-sym-chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  // Trading: order type tabs
  document.querySelectorAll('.otab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.otab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      APP.orderSide = btn.dataset.type;
      const placeBtn = document.getElementById('placeOrderBtn');
      if (placeBtn) {
        placeBtn.textContent = APP.orderSide === 'BUY' ? 'Confirmar Compra' : 'Confirmar Venta';
        placeBtn.style.background = APP.orderSide === 'BUY' ? '' : 'var(--red)';
      }
      updateOrderPreview();
    });
  });

  // Trading: amount presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pct = parseInt(btn.dataset.pct);
      try {
        const data = await apiFetch('/api/balances');
        const balances = data.balances || data;
        const usdt = parseFloat(balances?.USDT?.free || balances?.USDT || 0);
        const amount = ((usdt * pct) / 100).toFixed(2);
        const input = document.getElementById('orderAmount');
        if (input) { input.value = amount; updateOrderPreview(); }
      } catch {
        const input = document.getElementById('orderAmount');
        if (input) { input.value = pct; updateOrderPreview(); }
      }
    });
  });

  // Trading: order symbol / SL / TP change → preview
  ['orderSymbol', 'orderSL', 'orderTP'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateOrderPreview);
  });

  // Trading: place order
  document.getElementById('placeOrderBtn')?.addEventListener('click', placeOrder);
  document.getElementById('executeOrderBtn')?.addEventListener('click', executeOrder);
  document.getElementById('cancelOrderBtn')?.addEventListener('click', () => {
    document.getElementById('confirmOrderOverlay')?.classList.remove('open');
  });
  document.getElementById('confirmOrderOverlay')?.addEventListener('click', e => {
    if (e.target.id === 'confirmOrderOverlay') e.target.classList.remove('open');
  });

  // Settings
  document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettings);
  document.getElementById('testConnectionBtn')?.addEventListener('click', testConnection);

  // Settings: Seguridad — PIN cifrado
  renderSecuritySettings();

  document.getElementById('setPinBtn')?.addEventListener('click', async () => {
    const newPin = document.getElementById('newPinInput')?.value?.trim();
    const curPin = document.getElementById('currentPinInput')?.value?.trim() || null;
    if (!newPin || newPin.length < 4) {
      toast('El PIN debe tener al menos 4 caracteres', 'error');
      return;
    }
    if (CryptoStore.hasPIN() && !curPin) {
      toast('Introduce también el PIN actual', 'error');
      return;
    }
    const ok = await CryptoStore.setPIN(newPin, curPin || null);
    if (!ok) {
      toast('PIN actual incorrecto', 'error');
      return;
    }
    // Re-guarda la config cifrada con el nuevo PIN
    const cfg = CloudAI.getConfig();
    await CryptoStore.save('pionex_cloud_ai', JSON.stringify(cfg));
    document.getElementById('newPinInput').value     = '';
    const curEl = document.getElementById('currentPinInput');
    if (curEl) curEl.value = '';
    toast('PIN establecido · API keys cifradas con AES-256 ✓', 'success');
    renderSecuritySettings();
  });

  document.getElementById('removePinBtn')?.addEventListener('click', async () => {
    const pin = prompt('Introduce el PIN actual para quitar el cifrado:');
    if (!pin) return;
    const ok = await CryptoStore.removePIN(pin);
    if (ok) {
      toast('Cifrado eliminado · keys en texto plano', 'info');
      renderSecuritySettings();
    } else {
      toast('PIN incorrecto', 'error');
    }
  });

  // Navigate to saved page
  navigateTo(APP.currentPage);

  // Start polling
  loadTickers();
  setInterval(loadTickers, 8000);
});

function addAISymbolChip(sym) {
  const chips = document.getElementById('aiSymbolChips');
  if (!chips) return;
  // Avoid duplicates
  if (chips.querySelector(`[data-sym="${sym}"]`)) return;
  const label = sym.replace('_USDT', '') + '/USDT';
  const chip  = document.createElement('span');
  chip.className = 'sym-chip active';
  chip.dataset.sym = sym;
  chip.innerHTML = `${label} <button class="chip-remove">×</button>`;
  chips.appendChild(chip);
}
