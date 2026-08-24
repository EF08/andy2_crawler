import fs from "node:fs";
import path from "node:path";
import { Page } from "playwright";
import { loadConfig } from "../config/loader";
import { launchSession } from "../browser/session";

/**
 * Discovery v3: figure out what each /home timeline tab IS technically.
 * - Saves the raw PinnedTimelines GraphQL payload (the tab-bar definition).
 * - Clicks each tab after For you/Following once (no scrolling) and records
 *   which GraphQL operations fire, including their decoded `variables`
 *   (which carry list ids / channel ids).
 * Read-only apart from tab clicks, which render one screenful like normal use.
 */

// Discovery dumps land under data/, which is gitignored — raw GraphQL payloads
// are account-specific and should never be committed.
const SCRATCH = path.resolve("data/discovery");

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function settle(page: Page): Promise<void> {
  await page
    .waitForSelector('a[data-testid="AppTabBar_Profile_Link"]', { timeout: 20_000 })
    .catch(() => null);
  await sleep(3_500);
}

type OpLog = { op: string; variables?: string };

async function main() {
  const config = loadConfig(path.resolve("crawler.config.json"));
  const session = await launchSession(config);
  fs.mkdirSync(SCRATCH, { recursive: true });

  try {
    const page = session.context.pages()[0] ?? (await session.context.newPage());
    await page.bringToFront();
    page.setDefaultNavigationTimeout(config.behavior.navigationTimeoutMs);

    let savedCount = 0;
    const ops: OpLog[] = [];

    page.on("response", (res) => {
      const url = res.url();
      const m = url.match(/\/i\/api\/graphql\/[^/]+\/([^?/]+)/);
      if (!m) return;
      const op = m[1];
      let variables: string | undefined;
      try {
        const u = new URL(url);
        const v = u.searchParams.get("variables");
        if (v) variables = v;
      } catch { /* ignore */ }
      ops.push({ op, variables });

      if (/PinnedTimelines/i.test(op)) {
        res.json().then((body) => {
          const file = path.join(SCRATCH, `pinned-timelines-${savedCount++}.json`);
          fs.writeFileSync(file, JSON.stringify(body, null, 2));
          console.log(`[discover] Saved ${op} payload -> ${file}`);
        }).catch(() => { /* ignore */ });
      }
    });

    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await settle(page);

    const tabTexts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).map(
        (t) => (t.textContent ?? "").trim(),
      ),
    );
    console.log(`[discover] Tabs: ${JSON.stringify(tabTexts)}`);

    // Click each tab after For you / Following, record ops fired per tab.
    for (let i = 2; i < tabTexts.length; i++) {
      const before = ops.length;
      const tab = page.locator('[role="tablist"] [role="tab"]').nth(i);
      await tab.click({ timeout: 10_000 }).catch((e) => {
        console.log(`[discover] Could not click tab ${i} (${tabTexts[i]}): ${(e as Error).message}`);
      });
      await sleep(3_000);
      const fired = ops.slice(before);
      console.log(`[discover] Tab "${tabTexts[i]}" fired ${fired.length} op(s):`);
      for (const f of fired.slice(0, 4)) {
        console.log(`    - ${f.op}` + (f.variables ? ` variables=${f.variables.slice(0, 400)}` : ""));
      }
    }

    console.log("[discover] Done.");
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
