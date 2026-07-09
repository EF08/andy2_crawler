/**
 * Always-on PC agent.
 *
 * Runs at logon (see scripts/start-agent.vbs + the Startup-folder shim) and lets the
 * backend — and therefore Claude, from any device via the Crawler MCP connector —
 * schedule and trigger scrapes on this machine:
 *
 *   every 30s → POST /api/crawler/agent/poll   (heartbeat + claim a queued job + fetch schedule)
 *   job claimed → run a one-shot crawl (npx tsx src/main.ts --config <sanitized temp config>)
 *   crawl done  → POST /api/crawler/agent/jobs/:id/complete (results already synced by the run itself)
 *   schedule due (enabled, everyHours elapsed) → enqueue a 'main' crawl job
 *
 * Safety: job params are sanitized here (whitelisted config files, allowed hosts only,
 * bounded char budgets); a job can never point the crawler at arbitrary files or sites.
 */
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/loader";
import { resolveIngestKey } from "../sync/backendSync";

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);

const POLL_MS = 30_000;
const CRAWL_TIMEOUT_MS = 35 * 60_000;
const FEEDS_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_FEEDS_EVERY_MINUTES = 15; // used until the backend sends its own value
const LOG_PATH = path.join(ROOT, "data", "agent.log");
const LOCK_PATH = path.join(ROOT, "data", "agent.lock");
const JOB_CONFIG_PATH = path.join(ROOT, "data", "agent-job-config.json");
const FEEDS_CONFIG_PATH = path.join(ROOT, "data", "agent-feeds-config.json");

const CONFIG_FILES: Record<string, string> = {
  main: "crawler.config.json",
  "5k": "crawler.config.5k.json",
  short: "crawler.config.short.json",
  feeds: "crawler.config.feeds.json", // news + EDGAR only, no browser
};
const ALLOWED_HOSTS = ["x.com", "reddit.com", "bloomberg.com"];

type Job = {
  _id: string;
  params?: { configFile?: string; targets?: string[]; maxCharsPerSite?: number };
  source?: string;
};
type Schedule = {
  enabled: boolean;
  everyHours: number;
  lastRunAt: string | null;
  /** News/EDGAR feed pull interval (0 = disabled). Backend-controlled; default 15. */
  feedsEveryMinutes?: number;
};

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch { /* logging must never kill the agent */ }
}

/* ── single-instance lock (logon shim + manual start must not double-run) ── */
function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, "utf-8").trim(), 10);
      if (pid && !isNaN(pid)) {
        try {
          process.kill(pid, 0); // throws if the process is gone
          log(`Another agent is already running (pid=${pid}) — exiting.`);
          return false;
        } catch { /* stale lock */ }
      }
    }
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  } catch (e) {
    log(`Lockfile error: ${(e as Error).message} — continuing anyway.`);
    return true;
  }
}

/* ── backend connection (base URL from config; env override for testing) ── */
const mainConfig = loadConfig(path.join(ROOT, "crawler.config.json"));
const BASE_URL = process.env.CRAWLER_BACKEND_BASEURL || mainConfig.backend.baseUrl;
const KEY = resolveIngestKey(mainConfig.backend);
const HOSTNAME = os.hostname();

