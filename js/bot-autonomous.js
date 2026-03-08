/* ═══════════════════════════════════════════════════════════════
   Pionex Bot — Autonomous Trading Engine (Cloud AI)
   Full port of src/ai_trader.py algorithm
   Uses CloudAI.chat() instead of local GGUF model
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const BotEngine = (() => {
  /* ── Constants ─────────────────────────────────────────────── */
  const MIN_BUY_USDT       = 90;
  const MAX_COIN_PRICE_USDT = 300;
  const MIN_PROFIT_USDT    = 0.33;
  const TRAILING_PCT       = 0.015;
  const MAX_LOGS           = 200;

  /* ── Mutable State ──────────────────────────────────────────── */
  let running         = false;
  let cycleTimeout    = null;
  let monitorInterval = null;
  let dailyTradeCount = 0;
  let lastDayReset    = '';
  let circuitBreaker  = false;
  let virtualUsdt     = 1000;

  /* open positions: { [symbol]: { entryPrice, size, amountUSD, entryTime,
                                   highWatermark, trailingStop, atr } }   */
  const openPositions = {};

  const sessionStats = {
    cycles: 0, buys: 0, sells: 0, holds: 0, errors: 0,
    totalPnL: 0, winTrades: 0, lossTrades: 0,
    peakPnL: 0, maxDrawdown: 0, bestTrade: 0, worstTrade: 0,
  };

  const tradeLogs    = [];   // { type, msg, time }
  const tradeHistory = [];   // trade records

  /* ── Config (defaults matching ai_trader.py) ────────────────── */
  const config = {
    tradeMode:       'autonomous',
    symbols:         ['BTC_USDT', 'ETH_USDT'],
    interval:        '15M',
    cycleMinutes:    5,
    maxTradesPerDay: 10,
    riskLevel:       'moderate',
    maxPositionUSD:  100,
    stopLossPct:     3,
    takeProfitPct:   5,
    dryRun:          true,
    maxDailyLossPct: 5,
    minProfitUsdt:   MIN_PROFIT_USDT,
    tradeAmountUSD:  null,
  };

  /* ── Helpers ────────────────────────────────────────────────── */
  function serverUrl() {
    return localStorage.getItem('pionex_server') || 'http://localhost:8000';
  }

  function fmt(v, d = 2) {
    if (v == null || isNaN(v)) return 'N/A';
    return parseFloat(v).toFixed(d);
  }

  function sfmt(v) {
    v = parseFloat(v);
    if (isNaN(v)) return 'N/A';
    if (v >= 1000) return v.toFixed(0);
    if (v >= 10)   return v.toFixed(2);
    if (v >= 1)    return v.toFixed(3);
    return v.toFixed(5);
  }

  /* ── Logging ────────────────────────────────────────────────── */
  function addLog(type, msg) {
    const entry = { type, msg, time: new Date().toLocaleTimeString('es', { hour12: false }) };
    tradeLogs.push(entry);
    if (tradeLogs.length > MAX_LOGS) tradeLogs.shift();
    renderLogEntry(entry);
  }

  function renderLogEntry(entry) {
    const logEl = document.getElementById('botLog');
    if (!logEl) return;
    const icons = {
      info: 'ℹ️', warn: '⚠️', error: '❌',
      buy: '🟢', sell: '🔴', hold: '⏸', analysis: '📊', debug: '🔍',
    };
    const div = document.createElement('div');
    div.className = `log-line log-${entry.type}`;
    div.textContent = `[${entry.time}] ${icons[entry.type] || ''} ${entry.msg}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.children.length > 120) logEl.removeChild(logEl.firstChild);
  }

  /* ── Persistence ────────────────────────────────────────────── */
  function saveState() {
    try {
      localStorage.setItem('bot_positions',   JSON.stringify(openPositions));
      localStorage.setItem('bot_stats',       JSON.stringify(sessionStats));
      localStorage.setItem('bot_daily',       JSON.stringify({ count: dailyTradeCount, day: lastDayReset, cb: circuitBreaker }));
      localStorage.setItem('bot_trades',      JSON.stringify(tradeHistory.slice(-100)));
      if (config.dryRun) localStorage.setItem('bot_virtual_usdt', String(virtualUsdt));
    } catch (_) {}
  }

  function loadState() {
    try {
      const pos = localStorage.getItem('bot_positions');
      if (pos) { const p = JSON.parse(pos); Object.assign(openPositions, p); }

      const daily = JSON.parse(localStorage.getItem('bot_daily') || '{}');
      if (daily.day) {
        dailyTradeCount = daily.count || 0;
        lastDayReset    = daily.day;
        circuitBreaker  = daily.cb || false;
      }

      if (config.dryRun) {
        virtualUsdt = parseFloat(localStorage.getItem('bot_virtual_usdt') || '1000');
      }

      const trades = localStorage.getItem('bot_trades');
      if (trades) { const t = JSON.parse(trades); tradeHistory.push(...t); }
    } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     INDICATOR CALCULATIONS (port of bot_engine.py)
  ══════════════════════════════════════════════════════════════ */

  function calcSMA(arr, period) {
    const res = new Array(arr.length).fill(null);
    for (let i = period - 1; i < arr.length; i++) {
      const sl = arr.slice(i - period + 1, i + 1);
      res[i] = sl.reduce((a, b) => a + b, 0) / period;
    }
    return res;
  }

  function calcEMA(arr, period) {
    const res = new Array(arr.length).fill(null);
    if (arr.length < period) return res;
    const k = 2 / (period + 1);
    let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    res[period - 1] = ema;
    for (let i = period; i < arr.length; i++) {
      ema = arr[i] * k + ema * (1 - k);
      res[i] = ema;
    }
    return res;
  }

  function calcEMAFromSparse(arr, period) {
    const res = new Array(arr.length).fill(null);
    const k = 2 / (period + 1);
    let seed = 0, count = 0, startIdx = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] != null) {
        seed += arr[i]; count++;
        if (count === period) { startIdx = i; break; }
      }
    }
    if (startIdx < 0) return res;
    let ema = seed / period;
    res[startIdx] = ema;
    for (let i = startIdx + 1; i < arr.length; i++) {
      if (arr[i] != null) { ema = arr[i] * k + ema * (1 - k); res[i] = ema; }
    }
    return res;
  }

  function calcRSI(closes, period = 14) {
    const res = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return res;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period; i < closes.length; i++) {
      if (i > period) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
      }
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      res[i] = 100 - 100 / (1 + rs);
    }
    return res;
  }

  function calcMACD(closes, fast = 12, slow = 26, sig = 9) {
    const emaF = calcEMA(closes, fast);
    const emaS = calcEMA(closes, slow);
    const macdLine = closes.map((_, i) =>
      emaF[i] != null && emaS[i] != null ? emaF[i] - emaS[i] : null);
    const sigLine  = calcEMAFromSparse(macdLine, sig);
    const hist     = macdLine.map((v, i) =>
      v != null && sigLine[i] != null ? v - sigLine[i] : null);
    return { macd: macdLine, signal: sigLine, histogram: hist };
  }

  function calcBollinger(closes, period = 20, mult = 2) {
    const sma = calcSMA(closes, period);
    return closes.map((_, i) => {
      if (sma[i] == null) return null;
      const sl = closes.slice(i - period + 1, i + 1);
      const std = Math.sqrt(sl.reduce((a, b) => a + (b - sma[i]) ** 2, 0) / period);
      return { upper: sma[i] + mult * std, middle: sma[i], lower: sma[i] - mult * std };
    });
  }

  function calcATR(highs, lows, closes, period = 14) {
    const trs = closes.map((c, i) => {
      if (i === 0) return highs[i] - lows[i];
      const prev = closes[i - 1];
      return Math.max(highs[i] - lows[i], Math.abs(highs[i] - prev), Math.abs(lows[i] - prev));
    });
    const res = new Array(closes.length).fill(null);
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    res[period - 1] = atr;
    for (let i = period; i < closes.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      res[i] = atr;
    }
    return res;
  }

  function calcADX(highs, lows, closes, period = 14) {
    const n = closes.length;
    const res = new Array(n).fill(null);
    if (n < period * 2 + 1) return res;

    const pDM = new Array(n).fill(0), mDM = new Array(n).fill(0), tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
      pDM[i]   = (up > down && up > 0) ? up : 0;
      mDM[i]   = (down > up && down > 0) ? down : 0;
      tr[i]    = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }

    let atr = 0, sumP = 0, sumM = 0;
    for (let i = 1; i <= period; i++) { atr += tr[i]; sumP += pDM[i]; sumM += mDM[i]; }

    const dxArr = [];
    for (let i = period; i < n; i++) {
      if (i > period) {
        atr  = atr  - atr  / period + tr[i];
        sumP = sumP - sumP / period + pDM[i];
        sumM = sumM - sumM / period + mDM[i];
      }
      const pdi = atr > 0 ? 100 * sumP / atr : 0;
      const mdi = atr > 0 ? 100 * sumM / atr : 0;
      dxArr.push(pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
    }

    let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let ri = period * 2 - 1;
    res[ri] = adx;
    for (let i = period; i < dxArr.length; i++) {
      adx = (adx * (period - 1) + dxArr[i]) / period;
      res[ri + (i - period + 1)] = adx;
    }
    return res;
  }

  function calcVWAP(highs, lows, closes, volumes) {
    let cumPV = 0, cumV = 0;
    return closes.map((c, i) => {
      const tp = (highs[i] + lows[i] + c) / 3;
      cumPV += tp * volumes[i]; cumV += volumes[i];
      return cumV > 0 ? cumPV / cumV : c;
    });
  }

  function calcSMAFromSparse(arr, period) {
    const res = new Array(arr.length).fill(null);
    for (let i = period - 1; i < arr.length; i++) {
      const sl = arr.slice(i - period + 1, i + 1).filter(v => v != null);
      if (sl.length === period) res[i] = sl.reduce((a, b) => a + b, 0) / period;
    }
    return res;
  }

  function calcStochRSI(closes, rsiP = 14, stochP = 14, kP = 3, dP = 3) {
    const rsi = calcRSI(closes, rsiP);
    const stoch = new Array(closes.length).fill(null);
    for (let i = rsiP + stochP - 2; i < closes.length; i++) {
      const win = rsi.slice(i - stochP + 1, i + 1).filter(v => v != null);
      if (win.length < stochP) continue;
      const mn = Math.min(...win), mx = Math.max(...win);
      stoch[i] = mx !== mn ? ((rsi[i] - mn) / (mx - mn)) * 100 : 50;
    }
    const kLine = calcSMAFromSparse(stoch, kP);
    const dLine = calcSMAFromSparse(kLine, dP);
    return closes.map((_, i) =>
      kLine[i] != null && dLine[i] != null ? { k: kLine[i], d: dLine[i] } : null);
  }

  function calcOBV(closes, volumes) {
    const res = [volumes[0] || 0];
    for (let i = 1; i < closes.length; i++) {
      const prev = res[i - 1];
      if (closes[i] > closes[i - 1])      res.push(prev + volumes[i]);
      else if (closes[i] < closes[i - 1]) res.push(prev - volumes[i]);
      else                                res.push(prev);
    }
    return res;
  }

  function calcCMF(highs, lows, closes, volumes, period = 20) {
    const mfv = closes.map((c, i) => {
      const rng = highs[i] - lows[i];
      const mfm = rng > 0 ? ((c - lows[i]) - (highs[i] - c)) / rng : 0;
      return mfm * volumes[i];
    });
    const res = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      const sv = mfv.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      const vv = volumes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      res[i] = vv > 0 ? sv / vv : 0;
    }
    return res;
  }

  function detectCandlePatterns(klines) {
    const pats = [];
    const n = klines.length;
    if (n < 2) return pats;
    const c = klines[n - 1], p1 = klines[n - 2];

    const cBody = Math.abs(c.close - c.open);
    const cRange = c.high - c.low;
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const upperShadow = c.high - Math.max(c.open, c.close);

    if (cRange > 0 && cBody < cRange * 0.3 && lowerShadow > cBody * 2 && upperShadow < cBody)
      pats.push('hammer');
    if (cRange > 0 && cBody < cRange * 0.3 && upperShadow > cBody * 2 && lowerShadow < cBody)
      pats.push('shooting_star');
    if (cRange > 0 && cBody / cRange < 0.05)
      pats.push('doji');
    if (p1.close < p1.open && c.close > c.open && c.open < p1.close && c.close > p1.open)
      pats.push('bullish_engulfing');
    if (p1.close > p1.open && c.close < c.open && c.open > p1.close && c.close < p1.open)
      pats.push('bearish_engulfing');

    return pats;
  }

  function detectRSIDivergence(closes, rsiArr, lookback = 14) {
    const n = closes.length;
    if (n < lookback + 2) return null;
    const slcP = closes.slice(n - lookback);
    const slcR = rsiArr.slice(n - lookback).filter(v => v != null);
    if (slcR.length < 4) return null;

    const minPi = slcP.indexOf(Math.min(...slcP));
    const maxPi = slcP.indexOf(Math.max(...slcP));
    const latP  = slcP[slcP.length - 1];
    const latR  = slcR[slcR.length - 1];

    if (latP < slcP[minPi] && latR > slcR[minPi]) return 'bullish';
    if (latP > slcP[maxPi] && latR < slcR[maxPi]) return 'bearish';
    return null;
  }

  /* ══════════════════════════════════════════════════════════════
     MARKET DATA FETCH  (full port of get_market_data())
  ══════════════════════════════════════════════════════════════ */

  async function getMarketData(symbol) {
    try {
      const resp = await fetch(
        `${serverUrl()}/api/klines?symbol=${symbol}&interval=${config.interval}&limit=200`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data   = await resp.json();
      const klines = data.data?.klines || data.klines || [];
      if (klines.length < 30) return null;

      const opens   = klines.map(k => parseFloat(k.open));
      const highs   = klines.map(k => parseFloat(k.high));
      const lows    = klines.map(k => parseFloat(k.low));
      const closes  = klines.map(k => parseFloat(k.close));
      const volumes = klines.map(k => parseFloat(k.volume));
      const n = closes.length - 1;

      const rsiArr    = calcRSI(closes, 14);
      const macdData  = calcMACD(closes, 12, 26, 9);
      const bbArr     = calcBollinger(closes, 20, 2);
      const sma20Arr  = calcSMA(closes, 20);
      const sma50Arr  = calcSMA(closes, 50);
      const ema9Arr   = calcEMA(closes, 9);
      const ema21Arr  = calcEMA(closes, 21);
      const ema200Arr = calcEMA(closes, 200);
      const atrArr    = calcATR(highs, lows, closes, 14);
      const adxArr    = calcADX(highs, lows, closes, 14);
      const vwapArr   = calcVWAP(highs, lows, closes, volumes);
      const stochArr  = calcStochRSI(closes);
      const obvArr    = calcOBV(closes, volumes);
      const cmfArr    = calcCMF(highs, lows, closes, volumes, 20);
      const patterns  = detectCandlePatterns(klines.slice(-10).map(k => ({
        open: parseFloat(k.open), high: parseFloat(k.high),
        low:  parseFloat(k.low),  close: parseFloat(k.close),
      })));
      const rsiDiv = detectRSIDivergence(closes, rsiArr, 20);

      const volAvg = volumes.slice(Math.max(0, n - 20), n).reduce((a, b) => a + b, 0) / Math.min(20, n);
      const volRatio = volAvg > 0 ? volumes[n] / volAvg : 1;

      return {
        symbol,
        price: { open: opens[n], high: highs[n], low: lows[n], close: closes[n], volume: volumes[n] },
        rsi:      rsiArr[n],
        macd: {
          macd:          macdData.macd[n],
          signal:        macdData.signal[n],
          histogram:     macdData.histogram[n],
          prevHistogram: macdData.histogram[n - 1],
        },
        bollinger:      bbArr[n],
        sma20:          sma20Arr[n],
        sma50:          sma50Arr[n],
        ema9:           ema9Arr[n],
        ema21:          ema21Arr[n],
        ema200:         ema200Arr[n],
        atr:            atrArr[n],
        adx:            adxArr[n],
        vwap:           vwapArr[n],
        stochRsi:       stochArr[n],
        obv:            obvArr[n],
        cmf:            cmfArr[n],
        candlePatterns: patterns,
        rsiDivergence:  rsiDiv,
        volumeRatio:    volRatio,
        recentCandles:  klines.slice(-10).map(k => ({
          open:   parseFloat(k.open),
          high:   parseFloat(k.high),
          low:    parseFloat(k.low),
          close:  parseFloat(k.close),
          volume: parseFloat(k.volume),
        })),
      };
    } catch (e) {
      addLog('error', `Error datos ${symbol}: ${e.message}`);
      return null;
    }
  }

  /* ── Fear & Greed Index (cached 1 h) ────────────────────────── */
  let fgCache = null, fgExpiry = 0;
  async function getFearGreed() {
    if (fgCache && Date.now() < fgExpiry) return fgCache;
    try {
      const resp = await fetch('https://api.alternative.me/fng/?limit=1',
        { signal: AbortSignal.timeout(5000) });
      const data = await resp.json();
      const item = data.data?.[0];
      if (item) {
        fgCache   = { value: parseInt(item.value), label: item.value_classification };
        fgExpiry  = Date.now() + 3_600_000;
        return fgCache;
      }
    } catch (_) {}
    return null;
  }

  /* ── Multi-Timeframe Context ─────────────────────────────────── */
  const MTF_MAP = { '1M': ['5M','15M'], '5M': ['15M','1H'], '15M': ['1H','4H'], '1H': ['4H','1D'] };

  async function getMTFContext(symbol) {
    const tfs = MTF_MAP[config.interval] || ['1H', '4H'];
    const results = {};
    await Promise.all(tfs.map(async tf => {
      try {
        const resp = await fetch(
          `${serverUrl()}/api/klines?symbol=${symbol}&interval=${tf}&limit=100`,
          { signal: AbortSignal.timeout(8000) }
        );
        const data   = await resp.json();
        const klines = data.data?.klines || data.klines || [];
        if (klines.length < 30) return;
        const closes = klines.map(k => parseFloat(k.close));
        const highs  = klines.map(k => parseFloat(k.high));
        const lows   = klines.map(k => parseFloat(k.low));
        const nn = closes.length - 1;
        const rsi    = calcRSI(closes, 14);
        const sma20  = calcSMA(closes, 20);
        const sma50  = calcSMA(closes, 50);
        const ema200 = calcEMA(closes, 200);
        const adxA   = calcADX(highs, lows, closes, 14);
        const trend  = sma20[nn] != null && sma50[nn] != null
          ? (sma20[nn] > sma50[nn] ? 'ALCISTA' : 'BAJISTA') : 'N/A';
        results[tf] = {
          rsi:   rsi[nn]   != null ? parseFloat(rsi[nn].toFixed(1))   : null,
          trend,
          ema200: ema200[nn],
          adx:   adxA[nn]  != null ? parseFloat(adxA[nn].toFixed(1))  : null,
        };
      } catch (_) {}
    }));
    return Object.keys(results).length ? results : null;
  }

  /* ══════════════════════════════════════════════════════════════
     PROMPT BUILDING  (full port of build_system_prompt + build_prompt)
  ══════════════════════════════════════════════════════════════ */

  function buildSystemPrompt(hasOpenPosition = false) {
    const mode = config.tradeMode;
    const RULES = {
      scalping:     `REGLAS SCALPING (±50 pt mínimo):
• Operar solo en velas 1-5M, ciclos de 1-3 min
• Tomar ganancia rápida con stoploss ajustado
• Solo operar cuando ADX > 20 (tendencia definida)
• Máximo retener 15 minutos
• BUY si score ≥ +50 | SELL si score ≤ -50`,
      daytrading:   `REGLAS DAYTRADING (±40 pt mínimo):
• Mantener posición 2-8 horas, no pasar de 1 día
• Confirmar con MACD + RSI + Bollinger
• Usar volumen para confirmar entradas
• BUY si score ≥ +40 | SELL si score ≤ -40`,
      swingtrading: `REGLAS SWING TRADING (±55 pt mínimo):
• Mantener posición 1-5 días, buscar movimientos del 2-10%
• Confirmar la tendencia con EMA200 y ADX
• Buscar reversiones en soportes/resistencias clave
• BUY si score ≥ +55 | SELL si score ≤ -55`,
      longterm:     `REGLAS LARGO PLAZO (±70 pt BUY / ±65 pt SELL):
• Mantener posición 2+ semanas, buscar ciclos de mercado
• Solo entrar en zonas de acumulación profunda (RSI<30)
• Confirmar con EMA200 y contexto macro
• BUY si score ≥ +70 | SELL si score ≤ -65`,
      autonomous:   `REGLAS MODO AUTÓNOMO (±58 pt mínimo, mínimo 2 confirmadores):
• Selección dinámica de monedas por momentum y volumen
• Ejecutar SOLO si al menos 2 indicadores adicionales confirman
• RSI + MACD + BB como señales primarias
• BUY si score ≥ +58 Y 2+ confirmadores | SELL si score ≤ -58 Y 2+ confirmadores`,
    };

    const warningOpenPos = hasOpenPosition
      ? '\n⚠️ POSICIÓN YA ABIERTA — NO respondas BUY. Solo SELL o HOLD.'
      : '';

    return `Eres un bot de trading algorítmico profesional para Pionex. Tu única tarea es analizar los datos de mercado y emitir una señal JSON estructurada.${warningOpenPos}

${RULES[mode] || RULES.autonomous}

═══ SISTEMA DE PUNTUACIÓN (-100 a +100) ═══

SEÑALES BUY (+):
• RSI < 30: +30 pts (sobreventa extrema)
• RSI 30-40: +15 pts (sobreventa moderada)
• StochRSI < 20: +15 pts
• Histograma MACD creciendo: +10 pts
• Cruce MACD alcista: +25 pts
• Precio en/bajo banda inferior BB: +20 pts
• SMA20 > SMA50: +15 pts (tendencia corto plazo alcista)
• EMA9 cruza EMA21 al alza: +20 pts
• Precio bajo VWAP: +10 pts
• Volumen elevado (>1.5x media): +10 pts
• CMF > +0.10: +10 pts (presión compradora institucional)
• Divergencia RSI alcista: +15 pts
• Patrón vela alcista (hammer/engulfing/morning_star): +10 pts
• Precio sobre EMA200: +10 pts (tendencia macroalcista)

SEÑALES SELL (-):
• RSI > 70: -30 pts (sobrecompra extrema)
• RSI 60-70: -15 pts
• StochRSI > 80: -15 pts
• Histograma MACD decreciendo: -10 pts
• Cruce MACD bajista: -25 pts
• Precio en/sobre banda superior BB: -20 pts
• SMA20 < SMA50: -15 pts
• EMA9 cruza EMA21 a la baja: -20 pts
• Precio sobre VWAP (>+1%): -10 pts
• CMF < -0.10: -10 pts (presión vendedora institucional)
• Divergencia RSI bajista: -15 pts
• Patrón vela bajista (shooting_star/engulfing/evening_star): -10 pts
• Precio bajo EMA200: -10 pts (tendencia macrobajista)

FILTRO: Si ADX < 20 (mercado lateral) → reduce confianza ±30%

═══ FORMATO DE RESPUESTA OBLIGATORIO ═══
SOLO el JSON. Sin texto antes ni después. Sin markdown.

{"action":"BUY","confidence":85,"score":65,"amount_pct":60,"reason":"RSI sobreventa + MACD alcista + volumen elevado","signals":{"rsi":"oversold","macd":"bullish","bb":"lower","trend":"up"},"risk_notes":"ADX > 25 tendencia fuerte"}`;
  }

  function buildUserPrompt(data, mtfContext, fearGreed) {
    const p  = data.price;
    const bb = data.bollinger;
    const pos = openPositions[data.symbol];

    // Bollinger analysis
    let bbSignal = '', bbWidth = 'N/A', bbPosition = 'N/A';
    if (bb) {
      const range = bb.upper - bb.lower;
      bbWidth = range > 0 ? ((range / bb.middle) * 100).toFixed(2) + '%' : 'N/A';
      const pp = range > 0 ? ((p.close - bb.lower) / range) * 100 : 50;
      bbPosition = fmt(pp, 1) + '%';
      if      (pp < 0)    bbSignal = `  ⚠️ PRECIO BAJO BANDA INFERIOR (${fmt(pp,1)}%) → SEÑAL BUY (+20pt)`;
      else if (pp > 150)  bbSignal = `  🚨 MUY POR ENCIMA BANDA SUPERIOR → sobrecompra extrema`;
      else if (pp > 100)  bbSignal = `  ⚠️ PRECIO SOBRE BANDA SUPERIOR (${fmt(pp,1)}%) → SEÑAL SELL (-20pt)`;
      else if (pp <= 25)  bbSignal = `  🟢 Tocando banda INFERIOR (${fmt(pp,1)}%) → señal BUY (+20pt)`;
      else if (pp >= 75)  bbSignal = `  🔴 Tocando banda SUPERIOR (${fmt(pp,1)}%) → señal SELL (-20pt)`;
    }

    // Open position block
    let openPosText = '';
    if (pos) {
      const pnlPct = (p.close - pos.entryPrice) / pos.entryPrice * 100;
      const sl = config.stopLossPct, tp = config.takeProfitPct;
      const signStr = pnlPct >= 0 ? '+' : '';
      let pnlStatus;
      if      (pnlPct >= tp * 0.7)   pnlStatus = `🟢 GANANCIA ALCANZANDO OBJETIVO (${signStr}${fmt(pnlPct,2)}%) → CONSIDERA VENDER`;
      else if (pnlPct > 0)            pnlStatus = `🟡 EN GANANCIA (${signStr}${fmt(pnlPct,2)}%) → evalúa salida si señales se debilitan`;
      else if (pnlPct <= -sl * 0.7)   pnlStatus = `🔴 CERCA DEL STOP-LOSS (${signStr}${fmt(pnlPct,2)}%) → EVALÚA VENDER AHORA`;
      else                            pnlStatus = `🔴 EN PÉRDIDA (${signStr}${fmt(pnlPct,2)}%)`;
      openPosText = `\n\n${'='.repeat(50)}\n🚨 POSICIÓN ABIERTA — DECIDE SI VENDER O MANTENER\nEntrada: $${fmt(pos.entryPrice)} | Precio actual: $${fmt(p.close)}\nPnL: ${pnlStatus}\nStop-loss: -${sl}% | Take-profit: +${tp}%\nACCIÓN PRIORITARIA: Analiza si debes SELL (cerrar) o HOLD (mantener).\nNO respondas BUY — ya tienes posición abierta.\n${'='.repeat(50)}`;
    }

    // Candles text (last 10, recent first)
    const cAndls = (data.recentCandles || []).slice().reverse();
    const candlesText = cAndls.length > 1
      ? cAndls.map((c, i) => `Vela -${i}: O=${fmt(c.open)} H=${fmt(c.high)} L=${fmt(c.low)} C=${fmt(c.close)} V=${fmt(c.volume,2)}`).join('\n')
      : 'Solo 1 vela disponible';

    // ATR
    const atr = data.atr;
    const atrPct = atr ? ((atr / p.close) * 100).toFixed(2) + '%' : 'N/A';
    const atrSL  = atr ? ((atr * 1.5 / p.close) * 100).toFixed(2) + '%' : 'N/A';

    // MTF block
    let mtfText = '';
    if (mtfContext) {
      const lines = Object.entries(mtfContext).map(([tf, d]) => {
        const rsiS   = d.rsi   != null ? `RSI=${d.rsi}` : 'RSI=N/A';
        const adxS   = d.adx   != null ? `ADX=${d.adx}` : 'ADX=N/A';
        const adxW   = (d.adx  != null && d.adx < 20) ? ' ⚠️RANGO' : '';
        const ema200S = d.ema200 != null ? `EMA200=${d.ema200.toFixed(4)}` : 'EMA200=N/A';
        return `  ┌ ${tf}: ${rsiS} | Tendencia=${d.trend} | ${adxS}${adxW} | ${ema200S}`;
      });
      if (lines.length) mtfText = '\n═══ CONFIRMACIÓN MULTI-TIMEFRAME ═══\n' + lines.join('\n');
    }

    // Fear & Greed
    const fg = fearGreed || {};
    const fgText = fg.value != null ? `${fg.value}/100 — ${fg.label}` : 'N/A';

    // Indicator aliases
    const rsi = data.rsi, macd = data.macd || {};
    const sma20 = data.sma20, sma50 = data.sma50;
    const ema9 = data.ema9, ema21 = data.ema21, ema200 = data.ema200;
    const adx = data.adx, vwap = data.vwap, stoch = data.stochRsi;
    const rsiDiv = data.rsiDivergence, patterns = data.candlePatterns || [];
    const volRatio = data.volumeRatio, cmf = data.cmf, obv = data.obv;

    // Trend string
    const trendSMA   = sma20 && sma50   ? (sma20 > sma50 ? 'ALCISTA (SMA20 > SMA50)' : 'BAJISTA (SMA20 < SMA50)') : 'N/A';
    const trendEMA   = ema9  && ema21   ? (ema9  > ema21  ? 'ALCISTA (EMA9 > EMA21)'  : 'BAJISTA (EMA9 < EMA21)')  : 'N/A';
    const trendMacro = ema200 ? (p.close > ema200 ? `ALCISTA (precio > EMA200 $${sfmt(ema200)})` : `BAJISTA (precio < EMA200 $${sfmt(ema200)})`) : 'N/A';

    // ADX
    let adxText = 'N/A', adxSignal = '';
    if (adx != null) {
      if      (adx < 20) { adxText = `${fmt(adx)} 🔶 MERCADO LATERAL/RANGO`;  adxSignal = '  ⚠️ ADX < 20: mercado en rango → reducir confianza en señales de tendencia'; }
      else if (adx < 25) adxText = `${fmt(adx)} tendencia débil`;
      else if (adx < 40) adxText = `${fmt(adx)} ✅ tendencia moderada`;
      else               adxText = `${fmt(adx)} 💪 tendencia fuerte`;
    }

    // VWAP
    let vwapText = 'N/A', vwapSignal = '';
    if (vwap != null) {
      const pct = (p.close - vwap) / vwap * 100;
      vwapText = `$${fmt(vwap)} | precio ${pct >= 0 ? 'SOBRE' : 'BAJO'} VWAP (${fmt(pct,2)}%)`;
      if      (pct < -1.0) vwapSignal = `  🟢 Precio BAJO VWAP (${fmt(pct,2)}%) → favorece BUY (+10pt)`;
      else if (pct >  1.0) vwapSignal = `  🔴 Precio SOBRE VWAP (${fmt(pct,2)}%) → favorece SELL (-10pt)`;
    }

    // Stoch
    let stochText = 'N/A';
    if (stoch) {
      const zone = stoch.k < 20 ? 'SOBREVENTA' : stoch.k > 80 ? 'SOBRECOMPRA' : 'neutral';
      stochText = `%K=${fmt(stoch.k)} %D=${fmt(stoch.d)} [${zone}]`;
    }

    // Volume
    let volText = 'N/A', volSignal = '';
    if (volRatio != null) {
      volText = `${fmt(volRatio)}× media`;
      if      (volRatio >= 1.5) volSignal = `  📊 Volumen ELEVADO (${fmt(volRatio)}×) → confirma movimiento (+10pt)`;
      else if (volRatio <  0.7) volSignal = `  ⚠️ Volumen DÉBIL (${fmt(volRatio)}×) → señal con menor convicción`;
    }

    // CMF
    let cmfText = 'N/A', cmfSignal = '';
    if (cmf != null) {
      if      (cmf >  0.10) { cmfText = `${cmf.toFixed(4)} 🟢 ACUMULACIÓN (+10pt BUY)`;  cmfSignal = '  🟢 CMF > +0.10: flujo institucional COMPRADOR'; }
      else if (cmf < -0.10) { cmfText = `${cmf.toFixed(4)} 🔴 DISTRIBUCIÓN (+10pt SELL)`; cmfSignal = '  🔴 CMF < -0.10: flujo institucional VENDEDOR'; }
      else                    cmfText = `${cmf.toFixed(4)} zona neutral`;
    }

    // Divergence
    let divText = 'ninguna';
    if      (rsiDiv === 'bullish') divText = '🟢 ALCISTA — precio hace mínimo más bajo, RSI hace mínimo más alto (+15pt BUY)';
    else if (rsiDiv === 'bearish') divText = '🔴 BAJISTA — precio hace máximo más alto, RSI hace máximo más bajo (+15pt SELL)';

    // Candle patterns
    const BULL_PATS = new Set(['hammer','bullish_engulfing','morning_star']);
    const BEAR_PATS = new Set(['shooting_star','bearish_engulfing','evening_star','doji']);
    const patText = patterns.length ? patterns.join(', ') : 'ninguno';
    let patSignal = '';
    const bul = patterns.filter(x => BULL_PATS.has(x));
    const bea = patterns.filter(x => BEAR_PATS.has(x));
    if      (bul.length) patSignal = `  🕯️ Patrón ALCISTA detectado: ${bul.join(', ')} (+10pt BUY)`;
    else if (bea.length) patSignal = `  🕯️ Patrón BAJISTA detectado: ${bea.join(', ')} (+10pt SELL)`;

    return `ANÁLISIS PARA: ${data.symbol}
TIMESTAMP: ${new Date().toISOString().slice(0,19)}
NIVEL DE RIESGO: ${config.riskLevel}
MAX POSICIÓN: $${config.maxPositionUSD}
STOP-LOSS: ${config.stopLossPct}% | TAKE-PROFIT: ${config.takeProfitPct}%
ATR(14): ${atr ? fmt(atr,4) : 'N/A'} (${atrPct}) | Stop-loss ATR sugerido: ${atrSL}
TRADES HOY: ${dailyTradeCount}/${config.maxTradesPerDay}
Fear & Greed Index: ${fgText}
DRY RUN: ${config.dryRun ? 'SÍ (simulación)' : 'NO (REAL)'}

═══ DATOS DE MERCADO ═══
Precio actual: $${fmt(p.close)}
Apertura: $${fmt(p.open)} | Máximo: $${fmt(p.high)} | Mínimo: $${fmt(p.low)}
Cambio: ${p.open > 0 ? ((p.close - p.open)/p.open*100).toFixed(2) : '0'}%
Volumen: ${fmt(p.volume,4)} (${volText})${volSignal}

═══ HISTORIAL DE VELAS ÚLTIMAS 10 ═══
${candlesText}${openPosText}${mtfText}

═══ INDICADORES TÉCNICOS (${config.interval}) ═══
RSI(14): ${rsi != null ? parseFloat(rsi).toFixed(1) : 'NO DISPONIBLE'}
Stoch RSI: ${stochText}
Divergencia RSI: ${divText}
MACD: ${macd.macd != null ? `línea=${fmt(macd.macd,4)}, signal=${fmt(macd.signal,4)}, histogram=${fmt(macd.histogram,4)}` : 'NO DISPONIBLE'}
Bollinger(20,2): ${bb ? `superior=$${fmt(bb.upper)}, media=$${fmt(bb.middle)}, inferior=$${fmt(bb.lower)}, ancho=${bbWidth}, posición=${bbPosition}${bbSignal}` : 'NO DISPONIBLE'}
ADX(14): ${adxText}${adxSignal}
VWAP: ${vwapText}${vwapSignal}
OBV: ${obv != null ? fmt(obv,0) : 'N/A'}
CMF(20): ${cmfText}${cmfSignal}
Patrones de velas: ${patText}${patSignal}
SMA(20): ${sma20 != null ? '$' + sfmt(sma20) : 'N/A'}
SMA(50): ${sma50 != null ? '$' + sfmt(sma50) : 'N/A'}
EMA(9):  ${ema9  != null ? '$' + sfmt(ema9)  : 'N/A'}
EMA(21): ${ema21 != null ? '$' + sfmt(ema21) : 'N/A'}
EMA(200): ${ema200 != null ? '$' + sfmt(ema200) : 'N/A (necesita más datos)'}
Tendencia SMA: ${trendSMA}
Tendencia EMA: ${trendEMA}
Tendencia macro (EMA200): ${trendMacro}

INSTRUCCIÓN FINAL OBLIGATORIA:
Responde ÚNICAMENTE con el objeto JSON. CERO texto antes o después.
No expliques nada. Solo el JSON entre { y }.`;
  }

  /* ═══════════════════════════════════════════════════════════════
     AI RESPONSE PARSER  (port of parse_ai_response + _repair_json)
  ═══════════════════════════════════════════════════════════════ */

  function parseAIResponse(text) {
    if (!text) return null;

    // Remove <think> blocks (Qwen3 / DeepSeek R1 style)
    let s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Remove code fences
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    // Extract first JSON object
    const m = s.match(/\{[\s\S]*\}/);
    if (m) s = m[0];
    // Fix common LLM JSON issues
    s = s.replace(/,\s*([}\]])/g, '$1');   // trailing commas
    s = s.replace(/;\s*("|\}|\])/g, ',$1'); // semicolons as separators

    let parsed;
    for (let pass = 0; pass < 2; pass++) {
      try { parsed = JSON.parse(s); break; }
      catch (_) {
        if (pass === 0) {
          const opens  = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
          const closes = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
          s = s.trim().replace(/,\s*$/, '');
          s += ']'.repeat(Math.max(0, closes)) + '}'.repeat(Math.max(0, opens));
        } else {
          addLog('warn', `No se pudo parsear respuesta AI: ${text.slice(0, 150)}`);
          return null;
        }
      }
    }
    if (!parsed) return null;

    // Action resolution (allow alternative key names)
    let rawAction = parsed.action || parsed.decision || parsed.trade_action
      || parsed.recommendation || parsed.signal || '';
    let action = String(rawAction).toUpperCase().trim();
    if (!['BUY','SELL','HOLD'].includes(action)) {
      for (const v of Object.values(parsed)) {
        const c = String(v).toUpperCase().trim();
        if (['BUY','SELL','HOLD'].includes(c)) { action = c; break; }
      }
    }
    if (!['BUY','SELL','HOLD'].includes(action)) {
      addLog('warn', `AI devolvió acción inválida: "${rawAction}"`);
      return null;
    }

    parsed.action     = action;
    parsed.confidence = Math.max(0, Math.min(100, parseFloat(parsed.confidence || 50) || 50));
    parsed.score      = Math.max(-100, Math.min(100, parseFloat(parsed.score || 0) || 0));
    parsed.amount_pct = Math.max(0, Math.min(100, parseFloat(parsed.amount_pct || 50) || 50));
    return parsed;
  }

  /* ═══════════════════════════════════════════════════════════════
     AUTONOMOUS SYMBOL SELECTOR
  ═══════════════════════════════════════════════════════════════ */

  async function selectBestSymbols() {
    try {
      const resp = await fetch(`${serverUrl()}/api/tickers`, { signal: AbortSignal.timeout(15000) });
      const data = await resp.json();
      const tickers = data.data?.tickers || data.tickers || [];

      const candidates = tickers
        .filter(t =>
          t.symbol?.endsWith('_USDT') &&
          parseFloat(t.amount || 0) > 500_000 &&
          parseFloat(t.close || 999999) < MAX_COIN_PRICE_USDT)
        .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
        .slice(0, 12);

      if (!candidates.length) return ['BTC_USDT', 'ETH_USDT'];
      addLog('info', `🤖 Autónomo: evaluando ${candidates.length} monedas…`);

      const scored = [];
      for (const t of candidates) {
        const md = await getMarketData(t.symbol);
        if (!md?.price) continue;
        let score = 0;

        const rsi = md.rsi;
        if (rsi != null) {
          if      (rsi < 30) score += 30;
          else if (rsi < 40) score += 20;
          else if (rsi < 50) score += 10;
          else if (rsi >= 60) score -= 20;
        }
        if (md.sma20 && md.sma50) score += md.sma20 > md.sma50 ? 20 : -10;
        const hist = md.macd?.histogram;
        if (hist != null) score += hist > 0 ? 15 : -10;
        const bbD = md.bollinger;
        if (bbD && md.price.close) {
          const rng = bbD.upper - bbD.lower;
          const pos = rng > 0 ? (md.price.close - bbD.lower) / rng : 0.5;
          if      (pos < 0.25) score += 25;
          else if (pos < 0.40) score += 10;
          else if (pos > 0.80) score -= 20;
          const bw = bbD.middle > 0 ? (rng / bbD.middle) * 100 : 5;
          if (bw < 0.8) score -= 15;
          if (bw > 7)   score -= 20;
        }
        const close = parseFloat(t.close || 0), open = parseFloat(t.open || 0);
        if (open > 0) {
          const ch = (close - open) / open * 100;
          if (ch >  8) score -= 20;
          if (ch < -8) score -= 10;
        }
        scored.push({ symbol: t.symbol, score });
      }

      scored.sort((a, b) => b.score - a.score);
      let top = scored.slice(0, 3).map(s => s.symbol);

      // Always keep symbols with open positions
      const mustKeep = Object.keys(openPositions).filter(s => !top.includes(s));
      if (mustKeep.length) top = [...mustKeep, ...top];

      const scoreMap = Object.fromEntries(scored.map(s => [s.symbol, s.score]));
      const summary = top.map(s =>
        `${s.replace('_USDT','')}(${s in openPositions ? '📌' : (scoreMap[s] ?? '?')})`
      ).join(', ');
      addLog('info', `🤖 Monedas seleccionadas: ${summary}`);
      return top.length ? top : ['BTC_USDT', 'ETH_USDT'];
    } catch (e) {
      addLog('warn', `🤖 Error selección autónoma: ${e.message}. Usando BTC/ETH.`);
      return ['BTC_USDT', 'ETH_USDT'];
    }
  }

  /* ── USDT Balance ───────────────────────────────────────────── */
  async function getUSDTBalance() {
    if (config.dryRun) return virtualUsdt;
    try {
      const resp = await fetch(`${serverUrl()}/api/balances`, { signal: AbortSignal.timeout(8000) });
      const data = await resp.json();
      const bals = data.data?.balances || data.balances || [];
      const usdt = bals.find(b => b.coin === 'USDT' || b.asset === 'USDT');
      return usdt ? parseFloat(usdt.free || usdt.available || 0) : 0;
    } catch (_) { return 0; }
  }

  /* ═══════════════════════════════════════════════════════════════
     TRADE EXECUTION  (port of execute_trade())
  ═══════════════════════════════════════════════════════════════ */

  async function executeTrade(symbol, decision, marketData) {
    const { action, confidence, score, amount_pct, reason } = decision;

    if (action === 'HOLD') {
      sessionStats.holds++;
      addLog('hold', `[${symbol}] HOLD — Score: ${score}, Confianza: ${confidence}% — ${reason}`);
      renderStats(); return;
    }

    if (action === 'BUY' && symbol in openPositions) {
      addLog('warn', `[${symbol}] ⚠️ Posición abierta. BUY bloqueado.`);
      sessionStats.holds++; renderStats(); return;
    }

    if (action === 'SELL' && !(symbol in openPositions) && !config.dryRun) {
      addLog('warn', `[${symbol}] Sin posición para vender (modo real). Omitiendo.`);
      sessionStats.holds++; renderStats(); return;
    }

    const curPrice = marketData?.price?.close || 0;

    if (action === 'BUY' && curPrice >= MAX_COIN_PRICE_USDT) {
      addLog('warn', `[${symbol}] 💲 BUY bloqueado: $${curPrice} ≥ máximo $${MAX_COIN_PRICE_USDT}`);
      sessionStats.holds++; renderStats(); return;
    }

    const minProfit = config.minProfitUsdt || MIN_PROFIT_USDT;
    if (action === 'SELL' && symbol in openPositions) {
      const pos = openPositions[symbol];
      const estPnl = pos.amountUSD * (curPrice - pos.entryPrice) / pos.entryPrice;
      const rl = (reason || '').toLowerCase();
      const isForcedSL = score <= -70 || rl.includes('stop') || rl.includes(' sl') || rl.startsWith('sl') || rl.includes('loss');
      if (estPnl < minProfit && !isForcedSL) {
        addLog('warn', `[${symbol}] 🔒 SELL bloqueado: PnL estimado $${estPnl.toFixed(3)} < mínimo $${minProfit.toFixed(2)}`);
        sessionStats.holds++; renderStats(); return;
      }
    }

    if (dailyTradeCount >= config.maxTradesPerDay) {
      addLog('warn', `[${symbol}] Límite diario (${config.maxTradesPerDay}) alcanzado. HOLD.`);
      sessionStats.holds++; renderStats(); return;
    }

    // Calculate trade size
    let sizePct = amount_pct;
    if (config.riskLevel === 'conservative') sizePct = Math.min(sizePct, 50);
    else if (config.riskLevel === 'moderate') sizePct = Math.min(sizePct, 75);

    let amountUSD = config.tradeAmountUSD
      ? parseFloat(config.tradeAmountUSD)
      : Math.round(config.maxPositionUSD * sizePct / 100 * 100) / 100;

    if (config.dryRun) {
      await _executeDryRun(symbol, action, amountUSD, curPrice, confidence, score, reason, marketData);
    } else {
      await _executeReal(symbol, action, amountUSD, curPrice, confidence, score, reason, marketData);
    }

    renderStats();
    renderPositions();
    renderTradeHistory();
  }

  async function _executeDryRun(symbol, action, amtUSD, price, confidence, score, reason, md) {
    if (action === 'BUY') {
      if (virtualUsdt < amtUSD) {
        amtUSD = Math.floor(virtualUsdt * 0.98 * 100) / 100;
        if (amtUSD < 5) { addLog('warn', `[${symbol}] Saldo virtual insuficiente ($${virtualUsdt.toFixed(2)})`); return; }
      }
      sessionStats.buys++;
      const simSize = price > 0 ? amtUSD / price : 0;
      openPositions[symbol] = {
        entryPrice: price, amountUSD: amtUSD, size: simSize,
        entryTime: new Date().toISOString().slice(0,19),
        highWatermark: price, trailingStop: null, atr: md?.atr || null,
      };
      virtualUsdt = Math.max(0, virtualUsdt - amtUSD);
      addLog('buy', `[SIM] BUY ${symbol} — $${amtUSD} @ $${price} — Conf: ${confidence}% — ${reason}`);
      addLog('info', `[dryRun] 💰 Saldo virtual: $${virtualUsdt.toFixed(2)}`);
    } else {
      // SELL
      sessionStats.sells++;
      const trade = {
        time: new Date().toISOString().slice(0,19), symbol, side: 'SELL',
        amount: amtUSD, confidence, score, reason, price, simulated: true,
      };
      if (symbol in openPositions) {
        const pos = openPositions[symbol];
        const pnl = pos.amountUSD * (price - pos.entryPrice) / pos.entryPrice;
        trade.pnl = Math.round(pnl * 10000) / 10000;
        _updatePnLStats(pnl);
        virtualUsdt += pos.amountUSD + pnl;
        const sign = pnl >= 0 ? '+' : '';
        addLog(pnl >= 0 ? 'info' : 'warn', `[${symbol}] PnL SIMULADO: ${sign}$${pnl.toFixed(2)}`);
        addLog('sell', `[SIM] SELL ${symbol} @ $${price} PnL: ${sign}$${pnl.toFixed(2)} — ${reason}`);
        addLog('info', `[dryRun] 💰 Saldo virtual actualizado: $${virtualUsdt.toFixed(2)}`);
        delete openPositions[symbol];
      }
      tradeHistory.push(trade);
    }

    if (action === 'BUY') {
      tradeHistory.push({
        time: new Date().toISOString().slice(0,19), symbol, side: 'BUY',
        amount: amtUSD, confidence, score, reason, price, simulated: true,
      });
    }

    dailyTradeCount++;
    saveState();
  }

  async function _executeReal(symbol, action, amtUSD, price, confidence, score, reason, md) {
    try {
      if (action === 'BUY') {
        const usdtFree = await getUSDTBalance();
        if (usdtFree < amtUSD) {
          amtUSD = Math.round(usdtFree * 0.98 * 100) / 100;
          if (amtUSD < 5) {
            addLog('error', `[${symbol}] Saldo insuficiente: $${usdtFree.toFixed(2)}.`);
            sessionStats.errors++; return;
          }
          addLog('warn', `[${symbol}] Ajustando monto a $${amtUSD} disponible.`);
        }
      }

      let orderBody;
      if (action === 'BUY') {
        orderBody = { symbol, side: 'BUY', type: 'MARKET', amount: String(amtUSD) };
      } else {
        const pos  = openPositions[symbol];
        const size = pos ? String(Math.round((pos.size || 0) * 1e8) / 1e8) : '0';
        orderBody = { symbol, side: 'SELL', type: 'MARKET', size };
      }

      const resp = await fetch(`${serverUrl()}/api/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderBody),
        signal: AbortSignal.timeout(30000),
      });
      const result = await resp.json();

      if (result.result) {
        const orderId = result.data?.orderId || 'unknown';
        const trade = {
          time: new Date().toISOString().slice(0,19), symbol, side: action,
          amount: amtUSD, price, confidence, score, reason, simulated: false, orderId,
        };

        if (action === 'BUY') {
          sessionStats.buys++;
          openPositions[symbol] = {
            entryPrice: price, amountUSD: amtUSD,
            size: price > 0 ? amtUSD / price : 0,
            entryTime: trade.time, highWatermark: price, trailingStop: null, atr: md?.atr || null,
          };
          addLog('buy', `[REAL ✅] BUY ${symbol} — $${amtUSD} @ $${price} — OID:${orderId} — ${reason}`);
        } else {
          sessionStats.sells++;
          if (symbol in openPositions) {
            const pos = openPositions[symbol];
            const pnl = pos.amountUSD * (price - pos.entryPrice) / pos.entryPrice;
            trade.pnl = Math.round(pnl * 10000) / 10000;
            _updatePnLStats(pnl);
            const sign = pnl >= 0 ? '+' : '';
            addLog('sell', `[REAL ✅] SELL ${symbol} @ $${price} PnL:${sign}$${pnl.toFixed(2)} OID:${orderId} — ${reason}`);
            delete openPositions[symbol];
          }
        }
        dailyTradeCount++;
        tradeHistory.push(trade);
        saveState();
      } else {
        addLog('error', `[${symbol}] Orden rechazada: ${result.message || JSON.stringify(result)}`);
        sessionStats.errors++;
      }
    } catch (e) {
      addLog('error', `[${symbol}] Error ejecutando orden: ${e.message}`);
      sessionStats.errors++;
    }
  }

  function _updatePnLStats(pnl) {
    sessionStats.totalPnL += pnl;
    if (pnl > 0) {
      sessionStats.winTrades++;
      if (pnl > sessionStats.bestTrade) sessionStats.bestTrade = pnl;
    } else {
      sessionStats.lossTrades++;
      if (pnl < sessionStats.worstTrade) sessionStats.worstTrade = pnl;
    }
    if (sessionStats.totalPnL > sessionStats.peakPnL) sessionStats.peakPnL = sessionStats.totalPnL;
    const dd = sessionStats.peakPnL - sessionStats.totalPnL;
    if (dd > sessionStats.maxDrawdown) sessionStats.maxDrawdown = dd;
  }

  /* ═══════════════════════════════════════════════════════════════
     POSITION MONITOR  (SL / TP / Trailing Stop)
  ═══════════════════════════════════════════════════════════════ */

  function startPositionMonitor() {
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = setInterval(checkPositions, 15_000);
  }

  async function checkPositions() {
    if (!running) return;
    const priceMap = {};

    for (const [symbol, pos] of Object.entries({ ...openPositions })) {
      try {
        const resp = await fetch(`${serverUrl()}/api/tickers?symbol=${symbol}`,
          { signal: AbortSignal.timeout(5000) });
        const data = await resp.json();
        const tickers = data.data?.tickers || data.tickers || [];
        if (!tickers.length) continue;
        const curPrice = parseFloat(tickers[0].close || 0);
        if (!curPrice) continue;
        priceMap[symbol] = curPrice;

        const entry = pos.entryPrice || 0;
        if (!entry) continue;
        const pnlPct = (curPrice - entry) / entry * 100;

        if (pnlPct <= -config.stopLossPct) {
          addLog('warn', `[${symbol}] 🔴 STOP-LOSS! PnL: ${pnlPct.toFixed(2)}%. SELL.`);
          await executeTrade(symbol,
            { action:'SELL', confidence:100, score:-90, amount_pct:100, reason:`SL: ${pnlPct.toFixed(2)}%` },
            { price: { close: curPrice } }); continue;
        }

        if (pnlPct >= config.takeProfitPct) {
          addLog('info', `[${symbol}] 🟢 TAKE-PROFIT! PnL: ${pnlPct.toFixed(2)}%. SELL.`);
          await executeTrade(symbol,
            { action:'SELL', confidence:100, score:85, amount_pct:100, reason:`TP: ${pnlPct.toFixed(2)}%` },
            { price: { close: curPrice } }); continue;
        }

        // Trailing stop
        const tpTrigger = config.takeProfitPct * 0.5;
        if (pnlPct > tpTrigger) {
          const hwm = pos.highWatermark || entry;
          if (curPrice > hwm) {
            pos.highWatermark = curPrice;
            const trailFrac = pos.atr
              ? Math.max(0.005, Math.min(pos.atr * 1.5 / entry, 0.08))
              : TRAILING_PCT;
            const newTrail = curPrice * (1 - trailFrac);
            if (!pos.trailingStop || newTrail > pos.trailingStop) pos.trailingStop = newTrail;
          }
          if (pos.trailingStop && curPrice < pos.trailingStop) {
            addLog('info', `[${symbol}] 🔒 Trailing stop @ $${curPrice.toFixed(4)}. SELL.`);
            await executeTrade(symbol,
              { action:'SELL', confidence:95, score:40, amount_pct:100, reason:`Trailing: $${pos.trailingStop.toFixed(4)}` },
              { price: { close: curPrice } });
          }
        }
      } catch (_) {}
    }
    if (Object.keys(priceMap).length) renderPositionsWithPrices(priceMap);
  }

  /* ═══════════════════════════════════════════════════════════════
     MAIN TRADING CYCLE  (port of run_cycle())
  ═══════════════════════════════════════════════════════════════ */

  async function runCycle() {
    // Daily reset
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastDayReset) {
      dailyTradeCount = 0;
      lastDayReset    = today;
      circuitBreaker  = false;
      sessionStats.totalPnL = 0;
      addLog('info', 'Nuevo día: contadores reiniciados.');
    }

    if (circuitBreaker) {
      addLog('warn', '🔴 CIRCUIT BREAKER — Trading suspendido hasta mañana.');
      scheduleNextCycle(); return;
    }

    // Circuit breaker check
    const tradeCap     = parseFloat(config.tradeAmountUSD || config.maxPositionUSD || 100);
    const maxDailyLoss = Math.max(tradeCap * config.maxDailyLossPct / 100 * Math.min(config.maxTradesPerDay, 5), 5);
    if (sessionStats.totalPnL < -maxDailyLoss) {
      circuitBreaker = true;
      const msg = `🔴 CIRCUIT BREAKER: pérdida $${Math.abs(sessionStats.totalPnL).toFixed(2)} superó límite $${maxDailyLoss.toFixed(2)}. Trading DETENIDO hasta mañana.`;
      addLog('error', msg);
      saveState(); scheduleNextCycle(); return;
    }

    sessionStats.cycles++;
    addLog('info', `═══ Ciclo #${sessionStats.cycles} — ${new Date().toLocaleTimeString()} — ${config.tradeMode.toUpperCase()} ═══`);
    renderStats();

    // Symbol selection
    let symbols = [...config.symbols];
    if (config.tradeMode === 'autonomous') {
      try { symbols = await selectBestSymbols(); } catch (_) { symbols = ['BTC_USDT', 'ETH_USDT']; }
    }

    // USDT balance check
    const usdtAvail = await getUSDTBalance();
    const sellOnly  = usdtAvail < MIN_BUY_USDT;
    if (sellOnly && Object.keys(openPositions).length === 0) {
      addLog('warn', `💰 USDT: $${usdtAvail.toFixed(2)} < $${MIN_BUY_USDT} y sin posiciones. Esperando fondos.`);
      scheduleNextCycle(); return;
    }
    if (sellOnly) addLog('warn', `💰 USDT: $${usdtAvail.toFixed(2)} < $${MIN_BUY_USDT} — Modo SELL-ONLY.`);
    else addLog('info', `💰 USDT disponible: $${usdtAvail.toFixed(2)} — compras habilitadas.`);

    // Build iteration order: open positions FIRST (priority), then new candidates
    const openExtra  = Object.keys(openPositions).filter(s => !symbols.includes(s));
    const openInCfg  = symbols.filter(s => s in openPositions);
    const newCands   = symbols.filter(s => !(s in openPositions));
    const symbolsIter = sellOnly
      ? Object.keys(openPositions)
      : [...openInCfg, ...openExtra, ...newCands];

    for (const symbol of symbolsIter) {
      if (!running) break;

      try {
        if (sellOnly && !(symbol in openPositions)) {
          addLog('info', `[${symbol}] Sell-only: sin posición, saltando.`); continue;
        }

        addLog('info', `Analizando ${symbol}…`);
        const data = await getMarketData(symbol);
        if (!data?.price) { addLog('warn', `[${symbol}] Sin datos de mercado.`); continue; }

        // Quick indicator log
        const inds = [];
        if (data.rsi != null)           inds.push(`RSI=${data.rsi.toFixed(1)}`);
        if (data.macd?.histogram != null) inds.push(`MACD_H=${data.macd.histogram.toFixed(4)}`);
        if (data.bollinger)             inds.push(`BB_pos=${data.price.close < data.bollinger.lower ? '⬇BAJO' : data.price.close > data.bollinger.upper ? '⬆ALTO' : 'mid'}`);
        addLog('info', `[${symbol}] $${data.price.close} | ${inds.join(' | ') || '⚠️ Sin indicadores'}`);

        // Inline SL/TP check (saves an AI call)
        if (symbol in openPositions) {
          const pos = openPositions[symbol];
          const pnlPct = (data.price.close - pos.entryPrice) / pos.entryPrice * 100;
          if (pnlPct <= -config.stopLossPct) {
            addLog('warn', `[${symbol}] 🔴 STOP-LOSS! PnL: ${pnlPct.toFixed(2)}%.`);
            await executeTrade(symbol,
              { action:'SELL', confidence:100, score:-80, amount_pct:100, reason:`Stop-loss: ${pnlPct.toFixed(2)}%` }, data);
            continue;
          }
          if (pnlPct >= config.takeProfitPct) {
            addLog('info', `[${symbol}] 🟢 TAKE-PROFIT! PnL: ${pnlPct.toFixed(2)}%.`);
            await executeTrade(symbol,
              { action:'SELL', confidence:100, score:80, amount_pct:100, reason:`Take-profit: ${pnlPct.toFixed(2)}%` }, data);
            continue;
          }
        }

        // Get supplementary context in parallel
        addLog('info', `Consultando Cloud AI para ${symbol}…`);
        const [mtfData, fgData] = await Promise.all([getMTFContext(symbol), getFearGreed()]);

        // Build and send prompt to cloud AI
        const hasOpenPos = symbol in openPositions;
        const systemPrompt = buildSystemPrompt(hasOpenPos);
        const userPrompt   = buildUserPrompt(data, mtfData, fgData);

        let aiText;
        try {
          aiText = await CloudAI.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ]);
        } catch (e) {
          addLog('error', `[${symbol}] Error AI: ${e.message}`);
          sessionStats.errors++; renderStats(); continue;
        }

        if (!aiText) { addLog('error', `[${symbol}] AI no respondió.`); sessionStats.errors++; renderStats(); continue; }

        // Parse decision; retry once if invalid
        let decision = parseAIResponse(aiText);
        if (!decision) {
          addLog('warn', `[${symbol}] Respuesta AI no parseable, reintentando…`);
          try {
            const retry = await CloudAI.chat([
              { role: 'system', content: 'Devuelve SOLO el objeto JSON válido, sin texto adicional.' },
              { role: 'user',   content: `Tu respuesta no era JSON válido:\n${aiText.slice(0,300)}\n\nDevuelve SOLO el JSON:\n{"action":"BUY"|"SELL"|"HOLD","confidence":0-100,"score":-100..100,"amount_pct":0-100,"reason":"...","signals":{},"risk_notes":""}` },
            ]);
            decision = parseAIResponse(retry);
          } catch (_) {}
        }
        if (!decision) { addLog('error', `[${symbol}] Respuesta AI inválida.`); sessionStats.errors++; renderStats(); continue; }

        addLog('analysis', `[${symbol}] Score:${decision.score} | ${decision.action} | Conf:${decision.confidence}% | ${decision.reason || ''}`);

        // Safety: block BUY if position open
        if (symbol in openPositions && decision.action === 'BUY') {
          addLog('warn', `[${symbol}] LLM devolvió BUY con posición abierta → HOLD`);
          decision.action = 'HOLD';
        }

        // Auto-convert HOLD to SELL if conditions met (port of bearish-signal override)
        if (symbol in openPositions && decision.action === 'HOLD') {
          const pos = openPositions[symbol];
          const pnlPct2 = (data.price.close - pos.entryPrice) / pos.entryPrice * 100;
          const pnlUsdt = pos.amountUSD * pnlPct2 / 100;
          const minP    = config.minProfitUsdt || MIN_PROFIT_USDT;
          const rsiV    = data.rsi;
          const macdH   = data.macd?.histogram || 0;
          if (sellOnly && pnlUsdt >= minP) {
            decision.action = 'SELL';
            decision.reason = `Sell-only: PnL=$${pnlUsdt.toFixed(2)}`;
            decision.confidence = 90;
          } else if (pnlUsdt >= minP && rsiV && rsiV > 60 && macdH < 0) {
            decision.action = 'SELL';
            decision.reason = `Salida protegida: PnL=$${pnlUsdt.toFixed(2)} señales bajistas`;
            decision.confidence = 75;
          }
        }

        await executeTrade(symbol, decision, data);

      } catch (e) {
        addLog('error', `Error en ciclo [${symbol}]: ${e.message}`);
        sessionStats.errors++; renderStats();
      }
    }

    addLog('info', `═══ Ciclo #${sessionStats.cycles} fin — ${sessionStats.buys}B/${sessionStats.sells}S/${sessionStats.holds}H/${sessionStats.errors}E ═══`);
    addLog('info', `Próximo ciclo en ${config.cycleMinutes} minutos.`);
    scheduleNextCycle();
  }

  function scheduleNextCycle() {
    if (!running) return;
    cycleTimeout = setTimeout(() => {
      runCycle().catch(e => addLog('error', `Error fatal en ciclo: ${e.message}`));
    }, config.cycleMinutes * 60_000);
  }

  /* ═══════════════════════════════════════════════════════════════
     UI RENDERING
  ═══════════════════════════════════════════════════════════════ */

  function renderStats() {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('statCycles',  sessionStats.cycles);
    set('statBuys',    sessionStats.buys);
    set('statSells',   sessionStats.sells);
    set('statHolds',   sessionStats.holds);
    set('statErrors',  sessionStats.errors);

    const pnl = sessionStats.totalPnL;
    const pnlEl = document.getElementById('statPnL');
    if (pnlEl) {
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
      pnlEl.className   = pnl >= 0 ? 'stat-val green' : 'stat-val red';
    }

    const total = sessionStats.winTrades + sessionStats.lossTrades;
    const wr = total > 0 ? (sessionStats.winTrades / total * 100).toFixed(0) + '%' : '—';
    set('statWinRate', wr);

    const vEl = document.getElementById('statVirtualUsdt');
    if (vEl) vEl.textContent = config.dryRun ? `$${virtualUsdt.toFixed(2)}` : '—';

    // Update bot status badge
    const badge = document.getElementById('botStatusBadge');
    if (badge) {
      badge.textContent = running ? 'Activo' : 'Detenido';
      badge.className = running ? 'badge running' : 'badge';
    }
    // Buttons
    const startBtn = document.getElementById('startBotBtn');
    const stopBtn  = document.getElementById('stopBotBtn');
    if (startBtn) startBtn.disabled = running;
    if (stopBtn)  stopBtn.disabled  = !running;
  }

  function renderPositions() {
    const el = document.getElementById('botPositionsPanel');
    if (!el) return;
    const entries = Object.entries(openPositions);
    if (!entries.length) {
      el.innerHTML = '<div class="empty-state"><ion-icon name="albums-outline"></ion-icon><span>Sin posiciones abiertas</span></div>';
      return;
    }
    el.innerHTML = entries.map(([sym, pos]) => `
      <div class="bot-position-item">
        <div class="bp-header">
          <span class="bp-sym">${sym.replace('_USDT','')}</span>
          <span class="bp-time">${pos.entryTime?.slice(11,16) || ''}</span>
        </div>
        <div class="bp-row">
          <span class="bp-label">Entrada</span><span class="bp-val">$${parseFloat(pos.entryPrice||0).toFixed(4)}</span>
          <span class="bp-label">Inv.</span><span class="bp-val">$${parseFloat(pos.amountUSD||0).toFixed(2)}</span>
        </div>
        <div class="bp-row">
          <span class="bp-label">SL</span><span class="bp-val red">-${config.stopLossPct}%</span>
          <span class="bp-label">TP</span><span class="bp-val green">+${config.takeProfitPct}%</span>
          ${pos.trailingStop ? `<span class="bp-label">Trail</span><span class="bp-val">$${pos.trailingStop.toFixed(4)}</span>` : ''}
        </div>
      </div>`).join('');
  }

  function renderPositionsWithPrices(prices = {}) {
    const el = document.getElementById('botPositionsPanel');
    if (!el) return;
    const entries = Object.entries(openPositions);
    if (!entries.length) {
      el.innerHTML = '<div class="empty-state"><ion-icon name="albums-outline"></ion-icon><span>Sin posiciones abiertas</span></div>';
      return;
    }
    el.innerHTML = entries.map(([sym, pos]) => {
      const curPrice = prices[sym] || pos.entryPrice;
      const pnlPct   = pos.entryPrice > 0 ? (curPrice - pos.entryPrice) / pos.entryPrice * 100 : 0;
      const pnlUsdt  = pos.amountUSD * pnlPct / 100;
      const sign     = pnlPct >= 0 ? '+' : '';
      const cls      = pnlPct >= 0 ? 'green' : 'red';
      return `
      <div class="bot-position-item">
        <div class="bp-header">
          <span class="bp-sym">${sym.replace('_USDT','')}</span>
          <span class="bp-pnl ${cls}">${sign}${pnlPct.toFixed(2)}% (${sign}$${pnlUsdt.toFixed(2)})</span>
        </div>
        <div class="bp-row">
          <span class="bp-label">Entrada</span><span class="bp-val">$${parseFloat(pos.entryPrice||0).toFixed(4)}</span>
          <span class="bp-label">Actual</span><span class="bp-val">$${curPrice.toFixed(4)}</span>
          <span class="bp-label">Inv.</span><span class="bp-val">$${parseFloat(pos.amountUSD||0).toFixed(2)}</span>
        </div>
        <div class="bp-row">
          <span class="bp-label">SL</span><span class="bp-val red">-${config.stopLossPct}%</span>
          <span class="bp-label">TP</span><span class="bp-val green">+${config.takeProfitPct}%</span>
          ${pos.trailingStop ? `<span class="bp-label">Trail</span><span class="bp-val">$${pos.trailingStop.toFixed(4)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function renderTradeHistory() {
    const el = document.getElementById('botTradeHistory');
    if (!el) return;
    const recent = tradeHistory.slice(-10).reverse();
    if (!recent.length) {
      el.innerHTML = '<div class="empty-state">Sin historial de trades</div>'; return;
    }
    el.innerHTML = recent.map(t => {
      const pnl    = t.pnl != null ? parseFloat(t.pnl) : null;
      const sign   = pnl != null && pnl >= 0 ? '+' : '';
      const pnlStr = pnl != null ? ` ${sign}$${Math.abs(pnl).toFixed(2)}` : '';
      const pnlCls = pnl != null ? (pnl >= 0 ? 'green' : 'red') : '';
      return `
      <div class="trade-item ${t.side === 'BUY' ? 'buy' : 'sell'}">
        <span class="ti-side">${t.side}</span>
        <span class="ti-sym">${(t.symbol||'').replace('_USDT','')}</span>
        <span class="ti-price">$${parseFloat(t.price||0).toFixed(4)}</span>
        <span class="ti-pnl ${pnlCls}">${pnlStr}</span>
        <span class="ti-tag">${t.simulated ? '🔵' : '🟠'}</span>
        <span class="ti-time">${(t.time||'').slice(11,16)}</span>
      </div>`;
    }).join('');
  }

  /* ═══════════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════════ */

  function start(userConfig = {}) {
    if (running) return { ok: false, error: 'Ya está corriendo' };

    const aiCfg = typeof CloudAI !== 'undefined' ? CloudAI.getConfig() : null;
    if (!aiCfg?.provider)
      return { ok: false, error: 'Configura un proveedor de Cloud AI primero (página de ajustes AI)' };

    Object.assign(config, userConfig);
    running = true;

    // Reset session stats (keep positions from previous session)
    Object.assign(sessionStats, {
      cycles:0, buys:0, sells:0, holds:0, errors:0,
      totalPnL:0, winTrades:0, lossTrades:0,
      peakPnL:0, maxDrawdown:0, bestTrade:0, worstTrade:0,
    });

    loadState();
    startPositionMonitor();

    addLog('info', [
      `🚀 AI Bot Cloud INICIADO`,
      `Modo: ${config.tradeMode.toUpperCase()}`,
      `Intervalo: ${config.interval}`,
      `Ciclo: ${config.cycleMinutes}min`,
      `DryRun: ${config.dryRun}`,
      `AI: ${aiCfg.provider}`,
    ].join(' | '));

    renderStats();

    // Start first cycle
    runCycle().catch(e => addLog('error', `Error inicial: ${e.message}`));
    return { ok: true };
  }

  function stop() {
    running = false;
    if (cycleTimeout)    { clearTimeout(cycleTimeout);   cycleTimeout    = null; }
    if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
    saveState();
    addLog('info', '🛑 AI Bot Cloud DETENIDO.');
    renderStats();
  }

  function getStatus() {
    return {
      running, config, sessionStats,
      openPositions: { ...openPositions },
      tradeHistory:  tradeHistory.slice(-20),
      dailyTradeCount, circuitBreaker,
      virtualUsdt: config.dryRun ? virtualUsdt : null,
    };
  }

  function updateConfig(newCfg) {
    Object.assign(config, newCfg);
  }

  return {
    start, stop, getStatus, updateConfig,
    renderStats, renderPositions, renderPositionsWithPrices, renderTradeHistory,
  };
})();
