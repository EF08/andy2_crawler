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

/**
 * Visits posts one-by-one and accumulates chars. Known content
 * (already in store) is filtered out and doesn't count toward budget.
 */
export async function expandWithCharBudget(
  page: Page,
  adapter: SiteAdapter,
  rule: SiteRule,
  targets: ExpandTarget[],
  behavior: Behavior,
  maxChars: number,
  knownTexts?: Set<string>,
): Promise<ExtractedRecord[]> {
  const expanded: ExtractedRecord[] = [];
  let cumulativeChars = 0;

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
  return expanded;
}
