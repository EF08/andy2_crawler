import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { collectSearch, SearchHealth } from "./search/collect";
import { resolveIngestKey } from "./sync/backendSync";
import { loadConfig } from "./config/loader";
import { launchSession } from "./browser/session";
import { JsonStore } from "./store/jsonStore";
import { runOnePass } from "./crawl/engine";
import { runFeedsPass } from "./feeds/engine";
import { deduplicateStore } from "./store/deduplicate";
import { pushSnapshots } from "./sync/backendSync";

type CliArgs = {
  configPath: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const dryRun = argv.includes("--dry-run");
  const configArgIndex = argv.indexOf("--config");
  const configPath =
    configArgIndex >= 0 && argv[configArgIndex + 1]
      ? argv[configArgIndex + 1]
      : path.resolve("crawler.config.json");

  return { dryRun, configPath };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function start(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  // Existing run_now target overrides also use the dedicated Latest collector.
  config.targets = config.targets.filter(target => {
    const u = new URL(target);
    if (u.hostname === 'x.com' && u.pathname === '/search') {
      const query = u.searchParams.get('q');
      if (!query) throw new Error('X search URL requires q');
      if (!config.xSearches.some(s => s.query === query)) config.xSearches.push({ query, maxPosts: 30, maxScrolls: 40, timeoutMs: 120000 });
      return false;
    }
    return true;
  });
  const store = new JsonStore(config.outputPath);

  console.log(`[main] Loaded config from ${args.configPath}`);
  console.log(`[main] Dry-run mode: ${args.dryRun ? "ON" : "OFF"}`);
  console.log(
    `[main] Chrome: systemProfile=${config.chrome.useSystemProfile} mode=${config.chrome.mode}` +
      (config.chrome.profileDirectory ? ` profile=${config.chrome.profileDirectory}` : ""),
  );
  console.log(`[main] Output: ${config.outputPath}`);

  // Feeds-only configs have no browser targets — never launch Chrome for them.
  const hasBrowserTargets =
    config.targets.length > 0 || config.xLists.length > 0 || config.xOverflow.enabled || config.xSearches.length > 0;
  const session = hasBrowserTargets ? await launchSession(config) : null;
  if (!session) console.log("[main] No browser targets — feeds-only run.");
  let runCounter = 0;

  try {
    do {
      runCounter += 1;
      const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${runCounter}`;
      console.log(`[main] Starting crawl run ${runId}`);

      // Phase 1: HTTP feeds (market news + EDGAR) — cheap, no browser, never fatal
      if (config.feeds.enabled) {
        try {
          await runFeedsPass(config, store, runId, args.dryRun);
        } catch (error) {
          console.warn(`[feeds] Pass failed: ${(error as Error).message}`);
        }
      }

      // Phase 2: browser crawl (X/Reddit/Bloomberg)
      const searchHealth: SearchHealth[] = [];
      if (session) {
        const page = session.context.pages()[0] ?? await session.context.newPage();
        for (const spec of config.xSearches) {
          searchHealth.push(await collectSearch(page, spec, config, store, runId, args.dryRun));
        }
      }
      if (session) await runOnePass(session.context, config, store, runId, args.dryRun);
      console.log(`[main] Completed crawl run ${runId}`);

      // Push this run's snapshots to the remote backend (never fatal to the crawl loop)
      if (!args.dryRun && config.backend.enabled) {
        try {
          const sync = await pushSnapshots(config.backend, store.getSnapshotsByRun(runId), "sync");
          if (searchHealth.length && (!sync || sync.failedBatches)) throw new Error('search_sync_failure');
          if (searchHealth.length) {
            const response = await fetch(new URL('/api/crawler/search/collections', config.backend.baseUrl), {
              method: 'POST', signal: AbortSignal.timeout(30000),
              headers: { 'content-type': 'application/json', 'x-crawler-key': resolveIngestKey(config.backend)! },
              body: JSON.stringify({ reports: searchHealth }),
            });
            if (!response.ok) throw new Error(`search_health_sync_failure: HTTP ${response.status}`);
          }
        } catch (error) {
          console.warn(`[sync] Backend push failed: ${(error as Error).message}`);
          if (searchHealth.length) {
            for (const h of searchHealth) { h.error = `${h.error ?? ''} ${(error as Error).message}`.trim(); h.status = 'sync_failure'; }
          }
        }
      }
      if (searchHealth.length && !args.dryRun) {
        const report = { jobId: config.searchJobId, runId, searchHealth };
        fs.writeFileSync(config.searchReportPath ?? path.join(path.dirname(config.outputPath), 'search-last-report.json'), JSON.stringify(report, null, 2));
        if (searchHealth.some(h => !['success', 'zero_results'].includes(h.status))) process.exitCode = 1;
      }

      // Auto-dedup after each run
      if (!args.dryRun) {
        deduplicateStore(config.outputPath);
      }

      if (!config.schedule.enabled) {
        break;
      }
      if (config.schedule.maxRuns && runCounter >= config.schedule.maxRuns) {
        console.log("[main] Reached schedule.maxRuns. Stopping.");
        break;
      }
      console.log(`[main] Waiting ${config.schedule.intervalMs}ms before next run.`);
      await sleep(config.schedule.intervalMs);
    } while (true);
  } finally {
    if (session) {
      await session.close();
      console.log("[main] Browser session closed.");
    }
  }
}

start().catch((error) => {
  console.error(`[main] Fatal error: ${(error as Error).stack ?? (error as Error).message}`);
  process.exitCode = 1;
});
