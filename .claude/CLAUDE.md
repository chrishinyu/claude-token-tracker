# Token Tracker — Claude Code Context

Chrome extension + CLI that tracks claude.ai quota in real time. Built by Christy.

## What it does
- Browser badge shows 5-hour quota % (green → amber at 70% → red at 90%)
- Popup shows meter, weekly trend, model breakdown, smart actions
- `tt` CLI prints quota + Claude Code token usage in terminal
- Status line shows live usage at bottom of every Claude Code session

## Project structure
```
token-tracker-extension/
├── .claude/CLAUDE.md       ← you are here
├── KB/how-it-works.md      ← internals, data format, decisions
├── Planning/backlog.md     ← features, ideas, decisions in progress
│
├── manifest.json           ← Chrome MV3 (must stay at root)
├── background.js           ← service worker: polls API, badge, bridge
├── content-badge.js        ← injects badge into claude.ai UI
│
├── popup/                  ← extension UI
│   ├── popup.html
│   └── popup.js
│
├── assets/                 ← icons + fonts
│   ├── icons/
│   └── fonts/
│
├── cli/                    ← terminal interface
│   ├── tt.js               ← CLI commands (status/cc/watch/notify/json)
│   └── tt-statusline.sh    ← Claude Code status line script
│
├── bridge/                 ← HTTP bridge server
│   ├── tt-server.js        ← daemon on :9898, writes ~/.token-tracker/
│   └── install.sh
│
└── docs/
    └── screenshots/
```

## Data format — critical
- `utilization` is always stored as a **decimal fraction (0–1)** after normalization
- Threshold is `>= 1.5` (not `> 1`) — 1.0 means 100%, not an integer percentage
- All values are clamped to [0, 1] after normalization
- See KB/how-it-works.md for full explanation

## The two quota windows
- **5-hour** → the big % in the popup, the badge, the terminal `claude.ai` line
- **7-day** → shown next to meter as `62% left · 7d 36%` — always a different number, both correct

## The bridge
Browser can't write files directly. `tt-server.js` runs on `:9898` and accepts POST from the extension, writes `~/.token-tracker/usage.json`. CLI reads that file. If bridge isn't running, extension still works — CLI just has no data.

## Rules — do not change without good reason
- The `>= 1.5` normalization threshold in `fixUtil()` (background.js)
- The clamp to [0, 1] after normalization
- The snapshot downsampling logic in `storeSnapshot()` (background.js)
- The `normUtil` clamp in popup.js

## How to reload after changes
Chrome: `chrome://extensions` → reload button on Token Tracker
CLI: changes are live immediately (it's a script)
Bridge server: restart `node bridge/tt-server.js`

## Current version
v0.5.2
