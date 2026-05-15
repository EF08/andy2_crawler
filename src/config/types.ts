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

export const CrawlerConfigSchema = z.object({
  profileDir: z.string().min(1),
  outputPath: z.string().min(1),
  targets: z.array(z.string().url()).min(1),
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
});

export type SiteRule = z.infer<typeof SiteRuleSchema>;
export type Behavior = z.infer<typeof BehaviorSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ClipboardConfig = z.infer<typeof ClipboardSchema>;
export type DedupConfig = z.infer<typeof DedupSchema>;
export type CrawlerConfig = z.infer<typeof CrawlerConfigSchema>;

export type SiteKey = "x.com" | "reddit.com" | "bloomberg.com";
