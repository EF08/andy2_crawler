import crypto from "node:crypto";
import { DateTime } from "luxon";
import { BrowserContext, Page } from "playwright";
import { CrawlerConfig, SiteKey, SiteRule } from "../config/types";
import { canonicalizeUrl } from "../extract/normalize";
import { JsonStore } from "../store/jsonStore";
import { CrawlSnapshot } from "../store/schema";
import { resolveAdapter } from "../sites";
import { ContentItem, ExpandTarget, ExtractedRecord, SiteAdapter } from "../sites/types";
import { expandWithCharBudget } from "./expand";
import { paginate } from "./paginate";
import { scrollOnce, getScrollHeight } from "./paginate";
import { humanizeBeforeExtract, randomWait } from "../browser/humanize";
import { collectNavDebug } from "./pageSignals";
import { progressBar } from "./progress";

/** Known content from the store, used to skip duplicates in real-time. */
type KnownContent = { texts: Set<string>; urls: Set<string> };

function nowStrings(): { iso: string; local: string } {
  const now = DateTime.local();
  return {
    iso: now.toUTC().toISO() ?? new Date().toISOString(),
    local: now.toFormat("yyyy-LL-dd HH:mm:ss ZZZZ"),
  };
}

function getSiteRule(config: CrawlerConfig, hostname: string): SiteRule {
  if (hostname.includes("x.com")) return config.siteRules.xCom;
  if (hostname.includes("reddit.com")) return config.siteRules.redditCom;
  return config.siteRules.bloombergCom;
}

/** Sum of all post text lengths in a snapshot. */
function totalPostChars(snap: CrawlSnapshot): number {
  return snap.content.posts.reduce((sum, p) => sum + p.text.length, 0);
}

// ---------------------------------------------------------------------------
// Feed-level crawl (X/Twitter)
// ---------------------------------------------------------------------------

/**
 * Level 1 ("feed"): Scroll the feed and extract posts on every iteration,
 * accumulating unique NEW posts only. Posts already in the store are skipped
 * and don't count toward the char budget.
 */
