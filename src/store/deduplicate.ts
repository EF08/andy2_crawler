import fs from "node:fs";
import path from "node:path";
import { ContentItem, CrawlSnapshot, CrawlStore } from "./schema";

const STORE_PATH = path.resolve(__dirname, "../../data/crawl-store.json");

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Remove ContentItems with duplicate or substring text.
 * Keeps the longest version of each overlapping text.
 */
function deduplicateItems(items: ContentItem[]): ContentItem[] {
  // Deduplicate by exact text match (keep first occurrence)
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    if (seen.has(item.text)) return false;
    seen.add(item.text);
    return true;
  });

  // Remove items whose text is a substring of a longer item
  const sorted = unique.slice().sort((a, b) => b.text.length - a.text.length);
  const kept: ContentItem[] = [];

  for (const item of sorted) {
    if (!kept.some((longer) => longer.text.includes(item.text))) {
      kept.push(item);
    }
  }

  // Restore original order
  return kept.sort((a, b) => unique.indexOf(a) - unique.indexOf(b));
}

/** Build a fingerprint for a snapshot based on its post content. */
function contentFingerprint(snap: CrawlSnapshot): string {
  const postText = snap.content.posts.map((p) => p.text).join("|");
  return `${snap.content.title ?? ""}|${postText.slice(0, 500)}`;
}

// ── Per-snapshot dedup ───────────────────────────────────────────────

/** Deduplicate posts and comments inside a single snapshot (mutates in place). */
function deduplicateSnapshot(snap: CrawlSnapshot): void {
  snap.content.posts = deduplicateItems(snap.content.posts);
  snap.content.comments = deduplicateItems(snap.content.comments);
}

// ── History dedup ────────────────────────────────────────────────────

/**
 * For each URL's history array, collapse entries with identical content
 * into a single entry (keep the most recent capture).
 */
function deduplicateHistory(
  history: Record<string, Record<string, CrawlSnapshot[]>>,
): { cleaned: typeof history; removedIds: Set<string> } {
  const removedIds = new Set<string>();

  for (const site of Object.keys(history)) {
    for (const url of Object.keys(history[site])) {
      const snaps = history[site][url];
      const seen = new Map<string, CrawlSnapshot>();

      for (const snap of snaps) {
        const fp = contentFingerprint(snap);
        const existing = seen.get(fp);

        if (!existing) {
          seen.set(fp, snap);
        } else {
          // Keep the more recent capture
          const existingTime = new Date(existing.capturedAtIso).getTime();
          const currentTime = new Date(snap.capturedAtIso).getTime();
          if (currentTime > existingTime) {
            removedIds.add(existing.id);
            seen.set(fp, snap);
          } else {
            removedIds.add(snap.id);
          }
        }
      }

      history[site][url] = [...seen.values()];
    }
  }

  return { cleaned: history, removedIds };
}

// ── Error dedup ──────────────────────────────────────────────────────

function deduplicateErrors(errors: CrawlStore["errors"]): CrawlStore["errors"] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.runId}|${e.site}|${e.sourceUrl}|${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Index cleanup ────────────────────────────────────────────────────

/** Remove duplicate IDs and purge any IDs that were removed from history. */
function cleanIndex(
  index: Record<string, string[]>,
  removedIds: Set<string>,
): Record<string, string[]> {
  const cleaned: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(index)) {
    const deduped = [...new Set(ids)].filter((id) => !removedIds.has(id));
    if (deduped.length > 0) cleaned[key] = deduped;
  }
  return cleaned;
}

// ── Exported dedup function ──────────────────────────────────────────

/** Run full dedup pass on a store file. Callable from anywhere. */
export function deduplicateStore(storePath: string): void {
  if (!fs.existsSync(storePath)) {
    console.warn(`[dedup] Store not found at ${storePath}, skipping`);
    return;
  }

  const raw = fs.readFileSync(storePath, "utf-8");
  const store: CrawlStore = JSON.parse(raw);
  const originalSize = Buffer.byteLength(raw, "utf-8");

  console.log(`[dedup] Loaded store (${(originalSize / 1024).toFixed(1)} KB)`);

  // 1. Deduplicate within each "latest" snapshot
  let latestCount = 0;
  for (const site of Object.values(store.latest)) {
    for (const snap of Object.values(site)) {
      deduplicateSnapshot(snap);
      latestCount++;
    }
  }
  console.log(`[dedup] Cleaned ${latestCount} latest snapshots`);

  // 2. Deduplicate within each history snapshot, then collapse duplicates
  let historySnapCount = 0;
  for (const site of Object.values(store.history)) {
    for (const snaps of Object.values(site)) {
      for (const snap of snaps) {
        deduplicateSnapshot(snap);
        historySnapCount++;
      }
    }
  }
  console.log(`[dedup] Cleaned ${historySnapCount} history snapshots`);

  const { removedIds } = deduplicateHistory(store.history);
  console.log(`[dedup] Removed ${removedIds.size} duplicate history entries`);

  // 3. Deduplicate errors
  const errorsBefore = store.errors.length;
  store.errors = deduplicateErrors(store.errors);
  console.log(`[dedup] Errors: ${errorsBefore} → ${store.errors.length}`);

  // 4. Clean indexes
  store.index.runs = cleanIndex(store.index.runs, removedIds);
  store.index.byDate = cleanIndex(store.index.byDate, removedIds);
  console.log(`[dedup] Index entries pruned of ${removedIds.size} removed IDs`);

  // 5. Write back
  const output = JSON.stringify(store, null, 2);
  const newSize = Buffer.byteLength(output, "utf-8");
  fs.writeFileSync(storePath, output, "utf-8");

  const saved = originalSize - newSize;
  const pct = originalSize > 0 ? ((saved / originalSize) * 100).toFixed(1) : "0.0";
  console.log(
    `[dedup] Done: ${(originalSize / 1024).toFixed(1)} KB → ${(newSize / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB / ${pct}%)`,
  );
}

// ── CLI entrypoint (npm run dedup) ──────────────────────────────────

if (require.main === module) {
  deduplicateStore(STORE_PATH);
}
