/**
 * Five different strategies to open a Bloomberg article without bot detection.
 * Uses project session; runs up to 5 tries (one per strategy). Reports each.
 * Run: npx tsx src/scripts/test-bloomberg-5tries.ts
 */
import path from "node:path";
import { loadConfig } from "../config/loader";
import { launchSession } from "../browser/session";
import { humanizeBeforeExtract, randomWait } from "../browser/humanize";
import { BloombergAdapter } from "../sites/bloomberg.adapter";
import { SiteRule } from "../config/types";
import type { Page } from "playwright";

const LATEST_URL = "https://www.bloomberg.com/latest?utm_source=homepage&utm_medium=web&utm_campaign=latest";
const baseRule: SiteRule = { maxChars: 5000, maxCharsPerComment: 600, contentLevel: "post", stallLimit: 3, maxFeedScrolls: 10, maxAgeDays: 3650 };

function isRobotPage(title: string): boolean {
  return title.toLowerCase().includes("robot");
}

async function ensureOnLatest(
  page: Page,
  config: { behavior: import("../config/types").Behavior },
): Promise<{ ok: boolean; articleUrl?: string }> {
  await page.goto(LATEST_URL, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 5000));
  const titleLatest = await page.title();
  if (isRobotPage(titleLatest)) return { ok: false };
  await humanizeBeforeExtract(page, config.behavior);
  await randomWait(1500, 3000);
  const adapter = new BloombergAdapter();
  const targets = await adapter.discoverExpandTargets(page, baseRule);
  const article = targets.find((t) => /\/news\/articles\//.test(t.url));
  return { ok: true, articleUrl: article?.url };
}

type TryResult = { strategy: string; success: boolean; title: string; url?: string; note?: string };

function isArticlePage(url: string): boolean {
  return url.includes("/news/articles/") || url.includes("/opinion/") || url.includes("/features/");
}

async function try1_RefererAndSecFetchHeaders(page: Page, articleUrl: string): Promise<TryResult> {
  // Add Referer + Sec-Fetch-* to all requests so article load looks like coming from feed
  await page.route("**/*", (route) => {
    const headers = { ...route.request().headers() };
    if (route.request().url().includes("bloomberg.com")) {
      headers["Referer"] = LATEST_URL;
      headers["Sec-Fetch-Dest"] = "document";
      headers["Sec-Fetch-Mode"] = "navigate";
      headers["Sec-Fetch-Site"] = "same-origin";
    }
    route.continue({ headers });
  });
  await page.goto(articleUrl, { waitUntil: "domcontentloaded", referer: LATEST_URL });
  await randomWait(4000, 6000);
  const title = await page.title();
  const url = page.url();
  page.unroute("**/*").catch(() => {});
  return { strategy: "1_referer_and_sec_fetch_headers", success: !isRobotPage(title) && isArticlePage(url), title, url };
}

async function try2_FullMouseSequence(
  page: Page,
  articleUrl: string,
  pathPart: string,
): Promise<TryResult> {
  const locator = page.locator(`a[href*="${pathPart.slice(0, 40)}"]`).first();
  await locator.scrollIntoViewIfNeeded();
  await randomWait(1000, 2000);
  const box = await locator.boundingBox();
  if (!box) return { strategy: "2_full_mouse_sequence", success: false, title: "", note: "no box" };
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 15 });
  await new Promise((r) => setTimeout(r, 200));
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 80));
  await page.mouse.up();
  await page.waitForLoadState("domcontentloaded");
  await randomWait(4000, 6000);
  const title = await page.title();
  const url = page.url();
  return { strategy: "2_full_mouse_sequence", success: !isRobotPage(title) && isArticlePage(url), title, url };
}

async function try3_HoverThenDelayedClick(
  page: Page,
  pathPart: string,
): Promise<TryResult> {
  const locator = page.locator(`a[href*="${pathPart.slice(0, 40)}"]`).first();
  await locator.scrollIntoViewIfNeeded();
  await randomWait(800, 1500);
  await locator.hover();
  await new Promise((r) => setTimeout(r, 2200));
  await locator.click({ delay: 120, timeout: 10000 });
  await page.waitForLoadState("domcontentloaded");
  await randomWait(4000, 6000);
  const title = await page.title();
  const url = page.url();
  return { strategy: "3_hover_then_delayed_click", success: !isRobotPage(title) && isArticlePage(url), title, url };
}

async function try4_GotoWithRefererOnly(page: Page, articleUrl: string): Promise<TryResult> {
  await page.goto(articleUrl, { waitUntil: "domcontentloaded", referer: LATEST_URL });
  await randomWait(4000, 6000);
  const title = await page.title();
  const url = page.url();
  return { strategy: "4_goto_with_referer_only", success: !isRobotPage(title) && isArticlePage(url), title, url };
}

