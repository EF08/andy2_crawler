/**
 * Smoke test for chrome.headless / chrome.windowMode.
 *
 * Launches a real session with the given config, reports what the browser
 * advertises about itself (the headless tells that matter to bot detection),
 * and confirms the X login survived into this mode.
 *
 *   npx tsx src/scripts/test-headless.ts [configPath]
 */
import { loadConfig } from "../config/loader";
import { launchSession } from "../browser/session";

const configPath = process.argv[2] ?? "crawler.config.json";
const LIST_URL = "https://x.com/i/lists/1513647721055461386";

async function main(): Promise<void> {
  const config = loadConfig(configPath);
  console.log(
    `[test] headless=${config.chrome.headless} windowMode=${config.chrome.windowMode} mode=${config.chrome.mode}`,
  );

  const session = await launchSession(config);
  try {
    const page = session.context.pages()[0] ?? (await session.context.newPage());
    page.setDefaultNavigationTimeout(config.behavior.navigationTimeoutMs);

    // The Sec-CH-UA we actually put on the wire, not what we meant to.
    let sentSecChUa: string | undefined;
    page.on("request", (req) => {
      if (!sentSecChUa && req.isNavigationRequest()) {
        sentSecChUa = req.headers()["sec-ch-ua"];
      }
    });

    console.log(`[test] Loading ${LIST_URL}…`);
    await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);

    // Client hints only exist in a secure context, so probe on the real page.
    const fp = await page.evaluate(() => {
      const uaData = (navigator as any).userAgentData;
      return {
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver,
        brands: uaData?.brands?.map((b: any) => `${b.brand} ${b.version}`) ?? null,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        plugins: navigator.plugins.length,
        title: document.title,
        articles: document.querySelectorAll("article").length,
        loginWall: /log in|sign in to x/i.test(document.body.innerText.slice(0, 4000)),
      };
    });
    console.log("[test] fingerprint:", JSON.stringify({ ...fp, sentSecChUa }, null, 2));

    const tells: string[] = [];
    if (/Headless/i.test(fp.userAgent)) tells.push("userAgent says Headless");
    if ((fp.brands ?? []).some((b: string) => /Headless/i.test(b))) tells.push("userAgentData brands say Headless");
    if (sentSecChUa && /Headless/i.test(sentSecChUa)) tells.push("sec-ch-ua header says Headless");
    if (fp.webdriver) tells.push("navigator.webdriver is true");
    console.log(tells.length ? `[test] FAIL — tells: ${tells.join("; ")}` : "[test] PASS — no headless tells");

    console.log(
      fp.articles > 0 && !fp.loginWall
        ? `[test] PASS — logged in, ${fp.articles} posts rendered`
        : "[test] FAIL — no posts rendered (login wall or challenge?)",
    );

    if (!config.chrome.headless) {
      console.log("[test] Window should now be sitting behind everything else — check your screen.");
      await page.waitForTimeout(15_000);
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
