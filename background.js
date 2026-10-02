/* PWF license background worker (Manifest V3 service worker).
 *
 * Does ALL pwfauth.com network calls for the extension:
 *  - service-worker fetches are not subject to page CSP, and
 *  - host_permissions ("https://pwfauth.com/*") + the declarativeNetRequest
 *    Origin/Referer rule let them pass the server's CSRF validation.
 *  - WebCrypto (AES-CBC/HMAC envelope, HWID sessions) is only used here,
 *    where SubtleCrypto is guaranteed available.
 *
 * Messages:
 *  { type: 'pwf-activate', licenseKey } -> HWID login (saves session receipt)
 *  { type: 'pwf-check', force }         -> ensureLicensedDirect() gate result
 *  { type: 'pwf-logout' }               -> best-effort session close
 *
 * Kill-switch: a minutely heartbeat keeps the session alive and revokes it
 * the moment the server reports banned / paused / expired; an hourly pass
 * also revalidates legacy sessionless receipts. Offline errors never wipe.
 */
'use strict';

importScripts('pwf-license.js');
PwfLicense.IS_BACKGROUND = true;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('pwf-') !== 0) {
    return false;
  }

  (async () => {
    try {
      if (msg.type === 'pwf-activate') {
        sendResponse(await PwfLicense.activateFlow(msg.licenseKey));
      } else if (msg.type === 'pwf-check') {
        sendResponse(await PwfLicense.ensureLicensedDirect({ force: !!msg.force }));
      } else if (msg.type === 'pwf-logout') {
        sendResponse(await PwfLicense.logout());
      } else {
        sendResponse({ ok: false, allowed: false, message: 'Unknown license request.' });
      }
    } catch (e) {
      sendResponse({
        ok: false,
        allowed: false,
        message: 'License worker failed. Try again.',
        detail: (e && (e.name + ': ' + e.message)) || 'worker error'
      });
    }
  })();

  return true; // async sendResponse
});

// Best-effort session refresh on browser start / install.
async function opportunisticRefresh() {
  try {
    await PwfLicense.workerMaintain();
  } catch (e) { /* silent */ }
}

try {
  chrome.runtime.onStartup.addListener(opportunisticRefresh);
  chrome.runtime.onInstalled.addListener(opportunisticRefresh);
  if (chrome.alarms) {
    const arm = () => {
      try {
        chrome.alarms.create('pwf-heartbeat', { periodInMinutes: 1 });
        chrome.alarms.create('pwf-recheck', { periodInMinutes: 60 });
      } catch (e) { /* alarms unavailable */ }
    };
    chrome.runtime.onStartup.addListener(arm);
    chrome.runtime.onInstalled.addListener(arm);
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm) return;
      if (alarm.name === 'pwf-heartbeat') {
        PwfLicense.workerMaintainHeartbeat().catch(() => {});
      } else if (alarm.name === 'pwf-recheck') {
        PwfLicense.workerMaintain().catch(() => {});
      }
    });
    arm();
  }
} catch (e) { /* listeners optional */ }
