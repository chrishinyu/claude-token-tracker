/**
 * Claude Token Tracker — Popup v0.5.2
 * Enhanced weekly trend · Apple-style microinteractions · Predictive time-to-limit
 */

// ─── Helpers ───

const $ = id => document.getElementById(id);

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function normUtil(v) { return v == null ? 0 : Math.min(v >= 1.5 ? v / 100 : v, 1); }

// The one definition of the state ramp. Ruled 2026-09-20: green 0-59
// "Plenty left", amber 60-69 "Getting tight", red 70+ "Near limit". Both
// the 5-hour hero and the 7-day foot figure read through this, so the
// colour means the same thing everywhere it appears — a green number is
// always "fine", never "this one is selected".
function stateFor(pct) { return pct >= 70 ? 'bad' : pct >= 60 ? 'warn' : 'ok'; }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function resetTime(r) {
  if (!r) return null;
  const t = typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : new Date(r).getTime();
  const d = t - Date.now();
  if (d <= 0) return '0h 0m';
  return `${Math.floor(d / 36e5)}h ${Math.floor((d % 36e5) / 6e4)}m`;
}

function dayLabel(s) {
  return new Date(s + 'T12:00:00').toLocaleDateString([], { weekday: 'short' }).slice(0, 2).toUpperCase();
}

function dayName(s) {
  return new Date(s + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
}

function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 6e4) return "now";
  if (d < 36e5) return Math.floor(d / 6e4) + "m ago";
  if (d < 864e5) return Math.floor(d / 36e5) + "h ago";
  return Math.floor(d / 864e5) + "d ago";
}

// "updated" line: "now" has no "ago"; everything else already carries it.
function updatedLabel(ts) {
  if (!ts) return "";
  const r = relTime(ts);
  return r === "now" ? "updated just now" : "updated " + r;
}

function severityColor(pct) {
  if (pct >= 75) return 'var(--danger)';
  if (pct >= 50) return 'var(--warning)';
  return 'var(--success)';
}

function severityClass(pct) {
  if (pct >= 75) return 'danger';
  if (pct >= 50) return 'amber';
  return 'green';
}

function localDateStr(d) {
  const dt = d || new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return localDateStr(new Date());
}

// Check reduced motion preference
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Animation helpers ───

// The popup no longer has an entrance sequence — sections are visible on paint
// (it opens dozens of times a day; a staggered load makes every open feel
// slower). Kept as a harmless no-op so the call sites don't need touching.
function staggerReveal() {}

