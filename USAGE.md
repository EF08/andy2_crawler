# Simple Usage Guide

This app crawls `x.com`, Reddit, and Bloomberg using a real Chrome window.

## 1) One-time setup

1. Open a terminal in this folder.
2. Install dependencies:

```bash
npm install
```

3. Install Playwright browser support:

```bash
npx playwright install
```

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
- A Chrome window opens.
- If not logged in yet, log into sites you need (X/Reddit/etc.).
- Crawl runs and data is written to `outputPath` (default: `data/crawl-store.json`).

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

