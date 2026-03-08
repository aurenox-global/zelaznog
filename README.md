# Experimento Trader · Mobile

> Interfaz web móvil para trading de criptomonedas con análisis de IA en la nube, bot autónomo y cifrado AES-256 de credenciales.

![dark theme](https://img.shields.io/badge/theme-dark-0d1117?style=flat-square)
![vanilla JS](https://img.shields.io/badge/JS-vanilla%20ES2022-f7df1e?style=flat-square&logo=javascript)
![Python proxy](https://img.shields.io/badge/proxy-Python%203-3776ab?style=flat-square&logo=python)
![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## Índice

- [Vista general](#vista-general)
- [Características](#características)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Inicio rápido](#inicio-rápido)
  - [Local](#local)
  - [GitHub Pages + proxy remoto](#github-pages--proxy-remoto)
  - [Sketchware / Android WebView](#sketchware--android-webview)
- [Proxy CORS](#proxy-cors)
- [Cifrado de API Keys](#cifrado-de-api-keys)
- [Proveedores de IA](#proveedores-de-ia)
- [Seguridad](#seguridad)
- [Tecnologías](#tecnologías)

---

## Vista general

Experimento Trader es una **web app 100 % estática** (HTML + CSS + JS) diseñada para funcionar:

| Entorno | Cómo |
|---|---|
| 🖥 Navegador local | `python3 proxy.py` + abrir `http://localhost:8000` |
| 🌐 GitHub Pages | Deploy estático + proxy en Render / Railway / Fly.io |
| 📱 Android (Sketchware) | WebView cargando `index.html` desde assets o URL remota |

No requiere Node.js, ni frameworks, ni proceso de build. El proxy funciona con **Python 3 stdlib pura** (cero dependencias).

---

## Características

### 📊 Dashboard
- Ticker de precios en tiempo real (BTC, ETH, SOL, BNB, XRP…)
- Top Movers: Gainers / Losers del día
- Estadísticas de mercado: pares activos, % subiendo, volumen 24h
- Balance de portfolio (requiere Pionex API keys)

### 📈 Mercado
- Gráfico de velas con [Lightweight Charts](https://tradingview.github.io/lightweight-charts/)
- Intervalos: 1m · 5m · 15m · 1h · 4h
- Indicadores técnicos calculados en el proxy:
  - **RSI** (14) — señales sobreventa/sobrecompra
  - **MACD** (12, 26, 9) — histograma + señal
  - **Bollinger Bands** (20, ±2σ) — %B
  - **EMA** (20 / 50) — tendencia cruzada
- Análisis AI rápido del par activo
- Buscador de pares (todos los ~350 pares de Pionex)

### 🤖 AI Trader
- Análisis multi-par con cualquiera de los 6 proveedores AI
- Modos: ⚡ Scalping · 📅 Day Trading · 🌊 Swing · 📈 Long Term
- Chat interactivo: pregunta lo que quieras sobre el mercado
- **Bot Autónomo Cloud AI**: ciclos automáticos de análisis y señales
  - Dry Run (simulación) o modo real
  - Stop Loss / Take Profit configurables
  - Circuit Breaker de pérdida diaria máxima
  - Historial de trades + log en vivo

### 💱 Trading
- Formulario de órdenes BUY / SELL con preview de SL/TP
- Shortcuts de cantidad: 25% · 50% · 75% · Max
- Modal de confirmación antes de ejecutar
- Lista de posiciones abiertas y órdenes recientes

### ⚙️ Ajustes
- URL del backend configurable (local o remoto)
- Pionex API Key + Secret
- API Keys por proveedor AI (Claude, OpenAI, Gemini…)
- **Cifrado AES-GCM 256-bit** de todas las keys con PIN
- Tema oscuro / claro

---

## Estructura del proyecto

```
Trader_web/
├── index.html              # App completa (SPA, ~750 líneas)
├── css/
│   └── styles.css          # Diseño mobile-first dark theme
├── js/
│   ├── crypto-store.js     # Cifrado AES-GCM 256 · PBKDF2-SHA256
│   ├── ai-cloud.js         # Módulo multi-proveedor IA (6 APIs)
│   ├── bot-autonomous.js   # Motor del bot autónomo
│   └── app.js              # Controlador principal + bridge Sketchware
├── proxy.py                # Proxy CORS Python 3 (0 deps, ≈ 300 líneas)
├── proxy.js                # Proxy CORS Node.js (alternativo)
└── package.json            # Scripts npm (opcional si tienes Node)
```

---

## Inicio rápido

### Local

**Opción A — Python 3 (recomendado, sin instalar nada extra):**

```bash
git clone https://github.com/tu-usuario/trader-web.git
cd trader-web
python3 proxy.py          # escucha en http://localhost:8000
```

Abre `http://localhost:8000` en el navegador.

**Opción B — Node.js:**

```bash
node proxy.js
```

**Puerto personalizado:**

```bash
PORT=8080 python3 proxy.py
```

---

### GitHub Pages + proxy remoto

1. **Haz fork / sube el repo a GitHub.**

2. Activa **GitHub Pages** en `Settings → Pages → Branch: main / root`.  
   Tu app estará en `https://tu-usuario.github.io/trader-web/`.

3. Despliega el proxy en un servidor gratuito:

   | Servicio | Comandos |
   |---|---|
   | [Render.com](https://render.com) | New → Web Service → `python3 proxy.py` |
   | [Railway.app](https://railway.app) | Deploy → `python3 proxy.py` |
   | [Fly.io](https://fly.io) | `fly launch` → start: `python3 proxy.py` |

4. En la app web → **Ajustes → URL del backend** → pega la URL pública del proxy (p. ej. `https://mi-proxy.onrender.com`).

---

### Sketchware / Android WebView

En tu Activity de Sketchware, agrega en el bloque **Java/Kotlin**:

```java
WebView wv = (WebView) findViewById(R.id.webview1);
WebSettings ws = wv.getSettings();

ws.setJavaScriptEnabled(true);
ws.setDomStorageEnabled(true);                         // habilita localStorage
ws.setAllowFileAccessFromFileURLs(true);               // si cargas desde assets
ws.setAllowUniversalAccessFromFileURLs(true);
ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); // proxy HTTP

// Expone la interfaz nativa (opcional)
wv.addJavascriptInterface(new TraderInterface(this), "Android");

// Carga el HTML desde assets
wv.loadUrl("file:///android_asset/www/index.html");

// O desde el proxy remoto
// wv.loadUrl("https://mi-proxy.onrender.com");
```

**Copiar archivos de la app a assets:**  
Coloca todo el contenido del repo en `app/src/main/assets/www/`.

**Llamar a la app desde Sketchware** (pasar URL del proxy al arrancar):

```java
wv.evaluateJavascript(
  "TraderApp.setServer('http://192.168.1.100:8000')", null
);
```

**Leer estado desde Sketchware:**

```java
wv.evaluateJavascript("TraderApp.getStatus()", value -> {
    // value = JSON con { connected, page, symbol }
});
```

---

## Proxy CORS

El proxy (`proxy.py` / `proxy.js`) actúa como intermediario entre el navegador/WebView y la API pública de Pionex:

```
Navegador ──fetch──► proxy:8000 ──HTTPS──► api.pionex.com
```

### Endpoints expuestos

| Endpoint | Descripción |
|---|---|
| `GET /api/health` | Status check |
| `GET /api/tickers` | Todos los pares (precio, cambio 24h, volumen) |
| `GET /api/klines?symbol=BTC_USDT&interval=15M&limit=200` | Velas OHLCV |
| `GET /api/indicators?symbol=BTC_USDT&interval=15M` | RSI · MACD · Bollinger · EMA |
| `GET /api/portfolio` | Devuelve vacío (requiere auth del exchange) |
| `/*` | Sirve archivos estáticos (modo dev local) |

### Indicadores calculados en el proxy (sin dependencias externas)

- **RSI** (Wilder, 14 períodos)
- **MACD** (12/26/9) — línea MACD, señal e histograma
- **Bollinger Bands** (20 períodos, ±2σ) — upper · mid · lower
- **EMA** (20 y 50 períodos)

---

## Cifrado de API Keys

Las API keys de los proveedores IA se pueden cifrar localmente con un PIN:

```
PIN → PBKDF2-SHA256 (200 000 iter) → CryptoKey
CryptoKey + IV aleatorio → AES-GCM 256-bit → ciphertext en localStorage
```

### Activar el cifrado

1. **Ajustes → Seguridad — Cifrado AES-256**
2. Introduce un PIN (mín. 4 caracteres)
3. Pulsa **Establecer / Cambiar PIN**

Al reabrir la app, aparece el overlay de desbloqueo. Las keys **no pueden leerse** de localStorage sin el PIN correcto.

### Propiedades de seguridad

| Propiedad | Valor |
|---|---|
| Algoritmo | AES-GCM 256-bit |
| Derivación de clave | PBKDF2-SHA256 · 200 000 iteraciones |
| IV | 96 bits aleatorios únicos por cifrado |
| Salt | 128 bits aleatorios, persistido en localStorage |
| PIN en reposo | ❌ nunca se almacena |
| API en uso | Web Crypto API (nativa en todos los navegadores modernos) |
| Fallback | Texto plano transparente si Web Crypto no está disponible |

---

## Proveedores de IA

Todos los modelos se llaman **directamente desde el browser** (client-side). La API key sale del dispositivo hacia el endpoint oficial del proveedor — no pasa por ningún servidor propio.

| Proveedor | Modelos incluidos |
|---|---|
| **Claude** (Anthropic) | Sonnet 4.5 · Opus 4.5 · 3.5 Sonnet · 3.5 Haiku · 3 Opus |
| **OpenAI** | GPT-4o · GPT-4o Mini · GPT-4 Turbo · GPT-3.5 Turbo · o1-mini |
| **Gemini** (Google) | 2.0 Flash · 1.5 Pro · 1.5 Flash · 1.5 Flash-8B |
| **Groq** | Llama 3.3 70B · Llama 3.1 8B · Mixtral 8x7B · Gemma 2 9B · DeepSeek R1 |
| **OpenRouter** | Claude · GPT-4o · Gemini · Llama · DeepSeek · Mistral Large · Qwen 2.5 |
| **Mistral** | Large · Medium · Small · Codestral |

---

## Seguridad

- **Sin servidor propio**: la app es 100 % estática; el proxy solo toca APIs públicas de Pionex.
- **API keys locales**: se guardan en `localStorage` del dispositivo, nunca en ningún backend tuyo.
- **Cifrado opcional**: AES-GCM 256-bit protege las keys si el dispositivo es compartido.
- **Path traversal bloqueado**: el proxy verifica que los archivos estáticos sean hijos del directorio raíz.
- **Sin datos de usuario recolectados**: no hay analytics, no hay telemetría.
- **Modo DRY RUN por defecto**: el bot autónomo simula operaciones hasta que lo actives explícitamente.

> ⚠️ **Aviso**: los análisis de IA son orientativos. No constituyen asesoramiento financiero. Opera siempre con capital que puedas permitirte perder.

---

## Tecnologías

| Capa | Herramienta |
|---|---|
| UI | HTML5 · CSS3 (custom properties) · Vanilla JS ES2022 |
| Gráficos | [Lightweight Charts 4.1](https://tradingview.github.io/lightweight-charts/) |
| Iconos | [Ionicons 7.4](https://ionic.io/ionicons) |
| Fuente | [Inter](https://fonts.google.com/specimen/Inter) (Google Fonts) |
| Datos de mercado | [Pionex Public API](https://pionex.com) |
| Cifrado | Web Crypto API (nativa) |
| Proxy | Python 3.8+ stdlib · Node.js 16+ stdlib |

---

## Licencia

MIT — libre para uso personal y comercial. Ver [`LICENSE`](LICENSE).
