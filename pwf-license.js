/* Shared PWF Auth license helper for 9Router Extender.
 *
 * Architecture (Manifest V3):
 *  - ALL network calls to pwfauth.com run in background.js (service worker),
 *    because it is immune to page CSP and its host_permissions bypass CORS.
 *    (The API sends no Access-Control-Allow-Origin header, so page-context
 *    fetches are unreliable.)
 *  - popup.js and content.js NEVER fetch directly: they talk to the worker
 *    via chrome.runtime.sendMessage, with a direct-fetch fallback if the
 *    worker is ever unreachable.
 *  - The only visible license UI lives in the extension popup. content.js
 *    silently gates on the cached license and injects nothing until valid.
 *
 * Backend: https://pwfauth.com/
 * Endpoint: POST /api/auth/check-key.php  (plain JSON, no envelope needed)
 *   Headers: { "X-App-Secret": APP_SECRET, "Content-Type": "application/json" }
 *   Body:    { "license_key": "PWF-XXXX-..." }
 *   Valid:   { "success": true, "valid": true, "key": { status, expires_at, ... } }
 *   Invalid: { "success": false, "valid": false, "error_code": "INVALID_KEY", ... }
 */
(function () {
  'use strict';

  const APP_ID = '945a2a22-2fa5-419f-9f79-c680c587eb01';
  const APP_SECRET = '1775b3f2f00d4911663706a04b7543ba2078b34b0b01eaae39b41cb07c3b8ba6';
  const CHECK_URL = 'https://pwfauth.com/api/auth/check-key.php';
  const LOGIN_URL = 'https://pwfauth.com/api/auth/login.php';
  const HEARTBEAT_URL = 'https://pwfauth.com/api/auth/heartbeat.php';
  const LOGOUT_URL = 'https://pwfauth.com/api/auth/logout.php';

  const STORE_KEY = 'pwf_license_key';
  const STORE_STATUS = 'pwf_license_status';
  const STORE_HWID = 'pwf_hwid';

  // Re-validation policy.
  const ONLINE_RECHECK_MS = 24 * 60 * 60 * 1000; // re-check online at most once per 24h
  const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // allow cached valid key offline for 7 days

  // Set to true by background.js after importScripts. When true, all calls
  // go direct (never sendMessage back to ourselves).
  let IS_BACKGROUND = false;

  // Key for the cached-license receipt HMAC. Embedded in the shipped code:
  // this stops casual DevTools-storage forgery, NOT someone editing the
  // extension's own files (nothing can stop that in a browser extension).
  const RECEIPT_KEY = '7d3a9f1c4e2b6850f6a1d3c5b7e89024a6c8e0f2b4d6a8c1e3f5a7b9d1c3e5f7';

  // --- Minimal SHA-256 / HMAC-SHA256 (sync, dependency-free, UTF-8 safe) ---
  function sha256Ascii(ascii) {
    function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
    const mathPow = Math.pow, maxWord = mathPow(2, 32);
    let result = '';
    const words = [], asciiBitLength = ascii.length * 8;
    let hash = (sha256Ascii.h = sha256Ascii.h || []);
    const k = (sha256Ascii.k = sha256Ascii.k || []);
    let primeCounter = k.length;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (let j = 0; j < words.length;) {
      const w = words.slice(j, (j += 16)), oldHash = hash;
      hash = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ (~e & hash[6]))
          + k[i]
          + (w[i] = i < 16 ? w[i] : (w[i - 16]
            + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
            + w[i - 7]
            + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0);
        const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? 0 : '') + b.toString(16);
      }
    }
    return result;
  }

  function toByteString(s) {
    return unescape(encodeURIComponent(String(s)));
  }

  function hexToByteString(hex) {
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return out;
  }

  function sha256Hex(s) {
    return sha256Ascii(toByteString(s));
  }

  function hmacSha256Hex(keyStr, msgStr) {
    let key = toByteString(keyStr);
    const msg = toByteString(msgStr);
    if (key.length > 64) key = hexToByteString(sha256Ascii(key));
    while (key.length < 64) key += '\x00';
    let oKeyPad = '', iKeyPad = '';
    for (let i = 0; i < 64; i++) {
      const c = key.charCodeAt(i);
      oKeyPad += String.fromCharCode(c ^ 0x5c);
      iKeyPad += String.fromCharCode(c ^ 0x36);
    }
    return sha256Ascii(oKeyPad + hexToByteString(sha256Ascii(iKeyPad + msg)));
  }

  // Canonical receipt payload: key + server fields + validation time.
  // Any edit (including extending validated_at) breaks the signature.
  function receiptPayload(licenseKey, keyInfo, validatedAt) {
    const exp = (keyInfo && keyInfo.expires_at != null) ? String(keyInfo.expires_at) : '';
    const days = (keyInfo && keyInfo.days_remaining != null) ? String(keyInfo.days_remaining) : '';
    const st = (keyInfo && keyInfo.status != null) ? String(keyInfo.status) : 'active';
    return ['v1', String(licenseKey || '').trim(), exp, days, st, String(validatedAt)].join('|');
  }

  function signReceipt(licenseKey, keyInfo, validatedAt, sess) {
    const base = receiptPayload(licenseKey, keyInfo, validatedAt);
    if (sess && sess.session_id) {
      // v2: binds the receipt to one device + one server session.
      return 'v2:' + hmacSha256Hex(RECEIPT_KEY, 'v2|' + base + '|' + String(sess.hwid || '') + '|' + String(sess.session_id));
    }
    return hmacSha256Hex(RECEIPT_KEY, base);
  }

  function verifyReceipt(licenseKey, receipt) {
    try {
      if (!receipt || receipt.valid !== true) return false;
      if (typeof receipt.validated_at !== 'number' || typeof receipt.sig !== 'string') return false;
      const keyInfo = {
        expires_at: receipt.expires_at != null ? receipt.expires_at : null,
        days_remaining: receipt.days_remaining != null ? receipt.days_remaining : null,
        status: receipt.status != null ? receipt.status : 'active'
      };
      const sess = receipt.session_id
        ? { hwid: receipt.hwid || '', session_id: receipt.session_id }
        : null;
      const expected = signReceipt(licenseKey, keyInfo, receipt.validated_at, sess);
      if (expected.length !== receipt.sig.length || expected.length === 0) return false;
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ receipt.sig.charCodeAt(i);
      }
      return diff === 0;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------
  // Encrypted envelope + HWID session API (runs in background.js).
  // Envelope: {"p": base64(IV||AES-256-CBC ciphertext), "t": unix_ts,
  //            "s": hex(HMAC-SHA256(p + str(t), mac_key))},
  // enc_key = SHA256("enc:"+secret), mac_key = SHA256("mac:"+secret).
  // WebCrypto does the primitives; this code only formats per PWF spec.
  // ---------------------------------------------------------
  function subtleCrypto() {
    const c = globalThis.crypto;
    if (!c || !c.subtle || !c.getRandomValues) {
      throw Object.assign(new Error('WebCrypto unavailable in this context.'), { code: 'NO_WEBCRYPTO' });
    }
    return c.subtle;
  }

  function b64encodeBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64decodeBytes(b64) {
    const s = atob(String(b64));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function hexToBytes(hex) {
    const clean = String(hex || '');
    const out = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < out.length; i++) {
      const v = parseInt(clean.substr(i * 2, 2), 16);
      out[i] = isNaN(v) ? 0 : v;
    }
    return out;
  }

  function bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return s;
  }

  async function deriveAppKeys() {
    const sub = subtleCrypto();
    const te = new TextEncoder();
    const encRaw = await sub.digest('SHA-256', te.encode('enc:' + APP_SECRET));
    const macRaw = await sub.digest('SHA-256', te.encode('mac:' + APP_SECRET));
    const encKey = await sub.importKey('raw', encRaw, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']);
    const macKey = await sub.importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return { encKey, macKey };
  }

  async function envelopeEncrypt(obj) {
    const { encKey, macKey } = await deriveAppKeys();
    const sub = subtleCrypto();
    const te = new TextEncoder();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const ct = new Uint8Array(await sub.encrypt({ name: 'AES-CBC', iv }, encKey, te.encode(JSON.stringify(obj))));
    const joined = new Uint8Array(16 + ct.length);
    joined.set(iv, 0);
    joined.set(ct, 16);
    const p = b64encodeBytes(joined);
    const t = Math.floor(Date.now() / 1000);
    const sig = new Uint8Array(await sub.sign('HMAC', macKey, te.encode(p + String(t))));
    return { p, t, s: bytesToHex(sig) };
  }

  async function envelopeDecrypt(body) {
    if (!body || typeof body.p !== 'string' || typeof body.s !== 'string' ||
        (typeof body.t !== 'number' && typeof body.t !== 'string')) {
      throw Object.assign(new Error('Not an encrypted envelope.'), { code: 'NOT_ENVELOPE' });
    }
    const { encKey, macKey } = await deriveAppKeys();
    const sub = subtleCrypto();
    const te = new TextEncoder();
    const t = Number(body.t);
    if (!isFinite(t)) {
      throw Object.assign(new Error('Bad envelope timestamp.'), { code: 'BAD_ENVELOPE' });
    }
    let macOk = false;
    try {
      macOk = await sub.verify('HMAC', macKey, hexToBytes(body.s), te.encode(String(body.p) + String(body.t)));
    } catch (e) {
      macOk = false;
    }
    if (!macOk) {
      throw Object.assign(new Error('Envelope signature mismatch.'), { code: 'MAC_MISMATCH' });
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - t) > 300) {
      throw Object.assign(new Error('Envelope timestamp out of range.'), { code: 'STALE_ENVELOPE' });
    }
    let raw;
    try {
      raw = b64decodeBytes(body.p);
    } catch (e) {
      throw Object.assign(new Error('Bad envelope payload.'), { code: 'BAD_ENVELOPE' });
    }
    if (raw.length < 17) {
      throw Object.assign(new Error('Bad envelope payload.'), { code: 'BAD_ENVELOPE' });
    }
    const iv = raw.slice(0, 16), ct = raw.slice(16);
    let pt;
    try {
      pt = await sub.decrypt({ name: 'AES-CBC', iv }, encKey, ct);
    } catch (e) {
      throw Object.assign(new Error('Envelope decryption failed.'), { code: 'BAD_ENVELOPE' });
    }
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function postEnvelope(url, obj) {
    const body = JSON.stringify(await envelopeEncrypt(obj));
    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-App-Secret': APP_SECRET },
          body,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      throw Object.assign(
        new Error(timedOut ? 'Request timed out.' : 'Could not reach license server.'),
        { code: 'NETWORK_ERROR', networkError: true, detail: (e && (e.name + ': ' + e.message)) || 'fetch failed' }
      );
    }
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      throw Object.assign(new Error('Could not read license server response.'), { code: 'BAD_RESPONSE', detail: 'HTTP ' + res.status });
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw Object.assign(new Error('Bad response from license server.'), { code: 'BAD_RESPONSE', detail: 'HTTP ' + res.status + ' non-JSON' });
    }
    return { res, json };
  }

  // Unwrap: encrypted envelope when present, plain JSON otherwise
  // (plain shapes carry CSRF blocks and validation errors).
  async function unwrapEnvelope(json, res) {
    if (!json || typeof json.p !== 'string') {
      return { enveloped: false, data: json };
    }
    try {
      return { enveloped: true, data: await envelopeDecrypt(json) };
    } catch (e) {
      throw Object.assign(new Error('Could not verify license server reply.'), {
        code: (e && e.code) || 'BAD_ENVELOPE',
        detail: 'HTTP ' + res.status
      });
    }
  }

  function transportOf(errCode, networkError) {
    return !!networkError || errCode === 'BAD_RESPONSE' || errCode === 'NO_WEBCRYPTO';
  }

  // Stable per-install device id (PWF treats the string opaquely).
  // First login binds it; max_devices retires the oldest session on
  // re-login, so reinstalls self-heal.
  function uuidv4() {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.prototype.map.call(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  async function getHwid() {
    const items = await storageGet([STORE_HWID]);
    if (items[STORE_HWID]) return items[STORE_HWID];
    const id = 'ext-' + uuidv4();
    await storageSet({ [STORE_HWID]: id });
    return id;
  }

  async function apiLogin(licenseKey, hwid) {
    const key = String(licenseKey || '').trim();
    if (!key) {
      return { ok: false, message: 'Please enter a license key.', errorCode: 'MISSING_FIELDS' };
    }
    if (!hwid) {
      return { ok: false, message: 'No device identity. Reload the extension and try again.', errorCode: 'NO_HWID' };
    }
    let res, json;
    try {
      const r = await postEnvelope(LOGIN_URL, { license_key: key, hwid });
      res = r.res;
      json = r.json;
    } catch (e) {
      return {
        ok: false,
        message: (e.message || 'Sign-in failed.') + ' Check your connection and try again.',
        errorCode: (e && e.code) || 'NETWORK_ERROR',
        networkError: !!(e && (e.networkError || e.code === 'NETWORK_ERROR')),
        detail: e && e.detail
      };
    }
    let data;
    try {
      data = (await unwrapEnvelope(json, res)).data;
    } catch (e) {
      return { ok: false, message: e.message || 'Bad reply from license server.', errorCode: (e && e.code) || 'BAD_ENVELOPE', detail: e && e.detail };
    }
    if (data && data.success === true && data.session_id) {
      const user = (data.user && typeof data.user === 'object') ? data.user : {};
      const features = (data.features && typeof data.features === 'object') ? data.features : {};
      const hb = Number(data.heartbeat_interval);
      return {
        ok: true,
        session: {
          session_id: String(data.session_id),
          user,
          features,
          heartbeat_interval: hb > 0 ? hb : 60
        }
      };
    }
    const code = (data && data.error_code) || 'LOGIN_FAILED';
    return {
      ok: false,
      message: (data && data.message) || (data && data.detail) || friendlyErrorMessage(code),
      errorCode: code,
      raw: data,
      detail: 'HTTP ' + res.status
    };
  }

  async function apiHeartbeat(sessionId, licenseKey) {
    if (!sessionId) {
      return { ok: false, alive: false, message: 'No session.', errorCode: 'SESSION_EXPIRED' };
    }
    let res, json;
    try {
      const r = await postEnvelope(HEARTBEAT_URL, { session_id: sessionId, license_key: String(licenseKey || '') });
      res = r.res;
      json = r.json;
    } catch (e) {
      return {
        ok: false, alive: false,
        message: (e.message || 'Heartbeat failed.') + ' Check your connection.',
        errorCode: (e && e.code) || 'NETWORK_ERROR',
        networkError: !!(e && (e.networkError || e.code === 'NETWORK_ERROR')),
        detail: e && e.detail
      };
    }
    let data;
    try {
      data = (await unwrapEnvelope(json, res)).data;
    } catch (e) {
      return { ok: false, alive: false, message: e.message || 'Bad reply from license server.', errorCode: (e && e.code) || 'BAD_ENVELOPE', detail: e && e.detail };
    }
    if (data && data.success === true) {
      return { ok: true, alive: true };
    }
    // Server rejection here IS the kill-switch (banned / paused / expired).
    const code = (data && data.error_code) || 'SESSION_EXPIRED';
    return {
      ok: false, alive: false,
      message: (data && data.message) || (data && data.detail) || friendlyErrorMessage(code),
      errorCode: code,
      raw: data,
      detail: 'HTTP ' + res.status
    };
  }

  async function apiLogout(sessionId, licenseKey) {
    try {
      if (!sessionId) return { ok: true };
      await postEnvelope(LOGOUT_URL, { session_id: sessionId, license_key: String(licenseKey || '') });
    } catch (e) { /* best-effort */ }
    return { ok: true };
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (items) => resolve(items || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function storageSet(items) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(items, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(keys, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function sendToBackground(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('license worker timeout'));
        }
      }, timeoutMs || 25000);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(new Error(err.message || 'license worker unavailable'));
          else resolve(resp);
        });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    });
  }

  /**
   * Raw HTTPS validation. Runs in the background worker. Never messages.
   */
  async function validateDirect(licenseKey) {
    const key = String(licenseKey || '').trim();
    if (!key) {
      return { ok: false, message: 'Please enter a license key.', errorCode: 'MISSING_FIELDS' };
    }

    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        res = await fetch(CHECK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-App-Secret': APP_SECRET
          },
          body: JSON.stringify({ license_key: key }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      return {
        ok: false,
        message: (timedOut ? 'Request timed out.' : 'Could not reach license server.') + ' Check your connection and try again.',
        errorCode: 'NETWORK_ERROR',
        networkError: true,
        detail: (e && (e.name + ': ' + e.message)) || 'fetch failed'
      };
    }

    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      return { ok: false, message: 'Could not read license server response.', errorCode: 'BAD_RESPONSE', detail: 'HTTP ' + res.status + ' body unreadable' };
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, message: 'Bad response from license server. Try again.', errorCode: 'BAD_RESPONSE', detail: 'HTTP ' + res.status + ' non-JSON reply' };
    }

    // Canonical success: { success: true, valid: true, key: {...} }
    if (data && data.success === true && data.valid === true) {
      return { ok: true, message: 'License valid.', keyInfo: data.key || {}, raw: data };
    }

    // Explicit invalid (valid:false) or success:false with error_code.
    // Note: server rejections (e.g. CSRF blocks) come as {"detail": "..."}
    // with NO error_code — always read data.detail too.
    const code = (data && data.error_code) || (data && data.detail ? 'SERVER_REJECTED' : 'INVALID_KEY');
    let msg = (data && data.message) || (data && data.detail) || friendlyErrorMessage(code);
    // HTTP-aware hints: 401/403 mean the request itself was refused — that's
    // an App Secret / app mismatch, not a typo in the key.
    if (res.status === 401) {
      msg = 'License server rejected the App Secret (HTTP 401). The secret configured in the extension is invalid.';
    } else if (res.status === 403 && /csrf|origin/i.test(msg)) {
      msg = 'License server rejected the extension origin (HTTP 403, CSRF block). Reload the extension at chrome://extensions/ so the header-fix rule activates, then try again.';
    } else if (res.status === 403 && code === 'INVALID_KEY') {
      msg = 'Key not found for this app (HTTP 403). The key likely belongs to a different app than the extension\u2019s App Secret, or the app is disabled — check the PWF dashboard.';
    }
    return { ok: false, message: msg, errorCode: code, raw: data, detail: 'HTTP ' + res.status };
  }

  /**
   * Activate (HWID-bind + persist) a user-supplied key from the popup form.
   * Runs in the background worker; direct flow is the fallback.
   */
  async function activate(licenseKey) {
    const key = String(licenseKey || '').trim();
    if (!key) {
      return { ok: false, message: 'Please enter a license key.', errorCode: 'MISSING_FIELDS' };
    }
    if (!IS_BACKGROUND) {
      try {
        const res = await sendToBackground({ type: 'pwf-activate', licenseKey: key }, 30000);
        if (res && typeof res.ok === 'boolean') return res;
      } catch (e) {
        // Worker unreachable — fall through to direct flow below.
      }
    }
    return await activateFlow(key);
  }

  function friendlyErrorMessage(code) {
    switch (String(code || '').toUpperCase()) {
      case 'INVALID_KEY': return 'This license key was not found.';
      case 'EXPIRED': return 'This license key has expired.';
      case 'BANNED': return 'This license key has been banned.';
      case 'PAUSED': return 'This license key is paused. Contact support.';
      case 'HWID_MISMATCH': return 'This key is bound to another device.';
      case 'MAINTENANCE': return 'License server is in maintenance. Try again later.';
      case 'MISSING_FIELDS': return 'Please enter a license key.';
      case 'SERVER_REJECTED': return 'License server refused the request.';
      case 'LOGIN_FAILED': return 'Sign-in failed. Check the key and try again.';
      case 'NO_HWID': return 'No device identity. Reload the extension and try again.';
      case 'SESSION_EXPIRED': return 'Session expired. Signing in again.';
      case 'SESSION_MISMATCH': return 'Session mismatch. Signing in again.';
      case 'BAD_ENVELOPE': return 'Could not verify the license server reply.';
      default: return 'License check failed. Try again.';
    }
  }

  async function getStored() {
    const items = await storageGet([STORE_KEY, STORE_STATUS]);
    return {
      licenseKey: items[STORE_KEY] || '',
      status: items[STORE_STATUS] || null
    };
  }

  async function saveValid(licenseKey, keyInfo) {
    const validatedAt = Date.now();
    const status = {
      valid: true,
      status: (keyInfo && keyInfo.status) || 'active',
      key_type: (keyInfo && (keyInfo.key_type || keyInfo.type)) || null,
      expires_at: (keyInfo && keyInfo.expires_at) || null,
      days_remaining: keyInfo && typeof keyInfo.days_remaining !== 'undefined' ? keyInfo.days_remaining : null,
      max_devices: (keyInfo && keyInfo.max_devices) || null,
      validated_at: validatedAt,
      // Signed receipt: any hand-edit of the cached license breaks this.
      sig: signReceipt(licenseKey, keyInfo, validatedAt)
    };
    await storageSet({ [STORE_KEY]: String(licenseKey).trim(), [STORE_STATUS]: status });
    return status;
  }

  // HWID-bound session receipt (v2 signature covers device + session).
  async function saveSession(licenseKey, hwid, session) {
    const validatedAt = Date.now();
    const user = (session && session.user) || {};
    const status = {
      valid: true,
      hwid: String(hwid || ''),
      session_id: session ? String(session.session_id) : '',
      status: user.status || 'active',
      key_type: user.key_type || user.type || null,
      expires_at: user.expires_at || null,
      days_remaining: typeof user.days_remaining !== 'undefined' ? user.days_remaining : null,
      max_devices: typeof user.max_devices !== 'undefined' ? user.max_devices : null,
      heartbeat_interval: (session && session.heartbeat_interval) || 60,
      heartbeat_at: validatedAt,
      validated_at: validatedAt,
      sig: ''
    };
    status.sig = signReceipt(licenseKey, user, validatedAt, { hwid: status.hwid, session_id: status.session_id });
    await storageSet({ [STORE_KEY]: String(licenseKey).trim(), [STORE_STATUS]: status });
    return status;
  }

  // Refresh timestamps on a verified session receipt after a live heartbeat.
  // Only ever called with an already signature-verified receipt, so no
  // forged fields can be laundered into a fresh signature here.
  async function touchReceipt(stored) {
    const now = Date.now();
    const status = Object.assign({}, stored.status, {
      heartbeat_at: now,
      validated_at: now,
      sig: ''
    });
    status.sig = signReceipt(stored.licenseKey, status, now, { hwid: status.hwid, session_id: status.session_id });
    await storageSet({ [STORE_STATUS]: status });
    return status;
  }

  function deniedFrom(r) {
    return {
      allowed: false,
      reason: r && r.networkError ? 'offline' : 'invalid',
      message: (r && r.message) || 'License check failed.',
      errorCode: r && r.errorCode,
      detail: r && r.detail
    };
  }

  // Full HWID login for a key. Returns { ok, status } or
  // { ok:false, transport, ... } (transport=true means "server unreachable
  // or unparsable" — NOT a rejection; callers may use the lightweight path).
  async function workerLogin(licenseKey) {
    let hwid;
    try {
      hwid = await getHwid();
    } catch (e) {
      return { ok: false, message: 'No device identity. Reload the extension and try again.', errorCode: 'NO_HWID' };
    }
    let r;
    try {
      r = await apiLogin(licenseKey, hwid);
    } catch (e) {
      return { ok: false, message: 'Sign-in failed.', errorCode: 'LOGIN_FAILED', transport: true, detail: e && e.message };
    }
    if (r.ok) {
      const status = await saveSession(licenseKey, hwid, r.session);
      return { ok: true, status, session: r.session };
    }
    return Object.assign({ transport: transportOf(r.errorCode, r.networkError) }, r);
  }

  // Activation from the popup: HWID login first; lightweight check only as
  // a transport-failure fallback (legacy sessionless receipt, upgraded to a
  // session on the next online check). Server rejections never fall back.
  async function activateFlow(licenseKey) {
    const key = String(licenseKey || '').trim();
    if (!key) {
      return { ok: false, message: 'Please enter a license key.', errorCode: 'MISSING_FIELDS' };
    }
    const lr = await workerLogin(key);
    if (lr.ok) {
      return { ok: true, message: 'License valid. This device is now bound to the key.' };
    }
    if (!lr.transport) return lr;
    const fb = await validateDirect(key);
    if (!fb.ok) return fb;
    await saveValid(key, fb.keyInfo);
    return { ok: true, message: 'License valid. Device binding completes on the next online check.', legacy: true };
  }

  async function logout() {
    const run = async () => {
      try {
        const stored = await getStored();
        if (stored.status && stored.status.session_id) {
          await apiLogout(stored.status.session_id, stored.licenseKey);
        }
      } catch (e) { /* best-effort */ }
      return { ok: true };
    };
    if (!IS_BACKGROUND) {
      try {
        const r = await sendToBackground({ type: 'pwf-logout' }, 8000);
        if (r) return r;
      } catch (e) { /* fall through to direct */ }
    }
    return await run();
  }

  // Minutely maintenance (session receipts only — no session churn):
  // heartbeat alive -> refresh; dead session -> one re-login;
  // hard rejection -> revoke. Network errors leave the cache alone.
  async function workerMaintainHeartbeat() {
    try {
      const stored = await getStored();
      if (!cachedOk(stored)) return;
      if (!stored.status.session_id) return;
      const hb = await apiHeartbeat(stored.status.session_id, stored.licenseKey);
      if (hb.ok) {
        await touchReceipt(stored);
      } else if (!hb.networkError &&
                 (hb.errorCode === 'SESSION_EXPIRED' || hb.errorCode === 'SESSION_MISMATCH')) {
        await workerLogin(stored.licenseKey).catch(() => {});
      } else if (!hb.networkError) {
        await storageRemove([STORE_STATUS]);
      }
    } catch (e) { /* silent */ }
  }

  // Hourly maintenance: heartbeat sessions, lightweight revalidation for
  // legacy sessionless receipts (never auto-login here -> no churn).
  async function workerMaintain() {
    try {
      const stored = await getStored();
      if (!cachedOk(stored)) return;
      if (stored.status.session_id) {
        await workerMaintainHeartbeat();
        return;
      }
      const fb = await validateDirect(stored.licenseKey);
      if (fb.ok) {
        await saveValid(stored.licenseKey, fb.keyInfo);
      } else if (!fb.networkError) {
        await storageRemove([STORE_STATUS]);
      }
    } catch (e) { /* silent */ }
  }

  async function clearStored() {
    await storageRemove([STORE_KEY, STORE_STATUS]);
  }

  function isFresh(status, maxAgeMs) {
    return !!(
      status &&
      status.valid === true &&
      typeof status.validated_at === 'number' &&
      Date.now() - status.validated_at < maxAgeMs
    );
  }

  /**
   * Cached valid license without network I/O (used by content.js gate).
   * The receipt signature is verified: hand-edited storage is revoked
   * instead of trusted. Returns { licenseKey, status } — status may be stale.
   */
  async function getCachedValid() {
    const stored = await getStored();
    if (stored.licenseKey && stored.status && stored.status.valid === true) {
      if (!verifyReceipt(stored.licenseKey, stored.status)) {
        // Forged or legacy unsigned receipt — revoke the status (key kept
        // so the popup can prefill it for re-activation).
        await storageRemove([STORE_STATUS]);
        return null;
      }
      if (stored.status.expires_at) {
        const t = Date.parse(stored.status.expires_at);
        if (!isNaN(t) && Date.now() > t + 5 * 60 * 1000) {
          return null; // past expiry — popup/worker revalidation reports why
        }
      }
      return stored;
    }
    return null;
  }

  function cachedOk(stored) {
    return !!(
      stored &&
      stored.licenseKey &&
      stored.status &&
      stored.status.valid === true &&
      verifyReceipt(stored.licenseKey, stored.status)
    );
  }

  /**
   * Gate with network revalidation. Runs in the background worker
   * (or direct fallback). Used by the popup and the worker itself.
   * opts.force skips the fresh-cache short-circuit (alarms, popup opens).
   *
   * Session receipts revalidate via heartbeat (authoritative, cheap);
   * a dead session triggers ONE re-login; hard rejections revoke the
   * cached receipt on the spot: the kill-switch. Receipts without a
   * session (legacy / transport-fallback) upgrade via login, with the
   * lightweight check as a transport-failure fallback only.
   */
  async function ensureLicensedDirect(opts) {
    const force = !!(opts && opts.force);
    const stored = await getStored();
    if (!stored.licenseKey) {
      return { allowed: false, reason: 'no-key' };
    }

    const usable = cachedOk(stored);

    if (!force && usable && isFresh(stored.status, ONLINE_RECHECK_MS)) {
      return { allowed: true, licenseKey: stored.licenseKey, status: stored.status, cached: true };
    }

    // --- HWID session path ---
    if (stored.status && stored.status.session_id && usable) {
      const hb = await apiHeartbeat(stored.status.session_id, stored.licenseKey);
      if (hb.ok) {
        const status = await touchReceipt(stored);
        return { allowed: true, licenseKey: stored.licenseKey, status, cached: false, heartbeat: true };
      }
      if (!hb.networkError &&
          (hb.errorCode === 'SESSION_EXPIRED' || hb.errorCode === 'SESSION_MISMATCH')) {
        const lr = await workerLogin(stored.licenseKey);
        if (lr.ok) {
          return { allowed: true, licenseKey: stored.licenseKey, status: lr.status, cached: false, relogin: true };
        }
        if (!lr.transport) {
          await storageRemove([STORE_STATUS]);
          return deniedFrom(lr);
        }
        // Transport failure during re-login -> grace check below.
      } else if (!hb.networkError) {
        // Banned / paused / expired / revoked: revoke locally at once.
        await storageRemove([STORE_STATUS]);
        return deniedFrom(hb);
      }
      if (usable && isFresh(stored.status, OFFLINE_GRACE_MS)) {
        return { allowed: true, licenseKey: stored.licenseKey, status: stored.status, offline: true };
      }
      return deniedFrom(hb);
    }

    // --- Login path (first run, legacy upgrade, untrusted session id) ---
    const lr = await workerLogin(stored.licenseKey);
    if (lr.ok) {
      return { allowed: true, licenseKey: stored.licenseKey, status: lr.status, cached: false };
    }
    if (!lr.transport) {
      await storageRemove([STORE_STATUS]);
      return deniedFrom(lr);
    }

    // Transport failure only: legacy lightweight revalidation so a
    // sessionless receipt keeps working through transient outages.
    const fb = await validateDirect(stored.licenseKey);
    if (fb.ok) {
      const status = await saveValid(stored.licenseKey, fb.keyInfo);
      return { allowed: true, licenseKey: stored.licenseKey, status, cached: false, legacy: true };
    }
    if (fb.networkError && usable && isFresh(stored.status, OFFLINE_GRACE_MS)) {
      return { allowed: true, licenseKey: stored.licenseKey, status: stored.status, offline: true };
    }
    if (!fb.networkError) {
      await storageRemove([STORE_STATUS]);
    }
    return {
      allowed: false,
      reason: fb.networkError ? 'offline' : 'invalid',
      message: fb.message,
      errorCode: fb.errorCode,
      detail: fb.detail
    };
  }

  /**
   * Full gate used before ANY extender logic runs:
   *  1. No stored key            -> { allowed: false, reason: 'no-key' }
   *  2. Fresh signed cache (<24h)-> { allowed: true, cached: true } (no network)
   *  3. Otherwise ask the background worker to revalidate (it also saves).
   *     On network failure with a recent (<7d) signed cache -> allowed offline.
   *     Else -> not allowed (and a hard-invalid key is revoked).
   */
  async function ensureLicensed(opts) {
    const force = !!(opts && opts.force);
    const stored = await getStored();
    if (!stored.licenseKey) {
      return { allowed: false, reason: 'no-key' };
    }

    if (!force && cachedOk(stored) && isFresh(stored.status, ONLINE_RECHECK_MS)) {
      return { allowed: true, licenseKey: stored.licenseKey, status: stored.status, cached: true };
    }

    if (!IS_BACKGROUND) {
      try {
        const res = await sendToBackground({ type: 'pwf-check', force }, 25000);
        if (res && typeof res.allowed === 'boolean') return res;
      } catch (e) {
        // Worker unreachable — fall through to direct check below.
      }
    }

    return await ensureLicensedDirect({ force });
  }

  const api = {
    APP_ID,
    CHECK_URL,
    validateDirect,
    activate,
    activateFlow,
    ensureLicensed,
    ensureLicensedDirect,
    getStored,
    getHwid,
    getCachedValid,
    saveValid,
    clearStored,
    logout,
    isFresh,
    verifyReceipt,
    workerMaintain,
    workerMaintainHeartbeat,
    ONLINE_RECHECK_MS,
    OFFLINE_GRACE_MS,
    // Test hooks (the key itself ships in this file, so exposing it
    // for vector tests grants an attacker nothing new).
    _receiptKey: RECEIPT_KEY,
    _sha256Hex: sha256Hex,
    _hmacSha256Hex: hmacSha256Hex,
    _envelopeEncrypt: envelopeEncrypt,
    _envelopeDecrypt: envelopeDecrypt,
    _apiLogin: apiLogin,
    _apiHeartbeat: apiHeartbeat
  };

  Object.defineProperty(api, 'IS_BACKGROUND', {
    get() { return IS_BACKGROUND; },
    set(v) { IS_BACKGROUND = !!v; },
    enumerable: true
  });

  globalThis.PwfLicense = api;
})();
