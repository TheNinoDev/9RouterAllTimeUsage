(function () {
  'use strict';

  // Idempotent install guard (manifest previously injected this file twice).
  if (window.__nineRouterExtenderInstalled) return;
  window.__nineRouterExtenderInstalled = true;

  console.log('[9Router All-Time Extender] Injected main world script initialized.');

  function isUsagePage() {
    try {
      return window.location.pathname.includes('/dashboard/usage');
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------
  // 1. FETCH + XHR INTERCEPTOR
  // ---------------------------------------------------------
  function rewriteUsageUrl(urlStr) {
    if (typeof urlStr !== 'string') return urlStr;
    let out = urlStr;
    // FIX: original /period=(all|alltime)/ matched "all" inside "alltime",
    // producing "period=60dtime". Match longest alternative first + word boundary.
    if (out.includes('/api/usage/chart') && /[?&]period=(alltime|all)\b/.test(out)) {
      out = out.replace(/([?&])period=(alltime|all)\b/g, '$1period=60d');
      console.log('[9Router Extender] Redirected chart API to period=60d:', out);
    }
    if (out.includes('/api/usage/stats') && /[?&]period=alltime\b/.test(out)) {
      out = out.replace(/([?&])period=alltime\b/g, '$1period=all');
      console.log('[9Router Extender] Normalized stats API to period=all:', out);
    }
    return out;
  }

  if (window.fetch && !window.fetch._extenderPatched) {
    const originalFetch = window.fetch.bind(window);
    async function patchedFetch(input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          const rewritten = rewriteUsageUrl(input.toString());
          if (rewritten !== input.toString()) input = rewritten;
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          const rewritten = rewriteUsageUrl(input.url);
          if (rewritten !== input.url) {
            input = new Request(rewritten, input);
          }
        }
      } catch (e) {
        console.warn('[9Router Extender] fetch rewrite failed, passing through:', e);
      }
      return originalFetch(input, init);
    }
    patchedFetch._extenderPatched = true;
    window.fetch = patchedFetch;
  }

  // Cover code paths that still use XHR.
  if (window.XMLHttpRequest && !window.XMLHttpRequest.prototype.open._extenderPatched) {
    const originalOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (typeof url === 'string') {
          const rewritten = rewriteUsageUrl(url);
          if (rewritten !== url) {
            arguments[1] = rewritten;
            url = rewritten;
          }
        }
      } catch (e) {
        console.warn('[9Router Extender] XHR rewrite failed:', e);
      }
      return originalOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.open._extenderPatched = true;
  }

  // ---------------------------------------------------------
  // 2. WEBPACK CHUNK INTERCEPTOR (Native React Options Patch)
  // ---------------------------------------------------------
  const patchedFns = new WeakSet();

  function safeRebuild(patched) {
    // Wrap in parens so function declarations, arrows, and async fns all parse.
    // Returns null instead of throwing so a failed patch never breaks the page.
    try {
      const rebuilt = (0, eval)('(' + patched + ')');
      if (typeof rebuilt === 'function') return rebuilt;
    } catch (e) {
      console.warn('[9Router Extender] eval rebuild failed:', e);
    }
    return null;
  }

  function patchModuleFunction(fn) {
    if (typeof fn !== 'function' || patchedFns.has(fn)) return fn;
    let fnStr;
    try {
      fnStr = Function.prototype.toString.call(fn);
    } catch (e) {
      return fn;
    }
    let patched = fnStr;

    // A) Patch options arrays in usage modules.
    if (
      (patched.includes('value:"60d"') || patched.includes('label:"60D"')) &&
      !patched.includes('value:"all"')
    ) {
      const next = patched.replace(
        /\{value:"60d",label:"60D"\}|\{value:"60d",label:"60d"\}/g,
        '{value:"60d",label:"60D"},{value:"all",label:"All Time"}'
      );
      if (next !== patched) {
        patched = next;
      } else {
        patched = patched.replace(
          /label:"60D"\}\s*\]|label:"60d"\}\s*\]/g,
          'label:"60D"},{value:"all",label:"All Time"}]'
        );
      }
    }

    // B) Patch SegmentedControl module to auto-inject All Time option.
    // Tightly scoped: require the options-param shape AND a control marker AND
    // the exact anchor we splice before. Never touch modules missing the anchor
    // (original code injected into any module containing the generic "let o={").
    if (
      (patched.includes('options:e=[]') || patched.includes('options:e')) &&
      (patched.includes('bg-surface-2') || patched.includes('t===e.value')) &&
      !patched.includes('value:"all"') &&
      patched.includes('let o={')
    ) {
      const injectCode =
        'if(Array.isArray(e)&&e.some(function(x){return x&&x.value==="60d";})&&!e.some(function(x){return x&&x.value==="all";})){e=e.slice();e.push({value:"all",label:"All Time"});}';
      patched = patched.replace('let o={', injectCode + 'let o={');
    }

    if (patched !== fnStr) {
      const rebuilt = safeRebuild(patched);
      if (rebuilt) {
        patchedFns.add(rebuilt);
        console.log('[9Router Extender] Successfully patched Webpack module natively for All Time!');
        // Preserve static props Next/React may attach to the module fn.
        try {
          Object.assign(rebuilt, fn);
        } catch (e) { /* ignore */ }
        return rebuilt;
      }
    }

    return fn;
  }

  function patchChunkArray(arr) {
    if (!arr || arr._extenderPatched) return;
    arr._extenderPatched = true;

    const originalPush = arr.push;
    arr.push = function (chunkData) {
      try {
        if (chunkData && chunkData[1]) {
          const modules = chunkData[1];
          for (const modId in modules) {
            modules[modId] = patchModuleFunction(modules[modId]);
          }
        }
      } catch (e) {
        console.warn('[9Router Extender] chunk push patch failed:', e);
      }
      return originalPush.apply(this, arguments);
    };

    // Patch chunks that already executed before this script ran.
    try {
      for (const item of arr) {
        if (item && item[1]) {
          const modules = item[1];
          for (const modId in modules) {
            modules[modId] = patchModuleFunction(modules[modId]);
          }
        }
      }
    } catch (e) {
      console.warn('[9Router Extender] existing-chunk patch failed:', e);
    }
  }

  // Hook every webpack chunk array, not just webpackChunk_N_E.
  // Next.js chunk global names vary; the page may expose them on self instead of window.
  function hookAllChunkArrays() {
    const roots = new Set();
    if (typeof window !== 'undefined') roots.add(window);
    if (typeof self !== 'undefined' && self !== window) roots.add(self);
    for (const root of roots) {
      let keys = [];
      try {
        keys = Object.keys(root);
      } catch (e) {
        continue;
      }
      for (const key of keys) {
        if (!key.startsWith('webpackChunk')) continue;
        const arr = root[key];
        if (!Array.isArray(arr)) continue;
        patchChunkArray(arr);
        // Re-patch if the framework replaces the whole array object later.
        try {
          let current = arr;
          Object.defineProperty(root, key, {
            configurable: true,
            enumerable: true,
            get() {
              return current;
            },
            set(val) {
              current = val;
              patchChunkArray(current);
            }
          });
        } catch (e) {
          // Property non-configurable (frozen by framework) — push hook above still applies.
        }
      }
    }
  }

  hookAllChunkArrays();

  // ---------------------------------------------------------
  // 3. DOM FALLBACK & REACT FIBER SYNCHRONIZER
  // ---------------------------------------------------------
  const FALLBACK_ACTIVE_CLASS =
    'shrink-0 px-4 h-7 text-xs rounded-[8px] font-medium transition-all bg-surface text-text-main shadow-sm';
  const FALLBACK_INACTIVE_CLASS =
    'shrink-0 px-4 h-7 text-xs rounded-[8px] font-medium transition-all text-text-muted hover:text-text-main';

  const PERIOD_LABELS = ['Today', '24h', '7D', '30D', '60D', 'All Time'];

  function getReactFiber(dom) {
    if (!dom) return null;
    for (const key in dom) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return dom[key];
      }
    }
    return null;
  }

  function triggerReactOnChange(dom, newValue) {
    let fiber = getReactFiber(dom);
    let depth = 0;
    while (fiber && depth < 25) {
      for (const propsKey of ['memoizedProps', 'pendingProps']) {
        const props = fiber[propsKey];
        if (props && typeof props.onChange === 'function') {
          try {
            props.onChange(newValue);
            return true;
          } catch (e) {
            console.warn('[9Router Extender] onChange error:', e);
          }
        }
      }
      fiber = fiber.return;
      depth++;
    }
    return false;
  }

  function findPeriodContainer() {
    const buttons = Array.from(document.querySelectorAll('button'));
    const periodButtons = buttons.filter((b) => PERIOD_LABELS.includes((b.textContent || '').trim()));
    if (periodButtons.length === 0) return null;
    return { container: periodButtons[0].parentElement, periodButtons };
  }

  function syncFallbackVisual(fallbackBtn, container) {
    // Optimistically mark fallback active; clear siblings using their real classes.
    const siblings = Array.from(container.querySelectorAll('button')).filter((b) => b !== fallbackBtn);
    const activeSample = siblings.find((b) => b.className.includes('bg-surface') && b.className.includes('shadow-sm'));
    const activeClass = activeSample ? activeSample.className : FALLBACK_ACTIVE_CLASS;
    for (const sib of siblings) {
      // Re-derive inactive look from the fallback's known-good inactive class
      // if the sibling currently carries the active style.
      if (sib.className === activeClass) sib.className = FALLBACK_INACTIVE_CLASS;
    }
    fallbackBtn.className = activeClass;
  }

  function enhancePeriodSelector() {
    if (!isUsagePage()) return;
    try {
      const found = findPeriodContainer();
      if (!found) return;
      const { container } = found;
      if (!container) return;

      const allTimeBtns = Array.from(container.querySelectorAll('button')).filter(
        (b) => (b.textContent || '').trim() === 'All Time'
      );
      const hasNativeAllTime = allTimeBtns.some((b) => !b.hasAttribute('data-fallback-injected'));

      if (hasNativeAllTime) {
        for (const b of allTimeBtns) {
          if (b.hasAttribute('data-fallback-injected')) b.remove();
        }
      } else if (allTimeBtns.length === 0) {
        const fallbackBtn = document.createElement('button');
        fallbackBtn.setAttribute('data-period', 'all');
        fallbackBtn.setAttribute('data-fallback-injected', 'true');
        fallbackBtn.setAttribute('type', 'button');
        fallbackBtn.textContent = 'All Time';
        fallbackBtn.className = FALLBACK_INACTIVE_CLASS;
        container.appendChild(fallbackBtn);

        fallbackBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Re-query at click time: the closure's periodButtons go stale after React re-renders.
          const live = findPeriodContainer();
          const targets = live ? live.periodButtons.concat([fallbackBtn]) : [fallbackBtn];
          let success = false;
          for (const target of targets) {
            if (triggerReactOnChange(target, 'all')) {
              success = true;
              break;
            }
          }
          // Also walk up from the container itself (SegmentedControl often owns onChange).
          if (!success) {
            let node = container;
            for (let i = 0; i < 5 && node && !success; i++) {
              success = triggerReactOnChange(node, 'all');
              node = node.parentElement;
            }
          }
          if (success) {
            syncFallbackVisual(fallbackBtn, container);
          } else {
            console.warn('[9Router Extender] Could not reach React onChange for period=all.');
          }
        });
      }

      // Generic layout fix: don't assume Tailwind grid-cols-5.
      if (container.classList.contains('grid-cols-5')) {
        container.classList.remove('grid-cols-5');
        container.classList.add('grid-cols-6');
      } else if (!container.style.flexWrap) {
        const display = window.getComputedStyle(container).display;
        if (display.includes('flex')) container.style.flexWrap = 'wrap';
      }
    } catch (e) {
      console.error('[9Router Extender] Error in enhancePeriodSelector:', e);
    }
  }

  // Debounced observer replaces the per-mutation sync call + 1s polling combo.
  let rafQueued = false;
  const observer = new MutationObserver(() => {
    if (!isUsagePage() || rafQueued) return;
    rafQueued = true;
    const run = () => {
      rafQueued = false;
      enhancePeriodSelector();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 100);
  });

  function startObserver() {
    if (!document.body) return false;
    observer.observe(document.body, { childList: true, subtree: true });
    enhancePeriodSelector();
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      hookAllChunkArrays();
      if (!startObserver()) setTimeout(startObserver, 500);
    });
  } else {
    startObserver();
  }

  // Light fallback poll for SPA navigations that don't mutate body (2s, paused when hidden).
  setInterval(() => {
    if (document.hidden || !isUsagePage()) return;
    hookAllChunkArrays();
    enhancePeriodSelector();
  }, 2000);
})();
