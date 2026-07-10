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
  profileDir: z.string().min(1),
  outputPath: z.string().min(1),
  /** Browser crawl targets. May be empty for feeds-only configs (no Chrome launched). */
  targets: z.array(z.string().url()),
  siteRules: z.object({
    xCom: SiteRuleSchema,
    redditCom: SiteRuleSchema,
    bloombergCom: SiteRuleSchema,
  }),
  behavior: BehaviorSchema,
  schedule: ScheduleSchema,
  chrome: ChromeProfileSchema.default({ useSystemProfile: false, mode: "persistent" }),
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
export type Behavior = z.infer<typeof BehaviorSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ClipboardConfig = z.infer<typeof ClipboardSchema>;
export type DedupConfig = z.infer<typeof DedupSchema>;
export type FeedsConfig = z.infer<typeof FeedsConfigSchema>;
export type BackendConfig = z.infer<typeof BackendSchema>;
export type CrawlerConfig = z.infer<typeof CrawlerConfigSchema>;

export type SiteKey = "x.com" | "reddit.com" | "bloomberg.com";