async function crawlFeedLevel(
  page: Page,
  adapter: SiteAdapter,
  siteRule: SiteRule,
  runId: string,
  target: string,
  known: KnownContent,
): Promise<CrawlSnapshot> {
  // Pre-seed with known texts so duplicates are auto-skipped
  const seenTexts = new Set<string>(known.texts);
  const allPosts: ContentItem[] = [];
  let cumulativeChars = 0;
  let totalSkipped = 0;
  let feedTitle = "";

  // Extract initial visible content
  const initial = await adapter.extractBase(page, siteRule);
  feedTitle = initial.title ?? "";
  for (const post of initial.posts) {
    if (!post.text) continue;
    if (seenTexts.has(post.text)) { totalSkipped++; continue; }
    seenTexts.add(post.text);
    allPosts.push(post);
    cumulativeChars += post.text.length;
  }

  console.log(
    `[crawl] ${progressBar(cumulativeChars, siteRule.maxChars)} ` +
    `${cumulativeChars}/${siteRule.maxChars} chars · ${allPosts.length} new posts (initial)` +
    (totalSkipped > 0 ? ` · ${totalSkipped} known, skipped` : ""),
  );

  let prevHeight = await getScrollHeight(page);
  let stallCount = 0;
  let scrolls = 0;

  while (cumulativeChars < siteRule.maxChars) {
    console.log(`[crawl] Scrolling… (scroll #${scrolls + 1})`);
    await scrollOnce(page);
    await randomWait(1800, 3500);
    scrolls++;

    // Stall detection via scroll height
    const height = await getScrollHeight(page);
    if (height <= prevHeight) {
      stallCount++;
      console.log(`[crawl] No new content loaded (stall ${stallCount}/${siteRule.stallLimit})`);
      if (stallCount >= siteRule.stallLimit) {
        console.log(`[crawl] Feed exhausted after ${scrolls} scrolls`);
        break;
      }
    } else {
      stallCount = 0;
    }
    prevHeight = height;

    // Extract visible posts — skip known content
    const batch = await adapter.extractBase(page, siteRule);
    let newInBatch = 0;
    let skippedInBatch = 0;
    for (const post of batch.posts) {
      if (!post.text) continue;
      if (seenTexts.has(post.text)) { skippedInBatch++; totalSkipped++; continue; }
      seenTexts.add(post.text);
      allPosts.push(post);
      cumulativeChars += post.text.length;
      newInBatch++;
    }

    let msg =
      `[crawl] ${progressBar(cumulativeChars, siteRule.maxChars)} ` +
      `${cumulativeChars}/${siteRule.maxChars} chars · ${allPosts.length} new · ${scrolls} scrolls`;
    if (newInBatch > 0) msg += ` (+${newInBatch} new)`;
    if (skippedInBatch > 0) msg += ` (${skippedInBatch} known)`;
    console.log(msg);
  }

  if (totalSkipped > 0) {
    console.log(`[crawl] Total skipped: ${totalSkipped} known posts from store`);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await randomWait(300, 600);

  const ts = nowStrings();
  return {
    id: crypto.randomUUID(),
    runId,
    site: adapter.site as SiteKey,
    sourceUrl: target,
    canonicalUrl: canonicalizeUrl(target),
    capturedAtIso: ts.iso,
    capturedAtLocal: ts.local,
    content: { title: feedTitle, posts: allPosts, comments: [] },
    metrics: {
      postCount: allPosts.length,
      commentCount: 0,
      totalChars: cumulativeChars,
      scrolls,
      skippedKnown: totalSkipped,
    },
  };
}

// ---------------------------------------------------------------------------
// Post-level crawl (Reddit, Bloomberg)
// ---------------------------------------------------------------------------

/** Char count across all posts + comments in a list of extracted records. */
function expandedChars(records: ExtractedRecord[]): number {
  return records.reduce(
    (sum, r) =>
      sum +
      r.posts.reduce((s, p) => s + p.text.length, 0) +
      r.comments.reduce((s, c) => s + c.text.length, 0),
    0,
  );
}

type FeedDiscovery = { targets: ExpandTarget[]; scrollsDone: number };

/**
 * Tries to load more post links on the listing page. For infinite-scroll
 * sites (Reddit) this does one scroll at a time and checks for new links,
 * capped by maxFeedScrolls. For button-based sites (Bloomberg) it falls
 * back to the full paginate() + API capture approach.
 */
async function discoverMorePosts(
  page: Page,
  adapter: SiteAdapter,
  siteRule: SiteRule,
  visitedUrls: Set<string>,
  feedScrollsSoFar: number,
): Promise<FeedDiscovery> {
  const strategy = adapter.paginationStrategy();
  const remaining = siteRule.maxFeedScrolls - feedScrollsSoFar;

  if (strategy.type === "infinite-scroll") {
    // Limited single-scroll discovery — avoids endlessly scrolling the titles page
    if (remaining <= 0) {
      console.log("[engine] Feed scroll limit reached — no more listing scrolls");
      return { targets: [], scrollsDone: 0 };
    }

    console.log(`[engine] No new links, scrolling feed (${remaining} scrolls left)`);
    for (let i = 0; i < remaining; i++) {
      await scrollOnce(page);
      await randomWait(1800, 3500);

      const found = (await adapter.discoverExpandTargets(page, siteRule))
        .filter((t) => !visitedUrls.has(t.url));

      if (found.length > 0) {
        console.log(`[engine] Found ${found.length} new links after ${i + 1} scroll(s)`);
        return { targets: found, scrollsDone: i + 1 };
      }
    }
    console.log("[engine] No new links after scrolling feed");
    return { targets: [], scrollsDone: remaining };
  }

  // Load-more button (Bloomberg) — keep full paginate + API capture
  console.log("[engine] No new post links, paginating feed (load-more)…");
  const apiUrls: string[] = [];
  const captureHandler = async (res: { url(): string; status(): number; text(): Promise<string> }) => {
    try {
      if (res.url().includes("/api/stories") && res.status() === 200) {
        const body = await res.text();
        const matches = body.matchAll(/\/news\/articles\/[^"'\s,}]+/g);
        for (const m of matches) {
          apiUrls.push(`https://www.bloomberg.com${m[0].split("?")[0]}`);
        }
      }
    } catch { /* ignore */ }
  };
  page.on("response", captureHandler);
  await paginate(page, strategy, Number.MAX_SAFE_INTEGER, siteRule);
  page.off("response", captureHandler);

  let newTargets = (await adapter.discoverExpandTargets(page, siteRule))
    .filter((t) => !visitedUrls.has(t.url));

  // Fallback: use URLs captured from API responses
  if (newTargets.length === 0 && apiUrls.length > 0) {
    const unique = [...new Set(apiUrls)].filter((u) => !visitedUrls.has(u));
    console.log(`[engine] DOM unchanged, found ${unique.length} URLs from API response`);
    newTargets = unique.map((url) => ({ url, reason: "api-captured" }));
  }

  return { targets: newTargets, scrollsDone: 0 };
}

/**
 * Level 2 ("post"): Discover post links, click into each, extract.
 * URLs already in the store are skipped (no navigation). If the char
 * budget isn't met, return to feed and load more posts.
 * Returns an array of snapshots, one per post visited.
 */
async function crawlPostLevel(
  page: Page,
  adapter: SiteAdapter,
  siteRule: SiteRule,
  config: CrawlerConfig,
  runId: string,
  feedUrl: string,
  known: KnownContent,
): Promise<CrawlSnapshot[]> {
  const feedTitle = await page.evaluate(() => document.title);

  // Pre-seed with known URLs so already-visited posts are skipped
  const visitedUrls = new Set<string>(known.urls);
  const allExpanded: ExtractedRecord[] = [];
  let cumulativeChars = 0;
  let feedScrolls = 0; // Track total listing-page scrolls

  while (cumulativeChars < siteRule.maxChars) {
    const discovered = await adapter.discoverExpandTargets(page, siteRule);
    const knownSkipped = discovered.filter((t) => visitedUrls.has(t.url)).length;
    let newTargets = discovered.filter((t) => !visitedUrls.has(t.url));

    if (knownSkipped > 0) {
      console.log(`[engine] Skipped ${knownSkipped} known URLs from store`);
    }

    // No new links — try loading more posts on the feed (limited scrolling)
    if (newTargets.length === 0) {
      const discovery = await discoverMorePosts(
        page, adapter, siteRule, visitedUrls, feedScrolls,
      );
      feedScrolls += discovery.scrollsDone;
      newTargets = discovery.targets;

      if (newTargets.length === 0) {
        console.log("[engine] Feed exhausted — no more posts to discover");
        break;
      }
    }

    console.log(`[engine] Post-level: ${newTargets.length} new posts to visit`);
    for (const t of newTargets) {
      visitedUrls.add(t.url);
    }

    const remainingBudget = siteRule.maxChars - cumulativeChars;
    const expanded = await expandWithCharBudget(
      page, adapter, siteRule, newTargets, config.behavior, remainingBudget,
      known.texts,
    );

    allExpanded.push(...expanded);
    cumulativeChars = expandedChars(allExpanded);

    console.log(
      `[engine] ${progressBar(cumulativeChars, siteRule.maxChars)} ` +
      `${cumulativeChars}/${siteRule.maxChars} chars · ${allExpanded.length} posts visited`,
    );

    if (cumulativeChars < siteRule.maxChars) {
      console.log(`[engine] Returning to feed for more posts`);
      await page.goto(feedUrl, { waitUntil: "domcontentloaded" });
      await randomWait(config.behavior.waitMinMs, config.behavior.waitMaxMs);
    }
  }

  // Create separate snapshots for each post with its own comments
  const snapshots: CrawlSnapshot[] = [];
  const ts = nowStrings();

  for (const record of allExpanded) {
    if (!record.sourceUrl) {
      console.warn(`[engine] Skipping record without sourceUrl`);
      continue;
    }

    snapshots.push({
      id: crypto.randomUUID(),
      runId,
      site: adapter.site as SiteKey,
      sourceUrl: record.sourceUrl,
      canonicalUrl: canonicalizeUrl(record.sourceUrl),
      capturedAtIso: ts.iso,
      capturedAtLocal: ts.local,
      content: {
        title: record.title ?? feedTitle,
        posts: record.posts,
        comments: record.comments,
      },
      metrics: {
        postCount: record.posts.length,
        commentCount: record.comments.length,
        ...(record.metrics ?? {}),
      },
      expandedUrls: [record.sourceUrl],
    });
  }

  return snapshots;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runOnePass(
  context: BrowserContext,
  config: CrawlerConfig,
  store: JsonStore,
  runId: string,
  dryRun: boolean,
): Promise<void> {
  const limitedTargets = config.targets.slice(0, config.behavior.maxPagesPerRun);

  // Reuse the first existing page (preserves CDP context stability).
  // bringToFront ensures it's visible to the user during the crawl.
  const page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront();
  console.log(`[engine] Using page (${context.pages().length} tab(s) open) — brought to front`);

  page.setDefaultNavigationTimeout(config.behavior.navigationTimeoutMs);

  for (const target of limitedTargets) {
    const adapter = resolveAdapter(target);
    if (!adapter) {
      console.warn(`[engine] Skipping unsupported target: ${target}`);
      continue;
    }
    const siteRule = getSiteRule(config, new URL(target).hostname);

    // Load known content from store for cross-run dedup
    const known = store.getKnownContent(adapter.site, config.dedup.windowDays);
    if (known.texts.size > 0 || known.urls.size > 0) {
      console.log(
        `[engine] Loaded ${known.texts.size} known texts, ${known.urls.size} known URLs ` +
        `(last ${config.dedup.windowDays} days) from store for ${adapter.site}`,
      );
    }

    let attempt = 0;
    while (attempt <= config.behavior.retriesPerTarget) {
      attempt += 1;
      try {
        await page.bringToFront();
        console.log(`[engine] Visiting ${target} (attempt ${attempt})`);
        const navStart = Date.now();
        const response = await page.goto(target, { waitUntil: "domcontentloaded" });
        console.log(`[engine] Page loaded in ${Date.now() - navStart}ms — waiting…`);
        await randomWait(config.behavior.waitMinMs, config.behavior.waitMaxMs);
        console.log(`[engine] Humanizing page…`);
        await humanizeBeforeExtract(page, config.behavior);

        const nav = await collectNavDebug(page, target, response);
        console.log(
          `[engine] Nav status=${nav.status ?? "n/a"} title=${JSON.stringify(nav.title)} url=${nav.finalUrl}`,
        );
        if (nav.blockReason) {
          console.warn(`[engine] Possible bot-block signal: ${nav.blockReason}`);
          store.appendError({
            runId,
            site: adapter.site,
            sourceUrl: target,
            stage: "botBlockSignal",
            message: `Signal: ${nav.blockReason} (status=${nav.status ?? "n/a"} title=${nav.title})`,
          });
        }

        if (siteRule.contentLevel === "post") {
          const snapshots = await crawlPostLevel(page, adapter, siteRule, config, runId, target, known);
          
          let totalChars = 0;
          let totalPosts = 0;
          let totalComments = 0;

          for (const snapshot of snapshots) {
            totalChars += totalPostChars(snapshot);
            totalComments += snapshot.content.comments.length;
            totalPosts += snapshot.content.posts.length;

            if (!dryRun) {
              store.upsertSnapshot(snapshot);
            }
          }

          if (dryRun) {
            console.log(
              `[engine] Dry-run: ${totalChars} chars, ${totalPosts} posts, ${totalComments} comments from ${snapshots.length} individual post(s) at ${target}`,
            );
          } else {
            console.log(
              `[engine] Stored: ${totalChars} chars, ${totalPosts} posts, ${totalComments} comments from ${snapshots.length} individual post(s) at ${target}`,
            );
          }
        } else {
          const snapshot = await crawlFeedLevel(page, adapter, siteRule, runId, target, known);
          
          const charCount = totalPostChars(snapshot);
          const commentCount = snapshot.content.comments.length;
          const postCount = snapshot.content.posts.length;

          if (dryRun) {
            console.log(
              `[engine] Dry-run: ${charCount} chars, ${postCount} posts, ${commentCount} comments from ${target}`,
            );
          } else {
            store.upsertSnapshot(snapshot);
            console.log(
              `[engine] Stored: ${charCount} chars, ${postCount} posts, ${commentCount} comments for ${target}`,
            );
          }
        }
        break;
      } catch (error) {
        const message = (error as Error).message;
        console.warn(`[engine] Failed target ${target} on attempt ${attempt}: ${message}`);
        store.appendError({
          runId,
          site: adapter.site,
          sourceUrl: target,
          stage: "runOnePass",
          message,
        });
        if (attempt > config.behavior.retriesPerTarget) {
          console.error(`[engine] Giving up on ${target}`);
        }
      }
    }
  }
}
