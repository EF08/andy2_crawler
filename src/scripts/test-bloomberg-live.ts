/**
 * Live Bloomberg anti-bot test: use project session + human-like behavior.
 * Run: npx tsx src/scripts/test-bloomberg-live.ts
 * Max 2 attempts; reports whether we can open /latest and an article without "Are you a robot".
 */
import path from "node:path";
import { loadConfig } from "../config/loader";
import { launchSession } from "../browser/session";
import { humanizeBeforeExtract, randomWait } from "../browser/humanize";
import { BloombergAdapter } from "../sites/bloomberg.adapter";
import { SiteRule } from "../config/types";

const LATEST_URL = "https://www.bloomberg.com/latest?utm_source=homepage&utm_medium=web&utm_campaign=latest";
const ROBOT_TITLE = "Are you a robot";
const baseRule: SiteRule = { maxChars: 5000, maxCharsPerComment: 600, contentLevel: "post", stallLimit: 3, maxFeedScrolls: 10, maxAgeDays: 3650 };

function isRobotPage(title: string): boolean {
  return title.toLowerCase().includes("robot");
}

async function attempt(
  session: { context: { pages: () => any[]; newPage: () => Promise<any> } },
  config: { behavior: import("../config/types").Behavior },
  attemptNumber: 1 | 2,
): Promise<{ success: boolean; stage: string; title: string }> {
  const page = session.context.pages()[0] ?? (await session.context.newPage());
  page.setDefaultNavigationTimeout(config.behavior.navigationTimeoutMs);

  // Step 1: Land on /latest and stay a while (human-like)
  console.log(`\n[attempt ${attemptNumber}] Navigating to Bloomberg /latest...`);
  await page.goto(LATEST_URL, { waitUntil: "domcontentloaded" });
  const stayMs = attemptNumber === 1 ? 6000 : 12000;
  console.log(`[attempt ${attemptNumber}] Staying ${stayMs / 1000}s on /latest...`);
  await new Promise((r) => setTimeout(r, stayMs));

  const titleLatest = await page.title();
  if (isRobotPage(titleLatest)) {
    return { success: false, stage: "latest", title: titleLatest };
  }
  console.log(`[attempt ${attemptNumber}] /latest OK: "${titleLatest}"`);

  // Step 2: Humanize — mouse move + scroll (read the feed)
  console.log(`[attempt ${attemptNumber}] Humanizing (mouse + scroll)...`);
  await humanizeBeforeExtract(page, config.behavior);
  await randomWait(2000, 4000);

  // Step 3: Get first article link and click it (don't goto — simulate user click)
  const adapter = new BloombergAdapter();
  const targets = await adapter.discoverExpandTargets(page, baseRule);
  const articleLink = targets.find((t) => /\/news\/articles\//.test(t.url));
  if (!articleLink) {
    console.log(`[attempt ${attemptNumber}] No article link found on page`);
    return { success: false, stage: "no_link", title: await page.title() };
  }
  const pathPart = articleLink.url.replace("https://www.bloomberg.com", "").split("?")[0];
  console.log(`[attempt ${attemptNumber}] Clicking article: ${pathPart.slice(0, 50)}...`);

  const locator = page.locator(`a[href*="${pathPart.slice(0, 40)}"]`).first();
  await locator.scrollIntoViewIfNeeded();
  await randomWait(1500, 3000);
  await locator.click({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded");
  await randomWait(4000, 7000);

  const titleArticle = await page.title();
  if (isRobotPage(titleArticle)) {
    return { success: false, stage: "article", title: titleArticle };
  }
  console.log(`[attempt ${attemptNumber}] Article OK: "${titleArticle}"`);
  return { success: true, stage: "article", title: titleArticle };
}

async function main(): Promise<void> {
  const configPath = path.resolve(process.cwd(), "crawler.config.json");
  const config = loadConfig(configPath);
  console.log("[test] Using config:", configPath);
  console.log("[test] Launching session (same as crawl — profile + stealth)...");
  const session = await launchSession(config);

  let result = await attempt(session, config, 1);
  if (!result.success && result.stage === "article") {
    console.log("[test] Attempt 1 failed at article. Retrying with longer dwell...");
    result = await attempt(session, config, 2);
  } else if (!result.success) {
    console.log("[test] Attempt 1 failed at", result.stage, "- retrying once...");
    result = await attempt(session, config, 2);
  }

  await session.close();

  console.log("\n--- RESULT ---");
  if (result.success) {
    console.log("SUCCESS: Reached article without bot detection.");
    console.log("Title:", result.title);
  } else {
    console.log("FAILED: Bot detected.");
    console.log("Stage:", result.stage, "| Title:", result.title);
  }
  process.exitCode = result.success ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
