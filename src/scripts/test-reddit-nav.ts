/**
 * Reddit navigation smoke test: verifies discover → click → extract flow.
 * Takes a screenshot after every action for visual debugging.
 * Run: npx tsx src/scripts/test-reddit-nav.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader";
import { launchSession } from "../browser/session";
import { humanizeBeforeExtract, randomWait } from "../browser/humanize";
import { RedditAdapter } from "../sites/reddit.adapter";
import { SiteRule } from "../config/types";

const SEARCH_URL =
  "https://www.reddit.com/r/wallstreetbets/search/?q=flair%3ADD&include_over_18=on&sort=new";

const RULE: SiteRule = {
  maxChars: 85000,
  maxCharsPerComment: 900,
  contentLevel: "post",
  stallLimit: 3,
  maxFeedScrolls: 5,
  maxAgeDays: 3650,
};

const SHOTS_DIR = path.resolve("data/screenshots");

/** Saves a PNG screenshot with a descriptive name. */
async function snap(page: any, label: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[snap] 📸 ${label} → ${file}`);
}

async function main(): Promise<void> {
  const configPath = path.resolve("crawler.config.json");
  const config = loadConfig(configPath);
  console.log("[test] Launching browser session…");
  const session = await launchSession(config);
  const page = session.context.pages()[0] ?? (await session.context.newPage());
  page.setDefaultNavigationTimeout(config.behavior.navigationTimeoutMs);

  const adapter = new RedditAdapter();

  try {
    // Step 1: Navigate to Reddit search page
    console.log("\n=== STEP 1: Navigate to feed ===");
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
    await randomWait(3000, 5000);
    await snap(page, "01-feed-loaded");

    // Step 2: Discover post links
    console.log("\n=== STEP 2: Discover post links ===");
    const targets = await adapter.discoverExpandTargets(page, RULE);
    console.log(`[test] Found ${targets.length} post links:`);
    for (const t of targets.slice(0, 5)) {
      console.log(`  → ${t.url}`);
    }
    if (targets.length > 5) console.log(`  … and ${targets.length - 5} more`);

    if (targets.length === 0) {
      console.error("[test] FAIL: No post links discovered on feed page!");
      await snap(page, "02-no-links-FAIL");
      return;
    }

    // Step 3: Click into the first post
    const firstPost = targets[0];
    console.log(`\n=== STEP 3: Navigate to first post ===`);
    console.log(`[test] Opening: ${firstPost.url}`);
    await page.goto(firstPost.url, { waitUntil: "domcontentloaded" });
    await randomWait(config.behavior.waitMinMs, config.behavior.waitMaxMs);
    await humanizeBeforeExtract(page, config.behavior);
    await snap(page, "03-post-page-loaded");

    // Step 4: Extract content from post page
    console.log("\n=== STEP 4: Extract post content ===");
    const extracted = await adapter.extractBase(page, RULE);
    const postText = extracted.posts[0]?.text ?? "(empty)";
    const postChars = postText.length;
    const commentCount = extracted.comments.length;

    console.log(`[test] Title:    ${extracted.title}`);
    console.log(`[test] Post:     ${postChars} chars`);
    console.log(`[test] Preview:  ${postText.slice(0, 200)}…`);
    console.log(`[test] Comments: ${commentCount}`);
    if (commentCount > 0) {
      console.log(`[test] First comment: ${extracted.comments[0].text.slice(0, 100)}…`);
    }
    await snap(page, "04-after-extract");

    // Step 5: Navigate back to feed
    console.log("\n=== STEP 5: Return to feed ===");
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
    await randomWait(2000, 3500);
    await snap(page, "05-back-to-feed");

    // Summary
    console.log("\n--- RESULT ---");
    console.log(`✅ SUCCESS: Full flow completed`);
    console.log(`   Links discovered: ${targets.length}`);
    console.log(`   Post chars:       ${postChars}`);
    console.log(`   Comments:         ${commentCount}`);
    console.log(`   Screenshots in:   ${SHOTS_DIR}`);
  } catch (error) {
    console.error(`[test] FAIL: ${(error as Error).message}`);
    await snap(page, "XX-error").catch(() => {});
    throw error;
  } finally {
    await session.close();
    console.log("[test] Browser closed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