// Counts an element's text from its CURRENT value to `to`, eased to match
// --ease-out (cubic-bezier(0.16,1,0.3,1) — no native JS equivalent,
// easeOutCubic is a close stand-in) over the same window as the bar-fill's
// own CSS transition, so the number and the bar read as one animated fact
// rather than a static number next to a moving bar.
//
// Counting from the current value, not from 0, is the whole point: the bar
// is a CSS transition, which always interpolates from wherever it already
// is. A count that restarted at 0 on every refresh diverged visibly from a
// bar that barely moved (verified in Chrome: mid-refresh the number read
// 53% next to a bar sitting at 73%). Same rule as the bar now — on first
// open the current value is 0 so the intro still counts all the way up; on
// a refresh that didn't move the needle, neither of them moves, which is
// the honest signal.
function animateCount(el, to, ms = 200) {
  const from = parseInt(el.textContent, 10) || 0;
  if (prefersReducedMotion || from === to) { el.textContent = `${to}%`; return; }
  cancelAnimationFrame(el._countRaf);
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / ms, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${Math.round(from + (to - from) * eased)}%`;
    if (t < 1) el._countRaf = requestAnimationFrame(tick);
  }
  el._countRaf = requestAnimationFrame(tick);
}

// Point-estimate "time to limit" prediction removed 2026-09-10: it fit a line
// through as few as 2 snapshots in a bursty signal — a confident number with
// no basis. A rate signal, if it returns, has to gate on sample count and
// show a range, never a single time. See the design-review notes.

// ─── State ───
let selectedDay = null;
let allSnapshots = [];
let latestUsage = null;
let isRefreshing = false;
let installDate = null;

// ─── Main render ───

async function render(isRefresh) {
  try {
    if (isRefresh) {
      isRefreshing = true;
      document.body.classList.add('refreshing');
    }

    const [usageRes, snapRes, settRes] = await Promise.all([
      sendMsg({ action: 'GET_USAGE' }),
      sendMsg({ action: 'GET_SNAPSHOTS' }),
      sendMsg({ action: 'GET_SETTINGS' })
    ]);

    if (!usageRes) throw new Error('Service worker not responding');

    const { usage, authenticated, lastPoll, apiStatus } = usageRes;
    allSnapshots = snapRes.snapshots || [];
    latestUsage = usage;
    installDate = settRes.installDate || null;

    $('pollFoot').textContent = '';
    $('meterUpdated').textContent = updatedLabel(lastPoll);
    $('pollSelect').value = String(settRes.pollInterval || 5);
    $('badgeToggle').checked = settRes.badgeEnabled !== false;
    $('notifyToggle').checked = settRes.notifyEnabled !== false;

    // Auth gate
    if (!authenticated) {
      $('authState').hidden = false;
      $('apiBroken').hidden = true;
      $('mainContent').hidden = true;
      return;
    }
    $('authState').hidden = true;

    // API broken gate
    if (apiStatus === 'broken' && !usage) {
      $('apiBroken').hidden = false;
      $('mainContent').hidden = true;
      return;
    }
    $('apiBroken').hidden = true;
    $('mainContent').hidden = false;

    if (!usage) {
      $('emptyState').hidden = false;
      $('meterTile').hidden = true;
      $('extraSection').hidden = true;
      renderWeeklyTrend(allSnapshots, usage);
      staggerReveal();
      return;
    }

    $('emptyState').hidden = true;
    $('meterTile').hidden = false;

    // ── Meter ── (see the 3-zone comment in popup.html)
    // READ: number (state-coloured) + "used · <verdict>" caption + the bar,
    // which shares the number.s colour so they agree. DECISION: countdown +
    // near-limit advisory. CONTEXT: window/weekly/freshness, pushed down.
    const f5 = usage.five_hour;
    const frac = normUtil(f5?.utilization);
    const pct = Math.min(Math.round(frac * 100), 100);
    const st = stateFor(pct);
    const verdict = st === 'bad' ? 'Near limit' : st === 'warn' ? 'Getting tight' : 'Plenty left';

    const mv = $('meterVal');
    mv.className = `meter-val ${st}`;
    // Counts up 0→pct in step with the bar's own fill transition (same
    // 200ms/ease-out) rather than snapping to text — the two are reading
    // the same fact and should move as one, not one animating while the
    // other just appears.
    animateCount(mv, pct);

    $("meterVerdict").textContent = verdict;

    // Update ARIA on meter bar
    const barTrack = $('barTrack');
    if (barTrack) barTrack.setAttribute('aria-valuenow', pct);

    // Animated bar — FILLS with % used, colored by state.
    // No reset-to-0-then-refill: setting scaleX(0) and back two frames later
    // just made Chrome reverse the in-flight transition, so the bar never
    // actually returned to zero — it only ever crawled by the delta while
    // the number restarted from 0 beside it. Let the transition run from
    // wherever the bar is, which on first render is 0 anyway.
    const bf = $('barFill');
    bf.style.backgroundColor = st === 'bad' ? 'var(--danger)' : st === 'warn' ? 'var(--warning)' : 'var(--success)';
    bf.style.transform = `scaleX(${pct / 100})`;

    const rt = resetTime(f5?.resets_at);
    $('meterCountdown').textContent = rt ? `resets in ${rt}` : '';

    // Foot: 5-hour window label + weekly usage, both in "% used".
    $('statUsed').textContent = '5-hour window';
    // 7-day figure carries the same colour coding as the hero, through the
    // same stateFor() — but only the number is coloured, and it stays at the
    // foot's 11px. The CONTEXT zone keeps its quiet weight; what changes is
    // that the colour now means the same thing in both places.
    const u7 = usage.seven_day?.utilization;
    const pct7 = u7 != null ? Math.min(Math.round(normUtil(u7) * 100), 100) : null;
    const sl = $('statLeft');
    if (pct7 != null) {
      sl.innerHTML = `7d <span class="stat-pct ${stateFor(pct7)}">${pct7}%</span> used`;
    } else {
      sl.textContent = '';
    }

    // Advisory — plain text, no card. The one piece of real advice, and it
    // only applies near the limit.
    const advisory = $('meterAdvisory');
    if (st === 'bad') {
      advisory.hidden = false;
      advisory.textContent = 'Save heavy tasks for after reset';
    } else {
      advisory.hidden = true;
      advisory.textContent = '';
    }

    // Single accessible status update per render.
    const sr = $('meterStatusSr');
    if (sr) sr.textContent = `${pct}% of the 5-hour window used, ${verdict}${rt ? `, resets in ${rt}` : ''}`;

    renderExtra(usage.extra_usage);
    renderWeeklyTrend(allSnapshots, usage);

    // Stagger reveal all sections
    staggerReveal();

  } catch (err) {
    console.error('[TT]', err);
    throw err;
  } finally {
    if (isRefresh) {
      isRefreshing = false;
      document.body.classList.remove('refreshing');
    }
  }
}

// Smart-actions card block removed 2026-09-09: after round 1 deleted its
// content (the "switch model" claims had no source), the surviving cards
// were inert <div>s that still carried pointer-cursor/hover/press styling —
// a false affordance, flagged in a /conductor design review. The one real
// piece of advice (save heavy work near the limit) is now a plain-text line
// in the meter tile (`.meter-advisory`, no card, no fake interactivity), and
// the verdict word ("Plenty left"/"Getting tight"/"Near limit") carries the
// rest of what these cards were trying to say. See Planning/backlog.md.

// ─── Extra Credits ───

function renderExtra(extra) {
  const container = $('extraContent');
  container.innerHTML = '';

  if (!(extra && extra.is_enabled)) {
    $('extraSection').hidden = true;
    return;
  }

  $('extraSection').hidden = false;
  const used = extra.used_credits ?? 0;
  const limit = extra.monthly_limit ?? 0;
  const spendPct = limit > 0 ? Math.min(Math.round((used / limit) * 100), 100) : 0;

  container.innerHTML = `
    <div class="extra-active">
      <div class="extra-active-header">
        <span class="extra-active-label">Extra usage credits</span>
        <span class="extra-active-amount">$${used.toFixed(2)}</span>
      </div>
      <div class="extra-active-bar">
        <div class="extra-active-fill animate" style="transform:scaleX(${spendPct / 100})"></div>
      </div>
      <div class="extra-active-foot">${limit > 0 ? `$${limit.toFixed(2)} monthly limit` : 'No limit set'}</div>
    </div>`;
}

// ─── Enhanced Weekly Trend ───

function renderWeeklyTrend(snapshots, usage, skipAnim) {
  const barsEl = $('sparkBars');
  const daysEl = $('sparkDays');
  const statsEl = $('trendStats');
  const insightEl = $('trendInsight');
  barsEl.innerHTML = '';
  daysEl.innerHTML = '';

  const today = todayStr();

  // Build 7 days ending at today (local time), today always rightmost
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(localDateStr(d));
  }

  // Collect real peaks from snapshots using LOCAL date
  const realPeaks = {};
  for (const s of snapshots) {
    const day = localDateStr(new Date(s.timestamp));
    const u = normUtil(s.five_hour?.utilization);
    realPeaks[day] = Math.max(realPeaks[day] || 0, u);
  }

  const fiveHourUtil = usage?.five_hour ? normUtil(usage.five_hour.utilization) : 0;

  const dayData = days.map((day) => {
    const isToday = day === today;
    const realUtil = realPeaks[day] || 0;

    if (realUtil > 0) {
      return { day, util: realUtil, pct: Math.round(realUtil * 100), noData: false };
    }

    // Today: use current 5h reading if no snapshot yet
    if (isToday && fiveHourUtil > 0) {
      return { day, util: fiveHourUtil, pct: Math.round(fiveHourUtil * 100), noData: false };
    }

    // No data for this day
    return { day, util: 0, pct: 0, noData: true };
  });

  const maxUtil = Math.max(...dayData.filter(d => !d.noData).map(d => d.util), 0.01);

  dayData.forEach((d, i) => {
    const isToday = d.day === today;
    const isSel = selectedDay === d.day;

    const bar = document.createElement('div');

    if (d.noData) {
      bar.className = `spark-bar no-data${isToday ? ' today' : ''}${isSel ? ' selected' : ''}`;
      bar.title = `${d.day}: no data`;
    } else {
      const h = Math.max(Math.round((d.util / maxUtil) * 100), d.util > 0 ? 6 : 2);
      bar.className = `spark-bar${isToday ? ' today' : ''}${isSel ? ' selected' : ''}`;
      bar.style.height = `${h}%`;
      bar.style.backgroundColor = severityColor(d.pct);
      bar.style.opacity = isToday ? '1' : '0.55';
      bar.title = `${d.day}: ${d.pct}%`;
    }

    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-label', `${dayName(d.day)} ${d.noData ? 'no data' : d.pct + '%'}`);

    if (!prefersReducedMotion && !skipAnim && !d.noData) {
      bar.classList.add('rise');
      bar.style.animationDelay = `${i * 70}ms`;
    }

    const toggleDay = () => {
      selectedDay = selectedDay === d.day ? null : d.day;
      renderWeeklyTrend(allSnapshots, latestUsage, true);
    };
    bar.addEventListener('click', toggleDay);
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(); }
    });
    barsEl.appendChild(bar);

    const lbl = document.createElement('span');
    lbl.textContent = dayLabel(d.day);
    // Two independent facts, so classList.add — plain className assignment
    // meant a day that was both today AND selected silently lost `today`.
    if (isToday) lbl.classList.add('today');
    if (isSel) lbl.classList.add('selected');
    daysEl.appendChild(lbl);
  });

  // Set sparkline ARIA summary
  const sparkContainer = barsEl.parentElement;
  const summaryParts = dayData.filter(d => d.pct > 0).map(d => `${dayName(d.day)} ${d.pct}%`);
  if (sparkContainer) sparkContainer.setAttribute('aria-label', 'Weekly trend: ' + (summaryParts.length ? summaryParts.join(', ') : 'no data'));

  // Stats row
  const realUsage = dayData.filter(d => d.pct > 0 && !d.noData);
  const avgPct = realUsage.length > 0
    ? Math.round(realUsage.reduce((s, d) => s + d.pct, 0) / realUsage.length)
    : 0;
  const heaviest = realUsage.length > 0
    ? realUsage.reduce((a, b) => a.pct > b.pct ? a : b)
    : null;

  let statsHtml = '';

  if (realUsage.length <= 1) {
    if (installDate) {
      const installDateStr = new Date(installDate).toLocaleDateString([], { month: 'short', day: 'numeric' });
      statsHtml = `<span><span class="label">Tracking since ${escapeHtml(installDateStr)}</span></span>`;
    } else {
      statsHtml = `<span><span class="label">Collecting data. Bars fill as polls accumulate.</span></span>`;
    }
  } else {
    statsHtml = `<span><span class="label">Avg: </span><span class="val">${avgPct}%</span></span>`;
    if (heaviest) {
      statsHtml += `<span><span class="label">Peak: </span><span class="val ${severityClass(heaviest.pct)}">${dayName(heaviest.day)} ${heaviest.pct}%</span></span>`;
    }
  }
  statsEl.innerHTML = statsHtml;

  // Pattern insight
  if (realUsage.length >= 3) {
    const weekdays = dayData.filter(d => d.pct > 0 && !d.noData && {1:1,2:1,3:1,4:1,5:1}[new Date(d.day + 'T12:00:00').getDay()]);
    const weekends = dayData.filter(d => d.pct > 0 && !d.noData && {0:1,6:1}[new Date(d.day + 'T12:00:00').getDay()]);
    const avgWd = weekdays.length ? weekdays.reduce((s, d) => s + d.pct, 0) / weekdays.length : 0;
    const avgWe = weekends.length ? weekends.reduce((s, d) => s + d.pct, 0) / weekends.length : 0;

    if (heaviest) {
      if (avgWd > avgWe * 2 && weekends.length > 0) {
        insightEl.textContent = `Usage peaks on weekdays. Heaviest: ${dayName(heaviest.day)} at ${heaviest.pct}%`;
      } else {
        insightEl.textContent = `Heaviest on ${dayName(heaviest.day)}: ${heaviest.pct}% peak`;
      }
      insightEl.hidden = false;
    } else {
      insightEl.hidden = true;
    }
  } else {
    insightEl.hidden = true;
  }

  // Day detail
  const detailEl = $('dayDetail');
  if (!selectedDay) { detailEl.innerHTML = ''; return; }
  renderDayDetail(selectedDay, snapshots);
}

function renderDayDetail(day, snapshots) {
  const detailEl = $('dayDetail');
  const daySnaps = snapshots.filter(s => localDateStr(new Date(s.timestamp)) === day);

  const dateStr = new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  if (daySnaps.length === 0) {
    detailEl.innerHTML = `
      <div class="day-detail">
        <div class="day-detail-header">
          <span class="day-detail-date">${escapeHtml(dateStr)}</span>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);padding:var(--sp-2) 0" class="state-body">No data for this day</div>
      </div>`;
    return;
  }

  const hourly = new Array(24).fill(0);
  for (const s of daySnaps) {
    const hr = new Date(s.timestamp).getHours();
    hourly[hr] = Math.max(hourly[hr], normUtil(s.five_hour?.utilization));
  }

  const peak = Math.max(...hourly, 0.01);
  const peakPct = Math.round(peak * 100);

  let html = `
    <div class="day-detail">
      <div class="day-detail-header">
        <span class="day-detail-date">${escapeHtml(dateStr)}</span>
        <span class="day-detail-peak">peak ${peakPct}%</span>
      </div>
      <div class="hourly-bars">`;

  for (let h = 0; h < 24; h++) {
    const val = hourly[h];
    const ht = Math.max(Math.round((val / peak) * 100), val > 0 ? 4 : 1);
    const barClass = val > 0 ? ' active' : '';
    const riseClass = !prefersReducedMotion ? ' rise' : '';
    const delayStyle = !prefersReducedMotion ? `animation-delay:${h * 20}ms;` : '';
    html += `<div class="hourly-bar${barClass}${riseClass}" style="height:${ht}%;${delayStyle}" title="${h}:00 · ${Math.round(val * 100)}%"></div>`;
  }

  html += `</div>
      <div class="hourly-labels">
        <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
      </div>
    </div>`;

  detailEl.innerHTML = html;
}

// ─── CSV Export ───

function exportCsv() {
  const peaks = {};
  for (const s of allSnapshots) {
    const day = localDateStr(new Date(s.timestamp));
    const u5 = normUtil(s.five_hour?.utilization);
    const u7 = normUtil(s.seven_day?.utilization);
    if (!peaks[day]) peaks[day] = { peak_5h: 0, peak_7d: 0 };
    peaks[day].peak_5h = Math.max(peaks[day].peak_5h, Math.round(u5 * 100));
    peaks[day].peak_7d = Math.max(peaks[day].peak_7d, Math.round(u7 * 100));
  }

  const sortedDays = Object.keys(peaks).sort();
  const rows = ['date,peak_5h,peak_7d'];
  for (const day of sortedDays) {
    rows.push(`${day},${peaks[day].peak_5h},${peaks[day].peak_7d}`);
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `token-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Events ───

