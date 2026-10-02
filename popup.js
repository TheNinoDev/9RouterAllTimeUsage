/* Popup controller: license gate runs BEFORE anything else. */
(function () {
  'use strict';

  const licenseView = document.getElementById('licenseView');
  const mainView = document.getElementById('mainView');
  const licenseInput = document.getElementById('licenseInput');
  const licenseError = document.getElementById('licenseError');
  const activateBtn = document.getElementById('activateBtn');
  const buyBtn = document.getElementById('buyBtn');
  const openBtn = document.getElementById('openBtn');
  const deactivateBtn = document.getElementById('deactivateBtn');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const licenseStatusLine = document.getElementById('licenseStatusLine');

  function showError(msg, detail) {
    licenseError.textContent = detail ? msg + ' (' + detail + ')' : msg;
    licenseError.style.display = 'block';
  }

  function hideError() {
    licenseError.textContent = '';
    licenseError.style.display = 'none';
  }

  function setLocked() {
    licenseView.classList.remove('hidden');
    mainView.classList.add('hidden');
    statusIndicator.classList.add('locked');
    statusDot.classList.add('locked');
    statusText.textContent = 'Locked';
  }

  function describeLicense(status, licenseKey) {
    if (!status) return 'Valid';
    const parts = [];
    if (status.expires_at) {
      try {
        const d = new Date(status.expires_at);
        parts.push('expires ' + d.toLocaleDateString());
      } catch (e) {
        parts.push('expires ' + status.expires_at);
      }
      if (typeof status.days_remaining === 'number') {
        parts.push(status.days_remaining + 'd left');
      }
    } else {
      parts.push('lifetime');
    }
    if (status.offline) parts.push('offline');
    void licenseKey;
    return 'Valid' + (parts.length ? ' · ' + parts.join(' · ') : '');
  }

  function setUnlocked(licenseKey, status) {
    licenseView.classList.add('hidden');
    mainView.classList.remove('hidden');
    statusIndicator.classList.remove('locked');
    statusDot.classList.remove('locked');
    statusText.textContent = 'Active';
    licenseStatusLine.textContent = describeLicense(status, licenseKey);
    try {
      const deviceLine = document.getElementById('deviceLine');
      if (deviceLine) {
        deviceLine.textContent =
          (status && status.hwid) ? 'this device ' + String(status.hwid).slice(0, 8) + '…' : 'this device';
        deviceLine.title = (status && status.hwid)
          ? 'HWID bound to this key: ' + status.hwid
          : 'No device binding yet — it completes on the next online check.';
      }
    } catch (e) {}
  }

  async function refresh() {
    hideError();
    activateBtn.disabled = true;
    activateBtn.textContent = 'Checking…';
    try {
      // Forced: opening the popup is an enforcement point (ban/expiry
      // takes effect here immediately, not after cache expiry).
      const check = await PwfLicense.ensureLicensed({ force: true });
      if (check && check.allowed) {
        setUnlocked(check.licenseKey, check.status);
      } else {
        setLocked();
        // Pre-fill stored key so the user can see/correct it.
        try {
          const stored = await PwfLicense.getStored();
          if (stored && stored.licenseKey && !licenseInput.value) {
            licenseInput.value = stored.licenseKey;
          }
        } catch (e) {}
        if (check && check.message) showError(check.message, check.detail);
      }
    } catch (e) {
      setLocked();
      showError('License check failed. Try again.');
    } finally {
      activateBtn.disabled = false;
      activateBtn.textContent = 'Activate license';
    }
  }

  async function onActivate() {
    hideError();
    const key = licenseInput.value;
    if (!key || !key.trim()) {
      showError('Please enter a license key.');
      return;
    }
    activateBtn.disabled = true;
    activateBtn.textContent = 'Verifying…';
    try {
      const result = await PwfLicense.activate(key);
      if (result.ok) {
        const stored = await PwfLicense.getStored();
        setUnlocked(stored.licenseKey, stored.status);
      } else {
        showError(result.message || 'Invalid license key.', result.detail);
      }
    } catch (e) {
      showError('Activation failed. Check your connection and try again.');
    } finally {
      activateBtn.disabled = false;
      activateBtn.textContent = 'Activate license';
    }
  }

  activateBtn.addEventListener('click', onActivate);
  buyBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://nakano-ninodev.vercel.app' });
  });
  licenseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onActivate();
  });

  openBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'http://localhost:20128/dashboard/usage' });
  });

  deactivateBtn.addEventListener('click', async () => {
    try {
      // Best-effort server-side session close; local wipe happens regardless.
      await PwfLicense.logout();
    } catch (e) {}
    await PwfLicense.clearStored();
    licenseInput.value = '';
    setLocked();
  });

  refresh();
})();
