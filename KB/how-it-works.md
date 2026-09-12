# Token Tracker — Knowledge Base

Internal reference for how the system works, why numbers look the way they do, and decisions made during development.

---

## The two quota windows

Claude enforces **two separate limits** at the same time. The tracker surfaces both.

| Window | What it measures | Displayed as |
|--------|-----------------|--------------|
| **5-hour** | Usage in the rolling 5h window | The big % in the popup meter |
| **7-day** | Usage across the past 7 days | Small label next to the meter, e.g. `62% left · 7d 36%` |

These will almost always be different numbers. If the 5-hour says 9% and the 7-day says 36%, both are correct — they're measuring different things. The badge icon always shows the **5-hour** number since that's the one that gates you immediately.

---

## How utilization becomes a percentage

The claude.ai API returns `utilization` as a decimal fraction (e.g. `0.09` = 9%). Every piece of the system normalizes to this same format before storing or displaying.

**Normalization pipeline:**

```
claude.ai API response
      │
      ▼  background.js → normalizeUsage() → fixUtil()
      │  • if value >= 1.5: divide by 100 (handles legacy integer % format)
      │  • clamp to [0, 1]
      ▼
chrome.storage.local  (always decimal fraction 0–1)
      │
      ├──► popup.js → normUtil() → multiply by 100 → display as %
      ├──► background.js → updateBadge() → multiply by 100 → badge text
      └──► usage.json → tt.js → utilPct() → multiply by 100 → terminal
```

**The `>= 1.5` threshold** (not `> 1`) exists because `1.0` means 100% utilization as a fraction. Using `> 1` would misread a tiny floating-point value like `1.0000001` (still meaning 100%) as an integer percentage and divide it down to ~1%. The 1.5 buffer makes the boundary unambiguous.

---

## Why the badge might show a different number than the popup

The extension polls every 5 minutes. The badge reflects the **last completed poll**. The popup also reads from the same stored data, so they should match — but if you open the popup between polls, both show data that could be up to 5 minutes old.

Click the **R (refresh) button** in the popup to trigger an immediate poll and sync everything.

---

## Why the weekly trend bars look different from the meter

The weekly trend shows the **peak 5-hour utilization reached each day**, pulled from stored snapshots. The meter shows **current utilization right now**. A day where you hit 85% in the morning but are at 20% now will show an 85% bar — that's correct behavior, not a bug.

---

## Data sources: two independent signals

The system reads from two completely separate places depending on what you're measuring:

| Source | What's in it | Who reads it |
|--------|-------------|-------------|
| `~/.token-tracker/usage.json` | claude.ai quota (5h + 7d + model buckets) | Extension badge, popup, `tt`, `tt-statusline.sh` |
| `~/.claude/projects/**/*.jsonl` | Raw token counts from Claude Code sessions | `tt cc`, `tt watch` (Claude Code section) |

The JSONL files are written directly by Claude Code and don't require the extension at all. `tt cc` can run standalone with no bridge server.

---

## The bridge server

Chrome's sandbox prevents extensions from writing files directly to disk. `tt-server.js` is a tiny HTTP server on port 9898 that accepts `POST /update` from the extension and writes `usage.json`.

```
Extension (browser) ──POST /update──► tt-server.js ──► usage.json
```

If the bridge isn't running, the extension still works (badge, popup) — it just can't sync data to the CLI. The popup always reads from `chrome.storage.local`; the CLI falls back gracefully to nothing.

---

## Chrome service worker lifecycle

Chrome can terminate the background service worker at any time after ~30 seconds of inactivity. We handle this two ways:

1. **Keepalive alarm** — fires every 25 seconds to keep the worker alive during active use
2. **Storage fallback** — if the popup can't reach the worker, it reads directly from `chrome.storage.local` and renders from cached data, then retries the worker after 2 seconds

If the popup ever shows stale data and the refresh button doesn't help, try clicking the badge icon again — this re-opens the popup with a fresh render cycle.

---

## Endpoint discovery

The claude.ai API doesn't have a single stable URL for usage data. The extension tries five endpoints in order, caches whichever one works, and clears the cache if that endpoint stops responding (format change, etc.):

```
/api/organizations/{orgId}/usage
/api/organizations/{orgId}/rate_limits
/api/organizations/{orgId}/settings/usage
/api/organizations/{orgId}/quota
/api/organizations/{orgId}/rate_limit_status
```

If all five fail three times in a row, `api_status` is set to `broken` and the popup shows a "data unavailable" state. Clearing this: reload the extension or wait — the next successful poll resets the failure count.

---

## Snapshot storage

Every poll stores a snapshot. Snapshots are downsampled over time to keep storage lean:

| Age | Retention |
|-----|-----------|
| < 24 hours | Keep every snapshot |
| 1–7 days | Keep 1 per hour |
| 7–30 days | Keep 1 per day |
| > 30 days | Pruned |

Snapshots drive the weekly trend chart and the predictive time-to-limit estimate. More snapshots = more accurate prediction.

---

## What the terminal shows

`tt` (no args) — combined view:
```
claude.ai   9%  █░░░░░░░░░ │ resets 4h 35m
claude code 655.2K tokens  │ 67 msgs │ 5h window │ Sonnet
```

`tt cc` — detailed Claude Code breakdown:
```
Claude Code — last 5 hours
────────────────────────────────────────
  Tokens:   655.2K (input: 312.1K, output: 88.4K)
  Cache:    created 210.3K, read 1.2M
  Messages: 67
  Sessions: 3

  Models:
    Sonnet     512.1K ███████████████ 78%
    Opus       143.1K ████░░░░░░░░░░░ 22%
```

The model % in `tt cc` is **share of total tokens used in the 5h window**, not quota utilization.

---

## Bugs fixed

| Date | Bug | Fix |
|------|-----|-----|
| 2026-06-28 | `> 1` threshold could misread `1.0` (100% quota) as an integer percentage and divide to ~1%, or treat floating-point noise above 1 the same way | Changed to `>= 1.5` everywhere; added clamp to [0, 1] after normalization |
| 2026-06-29 | `tt-statusline.sh` still used `> 1` threshold (missed in the June-28 fix), inconsistent with all other normalization code | Changed to `>= 1.5` to match everywhere else |
| 2026-06-29 | `statLeft` in popup showed `X% left · 7d Y%` where Y was 7-day **utilization** (used%), but the label implied remaining% — misread as "Y% left on 7-day" | Changed Y to `100 - utilization` so both numbers are remaining% and the "% left" label applies to both |

---

`v0.5.2`
