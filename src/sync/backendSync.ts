import fs from "node:fs";
import path from "node:path";
import { BackendConfig } from "../config/types";
import { CrawlSnapshot } from "../store/schema";

/**
 * Pushes crawl snapshots to a1a2-command-center (POST /api/crawler/ingest).
 * The backend upserts by snapshot id, so resending anything (retries, backfills)
 * is always safe — no duplicates.
 */

/** Ingest key resolution order: env var → backend.local.json (gitignored) → config field. */
export function resolveIngestKey(cfg: BackendConfig): string | null {
  if (process.env.CRAWLER_INGEST_KEY) return process.env.CRAWLER_INGEST_KEY;
  const localPath = path.resolve("backend.local.json");
  if (fs.existsSync(localPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localPath, "utf-8")) as { ingestKey?: string };
      if (typeof parsed.ingestKey === "string" && parsed.ingestKey) return parsed.ingestKey;
    } catch {
      console.warn("[sync] backend.local.json exists but could not be parsed — ignoring it");
    }
  }
  return cfg.ingestKey ?? null;
}

export type SyncResult = {
  pushed: number;
  inserted: number;
  updated: number;
  failedBatches: number;
};

/** Push snapshots in batches. Never throws on HTTP/network errors — logs and counts them. */
export async function pushSnapshots(
  cfg: BackendConfig,
  snapshots: CrawlSnapshot[],
  label = "sync",
): Promise<SyncResult | null> {
  if (snapshots.length === 0) {
    console.log(`[${label}] Nothing to push.`);
    return { pushed: 0, inserted: 0, updated: 0, failedBatches: 0 };
  }
  const key = resolveIngestKey(cfg);
  if (!key) {
    console.warn(
      `[${label}] No ingest key found (env CRAWLER_INGEST_KEY, backend.local.json, or config.backend.ingestKey) — skipping push.`,
    );
    return null;
  }

  const url = new URL(cfg.ingestPath, cfg.baseUrl).toString();
  const result: SyncResult = { pushed: 0, inserted: 0, updated: 0, failedBatches: 0 };
  const totalBatches = Math.ceil(snapshots.length / cfg.batchSize);

  for (let i = 0; i < snapshots.length; i += cfg.batchSize) {
    const batch = snapshots.slice(i, i + cfg.batchSize);
    const batchNo = Math.floor(i / cfg.batchSize) + 1;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-crawler-key": key },
        body: JSON.stringify({ source: "andy2_crawler", snapshots: batch }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        console.warn(`[${label}] Batch ${batchNo}/${totalBatches} failed: HTTP ${res.status} ${bodyText.slice(0, 200)}`);
        result.failedBatches += 1;
        continue;
      }
      const body = (await res.json()) as { inserted?: number; updated?: number };
      result.pushed += batch.length;
      result.inserted += body.inserted ?? 0;
      result.updated += body.updated ?? 0;
      console.log(
        `[${label}] Batch ${batchNo}/${totalBatches}: pushed ${batch.length} snapshot(s) (${body.inserted ?? 0} new)`,
      );
    } catch (error) {
      console.warn(`[${label}] Batch ${batchNo}/${totalBatches} failed: ${(error as Error).message}`);
      result.failedBatches += 1;
    }
  }

  console.log(
    `[${label}] Done: ${result.pushed} pushed, ${result.inserted} new, ${result.updated} updated` +
      (result.failedBatches > 0 ? `, ${result.failedBatches} FAILED batch(es)` : ""),
  );
  return result;
}
