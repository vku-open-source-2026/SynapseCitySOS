// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// External boot module so the public edge can keep `script-src 'self'`
// without a hash/nonce. It removes the pre-paint splash overlay and registers
// the service worker.
(function () {
  window.addEventListener('load', function () {
    window.setTimeout(function () {
      var splash = document.getElementById('splash-screen');
      if (splash) {
        splash.classList.add('fade-out');
        window.setTimeout(function () {
          splash.remove();
        }, 300);
      }
    }, 500);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js')
      .then(function (registration) {
        console.log('SW registered:', registration.scope);
      })
      .catch(function (error) {
        console.log('SW registration failed:', error);
      });
  }
})();
