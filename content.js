(function () {
  // License UI lives ONLY in the extension popup. This content script never
  // shows UI and never touches the network — it silently gates on the cached
  // license (written by the popup via the background worker) and injects
  // nothing until a valid cached license exists.
  //
  // NOTE: pwf-license.js runs before this file (see manifest.json) and
  // exposes globalThis.PwfLicense (storage helpers only on this path).
  let injected = false;

  function inject() {
    if (injected) return;
    if (document.documentElement.hasAttribute('data-nine-router-extender-injected')) {
      injected = true;
      return;
    }
    document.documentElement.setAttribute('data-nine-router-extender-injected', 'true');
    injected = true;

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.async = false;
    script.onload = function () {
      this.remove();
    };
    script.onerror = function () {
      console.error('[9Router Extender] Failed to load injected.js');
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
    console.log('[9Router Extender] Content script injected main world script.');
  }

  function scheduleInject() {
    if (document.head || document.readyState !== 'loading') {
      inject();
    } else {
      document.addEventListener('DOMContentLoaded', inject, { once: true });
      // Fallback: don't wait forever if DOMContentLoaded is delayed.
      setTimeout(() => {
        if (!document.querySelector('script[src*="injected.js"]')) inject();
      }, 1000);
    }
  }

  // ---------------------------------------------------------
  // License gate: NOTHING (no injection, no patching) runs until
  // a valid cached license exists. Activate via extension popup.
  // ---------------------------------------------------------
  async function boot() {
    try {
      const api = globalThis.PwfLicense;
      if (!api || typeof api.getCachedValid !== 'function') {
        console.warn('[9Router Extender] License module missing — blocking.');
        return;
      }

      const cached = await api.getCachedValid();
      if (cached && api.isFresh(cached.status, api.OFFLINE_GRACE_MS)) {
        scheduleInject();
      } else {
        console.warn('[9Router Extender] Locked — open the extension popup and enter a license key.');
      }
    } catch (e) {
      console.warn('[9Router Extender] License check failed, blocking:', e);
    }
  }

  // If the user activates via the popup while this tab is open,
  // start working immediately without requiring a reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes.pwf_license_key && !changes.pwf_license_status) return;
      if (injected) return;
      boot().catch(() => {});
    });
  } catch (e) { /* storage listener optional */ }

  boot();
})();
