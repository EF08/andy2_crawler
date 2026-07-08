import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config/loader";
import { launchSession } from "./browser/session";
import { JsonStore } from "./store/jsonStore";
import { runOnePass } from "./crawl/engine";
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
  const store = new JsonStore(config.outputPath);

  console.log(`[main] Loaded config from ${args.configPath}`);
  console.log(`[main] Dry-run mode: ${args.dryRun ? "ON" : "OFF"}`);
  console.log(
    `[main] Chrome: systemProfile=${config.chrome.useSystemProfile} mode=${config.chrome.mode}` +
      (config.chrome.profileDirectory ? ` profile=${config.chrome.profileDirectory}` : ""),
  );
  console.log(`[main] Output: ${config.outputPath}`);

  const session = await launchSession(config);
  let runCounter = 0;

  try {
    do {
      runCounter += 1;
      const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${runCounter}`;
      console.log(`[main] Starting crawl run ${runId}`);
      await runOnePass(session.context, config, store, runId, args.dryRun);
      console.log(`[main] Completed crawl run ${runId}`);

      // Push this run's snapshots to the remote backend (never fatal to the crawl loop)
      if (!args.dryRun && config.backend.enabled) {
        try {
          await pushSnapshots(config.backend, store.getSnapshotsByRun(runId), "sync");
        } catch (error) {
          console.warn(`[sync] Backend push failed: ${(error as Error).message}`);
        }
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
    await session.close();
    console.log("[main] Browser session closed.");
  }
}

start().catch((error) => {
  console.error(`[main] Fatal error: ${(error as Error).stack ?? (error as Error).message}`);
  process.exitCode = 1;
});
