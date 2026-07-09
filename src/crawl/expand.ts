import { Page } from "playwright";
import { SiteAdapter, ExpandTarget, ExtractedRecord } from "../sites/types";
import { SiteRule, Behavior } from "../config/types";
import { randomWait, humanizeBeforeExtract } from "../browser/humanize";
import { progressBar } from "./progress";

/** Total chars across all posts and comments in an extracted record. */
function recordChars(record: ExtractedRecord): number {
  const postChars = record.posts.reduce((sum, p) => sum + p.text.length, 0);
  const commentChars = record.comments.reduce((sum, c) => sum + c.text.length, 0);
  return postChars + commentChars;
}

/** Removes items whose text is already in knownTexts. */
function filterKnown(record: ExtractedRecord, knownTexts: Set<string>): ExtractedRecord {
  return {
    ...record,
    posts: record.posts.filter((p) => !knownTexts.has(p.text)),
    comments: record.comments.filter((c) => !knownTexts.has(c.text)),
  };
}

export type ExpandResult = {
  records: ExtractedRecord[];
  /** True when expansion stopped because a post was older than rule.maxAgeDays. */
  agedOut: boolean;
};

/**
 * Visits posts one-by-one and accumulates chars. Known content
 * (already in store) is filtered out and doesn't count toward budget.
 * Stops at the char budget OR the first post older than rule.maxAgeDays
 * (listings are sorted newest-first, so everything after is older still).
 */
export async function expandWithCharBudget(
  page: Page,
  adapter: SiteAdapter,
  rule: SiteRule,
  targets: ExpandTarget[],
  behavior: Behavior,
  maxChars: number,
  knownTexts?: Set<string>,
): Promise<ExpandResult> {
  const expanded: ExtractedRecord[] = [];
  let cumulativeChars = 0;
  let agedOut = false;
  const cutoffMs = Date.now() - rule.maxAgeDays * 86_400_000;

  for (const target of targets) {
    if (cumulativeChars >= maxChars) {
      console.log(`[expand] Budget reached, stopping`);
      break;
    }

    try {
      console.log(
        `[expand] ${progressBar(cumulativeChars, maxChars)} ` +
        `${cumulativeChars}/${maxChars} chars · Opening ${target.url}`,
      );
      await page.goto(target.url, { waitUntil: "domcontentloaded" });
      await randomWait(behavior.waitMinMs, behavior.waitMaxMs);
      await humanizeBeforeExtract(page, behavior);

      let extracted = await adapter.extractBase(page, rule);

      // Add the source URL to the extracted record
      extracted.sourceUrl = target.url;

      // Age horizon: stop at the first post older than maxAgeDays (checked before
      // known-content filtering so the post's own timestamp is still present)
      const postTs = extracted.posts[0]?.timestamp;
      if (postTs) {
        const t = Date.parse(postTs);
        if (!isNaN(t) && t < cutoffMs) {
          console.log(
            `[expand] Post dated ${postTs.slice(0, 10)} is older than ${rule.maxAgeDays} days — stopping`,
          );
          agedOut = true;
          break;
        }
      }

      // Filter out content already in the store
      if (knownTexts && knownTexts.size > 0) {
        const before = extracted.posts.length + extracted.comments.length;
        extracted = filterKnown(extracted, knownTexts);
        const after = extracted.posts.length + extracted.comments.length;
        if (before > after) {
          console.log(`[expand] Filtered ${before - after} known items from ${target.url}`);
        }
      }

      const chars = recordChars(extracted);
      if (chars === 0) {
        console.log(`[expand] All content already known, skipping`);
        continue;
      }

      expanded.push(extracted);
      cumulativeChars += chars;

      console.log(
        `[expand] ${progressBar(cumulativeChars, maxChars)} ` +
        `${cumulativeChars}/${maxChars} chars · +${chars} from post`,
      );
    } catch (error) {
      console.warn(`[expand] Failed on ${target.url}: ${(error as Error).message}`);
    }
  }

  console.log(`[expand] Done: ${expanded.length} posts, ${cumulativeChars} total chars`);
  return { records: expanded, agedOut };
}
