import { Page } from "playwright";
import { PaginationStrategy } from "../sites/types";
import { SiteRule } from "../config/types";
import { randomWait } from "../browser/humanize";
import { progressBar } from "./progress";

/** Measures char length of content matching a selector (or full body). */
async function measureContent(page: Page, selector?: string): Promise<number> {
  return page.evaluate((sel) => {
    if (sel && sel !== "body") {
      const nodes = Array.from(document.querySelectorAll(sel));
      return nodes.reduce((sum, n) => sum + (n.textContent?.length ?? 0), 0);
    }
    return document.body?.innerText?.length ?? 0;
  }, selector);
}

/** Returns current page scroll height. */
export async function getScrollHeight(page: Page): Promise<number> {
  return page.evaluate(() => document.body.scrollHeight);
}

/** Scrolls to page bottom to trigger infinite-scroll loading. */
export async function scrollOnce(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
}

/** Human-readable target label — hides Number.MAX_SAFE_INTEGER. */
function targetLabel(targetChars: number): string {
  return targetChars >= Number.MAX_SAFE_INTEGER ? "until stall" : `target=${targetChars}`;
}

/**
 * Loads content via infinite scroll. Uses scrollHeight for stall
 * detection (works with virtualized DOMs like X/Twitter).
 * NOTE: For feed-level crawling (X), use crawlFeedLevel instead —
 * it accumulates content while scrolling. This is only used for
 * post-level feed discovery.
 */
async function scrollToFill(
  page: Page,
  targetChars: number,
  stallLimit: number,
  contentSelector?: string,
): Promise<{ totalChars: number; scrolls: number }> {
  let prevHeight = await getScrollHeight(page);
  let stallCount = 0;
  let scrolls = 0;

  const initialChars = await measureContent(page, contentSelector);
  if (initialChars >= targetChars) {
    console.log(`[paginate] Already at target: ${initialChars} chars`);
    return { totalChars: initialChars, scrolls: 0 };
  }

  while (true) {
    await scrollOnce(page);
    await randomWait(1800, 3500);
    scrolls++;

    const height = await getScrollHeight(page);

    if (scrolls % 5 === 0) {
      console.log(`[paginate] ${scrolls} scrolls, height=${height}`);
    }

    if (height <= prevHeight) {
      stallCount++;
      if (stallCount >= stallLimit) {
        console.log(`[paginate] Feed exhausted after ${scrolls} scrolls`);
        return { totalChars: await measureContent(page, contentSelector), scrolls };
      }
    } else {
      stallCount = 0;
    }
    prevHeight = height;
  }
}

/**
 * Loads content by clicking a "Load more" button. Heavy debug logging
 * to diagnose button-click failures (e.g. Bloomberg).
 */
async function clickToFill(
  page: Page,
  targetChars: number,
  stallLimit: number,
  buttonSelector: string,
  contentSelector?: string,
): Promise<{ totalChars: number; clicks: number }> {
  let prevLen = await measureContent(page, contentSelector);
  let stallCount = 0;
  let clicks = 0;

  if (prevLen >= targetChars) {
    console.log(`[paginate] Already at target: ${prevLen} chars`);
    return { totalChars: prevLen, clicks: 0 };
  }

  while (true) {
    // --- Debug: find the button ---
    const btn = page.locator(buttonSelector).first();
    const count = await page.locator(buttonSelector).count().catch(() => 0);
    const visible = await btn.isVisible().catch(() => false);
    const box = visible ? await btn.boundingBox().catch(() => null) : null;

    console.log(
      `[paginate] Button search: matches=${count} visible=${visible}` +
      (box ? ` box=(${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)})` : ""),
    );

    if (!visible) {
      console.log(`[paginate] No visible button after ${clicks} clicks (${prevLen} chars)`);
      return { totalChars: prevLen, clicks };
    }

    // --- Scroll into view, small pause, then click ---
    try {
      await btn.scrollIntoViewIfNeeded();
      await randomWait(400, 800);
      await btn.click({ timeout: 5000 });
      console.log(`[paginate] Click OK (attempt: normal)`);
    } catch (err) {
      console.warn(`[paginate] Normal click failed: ${(err as Error).message}`);
      // Retry with force (skips actionability checks)
      try {
        await btn.click({ force: true, timeout: 5000 });
        console.log(`[paginate] Click OK (attempt: force)`);
      } catch (err2) {
        console.warn(`[paginate] Force click also failed: ${(err2 as Error).message}`);
        return { totalChars: prevLen, clicks };
      }
    }

    await randomWait(2000, 4000);
    clicks++;

    const chars = await measureContent(page, contentSelector);
    console.log(`[paginate] After click ${clicks}: ${chars} chars (prev=${prevLen})`);

    if (chars >= targetChars) {
      console.log(`[paginate] Target reached: ${chars} chars (${clicks} clicks)`);
      return { totalChars: chars, clicks };
    }

    if (chars <= prevLen) {
      stallCount++;
      if (stallCount >= stallLimit) {
        console.log(`[paginate] Stalled at ${chars} chars (${clicks} clicks)`);
        return { totalChars: chars, clicks };
      }
    } else {
      stallCount = 0;
    }
    prevLen = chars;
  }
}

/**
 * Main entry point for pagination — used by post-level discovery
 * (scroll to find more posts, click "Load more" on Bloomberg).
 */
export async function paginate(
  page: Page,
  strategy: PaginationStrategy,
  targetChars: number,
  rule: SiteRule,
): Promise<void> {
  console.log(`[paginate] Starting ${strategy.type} pagination (${targetLabel(targetChars)})`);

  if (strategy.type === "infinite-scroll") {
    await scrollToFill(page, targetChars, rule.stallLimit, strategy.contentSelector);
  } else {
    await clickToFill(page, targetChars, rule.stallLimit, strategy.buttonSelector, strategy.contentSelector);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await randomWait(300, 600);
}
