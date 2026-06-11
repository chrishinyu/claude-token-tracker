#!/usr/bin/env bash
# Claude Code status line — usage % + reset time + Claude Code token count

USAGE_FILE="$HOME/.token-tracker/usage.json"

node -e "
const fs = require('fs'), path = require('path'), os = require('os');

function bar(pct, w=10) {
  const f = Math.round(pct/100*w);
  return '\u2588'.repeat(Math.max(0,f)) + '\u2591'.repeat(Math.max(0,w-f));
}

function resetIn(resetsAt) {
  if (!resetsAt) return null;
  const t = typeof resetsAt === 'number'
    ? (resetsAt < 1e12 ? resetsAt*1000 : resetsAt)
    : new Date(resetsAt).getTime();
  const d = t - Date.now();
  if (d <= 0) return 'now';
  const h = Math.floor(d/36e5), m = Math.floor((d%36e5)/6e4);
  return h > 0 ? h+'h '+m+'m' : m+'m';
}

// ── Usage % + reset from extension (authoritative — covers all Claude usage) ──
let pct = null, reset = null, stale = false;
try {
  const d = JSON.parse(fs.readFileSync('$USAGE_FILE','utf-8'));
  const u = d.five_hour?.utilization;
  if (u != null) {
    pct = u > 1 ? Math.round(u) : Math.round(u * 100);
    reset = resetIn(d.five_hour?.resets_at);
    stale = (Date.now() - (d.updated_at||0)) > 600000;
  }
} catch {}

// ── Claude Code local token count (5h rolling window) ──
let ccTokens = 0, ccMsgs = 0, oldestTs = null;
try {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const cutoff = Date.now() - 5*60*60*1000;
  for (const proj of fs.readdirSync(projectsDir)) {
    const pp = path.join(projectsDir, proj);
    if (!fs.statSync(pp).isDirectory()) continue;
    for (const f of fs.readdirSync(pp).filter(f => f.endsWith('.jsonl'))) {
      for (const line of fs.readFileSync(path.join(pp,f),'utf-8').split('\n')) {
        try {
          const r = JSON.parse(line);
          if (r.type !== 'assistant') continue;
          const ts = new Date(r.timestamp).getTime();
          if (!ts || ts < cutoff) continue;
          const u = r.message?.usage;
          if (!u) continue;
          ccTokens += (u.input_tokens||0)+(u.output_tokens||0)+(u.cache_creation_input_tokens||0);
          ccMsgs++;
          if (!oldestTs || ts < oldestTs) oldestTs = ts;
        } catch {}
      }
    }
  }
} catch {}

const fmtT = n => n>=1e6?(n/1e6).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':String(n);

// ── Compose output ──
let out = '';

if (pct != null) {
  out += pct + '% ' + bar(pct);
  if (reset) out += ' \u2502 resets ' + reset;
  if (stale) out += ' (stale)';
} else if (ccTokens > 0) {
  // No extension data — estimate reset from oldest message in window
  const ccReset = oldestTs ? resetIn(oldestTs + 5*60*60*1000) : null;
  out += fmtT(ccTokens) + ' tokens';
  if (ccReset) out += ' \u2502 resets ~' + ccReset;
} else {
  out = 'Claude: no data';
}

// Append Claude Code msg count if active
if (ccMsgs > 0 && pct != null) {
  out += ' \u2502 ' + fmtT(ccTokens) + ' (' + ccMsgs + ' msgs)';
}

console.log(out);
" 2>/dev/null || echo "Claude: no data"
