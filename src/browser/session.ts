import fs from "node:fs";
import path from "node:path";
import { BrowserContext } from "playwright";
import { chromium } from "playwright";
import { CrawlerConfig } from "../config/types";
import { applyStealthPatches } from "./stealth";
import { syncProfileForCrawler } from "./profileCopy";
import { launchChromeAndConnectOverCdp, CdpChromeSession } from "./chromeCdp";
import { closeProfileChrome } from "./closeProfileChrome";

export type BrowserSession = {
  context: BrowserContext;
  close: () => Promise<void>;
};

// Playwright injects these by default. They scream "automation" to every
// bot-detection system. We strip them and only keep the harmless ones.
const ARGS_TO_STRIP = [
  "--enable-automation",
  "--disable-extensions",
  "--disable-default-apps",
  "--disable-component-update",
  "--disable-component-extensions-with-background-pages",
  "--no-service-autorun",
  "--disable-background-networking",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-client-side-phishing-detection",
  "--disable-field-trial-config",
  "--disable-infobars",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-renderer-backgrounding",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--enable-unsafe-swiftshader",
  "--metrics-recording-only",
  "--no-sandbox",
  "--password-store=basic",
  "--use-mock-keychain",
  "--export-tagged-pdf",
  "--unsafely-disable-devtools-self-xss-warnings",
];

/** Resolves the user-data-dir, seeding from the real Chrome profile on first run. */
function resolveUserDataDir(config: CrawlerConfig): string {
  let userDataDir = config.chrome.userDataDir ?? config.profileDir;
  const profileDir = config.chrome.profileDirectory ?? "Default";

  if (config.chrome.useSystemProfile && config.chrome.userDataDir) {
    const crawlerDir = path.resolve(config.profileDir);
    const marker = path.join(crawlerDir, profileDir, "Preferences");
    if (!fs.existsSync(marker)) {
      console.log(`[session] First run — seeding crawler profile from real Chrome profile`);
      userDataDir = syncProfileForCrawler(config.chrome.userDataDir, profileDir, crawlerDir);
    } else {
      console.log(`[session] Using existing crawler profile (logins preserved)`);
      userDataDir = crawlerDir;
    }
  } else if (!config.chrome.userDataDir) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  return userDataDir;
}

/** Applies stealth patches, headers, and zoom to a browser context. */
async function applyContextSetup(context: BrowserContext): Promise<void> {
  await applyStealthPatches(context);
  await context.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

  // Zoom out to 75% so more content fits per viewport — fewer scrolls needed.
  // Skip Bloomberg: their React app breaks when zoom is applied.
  await context.addInitScript(() => {
    const applyZoom = () => {
      if (!location.hostname.includes("bloomberg.com")) {
        document.documentElement.style.zoom = "0.75";
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", applyZoom);
    } else {
      applyZoom();
    }
  });
}

/** Launches Chrome via Playwright's persistent context (uses --remote-debugging-pipe). */
async function launchPersistent(
  userDataDir: string,
  config: CrawlerConfig,
): Promise<BrowserSession> {
  await closeProfileChrome(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1920, height: 1080 },
    timeout: config.behavior.navigationTimeoutMs,
    locale: "en-US",
    ignoreDefaultArgs: ARGS_TO_STRIP,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=AutomationControlled",
      "--start-maximized",
    ],
  });

  return {
    context,
    close: async () => {
      await context.close();
      console.log("[session] Browser closed.");
    },
  };
}

/**
 * Launches Chrome directly (like npm run login), then connects Playwright
 * over CDP. Much more reliable on Windows than --remote-debugging-pipe.
 */
async function launchCdp(
  userDataDir: string,
  config: CrawlerConfig,
): Promise<BrowserSession> {
  const profileDir = config.chrome.profileDirectory ?? "Default";

  const cdp: CdpChromeSession = await launchChromeAndConnectOverCdp({
    userDataDir,
    profileDirectory: profileDir,
    navigationTimeoutMs: config.behavior.navigationTimeoutMs,
    cdpPort: config.chrome.cdpPort,
    chromeExecutablePath: config.chrome.chromeExecutablePath,
  });

  return {
    context: cdp.context,
    close: async () => {
      await cdp.browser.close();
      // Kill the Chrome process — browser.close() only disconnects Playwright over CDP.
      if (!cdp.chromeProcess.killed) {
        cdp.chromeProcess.kill();
        console.log(`[session] Chrome process killed (pid=${cdp.chromeProcess.pid})`);
      }
      console.log("[session] Browser closed.");
    },
  };
}

export async function launchSession(config: CrawlerConfig): Promise<BrowserSession> {
  const userDataDir = resolveUserDataDir(config);
  const mode = config.chrome.mode ?? "persistent";

  console.log(`[session] Launching with user-data-dir: ${userDataDir}`);
  console.log(`[session] Mode: ${mode}`);

  const session =
    mode === "cdp"
      ? await launchCdp(userDataDir, config)
      : await launchPersistent(userDataDir, config);

  await applyContextSetup(session.context);

  console.log(`[session] Browser ready. pages=${session.context.pages().length}`);
  return session;
}
