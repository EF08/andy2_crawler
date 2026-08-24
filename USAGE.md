# Simple Usage Guide

This app crawls `x.com`, Reddit, and Bloomberg using a real Chrome profile
(headless by default — no window appears), and pulls market/business news +
SEC EDGAR filings from HTTP feeds (no browser).

## 1) One-time setup

1. Open a terminal in this folder.
2. Install dependencies:

```bash
npm install
```

3. Make sure **Google Chrome is installed** — the crawler drives your real Chrome
   (`channel: "chrome"`); Playwright's bundled browsers are not used, so there is
   no `npx playwright install` step.

## 2) Configure targets

Edit `crawler.config.json`.

Most important fields:
- `targets`: pages to crawl
- `outputPath`: where results are saved
- `chrome.useSystemProfile`: `true` = use your real Chrome profile (recommended for auth sites)
- `chrome.mode`: `"cdp"` (recommended) or `"persistent"`
- `chrome.profileDirectory`: optional override (e.g. `"Default"`, `"Profile 1"`)
- `profileDir`: fallback profile folder (used when `chrome.useSystemProfile` is `false`)
- `schedule.enabled`: `false` = run once, `true` = run repeatedly

## 3) Run crawler (normal mode)

```bash
npm run crawl
```

What happens:
- Chrome starts in the background with no window (see "Browser visibility" below).
- If not logged in yet, run `npm run login` and log into the sites you need
  (X/Reddit/etc.) — that opens a normal, visible window on the crawler profile.
- Crawl runs and data is written to `outputPath` (default: `data/crawl-store.json`).

## 3b) Browser visibility

Two settings under `chrome` in the config control whether you ever see the crawler:

```json
"chrome": {
  "headless": true,
  "windowMode": "background"
}
```

- **`headless`** (default `true`) — Chrome runs with no window at all. The crawl uses
  the same logged-in profile and behaves identically; it just never touches your screen.
  Headless Chrome would normally announce itself as `HeadlessChrome/<version>` in its
  user-agent, so the launcher replaces that with the ordinary `Chrome/<version>` string.
  Set to `false` if a site ever starts challenging the crawler.

- **`windowMode`** (default `"background"`) — only applies when `headless` is `false`:
  - `"background"` — the window opens, is immediately pushed to the bottom of the
    z-order, and focus is handed straight back to whatever you were doing. It sits
    one step above the desktop, under all your other windows. The crawler also stops
    calling `bringToFront()`, so it never jumps back over you mid-crawl.
  - `"minimized"` — starts minimized to the taskbar.
  - `"normal"` — the old behaviour: a maximized window that raises itself on every
    page load. Use this when you want to watch the crawl.

A hidden or covered window is "occluded" as far as Chrome is concerned, and occluded
windows get throttled — so `background` and `minimized` also pass the flags that keep
timers and renderers running at full speed. Infinite-scroll feeds crawl at the same
rate whether you can see them or not.

Check a mode end to end (fingerprint + X login) with:

```bash
npx tsx src/scripts/test-headless.ts [configPath]
```

## 4) Run crawler (dry run)

Use this to test navigation/extraction without writing data:

```bash
npm run crawl:dry
```

## 5) Optional smoke test

Quick adapter sanity check:

```bash
npm run smoke
```

## 6) Use a different config file

```bash
npm run crawl -- --config ./my-config.json
```

## 5b) Market news + EDGAR feeds (no browser)

Every normal crawl run first pulls HTTP feeds (config block `feeds` in
`crawler.config.json`): GlobeNewswire category RSS (earnings / M&A / bankruptcy,
with tickers), Google News RSS (Bloomberg/Reuters/WSJ), and the SEC EDGAR
current-filings Atom feed (8-K). One snapshot per headline/filing, stored under
sites `globenewswire.com`, `news.google.com`, `sec.gov`. Snapshot ids are
deterministic (hash of site+URL), so re-pulls never duplicate anything. Each
source collects newest-first up to its `maxChars` budget per pull.

Feeds-only pull (finishes in seconds, Chrome never launches):

```bash
npm run feeds        # real pull + backend push
npm run feeds:dry    # fetch + count only, stores nothing
```

While the always-on agent runs, it does a feeds-only pull every 15 minutes when
idle (remote-controlled: `crawler_set_schedule({feedsEveryMinutes})`, 0 disables;
`crawler_run_now({configFile:"feeds"})` triggers one on demand).

## 6b) Backend sync (query your data from Claude, anywhere)

Every run automatically pushes its snapshots to `a1a2-command-center` on Render
(when `backend.enabled` is `true` in the config). From there the data is queryable
from claude.ai on any device via the "Crawler" MCP connector
(`https://a1a2-command-center.onrender.com/api/crawler/mcp` — same access password
as the Maor connector).

- The ingest key lives in `backend.local.json` (gitignored — never commit it).
  Alternatives: env var `CRAWLER_INGEST_KEY`, or `backend.ingestKey` in the config.
- Push the ENTIRE local store (idempotent, safe to rerun):

```bash
npm run sync
```

- Sync failures never break a crawl run — snapshots stay in the local store and the
  next `npm run sync` catches the backend up.

## 6c) Always-on PC agent (remote-triggered scrapes from Claude)

`npm run agent` starts a lightweight daemon that polls the backend every 30s
(heartbeat + job queue + schedule). With it running, Claude — from any device via
the Crawler MCP connector — can:

- `crawler_run_now` → your PC starts a scrape within ~30s
- `crawler_set_schedule` → recurring scrapes every N hours (while the PC is on)
- `crawler_status` → is the PC online? what ran recently?

It starts automatically at logon via a shim in the Windows Startup folder that runs
`scripts\start-agent.vbs` hidden (logs go to `data\agent.log`). A lockfile prevents
double agents. To stop it: Task Manager → end the `node` process running tsx, or
delete the Startup shim to disable autostart.

## 7) Common issues

- Chrome profile in use / won't launch:
  - If `chrome.useSystemProfile` is `true`, close Chrome completely (including background Chrome) and retry.
- Chrome does not launch:
  - Install Google Chrome (the app uses Playwright with `channel: "chrome"`).
- You still see "Chrome is being controlled by automated test software":
  - That banner is expected in `"persistent"` mode.
  - Use `chrome.mode: "cdp"` to connect to a normal Chrome instance instead.
- CDP mode opens Chrome but nothing navigates:
  - Check the logs for `Opening in existing browser session.`
  - That means Chrome was already running, so it reused the existing session and did NOT open the remote debugging port.
  - Fix: close Chrome completely (all windows + background `chrome.exe`) and rerun.
- Empty/poor results:
  - Make sure you are logged in for sites that require auth.
  - Check `targets` URLs in `crawler.config.json`.
- Runs forever:
  - Set `schedule.enabled` to `false` for one-shot runs.

