import { z } from "zod";

export const SiteRuleSchema = z.object({
  maxChars: z.number().int().min(200).max(500000),
  maxCharsPerComment: z.number().int().min(50).max(50000),
  /** "feed" = count chars on the feed itself (level 1). "post" = click into each post first (level 2). */
  contentLevel: z.enum(["feed", "post"]).default("feed"),
  /** Consecutive stalls (no new content) before pagination gives up. */
  stallLimit: z.number().int().min(1).max(20).default(3),
  /** Max scrolls on the listing/feed page when discovering post links (post-level only).
   *  Keeps the crawler from endlessly scrolling a titles page — just grab visible posts,
   *  visit them, and do a couple extra scrolls if more are needed. */
  maxFeedScrolls: z.number().int().min(0).max(100).default(10),
  /** Stop scraping once content is older than this many days (posts with no parseable
   *  timestamp are kept). Runs end at char budget OR this age horizon, whichever first. */
  maxAgeDays: z.number().min(1).max(3650).default(35),
  /** Feed-level only: stop after this many consecutive scroll batches that have posts
   *  but nothing new. On a chronological feed (X Lists), once a whole batch is already
   *  known everything deeper is older and known too — no point scrolling to the age horizon. */
  stopAfterKnownBatches: z.number().int().min(1).max(50).default(3),
});

/** One X List crawled feed-level at its canonical https://x.com/i/lists/<id> URL.
 *  Never crawl x.com/home: the For You / topic tabs there are ranked timelines and
 *  scroll-past impressions poison the account's recommendations. Lists are
 *  chronological and safe. Find URLs with: npx tsx src/scripts/discover-lists.ts */
export const XListSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  /** Relative share of siteRules.xCom.maxChars this list gets. Lists are crawled
   *  highest-weight first; a list that runs short of new content leaves its unspent
   *  chars to the lists after it. */
  weight: z.number().positive().max(1000),
});

/** Overflow pass: once the xLists have run dry, spend the leftover X budget on the
 *  /home pinned topic tabs (in tab-bar order), and finally on the For You timeline
 *  itself. CAUTION: unlike Lists these are ranked HomeTimeline surfaces — scraping
 *  them feeds scroll-past engagement signals back into the account's
 *  recommendations (the original feed-decay problem). Enabled at Andy's request;
 *  the leftover-only design keeps exposure as small as the lists allow. */
export const XOverflowSchema = z.object({
  enabled: z.boolean().default(false),
  /** Skip the overflow pass entirely when the leftover X budget is below this. */
  minLeftoverChars: z.number().int().min(0).max(500000).default(2000),
});

export const BehaviorSchema = z.object({
  navigationTimeoutMs: z.number().int().min(1000).max(180000).default(45000),
  waitMinMs: z.number().int().min(100).max(15000).default(600),
  waitMaxMs: z.number().int().min(200).max(25000).default(1800),
  retriesPerTarget: z.number().int().min(0).max(5).default(2),
  maxPagesPerRun: z.number().int().min(1).max(1000).default(25),
});

export const ScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMs: z.number().int().min(5000).max(86_400_000).default(300000),
  maxRuns: z.number().int().min(1).max(1_000_000).optional(),
});

export const ChromeProfileSchema = z.object({
  // If true, uses your real Chrome profile under LOCALAPPDATA.
  // Note: Chrome must be fully closed or the profile may be locked.
  useSystemProfile: z.boolean().default(false),
  // How to launch Chrome:
  // - "persistent": Playwright launches Chrome itself (shows "controlled" banner)
  // - "cdp": start a normal Chrome with remote debugging and connect over CDP
  mode: z.enum(["persistent", "cdp"]).default("persistent"),
  // Run Chrome with no visible window at all. This is the default: a crawl is
  // background work and should never take over the screen. Trade-off: headless
  // Chrome is easier for bot detection to spot, so the launcher also masks the
  // "HeadlessChrome" product token in the UA and client hints (see chromeCdp.ts).
  // Flip to false if a site starts challenging the crawler.
  headless: z.boolean().default(true),
  // Where the window sits when headless is false:
  // - "background": visible, but pushed to the bottom of the z-order and never
  //   given focus — it sits just above the desktop, under everything else
  // - "minimized": starts minimized to the taskbar
  // - "normal": ordinary foreground window (raises itself on every navigation)
  windowMode: z.enum(["normal", "background", "minimized"]).default("background"),
  cdpPort: z.number().int().min(1024).max(65535).optional(),
  chromeExecutablePath: z.string().min(1).optional(),
  // Advanced: override the detected Chrome user data dir / profile folder.
  userDataDir: z.string().min(1).optional(),
  profileDirectory: z.string().min(1).optional(), // e.g. "Default", "Profile 1"
});

export const ClipboardSchema = z.object({
  maxChars: z.number().int().min(100).max(10_000_000).default(50000),
});

export const DedupSchema = z.object({
  /** Only dedup against content posted within the last N days (limits RAM usage). */
  windowDays: z.number().int().min(1).max(365).default(5),
});

/* ── HTTP feeds (market news + EDGAR filings) — no browser, plain fetch ── */

