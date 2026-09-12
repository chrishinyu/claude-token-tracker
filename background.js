/**
 * Token Tracker — Background Service Worker v0.5.2
 * Polls claude.ai usage API + conversations for source intelligence.
 * 30-day snapshot retention, badge setting, daily summary support.
 * Threshold notifications, API breakage detection, exponential backoff.
 */

const DEFAULT_POLL_MINUTES = 5;
const ALARM_POLL = 'usage_poll';
const ALARM_KEEPALIVE = 'keepalive';
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
  // Unwrap common top-level wrappers
  const inner = raw.usage || raw.data || raw.rate_limits || raw.limits || raw.quotas || raw;

  // Collect all candidate objects to search (handles arbitrary nesting)
  const candidates = [raw, inner];
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) candidates.push(v);
  }
  if (inner !== raw) {
    for (const key of Object.keys(inner)) {
      const v = inner[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) candidates.push(v);
    }
  }

  function fixUtil(bucket) {
    if (!bucket || bucket.utilization == null) return bucket;
    const copy = { ...bucket };
    // >= 1.5 so that 1.0 (100% used) is never mistaken for an integer percentage
    if (copy.utilization >= 1.5) copy.utilization = copy.utilization / 100;
    copy.utilization = Math.min(Math.max(copy.utilization, 0), 1);
    return copy;
  }

  function findBucket(obj, ...keys) {
    for (const k of keys) {
      if (obj[k] != null) return fixUtil(obj[k]);
    }
    return null;
  }

  function findInAll(...keys) {
    for (const obj of candidates) {
      const result = findBucket(obj, ...keys);
      if (result) return result;
    }
    return null;
  }

  // Log raw response once for debugging format changes. This doubles as the
  // live test for whether the API returns per-model quota buckets at all —
  // check this log (chrome://extensions → Token Tracker → service worker
  // console) for any key naming a model (opus/sonnet/haiku). As of
  // 2026-09-08 no such key has ever been observed; the per-model guesses
  // that used to live below (seven_day_opus/sonnet/oauth_apps/cowork) never
  // matched anything in 305 stored snapshots and were removed rather than
  // keep shipping a UI built on values that are always null. If this log
  // ever shows a real per-model key, that's the point to re-add it.
  const rawKeys = Object.keys(raw);
  const innerKeys = inner !== raw ? Object.keys(inner) : null;
  console.log('[TT] Raw API keys:', JSON.stringify(rawKeys),
    innerKeys ? 'inner keys: ' + JSON.stringify(innerKeys) : '');

  return {
    five_hour:   findInAll('five_hour', 'fiveHour', '5h', 'five_hours', 'five_hour_window', 'fiveHourWindow'),
    seven_day:   findInAll('seven_day', 'sevenDay', '7d', 'seven_days', 'seven_day_window', 'sevenDayWindow'),
    extra_usage: findInAll('extra_usage', 'extraUsage'),
    // Diagnostic only — not a display field. Flushed to disk so the D3
    // question ("does the API expose per-model quota under any key name?")
    // can be checked with `grep`/`jq` instead of Chrome devtools. Safe to
    // ignore downstream; strip before it ever reaches the popup.
    _debug_raw_keys: innerKeys ? [...new Set([...rawKeys, ...innerKeys])] : rawKeys,
    // Values, not just key names — a key can exist and still be null/a
    // feature flag/unrelated. Capture anything that looks model- or
    // breakdown-shaped so D3 can be settled from one file read.
    _debug_candidate_values: (() => {
      const suspects = {};
      const nameLooksRelevant = k => /opus|sonnet|haiku|model|breakdown|cowork|oauth/i.test(k);
      for (const k of rawKeys) if (nameLooksRelevant(k)) suspects['raw.' + k] = raw[k];
      if (innerKeys) for (const k of innerKeys) if (nameLooksRelevant(k)) suspects['inner.' + k] = inner[k];
      return suspects;
    })(),
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
  const pct = Math.min(Math.round(util * 100), 100);
  const { last_notified_pct = 0, notify_enabled } = await chrome.storage.local.get(['last_notified_pct', 'notify_enabled']);
  if (notify_enabled === false) return;

  const thresholds = [95, 80];
  for (const t of thresholds) {
    if (pct >= t && last_notified_pct < t) {
      const rt = usage.five_hour?.resets_at;
      const resetStr = rt ? resetTime(rt) : '';
      chrome.notifications.create(`tt-threshold-${t}`, {
        type: 'basic', iconUrl: 'assets/icons/icon128.png',
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

  // Skip if normalization found nothing (API format may have changed)
  const hasData = usage.five_hour?.utilization != null || usage.seven_day?.utilization != null;
  if (!hasData) {
    console.warn('[TT] Normalized to all-null from', url, '— raw keys:', Object.keys(raw));
    return { skip: true };
  }

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
    `https://claude.ai/api/organizations/${orgId}/settings/usage`,
    `https://claude.ai/api/organizations/${orgId}/quota`,
    `https://claude.ai/api/organizations/${orgId}/rate_limit_status`
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
      // Cached endpoint returned skip (format changed?) — clear it and try all
      await chrome.storage.local.remove('working_endpoint');
    }
  } catch (err) {
    console.warn('[TT] Cached endpoint failed:', err.message);
    await chrome.storage.local.remove('working_endpoint');
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
  const fields = ['five_hour', 'seven_day', 'extra_usage'];
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

    // No `models` block: the API has never returned per-model quota (see
    // the comment above normalizeUsage's return). Don't ship a field whose
    // consumers will treat presence-of-key as presence-of-data.
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
      extra_usage: usage.extra_usage ?? null,
      // Diagnostic for the open D3 question — see normalizeUsage(). Not a
      // display field; the popup and CLI ignore it.
      _debug_raw_keys: usage._debug_raw_keys ?? null,
      _debug_candidate_values: usage._debug_candidate_values ?? null
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
  const pct = Math.min(Math.round(util * 100), 100);
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
  // Keepalive just wakes the worker — no action needed
});

// Keepalive: wake the service worker every 25s so it never goes idle
chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 });

// ─── Message handler ───

const messageHandlers = {
  async PING() {
    return { pong: true };
  },

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
      `https://claude.ai/api/organizations/${orgId}/settings/usage`,
      `https://claude.ai/api/organizations/${orgId}/quota`,
      `https://claude.ai/api/organizations/${orgId}/rate_limit_status`
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
      const pct = Math.min(Math.round(u * 100), 100);
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
