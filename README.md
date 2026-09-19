<div align="center">

# Claude Discord Presence

**Show off your Claude Desktop sessions as Discord Rich Presence.**

When the Claude app is open, your friends see it on your Discord profile — with a logo,
a live timer, rotating status messages, and clickable buttons.

*An optimised fork of [HeavenDCS](https://github.com/HeavenDCS)'s original **claude-discord-presence**
— same zero-dependency helper, now fed by Claude Code's own session data for precise details.*

[![CI](https://github.com/TheUnknownMurda/claude-discord-presence/actions/workflows/ci.yml/badge.svg)](https://github.com/TheUnknownMurda/claude-discord-presence/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D16-43853d.svg)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#why-zero-dependencies)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

</div>

---

## What it looks like

```
┌────────────────────────────────────────────┐
│  ●  YourName                                 │
│     Playing Claude                           │
│  ┌──────┐                                    │
│  │      │  Pair-programming with Claude      │   ← rotating top line (details)
│  │ 🟣🟠 │  Opus 4.8 · Actively chatting       │   ← model · status (state)
│  │  ◔   │  for 00:42:17                       │   ← live session timer
│  └──────┘                                    │
│   [ Try Claude ]  [ Get this presence ]      │   ← up to two buttons
└────────────────────────────────────────────┘
```

Hovering the big icon shows a tooltip like **“Claude Max · 2h 14m today · 11h this month · 5h 60% · week 38%”**
— the last two being your plan's *real* rate-limit meters, read from the desktop app's own cache.

---

## What it is (and how it honestly works)

The Claude Desktop App does **not** expose a public plugin or "presence" API, so this can't be a
true in-app plugin. Instead it's a tiny, well-behaved **background helper** that:

1. **Watches for the Claude app** by listing running processes (`tasklist` on Windows, `ps` on
   macOS/Linux) every few seconds — it never injects into, modifies, or reads anything *inside*
   Claude.
2. **Talks to Discord's local socket.** Discord ships a local IPC endpoint (a named pipe on
   Windows, a Unix socket elsewhere) that every Rich Presence integration uses. The helper speaks
   that protocol directly to set your status.
3. **Mirrors Claude's state.** Claude open → presence shows. Claude closed → presence clears
   (and automatically returns when you reopen Claude).
4. **Reads Claude Code's own bookkeeping** for precision: its live session registry
   (`~/.claude/sessions`) says which session is open, whether it's *busy* generating, when it
   started and what it's called; its transcripts give the model, project, branch, prompt count
   and token count; the desktop app's cache gives your plan's real usage meters. Only named
   fields are read — never your messages.

That's the whole trick. It's the same approach used by Rich Presence tools for VS Code, Spotify,
games, etc. — just pointed at Claude.

---

## Features

- 🟣 **Rich Presence** — logo, two text lines, small status icon, and the "Playing Claude" label.
- 🧠 **Model shown** — display the model you're using (e.g. *Opus 4.8*) via a label you set, with
  opt-in best-effort auto-detection, named exactly as the app names it. ([details ↓](#showing-which-model-youre-using))
- 💳 **Plan + usage** — your plan name, real local time used today/this month, **and your plan's
  actual 5-hour / 7-day usage meters** (from the desktop app's cache). (The desktop app is a flat
  subscription, so there's **no per-message dollar cost** to show. [why ↓](#plan--usage-not-a-dollar-figure))
- 🗂️ **Live session details** — project, git branch, session title, prompts sent and tokens used,
  straight from the Claude Code session that is actually open. ([placeholders ↓](#placeholders))
- ⏱️ **Live session timer** — counts up from when the current Claude Code session started (or when
  the Claude app was launched), not merely from when the helper noticed it.
- � **Usage history** — `claude-presence stats` charts your last N days, entirely local.
- �🔁 **Rotating messages** — cycle through fun/custom status lines on a timer.
- 🟢 **Honest Active vs Idle** — says *"actively in a conversation"* only when Claude is really
  generating (Claude Code's registry says *busy*) or has written something recently — not just
  sitting open. ([details ↓](#active-vs-idle-detection))
- ⏸️ **Pause anytime** — `claude-presence pause` hides the status without stopping the helper.
- ♻️ **Live config reload** — edit `config.json` and the running helper picks it up.
- 🔘 **Buttons** — up to two clickable links (e.g. *Try Claude*, *Get this presence*).
- 🪄 **Zero Discord setup** — a shared Discord app is **built in**, so installers never touch the
  Developer Portal. (Power users can still bring their own. [details ↓](#using-your-own-discord-app-optional))
- 🔒 **Single instance, guaranteed** — a PID lock means **only one** helper can ever run.
  Closing and reopening Claude (or login autostart racing a manual start) **never** stacks
  duplicate processes. ([How it works ↓](#how-the-single-instance-lock-works))
- 🚀 **Run at login** — one command sets up autostart on Windows, macOS, and Linux.
- 🔌 **Auto-reconnect** — survives Discord starting later, restarting, or briefly dropping.
- 🧰 **Friendly CLI** — `start`, `stop`, `status`, and a `doctor` that diagnoses problems for you.
- 🪶 **Zero dependencies** — pure Node, nothing to `npm install`. ([why ↓](#why-zero-dependencies))

---

## Requirements

| Requirement | Notes |
|---|---|
| **Node.js ≥ 16** | `node --version` to check. [Download here](https://nodejs.org). |
| **Discord _desktop_ app** | Running and logged in. The **browser** version of Discord cannot show Rich Presence. |
| **Claude Desktop App** | [claude.ai/download](https://claude.ai/download). |
| **A Discord application** | **Not needed** — a shared one is built in. Only if you want your own: [optional setup ↓](#using-your-own-discord-app-optional). |

Works on **Windows 10/11**, **macOS**, and **Linux**. Windows is the most thoroughly tested path.

---

## Installation

```bash
# 1. Get the code
git clone https://github.com/TheUnknownMurda/claude-discord-presence.git
cd claude-discord-presence

# 2. Install the `claude-presence` command globally (no dependencies are downloaded)
npm install -g .

# 3. Check your setup — this tells you exactly what (if anything) is missing
claude-presence doctor
```

> **Prefer not to install globally?** You can run every command with `node bin/cli.js …` from
> inside the project folder instead of `claude-presence …`. For example:
> `node bin/cli.js doctor`.

> **Windows PowerShell tip:** if `npm install -g .` warns about PATH, restart your terminal so the
> new `claude-presence` command is found, or use the `node bin/cli.js …` form.

---

## Setup — it's automatic

This build ships with a **shared Discord application baked in**, so there's **nothing to do in the
Discord Developer Portal** — you don't create an app, copy an ID, or upload any images. Install,
start, open Claude:

```bash
npm install -g .
claude-presence install   # turn on run-at-login and start the helper now
```

Open Claude, then look at your Discord profile. 🎉 That's the whole setup. If anything looks off,
run `claude-presence doctor` — it checks every piece and prints exact fixes.

> Just need Discord running? Rich Presence only works through the **desktop** client, logged in —
> the browser version can't show it.

> Prefer a guided walkthrough (model label, plan name, autostart)? Run `claude-presence setup`.
> It's optional — the defaults already work out of the box.

> **Want your own Discord app instead** — to rename the "Playing **Claude**" label or host your own
> images? You still can: see [Using your own Discord app](#using-your-own-discord-app-optional).

---

## Quick start (TL;DR)

```bash
npm install -g .
claude-presence install   # autostart + start now — the Discord app is already built in
```

Want to tweak your model label, plan name, or buttons first? Run `claude-presence setup` (guided)
or edit the file shown by `claude-presence config --path`.

---

## Using your own Discord app (optional)

Most people never need this — the built-in shared app already gives you full Rich Presence. Set up
your own only if you want to **rename the "Playing _Claude_" label**, **host your own images**, or
**publish your own build**.

### Point the helper at your own app
1. Open the **[Discord Developer Portal → Applications](https://discord.com/developers/applications)**,
   click **New Application**, and name it whatever you want the "Playing **___**" label to read.
   Copy its **Application ID** (a long number).
2. **Rich Presence → Art Assets → Add Image(s)** — upload [`assets/claude.png`](assets/claude.png)
   (or your own square art) under the exact key `claude`, plus optional `active` / `idle` small
   overlays. Images must be uploaded to *your* app: Discord does not render raw image URLs
   (see [`assets/README.md`](assets/README.md)).
3. Run `claude-presence setup` and paste the ID (or set `clientId` in your config), then
   `claude-presence restart`.

   ```jsonc
   { "clientId": "123456789012345678" }   // ← your Application ID
   ```

### Publishing a build where *your* users need zero setup
This is exactly how the built-in shared app works. Create one app as above, then hardcode its
Application ID as `DEFAULT_CLIENT_ID` near the top of [`src/config.js`](src/config.js) and commit
it. Everyone who installs your build then gets working presence with **no Discord setup at all** —
their `clientId` can stay empty.

```js
// src/config.js
const DEFAULT_CLIENT_ID = '123456789012345678'; // your app's ID — commit it once
```

> A Discord Application ID is fundamentally required by Discord to show *any* Rich Presence — it
> can't be removed. Baking one in doesn't dodge that; it just moves the work off your users and
> onto a single shared app, so installing "just works."

---

## Showing which model you're using

The Claude Desktop App doesn't expose the selected model anywhere stable, so this works in two layers:

- **`model.label`** *(reliable)* — whatever you set, e.g. `"Opus 4.8"`, shown as
  **“Opus 4.8 · Actively in a conversation”**. Never wrong, never breaks.
- **`model.detect`** *(opt-in, best-effort)* — reads the `"model"` field from the transcript of
  the **Claude Code session that is open right now** (else the newest one) and, if found,
  overrides the label. Names come from the app's own model catalogue cache, so they match what
  the app shows. It reflects agent/Claude-Code sessions (not necessarily your chat model), can
  lag or come up blank, and may stop working if the app changes its internals — so it **always
  falls back to your label**. It reads only the model-ID field, never your conversation content.

```jsonc
{ "model": { "show": true, "label": "Opus 4.8", "detect": true } }
```

`claude-presence doctor` shows exactly which model will be displayed and whether detection found one.

## Plan & usage (not a dollar figure)

The Claude **Desktop App is a flat subscription** (Pro/Max) — there is **no per-message dollar
cost** anywhere on your machine to read, so this plugin deliberately does **not** invent one.
Instead it shows something honest and genuinely useful:

- **Your plan name** — a label you set (`usage.planLabel`, e.g. `"Claude Max"`).
- **Real local time used** — measured by this helper: today, and optionally this month.
- **Your plan's real usage meters** — the desktop app polls your subscription's rate-limit
  windows (the numbers in its own "plan usage" tray) every ~15 minutes and caches them in
  `plan-usage-history.json`. The helper reads the newest sample: **% of the 5-hour window** and
  **% of the 7-day window** used. Shown only while fresh (under 45 min old), so a closed app
  never leaves a stale figure on your profile. Switch off with `usage.showLimits: false`.

Together they render in the logo tooltip as
**“Claude Max · 2h 14m today · 11h this month · 5h 60% · week 38%”**. Add `"showOnCard": true`
to *also* put the plan on the always-visible second line, e.g. **“Opus 4.8 · Claude Max”** — no
hover needed. The meters are also available as `{usage5h}` / `{usage7d}` in any text field.

```jsonc
{ "usage": { "show": true, "planLabel": "Claude Max", "showToday": true, "showMonth": true, "showLimits": true, "showOnCard": true } }
```

> **What about real $ spend?** Dollar amounts only exist for the separate **Anthropic API**
> (console.anthropic.com) — via the Cost Report API and an Admin API key — which measures API
> usage, *not* your desktop chats. It's intentionally out of scope here; if you want it, it would
> be a separate opt-in integration (open an issue).

## Placeholders

Every text field under `presence` (`details`, `stateActive`, `stateIdle`, `largeText`, …) may
contain `{placeholders}`. An empty one disappears cleanly, separators and all.

| Placeholder | Value | Source |
|---|---|---|
| `{model}` | Model in use, e.g. *Opus 4.8* | label / transcript `"model"` field |
| `{plan}` | `usage.planLabel` | config |
| `{project}` | Folder name of the open Claude Code session | registry `cwd` |
| `{branch}` | Its git branch (blank for `HEAD` / not a repo) | transcript `gitBranch` |
| `{title}` | The session's title, as shown in Claude Code / the Code tab | registry `name` |
| `{messages}` | **Prompts you've sent** in that session (tool results are not counted) | transcript |
| `{tokens}` | Tokens the session produced or added to its context, e.g. *165k* (cache re-reads excluded) | transcript `usage` |
| `{sessions}` | How many Claude Code sessions are open | registry |
| `{status}` | The resolved active/idle line | — |
| `{session}` | How long the session has been open, e.g. *1h 20m* | registry `startedAt` / process start |
| `{idle}` | How long since Claude last did anything | registry status + mtimes |
| `{today}` `{month}` `{total}` | Locally-measured usage time | `stats.json` |
| `{streak}` | Consecutive days of use | `stats.json` |
| `{usage5h}` `{usage7d}` | Real plan usage, % of the 5-hour / 7-day window, e.g. *60%* | desktop app cache |
| `{time}` | Local clock time, HH:MM | — |

Two conveniences keep templates honest when data is missing:

- **Units that agree in number:** `{messages:prompt|prompts}` renders *1 prompt* / *12 prompts*.
- **Whole segments vanish:** text is split on ` · `, ` | `, ` – `, ` — ` and ` - `; a segment whose
  placeholders are all empty disappears with its words, so `{model} · {messages:prompt|prompts} sent`
  reads just *Opus 4.8* outside a session — never *Opus 4.8 · sent*.

`claude-presence preview` renders your templates with live values without touching Discord.

## Active vs idle detection

"Actively in a conversation" is only claimed when there is evidence, strongest first:

1. **Focused window** (`detectActiveWindow: true`) — Claude is the foreground app.
2. **Claude Code is generating** — its session registry (`~/.claude/sessions/<pid>.json`) marks
   the session `busy`. This is exact and immediate.
3. **Recent writes** — a session transcript or the desktop app's storage (IndexedDB / Local
   Storage) changed within `activity.idleAfterSeconds`. The desktop app's *log* heartbeat is
   deliberately ignored: it fires about once a minute whether or not anyone is there, which used
   to make every desktop session read as permanently active.

When none of these can be observed (for example the desktop chat app on its own, with no Claude
Code data on the machine) the helper falls back to *active*, exactly as before.

---

## CLI reference

Run `claude-presence help` any time.

| Command | What it does |
|---|---|
| `claude-presence setup` | **Interactive first-time setup** — Discord App ID, model label, plan, autostart. Start here. |
| `claude-presence start` | Start the helper **in the background** (detached, no window). Refuses if one is already running. |
| `claude-presence start --foreground` | Run in the current terminal (great for debugging; `Ctrl+C` to stop). Alias: `-f`. |
| `claude-presence start --force` | Stop any existing instance first, then start fresh. |
| `claude-presence stop` | Stop the running helper and clear your Discord status. |
| `claude-presence restart` | Stop then start. Use after editing config. |
| `claude-presence status` | Show running state, autostart state, whether the Discord ID is set, and time used today. |
| `claude-presence doctor` | Full diagnostics with **specific fixes** for anything wrong. Start here when troubleshooting. |
| `claude-presence install` | Enable run-at-login **and** start the helper now. |
| `claude-presence uninstall` | Disable run-at-login (a running helper keeps running). |
| `claude-presence config` | Print the resolved config. Add `--path` to print just the file location. |
| `claude-presence version` | Print the version. |

`npm run` shortcuts also exist: `npm run doctor`, `npm run status`, `npm start` (foreground),
`npm run stop`, `npm run install-autostart`, `npm run uninstall-autostart`.

---

## Configuration

Your editable config lives in your OS app-data folder (not in the repo). Find it with
`claude-presence config --path`:

| OS | Location |
|---|---|
| Windows | `%APPDATA%\claude-discord-presence\config.json` |
| macOS | `~/Library/Application Support/claude-discord-presence/config.json` |
| Linux | `~/.config/claude-discord-presence/config.json` |

It's created automatically on first run. After editing, run `claude-presence restart`.
A fully-commented reference copy lives at [`config.example.json`](config.example.json).

### Every option

| Key | Type | Default | Description |
|---|---|---|---|
| `clientId` | string | *(placeholder)* | **Required.** Your Discord Application ID (digits only). |
| `pollIntervalSeconds` | number | `15` | How often to check whether Claude is running. |
| `claudeProcessNames` | string[] | `["Claude.exe","Claude"]` | Process names that count as "Claude" (case-insensitive, `.exe` optional). |
| `detectActiveWindow` | boolean | `false` | If `true`, distinguish **Active** (Claude focused) from **Idle**. |
| `onClaudeClose` | `"clear"` \| `"exit"` | `"clear"` | `clear`: keep the helper alive and hide presence. `exit`: shut the helper down. |
| `logLevel` | string | `"info"` | `error` \| `warn` \| `info` \| `debug`. |
| `showTimer` | boolean | `true` | Show the elapsed timer. It starts at the current Claude Code session's real start time (registry), else at the Claude app's process launch, else at first detection. |
| `model.show` | boolean | `true` | Show the model in the status line. |
| `model.label` | string | `"Opus 4.8"` | The model name to display (reliable; you set it). |
| `model.detect` | boolean | `true` | Best-effort auto-detect from local session files; falls back to `label`. |
| `usage.show` | boolean | `true` | Show plan + time-used in the logo tooltip. |
| `usage.planLabel` | string | `"Claude"` | Your plan name, e.g. `"Claude Pro"` / `"Claude Max"`. |
| `usage.showToday` / `usage.showMonth` | boolean | `true` | Include today's / this month's total time. |
| `usage.showLimits` | boolean | `true` | Include the plan's real 5-hour / 7-day usage meters (from the desktop app's cache) in the tooltip and `{usage5h}`/`{usage7d}`. |
| `activity.detect` | boolean | `true` | Honest active/idle detection (see [above](#active-vs-idle-detection)). |
| `activity.idleAfterSeconds` | number | `300` | No Claude activity for this long → the idle line. |
| `activity.hideWhenIdle` / `pauseStatsWhenIdle` | boolean | `false` | Clear the presence while idle / only count active time. |
| `activity.detectClaudeCode` | boolean | `true` | Count a live Claude Code session (registry) as "Claude is in use", even with no app window. |
| `project.show` / `project.detect` / `project.label` | — | `true` / `true` / `""` | Session details for `{project}` `{branch}` `{title}` `{messages}` `{tokens}`; `label` pins a project name. |
| `theme` | string | `"default"` | A built-in look: `default` `minimal` `coder` `stats` `chill` (`claude-presence theme list`). |
| `usage.showOnCard` | boolean | `false` | Also show the plan on the always-visible second line (`Model · Plan`), not just the hover tooltip. |
| `presence.activeType` | number | `0` | Activity verb: `0` Playing · `2` Listening · `3` Watching · `5` Competing. |
| `presence.largeImage` | string | `"claude"` | Big icon — an **art-asset key** uploaded to your Discord app. |
| `presence.largeText` | string | `"Claude"` | Tooltip on the big icon (overridden by `usage` when enabled). |
| `presence.smallImageActive` / `smallImageIdle` | string | `""` / `""` | Small overlay icon — art-asset key (empty = no overlay). |
| `presence.smallTextActive` / `smallTextIdle` | string | `"Active"` / `"Idle"` | Tooltip on the small icon. |
| `presence.details` | string | `"Chatting with Claude"` | Top line (overridden by `rotateMessages` if set). |
| `presence.stateActive` / `stateIdle` | string | … | Second line for active / idle. |
| `presence.rotateMessages` | string[] | *(4 samples)* | If non-empty, the top line cycles through these. Empty `[]` to disable. |
| `presence.rotateIntervalSeconds` | number | `30` | How often the rotating message advances. |
| `presence.buttons` | array | *(2 samples)* | Up to **2** `{ "label", "url" }` buttons. URLs must be `http(s)`. |

---

## How the single-instance lock works

This is the behaviour you specifically asked for: **closing and reopening Claude must never leave
multiple copies of the helper running.** Here's the design.

- The helper writes a **lock file** (`presence.lock`) in its data folder containing its process
  ID. It's created **atomically** (open-with-`wx`), so two helpers launching at the *exact* same
  moment can't both win.
- On startup, if a lock already exists, the helper reads the stored PID and checks whether that
  process is **actually still alive**:
  - **Alive?** The new copy logs *"Another instance is already running (PID …)"* and **exits
    immediately**. You can't get two.
  - **Dead** (e.g. a previous crash left a stale lock)? The new copy cleans it up and takes over.
- On shutdown (`stop`, `Ctrl+C`, log-off, or the OS asking it to quit), the helper **removes its
  own lock** and clears your Discord status. It will only ever delete a lock it owns.

**What this means in practice:**

- Closing Claude does **not** spawn anything. The one helper just hides your presence and keeps
  waiting (a few MB of RAM). Reopen Claude and it reappears — same single process the whole time.
- Running `claude-presence start` twice? The second one says *"Already running"* and does nothing.
- Autostart at login **and** you manually start it? Whichever is second backs off. Still one.
- Want the helper to fully quit when Claude closes instead of idling? Set `"onClaudeClose": "exit"`.
  (Autostart will bring it back next login; or relaunch with `claude-presence start`.)

To stop everything: `claude-presence stop`. To see what's running: `claude-presence status`.

---

## Autostart (run at login)

`claude-presence install` sets this up with **no admin rights**:

| OS | Mechanism | File |
|---|---|---|
| **Windows** | A hidden-launch script in your Startup folder | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\claude-discord-presence.vbs` |
| **macOS** | A LaunchAgent (loaded via `launchctl`) | `~/Library/LaunchAgents/com.claude.discordpresence.plist` |
| **Linux** | An XDG autostart entry | `~/.config/autostart/claude-discord-presence.desktop` |

The Windows launcher runs Node **windowless** (no console pops up at login). Remove autostart any
time with `claude-presence uninstall` (or just delete the file above). Because of the
single-instance lock, autostart can never collide with a manual start.

---

## Customization recipes

**Make it say "Listening to Claude" instead of "Playing":**
```jsonc
{ "presence": { "activeType": 2 } }
```

**Disable rotating messages and pin one line:**
```jsonc
{ "presence": { "rotateMessages": [], "details": "Deep in thought with Claude" } }
```

**Show Active/Idle based on window focus:**
```jsonc
{ "detectActiveWindow": true }
```
(On Windows this uses a tiny generated PowerShell script; on macOS, `osascript`.)

**Custom buttons:**
```jsonc
{ "presence": { "buttons": [
  { "label": "My portfolio", "url": "https://example.com" },
  { "label": "Say hi",       "url": "https://github.com/TheUnknownMurda" }
] } }
```

**Lighter footprint / slower polling:**
```jsonc
{ "pollIntervalSeconds": 30 }
```

---

## Troubleshooting

Run **`claude-presence doctor`** first — it checks each piece and prints targeted fixes.

<details>
<summary><b>The presence isn't showing up at all</b></summary>

1. Is the **Discord _desktop_ app** open and logged in? (Browser Discord can't show it.)
2. Is `clientId` set to your real Application ID (digits only)? `claude-presence status` will say.
3. Is the helper running? `claude-presence status`. If not, `claude-presence start`.
4. In Discord: **Settings → Activity Privacy → "Display current activity as a status message"**
   must be **on**.
5. Check the log: `claude-presence config --path` is next to `presence.log`.
</details>

<details>
<summary><b>Claude isn't being detected</b></summary>

Your Claude process may have a different name. Run `claude-presence doctor` — it lists any running
process containing "claude". Add the right name to `claudeProcessNames` in your config and
`restart`. (On Windows it's usually `Claude.exe`; on macOS, `Claude`.)
</details>

<details>
<summary><b>Discord isn't detected</b></summary>

Make sure the **desktop** client is fully launched (not minimized-to-tray-still-starting, not the
web app). The helper retries automatically, so once Discord is up the presence appears within a
poll or two — no need to restart the helper.
</details>

<details>
<summary><b>The big logo / small icons don't appear</b></summary>

- The image **asset keys** in your config must match the names you uploaded under
  **Rich Presence → Art Assets** (`claude`, and optionally `active` / `idle`).
- A raw `https://` image URL will **not** render (Discord shows a grey placeholder
  icon instead) — the image has to be uploaded as an art asset.
- Freshly-uploaded assets can take a few minutes to propagate.
- Double-check you uploaded them to the **same** application whose ID is in your `clientId`.
</details>

<details>
<summary><b>It says "Playing Claude" — can I change the verb?</b></summary>

Yes — set `presence.activeType` (`2` = Listening, `3` = Watching, `5` = Competing). The word
**after** the verb is your Discord application's **name**, so name the app whatever you want it to
read as.
</details>

<details>
<summary><b>Windows blocked the .vbs / antivirus flagged it</b></summary>

The autostart file is a 4-line, human-readable script that only launches Node on the daemon — you
can open it in Notepad to verify. If your environment forbids `.vbs`, skip `install` and instead
add `claude-presence start` to your own startup method (Task Scheduler, a shortcut, etc.).
</details>

<details>
<summary><b>I think multiple copies are running</b></summary>

By design they can't ([see the lock section](#how-the-single-instance-lock-works)). Confirm with
`claude-presence status` (shows a single PID) and `claude-presence stop` to clear it. If you ever
suspect a stale lock, `stop` cleans it up.
</details>

---

## Updating

```bash
cd claude-discord-presence
git pull
npm install -g .          # refresh the global command
claude-presence restart
```

Your config is preserved (it lives outside the repo), and new settings are auto-filled with
defaults on the next start.

---

## Uninstalling

```bash
claude-presence stop          # stop the helper, clear your status
claude-presence uninstall     # remove autostart
npm uninstall -g claude-discord-presence
```

Then optionally delete the data folder shown by `claude-presence config --path`.

---

## Privacy

Everything is **local**.

- The helper only ever talks to **Discord's local socket** on your own machine — the same channel
  every Rich Presence app uses. It makes **no other network connections**.
- It detects Claude by **process name**, and reads Claude Code's small per-session registry files
  (`~/.claude/sessions`: process id, working directory, start time, busy/idle flag, title). With
  `model.detect` / `project.detect` enabled it additionally reads a handful of **named fields** from
  the open session's transcript (`model`, `cwd`, `gitBranch`, `customTitle`, message *types* and
  token *counts*), and the two percentages in the desktop app's `plan-usage-history.json`. Message
  text is decoded only long enough to tell a prompt from a tool result and is never kept, logged or
  shown. It never reads your screen or your keystrokes.
- Nothing about a session leaves your machine except what *you* put in a template: `{title}` is
  never shown unless you use it.
- The "used today / this month" stats are stored in a plain local file and are **never transmitted**.
- What Discord then displays to others is the standard Rich Presence info (the text/images you
  configured). You can hide all of it in Discord's Activity Privacy settings at any time.

---

## Why zero dependencies?

The Discord IPC protocol is small and stable, so it's implemented directly (see
[`src/discord-rpc.js`](src/discord-rpc.js)) rather than pulling in a third-party RPC package.
The result: nothing to download, no supply-chain risk, no breakage when an upstream package
changes, and a tiny install. You only need Node itself.

---

## Project layout

```
claude-discord-presence/
├── bin/
│   └── cli.js               # `claude-presence` command (start/stop/status/doctor/…)
├── src/
│   ├── daemon.js            # the long-lived background loop
│   ├── discord-rpc.js       # hand-rolled, dependency-free Discord IPC client
│   ├── claude-detector.js   # process PIDs, real start time, optional foreground-window detection
│   ├── claude-sessions.js   # Claude Code's live session registry (busy/idle, title, start time)
│   ├── session-info.js      # project / branch / title / prompt + token counts of the open session
│   ├── activity-detector.js # honest active vs idle (registry status + file mtimes)
│   ├── plan-usage.js        # the plan's real 5h / 7d usage meters from the desktop app's cache
│   ├── claude-data.js       # where Claude keeps its data, per OS (metadata only)
│   ├── model-detector.js    # best-effort "which model?" from the open session's transcript
│   ├── single-instance.js   # the PID lock (no-duplicates guarantee)
│   ├── presence-builder.js  # builds the Discord activity payload
│   ├── autostart.js         # run-at-login for Windows/macOS/Linux
│   ├── stats.js             # local-only daily/monthly usage tracking
│   ├── config.js            # defaults + load/merge/save (+ DEFAULT_CLIENT_ID)
│   ├── logger.js            # leveled, rotating file logger
│   ├── paths.js             # per-OS data locations
│   └── fs-utils.js          # atomic file writes (temp + rename)
├── test/                    # node:test unit tests (run with `npm test`)
├── scripts/                 # dev tooling (syntax-check.js → `npm run check`)
├── .github/workflows/       # CI: tests + node --check on Windows/macOS/Linux
├── assets/                  # optional image(s) for presence (see assets/README.md)
├── config.example.json      # commented reference of every setting
├── package.json
├── CHANGELOG.md
└── README.md
```

---

## Roadmap / ideas

- 📦 Publish to npm for `npm install -g claude-discord-presence`.
- 🖥️ A tiny tray icon (pause / resume / quit without the CLI).
- 🧠 Detect *which* Claude project/workspace is focused (window-title parsing) for richer details.
- 🌗 Time-of-day or "deep work" themed presets.
- 🐧 Linux foreground-window detection (X11/Wayland).
- 🔁 A built-in self-update check.

PRs welcome — see below.

---

## Contributing

1. Fork and branch (`git checkout -b feature/my-idea`).
2. Keep it **dependency-free** and CommonJS.
3. Run `npm run check` and `npm test` (Node 20+), then smoke-test with
   `claude-presence doctor`. CI runs the same across Windows/macOS/Linux.
4. Open a PR describing the change and how you tested it.

Bug reports and feature requests via
[GitHub Issues](https://github.com/TheUnknownMurda/claude-discord-presence/issues).

---

## Credits

- **[HeavenDCS](https://github.com/HeavenDCS)** — original author of claude-discord-presence: the
  dependency-free Discord IPC client, the process detection, the single-instance lock, autostart,
  the CLI and the overall design. This project would not exist without that work.
- **[TheUnknownMurda](https://github.com/TheUnknownMurda)** — this optimised fork: live session
  registry, real plan meters, precise prompt/token/model/branch data, the timer's true start,
  honest active/idle detection, and the poll-loop optimisations (see [CHANGELOG](CHANGELOG.md)).

---

## License

[MIT](LICENSE) © 2026 HeavenDCS (original work) · TheUnknownMurda (this fork).

Unofficial and not affiliated with Anthropic or Discord. "Claude" and "Discord" are trademarks of
their respective owners, used here only to describe interoperability.
