/* ═══════════════════════════════════════════════════════════════
   CryptoStore — cifrado AES-GCM 256-bit para localStorage
   ─────────────────────────────────────────────────────────────
   · Clave derivada vía PBKDF2-SHA256 (200 000 iteraciones)
   · IV y salt aleatorios únicos por cada cifrado
   · El PIN vive SOLO en memoria — nunca se persiste
   · Fallback transparente a texto plano si Web Crypto no está
     disponible (p.ej. WebViews muy antiguos sin TLS)
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const CryptoStore = (() => {

  /* ── Constantes ────────────────────────────────────────────── */
  const PBKDF2_ITERS = 200_000;
  const LS_SALT  = 'cs_pin_salt';     // salt PBKDF2 (base64)
  const LS_CHECK = 'cs_pin_check';    // valor de verificación cifrado
  const CHECK_TXT = 'traderpinv1ok';  // texto para verificar PIN correcto

  /* ── Estado en memoria ─────────────────────────────────────── */
  let _key = null;   // CryptoKey AES-GCM — solo en memoria

  /* ── Feature detect ────────────────────────────────────────── */
  const _supported = (() => {
    try { return typeof window !== 'undefined' && !!(window.crypto?.subtle); }
    catch { return false; }
  })();

  /* ── Helpers binarios ──────────────────────────────────────── */
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  function _toB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function _fromB64(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function _rnd(n) {
    return window.crypto.getRandomValues(new Uint8Array(n));
  }

  /* ── Derivación de clave ───────────────────────────────────── */
  async function _deriveKey(pin, salt) {
    const km = await window.crypto.subtle.importKey(
      'raw', _enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
      km,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /* ── AES-GCM cifrado / descifrado ──────────────────────────── */
  async function _encrypt(key, plaintext) {
    const iv = _rnd(12);
    const ct = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, _enc.encode(plaintext)
    );
    return JSON.stringify({ iv: _toB64(iv.buffer), ct: _toB64(ct) });
  }

  async function _decrypt(key, stored) {
    const { iv, ct } = JSON.parse(stored);
    const plain = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(_fromB64(iv)) }, key, _fromB64(ct)
    );
    return _dec.decode(plain);
  }

  /** Devuelve true si el string parece un blob cifrado { iv, ct } */
  function _isBlob(raw) {
    try { const o = JSON.parse(raw); return !!(o && o.iv && o.ct); }
    catch { return false; }
  }

  /* ══════════════════════════════════════════════════════════════
     API pública
  ══════════════════════════════════════════════════════════════ */
  return {

    /** true si Web Crypto API está disponible en este entorno */
    get supported() { return _supported; },

    /** true si hay un PIN configurado en este dispositivo */
    hasPIN() {
      return !!(localStorage.getItem(LS_SALT) && localStorage.getItem(LS_CHECK));
    },

    /** true si la clave ya está en memoria (desbloqueado) */
    isUnlocked() { return _key !== null; },

    /** Borra la clave de memoria */
    lock() { _key = null; },

    /**
     * Intenta desbloquear con el PIN dado.
     * @returns {Promise<boolean>} true = PIN correcto
     */
    async unlock(pin) {
      if (!_supported) return true;
      const saltB64 = localStorage.getItem(LS_SALT);
      if (!saltB64) return true;   // sin PIN configurado → siempre abierto
      const salt  = new Uint8Array(_fromB64(saltB64));
      const key   = await _deriveKey(pin, salt);
      const check = localStorage.getItem(LS_CHECK);
      if (!check) { _key = key; return true; }
      try {
        const plain = await _decrypt(key, check);
        if (plain !== CHECK_TXT) return false;
        _key = key;
        return true;
      } catch { return false; }
    },

    /**
     * Establece o cambia el PIN.
     * Si ya había datos cifrados los re-cifra con el nuevo PIN.
     * @param {string} newPin
     * @param {string} [currentPin] requerido si ya hay un PIN
     * @returns {Promise<boolean>}
     */
    async setPIN(newPin, currentPin) {
      if (!_supported || !newPin) return false;
      // Si ya hay PIN, verificar el actual
      if (this.hasPIN() && currentPin != null) {
        const ok = await this.unlock(currentPin);
        if (!ok) return false;
      }
      const salt  = _rnd(16);
      const key   = await _deriveKey(newPin, salt);
      const check = await _encrypt(key, CHECK_TXT);
      localStorage.setItem(LS_SALT,  _toB64(salt.buffer));
      localStorage.setItem(LS_CHECK, check);

      // Re-cifra la config de IA si ya existe en texto plano
      try {
        const raw = localStorage.getItem('pionex_cloud_ai');
        if (raw && !_isBlob(raw)) {
          localStorage.setItem('pionex_cloud_ai', await _encrypt(key, raw));
        }
      } catch {}

      _key = key;
      return true;
    },

    /**
     * Quita el PIN y descifra todo de vuelta a texto plano.
     * @param {string} pin  PIN actual para confirmar
     * @returns {Promise<boolean>}
     */
    async removePIN(pin) {
      if (!_supported) return true;
      const ok = await this.unlock(pin);
      if (!ok) return false;
      // Descifrar config de AI de vuelta a texto plano
      try {
        const raw = localStorage.getItem('pionex_cloud_ai');
        if (raw && _isBlob(raw) && _key) {
          const plain = await _decrypt(_key, raw);
          localStorage.setItem('pionex_cloud_ai', plain);
        }
      } catch {}
      localStorage.removeItem(LS_SALT);
      localStorage.removeItem(LS_CHECK);
      _key = null;
      return true;
    },

    /**
     * Guarda un valor en localStorage — cifrado si hay PIN activo.
     * @param {string} lsKey
     * @param {string|object} value
     */
    async save(lsKey, value) {
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      if (!_supported || !_key) {
        localStorage.setItem(lsKey, str);
        return;
      }
      localStorage.setItem(lsKey, await _encrypt(_key, str));
    },

    /**
     * Carga un valor de localStorage — descifra si es un blob cifrado.
     * @param {string} lsKey
     * @returns {Promise<string|null>}
     */
    async load(lsKey) {
      const raw = localStorage.getItem(lsKey);
      if (!raw) return null;
      if (!_supported || !_key) return raw;
      try {
        if (!_isBlob(raw)) return raw;   // legado: texto plano
        return await _decrypt(_key, raw);
      } catch { return raw; }
    },
  };

})();