$('btnSettings').addEventListener('click', () => {
  const p = $('settingsPanel');
  p.hidden = !p.hidden;
  const open = !p.hidden;
  $('btnSettings').classList.toggle('active', open);
  $('btnSettings').setAttribute('aria-expanded', String(open));
});

$('pollSelect').addEventListener('change', e => {
  sendMsg({ action: 'SET_POLL_INTERVAL', minutes: parseInt(e.target.value, 10) });
});

$('badgeToggle').addEventListener('change', e => {
  sendMsg({ action: 'SET_BADGE_SETTING', enabled: e.target.checked });
});

$('notifyToggle').addEventListener('change', e => {
  sendMsg({ action: 'SET_NOTIFY_SETTING', enabled: e.target.checked });
});

// Two tiers of refresh feedback, two classes:
//   .refreshing    — header spin + meter shimmer + content dim. Goes on
//                    immediately on click, every time, fast or slow. This
//                    is the cheap always-on acknowledgment ("your click
//                    registered").
//   .loading-mode  — the full-screen blink-eye overlay. NOT immediate: a
//                    delayed-reveal pattern (same logic as GitHub/Stripe's
//                    ~300ms spinner threshold), so a normal fast refresh
//                    (the common case, checked dozens of times a day)
//                    never pays a ceremony tax. Only a refresh that's
//                    genuinely still running past OVERLAY_DELAY_MS earns
//                    the takeover — and once it does, it plays one full,
//                    uncut 2s cycle (open→close→open, holds on the open
//                    frame via fill:forwards) before the reveal, so a
//                    blink that started never gets cut off mid-close by
//                    data arriving a beat later.
const OVERLAY_DELAY_MS = 180;   // don't show the overlay for anything faster than this
const BLINK_DURATION_MS = 2200; // eyeOpen/eyeClosed's own 2s + a small settle buffer

