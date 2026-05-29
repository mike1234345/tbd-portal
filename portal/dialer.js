// =====================================================
// TBD Marketing Solutions — Portal Dialer (Quo edition)
// v3.6.0: The legacy Telnyx WebRTC dialer was removed. The portal's dialer
// view now points users to the unified Call Command (Quo) experience used
// across the rest of the app. This file keeps the namespace alive so
// dashboard.js can still call window.openDialerWithNumber() without errors.
// =====================================================
(function () {
  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Replace the legacy dialer view body with a short banner pointing users to
  // the new flow. Runs on DOM ready so the UI shows instantly when the view loads.
  function renderRedirectBanner() {
    const view = byId('view-dialer');
    if (!view) return;
    // Look for the legacy dialer layout and swap it out (once)
    const layout = view.querySelector('.dialer-layout');
    if (!layout || layout.dataset.replaced) return;
    layout.dataset.replaced = '1';
    layout.innerHTML = `
      <div class="settings-card" style="max-width:640px;margin:32px auto;padding:32px;text-align:center;">
        <div style="font-size:48px;color:var(--primary,#38bdf8);margin-bottom:12px;">
          <i class="fas fa-phone-volume"></i>
        </div>
        <h2 style="margin:0 0 12px;">Dialer moved to Call Command</h2>
        <p class="muted" style="margin:0 0 20px;font-size:0.95rem;line-height:1.55;">
          The phone dialer is now part of the unified Call Command experience. Click below to
          open it. You can dial leads, take live notes, log dispositions, and review recordings
          \u2014 all from one screen.
        </p>
        <button id="portalDialerOpenCallCommandBtn" class="btn-save" type="button"
                style="padding:14px 28px;font-size:1rem;">
          <i class="fas fa-arrow-right"></i> Open Call Command
        </button>
      </div>
    `;
    const openBtn = byId('portalDialerOpenCallCommandBtn');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        // dashboard.js exposes showView() to switch views inside the portal SPA
        if (typeof window.showView === 'function') {
          window.showView('calls');
        } else {
          window.location.hash = '#calls';
        }
      });
    }
  }

  // Public API kept for backwards compatibility with dashboard.js which calls
  // window.openDialerWithNumber(number, leadId) from various places.
  function openDialerWithNumber(number, leadId) {
    if (typeof window.showView === 'function') window.showView('calls');
    // If the Quo Call Command exposes a populate helper, hand the number off to it.
    if (typeof window.callCommandPrepareNumber === 'function') {
      try { window.callCommandPrepareNumber(number, leadId); } catch (e) { /* non-fatal */ }
    }
  }
  window.openDialerWithNumber = openDialerWithNumber;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderRedirectBanner);
  } else {
    renderRedirectBanner();
  }
  // Also re-render when the view becomes active (handles SPA navigation)
  document.addEventListener('click', (e) => {
    const navItem = e.target.closest('[data-view="dialer"]');
    if (navItem) setTimeout(renderRedirectBanner, 50);
  });
})();
