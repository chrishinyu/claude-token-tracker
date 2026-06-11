/**
 * Claude Token Tracker — Popup v0.5.2
 * Source breakdown · Model breakdown · Enhanced weekly trend · SVG icons
 * Apple-style microinteractions · Predictive time-to-limit
 */

const BUCKETS = {
  seven_day_opus:       { label: 'Opus (7d)',       color: 'var(--opus)' },
  seven_day_sonnet:     { label: 'Sonnet (7d)',     color: 'var(--sonnet)' },
  seven_day:            { label: 'Overall (7d)',    color: 'var(--overall)' },
  seven_day_oauth_apps: { label: 'OAuth apps (7d)', color: 'var(--oauth)' },
  seven_day_cowork:     { label: 'Cowork (7d)',     color: 'var(--cowork)' }
};

// ─── SVG Icons (inline strings, Feather-style) ───

const ICONS = {
  clock:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  arrowDown:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="8" x2="12" y2="16"/></svg>',
  alertTriangle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  barChart:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  shield:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  lightbulb:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z"/></svg>',
  repeat:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>',
  externalLink:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
};

// ─── Helpers ───

const $ = id => document.getElementById(id);
const STAGGER = 60; // ms between staggered animations

function normUtil(v) { return v == null ? 0 : v > 1 ? v / 100 : v; }

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
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 6e4) return 'now';
  if (d < 36e5) return `${Math.floor(d / 6e4)}m`;
  if (d < 864e5) return `${Math.floor(d / 36e5)}h`;
  return `${Math.floor(d / 864e5)}d`;
}

function severityColor(pct) {
  if (pct >= 75) return 'var(--coral)';
  if (pct >= 50) return 'var(--warning)';
  return 'var(--success)';
}

function severityClass(pct) {
  if (pct >= 75) return 'coral';
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

let animFrameId = null;

function animateCountUp(el, target, duration) {
  if (prefersReducedMotion) { el.textContent = target + '%'; return; }
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(eased * target) + '%';
    if (t < 1) animFrameId = requestAnimationFrame(tick);
  }
  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(tick);
}

function staggerReveal() {
  if (prefersReducedMotion) {
    document.querySelectorAll('.anim').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none'; });
    return;
  }
  const anims = document.querySelectorAll('.anim');
  anims.forEach((el, i) => {
    el.classList.remove('reveal');
    void el.offsetWidth; // force reflow
    el.style.animationDelay = `${i * STAGGER}ms`;
    el.classList.add('reveal');
  });
}

// ─── Predictive time-to-limit ───

