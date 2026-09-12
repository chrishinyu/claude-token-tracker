# Token Tracker — Planning

Feature ideas, decisions in progress, what's next.

---

## Status

| Area | State |
|------|-------|
| Core extension (badge, popup, polling) | ✅ shipped |
| CLI (`tt`, `tt cc`, `tt watch`, `tt notify`) | ✅ shipped |
| Status line (Claude Code bottom bar) | ✅ shipped |
| Knowledge base + `.claude/` context | ✅ done 2026-06-28 |
| Normalization bug fix (`>= 1.5` threshold) | ✅ fixed 2026-06-28 |

---

## Ideas / backlog

Add ideas here as they come up. Include the why — not just what.

### Badge countdown alternation
Show `9%` and `4h` alternating in the badge when above 50%.
- **Why:** gives reset timing without opening the popup
- **Files:** `background.js` → `updateBadge()`
- **Status:** idea

### Export to CSV
Button in popup to download weekly usage as CSV.
- **Why:** useful for spotting patterns over time
- **Files:** `popup/popup.js` → `exportCsv()` (function already exists)
- **Status:** function exists, just needs UI hook

### Smarter prediction
Time-to-limit estimate currently needs 2+ snapshots in the last 2 hours.
- **Why:** often shows nothing when you've just started a heavy session
- **Files:** `popup/popup.js` → `predictTimeToLimit()`
- **Status:** idea

---

## Decisions log

| Date | Decision | Why |
|------|----------|-----|
| 2026-06-28 | Changed `> 1` threshold to `>= 1.5` | `1.0` means 100% as a fraction — old threshold could misread it |
| 2026-06-28 | Added clamp to [0, 1] after normalization | Floating-point drift above 1.0 caused display errors |
| 2026-06-28 | Added `.claude/CLAUDE.md` + KB/ + Planning/ | Persistent context so Claude Code doesn't need re-briefing each session |
| 2026-09-08 | Deduped `.jsonl` token counting by `requestId` in `cli/tt.js` + `cli/tt-statusline.sh` | Claude Code re-emits the same assistant turn across retries/streaming checkpoints with an identical `requestId` — undeduped, ~45-55% of raw records were duplicates, inflating every token count ~2-2.7x. Found + verified in a `/conductor` council (Jensen + Calvin + Chloe), 2026-09-08 |
| 2026-09-08 | Removed per-model quota breakdown (popup `modelSection`/`renderModelBreakdown`, `background.js` `seven_day_opus/sonnet/oauth_apps/cowork`) | The API has never returned per-model quota — those fields were `findInAll()` guesses (e.g. bare `'opus'` as a key) that matched nothing in 305 stored snapshots (all 6 values `null`, 0/305 snapshots even had the key). The popup was rendering deletions off values it never received |
| 2026-09-08 | Removed invented model-weight/multiplier claims ("Opus weight 5 / Sonnet 2", "Switch to Haiku for ~5x more messages", "save ~60% of weighted quota", "~10x fewer quota tokens") | No source for any of these numbers. Jensen traced "~5x" to the Opus/Haiku **API input-price ratio** ($5 vs $1) mislabeled as a quota weight — Anthropic publishes prices, never quota weights |
| 2026-09-09 | Confirmed (not just inferred) per-model quota is unbuildable — added `_debug_candidate_values` to `background.js`, read live: `seven_day_opus/sonnet/cowork/oauth_apps` **and** a previously-unseen `seven_day_breakdown` key all exist on the raw API response, all `null` | Settles the open question from 2026-09-08 with actual values, not just key presence. Diagnostic left in place — cheap to re-check later if Anthropic ever populates these |
| 2026-09-09 | Popup meter now shows **remaining** headroom + a one-word verdict ("68% left / Comfortable"), not raw percent-used colored by headroom | The old pairing (green + small number = "used") read backwards at a glance — a `/conductor` design review (Celine) found green-when-low is logically correct but easy to misread as "almost out." Fixed in both the live render path and the storage-fallback path |
| 2026-09-09 | Deleted the "smart actions" card block (`actionsSection`/`renderActions`) and the now-dead `ICONS` object entirely | After round 1 removed their content (unsourced "switch model" claims), the surviving cards were inert `div`s that still carried pointer-cursor/hover/press styling — a false affordance. The one real piece of advice (save heavy work near the limit) is now a plain-text `.meter-advisory` line, no card |
| 2026-09-09 | Removed `aria-live="polite"` from the animating meter number; added a single `.sr-only` live region updated once per render | The old markup announced every intermediate percentage to screen readers during the 800ms count-up animation — found in the same design review |
| 2026-09-10 | Meter hero is now a plain-language verdict ("Plenty left" / "Getting tight" / "Near limit"), 24px — no headline percentage at all | A 4-seat /conductor review (Celine + a user-perspective seat + Calvin) found the round-2 "% left" headline had two problems: (1) it counted DOWN while the bar counted UP — opposite directions, stacked, the real source of "unintuitive"; (2) the same quantity appeared 3× in the tile. Verdict answers the only 2-second question ("keep going or wrap up"); reset countdown prices it; bar shows trend. Number was never load-bearing (68 vs 61 changes nothing) |
| 2026-09-10 | Hero is the **usage percentage** ("32%" + "used", 40px), verdict word demoted to a small colored subhead. Number + bar + foot all read "% used" and rise together | Christy override of the round-4 council (which wanted a verbal verdict as hero, no number): she wants the usage figure shown. Single polarity kept the other way — number and bar both fill up, so they never disagree (the disagreement was the original bug). Foot: "5-hour window" / "7d 45% used" |
| 2026-09-10 | Update time moved into the meter tile ("updated 2m ago", `.meter-updated`); page-bottom `.poll-foot` now only shows "showing cached data" in the storage-fallback path, hidden otherwise | Freshness sits next to the data it describes; the 9px page-bottom line was easy to miss |
| 2026-09-10 | Deleted `predictTimeToLimit` + its render, and the now-unused `animateCountUp` | The prediction fit a line through as few as 2 snapshots of a bursty signal — a confident number with no basis, flagged across two review rounds. `animateCountUp` only served the deleted headline number |

