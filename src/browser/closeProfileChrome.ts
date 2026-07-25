import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Frees the automation profile before launching, by closing only the Chrome
 * processes that are actually using it.
 *
 * The hard rule here: never kill Chrome we didn't start. An earlier version fell back to
 * `Get-Process chrome | Stop-Process -Force` when its targeted kill failed — which took
 * out Andy's personal browsing (and the marketer agent's browser) along with it, leaving
 * those profiles flagged as crashed, so every launch opened with "Restore pages?". Worse,
 * that targeted kill failed *every* time: its PowerShell was double-quoted inside a
 * double-quoted -Command string, so the fallback was the only path that ever ran.
 *
 * If nothing owns the profile, the lockfile is simply a leftover from an ungraceful exit,
 * and removing that file is the correct fix — not killing browsers.
 */
export async function closeProfileChrome(userDataDir: string): Promise<void> {
  const resolved = path.resolve(userDataDir);
  const lockfile = path.join(resolved, "lockfile");

  if (!fs.existsSync(lockfile)) {
    console.log("[session] No Chrome lockfile found — profile is free.");
    return;
  }
  console.log("[session] Chrome lockfile detected — finding the process that owns it…");

  const killed = process.platform === "win32"
    ? killProfileChromeWin(resolved)
    : killProfileChromeUnix(resolved);

  if (killed > 0) await sleep(2_000);
  if (!fs.existsSync(lockfile)) {
    console.log("[session] Profile is free now.");
    return;
  }

  if (killed === 0) {
    // Nothing is using this profile, so the lockfile is stale — that, we can clean up.
    try {
      fs.unlinkSync(lockfile);
      console.log("[session] No Chrome owns this profile — removed the stale lockfile.");
    } catch (err) {
      console.warn(`[session] Stale lockfile could not be removed: ${(err as Error).message}`);
    }
    return;
  }
  console.warn(`[session] Lockfile still present after closing ${killed} Chrome process(es) — launching anyway.`);
}

/** PowerShell single-quoted literal (doubling any embedded quote). */
function psLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Kill the chrome.exe processes whose command line contains our user-data-dir.
 * Passed to PowerShell as one argv element — no shell re-quoting — and written with
 * single quotes only, so nothing can collide with the outer quoting again.
 */
function killProfileChromeWin(resolvedDir: string): number {
  // `exit 0` matters: killing a parent Chrome takes its children with it, so the next
  // Stop-Process hits a pid that's already gone. That error is suppressed but still
  // leaves PowerShell exiting non-zero, which made execFileSync throw and report a
  // successful kill as "could not enumerate".
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue';`,
    `$dir = ${psLiteral(resolvedDir.toLowerCase())};`,
    `$procs = @(Get-CimInstance Win32_Process |`,
    `  Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($dir) });`,
    `foreach ($p in $procs) { Write-Output $p.ProcessId; Stop-Process -Id $p.ProcessId -Force }`,
    `exit 0`,
  ].join(" ");

  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      timeout: 20_000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pids = raw.trim().split(/\s+/).filter(Boolean);
    if (pids.length) console.log(`[session] Closed ${pids.length} Chrome process(es) using this profile: ${pids.join(", ")}`);
    else console.log("[session] No Chrome process is using this profile.");
    return pids.length;
  } catch (err) {
    console.warn(`[session] Could not enumerate Chrome processes: ${(err as Error).message}`);
    return 0;
  }
}

/** Linux/macOS: same rule — only processes whose command line names our profile dir. */
function killProfileChromeUnix(resolvedDir: string): number {
  try {
    const raw = execSync("ps ax -o pid=,command=", { encoding: "utf-8", timeout: 5_000 });
    const pids = raw
      .split("\n")
      .filter((l) => /chrome/i.test(l) && l.includes(resolvedDir))
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean);

    if (!pids.length) {
      console.log("[session] No Chrome process is using this profile.");
      return 0;
    }
    console.log(`[session] Closing ${pids.length} Chrome process(es) using this profile: ${pids.join(", ")}`);
    for (const pid of pids) {
      try { execSync(`kill ${pid}`, { stdio: "ignore" }); } catch { /* already gone */ }
    }
    return pids.length;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
