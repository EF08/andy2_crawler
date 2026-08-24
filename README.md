# andy2_crawler

A credentialed web-data pipeline with an **MCP interface**: it turns X (Twitter), Reddit, market newswires, and SEC EDGAR filings into one deduplicated, queryable research feed — which Claude reads directly over the Model Context Protocol.

Built to answer one question every morning: *what's in my feeds that isn't priced in yet?*

## How it works

```mermaid
flowchart TD
    subgraph local [Local machine]
        A["Your real Chrome profile<br/>headless by default · CDP"] --> B["Site adapters<br/>x.com · reddit · bloomberg"]
        C["HTTP feed engines<br/>GlobeNewswire · Google News · EDGAR 8-K"] --> D
        B --> D["Extract + normalize<br/>+ dedup window"]
        P["Pluggable sources<br/>10-K/10-Q · annual reports · GPU tracker"] -.planned.-> D
        D --> E["JSON store"]
    end
    E -->|keyed sync| F["a1a2-command-center<br/>(Express backend on Render)"]
    F --> G["MCP endpoint<br/>/api/crawler/mcp"]
    G --> H["Claude<br/>claude.ai connector + Claude Code"]
```

The browser path runs **headless by default** — a crawl is background work, so it
never opens a window or takes your screen. When you do want to watch it, the window
can be told to sit behind everything else instead of on top. See
[Running invisibly](#running-invisibly).

Two acquisition paths feed one store:

1. **Browser path** — attaches to your own logged-in Chrome via the DevTools Protocol and reads the feeds you already have access to, through per-site adapters with stall detection and bounded runs.
2. **Feed path** — plain HTTP engines for GlobeNewswire, Google News RSS, and SEC EDGAR (8-K filings). No browser needed.

Everything is normalized into one schema, deduplicated over a rolling window, and synced to a backend whose MCP server makes the corpus searchable from any Claude surface — ask claude.ai or Claude Code "what did the feed pick up on $XYZ this week?" and it queries this store.

## Design decisions

- **CDP session reuse instead of login automation.** The crawler never sees or stores credentials — it attaches to your existing Chrome profile, so 2FA, cookies, and session state stay exactly where they belong. This is the difference between "automation that keeps working" and "automation that breaks on every login challenge."
- **One adapter per site.** Each source implements a small adapter interface (`src/sites/`); supporting a new site is one file, not a refactor.
- **Invisible by default.** The crawl runs headless and never steals focus. Headless Chrome normally advertises itself as `HeadlessChrome/<version>` in its user-agent — the single loudest automation tell — so the launcher rewrites that to the ordinary `Chrome/<version>` string. Its client hints are already clean and are deliberately left untouched, since a UA that disagrees with its own `Sec-CH-UA` header is a stronger signal than either one alone.
- **Layered secret resolution.** The backend ingest key resolves env var → gitignored local file → config, and is never committed. The repo history is gitleaks-clean.
- **Polite by construction.** Randomized pacing, page and character budgets, per-run caps, and age cutoffs are first-class config — this is a personal research tool reading feeds its owner already has access to, and it behaves like one.
- **Fixtures over live tests.** Site extractors are developed against synthetic HTML fixtures (`src/fixtures/`), so parser changes are testable offline.

## Running invisibly

Two settings under `chrome` control whether the crawler ever touches your screen:

```json
"chrome": { "headless": true, "windowMode": "background" }
```

| Setting | Effect |
| --- | --- |
| `headless: true` *(default)* | No window at all. Same logged-in profile, same behaviour — it just runs in the background. |
| `windowMode` *(when headless is `false`)* | `background` *(default)* drops the window to the bottom of the z-order and hands focus straight back, so it sits under everything else; `minimized` sends it to the taskbar; `normal` is a foreground window that raises itself on every page load, for when you want to watch. |

Two details make this work rather than merely look like it works:

- **Focus is not stolen back.** The engine used to call `bringToFront()` before every
  navigation, which yanks the window over whatever you are doing on each page load.
  It is now skipped whenever the window is deliberately parked.
- **Backgrounded windows are not throttled.** Chrome treats a covered window as
  occluded and slows its timers and renderers, which stalls infinite-scroll feeds.
  The non-`normal` modes pass the flags that keep it running at full speed.

Verify any mode end to end — fingerprint plus a real logged-in page load — with:

```sh
npx tsx src/scripts/test-headless.ts [configPath]
```

## Adding a source

New sources plug into whichever of the two paths fits, and everything downstream —
dedup, budgets, the store, the backend sync, the MCP tools — comes for free because
every source normalizes into the same snapshot schema.

- **HTTP path** (`src/feeds/`) — anything with a feed or a JSON/XML endpoint. Implement
  one function returning `FeedItem[]` (`url`, `title`, `text`, `author`, `timestamp`,
  `metrics`), register it in the feed engine, add a toggle under `feeds` in the config.
  No browser, seconds per run.
- **Browser path** (`src/sites/`) — anything that needs a login or renders client-side.
  Implement `SiteAdapter` (`extractBase`, `discoverExpandTargets`, `paginationStrategy`)
  and add it to `src/sites/index.ts`. Character budgets, stall detection, age cutoffs
  and post-level expansion are handled by the engine.

Candidates that fit this shape, roughly easiest first:

| Source | Path | Notes |
| --- | --- | --- |
| **Corporate filings beyond 8-K** — 10-K, 10-Q, S-1, 13F/13D | HTTP | The EDGAR engine already exists; this is mostly widening `feeds.edgar.formTypes` and teaching the parser the extra item codes. Cheapest real win. |
| **Annual reports / investor relations decks** | HTTP + parse | PDFs, so it needs a text-extraction step before it becomes a `FeedItem`. Slower-moving data — a weekly cadence rather than the 15-minute feed pull. |
| **GPU tracker** (from the sibling project) | direct import | Numeric time series rather than documents, so it does not fit `FeedItem` cleanly. Either normalize each observation into a snapshot with the numbers in `metrics`, or keep it in its own collection and join at query time in the MCP layer. The messier shape is the reason it is worth deciding deliberately rather than forcing it into the text schema. |
| **Earnings-call transcripts, FRED//macro series, exchange filings (SEDAR, RNS)** | HTTP | Same pattern as EDGAR — a fetcher plus a normalizer. |

Rule of thumb: if it is **text with a timestamp and a source URL**, it belongs in the
snapshot store and the existing dedup/MCP machinery handles it. If it is **a number
series**, prefer a sibling collection and join at the MCP layer — forcing metrics into
a text schema costs more than it saves.

## Usage

See [USAGE.md](USAGE.md) for full setup and configuration. Quick version:

```sh
npm install          # requires Google Chrome — the crawler drives real Chrome, not Playwright's bundled browsers
# edit crawler.config.json (targets, site budgets, backend sync)
npm run login        # opens the automation Chrome profile — sign in to X/Reddit once
npm run crawl        # one-shot crawl of the configured targets
npm run agent        # or: always-on daemon that takes remote jobs via the backend
```

Config presets (`crawler.config.*.json`) cover full runs, short smoke runs, and feeds-only runs; `npm run feeds` pulls the news/EDGAR feeds with no browser at all.

## Stack

TypeScript · Playwright + Chrome DevTools Protocol · RSS/Atom + SEC EDGAR · Node/Express + MongoDB (backend) · Model Context Protocol
