/**
 * Token Tracker — Content Badge v0.5.0
 * Floating usage badge on claude.ai with shadow DOM isolation.
 */

(function () {
  'use strict';

  const host = document.createElement('div');
  host.id = 'tt-badge-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .tt-badge {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 99999;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      cursor: default;
      user-select: none;
      box-shadow: 0 1px 4px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06);
      transition: opacity 0.3s, transform 0.3s;
    }
    .tt-badge--hidden { display: none; }
    .tt-badge--green  { background: #eaf3de; color: #3b6d11; }
    .tt-badge--amber  { background: #faeeda; color: #854f0b; }
    .tt-badge--coral  { background: #faece7; color: #993c1d; }
    .tt-badge--pulse  { animation: tt-pulse 1.5s ease-in-out infinite; }
    @keyframes tt-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    .tt-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    @media (prefers-color-scheme: dark) {
      .tt-badge--green { background: #1e2e12; color: #7ab648; }
      .tt-badge--amber { background: #2e2410; color: #d4a53a; }
      .tt-badge--coral { background: #2e1c14; color: #d46b4a; }
    }
  `;
  shadow.appendChild(style);

  const badge = document.createElement('div');
  badge.className = 'tt-badge tt-badge--hidden';
  badge.innerHTML = '<div class="tt-dot"></div><span class="tt-pct"></span>';
  shadow.appendChild(badge);

  document.body.appendChild(host);

  function update(usage, enabled) {
    if (!enabled || !usage || usage.pct == null) {
      badge.classList.add('tt-badge--hidden');
      return;
    }
    badge.classList.remove('tt-badge--hidden');
    const pct = typeof usage.pct === 'number' ? usage.pct : 0;
    badge.querySelector('.tt-pct').textContent = pct + '%';
    badge.title = 'Token usage: ' + pct + '%';

    badge.classList.remove('tt-badge--green', 'tt-badge--amber', 'tt-badge--coral', 'tt-badge--pulse');
    if (pct > 75) {
      badge.classList.add('tt-badge--coral');
    } else if (pct > 50) {
      badge.classList.add('tt-badge--amber');
    } else {
      badge.classList.add('tt-badge--green');
    }
    if (pct > 90) {
      badge.classList.add('tt-badge--pulse');
    }
  }

  // Load initial data
  chrome.storage.local.get(['latest_usage', 'badge_enabled'], (result) => {
    const usage = result.latest_usage;
    const enabled = result.badge_enabled !== false;
    if (usage) {
      const util = usage.five_hour?.utilization;
      const pct = util == null ? 0 : util > 1 ? Math.round(util) : Math.round(util * 100);
      update({ pct }, enabled);
    }
  });

  // Listen for changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.latest_usage || changes.badge_enabled) {
      chrome.storage.local.get(['latest_usage', 'badge_enabled'], (result) => {
        const usage = result.latest_usage;
        const enabled = result.badge_enabled !== false;
        if (usage) {
          const util = usage.five_hour?.utilization;
          const pct = util == null ? 0 : util > 1 ? Math.round(util) : Math.round(util * 100);
          update({ pct }, enabled);
        } else {
          update(null, enabled);
        }
      });
    }
  });
})();
