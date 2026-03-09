
# Experimento Trader · Mobile

> Interfaz web móvil para trading de criptomonedas con análisis de IA en la nube, bot autónomo y cifrado AES-256 de credenciales.

![GitHub Pages](https://img.shields.io/badge/deploy-GitHub%20Pages-0d1117?style=flat-square&logo=github)
![vanilla JS](https://img.shields.io/badge/JS-vanilla%20ES2022-f7df1e?style=flat-square&logo=javascript)
![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## Vista general

App 100 % estática — sin build, sin Node.js, sin dependencias. Funciona directamente desde GitHub Pages conectándose a `api.pionex.com` desde el browser.

| Entorno | Cómo |
|---|---|
| 🌐 GitHub Pages | Deploy estático — acceso directo a Pionex API |
| 📱 Android (Sketchware) | WebView cargando `index.html` desde assets |

---

## Deploy en GitHub Pages

1. Haz **fork** o sube este repo a GitHub.
2. Ve a **Settings → Pages → Branch: main / (root)** y guarda.
3. En unos segundos tendrás la app en:

```
https://<tu-usuario>.github.io/<nombre-repo>/
```

Listo. No se necesita ningún servidor ni configuración adicional.

---

## Estructura del proyecto

```
Trader_web/
├── index.html          # App completa (SPA)
├── css/
│   └── styles.css      # Diseño mobile-first dark theme
└── js/
    ├── app.js           # Controlador principal
    ├── pionex-client.js # Acceso directo a api.pionex.com + indicadores
    ├── crypto-store.js  # Cifrado AES-GCM 256 · PBKDF2-SHA256
    ├── ai-cloud.js      # Módulo multi-proveedor IA (6 APIs)
    └── bot-autonomous.js# Motor del bot autónomo
```

---

## Proxy remoto (opcional)

La app funciona sin proxy. Si necesitas acceso autenticado a Pionex (órdenes reales), despliega un proxy propio:

| Servicio | Start command |
|---|---|
| [Render.com](https://render.com) | `node proxy.js` |
| [Railway.app](https://railway.app) | `node proxy.js` |
| [Fly.io](https://fly.io) | `node proxy.js` |

Luego en la app → **Ajustes → Proxy remoto** → introduce la URL pública del proxy.

---

## Sketchware / Android WebView

Copia todos los archivos del repo a `app/src/main/assets/www/` y carga el HTML desde Activity:

```java
WebView wv = (WebView) findViewById(R.id.webview1);
WebSettings ws = wv.getSettings();
ws.setJavaScriptEnabled(true);
ws.setDomStorageEnabled(true);
ws.setAllowFileAccessFromFileURLs(true);
ws.setAllowUniversalAccessFromFileURLs(true);
wv.addJavascriptInterface(new TraderInterface(this), "Android");
wv.loadUrl("file:///android_asset/www/index.html");
```

---

## Características

### 📊 Dashboard
- Ticker de precios en tiempo real (BTC, ETH, SOL, BNB, XRP…)
- Top Movers: Gainers / Losers del día
- Estadísticas de mercado: pares activos, % subiendo, volumen 24h

### 📈 Mercado
- Gráfico de velas con [Lightweight Charts](https://tradingview.github.io/lightweight-charts/)
- Intervalos: 1m · 5m · 15m · 1h · 4h
- Indicadores técnicos calculados en el browser (RSI · MACD · Bollinger · EMA)
- Análisis AI rápido del par activo

### 🤖 AI Trader
- Análisis multi-par con 6 proveedores AI
- Modos: ⚡ Scalping · 📅 Day Trading · 🌊 Swing · 📈 Long Term
- Chat interactivo sobre el mercado
- **Bot Autónomo**: ciclos automáticos de análisis y señales (Dry Run o real)

### ⚙️ Ajustes
- API Keys por proveedor AI (Claude, OpenAI, Gemini…)
- **Cifrado AES-GCM 256-bit** de todas las keys con PIN
- Proxy remoto opcional
- Tema oscuro / claro

---

## Cifrado de API Keys

```
PIN → PBKDF2-SHA256 (200 000 iter) → CryptoKey
CryptoKey + IV aleatorio → AES-GCM 256-bit → ciphertext en localStorage
```

Las keys nunca salen del dispositivo sin cifrar. El PIN no se almacena en ningún sitio.

---

## Proveedores de IA

| Proveedor | Modelos |
|---|---|
| **Claude** (Anthropic) | Sonnet 4.5 · Opus 4.5 · 3.5 Sonnet · 3.5 Haiku |
| **OpenAI** | GPT-4o · GPT-4o Mini · GPT-4 Turbo · o1-mini |
| **Gemini** (Google) | 2.0 Flash · 1.5 Pro · 1.5 Flash |
| **Groq** | Llama 3.3 70B · Mixtral 8x7B · DeepSeek R1 |
| **OpenRouter** | Claude · GPT-4o · Gemini · Llama · Mistral |
| **Mistral** | Large · Medium · Small · Codestral |

> ⚠️ Los análisis de IA son orientativos. No constituyen asesoramiento financiero.

---

## Tecnologías

| Capa | Herramienta |
|---|---|
| UI | HTML5 · CSS3 · Vanilla JS ES2022 |
| Gráficos | [Lightweight Charts 4.1](https://tradingview.github.io/lightweight-charts/) |
| Iconos | [Ionicons 7.4](https://ionic.io/ionicons) |
| Fuente | [Inter](https://fonts.google.com/specimen/Inter) |
| Datos | [Pionex Public API](https://pionex.com) |
| Cifrado | Web Crypto API (nativa del navegador) |

---

## Licencia

MIT
