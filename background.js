/**
 * Token Tracker — Background Service Worker v0.5.0
 * Polls claude.ai usage API + conversations for source intelligence.
 * 30-day snapshot retention, badge setting, daily summary support.
 */

const DEFAULT_POLL_MINUTES = 2;
const ALARM_POLL = 'usage_poll';
const MAX_SNAPSHOTS_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Org discovery ───

async function discoverOrgId() {
  try {
    const resp = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include'
    });
    if (resp.status === 401 || resp.status === 403) {
      await setAuthState(false);
      return null;
    }
    if (!resp.ok) return null;

    const orgs = await resp.json();
    if (!Array.isArray(orgs) || orgs.length === 0) return null;

    const orgId = orgs[0].uuid || orgs[0].id;
    if (orgId) {
      await chrome.storage.local.set({ org_id: orgId });
      await setAuthState(true);
    }
    return orgId;
  } catch (err) {
    console.warn('[TT] Org discovery failed:', err.message);
    return null;
  }
}

async function getOrgId() {
  const data = await chrome.storage.local.get('org_id');
  return data.org_id || await discoverOrgId();
}

// ─── Auth state ───

async function setAuthState(authenticated) {
  await chrome.storage.local.set({ authenticated });
  if (!authenticated) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#64748B' });
  }
}

// ─── Normalize usage response ───

function normalizeUsage(raw) {
  const inner = raw.usage || raw.data || raw;

  function fixUtil(bucket) {
    if (!bucket || bucket.utilization == null) return bucket;
    const copy = { ...bucket };
    if (copy.utilization > 1) copy.utilization = copy.utilization / 100;
    return copy;
  }

  function findBucket(obj, ...keys) {
    for (const k of keys) {
      if (obj[k] != null) return fixUtil(obj[k]);
    }
    return null;
  }

  // Always scan both raw and inner for all possible key names
  function findInBoth(...keys) {
    return findBucket(raw, ...keys) || findBucket(inner, ...keys);
  }

  return {
    five_hour:            findInBoth('five_hour', 'fiveHour', '5h', 'five_hours'),
    seven_day:            findInBoth('seven_day', 'sevenDay', '7d', 'seven_days'),
    seven_day_opus:       findInBoth('seven_day_opus', 'sevenDayOpus', '7d_opus', 'opus'),
    seven_day_sonnet:     findInBoth('seven_day_sonnet', 'sevenDaySonnet', '7d_sonnet', 'sonnet'),
    seven_day_oauth_apps: findInBoth('seven_day_oauth_apps', 'sevenDayOauthApps', '7d_oauth', 'oauth_apps'),
    seven_day_cowork:     findInBoth('seven_day_cowork', 'sevenDayCowork', '7d_cowork', 'cowork', 'claude_code', 'code'),
    extra_usage:          raw.extra_usage || raw.extraUsage || inner.extra_usage || inner.extraUsage || null,
    _raw: raw
  };
}

// ─── Usage polling ───

async function pollUsage() {
  const orgId = await getOrgId();
  if (!orgId) return null;

  const endpoints = [
    `https://claude.ai/api/organizations/${orgId}/usage`,
    `https://claude.ai/api/organizations/${orgId}/rate_limits`,
    `https://claude.ai/api/organizations/${orgId}/settings/usage`
  ];

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { credentials: 'include' });

      if (resp.status === 401 || resp.status === 403) {
        await setAuthState(false);
        return null;
      }
      if (resp.status === 404) continue;
      if (resp.status === 429) return null;
      if (!resp.ok) continue;

      await setAuthState(true);
      const raw = await resp.json();
      const usage = normalizeUsage(raw);

      await storeSnapshot(usage);
      await updateBadge(usage);
      return usage;
    } catch (err) {
      console.warn('[TT] Poll error:', err.message);
    }
  }
  return null;
}

// ─── Snapshot storage ───

async function storeSnapshot(usage) {
  const data = await chrome.storage.local.get('snapshots');
  const snapshots = data.snapshots || [];

  snapshots.push({
    timestamp: Date.now(),
    five_hour:            usage.five_hour || null,
    seven_day:            usage.seven_day || null,
    seven_day_opus:       usage.seven_day_opus || null,
    seven_day_sonnet:     usage.seven_day_sonnet || null,
    seven_day_oauth_apps: usage.seven_day_oauth_apps || null,
    seven_day_cowork:     usage.seven_day_cowork || null,
    extra_usage:          usage.extra_usage || null
  });

  const cutoff = Date.now() - MAX_SNAPSHOTS_AGE_MS;
  const pruned = snapshots.filter(s => s.timestamp > cutoff);

  await chrome.storage.local.set({
    snapshots: pruned,
    latest_usage: usage,
    last_poll: Date.now()
  });
}

