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
import { canFocusBrowserWindow } from "../browser/session";
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
  listName?: string,
): Promise<CrawlSnapshot> {
  // Pre-seed with known texts so duplicates are auto-skipped
  const seenTexts = new Set<string>(known.texts);
  const allPosts: ContentItem[] = [];
  let cumulativeChars = 0;
  let totalSkipped = 0;
  let totalTooOld = 0;
  let feedTitle = "";
  // Consecutive scroll batches that had posts but nothing new — on a
  // chronological feed that means we're caught up (everything deeper is older).
  let allKnownStreak = 0;

  // Age horizon: posts older than maxAgeDays are skipped; a whole batch of them stops the run
  const cutoffMs = Date.now() - siteRule.maxAgeDays * 86_400_000;
  const tooOld = (ts?: string): boolean => {
    if (!ts) return false; // no parseable timestamp → keep
    const t = Date.parse(ts);
    return !isNaN(t) && t < cutoffMs;
  };

  // Extract initial visible content
  const initial = await adapter.extractBase(page, siteRule);
  feedTitle = initial.title ?? "";
  for (const post of initial.posts) {
    if (!post.text) continue;
    if (tooOld(post.timestamp)) { totalTooOld++; continue; }
    if (seenTexts.has(post.text)) { totalSkipped++; continue; }
    seenTexts.add(post.text);
    allPosts.push(post);
    cumulativeChars += post.text.length;
  }
  if (initial.posts.some((p) => p.text) && allPosts.length === 0) allKnownStreak = 1;

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

    // Extract visible posts — skip known and too-old content
    const batch = await adapter.extractBase(page, siteRule);
    let newInBatch = 0;
    let skippedInBatch = 0;
    let oldInBatch = 0;
    let datedInBatch = 0;
    for (const post of batch.posts) {
      if (!post.text) continue;
      if (post.timestamp && !isNaN(Date.parse(post.timestamp))) datedInBatch++;
      if (tooOld(post.timestamp)) { oldInBatch++; totalTooOld++; continue; }
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
    if (oldInBatch > 0) msg += ` (${oldInBatch} too old)`;
    console.log(msg);

    // Every dated post in the batch is past the age horizon → deeper scrolling only gets older
    if (datedInBatch > 0 && oldInBatch === datedInBatch) {
      console.log(`[crawl] Feed content is older than ${siteRule.maxAgeDays} days — stopping`);
      break;
    }

    // Chronological catch-up: batches keep rendering posts but none are new →
    // everything deeper is older and already stored. Don't scroll to the age horizon.
    const postsInBatch = batch.posts.filter((p) => p.text).length;
    if (postsInBatch > 0 && newInBatch === 0) {
      allKnownStreak++;
      if (allKnownStreak >= siteRule.stopAfterKnownBatches) {
        console.log(
          `[crawl] ${allKnownStreak} consecutive batches with nothing new — feed is caught up, stopping`,
        );
        break;
      }
    } else if (newInBatch > 0) {
      allKnownStreak = 0;
    }
  }

  if (totalSkipped > 0) {
    console.log(`[crawl] Total skipped: ${totalSkipped} known posts from store`);
  }
  if (totalTooOld > 0) {
    console.log(`[crawl] Total skipped: ${totalTooOld} posts older than ${siteRule.maxAgeDays} days`);
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
    ...(listName ? { listName } : {}),
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
    const expandResult = await expandWithCharBudget(
      page, adapter, siteRule, newTargets, config.behavior, remainingBudget,
      known.texts,
    );

    allExpanded.push(...expandResult.records);
    cumulativeChars = expandedChars(allExpanded);

    console.log(
      `[engine] ${progressBar(cumulativeChars, siteRule.maxChars)} ` +
      `${cumulativeChars}/${siteRule.maxChars} chars · ${allExpanded.length} posts visited`,
    );

    // Listing is sorted newest-first — a too-old post means everything further is older
    if (expandResult.agedOut) {
      console.log(`[engine] Reached posts older than ${siteRule.maxAgeDays} days — stopping this target`);
      break;
    }

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
// Overflow: /home topic tabs + For You (leftover X budget only)
// ---------------------------------------------------------------------------

type SourceChars = { name: string; chars: number };

/**
 * Spends the leftover X char budget on the /home pinned tabs, in tab-bar order,
 * finishing with the For You timeline itself. Tabs matching an xLists name are
 * skipped (first match wins, so a topic tab that shares a list's name — e.g. the
 * second "AI" — still gets crawled). Tabs have no URLs of their own: each source
 * is reached by clicking its tab, then crawled feed-level like a list.
 */
async function crawlHomeOverflow(
  page: Page,
  config: CrawlerConfig,
  store: JsonStore,
  runId: string,
  dryRun: boolean,
  budget: number,
): Promise<SourceChars[]> {
  const adapter = resolveAdapter("https://x.com/home");
  if (!adapter) return [];
  const baseRule = config.siteRules.xCom;

  console.log(`[engine] Overflow: ${budget} X chars unspent — moving to /home topic tabs`);
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
  await randomWait(config.behavior.waitMinMs, config.behavior.waitMaxMs);

  const tabTexts: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).map(
      (t) => (t.textContent ?? "").trim(),
    ),
  );
  if (tabTexts.length < 2) {
    console.warn("[engine] Overflow: no /home tab bar found — skipping overflow pass");
    return [];
  }

  // Everything after "For you"/"Following" that isn't one of the xLists,
  // in tab order; For You itself goes last.
  const unusedListNames = config.xLists.map((l) => l.name);
  const sources: Array<{ tabIndex: number; name: string }> = [];
  for (let i = 2; i < tabTexts.length; i++) {
    const listIdx = unusedListNames.indexOf(tabTexts[i]);
    if (listIdx >= 0) {
      unusedListNames.splice(listIdx, 1);
      continue;
    }
    sources.push({ tabIndex: i, name: tabTexts[i] });
  }
  sources.push({ tabIndex: 0, name: "For you" });

  let budgetLeft = budget;
  let weightLeft = sources.length;
  const spent: SourceChars[] = [];

  for (const source of sources) {
    // Equal split of whatever is still unspent — a thin tab spills to the rest.
    const cap = weightLeft > 0 ? Math.floor(budgetLeft / weightLeft) : 0;
    weightLeft--;
    if (cap < 1) {
      console.log(`[engine] Overflow "${source.name}": X char budget exhausted — skipping`);
      continue;
    }

    try {
      await page
        .locator('[role="tablist"] [role="tab"]')
        .nth(source.tabIndex)
        .click({ timeout: 10_000 });
    } catch (error) {
      const message = (error as Error).message;
      console.warn(`[engine] Overflow "${source.name}": tab click failed — ${message}`);
      store.appendError({
        runId,
        site: adapter.site,
        sourceUrl: "https://x.com/home",
        stage: "overflowTabClick",
        message: `${source.name}: ${message}`,
      });
      continue;
    }
    await randomWait(config.behavior.waitMinMs, config.behavior.waitMaxMs);

    const label = `overflow:${source.name}`;
    console.log(`[engine] Overflow "${source.name}": char budget ${cap} of ${budgetLeft} unspent`);

    try {
      const known = store.getKnownContent(adapter.site, config.dedup.windowDays);
      const rule = { ...baseRule, maxChars: cap };
      // Distinct sourceUrl per tab — canonicalizeUrl keeps query params, so each
      // source gets its own slot in the store.
      const sourceUrl = `https://x.com/home?tab=${encodeURIComponent(source.name)}&pos=${source.tabIndex}`;
      const snapshot = await crawlFeedLevel(page, adapter, rule, runId, sourceUrl, known, label);

      const chars = totalPostChars(snapshot);
      budgetLeft = Math.max(0, budgetLeft - chars);
      spent.push({ name: label, chars });

      if (dryRun) {
        console.log(`[engine] Dry-run: ${chars} chars, ${snapshot.content.posts.length} posts from ${label}`);
      } else {
        store.upsertSnapshot(snapshot);
        console.log(`[engine] Stored: ${chars} chars, ${snapshot.content.posts.length} posts for ${label}`);
      }
    } catch (error) {
      const message = (error as Error).message;
      console.warn(`[engine] Overflow "${source.name}" failed: ${message}`);
      store.appendError({
        runId,
        site: adapter.site,
        sourceUrl: "https://x.com/home",
        stage: "overflowCrawl",
        message: `${source.name}: ${message}`,
      });
    }
  }

  return spent;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

type PlannedTarget = { url: string; listName?: string; weight?: number };

export async function runOnePass(
  context: BrowserContext,
  config: CrawlerConfig,
  store: JsonStore,
  runId: string,
  dryRun: boolean,
): Promise<void> {
  // X Lists first (highest weight first — they claim shared tweets on dedup),
  // then the regular targets. maxPagesPerRun caps only the regular targets.
  const listTargets: PlannedTarget[] = [...config.xLists]
    .sort((a, b) => b.weight - a.weight)
    .map((l) => ({ url: l.url, listName: l.name, weight: l.weight }));
  const genericTargets: PlannedTarget[] = config.targets
    .slice(0, config.behavior.maxPagesPerRun)
    .map((url) => ({ url }));
  const plan = [...listTargets, ...genericTargets];

  // The lists share ONE X char budget (siteRules.xCom.maxChars), split by weight.
  // Each list's cap is its weight-share of whatever budget is still unspent, so a
  // list with little new content spills its leftover to the lists after it.
  let xBudgetLeft = config.siteRules.xCom.maxChars;
  let xWeightLeft = listTargets.reduce((sum, t) => sum + (t.weight ?? 0), 0);
  const xSummary: SourceChars[] = [];

  // Reuse the first existing page (preserves CDP context stability).
  // bringToFront makes it the active tab, which also raises the OS window — so it
  // is skipped when the window is deliberately parked behind everything else.
  const mayFocus = canFocusBrowserWindow(config);
  const page = context.pages()[0] ?? (await context.newPage());
  if (mayFocus) await page.bringToFront();
  console.log(
    `[engine] Using page (${context.pages().length} tab(s) open)` +
      (mayFocus ? " — brought to front" : " — left in the background"),
  );

  page.setDefaultNavigationTimeout(config.behavior.navigationTimeoutMs);

  for (const planned of plan) {
    const target = planned.url;
    const adapter = resolveAdapter(target);
    if (!adapter) {
      console.warn(`[engine] Skipping unsupported target: ${target}`);
      continue;
    }
    let siteRule = getSiteRule(config, new URL(target).hostname);

    if (planned.listName) {
      const weight = planned.weight ?? 0;
      const cap = xWeightLeft > 0 ? Math.floor((xBudgetLeft * weight) / xWeightLeft) : 0;
      xWeightLeft -= weight;
      if (cap < 1) {
        console.log(`[engine] Skipping list "${planned.listName}" — X char budget exhausted`);
        continue;
      }
      siteRule = { ...siteRule, maxChars: cap };
      console.log(`[engine] List "${planned.listName}": char budget ${cap} of ${xBudgetLeft} unspent`);
    }

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
        if (mayFocus) await page.bringToFront();
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
          const snapshot = await crawlFeedLevel(
            page, adapter, siteRule, runId, target, known, planned.listName,
          );

          const charCount = totalPostChars(snapshot);
          const commentCount = snapshot.content.comments.length;
          const postCount = snapshot.content.posts.length;

          if (planned.listName) {
            xBudgetLeft = Math.max(0, xBudgetLeft - charCount);
            xSummary.push({ name: planned.listName, chars: charCount });
          }

          const label = planned.listName ? `list "${planned.listName}" (${target})` : target;
          if (dryRun) {
            console.log(
              `[engine] Dry-run: ${charCount} chars, ${postCount} posts, ${commentCount} comments from ${label}`,
            );
          } else {
            store.upsertSnapshot(snapshot);
            console.log(
              `[engine] Stored: ${charCount} chars, ${postCount} posts, ${commentCount} comments for ${label}`,
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

  // Overflow pass (opt-in): leftover X budget → /home topic tabs, For You last.
  if (config.xOverflow.enabled) {
    if (xBudgetLeft >= config.xOverflow.minLeftoverChars) {
      try {
        const overflowSpent = await crawlHomeOverflow(page, config, store, runId, dryRun, xBudgetLeft);
        xSummary.push(...overflowSpent);
      } catch (error) {
        console.warn(`[engine] Overflow pass failed: ${(error as Error).message}`);
        store.appendError({
          runId,
          site: "x.com",
          sourceUrl: "https://x.com/home",
          stage: "overflowPass",
          message: (error as Error).message,
        });
      }
    } else {
      console.log(
        `[engine] Overflow: skipped — leftover ${xBudgetLeft} chars < minLeftoverChars ` +
        `${config.xOverflow.minLeftoverChars}`,
      );
    }
  }

  if (xSummary.length > 0) {
    const total = xSummary.reduce((sum, entry) => sum + entry.chars, 0);
    console.log(
      `[engine] X chars by source: ${xSummary.map((e) => `${e.name}=${e.chars}`).join(", ")}` +
      ` · total=${total}/${config.siteRules.xCom.maxChars}`,
    );
  }
}
