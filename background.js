/**
 * Token Tracker — Background Service Worker v0.5.2
 * Polls claude.ai usage API + conversations for source intelligence.
 * 30-day snapshot retention, badge setting, daily summary support.
 * Threshold notifications, API breakage detection, exponential backoff.
 */

const DEFAULT_POLL_MINUTES = 5;
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
  };
}

// ─── Reset time helper ───

function resetTime(r) {
  if (!r) return null;
  const t = typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : new Date(r).getTime();
  const d = t - Date.now();
  if (d <= 0) return '0h 0m';
  return `${Math.floor(d / 36e5)}h ${Math.floor((d % 36e5) / 6e4)}m`;
}

// ─── Threshold notifications ───

async function checkThresholds(usage) {
  const util = usage?.five_hour?.utilization;
  if (util == null) return;
  const pct = util > 1 ? Math.round(util) : Math.round(util * 100);
  const { last_notified_pct = 0, notify_enabled } = await chrome.storage.local.get(['last_notified_pct', 'notify_enabled']);
  if (notify_enabled === false) return;

  const thresholds = [95, 80];
  for (const t of thresholds) {
    if (pct >= t && last_notified_pct < t) {
      const rt = usage.five_hour?.resets_at;
      const resetStr = rt ? resetTime(rt) : '';
      chrome.notifications.create(`tt-threshold-${t}`, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: `Claude usage at ${pct}%`,
        message: t >= 95 ? 'Near limit — save heavy tasks for after reset' :
          resetStr ? `Resets in ${resetStr}` : 'Consider switching to a lighter model'
      });
      await chrome.storage.local.set({ last_notified_pct: pct });
      return;
    }
  }
  if (pct < 50 && last_notified_pct >= 50) {
    await chrome.storage.local.set({ last_notified_pct: 0 });
  }
}

// ─── Usage polling ───

async function tryEndpoint(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (resp.status === 401 || resp.status === 403) {
    await setAuthState(false);
    return { auth: false };
  }
  if (resp.status === 404) return { skip: true };
  if (resp.status === 429) return { rateLimit: true };
  if (!resp.ok) return { skip: true };

  await setAuthState(true);
  let raw;
  try {
    raw = await resp.json();
  } catch (e) {
    console.warn('[TT] JSON parse failed:', e.message);
    return { skip: true };
  }
  const usage = normalizeUsage(raw);
  await storeSnapshot(usage);
  await updateBadge(usage);
  await checkThresholds(usage);
  await chrome.storage.local.set({ working_endpoint: url });
  return { usage };
}

async function pollUsage() {
  const orgId = await getOrgId();
  if (!orgId) return null;

  const endpoints = [
    `https://claude.ai/api/organizations/${orgId}/usage`,
    `https://claude.ai/api/organizations/${orgId}/rate_limits`,
    `https://claude.ai/api/organizations/${orgId}/settings/usage`
  ];

  let authFailure = false;

  // Try cached endpoint first
  try {
    const cached = (await chrome.storage.local.get('working_endpoint')).working_endpoint;
    if (cached && cached.includes(orgId)) {
      const result = await tryEndpoint(cached);
      if (result.usage) {
        await onPollSuccess();
        return result.usage;
      }
      if (result.auth === false) { authFailure = true; }
      if (result.auth === false || result.rateLimit) return null;
    }
  } catch (err) {
    console.warn('[TT] Cached endpoint failed:', err.message);
  }

  for (const url of endpoints) {
    try {
      const result = await tryEndpoint(url);
      if (result.usage) {
        await onPollSuccess();
        return result.usage;
      }
      if (result.auth === false) { authFailure = true; }
      if (result.auth === false || result.rateLimit) return null;
    } catch (err) {
      console.warn('[TT] Poll error:', err.message);
    }
  }

  // All endpoints failed — track failures for breakage detection + backoff
  if (!authFailure) {
    const { poll_failures = 0 } = await chrome.storage.local.get('poll_failures');
    const newFailures = poll_failures + 1;
    const apiStatus = newFailures >= 3 ? 'broken' : 'ok';
    await chrome.storage.local.set({ poll_failures: newFailures, api_status: apiStatus });

    // Exponential backoff: base → base*2 → base*4 → cap at 30
    const { poll_interval_minutes } = await chrome.storage.local.get('poll_interval_minutes');
    const base = poll_interval_minutes || DEFAULT_POLL_MINUTES;
    const backoff = Math.min(base * Math.pow(2, newFailures), 30);
    await chrome.alarms.clear(ALARM_POLL);
    await chrome.alarms.create(ALARM_POLL, { periodInMinutes: backoff });
  }

  return null;
}

