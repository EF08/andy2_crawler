import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { chromium } from "playwright";
import { XAdapter } from "./sites/x.adapter";
import { RedditAdapter } from "./sites/reddit.adapter";
import { BloombergAdapter } from "./sites/bloomberg.adapter";
import { SiteRule } from "./config/types";

const baseRule: SiteRule = {
  maxChars: 5000,
  maxCharsPerComment: 400,
  contentLevel: "feed",
  stallLimit: 3,
  maxFeedScrolls: 10,
};

function loadFixture(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "src", "fixtures", name), "utf-8");
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const xAdapter = new XAdapter();
  const redditAdapter = new RedditAdapter();
  const bloombergAdapter = new BloombergAdapter();

  await page.setContent(loadFixture("x.html"));
  const xBase = await xAdapter.extractBase(page, baseRule);
  const xTargets = await xAdapter.discoverExpandTargets(page, baseRule);
  const xText = xBase.posts.map((p) => p.text).join("\n");
  assert.ok(xText.includes("Market update"), "X adapter should capture article text");
  assert.ok(xBase.posts[0]?.author, "X adapter should pair author with post");
  assert.ok(xTargets.some((x) => x.url.includes("/status/1234567890")), "X adapter should find status link");

  await page.setContent(loadFixture("reddit.html"));
  const redditBase = await redditAdapter.extractBase(page, baseRule);
  const redditTargets = await redditAdapter.discoverExpandTargets(page, baseRule);
  assert.ok(redditBase.posts.length >= 1, "Reddit adapter should capture post");
  assert.ok(redditBase.comments.length >= 1, "Reddit adapter should capture comments");
  assert.ok(redditBase.comments[0]?.text, "Reddit comment should have text");
  assert.ok(redditTargets.some((x) => x.url.includes("/comments/abc123")), "Reddit adapter should find thread link");

  await page.setContent(loadFixture("bloomberg.html"));
  const bloombergBase = await bloombergAdapter.extractBase(page, baseRule);
  const bloombergTargets = await bloombergAdapter.discoverExpandTargets(page, baseRule);
  const bloomText = bloombergBase.posts.map((p) => p.text).join("\n");
  assert.ok(bloomText.includes("Stocks rose globally"), "Bloomberg adapter should capture article body");
  assert.ok(bloombergBase.posts[0]?.author, "Bloomberg adapter should pair author with article");
  assert.ok(
    bloombergTargets.some((x) => x.url.includes("/news/articles/2026-02-10/sample-follow-up")),
    "Bloomberg adapter should find related article link",
  );

  await context.close();
  await browser.close();
  console.log("[smoke] All adapter smoke checks passed.");
}

run().catch((error) => {
  console.error(`[smoke] Failed: ${(error as Error).stack ?? (error as Error).message}`);
  process.exitCode = 1;
});
