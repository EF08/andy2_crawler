import fs from "node:fs";
import path from "node:path";
import { ChildProcess } from "node:child_process";
import { BrowserContext } from "playwright";
import { chromium } from "playwright";
import { CrawlerConfig } from "../config/types";
import { applyStealthPatches } from "./stealth";
import { syncProfileForCrawler, clearCrashExitFlags } from "./profileCopy";
import { launchChromeAndConnectOverCdp, CdpChromeSession } from "./chromeCdp";
import { closeProfileChrome } from "./closeProfileChrome";
import { detectChromeExecutable, detectChromeMajorVersion, headfulUserAgent } from "./chromePaths";
import { currentForegroundWindow, placeChromeWindow } from "./windowPlacement";

export type BrowserSession = {
  context: BrowserContext;
  close: () => Promise<void>;
};

/**
 * Whether raising the browser window to the foreground is acceptable during a crawl.
 *
 * Headless has no window, so activating a tab costs nothing and still helps (an
 * inactive tab gets throttled). A headed window in "background" or "minimized" mode
 * is deliberately out of the way, and Page.bringToFront would yank it back over
 * whatever the user is doing on every navigation.
 */
export function canFocusBrowserWindow(config: CrawlerConfig): boolean {
  if (config.chrome.headless) return true;
  return config.chrome.windowMode === "normal";
}

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
  clearCrashExitFlags(userDataDir, config.chrome.profileDirectory ?? "Default");

  const headless = config.chrome.headless;
  const windowMode = config.chrome.windowMode;
  const majorVersion = detectChromeMajorVersion(
    detectChromeExecutable(config.chrome.chromeExecutablePath),
  );

  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=AutomationControlled",
  ];
  if (!headless) {
    args.push("--start-maximized");
    if (windowMode !== "normal") {
      // See chromeCdp.ts — a window hidden behind others is treated as occluded
      // and throttled, which stalls the infinite-scroll feeds we crawl.
      args.push(
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
      );
    }
  }

  const previousForeground =
    !headless && windowMode !== "normal" ? currentForegroundWindow() : undefined;

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless,
    viewport: { width: 1920, height: 1080 },
    timeout: config.behavior.navigationTimeoutMs,
    locale: "en-US",
    // Headless Chrome advertises "HeadlessChrome/<v>"; hand it the headful string.
    userAgent: headless && majorVersion ? headfulUserAgent(majorVersion) : undefined,
    ignoreDefaultArgs: ARGS_TO_STRIP,
    args,
  });

  if (!headless && windowMode !== "normal") {
    // Playwright does not expose the browser pid for a persistent context, so the
    // placement helper finds the window by our user-data-dir instead.
    placeChromeWindow({ pid: undefined, userDataDir, mode: windowMode, previousForeground });
  }

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
    headless: config.chrome.headless,
    windowMode: config.chrome.windowMode,
  });

  return {
    context: cdp.context,
    close: async () => {
      // Close every tab like a user would — when the last window goes,
      // Chrome shuts down through its normal path and writes
      // "exit_type": "Normal" to Preferences. A CDP Browser.close or a
      // plain kill() leaves the profile marked as crashed, and every next
      // launch shows the "Chrome didn't shut down correctly" bubble.
      try {
        for (const context of cdp.browser.contexts()) {
          for (const page of context.pages()) {
            await page.close().catch(() => { /* already closed */ });
          }
        }
      } catch { /* browser already gone */ }

      let exited = await waitForProcessExit(cdp.chromeProcess, 10_000);

      if (!exited) {
        // Something (e.g. a background page) kept Chrome alive — ask it to quit.
        try {
          const cdpSession = await cdp.browser.newBrowserCDPSession();
          await cdpSession.send("Browser.close");
        } catch { /* browser already gone */ }
        exited = await waitForProcessExit(cdp.chromeProcess, 10_000);
      }

      if (exited) {
        console.log("[session] Chrome closed gracefully.");
      } else {
        cdp.chromeProcess.kill();
        console.log(`[session] Chrome didn't exit in time — killed (pid=${cdp.chromeProcess.pid})`);
      }

      try { await cdp.browser.close(); } catch { /* already disconnected */ }
      console.log("[session] Browser closed.");
    },
  };
}

/** Resolves true once the process exits, or false after timeoutMs. */
function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function launchSession(config: CrawlerConfig): Promise<BrowserSession> {
  const userDataDir = resolveUserDataDir(config);
  const mode = config.chrome.mode ?? "persistent";

  console.log(`[session] Launching with user-data-dir: ${userDataDir}`);
  console.log(`[session] Mode: ${mode}`);
  console.log(
    config.chrome.headless
      ? `[session] Headless: no window will open.`
      : `[session] Headed: window mode "${config.chrome.windowMode}".`,
  );

  const session =
    mode === "cdp"
      ? await launchCdp(userDataDir, config)
      : await launchPersistent(userDataDir, config);

  await applyContextSetup(session.context);

  console.log(`[session] Browser ready. pages=${session.context.pages().length}`);
  return session;
}
