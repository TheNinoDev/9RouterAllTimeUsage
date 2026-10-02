(function () {
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

  if (document.head || document.readyState !== 'loading') {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject, { once: true });
    setTimeout(() => {
      if (!document.querySelector('script[src*="injected.js"]')) inject();
    }, 1000);
  }
})();