async function onPollSuccess() {
  await chrome.storage.local.set({ poll_failures: 0, api_status: 'ok' });
  await setupAlarm();
}

// ─── Snapshot storage ───

function downsampleSnapshots(snapshots) {
  const now = Date.now();
  const H24 = 24 * 60 * 60 * 1000;
  const D7 = 7 * H24;

  const result = [];
  for (const s of snapshots) {
    const age = now - s.timestamp;
    if (age < H24) {
      // < 24h: keep all
      result.push(s);
    } else if (age < D7) {
      // 1-7d: keep 1 per hour
      const hourKey = Math.floor(s.timestamp / (60 * 60 * 1000));
      if (!result._hourSeen) result._hourSeen = new Set();
      if (!result._hourSeen.has(hourKey)) {
        result._hourSeen.add(hourKey);
        result.push(s);
      }
    } else {
      // 7-30d: keep 1 per day
      const dayKey = Math.floor(s.timestamp / H24);
      if (!result._daySeen) result._daySeen = new Set();
      if (!result._daySeen.has(dayKey)) {
        result._daySeen.add(dayKey);
        result.push(s);
      }
    }
  }
  delete result._hourSeen;
  delete result._daySeen;
  return result;
}

function compactSnapshot(usage) {
  const snap = { timestamp: Date.now() };
  const fields = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet',
                  'seven_day_oauth_apps', 'seven_day_cowork', 'extra_usage'];
  for (const f of fields) {
    if (usage[f] != null) snap[f] = usage[f];
  }
  return snap;
}

async function storeSnapshot(usage) {
  const data = await chrome.storage.local.get('snapshots');
  const snapshots = data.snapshots || [];

  snapshots.push(compactSnapshot(usage));

  const cutoff = Date.now() - MAX_SNAPSHOTS_AGE_MS;
  const pruned = downsampleSnapshots(snapshots.filter(s => s.timestamp > cutoff));

  await chrome.storage.local.set({
    snapshots: pruned,
    latest_usage: usage,
    last_poll: Date.now()
  });

  // Flush to disk for CLI companion and snapshot persistence
  flushToDisk(usage);
  flushSnapshotsToDisk(pruned);
}

// ─── HTTP bridge: write usage.json + snapshots.json to disk via local daemon ───

const TT_SERVER = 'http://127.0.0.1:9898/update';
const TT_SNAPSHOTS = 'http://127.0.0.1:9898/snapshots';

function flushToDisk(usage) {
  try {
    const fiveHour = usage.five_hour || {};
    const sevenDay = usage.seven_day || {};
    const opus = usage.seven_day_opus || {};
    const sonnet = usage.seven_day_sonnet || {};
    const cowork = usage.seven_day_cowork || {};

    const payload = {
      version: 1,
      updated_at: Date.now(),
      five_hour: {
        utilization: fiveHour.utilization ?? null,
        resets_at: fiveHour.resets_at ?? null,
        reset_in: resetTime(fiveHour.resets_at)
      },
      seven_day: {
        utilization: sevenDay.utilization ?? null,
        resets_at: sevenDay.resets_at ?? null,
        reset_in: resetTime(sevenDay.resets_at)
      },
      models: {
        opus: { utilization: opus.utilization ?? null, resets_at: opus.resets_at ?? null },
        sonnet: { utilization: sonnet.utilization ?? null, resets_at: sonnet.resets_at ?? null },
        cowork: { utilization: cowork.utilization ?? null, resets_at: cowork.resets_at ?? null }
      },
      extra_usage: usage.extra_usage ?? null
    };

    fetch(TT_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {}); // daemon not running — silently ignore
  } catch {
    // no-op
  }
}