## 2026-09-10 — design-foundation pass (Emil / Apple / impeccable lenses)

**Motion**
- `--dur-value: 800ms` (bar fill) → `--dur-base: 200ms`. 800ms was built for a deleted count-up; the bar inherited a duration you sit and watch on a 2s glance.
- Removed the popup entrance sequence entirely (`popupEntrance` + per-section `60ms × i` stagger). A frequently-opened surface should have no load choreography — it just adds perceived latency every open.
- Refresh no longer dims all content to 0.4 for 600ms (`dimPulse`); it's a 0.85 hairline fade. Don't obscure the data someone opened the popup to read.
- Refresh spinner 500ms → 340ms (faster spin reads as faster).
- `prefers-reduced-motion` no longer blanket-kills every transition — it now keeps opacity/colour transitions (which aid comprehension) and only removes movement.
- Consolidated three near-duplicate keyframes; single motion scale (`--dur-fast` 140 / `--dur-base` 200 / `--dur-exit` 150).

**Interaction**
- `.hdr-btn` gained an `:active` press state (`scale(0.92)`) — pressable things must feel pressed.
- Popup now paints instantly from the last cached snapshot (`renderFromStorage()` first), then reconciles with a live poll — instead of a blank frame while the service worker wakes.

**Visual foundation**
- Meter number: `Cormorant Garamond` serif → `Inter` 600 with `tabular-nums`. It's data, not display type; the serif also made "8%" and "80%" different widths. Serif kept only for the brand wordmark and rare state-screen titles.
- Elevation fixed: bar tracks now use `--surface-inset` (#141311, *darker* than the tile) + an inset shadow, so a groove reads as recessed, not raised. Was `--surface-card` #2a2826, lighter than its container.
- Meter tile gets a 1px hairline border — it's the primary surface, should read as raised.
- `--danger` (#e5484d, a real red) replaces `--coral` for the "Near limit" state everywhere (number, verdict, bar, sparkline peaks). Coral → amber → coral wasn't an escalation; amber → red is.
- Text ramp: four greys (two visually identical) → three genuinely distinct steps, all contrast-checked.
- Type scale: removed 8px and 9px sizes (floor is now 10px).
- `.sec-h` tracking `1.2px` (0.11em, way over-spaced) → `0.04em`.
- Removed the `border-left: 3px` side-stripe on `.extra-active` (an impeccable absolute ban) — full hairline border + a leading dot instead.
- Deleted dead CSS: model-advisor block, per-model bucket-row block, `--opus/--sonnet/--cowork/--overall` tokens, `body.entering` machinery.

## 2026-09-10 — hierarchy / focus / spacing / contrast pass (Celine + $impeccable layout)

Two isolated assessments (Celine craft review + impeccable `layout` checklist), plus the
bundled `detect.mjs --scope layout` scan (which flagged: "~4px used 10/15 times — monotonous
spacing, no rhythm"). Both reviews converged.

- **Two competing heroes → one.** The 42px number and the 13px/600 verdict word both encoded
  the same state (`st`), one by size, the other by being the only coloured thing. Fix: the
  **number** now carries the state colour at all three levels (green / amber / red), matching
  the bar right beneath it so colour + shape + words agree. The verdict is demoted to a
  plain-text caption on the number's own line: **"32% used · Plenty left"**. One focal point.
- **Meter tile restructured into three space-separated zones:** READ (number + caption + bar),
  DECISION (reset countdown, promoted to `--text-primary` — it's a live input, not a
  footnote; + the near-limit advisory), CONTEXT (window label / weekly / "updated Nm ago",
  pushed down and `--text-faint`). The advisory moved above the foot — it was rendering
  *below* the timestamp, i.e. advice under a footnote.
- **Spacing rhythm:** `4pt` scale fixed to even doubling (`--sp-5` 20→24, `--sp-6` 28→32).
  Meter joints now 12 / 8 / 16 / 4 (was a flat 4 / 4 / 12 / 12 / 4). Between-tile gap raised
  to `--sp-5` (24) so it clears the largest *within*-tile gap (16) — tiles read as blocks,
  not one stack.
- **Surface unification:** all four blocks (meter / extra-credits / trend / settings) now use
  the same `.tile` radius (`--r-lg`) and padding (`--sp-4`); the trend tile's inline
  `padding: sp-3` override and extra-credits' odd `--r-md` are gone. Primacy is one signal —
  the meter's border + `0 2px 8px` shadow — not four near-identical card styles.
- **Contrast / levels:** `.meter-foot` dropped from `--text-secondary` to `--text-faint`
  (it's ambient, was tonally tied to the countdown which is a decision input). All remaining
  10px text lifted to 11px (debug JSON dump excepted). `.trend-stats .val.coral` renamed to
  `.val.danger` + `severityClass()` returns `'danger'` — the class was named `coral` but
  coloured `--danger`, a naming lie against coral-is-interactive-only.
- Bar 6px → 8px (it's the tile's main spatial encoding, not trim), radius 3→4, deeper inset
  shadow so it reads as a recessed groove.

## 2026-09-10 — header/nav pass (Celine + $impeccable + Emil) + "updated now ago" bug

**Bug:** `relTime()` returned `"now"` for <60s, and the caller wrapped it as
`updated ${x} ago` → "updated now ago". Added `updatedLabel()`: "updated just now" for fresh,
"updated 5m ago" otherwise. `relTime()` now carries its own "ago".

**Header — was a card that lost its corners, now it's chrome:**
- `.header` background `--surface-tile` → `--surface-body` (matches the page), `border-bottom`
  removed. The content tiles (border + shadow) are what floats now; the header is just the
  page's top strip. It was competing with `#meterTile`'s primacy signal.
- Wordmark "Claude Token Tracker" (15px/400 serif, `--text-primary`) → **"Token Tracker"**
  13px/500, `--text-secondary`. "Claude" is redundant inside a Claude extension; the icon the
  user just clicked established identity. Serif kept — it's the one thread to `.meter-val`.
- **Refresh vs Settings now differ at rest:** `#btnRefresh` (the primary intent) is
  `--text-secondary`; `#btnSettings` is `--text-faint`. `.hdr-actions` got `gap: --sp-1` —
  the two buttons were touching and read as a segmented control.
- **Settings icon: sliders/EQ → gear.** Sliders conventionally means filters.
- **Hit targets:** visual 34→32px but a `::before { inset: -6px }` pseudo-element gives a
  44×44 click/tap area (was 34, under the floor).
- **A11y:** `aria-label` on both buttons, `aria-hidden` on the SVGs, `aria-expanded` on
  settings (toggled in JS), `alt=""` on the decorative logo.
- **`.hdr-btn.active`** (settings-drawer-open) dropped its coral + glow for a plain
  persistent-hover look — coral is reserved for focus rings only.
- **Refresh motion:** the one-shot `spinOnce 340ms ease-out` (which finished then hung for
  slower fetches) → a `spin` that **loops `linear` while `.refreshing`** and stops when the
  fetch resolves. Icon also dims (`--text-faint`) while refreshing — a non-motion cue that
  survives `prefers-reduced-motion`. Press `scale(0.92)` → `0.9` (more readable travel on a
  32px target). Refresh handler no longer uses a fixed 500ms timeout.

## 2026-09-10 — session close

**"updated now ago" bug fixed** — `relTime()` now carries its own "ago"; new `updatedLabel()`
renders "updated just now" for fresh data.

**Nav title** — bumped back to 15px / `--text-primary` / weight 500 (Christy's call; the
craft review had demoted it to 13px secondary). Logo back to 20px.

**Type system audited and consolidated** — final scale: 42 (meter hero) / 18 (state titles) /
15 (nav) / 14 (body) / 13 (compact labels) / 12 (interactive labels) / 11 (all meta) / 10
(debug dump only). Serif = weight 500 everywhere (was mixed). Weights: 400 default, 500
emphasis, 600 only for `.sec-h`.

### Session state / what's next

**Shipped and stable (rounds 1–4 + craft passes):**
- Token-count correctness: `requestId` dedupe, deleted fabricated per-model UI + invented
  multipliers, `predictTimeToLimit` removed.
- Popup rebuilt: usage % hero (serif) + verdict caption + state-coloured number & bar
  (single polarity), 3-zone spacing, reset countdown promoted, `updated` line, near-limit
  advisory above the foot, real `--danger` red.
- Header = chrome (not a card), 44px hit targets, a11y labels, looping refresh spinner.
- Motion turned down (no entrance sequence, 200ms state changes, reduced-motion scoped).

**OPEN — needs Christy, blocks the rest of v0.6:**
1. **Is v0.6 a tool you use, or a case study you present?** Several past findings invert on
   this. (You answered "both" once, then the reviews kept surfacing where "both" still
   forces a pick — e.g. keep the deleted-feature trail as narrative vs bury it.)
2. **Which `tt` number ever changed your behaviour?** If it was the quota %, the
   "pivot to context-window tracking" idea has no demand evidence and should stay cut.
3. Round-3 wall council never got a ruling — its recommendation was "small: a pre-wall
   nudge at ~70%, not a context subsystem" (2 lockouts / 8 days is below the bar for more).

**Deferred (not started):**
- Val's near-limit hero swap (show the reset *time* big instead of the word when red).
- Advisory threshold: move the "save heavy tasks" line from >=90% to ~70% (agreed in
  round 3, not yet done — `st === 'bad'` is still 90 in popup.js).
- Weekly-trend tile + settings drawer never got the craft/spacing pass the meter tile did.
- CLI (`tt.js`, `tt-statusline.sh`) unchanged since the round-1 dedupe fix.
- The 3 old backlog items (badge alternation, CSV export UI, smarter prediction) — all
  quota-clock polish, parked.

### 2026-09-11 — session close: before/after visual evidence + repo sync

Produced 6 before/after screenshots at 3 usage levels (7% / ~75% / ~93%) by driving the real
`popup.js` render code headlessly against `git HEAD` (true pre-session baseline) vs the
current working tree, with a mocked `chrome.*` API — no browser-automation bridge was
available this session. Saved to `~/Desktop/token-tracker-screenshots/`. Confirms the
before set faithfully shows the fabricated model-breakdown section, invented multipliers,
side-stripe cards, and coral-only escalation; the after set shows the shipped usage-%
hero, single-polarity bar, and real danger-red escalation at high usage.

This entry closes out rounds 1–4 + craft passes as committed to git for the first time —
prior sessions' work (dedupe, popup rebuild, header/nav pass) had never been committed.
OPEN items 1–3 and the Deferred list above still stand; nothing here resolves them.