async function try5_OpenInNewTab(page: Page, articleUrl: string): Promise<TryResult> {
  const context = page.context();
  const newPage = await context.newPage();
  newPage.setDefaultNavigationTimeout(45000);
  await newPage.goto(LATEST_URL, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 3000));
  await newPage.evaluate((url) => { window.open(url, "_blank"); }, articleUrl);
  await randomWait(2000, 3500);
  const pages = context.pages();
  const articlePage = pages.find((p) => p.url().includes("/news/articles/") && p !== newPage) ?? pages[pages.length - 1];
  await articlePage.waitForLoadState("domcontentloaded").catch(() => {});
  await randomWait(4000, 6000);
  const title = await articlePage.title();
  const url = articlePage.url();
  await newPage.close().catch(() => {});
  return { strategy: "5_open_in_new_tab", success: !isRobotPage(title) && isArticlePage(url), title, url };
}

async function main(): Promise<void> {
  const configPath = path.resolve(process.cwd(), "crawler.config.json");
  const config = loadConfig(configPath);
  const session = await launchSession(config);
  const page = session.context.pages()[0] ?? (await session.context.newPage());
  page.setDefaultNavigationTimeout(config.behavior.navigationTimeoutMs);

  console.log("[test] Bloomberg 5-strategy test. Loading /latest and getting article link...\n");
  const { ok, articleUrl } = await ensureOnLatest(page, config);
  if (!ok || !articleUrl) {
    console.log("[test] Failed to load /latest or no article link.");
    await session.close();
    process.exitCode = 1;
    return;
  }
  const pathPart = articleUrl.replace("https://www.bloomberg.com", "").split("?")[0];
  console.log("[test] Article URL:", articleUrl.slice(0, 70) + "...\n");

  const results: TryResult[] = [];

  // Try 1: Referer + Sec-Fetch headers + goto
  console.log("[try 1] Referer + Sec-Fetch headers + goto(article)...");
  results.push(await try1_RefererAndSecFetchHeaders(page, articleUrl));
  if (results[0].success) {
    console.log("  -> SUCCESS:", results[0].title);
  } else {
    console.log("  -> FAIL:", results[0].title);
    await page.goto(LATEST_URL, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 4000));
    await humanizeBeforeExtract(page, config.behavior);
    await randomWait(1000, 2000);
  }

  // Try 2: Full mouse move/down/up sequence
  console.log("[try 2] Full mouse sequence (move -> down -> up)...");
  results.push(await try2_FullMouseSequence(page, articleUrl, pathPart));
  console.log(results[1].success ? "  -> SUCCESS:" : "  -> FAIL:", results[1].title || results[1].note);
  if (!results[1].success && !results[1].note) {
    await page.goto(LATEST_URL, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 4000));
    await humanizeBeforeExtract(page, config.behavior);
    await randomWait(1000, 2000);
  }

  // Try 3: Hover 2.2s then click with 120ms delay
  console.log("[try 3] Hover 2.2s then delayed click...");
  results.push(await try3_HoverThenDelayedClick(page, pathPart));
  console.log(results[2].success ? "  -> SUCCESS:" : "  -> FAIL:", results[2].title);
  if (!results[2].success) {
    await page.goto(LATEST_URL, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 4000));
    await humanizeBeforeExtract(page, config.behavior);
    await randomWait(1000, 2000);
  }

  // Try 4: Simple goto with referer only (no route)
  console.log("[try 4] page.goto(article, { referer: LATEST_URL })...");
  results.push(await try4_GotoWithRefererOnly(page, articleUrl));
  console.log(results[3].success ? "  -> SUCCESS:" : "  -> FAIL:", results[3].title);
  if (!results[3].success) {
    await page.goto(LATEST_URL, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 4000));
    await humanizeBeforeExtract(page, config.behavior);
    await randomWait(1000, 2000);
  }

  // Try 5: Open article in new tab via window.open
  console.log("[try 5] Open article in new tab (window.open)...");
  results.push(await try5_OpenInNewTab(page, articleUrl));
  console.log(results[4].success ? "  -> SUCCESS:" : "  -> FAIL:", results[4].title);

  await session.close();

  const passed = results.filter((r) => r.success);
  console.log("\n--- FINDINGS ---");
  results.forEach((r) => {
    console.log(`  ${r.strategy}: ${r.success ? "PASS" : "FAIL"} | ${r.title || r.note || ""}`);
  });
  if (passed.length > 0) {
    console.log("\nWorking strategy(ies):", passed.map((r) => r.strategy).join(", "));
  } else {
    console.log("\nNo strategy succeeded. Article page triggers bot detection in all cases.");
  }
  process.exitCode = passed.length > 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
