import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Finds chrome.exe processes whose command line contains the given
 * user-data-dir and kills them. Only targets processes using *our*
 * profile — leaves the user's regular Chrome alone.
 */
export async function closeProfileChrome(userDataDir: string): Promise<void> {
  const resolved = path.resolve(userDataDir);

  // Quick check: if Chrome's lockfile doesn't exist, no instance is running
  const lockfile = path.join(resolved, "lockfile");
  if (!fs.existsSync(lockfile)) {
    console.log("[session] No Chrome lockfile found — profile is free.");
    return;
  }

  console.log("[session] Chrome lockfile detected — finding owning process…");

  if (process.platform === "win32") {
    await closeProfileChromeWin(resolved);
  } else {
    closeProfileChromeUnix(resolved);
  }

  // Wait for lock release and verify
  await sleep(2_000);

  if (fs.existsSync(lockfile)) {
    console.warn("[session] Lockfile still present — retrying with broad kill…");
    broadKillChromeWin(resolved);
    await sleep(2_000);
  }

  console.log("[session] Profile should be free now.");
}

/**
 * Uses PowerShell Get-CimInstance to find chrome.exe processes matching
 * our user-data-dir and kill them. Much more reliable than wmic on
 * modern Windows since wmic CSV output breaks on command lines with commas.
 */
async function closeProfileChromeWin(resolvedDir: string): Promise<void> {
  // Escape backslashes for the PS -match regex
  const escaped = resolvedDir.replace(/\\/g, "\\\\");

  const psScript = [
    `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"`,
    `  | Where-Object { $_.CommandLine -match '${escaped}' };`,
    `if ($procs) {`,
    `  $procs | ForEach-Object {`,
    `    Write-Output $_.ProcessId;`,
    `    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue`,
    `  }`,
    `}`,
  ].join(" ");

  try {
    const raw = execSync(`powershell -NoProfile -Command "${psScript}"`, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "ignore"],
    });

    const pids = raw.trim().split(/\s+/).filter(Boolean);
    if (pids.length > 0) {
      console.log(`[session] Killed ${pids.length} Chrome process(es): PIDs ${pids.join(", ")}`);
    } else {
      console.log("[session] No Chrome processes matched (lockfile may be stale).");
    }
  } catch (err) {
    console.warn(`[session] PowerShell kill failed: ${(err as Error).message}`);
  }
}

/** Fallback: kill ALL chrome.exe that match the profile dir (brute force). */
function broadKillChromeWin(resolvedDir: string): void {
  try {
    const raw = execSync(
      `powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force"`,
      { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "ignore"] },
    );
    console.log("[session] Broad Chrome kill executed.");
  } catch { /* no chrome running at all */ }
}

/** Linux/macOS: find and kill chrome processes matching user-data-dir. */
function closeProfileChromeUnix(resolvedDir: string): void {
  try {
    const raw = execSync("ps aux", { encoding: "utf-8", timeout: 5_000 });
    const pids = raw
      .split("\n")
      .filter((l) => l.includes("chrome") && l.includes(resolvedDir))
      .map((l) => l.trim().split(/\s+/)[1])
      .filter(Boolean);

    if (pids.length === 0) return;

    console.log(`[session] Closing ${pids.length} Chrome process(es) using profile: ${resolvedDir}`);
    for (const pid of pids) {
      try { execSync(`kill ${pid}`, { stdio: "ignore" }); } catch { /* gone */ }
    }
  } catch { /* no matches */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
