#!/usr/bin/env node
"use strict"

const fs = require("fs")
const path = require("path")
const os = require("os")

const USAGE_FILE = path.join(os.homedir(), ".token-tracker", "usage.json")
const CLAUDE_DIR = path.join(os.homedir(), ".claude")
const NOTIFY_PID_FILE = path.join(os.homedir(), ".token-tracker", "notify.pid")
const REFRESH_MS = 30_000

// ─── Claude Code local reader ──────────────────────────────────────

function readClaudeCodeUsage(windowHours = 5) {
  const projectsDir = path.join(CLAUDE_DIR, "projects")
  if (!fs.existsSync(projectsDir)) return null

  const cutoff = Date.now() - windowHours * 60 * 60 * 1000
  const stats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    message_count: 0,
    by_model: {},
    by_session: {},
    oldest: Date.now(),
    newest: 0
  }

  // Walk all project dirs
  const projectDirs = fs.readdirSync(projectsDir)
  for (const proj of projectDirs) {
    const projPath = path.join(projectsDir, proj)
    if (!fs.statSync(projPath).isDirectory()) continue

    const files = fs.readdirSync(projPath).filter(f => f.endsWith(".jsonl"))
    for (const file of files) {
      const filePath = path.join(projPath, file)
      let content
      try { content = fs.readFileSync(filePath, "utf-8") } catch { continue }

      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        let record
        try { record = JSON.parse(line) } catch { continue }

        if (record.type !== "assistant") continue
        const ts = new Date(record.timestamp).getTime()
        if (!ts || ts < cutoff) continue

        const usage = record.message?.usage
        if (!usage) continue

        const input = usage.input_tokens || 0
        const output = usage.output_tokens || 0
        const cacheCreate = usage.cache_creation_input_tokens || 0
        const cacheRead = usage.cache_read_input_tokens || 0
        const total = input + output + cacheCreate

        stats.input_tokens += input
        stats.output_tokens += output
        stats.cache_creation_tokens += cacheCreate
        stats.cache_read_tokens += cacheRead
        stats.total_tokens += total
        stats.message_count += 1

        const model = record.message?.model || "unknown"
        stats.by_model[model] = (stats.by_model[model] || 0) + total

        const sid = record.sessionId || "unknown"
        stats.by_session[sid] = (stats.by_session[sid] || 0) + total

        if (ts < stats.oldest) stats.oldest = ts
        if (ts > stats.newest) stats.newest = ts
      }
    }
  }

  if (stats.message_count === 0) return null
  return stats
}

// ─── Extension usage reader ────────────────────────────────────────

function readExtensionUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"))
  } catch {
    return null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function utilPct(bucket) {
  if (!bucket || bucket.utilization == null) return null
  const u = bucket.utilization
  return u > 1 ? Math.round(u) : Math.round(u * 100)
}

function bar(pct, width = 10) {
  const filled = Math.round((pct / 100) * width)
  return "\u2588".repeat(Math.max(0, filled)) + "\u2591".repeat(Math.max(0, width - filled))
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return null
  const h = Math.floor(ms / 36e5)
  const m = Math.floor((ms % 36e5) / 6e4)
  if (h >= 24) { const d = Math.floor(h / 24), rh = h % 24; return rh ? `${d}d ${rh}h` : `${d}d` }
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function resetStr(bucket) {
  if (!bucket?.resets_at) return null
  const r = bucket.resets_at
  const t = typeof r === "number" ? (r < 1e12 ? r * 1000 : r) : new Date(r).getTime()
  const d = t - Date.now()
  return fmtDuration(d)
}

function staleness(data) {
  if (!data?.updated_at) return null
  const age = Date.now() - data.updated_at
  if (age > 10 * 60_000) return `(stale: ${fmtDuration(age)} ago)`
  return null
}

function topModel(byModel) {
  if (!byModel || !Object.keys(byModel).length) return null
  const [model, tokens] = Object.entries(byModel).sort((a, b) => b[1] - a[1])[0]
  const short = model.includes("opus") ? "Opus"
    : model.includes("sonnet") ? "Sonnet"
    : model.includes("haiku") ? "Haiku"
    : model.slice(0, 12)
  return { short, tokens }
}

// ─── Commands ─────────────────────────────────────────────────────

function cmdStatus() {
  const ext = readExtensionUsage()
  const cc = readClaudeCodeUsage(5)

  if (!ext && !cc) {
    console.log("No usage data. Reload Token Tracker extension or use Claude Code first.")
    process.exit(1)
  }

  // Claude.ai usage (from extension)
  if (ext) {
    const pct = utilPct(ext.five_hour)
    if (pct != null) {
      const reset = resetStr(ext.five_hour)
      const stale = staleness(ext)
      let line = `claude.ai  ${pct}% ${bar(pct)} \u2502 resets ${reset || "—"}`
      if (stale) line += ` ${stale}`
      console.log(line)
    }
  }

  // Claude Code usage (from local files)
  if (cc) {
    const top = topModel(cc.by_model)
    let line = `claude code ${fmtTokens(cc.total_tokens)} tokens \u2502 ${cc.message_count} msgs \u2502 5h window`
    if (top) line += ` \u2502 ${top.short}`
    console.log(line)
  }
}

function cmdCc() {
  const cc = readClaudeCodeUsage(5)
  if (!cc) {
    console.log("No Claude Code usage in the last 5 hours.")
    process.exit(0)
  }

  console.log("Claude Code — last 5 hours")
  console.log("\u2500".repeat(40))
  console.log(`  Tokens:   ${fmtTokens(cc.total_tokens)} (input: ${fmtTokens(cc.input_tokens)}, output: ${fmtTokens(cc.output_tokens)})`)
  console.log(`  Cache:    created ${fmtTokens(cc.cache_creation_tokens)}, read ${fmtTokens(cc.cache_read_tokens)}`)
  console.log(`  Messages: ${cc.message_count}`)
  console.log(`  Sessions: ${Object.keys(cc.by_session).length}`)

  if (Object.keys(cc.by_model).length) {
    console.log("")
    console.log("  Models:")
    for (const [model, tokens] of Object.entries(cc.by_model).sort((a, b) => b[1] - a[1])) {
      const short = model.includes("opus") ? "Opus" : model.includes("sonnet") ? "Sonnet" : model.includes("haiku") ? "Haiku" : model
      const pct = Math.round((tokens / cc.total_tokens) * 100)
      console.log(`    ${short.padEnd(10)} ${fmtTokens(tokens).padStart(7)} ${bar(pct, 15)} ${pct}%`)
    }
  }
}

function cmdWatch() {
  function render() {
    process.stdout.write("\x1B[2J\x1B[H")

    const ext = readExtensionUsage()
    const cc = readClaudeCodeUsage(5)

    console.log("Token Tracker \u2014 Live")
    console.log("\u2500".repeat(44))
    console.log("")

    if (ext) {
      const pct5h = utilPct(ext.five_hour)
      const pct7d = utilPct(ext.seven_day)
      console.log("claude.ai (from extension)")
      if (pct5h != null) {
        console.log(`  5-hour:  ${pct5h}% ${bar(pct5h, 20)} \u2502 resets ${resetStr(ext.five_hour) || "—"}`)
      }
      if (pct7d != null) {
        console.log(`  7-day:   ${pct7d}% ${bar(pct7d, 20)}`)
      }
      const stale = staleness(ext)
      if (stale) console.log(`  \u26A0 ${stale}`)
      console.log("")
    }

    if (cc) {
      console.log("Claude Code (from local files, 5h window)")
      console.log(`  Tokens:  ${fmtTokens(cc.total_tokens)} \u2502 ${cc.message_count} messages \u2502 ${Object.keys(cc.by_session).length} sessions`)
      const top = topModel(cc.by_model)
      if (top) {
        const pct = Math.round((top.tokens / cc.total_tokens) * 100)
        console.log(`  Model:   ${top.short} ${pct}% of usage`)
      }
      console.log("")
    }

    if (!ext && !cc) console.log("No data yet.")

    console.log(`Refreshing every ${REFRESH_MS / 1000}s. Ctrl+C to exit.`)
  }

  render()
  const interval = setInterval(render, REFRESH_MS)
  process.on("SIGINT", () => { clearInterval(interval); console.log(""); process.exit(0) })
}

function cmdNotify() {
  const THRESHOLD_80 = 80, THRESHOLD_95 = 95
  let notified80 = false, notified95 = false

  const pidDir = path.dirname(NOTIFY_PID_FILE)
  if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true })
  fs.writeFileSync(NOTIFY_PID_FILE, String(process.pid))

  function notify(title, message) {
    const { execSync } = require("child_process")
    try {
      if (process.platform === "darwin") execSync(`osascript -e 'display notification "${message}" with title "${title}"'`)
      else if (process.platform === "linux") execSync(`notify-send "${title}" "${message}"`)
    } catch { console.log(`[${new Date().toISOString()}] ${title}: ${message}`) }
  }

  function check() {
    const ext = readExtensionUsage()
    if (!ext) return
    const pct = utilPct(ext.five_hour)
    if (pct == null) return

    if (pct >= THRESHOLD_95 && !notified95) {
      notified95 = true
      notify("Token Tracker", `claude.ai at ${pct}% — approaching limit! Resets ${resetStr(ext.five_hour) || "soon"}`)
    } else if (pct >= THRESHOLD_80 && !notified80) {
      notified80 = true
      notify("Token Tracker", `claude.ai at ${pct}% — consider pacing.`)
    }
    if (pct < THRESHOLD_80) { notified80 = false; notified95 = false }
  }

  console.log(`Token Tracker notify daemon (PID ${process.pid}) — alerts at 80% and 95%`)
  check()
  setInterval(check, REFRESH_MS)

  const cleanup = () => { try { fs.unlinkSync(NOTIFY_PID_FILE) } catch {} process.exit(0) }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
}

function cmdJson() {
  const ext = readExtensionUsage()
  const cc = readClaudeCodeUsage(5)
  if (!ext && !cc) { console.error("No usage data found."); process.exit(1) }
  console.log(JSON.stringify({ extension: ext, claude_code: cc }, null, 2))
}

function cmdHelp() {
  console.log(`tt \u2014 Token Tracker CLI

Usage:
  tt              Combined status (claude.ai + Claude Code)
  tt status       Same as above
  tt cc           Claude Code detailed breakdown (reads ~/.claude/)
  tt watch        Live display, refreshes every 30s
  tt notify       Background daemon — OS alerts at 80%/95%
  tt json         Raw JSON output
  tt help         This help

Data sources:
  claude.ai usage  → ${USAGE_FILE} (from extension)
  Claude Code      → ${CLAUDE_DIR}/projects/ (direct, no extension needed)`)
}

// ─── Main ─────────────────────────────────────────────────────────

const cmd = process.argv[2] || "status"
switch (cmd) {
  case "status": cmdStatus(); break
  case "cc": cmdCc(); break
  case "watch": cmdWatch(); break
  case "notify": cmdNotify(); break
  case "json": cmdJson(); break
  case "help": case "--help": case "-h": cmdHelp(); break
  default: console.error(`Unknown command: ${cmd}`); cmdHelp(); process.exit(1)
}
