# tt — Claude Usage in Your Terminal

**See your Claude quota before you hit it.**

When you're deep in a Claude Code session, there's no way to know how close you are to your rate limit. You find out when everything stops. `tt` fixes that — it puts live quota data directly in your terminal, as a status line in Claude Code, and as a badge in Chrome.

---

## What it is

Three pieces that work together:

| Piece | What it does |
|---|---|
| **Chrome extension** | Polls claude.ai every 5 min, shows quota % as a browser badge |
| **`tt` CLI** | Reads cached usage data, prints quota + reset time in your terminal |
| **Status line script** | Runs inside Claude Code — live usage at the bottom of every session |

The extension is the source of truth for claude.ai quota. A small local HTTP server bridges browser → filesystem so the CLI can read it.

---

## Demo

**`tt` in your terminal:**

```
claude.ai   44% ████░░░░░░ │ resets 3h 56m
claude code 655.2K tokens  │ 67 msgs │ 5h window │ Sonnet
```

**Status line inside Claude Code:**

```
╭─ Claude Code ─────────────────────────────────────╮
│  your conversation here                            │
╰────────────────────────────────────────────────────╯
 44% ████░░░░░░ │ resets 3h 56m │ 655K (67 msgs)
```

**Browser badge:**

```
[Claude icon]  44%   ← green below 70%, amber 70–89%, red 90%+
```

---

## How it works

```
  chrome.ai (logged in)
        │
        │  fetch() every 5 min
        ▼
  background.js (service worker)
        │
        │  POST JSON
        ▼
  tt-server.js  (:9898)
        │
        │  writes
        ▼
  ~/.token-tracker/usage.json
        │
        ├──► tt        (CLI — reads file on demand)
        └──► tt-statusline.sh  (runs inside Claude Code)

  Claude Code local files (~/.claude/projects/)
        │
        └──► tt cc     (direct read — no extension needed)
```

The extension can't write to disk directly (browser sandbox). The bridge daemon (`tt-server.js`) is a minimal HTTP server that accepts POSTs from the extension and writes the JSON file. That's its entire job.

---

## Requirements

- Node.js 18+
- Chrome (or Chromium-based browser)
- A claude.ai account — must be logged in for the extension to read quota

---

## Installation

### 1. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this project folder (`token-tracker-extension/`)
5. Note your extension ID — you'll need it in step 3

### 2. Start the bridge server

The bridge writes extension data to disk so the CLI can read it.

```bash
node tt-bridge/tt-server.js
```

To start it automatically on login, add this to your `~/.zshrc`:

```bash
# Claude token tracker bridge
if ! curl -sf http://127.0.0.1:9898/health > /dev/null 2>&1; then
  node ~/Downloads/token-tracker-extension/tt-bridge/tt-server.js &> /tmp/tt-server.log &
fi
```

### 3. Install the CLI

```bash
chmod +x cli/tt.js
sudo ln -sf "$(pwd)/cli/tt.js" /usr/local/bin/tt
```

Or use the install script (also sets up native messaging for a native host alternative):

```bash
bash tt-bridge/install.sh emaneooggjdnmbmnlhkmganeajpkfmbc
```

### 4. Add the Claude Code status line

In `~/.claude/settings.json`, add:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/token-tracker-extension/cli/tt-statusline.sh"
  }
}
```

Or if you used the install script, the statusline is symlinked to `~/.token-tracker/statusline.sh`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.token-tracker/statusline.sh"
  }
}
```

Reload Claude Code. The status line appears immediately.

---

## Usage

```bash
tt              # Combined status: claude.ai quota + Claude Code tokens
tt status       # Same as above
tt cc           # Claude Code detailed breakdown (reads ~/.claude/ directly)
tt watch        # Live display, refreshes every 30s
tt notify       # Background daemon — OS alerts at 80% and 95%
tt json         # Raw JSON output (pipe-friendly)
tt help         # Help
```

### Examples

**Quick status:**
```
$ tt
claude.ai   44% ████░░░░░░ │ resets 3h 56m
claude code 655.2K tokens  │ 67 msgs │ 5h window │ Sonnet
```

**Claude Code breakdown:**
```
$ tt cc
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

**Live watch:**
```
$ tt watch
# full-screen, refreshes every 30s, Ctrl+C to exit
```

**Background alerts (macOS / Linux):**
```bash
tt notify &   # OS notifications at 80% and 95%
```

**JSON output for scripting:**
```bash
tt json | jq '.extension.five_hour.utilization'
```

---

## Claude Code status line

The status line (`tt-statusline.sh`) runs as a subprocess each time Claude Code refreshes the bottom bar. It reads two sources:

1. `~/.token-tracker/usage.json` — extension data (authoritative claude.ai quota)
2. `~/.claude/projects/**/*.jsonl` — Claude Code local session files (token counts, 5h rolling window)

Output examples:

```bash
# Extension data available
44% ████░░░░░░ │ resets 3h 56m │ 655K (67 msgs)

# Extension not running, Claude Code data only
655.2K tokens │ resets ~2h 14m

# Nothing yet
Claude: no data
```

The status line degrades gracefully — if the bridge server isn't running, it falls back to reading Claude Code's local files directly.

---

## File structure

```
token-tracker-extension/
├── manifest.json          # Chrome MV3 manifest
├── background.js          # Service worker: polls API, manages badge, calls bridge
├── content-badge.js       # Injects usage badge into claude.ai UI
├── popup/                 # Browser popup UI
├── icons/                 # Extension icons
├── cli/
│   ├── tt.js              # CLI tool (symlink to /usr/local/bin/tt)
│   └── tt-statusline.sh   # Claude Code status line script
└── tt-bridge/
    ├── tt-server.js       # HTTP daemon on :9898, writes ~/.token-tracker/usage.json
    ├── install.sh         # Setup script
    ├── host.js            # Native messaging host (alternative to HTTP bridge)
    └── com.token_tracker.bridge.json  # Native messaging manifest template
```

**Data files (created at runtime):**

```
~/.token-tracker/
└── usage.json             # Latest quota snapshot — written by bridge, read by CLI
```

---

## How the sync works

Chrome extensions run in a sandboxed process and cannot write to the filesystem directly. To get usage data from the browser to the terminal, there are two options:

**HTTP bridge (default, recommended):** `tt-server.js` runs a minimal HTTP server on `localhost:9898`. The extension POSTs quota data to `/update` after each poll; the server writes it to `~/.token-tracker/usage.json`. The CLI reads that file on demand. No latency, no polling — data arrives within seconds of each extension poll.

**Native messaging (alternative):** `host.js` implements Chrome's native messaging protocol via stdin/stdout. Installed via `install.sh`. More complex setup, same result.

The bridge only listens on `127.0.0.1` — no external network access.

---

## Notifications

The extension sends browser notifications at 80% and 95% utilization (configurable in the popup). The `tt notify` daemon provides OS-level alerts (macOS: Notification Center, Linux: `notify-send`) as an alternative if you prefer not to rely on Chrome.

---

## Troubleshooting

**Badge shows `!`** — Extension can't authenticate. Make sure you're logged in to claude.ai.

**`tt` shows "No usage data"** — The bridge server isn't running, or hasn't received data yet. Start `tt-server.js` and wait up to 5 minutes for the first poll.

**Status line blank** — Check that the path in `settings.json` is correct and the script is executable (`chmod +x cli/tt-statusline.sh`).

**Bridge health check:**
```bash
curl http://127.0.0.1:9898/health
# {"status":"ok","pid":12345}
```

---

## Version

`0.5.2` — Chrome Extension Manifest V3
