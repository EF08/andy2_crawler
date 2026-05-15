import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { CrawlErrorRecord, CrawlSnapshot, CrawlStore, STORE_VERSION, createEmptyStore } from "./schema";

export class JsonStore {
  private readonly outputPath: string;
  private store: CrawlStore;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
    this.store = this.load();
  }

  private load(): CrawlStore {
    if (!fs.existsSync(this.outputPath)) {
      return createEmptyStore();
    }
    const raw = fs.readFileSync(this.outputPath, "utf-8");
    const parsed = JSON.parse(raw) as CrawlStore;
    // Incompatible schema version — start fresh
    if (!parsed.version || parsed.version < STORE_VERSION) {
      console.log(`[store] Old schema v${parsed.version ?? 0} detected, starting fresh (v${STORE_VERSION})`);
      return createEmptyStore();
    }
    return parsed;
  }

  private persist(): void {
    const parentDir = path.dirname(this.outputPath);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(this.outputPath, JSON.stringify(this.store, null, 2), "utf-8");
  }

  upsertSnapshot(snapshot: CrawlSnapshot): void {
    this.store.latest[snapshot.site] ??= {};
    this.store.latest[snapshot.site][snapshot.canonicalUrl] = snapshot;

    this.store.history[snapshot.site] ??= {};
    this.store.history[snapshot.site][snapshot.canonicalUrl] ??= [];
    this.store.history[snapshot.site][snapshot.canonicalUrl].push(snapshot);

    this.store.index.runs[snapshot.runId] ??= [];
    this.store.index.runs[snapshot.runId].push(snapshot.id);

    const localDate = DateTime.fromISO(snapshot.capturedAtIso).toFormat("yyyy-LL-dd");
    this.store.index.byDate[localDate] ??= [];
    this.store.index.byDate[localDate].push(snapshot.id);

    this.persist();
  }

  /**
   * Collects known content for a site to enable live dedup during crawling.
   * Only includes items posted within the last `windowDays` to cap RAM usage.
   */
  getKnownContent(site: string, windowDays: number): { texts: Set<string>; urls: Set<string> } {
    const texts = new Set<string>();
    const urls = new Set<string>();
    const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;

    const isRecent = (timestamp?: string): boolean => {
      if (!timestamp) return false; // No timestamp = treat as old, skip it
      try {
        const ms = new Date(timestamp).getTime();
        return ms >= cutoffMs;
      } catch {
        return false;
      }
    };

    const collect = (snap: CrawlSnapshot) => {
      for (const p of snap.content.posts) {
        if (p.text && isRecent(p.timestamp)) texts.add(p.text);
      }
      for (const c of snap.content.comments) {
        if (c.text && isRecent(c.timestamp)) texts.add(c.text);
      }
      // URL dedup: only include URLs from snapshots captured within the window
      if (isRecent(snap.capturedAtIso)) {
        for (const u of snap.expandedUrls ?? []) urls.add(u);
      }
    };

    // Latest snapshots for this site
    for (const snap of Object.values(this.store.latest[site] ?? {})) {
      collect(snap);
    }
    // History snapshots for this site
    for (const snaps of Object.values(this.store.history[site] ?? {})) {
      for (const snap of snaps) collect(snap);
    }

    return { texts, urls };
  }

  appendError(record: Omit<CrawlErrorRecord, "capturedAtIso" | "capturedAtLocal">): void {
    const now = DateTime.local();
    this.store.errors.push({
      ...record,
      capturedAtIso: now.toUTC().toISO() ?? now.toISO() ?? new Date().toISOString(),
      capturedAtLocal: now.toFormat("yyyy-LL-dd HH:mm:ss ZZZZ"),
    });
    this.persist();
  }
}
