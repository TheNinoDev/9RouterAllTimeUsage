(function () {
  'use strict';

  const openBtn = document.getElementById('openBtn');

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'http://localhost:20128/dashboard/usage' });
    });
  }
})();