function predictTimeToLimit(snapshots) {
  const now = Date.now();
  const recent = snapshots.filter(s =>
    s.timestamp > now - 2 * 60 * 60 * 1000 && s.five_hour?.utilization != null
  );
  if (recent.length < 2) return null;
  const first = recent[0], last = recent[recent.length - 1];
  const u1 = normUtil(first.five_hour.utilization);
  const u2 = normUtil(last.five_hour.utilization);
  const dt = (last.timestamp - first.timestamp) / 60000;
  if (dt < 5 || u2 <= u1) return null;
  const rate = (u2 - u1) / dt;
  const remaining = 1 - u2;
  const mins = remaining / rate;
  if (mins > 300) return null;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`;
}

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
      chrome.runtime.sendMessage({ action: 'GET_USAGE' }),
      chrome.runtime.sendMessage({ action: 'GET_SNAPSHOTS' }),
      chrome.runtime.sendMessage({ action: 'GET_SETTINGS' })
    ]);

    const { usage, authenticated, lastPoll, apiStatus } = usageRes;
    allSnapshots = snapRes.snapshots || [];
    latestUsage = usage;
    installDate = settRes.installDate || null;

    $('pollFoot').textContent = lastPoll ? `polled ${relTime(lastPoll)} ago` : '';
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
      $('actionsSection').hidden = true;
      $('extraSection').hidden = true;
      $('modelSection').hidden = true;
      renderWeeklyTrend(allSnapshots, usage);
      staggerReveal();
      return;
    }

    $('emptyState').hidden = true;
    $('meterTile').hidden = false;

    // ── Meter ──
    const f5 = usage.five_hour;
    const frac = normUtil(f5?.utilization);
    const pct = Math.min(Math.round(frac * 100), 100);
    const rem = Math.max(100 - pct, 0);
    const st = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';

    const mv = $('meterVal');
    mv.className = `meter-val ${st}`;

    // Animated count-up
    animateCountUp(mv, pct, 800);

    // Update ARIA on meter bar
    const barTrack = $('barTrack');
    if (barTrack) barTrack.setAttribute('aria-valuenow', pct);

    // Animated bar fill
    const bf = $('barFill');
    bf.style.transform = 'scaleX(0)';
    bf.style.backgroundColor = st === 'bad' ? 'var(--coral)' : st === 'warn' ? 'var(--warning)' : 'var(--success)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bf.style.transform = `scaleX(${pct / 100})`;
      });
    });

    const rt = resetTime(f5?.resets_at);
    $('meterCountdown').textContent = rt ? `resets ${rt}` : '';
    $('statUsed').textContent = `${pct}% used`;

    const s7 = usage.seven_day;
    const u7 = s7?.utilization;
    $('statLeft').textContent = u7 != null
      ? `${rem}% left · 7d ${Math.round(normUtil(u7) * 100)}%`
      : `${rem}% remaining`;

    // Prediction
    const prediction = predictTimeToLimit(allSnapshots);
    $('meterPrediction').textContent = prediction
      ? `At this pace, limit in ${prediction}`
      : '';

    renderActions(pct, rt, usage);
    renderModelBreakdown(usage, pct);
    renderExtra(usage.extra_usage);
    renderWeeklyTrend(allSnapshots, usage);

    // Stagger reveal all sections
    staggerReveal();

  } catch (err) {
    console.error('[TT]', err);
    $('emptyState').hidden = false;
  } finally {
    if (isRefresh) {
      isRefreshing = false;
      document.body.classList.remove('refreshing');
    }
  }
}

// ─── Smart Actions (SVG icons, no emojis) ───

function renderActions(pct, resetStr, usage) {
  const container = $('actionsSection');
  container.innerHTML = '';
  const cards = [];

  let heaviest = null, heaviestPct = 0;
  for (const [key, cfg] of Object.entries(BUCKETS)) {
    const b = usage[key];
    if (!b || b.utilization == null) continue;
    const p = Math.round(normUtil(b.utilization) * 100);
    if (p > heaviestPct) { heaviest = { key, ...cfg, pct: p }; heaviestPct = p; }
  }

  if (pct >= 90) {
    cards.push({
      cls: 'coral',
      icon: ICONS.clock, iconBg: 'var(--error-soft)',
      title: resetStr ? `Resets in ${resetStr}` : 'Near limit',
      desc: 'Save heavy tasks for after reset'
    });
    cards.push({
      cls: 'warn',
      icon: ICONS.arrowDown, iconBg: 'var(--warning-soft)',
      title: 'Switch to Haiku',
      desc: 'Uses ~10x fewer quota tokens per message',
      link: 'https://claude.ai/settings'
    });
  } else if (pct >= 70) {
    cards.push({
      cls: 'warn',
      icon: ICONS.alertTriangle, iconBg: 'var(--warning-soft)',
      title: 'Usage elevated',
      desc: 'Shorter prompts or Haiku can stretch your window'
    });
  }

  if (heaviest && heaviestPct >= 40 && heaviest.key !== 'seven_day') {
    const modelName = heaviest.label.replace(' (7d)', '');
    cards.push({
      cls: 'warn',
      icon: ICONS.barChart, iconBg: 'var(--warning-soft)',
      title: `${modelName} is ${heaviestPct}% of 7d`,
      desc: modelName.includes('Opus')
        ? 'Sonnet handles most tasks equally well'
        : 'Consider mixing models to spread quota'
    });
  }

  // Positive low-usage card
  if (cards.length === 0 && pct < 40) {
    cards.push({
      cls: 'good',
      icon: ICONS.shield, iconBg: 'var(--success-soft)',
      title: 'Plenty of headroom',
      desc: `${100 - pct}% remaining — you're well within quota`
    });
  }

  // Cap at 2 cards max
  cards.splice(2);

  if (cards.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  for (const c of cards) {
    const el = document.createElement(c.link ? 'a' : 'div');
    el.className = `action-card ${c.cls}`;
    if (c.link) { el.href = c.link; el.target = '_blank'; }
    el.innerHTML = `
      <div class="action-icon" style="background:${c.iconBg}">${c.icon}</div>
      <div class="action-body">
        <div class="action-title">${escapeHtml(c.title)}</div>
        <div class="action-desc">${escapeHtml(c.desc)}</div>
      </div>`;
    container.appendChild(el);
  }
}

// ─── Model Breakdown (merged advisor + buckets) ───

