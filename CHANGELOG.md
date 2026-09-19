# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-09-19

Precision release: the presence now reads Claude Code's own bookkeeping instead of
guessing from file timestamps, and the numbers it shows are the real ones.

This version is maintained by **TheUnknownMurda** as an optimised fork of
**[HeavenDCS](https://github.com/HeavenDCS)**'s original project; everything below
1.2.0 in this file is their work. The default "Get this plugin" button is now
"Get this presence" and points at the fork; existing configs are migrated on load.

### Added
- **Live session registry.** Claude Code keeps one small JSON per running session in
  `~/.claude/sessions` (PID, cwd, start time, title, `busy`/`idle`). A new `claude-sessions`
  module reads it, verified against the process scan, and everything else builds on it:
  Claude Code counts as "in use" for as long as a session is open (it used to vanish after
  120s without a write), *busy* means active the instant it happens, and the session that is
  actually open — not merely the newest file — is the one shown.
- **Real plan usage.** The desktop app caches your subscription's rate-limit meters in
  `plan-usage-history.json` every ~15 minutes. The tooltip now shows *"5h 60% · week 38%"*
  and `{usage5h}` / `{usage7d}` are available everywhere (`usage.showLimits`, on by
  default; stale samples are never shown).
- **New placeholders:** `{title}` (the session's name), `{tokens}` (tokens the session
  produced or added to context, cache re-reads excluded), `{sessions}` (open Claude Code
  sessions), `{usage5h}`, `{usage7d}`.
- **Accurate timer.** The elapsed timer starts at the open Claude Code session's real start
  time (registry), else at the Claude app's process launch (one PowerShell/`ps` call per
  session), else at first detection — instead of always "when the helper noticed".
- **Model names from the app's catalogue.** Detected ids are rendered with the display name
  Claude Code caches in `~/.claude/cache/model-catalog` (`claude-fable-5-1` → *Fable 5.1*),
  with the old heuristic as a fallback.
- `status`, `doctor`, `watch` and `state.json` report all of the above: open sessions and
  their busy/idle state, title, prompt and token counts, plan meters and their age, the timer's
  source, and the rendered tooltip. `status --json` includes the sessions and plan sample.
- **Template units and segments.** `{messages:prompt|prompts}` agrees in number (*1 prompt*,
  *12 prompts*), and a ` · `-separated segment whose placeholders are all empty now vanishes
  with its words — `{streak} day streak` no longer leaves a bare *day streak* on a fresh
  install. An entirely empty line is omitted rather than sent to Discord as two spaces.
- The `coder` and `stats` themes use the new data (`{tokens}`, `{usage5h}`, `{usage7d}`).

### Fixed
- **`{messages}` counted tool results as messages.** A Claude Code transcript's `"type":"user"`
  lines are mostly tool output fed back to the model; a 7-prompt session reported ~110
  messages. Only lines whose content is text you typed are counted now (sub-agent traffic
  excluded), and the count is kept incrementally so a growing transcript is never re-parsed.
- **`{branch}` showed "HEAD".** Git reports `HEAD` for a detached head or a folder that isn't a
  repository; it is now treated as no branch.
- **Model detection could pick a model id out of conversation text.** It matched any
  `claude-…` string in the transcript tail, so a pasted document or a tool result mentioning
  another model changed the display. Matching is now anchored on the `"model"` JSON field.
- **The desktop app always read as active.** Its `main.log` receives a heartbeat about once a
  minute whether or not anyone is there, which defeated `idleAfterSeconds`. The log folder is
  no longer an activity signal; the app's storage (IndexedDB / Local Storage) — which only
  changes when the UI does something — is used instead, alongside transcripts and the registry.
- **Usage time was credited for the poll before Claude opened.** The first poll after Claude
  appears covers a gap during which it wasn't running; that interval is no longer counted.
- **Polls could overlap.** A slow poll (foreground-window check, process scan) could still be
  running when the next interval fired, or when Discord reconnected; polls are now serialised.
- **Changing `clientId` in a running helper had no effect** until a restart; the Discord
  connection is now re-established on live reload.
- `status` showed a stale "Showing …" line from a `state.json` left behind by a hard kill.
- `claude-presence status | head` no longer dies with an EPIPE stack trace.

### Changed
- **Far less work per poll.** The transcript directory walk (up to 400 `stat`s) ran up to three
  times per poll and is now done once and shared; when a session is open its transcript is
  opened directly by path instead of walked for; `stats.json` is parsed once per poll instead
  of five times; on Windows the process check uses a filtered `tasklist` (~3× faster).
- Transcript `user`/`assistant` lines are decoded to classify them (prompt vs tool result,
  token counts). Message text is never kept, logged or shown — see the README's Privacy section.

## [Unreleased — earlier in this cycle]

### Added
- **Honest active/idle status.** A new activity detector tells "actually using
  Claude" apart from "Claude is just open", based on how recently Claude wrote to
  its own session/log files (mtimes only — never contents). The presence now says
  *"Actively in a conversation"* only when that's true, and falls back to the old
  always-active behaviour when the signal is unavailable. Configurable under
  `activity`: `detect`, `idleAfterSeconds`, `hideWhenIdle`, `pauseStatsWhenIdle`.
- **`claude-presence stats`.** Usage history — today, last 7 days, this month, all
  time — plus a per-day bar chart (`--days N`, default 14).
- **`claude-presence logs`.** Print the tail of the log (`--lines N`) and follow it
  live with `-f`, instead of hunting for the file in the data directory.
- **`claude-presence pause` / `resume`.** Hide the presence temporarily without
  stopping the helper (a flag file, so it works on Windows and survives restarts).
