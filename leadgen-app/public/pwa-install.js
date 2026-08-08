// Registers the service worker and shows a bottom-center install prompt
// when the app isn't installed yet. Shared by both index.html and
// login.html so this logic exists in exactly one place.
(function () {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("Service worker registration failed:", err);
      });
    });
  }

  const banner = document.getElementById("installBanner");
  if (!banner) return; // page doesn't have the banner markup, nothing to do

  const textEl = document.getElementById("installBannerText");
  const actionBtn = document.getElementById("installBannerActionBtn");
  const dismissBtn = document.getElementById("installBannerDismissBtn");

  const DISMISS_KEY = "prospect-install-banner-dismissed-at";
  const DISMISS_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // re-offer after a week, not never again

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function wasDismissedRecently() {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    return Date.now() - Number(raw) < DISMISS_SNOOZE_MS;
  }

  function hideBanner() {
    banner.style.display = "none";
  }

  function dismissBanner() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    hideBanner();
  }

  dismissBtn?.addEventListener("click", dismissBanner);

  if (isStandalone() || wasDismissedRecently()) {
    return; // already installed, or user dismissed recently - don't nag
  }

  // Chrome/Edge/Android: a real, programmatic install prompt is available.
  let deferredInstallEvent = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallEvent = e;
    banner.style.display = "flex";
  });

  actionBtn?.addEventListener("click", async () => {
    if (deferredInstallEvent) {
      deferredInstallEvent.prompt();
      const choice = await deferredInstallEvent.userChoice;
      deferredInstallEvent = null;
      if (choice.outcome === "accepted") hideBanner();
      else dismissBanner();
      return;
    }
    // iOS Safari (and any other browser without beforeinstallprompt) has no
    // programmatic install trigger - the button becomes a "how to" instead.
    textEl.textContent = 'On iPhone/iPad: tap the Share icon, then "Add to Home Screen".';
    actionBtn.style.display = "none";
  });

  // iOS Safari never fires beforeinstallprompt at all - detect it directly
  // and show the manual-instructions version of the banner proactively,
  // rather than waiting for an event that will never come.
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && !isStandalone()) {
    textEl.textContent = 'Install Xeven Leads: tap the Share icon, then "Add to Home Screen".';
    actionBtn.style.display = "none";
    banner.style.display = "flex";
  }
})();