$('btnRefresh').addEventListener('click', async () => {
  // `.refreshing` goes on BEFORE the REFRESH message — that network
  // round-trip is the actual slow part; render()'s own add() used to fire
  // after it had already finished, so the class was only ever true for the
  // few ms of the local-storage reads inside render(), and nothing ever
  // visibly showed. render(false) here means this handler is the sole
  // owner of both classes now. `disabled` guards against double-fire —
  // each click is a fresh, deliberate request, so there's no separate
  // replay-cooldown beyond that.
  const b = $('btnRefresh');
  if (b.disabled) return;
  b.disabled = true;
  document.body.classList.add('refreshing');

  let overlayShownAt = 0;
  const overlayTimer = setTimeout(() => {
    overlayShownAt = Date.now();
    document.body.classList.add('loading-mode');
  }, OVERLAY_DELAY_MS);

  try {
    await sendMsg({ action: 'REFRESH' });
    clearTimeout(overlayTimer);
    if (overlayShownAt) {
      // The overlay actually appeared — let its blink finish the cycle
      // it's already mid-way through rather than yanking it away early.
      const remaining = BLINK_DURATION_MS - (Date.now() - overlayShownAt);
      if (remaining > 0) await wait(remaining);
      // Remove the class AND populate the data in the same breath: the
      // iris-reveal mask starts opening right as render() kicks off the
      // bar-fill transition and number count-up, so the user watches the
      // numbers actually grow into place as the popup uncovers — not a
      // reveal of numbers that finished animating, unseen, under an
      // opaque overlay a moment earlier.
      document.body.classList.remove('loading-mode');
      await render(false);
    } else {
      // Fast path: the overlay never appeared, nothing to sync the reveal
      // against — just populate immediately.
      await render(false);
    }
  } finally {
    clearTimeout(overlayTimer);
    document.body.classList.remove('refreshing', 'loading-mode');
    b.disabled = false;
  }
});