async function api(pathname: string, body: unknown): Promise<any> {
  const res = await fetch(new URL(pathname, BASE_URL).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-crawler-key": KEY as string },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathname}`);
  return res.json();
}

/* ── job config: whitelisted base + sanitized overrides ── */
function buildJobConfig(params: Job["params"], outPath: string = JOB_CONFIG_PATH): string {
  const fileKey = params?.configFile && CONFIG_FILES[params.configFile] ? params.configFile : "main";
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, CONFIG_FILES[fileKey]), "utf-8"));

  if (Array.isArray(params?.targets) && params.targets.length > 0) {
    const valid = params.targets.filter((t) => {
      try {
        const u = new URL(t);
        return u.protocol === "https:" && ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
      } catch { return false; }
    }).slice(0, 6);
    if (valid.length > 0) base.targets = valid;
    if (valid.length !== params.targets.length) log(`Job targets: dropped ${params.targets.length - valid.length} disallowed URL(s)`);
  }

  const mc = params?.maxCharsPerSite;
  if (typeof mc === "number" && mc >= 500 && mc <= 500000) {
    for (const key of Object.keys(base.siteRules || {})) base.siteRules[key].maxChars = Math.floor(mc);
  }

  base.schedule = { ...(base.schedule || {}), enabled: false }; // jobs are always one-shot
  base.backend = { ...(base.backend || {}), enabled: true, baseUrl: BASE_URL }; // results must reach the store
  // temp config lives in data/, so relative paths must be re-anchored to the repo root
  base.profileDir = path.join(ROOT, "profiles", "automation-profile");
  base.outputPath = path.join(ROOT, "data", "crawl-store.json");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(base, null, 2));
  return outPath;
}

/* ── crawl runner ── */
let currentJob: Job | null = null;
let currentChild: ChildProcess | null = null;

/* ── feeds pull state (news + EDGAR every N minutes, agent-local, no job queue) ── */
let feedsChild: ChildProcess | null = null;
let lastFeedsAt = 0; // 0 → first pull happens right after agent start
let lastFeedsResult: string | null = null;

function runJob(job: Job): void {
  currentJob = job;
  let configPath: string;
  try {
    configPath = buildJobConfig(job.params);
  } catch (e) {
    log(`Job ${job._id}: config build failed: ${(e as Error).message}`);
    void completeJob(job, false, null, `config build failed: ${(e as Error).message}`);
    return;
  }

  log(`Job ${job._id} (${job.source || "?"}): starting crawl (config=${job.params?.configFile || "main"})`);
  const tail: string[] = [];
  const child = spawn("cmd.exe", ["/c", "npx", "tsx", "src/main.ts", "--config", configPath], {
    cwd: ROOT,
    windowsHide: true,
  });
  currentChild = child;

  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    tail.push(text);
    while (tail.length > 200) tail.shift();
    try { fs.appendFileSync(LOG_PATH, text); } catch { /* ignore */ }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const timeout = setTimeout(() => {
    log(`Job ${job._id}: TIMEOUT after ${CRAWL_TIMEOUT_MS / 60000}min — killing crawl tree`);
    if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  }, CRAWL_TIMEOUT_MS);

  child.on("close", (code) => {
    clearTimeout(timeout);
    const logTail = tail.join("").slice(-800);
    const stored = (logTail.match(/\[engine\] Stored: [^\n]+/g) || []).slice(-3);
    log(`Job ${job._id}: crawl exited with code ${code}`);
    void completeJob(job, code === 0, { exitCode: code, stored, logTail: stored.length ? undefined : logTail }, code === 0 ? null : `exit code ${code}`);
  });
}

async function completeJob(job: Job, ok: boolean, result: unknown, error: string | null): Promise<void> {
  currentJob = null;
  currentChild = null;
  try {
    await api(`/api/crawler/agent/jobs/${job._id}/complete`, { ok, result, error });
    log(`Job ${job._id}: reported ${ok ? "done" : "failed"}`);
  } catch (e) {
    log(`Job ${job._id}: could not report completion: ${(e as Error).message}`);
  }
}

/* ── feeds pull runner ──
 * Runs main.ts with the feeds-only config (no Chrome). Single-instance by design:
 * only started when the agent is fully idle (no crawl job, no feeds child), and while
 * it runs the agent claims no jobs — so the store file is never written concurrently.
 * lastFeedsAt is stamped at START so a crashing pull can't retry faster than the interval.
 */
