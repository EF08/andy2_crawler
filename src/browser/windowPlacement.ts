import { execFileSync } from "node:child_process";
import path from "node:path";

/** Where a headed crawler window sits on screen. See ChromeProfileSchema.windowMode. */
export type WindowMode = "normal" | "background" | "minimized";

/** PowerShell single-quoted literal (doubling any embedded quote). */
function psLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * The P/Invoke surface we need to move a window around without focusing it.
 * Kept in a literal here-string so nothing in the C# is interpolated by PowerShell.
 */
const WIN32_HELPER = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class CrawlerWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int max);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  // Top-level Chrome browser windows belonging to any of the given processes.
  public static List<IntPtr> WindowsFor(uint[] pids) {
    var wanted = new HashSet<uint>(pids);
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (!wanted.Contains(owner)) return true;
      if (!IsWindowVisible(hWnd) || GetWindowTextLength(hWnd) == 0) return true;
      var cls = new StringBuilder(256);
      GetClassName(hWnd, cls, cls.Capacity);
      if (cls.ToString() == "Chrome_WidgetWin_1") found.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // SetForegroundWindow is refused for background processes unless we share an
  // input queue with whoever currently owns the foreground.
  public static void Focus(IntPtr hWnd) {
    uint pid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint self = GetCurrentThreadId();
    AttachThreadInput(fgThread, self, true);
    SetForegroundWindow(hWnd);
    AttachThreadInput(fgThread, self, false);
  }
}
'@`;

/**
 * Pushes the crawler's Chrome window out of the way without closing or hiding it,
 * then hands focus back to whatever the user was doing.
 *
 * "background" drops it to the bottom of the z-order (HWND_BOTTOM) — it stays a
 * normal, visible window, it just sits under everything else, one step above the
 * desktop. "minimized" sends it to the taskbar instead. Both use the NOACTIVATE /
 * MINNOACTIVE variants, so neither steals the keyboard.
 *
 * Best-effort by design: a crawl must not fail because a window couldn't be moved.
 */
export function placeChromeWindow(params: {
  pid: number | undefined;
  userDataDir: string;
  mode: WindowMode;
  previousForeground?: string;
}): void {
  if (process.platform !== "win32") return;
  if (params.mode === "normal") return;

  const dir = path.resolve(params.userDataDir).toLowerCase();
  const spawnedPid = params.pid ?? 0;
  const prev = params.previousForeground ?? "0";

  // The window may belong to the process we spawned or to a browser process it
  // re-execed into, so match on our user-data-dir too — the same rule
  // closeProfileChrome uses to be sure it only ever touches our own Chrome.
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    WIN32_HELPER,
    `$dir = ${psLiteral(dir)}`,
    `$pids = New-Object System.Collections.Generic.List[uint32]`,
    `if (${spawnedPid} -ne 0) { $pids.Add([uint32]${spawnedPid}) }`,
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($dir) } | ForEach-Object { $pids.Add([uint32]$_.ProcessId) }`,
    `$handles = @()`,
    `$deadline = (Get-Date).AddSeconds(8)`,
    `while ((Get-Date) -lt $deadline) {`,
    `  $handles = @([CrawlerWin]::WindowsFor($pids.ToArray()))`,
    `  if ($handles.Count -gt 0) { break }`,
    `  Start-Sleep -Milliseconds 250`,
    `}`,
    `if ($handles.Count -eq 0) { Write-Output 'no-window'; exit 0 }`,
    `foreach ($h in $handles) {`,
    params.mode === "minimized"
      // SW_SHOWMINNOACTIVE — minimize without activating.
      ? `  [void][CrawlerWin]::ShowWindow($h, 7)`
      // HWND_BOTTOM with SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE.
      : `  [void][CrawlerWin]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, 0x0013)`,
    `}`,
    `if (${prev} -ne 0) { [CrawlerWin]::Focus([IntPtr]${prev}) }`,
    `Write-Output ('placed:' + $handles.Count)`,
    `exit 0`,
  ].join("\n");

  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    if (out.startsWith("placed:")) {
      const label = params.mode === "minimized" ? "minimized" : "sent to the back";
      console.log(`[session] Chrome window ${label} (${out.slice(7)} window(s)) — focus returned to you.`);
    } else {
      console.warn(`[session] Chrome window not found — it may still be in front.`);
    }
  } catch (err) {
    console.warn(`[session] Could not reposition the Chrome window: ${(err as Error).message}`);
  }
}

/** Handle of the window the user is currently working in, so we can hand focus back. */
export function currentForegroundWindow(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    WIN32_HELPER,
    `Write-Output ([CrawlerWin]::GetForegroundWindow().ToInt64())`,
    `exit 0`,
  ].join("\n");

  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      timeout: 20_000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return /^-?\d+$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}