- **Live config reload.** The daemon notices edits to `config.json` and applies
  them within one poll — including a changed poll interval — without a restart.
- **`doctor` now validates your presence images.** It lists the art assets that
  actually exist in the Discord application being used and flags any
  `largeImage`/`smallImage` that isn't one of them (or is a URL, which Discord
  never renders). This is the exact failure that showed a grey placeholder icon
  and produced no error anywhere.
- `doctor` and `status` also report where Claude's data was found, how long ago
  Claude last did anything, and whether the presence is paused.

### Fixed
- **Model auto-detection never worked on current Claude builds.** It looked only
  in `%APPDATA%\Claude\claude-code-sessions` for `.json` files; current installs
  store data in `%LOCALAPPDATA%\Claude` and `~/.claude/projects/*.jsonl`. A new
  `claude-data` module probes every known location on every OS, and detection now
  reads the **end** of a transcript rather than the start — an append-only session
  file begins with whatever model it opened with, so the old code reported a stale
  model even when it did find a file.
- **Usage time is now measured, not assumed.** Each poll credited a full
  `pollIntervalSeconds` regardless of how much time had really passed, so a
  suspended or throttled machine skewed the totals. The daemon now uses the real
  elapsed time between polls, capped at two intervals so unobserved time (sleep,
  hibernation) can't be counted.
- **Discord rate-limit safety.** The logo tooltip included a seconds-resolution
  duration, so the activity changed on *every* poll and was pushed every time.
  Tooltip durations are now minute-resolution and the daemon never pushes more
  than one update per 15s (a skipped update is retried on the next poll).
- **Buffered stats writes.** `stats.json` was fully rewritten every poll; seconds
  are now accumulated in memory and flushed at most once a minute — and always on
  shutdown, on the day rollover, and when Claude closes.

### Added (earlier in this cycle)
- **Test suite + CI.** A dependency-free [`node:test`](test/) suite covers the pure
  logic (presence building, config merge/resolve, duration formatting, model-name
  parsing, atomic writes, …). A GitHub Actions workflow runs the tests and a
  `node --check` pass on every `.js` file across Windows/macOS/Linux on Node
  20/22/24. New scripts: `npm test` and `npm run check`.

### Fixed
- **Usage stats can no longer be wiped by a crash.** `stats.json` (and `config.json`)
  are now written atomically via a temp-file + rename, so a process killed
  mid-write can never leave a truncated file — which `loadAll()` would otherwise
  read as empty, silently resetting today's/this-month's totals.
- **More reliable model auto-detection.** Detection now scans the few most-recent
  Claude session files and takes the first model ID found, instead of reading only
  the single newest file (which, if it happened to contain no model ID, blanked
  out detection entirely).

### Changed
- **Discord setup is now automatic by default.** With a shared `DEFAULT_CLIENT_ID`
  baked into `src/config.js`, installers get working Rich Presence with no Discord
  Developer Portal steps at all — the user-facing `clientId` defaults to empty and
  falls back to the built-in app. Creating your own Discord app is now an optional
  path (the README's setup section was rewritten accordingly).
- Set the repository owner to **HeavenDCS** across `README.md`, `package.json`,
  `config.example.json`, and the in-app button URLs.
- Ship a default `claude.png` logo and point `largeImage` at its raw GitHub URL,
  so the large icon shows out of the box with no Discord art-asset upload.

## [1.1.0] — 2026-06-12

### Added
- **Model display.** Show which model you're using as a reliable `model.label`
  (e.g. "Opus 4.8 · Actively in a conversation"), with an opt-in best-effort
  `model.detect` that reads the model ID from your newest local Claude session
  file and falls back to the label if it finds nothing.
- **Plan + usage display.** Because the desktop app is a flat subscription (no
  per-message dollar cost), the logo tooltip now shows your plan name plus real,
  locally-measured time — e.g. "Claude Max · 2h 14m today · 11h this month".
- **`claude-presence setup`** — an interactive first-time wizard that collects
  your Discord Application ID, model label, and plan, then offers autostart.
- **Zero-setup forks.** A bakeable `DEFAULT_CLIENT_ID` in `src/config.js` lets a
  repo owner ship a working Application ID so end-users need no Discord setup.
- **Image URLs.** `largeImage`/`smallImage` now accept a full `https://` URL to a
  hosted PNG/JPG, so you can skip uploading Discord art assets entirely.

### Changed
- Replaced the single `showDailyStats` toggle with the richer `usage` block.
- `doctor`/`status` now report the resolved Application ID (incl. built-in
  default) and the model that will be shown.

## [1.0.0] — 2026-06-12

### Added
- Initial release. 🎉
- Zero-dependency Discord Rich Presence helper for the Claude Desktop App.
- Hand-rolled Discord local-IPC client (no third-party packages).
- Cross-platform Claude detection via `tasklist` (Windows) and `ps` (macOS/Linux).
- Optional foreground-window detection to show **Active** vs **Idle** state.
- Single-instance lock — only one helper can ever run; closing/reopening Claude
  never spawns duplicates.
- Presence features: elapsed session timer, rotating status messages, large/small
  art-asset images, up to two link buttons, and an optional "time used today" tooltip.
- `claude-presence` CLI: `start`, `stop`, `restart`, `status`, `doctor`,
  `install`, `uninstall`, `config`.
- Run-at-login autostart for Windows (Startup `.vbs`), macOS (LaunchAgent), and
  Linux (XDG autostart).
- Auto-reconnect to Discord and graceful presence-clearing on shutdown.
- Local-only daily usage stats with automatic pruning.