function renderModelBreakdown(usage, currentPct) {
  const section = $('modelSection');
  const content = $('modelContent');

  const models = [
    { key: 'seven_day_opus', label: 'Opus', weight: 5 },
    { key: 'seven_day_sonnet', label: 'Sonnet', weight: 2 },
    { key: 'seven_day_cowork', label: 'Code', weight: 2 },
    { key: 'seven_day_oauth_apps', label: 'OAuth', weight: 1 }
  ];

  const data = models.map(m => {
    const b = usage[m.key];
    const util = b ? normUtil(b.utilization) : 0;
    return { ...m, util, pct: Math.round(util * 100) };
  }).filter(m => m.pct > 0);

  // Also collect all bucket entries for unified rows
  const bucketEntries = [];
  for (const [k, cfg] of Object.entries(BUCKETS)) {
    const b = usage[k];
    if (!b || b.utilization == null) continue;
    bucketEntries.push({ ...cfg, pct: Math.round(normUtil(b.utilization) * 100), color: cfg.color });
  }

  if (data.length === 0 && bucketEntries.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const opusEntry = data.find(m => m.key === 'seven_day_opus');
  const opusPct = opusEntry ? opusEntry.pct : 0;
  const totalPct = data.reduce((s, m) => s + m.pct, 0);

  let html = '';

  // Advisor banner
  if (currentPct >= 70) {
    html += `
      <div class="advisor-banner urgent">
        ${ICONS.alertTriangle}
        <span>Switch to Haiku for ~5x more messages before reset</span>
      </div>`;
  } else if (opusPct > 30 && totalPct > 0) {
    const savings = Math.round((opusPct * 0.6));
    html += `
      <div class="advisor-banner suggest">
        ${ICONS.repeat}
        <span>Opus is ${opusPct}% of 7d. Switching to Sonnet could save ~${savings}% of weighted quota.</span>
      </div>`;
  }

  // Bucket rows (compact colored-pip style)
  for (const e of bucketEntries) {
    html += `
      <div class="sl-row">
        <div class="sl-pip" style="background:${e.color}"></div>
        <span class="sl-name">${escapeHtml(e.label)}</span>
        <span class="sl-pct">${e.pct}%</span>
        <div class="sl-track"><div class="sl-fill animate" style="transform:scaleX(${e.pct / 100});background:${e.color}"></div></div>
      </div>`;
  }

  // Advisor link
  html += `
    <a class="advisor-link" href="https://claude.ai" target="_blank">
      ${ICONS.externalLink} Try a lighter model in your next conversation
    </a>`;

  content.innerHTML = html;
}

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
    if (isToday) lbl.className = 'today';
    if (isSel) lbl.className = 'selected';
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
      statsHtml = `<span><span class="label">Collecting data — bars fill as polls accumulate</span></span>`;
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
        insightEl.textContent = `Usage peaks on weekdays — heaviest ${dayName(heaviest.day)} at ${heaviest.pct}%`;
      } else {
        insightEl.textContent = `Heaviest on ${dayName(heaviest.day)} — ${heaviest.pct}% peak`;
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
        <div style="font-size:11px;color:var(--text-muted);padding:var(--sp-2) 0" class="state-body">No data for this day</div>
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
    html += `<div class="hourly-bar${barClass}${riseClass}" style="height:${ht}%;${delayStyle}" title="${h}:00 — ${Math.round(val * 100)}%"></div>`;
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
  $('btnSettings').classList.toggle('active', !p.hidden);
});

$('pollSelect').addEventListener('change', e => {
  chrome.runtime.sendMessage({ action: 'SET_POLL_INTERVAL', minutes: parseInt(e.target.value, 10) });
});

$('badgeToggle').addEventListener('change', e => {
  chrome.runtime.sendMessage({ action: 'SET_BADGE_SETTING', enabled: e.target.checked });
});

$('notifyToggle').addEventListener('change', e => {
  chrome.runtime.sendMessage({ action: 'SET_NOTIFY_SETTING', enabled: e.target.checked });
});

$('btnRefresh').addEventListener('click', async () => {
  const b = $('btnRefresh');
  b.classList.add('spin');
  b.disabled = true;
  await chrome.runtime.sendMessage({ action: 'REFRESH' });
  await render(true);
  setTimeout(() => { b.classList.remove('spin'); b.disabled = false; }, 500);
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
    const res = await chrome.runtime.sendMessage({ action: 'DEBUG_API' });
    const usageRes = await chrome.runtime.sendMessage({ action: 'GET_USAGE' });
    const snapRes = await chrome.runtime.sendMessage({ action: 'GET_SNAPSHOTS' });
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

// ─── Init ───
// Remove entrance class after animation completes
setTimeout(() => document.body.classList.remove('entering'), 300);
render();
