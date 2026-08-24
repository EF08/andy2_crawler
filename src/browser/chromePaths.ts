import fs from "node:fs";
import path from "node:path";

export function detectChromeExecutable(explicitPath?: string): string {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`[chrome] chromeExecutablePath does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }

  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA;

  const candidates = [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData
      ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(`[chrome] Could not find chrome.exe. Set chrome.chromeExecutablePath in config.`);
}


/**
 * Major version of the installed Chrome, read from the versioned resource folder
 * that sits next to chrome.exe (e.g. ".../Application/151.0.7922.170/").
 * Used to build a believable user-agent for headless runs.
 */
export function detectChromeMajorVersion(exePath: string): number | undefined {
  try {
    const dir = path.dirname(exePath);
    let best = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = /^(\d+)\.\d+\.\d+\.\d+$/.exec(entry.name);
      if (match) best = Math.max(best, Number(match[1]));
    }
    return best || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user-agent a *headful* Chrome of this version would send on this OS.
 *
 * The UA string is the only place modern headless Chrome still identifies itself:
 * it swaps the "Chrome/<v>" product token for "HeadlessChrome/<v>", which every bot
 * detector treats as an automation signal. Its Sec-CH-UA client hints are already
 * clean (verified on Chrome 151), so they are deliberately left alone — rewriting
 * them would only risk a UA/client-hint mismatch, which is itself a detection signal.
 */
export function headfulUserAgent(majorVersion: number): string {
  const platform =
    process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : process.platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";
  return (
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${majorVersion}.0.0.0 Safari/537.36`
  );
}