$('btnExport').addEventListener('click', (e) => {
  e.stopPropagation();
  exportCsv();
});

$('btnDebug').addEventListener('click', async () => {
  const out = $('debugOutput');
  out.hidden = false;
  out.textContent = 'Fetching...';
  try {
    const res = await sendMsg({ action: 'DEBUG_API' });
    const usageRes = await sendMsg({ action: 'GET_USAGE' });
    const snapRes = await sendMsg({ action: 'GET_SNAPSHOTS' });
    const snaps = snapRes.snapshots || [];
    // Show snapshot date distribution
    const snapDates = {};
    for (const s of snaps) {
      const d = localDateStr(new Date(s.timestamp));
      snapDates[d] = (snapDates[d] || 0) + 1;
    }
    const debug = {
      _snapshot_count: snaps.length,
      _snapshot_dates: snapDates,
      _today_local: todayStr(),
      _normalized_usage: usageRes.usage,
      _raw_api_responses: res
    };
    out.textContent = JSON.stringify(debug, null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
});

// ─── Service worker message with wake + retry ───

async function wakeWorker() {
  try {
    await Promise.race([
      chrome.runtime.sendMessage({ action: 'PING' }),
      new Promise(r => setTimeout(r, 500))
    ]);
  } catch { /* worker starting up */ }
}

async function sendMsg(msg, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await Promise.race([
        chrome.runtime.sendMessage(msg),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
      ]);
      if (res !== undefined) return res;
    } catch (e) {
      if (i === retries) throw e;
    }
    await wakeWorker();
  }
  return null;
}