function runFeedsPull(): void {
  let configPath: string;
  try {
    configPath = buildJobConfig({ configFile: "feeds" }, FEEDS_CONFIG_PATH);
  } catch (e) {
    lastFeedsAt = Date.now();
    lastFeedsResult = `config build failed: ${(e as Error).message}`;
    log(`Feeds pull: ${lastFeedsResult}`);
    return;
  }

  lastFeedsAt = Date.now();
  log("Feeds pull: starting (news + EDGAR, no browser)");
  const tail: string[] = [];
  const child = spawn("cmd.exe", ["/c", "npx", "tsx", "src/main.ts", "--config", configPath], {
    cwd: ROOT,
    windowsHide: true,
  });
  feedsChild = child;

  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    tail.push(text);
    while (tail.length > 100) tail.shift();
    try { fs.appendFileSync(LOG_PATH, text); } catch { /* ignore */ }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const timeout = setTimeout(() => {
    log(`Feeds pull: TIMEOUT after ${FEEDS_TIMEOUT_MS / 60000}min — killing`);
    if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  }, FEEDS_TIMEOUT_MS);

  child.on("close", (code) => {
    clearTimeout(timeout);
    feedsChild = null;
    const feedLines = (tail.join("").match(/\[feeds\] [^\n]+/g) || []).slice(-4);
    lastFeedsResult = code === 0
      ? (feedLines.join(" | ") || "ok (no [feeds] output)")
      : `exit code ${code}`;
    log(`Feeds pull: done (code ${code}) ${lastFeedsResult}`);
  });
}

/* ── schedule ── */
function scheduleDue(s: Schedule): boolean {
  if (!s.enabled || !s.everyHours) return false;
  const last = s.lastRunAt ? Date.parse(s.lastRunAt) : 0;
  return Date.now() - last >= s.everyHours * 3600_000;
}

function feedsDue(s: Schedule | undefined): boolean {
  const everyMinutes = typeof s?.feedsEveryMinutes === "number" ? s.feedsEveryMinutes : DEFAULT_FEEDS_EVERY_MINUTES;
  if (everyMinutes <= 0) return false; // 0 = disabled from the backend
  return Date.now() - lastFeedsAt >= everyMinutes * 60_000;
}

/* ── main loop ── */
async function tick(): Promise<void> {
  const busy = currentJob !== null || feedsChild !== null;
  const resp = await api("/api/crawler/agent/poll", {
    status: currentJob ? "crawling" : feedsChild ? "feeds" : "idle",
    hostname: HOSTNAME,
    currentJobId: currentJob?._id ?? null,
    wantJob: !busy,
    feeds: {
      lastPullAt: lastFeedsAt ? new Date(lastFeedsAt).toISOString() : null,
      pulling: feedsChild !== null,
      lastResult: lastFeedsResult,
    },
  });
  if (!busy && resp.job) {
    runJob(resp.job as Job);
  } else if (!busy && resp.schedule && scheduleDue(resp.schedule as Schedule)) {
    log(`Schedule due (every ${resp.schedule.everyHours}h) — enqueueing a 'main' crawl`);
    await api("/api/crawler/agent/jobs", { source: "schedule", params: { configFile: "main" } });
  } else if (!busy && feedsDue(resp.schedule as Schedule)) {
    runFeedsPull();
  }
}

async function main(): Promise<void> {
  if (!KEY) { log("FATAL: no ingest key (backend.local.json / CRAWLER_INGEST_KEY) — exiting."); process.exit(1); }
  if (!acquireLock()) return;
  log(`Agent started (pid=${process.pid}, host=${HOSTNAME}, backend=${BASE_URL}, poll=${POLL_MS / 1000}s)`);

  const cleanup = () => {
    try { if (currentChild?.pid) spawn("taskkill", ["/pid", String(currentChild.pid), "/T", "/F"], { windowsHide: true }); } catch { /* ignore */ }
    try { if (feedsChild?.pid) spawn("taskkill", ["/pid", String(feedsChild.pid), "/T", "/F"], { windowsHide: true }); } catch { /* ignore */ }
    try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  let failStreak = 0;
  while (true) {
    try {
      await tick();
      failStreak = 0;
    } catch (e) {
      failStreak += 1;
      // Render free tier cold-starts + reboots happen; just keep polling
      if (failStreak <= 3 || failStreak % 20 === 0) log(`Poll failed (${failStreak}x): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => { log(`FATAL: ${(e as Error).stack ?? (e as Error).message}`); process.exit(1); });