export const DEFAULT_GNW_FEEDS = [
  // Official GlobeNewswire category feeds — full catalog: https://www.globenewswire.com/rss/list
  "https://www.globenewswire.com/RssFeed/subjectcode/13-Earnings%20Releases%20and%20Operating%20Results/feedTitle/GlobeNewswire%20-%20Earnings%20Releases%20and%20Operating%20Results",
  "https://www.globenewswire.com/RssFeed/subjectcode/27-Mergers%20and%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20and%20Acquisitions",
  "https://www.globenewswire.com/RssFeed/subjectcode/5-Bankruptcy/feedTitle/GlobeNewswire%20-%20Bankruptcy",
];

export const DEFAULT_GOOGLE_NEWS_FEEDS = [
  "https://news.google.com/rss/search?q=site:bloomberg.com+OR+site:reuters.com+OR+site:wsj.com&hl=en-US&gl=US&ceid=US:en",
];

const FeedSourceBaseSchema = z.object({
  enabled: z.boolean().default(true),
  /** Char budget per pull: NEW item text accumulates until this limit (the item that
   *  crosses it is included, matching the crawl engine's char-budget semantics). */
  maxChars: z.number().int().min(500).max(500_000).default(20_000),
});

export const FeedsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Skip feed items older than this many days (no parseable timestamp = kept). */
  maxAgeDays: z.number().min(0.05).max(365).default(7),
  timeoutMs: z.number().int().min(2000).max(60_000).default(15_000),
  /** Sent on every feed request. The SEC requires a UA that identifies you + contact. */
  userAgent: z.string().default("andy2_crawler/1.0 (contact: andyfazliu@gmail.com)"),
  globenewswire: FeedSourceBaseSchema.extend({
    feeds: z.array(z.string().url()).default(DEFAULT_GNW_FEEDS),
  }).prefault({}),
  googleNews: FeedSourceBaseSchema.extend({
    feeds: z.array(z.string().url()).default(DEFAULT_GOOGLE_NEWS_FEEDS),
  }).prefault({}),
  edgar: FeedSourceBaseSchema.extend({
    /** EDGAR "current events" form types to pull (each is one Atom request). */
    formTypes: z.array(z.string().min(1)).default(["8-K"]),
  }).prefault({}),
});

export const BackendSchema = z.object({
  /** Push snapshots to the remote backend (a1a2-command-center) after each run. */
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default("https://a1a2-command-center.onrender.com"),
  ingestPath: z.string().default("/api/crawler/ingest"),
  /** Shared secret sent as x-crawler-key. Prefer env CRAWLER_INGEST_KEY or the gitignored
   *  backend.local.json over committing it here (see src/sync/backendSync.ts). */
  ingestKey: z.string().optional(),
  /** Snapshots per ingest request (keeps request bodies well under the backend's 5mb limit). */
  batchSize: z.number().int().min(1).max(500).default(40),
});

export const CrawlerConfigSchema = z.object({
  searchJobId: z.string().optional(),
  searchReportPath: z.string().optional(),
  xSearches: z.array(z.object({
    query: z.string().trim().min(1).max(512),
    profile: z.string().max(80).optional(),
    maxPosts: z.number().int().min(1).max(100).default(30),
    since: z.string().datetime({ offset: true }).optional(),
    maxScrolls: z.number().int().min(1).max(100).default(40),
    timeoutMs: z.number().int().min(5000).max(300000).default(120000),
  })).max(20).default([]),
  profileDir: z.string().min(1),
  outputPath: z.string().min(1),
  /** Browser crawl targets. May be empty for feeds-only configs (no Chrome launched). */
  targets: z.array(z.string().url()),
  /** X Lists to crawl, sharing siteRules.xCom.maxChars split by weight (see XListSchema). */
  xLists: z.array(XListSchema).default([]),
  /** Spend leftover X budget on /home topic tabs + For You (see XOverflowSchema). */
  xOverflow: XOverflowSchema.prefault({}),
  siteRules: z.object({
    xCom: SiteRuleSchema,
    redditCom: SiteRuleSchema,
    bloombergCom: SiteRuleSchema,
  }),
  behavior: BehaviorSchema,
  schedule: ScheduleSchema,
  chrome: ChromeProfileSchema.prefault({}),
  clipboard: ClipboardSchema.default({ maxChars: 50000 }),
  dedup: DedupSchema.default({ windowDays: 5 }),
  feeds: FeedsConfigSchema.prefault({}),
  backend: BackendSchema.default({
    enabled: false,
    baseUrl: "https://a1a2-command-center.onrender.com",
    ingestPath: "/api/crawler/ingest",
    batchSize: 40,
  }),
});

export type SiteRule = z.infer<typeof SiteRuleSchema>;
export type XList = z.infer<typeof XListSchema>;
export type XOverflow = z.infer<typeof XOverflowSchema>;
export type Behavior = z.infer<typeof BehaviorSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ClipboardConfig = z.infer<typeof ClipboardSchema>;
export type DedupConfig = z.infer<typeof DedupSchema>;
export type FeedsConfig = z.infer<typeof FeedsConfigSchema>;
export type BackendConfig = z.infer<typeof BackendSchema>;
export type CrawlerConfig = z.infer<typeof CrawlerConfigSchema>;

export type SiteKey = "x.com" | "reddit.com" | "bloomberg.com";
