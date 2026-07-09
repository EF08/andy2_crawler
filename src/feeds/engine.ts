import crypto from "node:crypto";
import { DateTime } from "luxon";
import { CrawlerConfig } from "../config/types";
import { canonicalizeUrl } from "../extract/normalize";
import { JsonStore } from "../store/jsonStore";
import { CrawlSnapshot } from "../store/schema";
import { fetchEdgar } from "./edgar";
import { fetchGlobeNewswire } from "./globenewswire";
import { fetchGoogleNews } from "./googleNews";
import { FeedItem, FeedSourceCounts } from "./types";

export type FeedsPassResult = {
  stored: number;
  perSource: Record<string, FeedSourceCounts>;
  errors: number;
};

function nowStrings(): { iso: string; local: string } {
  const now = DateTime.local();
  return {
    iso: now.toUTC().toISO() ?? new Date().toISOString(),
    local: now.toFormat("yyyy-LL-dd HH:mm:ss ZZZZ"),
  };
}

/** Deterministic snapshot id: the same headline/filing maps to the same id on every
 *  pull, so re-ingesting is a no-op all the way through to the backend's upsert. */
function feedSnapshotId(site: string, canonicalUrl: string): string {
  return crypto.createHash("sha256").update(`feed\n${site}\n${canonicalUrl}`).digest("hex").slice(0, 32);
}

/** Newest first; items without a parseable timestamp keep their feed position. */
function sortNewestFirst(items: FeedItem[]): FeedItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ta = a.item.timestamp ? Date.parse(a.item.timestamp) : NaN;
      const tb = b.item.timestamp ? Date.parse(b.item.timestamp) : NaN;
      if (isNaN(ta) && isNaN(tb)) return a.i - b.i;
      if (isNaN(ta)) return -1;
      if (isNaN(tb)) return 1;
      return tb - ta;
    })
    .map((x) => x.item);
}

/**
 * Turn one source's fetched items into snapshots: newest first, skip items already in
 * the store (they don't spend budget), skip items past the age horizon, and accumulate
 * NEW text until the char budget (the item that crosses the limit is included).
 */
function buildSnapshots(
  items: FeedItem[],
  maxChars: number,
  maxAgeDays: number,
  store: JsonStore,
  runId: string,
  seenThisRun: Set<string>,
): { snapshots: CrawlSnapshot[]; counts: FeedSourceCounts } {
  const counts: FeedSourceCounts = { fetched: items.length, stored: 0, skippedKnown: 0, skippedOld: 0, chars: 0 };
  const snapshots: CrawlSnapshot[] = [];
  const cutoffMs = Date.now() - maxAgeDays * 86_400_000;

  for (const item of sortNewestFirst(items)) {
    const canonical = canonicalizeUrl(item.url);
    if (seenThisRun.has(canonical)) continue;
    seenThisRun.add(canonical);

    if (item.timestamp) {
      const t = Date.parse(item.timestamp);
      if (!isNaN(t) && t < cutoffMs) { counts.skippedOld++; continue; }
    }
    if (store.hasSnapshotFor(item.site, canonical)) { counts.skippedKnown++; continue; }

    const ts = nowStrings();
    snapshots.push({
      id: feedSnapshotId(item.site, canonical),
      runId,
      site: item.site,
      sourceUrl: item.url,
      canonicalUrl: canonical,
      capturedAtIso: ts.iso,
      capturedAtLocal: ts.local,
      content: {
        title: item.title,
        posts: [{ text: item.text, author: item.author, timestamp: item.timestamp }],
        comments: [],
      },
      metrics: { ...item.metrics, totalChars: item.text.length },
    });
    counts.stored++;
    counts.chars += item.text.length;
    if (counts.chars >= maxChars) break;
  }

  return { snapshots, counts };
}

/**
 * Pull all enabled HTTP feeds (market news + EDGAR) and store one snapshot per new
 * headline/filing. A source that fails never breaks the others. Returns counts;
 * snapshots land in the store under `runId`, so the run's normal backend push
 * (store.getSnapshotsByRun) picks them up with zero extra plumbing.
 */
export async function runFeedsPass(
  config: CrawlerConfig,
  store: JsonStore,
  runId: string,
  dryRun: boolean,
): Promise<FeedsPassResult> {
  const cfg = config.feeds;
  const result: FeedsPassResult = { stored: 0, perSource: {}, errors: 0 };
  const seenThisRun = new Set<string>();

  const sources: Array<{ site: FeedItem["site"]; enabled: boolean; maxChars: number; fetch: () => Promise<FeedItem[]> }> = [
    { site: "globenewswire.com", enabled: cfg.globenewswire.enabled, maxChars: cfg.globenewswire.maxChars, fetch: () => fetchGlobeNewswire(cfg) },
    { site: "news.google.com", enabled: cfg.googleNews.enabled, maxChars: cfg.googleNews.maxChars, fetch: () => fetchGoogleNews(cfg) },
    { site: "sec.gov", enabled: cfg.edgar.enabled, maxChars: cfg.edgar.maxChars, fetch: () => fetchEdgar(cfg) },
  ];

  const toStore: CrawlSnapshot[] = [];
  for (const source of sources) {
    if (!source.enabled) continue;
    try {
      const items = await source.fetch();
      const { snapshots, counts } = buildSnapshots(items, source.maxChars, cfg.maxAgeDays, store, runId, seenThisRun);
      toStore.push(...snapshots);
      result.perSource[source.site] = counts;
      result.stored += counts.stored;
      console.log(
        `[feeds] ${source.site}: ${counts.fetched} fetched → ${counts.stored} new · ${counts.chars} chars` +
          (counts.skippedKnown ? ` (${counts.skippedKnown} known)` : "") +
          (counts.skippedOld ? ` (${counts.skippedOld} too old)` : ""),
      );
    } catch (error) {
      result.errors++;
      const message = (error as Error).message;
      console.warn(`[feeds] ${source.site} FAILED: ${message}`);
      if (!dryRun) {
        store.appendError({ runId, site: source.site, sourceUrl: "feeds", stage: "feeds-fetch", message });
      }
    }
  }

  if (dryRun) {
    console.log(`[feeds] Dry-run: ${toStore.length} snapshot(s) NOT stored.`);
  } else if (toStore.length > 0) {
    store.upsertMany(toStore);
    console.log(`[feeds] Stored ${toStore.length} snapshot(s) across ${Object.keys(result.perSource).length} source(s).`);
  } else {
    console.log(`[feeds] Nothing new to store.`);
  }

  return result;
}
