import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { chromium, Browser, BrowserContext } from "playwright";
import { detectChromeExecutable } from "./chromePaths";
import { closeProfileChrome } from "./closeProfileChrome";

export type CdpChromeSession = {
  browser: Browser;
  context: BrowserContext;
  chromeProcess: ChildProcess;
  endpointUrl: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForEndpoint(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/json/version`);
      if (res.ok) {
        console.log(`[session] CDP endpoint responded OK at ${url}`);
        return;
      }
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message ?? String(err);
    }
    await sleep(300);
  }

  throw new Error(
    `[session] CDP endpoint ${url} never became ready (waited ${timeoutMs}ms). Last error: ${lastError}`,
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function launchChromeAndConnectOverCdp(params: {
  userDataDir: string;
  profileDirectory?: string;
  navigationTimeoutMs: number;
  cdpPort?: number;
  chromeExecutablePath?: string;
}): Promise<CdpChromeSession> {
  const port = params.cdpPort ?? 9222;
  const endpointUrl = `http://127.0.0.1:${port}`;
  const chromePath = detectChromeExecutable(params.chromeExecutablePath);

  // Step 1: close any Chrome using this profile so we get a clean launch.
  await closeProfileChrome(params.userDataDir);

  // Step 2: delete stale DevToolsActivePort (not strictly needed, but clean).
  const dtap = path.join(params.userDataDir, "DevToolsActivePort");
  try { fs.unlinkSync(dtap); } catch { /* ignore */ }

  // Step 3: build Chrome args — minimal, no verbose logging.
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${params.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
  ];
  if (params.profileDirectory) {
    args.push(`--profile-directory=${params.profileDirectory}`);
  }

  console.log(`[session] Chrome executable: ${chromePath}`);
  console.log(`[session] CDP port: ${port}`);
  console.log(`[session] Chrome args: ${args.join(" ")}`);

  // Step 4: spawn Chrome.
  const chromeProcess = spawn(chromePath, args, {
    stdio: "ignore",
    detached: false,
  });

  chromeProcess.on("error", (err) => {
    console.error(`[session] Chrome spawn error: ${err.message}`);
  });
  chromeProcess.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.warn(`[session] Chrome exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });

  console.log(`[session] Chrome spawned (pid=${chromeProcess.pid}). Waiting for CDP…`);

  // Step 5: wait for the CDP endpoint to come alive.
  await waitForEndpoint(endpointUrl, Math.min(60_000, params.navigationTimeoutMs));

  // Step 6: connect Playwright over CDP.
  console.log(`[session] Connecting Playwright to ${endpointUrl}…`);
  const browser = await chromium.connectOverCDP(endpointUrl, {
    timeout: params.navigationTimeoutMs,
  });

  const context = browser.contexts()[0] ?? (await browser.newContext());
  console.log(`[session] Connected. contexts=${browser.contexts().length} pages=${context.pages().length}`);

  return { browser, context, chromeProcess, endpointUrl };
}