// ─── Badge ───

async function updateBadge(usage) {
  const util = usage?.five_hour?.utilization;
  if (util == null) {
    await chrome.action.setBadgeText({ text: '?' });
    await chrome.action.setBadgeBackgroundColor({ color: '#64748B' });
    return;
  }
  const pct = util > 1 ? Math.round(util) : Math.round(util * 100);
  const text = pct >= 100 ? '!' : `${pct}%`;
  const color = pct >= 90 ? '#A32D2D' : pct >= 70 ? '#BA7517' : '#3B6D11';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Alarm-based polling ───

async function setupAlarm() {
  const data = await chrome.storage.local.get('poll_interval_minutes');
  const minutes = data.poll_interval_minutes || DEFAULT_POLL_MINUTES;
  await chrome.alarms.clear(ALARM_POLL);
  await chrome.alarms.create(ALARM_POLL, { periodInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_POLL) {
    await pollUsage();
  }
});

// ─── Message handler ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_USAGE') {
    (async () => {
      const data = await chrome.storage.local.get(['latest_usage', 'authenticated', 'last_poll']);
      sendResponse({
        usage: data.latest_usage || null,
        authenticated: data.authenticated !== false,
        lastPoll: data.last_poll || null
      });
    })();
    return true;
  }

  if (message.action === 'GET_SNAPSHOTS') {
    (async () => {
      const data = await chrome.storage.local.get('snapshots');
      sendResponse({ snapshots: data.snapshots || [] });
    })();
    return true;
  }

  if (message.action === 'REFRESH') {
    pollUsage().then(usage => sendResponse({ usage }));
    return true;
  }

  if (message.action === 'SET_POLL_INTERVAL') {
    (async () => {
      await chrome.storage.local.set({ poll_interval_minutes: message.minutes });
      await setupAlarm();
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.action === 'GET_SETTINGS') {
    (async () => {
      const data = await chrome.storage.local.get(['poll_interval_minutes', 'badge_enabled']);
      sendResponse({
        pollInterval: data.poll_interval_minutes || DEFAULT_POLL_MINUTES,
        badgeEnabled: data.badge_enabled !== false
      });
    })();
    return true;
  }

  if (message.action === 'SET_BADGE_SETTING') {
    (async () => {
      await chrome.storage.local.set({ badge_enabled: message.enabled });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.action === 'DEBUG_API') {
    (async () => {
      const orgId = await getOrgId();
      if (!orgId) { sendResponse({ error: 'No org ID' }); return; }

      const endpoints = [
        `https://claude.ai/api/organizations/${orgId}/usage`,
        `https://claude.ai/api/organizations/${orgId}/rate_limits`,
        `https://claude.ai/api/organizations/${orgId}/settings/usage`
      ];

      const results = {};
      for (const url of endpoints) {
        try {
          const resp = await fetch(url, { credentials: 'include' });
          const key = url.split('/').pop();
          if (resp.ok) {
            results[key] = await resp.json();
          } else {
            results[key] = { _status: resp.status, _statusText: resp.statusText };
          }
        } catch (err) {
          const key = url.split('/').pop();
          results[key] = { _error: err.message };
        }
      }
      sendResponse(results);
    })();
    return true;
  }

  if (message.action === 'GET_DAILY_SUMMARY') {
    (async () => {
      const data = await chrome.storage.local.get('snapshots');
      const snapshots = data.snapshots || [];
      const peaks = {};
      for (const s of snapshots) {
        const day = new Date(s.timestamp).toISOString().slice(0, 10);
        const u = s.five_hour?.utilization;
        if (u == null) continue;
        const pct = u > 1 ? u : Math.round(u * 100);
        peaks[day] = Math.max(peaks[day] || 0, pct);
      }
      sendResponse({ peaks });
    })();
    return true;
  }
});

// ─── Init ───

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Token Tracker] v0.5.0');
  await chrome.action.setBadgeText({ text: '—' });
  await chrome.action.setBadgeBackgroundColor({ color: '#64748B' });
  await setupAlarm();
  await pollUsage();
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarm();
  await pollUsage();
});
