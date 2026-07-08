import path from "node:path";
import { loadConfig } from "../config/loader";
import { JsonStore } from "../store/jsonStore";
import { pushSnapshots } from "../sync/backendSync";

/**
 * Backfill: push EVERY snapshot in the local crawl store to the backend.
 * Idempotent (the backend upserts by snapshot id) — safe to run repeatedly.
 *
 *   npm run sync                       → uses crawler.config.json
 *   npm run sync -- path/to/config     → uses another config (e.g. a localhost baseUrl for testing)
 */
async function main(): Promise<void> {
  const configPath = process.argv[2] ?? path.resolve("crawler.config.json");
  const config = loadConfig(configPath);
  const store = new JsonStore(config.outputPath);
  const snapshots = store.getAllSnapshots();
  console.log(`[backfill] ${snapshots.length} snapshot(s) in ${config.outputPath}`);
  console.log(`[backfill] Target: ${new URL(config.backend.ingestPath, config.backend.baseUrl).toString()}`);
  const result = await pushSnapshots(config.backend, snapshots, "backfill");
  if (!result || result.failedBatches > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[backfill] Fatal error: ${(error as Error).stack ?? (error as Error).message}`);
  process.exitCode = 1;
});