function flushSnapshotsToDisk(snapshots) {
  fetch(TT_SNAPSHOTS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshots)
  }).catch(() => {});
}

async function restoreSnapshotsFromDisk() {
  try {
    const existing = await chrome.storage.local.get('snapshots');
    if (existing.snapshots && existing.snapshots.length > 0) return; // already have data

    const resp = await fetch(TT_SNAPSHOTS);
    if (!resp.ok) return;
    const snapshots = await resp.json();
    if (Array.isArray(snapshots) && snapshots.length > 0) {
      await chrome.storage.local.set({ snapshots });
      console.log(`[TT] Restored ${snapshots.length} snapshots from disk`);
    }
  } catch {
    // daemon not running — silently ignore
  }
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

const messageHandlers = {
  async GET_USAGE() {
    const data = await chrome.storage.local.get(['latest_usage', 'authenticated', 'last_poll', 'api_status']);
    return {
      usage: data.latest_usage || null,
      authenticated: data.authenticated !== false,
      lastPoll: data.last_poll || null,
      apiStatus: data.api_status || 'ok'
    };
  },

  async GET_SNAPSHOTS() {
    const data = await chrome.storage.local.get('snapshots');
    return { snapshots: data.snapshots || [] };
  },

  async REFRESH() {
    const usage = await pollUsage();
    return { usage };
  },

  async SET_POLL_INTERVAL(message) {
    await chrome.storage.local.set({ poll_interval_minutes: message.minutes });
    await setupAlarm();
    return { success: true };
  },

  async GET_SETTINGS() {
    const data = await chrome.storage.local.get(['poll_interval_minutes', 'badge_enabled', 'notify_enabled', 'install_date']);
    return {
      pollInterval: data.poll_interval_minutes || DEFAULT_POLL_MINUTES,
      badgeEnabled: data.badge_enabled !== false,
      notifyEnabled: data.notify_enabled !== false,
      installDate: data.install_date || null
    };
  },

  async SET_BADGE_SETTING(message) {
    await chrome.storage.local.set({ badge_enabled: message.enabled });
    return { success: true };
  },

  async SET_NOTIFY_SETTING(message) {
    await chrome.storage.local.set({ notify_enabled: message.enabled });
    return { success: true };
  },

  async DEBUG_API() {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'No org ID' };

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
    return results;
  },

  async EXPORT_FOR_CLI() {
    const data = await chrome.storage.local.get('latest_usage');
    if (data.latest_usage) flushToDisk(data.latest_usage);
    return { success: true };
  },

  async GET_DAILY_SUMMARY() {
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
    return { peaks };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message.action];
  if (!handler) return;

  (async () => {
    try {
      const result = await handler(message);
      sendResponse(result);
    } catch (err) {
      console.error('[TT] Handler error:', message.action, err);
      sendResponse({ error: err.message });
    }
  })();
  return true;
});

// ─── Init ───

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Token Tracker] v0.5.2');
  // Store install date only on first install
  const { install_date } = await chrome.storage.local.get('install_date');
  if (!install_date) {
    await chrome.storage.local.set({ install_date: Date.now() });
  }
  await chrome.action.setBadgeText({ text: '—' });
  await chrome.action.setBadgeBackgroundColor({ color: '#64748B' });
  await restoreSnapshotsFromDisk();
  await setupAlarm();
  await pollUsage();
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreSnapshotsFromDisk();
  await setupAlarm();
  await pollUsage();
});
