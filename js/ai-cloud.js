/* ═══════════════════════════════════════════════════════════════
   Pionex Bot — Cloud AI Module
   Supports: Claude (Anthropic), OpenAI, Gemini, Groq,
             OpenRouter, Mistral
   All calls are made client-side using the stored API key.
   ═══════════════════════════════════════════════════════════════ */

const CloudAI = (() => {

  /* ── Provider definitions ──────────────────────────────────── */
  const PROVIDERS = {
    claude: {
      name: 'Claude',
      models: [
        { id: 'claude-sonnet-4-5',          label: 'Claude Sonnet 4.5'   },
        { id: 'claude-opus-4-5',             label: 'Claude Opus 4.5'     },
        { id: 'claude-3-5-sonnet-20241022',  label: 'Claude 3.5 Sonnet'  },
        { id: 'claude-3-5-haiku-20241022',   label: 'Claude 3.5 Haiku'   },
        { id: 'claude-3-opus-20240229',      label: 'Claude 3 Opus'       },
      ],
      async call(config, messages) {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model:      config.model,
            max_tokens: 2048,
            system:     messages.find(m => m.role === 'system')?.content || '',
            messages:   messages.filter(m => m.role !== 'system'),
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error?.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        return data.content?.[0]?.text || '';
      },
    },

    openai: {
      name: 'OpenAI',
      models: [
        { id: 'gpt-4o',            label: 'GPT-4o'            },
        { id: 'gpt-4o-mini',       label: 'GPT-4o Mini'       },
        { id: 'gpt-4-turbo',       label: 'GPT-4 Turbo'       },
        { id: 'gpt-3.5-turbo',     label: 'GPT-3.5 Turbo'     },
        { id: 'o1-mini',           label: 'o1-mini'             },
      ],
      async call(config, messages) {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model:    config.model,
            messages: messages,
            max_tokens: 2048,
            temperature: 0.4,
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error?.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
      },
    },

    gemini: {
      name: 'Gemini',
      models: [
        { id: 'gemini-2.0-flash',        label: 'Gemini 2.0 Flash'     },
        { id: 'gemini-1.5-pro',          label: 'Gemini 1.5 Pro'       },
        { id: 'gemini-1.5-flash',        label: 'Gemini 1.5 Flash'     },
        { id: 'gemini-1.5-flash-8b',     label: 'Gemini 1.5 Flash-8B'  },
      ],
      async call(config, messages) {
        const sys = messages.find(m => m.role === 'system');
        const history = messages.filter(m => m.role !== 'system').map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        const body = {
          contents: history,
          generationConfig: { maxOutputTokens: 2048, temperature: 0.4 },
        };
        if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error?.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      },
    },

    groq: {
      name: 'Groq',
      models: [
        { id: 'llama-3.3-70b-versatile',     label: 'Llama 3.3 70B'       },
        { id: 'llama-3.1-8b-instant',        label: 'Llama 3.1 8B Instant'},
        { id: 'mixtral-8x7b-32768',          label: 'Mixtral 8x7B'        },
        { id: 'gemma2-9b-it',                label: 'Gemma 2 9B'           },
        { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Llama 70B' },
      ],
      async call(config, messages) {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model:      config.model,
            messages:   messages,
            max_tokens: 2048,
            temperature: 0.4,
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error?.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
      },
    },

    openrouter: {
      name: 'OpenRouter',
      models: [
        { id: 'anthropic/claude-sonnet-4-5',          label: 'Claude Sonnet 4.5'       },
        { id: 'openai/gpt-4o',                        label: 'GPT-4o'                  },
        { id: 'google/gemini-2.0-flash-001',          label: 'Gemini 2.0 Flash'        },
        { id: 'meta-llama/llama-3.3-70b-instruct',    label: 'Llama 3.3 70B'           },
        { id: 'deepseek/deepseek-r1',                 label: 'DeepSeek R1'             },
        { id: 'mistralai/mistral-large',              label: 'Mistral Large'           },
        { id: 'qwen/qwen-2.5-72b-instruct',           label: 'Qwen 2.5 72B'            },
      ],
      async call(config, messages) {
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization':  `Bearer ${config.apiKey}`,
            'Content-Type':   'application/json',
            'HTTP-Referer':   window.location.origin && window.location.origin !== 'null'
                              ? window.location.origin
                              : 'https://trader-app',
            'X-Title':        'Pionex Bot',
          },
          body: JSON.stringify({
            model:      config.model,
            messages:   messages,
            max_tokens: 2048,
            temperature: 0.4,
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error?.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
      },
    },

    mistral: {
      name: 'Mistral',
      models: [
        { id: 'mistral-large-latest',   label: 'Mistral Large'   },
        { id: 'mistral-medium-latest',  label: 'Mistral Medium'  },
        { id: 'mistral-small-latest',   label: 'Mistral Small'   },
        { id: 'codestral-latest',       label: 'Codestral'       },
      ],
      async call(config, messages) {
        const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model:      config.model,
            messages:   messages,
            max_tokens: 2048,
            temperature: 0.4,
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error?.message || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
      },
    },
  };

  /* ── Config storage ────────────────────────────────────────── */
  const LS_KEY   = 'pionex_cloud_ai';
  const _default = () => ({ provider: 'claude', model: 'claude-sonnet-4-5', keys: {} });

  let _cfgCache = null;   // config en memoria (evita re-leer localStorage en cada acceso)

  function loadConfig() {
    if (_cfgCache) return _cfgCache;
    // Fallback síncrono (antes de que init() haya corrido)
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return _default();
      const parsed = JSON.parse(raw);
      // Si es un blob cifrado { iv, ct } y aún no está descifrado → devolver defaults
      if (parsed && parsed.iv && parsed.ct) return _default();
      _cfgCache = parsed;
      return _cfgCache;
    } catch { return _default(); }
  }

  function saveConfig(cfg) {
    _cfgCache = cfg;
    // Guarda de forma async (con cifrado si CryptoStore está desbloqueado)
    const cs = typeof CryptoStore !== 'undefined' ? CryptoStore : null;
    if (cs) {
      cs.save(LS_KEY, JSON.stringify(cfg)).catch(() => {
        try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {}
      });
    } else {
      try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {}
    }
  }

  /* ── Public API ────────────────────────────────────────────── */
  return {
    PROVIDERS,

    get providerIds() { return Object.keys(PROVIDERS); },

    getModels(provId) { return PROVIDERS[provId]?.models || []; },

    /**
     * Inicializa la config desde localStorage (descifra si CryptoStore está activo).
     * Llamar una vez al arrancar, después del PIN unlock.
     */
    async init() {
      const cs = typeof CryptoStore !== 'undefined' ? CryptoStore : null;
      try {
        const raw = cs ? await cs.load(LS_KEY) : localStorage.getItem(LS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && !(parsed.iv && parsed.ct)) {
            _cfgCache = parsed;
            return;
          }
        }
      } catch {}
      _cfgCache = _default();
    },

    getConfig() { return loadConfig(); },

    setProvider(provId, model, apiKey) {
      const cfg = loadConfig();
      cfg.provider = provId;
      cfg.model    = model;
      if (apiKey) cfg.keys = { ...cfg.keys, [provId]: apiKey };
      saveConfig(cfg);
      return cfg;
    },

    setKey(provId, apiKey) {
      const cfg = loadConfig();
      cfg.keys = { ...cfg.keys, [provId]: apiKey };
      saveConfig(cfg);
    },

    getKey(provId) {
      return loadConfig().keys?.[provId] || '';
    },

    /**
     * Send a chat to the currently configured provider.
     * @param {Array<{role:string,content:string}>} messages
     * @returns {Promise<string>} text response
     */
    async chat(messages) {
      const cfg  = loadConfig();
      const prov = PROVIDERS[cfg.provider];
      if (!prov) throw new Error(`Proveedor desconocido: ${cfg.provider}`);
      const apiKey = cfg.keys?.[cfg.provider] || '';
      if (!apiKey) throw new Error(`No hay API key para ${prov.name}. Configúrala en Ajustes.`);
      return prov.call({ apiKey, model: cfg.model }, messages);
    },

    /**
     * Build a trading analysis prompt from market context.
     */
    buildTradingPrompt(symbols, marketData, mode) {
      const modeDescs = {
        scalping:     'scalping (5m charts, 0.5-2% targets)',
        daytrading:   'day trading (15m charts, intraday)',
        swingtrading: 'swing trading (1H-4H, days-long holds)',
        longterm:     'long-term (4H+ charts, week+ holds)',
      };
      const modeStr = modeDescs[mode] || mode;

      let ctx = '';
      for (const sym of symbols) {
        const d = marketData[sym];
        if (!d) continue;
        ctx += `\n## ${sym}\n`;
        ctx += `Price: ${d.price} USDT | Change 24h: ${d.change24h}%\n`;
        if (d.rsi)  ctx += `RSI(14): ${d.rsi} | `;
        if (d.macd) ctx += `MACD hist: ${d.macd.histogram?.toFixed(4)} | Signal: ${d.macd.signal?.toFixed(2)}\n`;
        if (d.bb)   ctx += `BB: Upper ${d.bb.upper?.toFixed(2)} / Mid ${d.bb.mid?.toFixed(2)} / Lower ${d.bb.lower?.toFixed(2)}\n`;
        if (d.ema20 && d.ema50) ctx += `EMA20: ${d.ema20?.toFixed(2)} | EMA50: ${d.ema50?.toFixed(2)}\n`;
        if (d.volume24h) ctx += `Volume 24h: $${(d.volume24h/1e6).toFixed(1)}M\n`;
      }

      const sysPrompt = `You are an expert crypto trading analyst. Analyze technical indicators and provide clear, actionable trading signals. Be concise and direct.`;

      const userPrompt = `Analyze the following crypto market data for ${modeStr} strategy and provide:
1. Signal (STRONG BUY / BUY / HOLD / SELL / STRONG SELL) for each pair
2. Key reasons (2-3 bullet points)
3. Suggested entry, stop-loss, and take-profit levels
4. Overall market sentiment

Market Data:
${ctx}

Format your response clearly with sections per symbol. Be direct with numbers.`;

      return [
        { role: 'system',  content: sysPrompt  },
        { role: 'user',    content: userPrompt },
      ];
    },
  };
})();