// ─── Fallback: read directly from chrome.storage.local if worker is dead ───

async function renderFromStorage() {
  try {
    const data = await chrome.storage.local.get([
      'latest_usage', 'authenticated', 'last_poll', 'api_status',
      'snapshots', 'poll_interval_minutes', 'badge_enabled',
      'notify_enabled', 'install_date'
    ]);

    if (!data.latest_usage && data.authenticated === undefined) return false;

    const usageRes = {
      usage: data.latest_usage || null,
      authenticated: data.authenticated !== false,
      lastPoll: data.last_poll || null,
      apiStatus: data.api_status || 'ok'
    };
    const snapRes = { snapshots: data.snapshots || [] };
    const settRes = {
      pollInterval: data.poll_interval_minutes || 5,
      badgeEnabled: data.badge_enabled !== false,
      notifyEnabled: data.notify_enabled !== false,
      installDate: data.install_date || null
    };

    const { usage, authenticated, lastPoll, apiStatus } = usageRes;
    allSnapshots = snapRes.snapshots || [];
    latestUsage = usage;
    installDate = settRes.installDate || null;

    $('meterUpdated').textContent = updatedLabel(lastPoll);
    $('pollFoot').textContent = lastPoll ? 'showing cached data' : '';
    $('pollSelect').value = String(settRes.pollInterval || 5);
    $('badgeToggle').checked = settRes.badgeEnabled !== false;
    $('notifyToggle').checked = settRes.notifyEnabled !== false;

    if (!authenticated) {
      $('authState').hidden = false;
      $('mainContent').hidden = true;
      return true;
    }
    $('authState').hidden = true;
    $('mainContent').hidden = false;

    if (!usage) {
      $('emptyState').hidden = false;
      $('meterTile').hidden = true;
      return true;
    }

    $('emptyState').hidden = true;
    $('meterTile').hidden = false;

    const f5 = usage.five_hour;
    const frac = normUtil(f5?.utilization);
    const pct = Math.min(Math.round(frac * 100), 100);
    const st = stateFor(pct);

    const verdict = st === 'bad' ? 'Near limit' : st === 'warn' ? 'Getting tight' : 'Plenty left';
    { const mvd = $("meterVerdict"); if (mvd) mvd.textContent = verdict; }
    const advisory = $('meterAdvisory');
    if (advisory) {
      advisory.hidden = st !== 'bad';
      advisory.textContent = st === 'bad' ? 'Save heavy tasks for after reset' : '';
    }

    const mv = $('meterVal');
    if (mv) { mv.className = `meter-val ${st}`; mv.textContent = `${pct}%`; }
    const bf = $('barFill');
    bf.style.transform = `scaleX(${pct / 100})`;
    bf.style.backgroundColor = st === 'bad' ? 'var(--danger)' : st === 'warn' ? 'var(--warning)' : 'var(--success)';

    $('meterCountdown').textContent = '';
    $('statUsed').textContent = '5-hour window';
    // 7-day figure carries the same colour coding as the hero, through the
    // same stateFor() — but only the number is coloured, and it stays at the
    // foot's 11px. The CONTEXT zone keeps its quiet weight; what changes is
    // that the colour now means the same thing in both places.
    const u7 = usage.seven_day?.utilization;
    const pct7 = u7 != null ? Math.min(Math.round(normUtil(u7) * 100), 100) : null;
    const sl = $('statLeft');
    if (pct7 != null) {
      sl.innerHTML = `7d <span class="stat-pct ${stateFor(pct7)}">${pct7}%</span> used`;
    } else {
      sl.textContent = '';
    }

    renderWeeklyTrend(allSnapshots, usage);
    staggerReveal();
    return true;
  } catch (e) {
    console.error('[TT] Storage fallback failed:', e);
    return false;
  }
}

// ─── Init ───
document.body.classList.remove('entering');

(async () => {
  // Instant first paint from the last cached snapshot (chrome.storage.local is
  // synchronous-fast), so the popup opens showing data, not a blank frame —
  // then reconcile with a live poll. Apple's first principle: kill latency.
  try { await renderFromStorage(); } catch { /* no cache yet — render() will fill in */ }

  await wakeWorker();
  try {
    await render();
  } catch (e) {
    console.warn('[TT] Render failed, using storage fallback:', e.message);
    const ok = await renderFromStorage();
    if (!ok) {
      $('mainContent').hidden = false;
      $('emptyState').hidden = false;
    }
    setTimeout(() => render(), 2000);
  }
})();
