import fs from "node:fs";
import path from "node:path";
import { CrawlerConfig, CrawlerConfigSchema } from "./types";
import { detectSystemChromeProfile } from "./chromeDetect";

function resolvePath(baseDir: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(baseDir, target);
}

export function loadConfig(configPath: string): CrawlerConfig {
  const absolutePath = path.resolve(configPath);
  const raw = fs.readFileSync(absolutePath, "utf-8");
  const rawObj = JSON.parse(raw) as any;
  const parsed = CrawlerConfigSchema.parse(rawObj);
  const baseDir = path.dirname(absolutePath);

  const normalized: CrawlerConfig = {
    ...parsed,
    profileDir: resolvePath(baseDir, parsed.profileDir),
    outputPath: resolvePath(baseDir, parsed.outputPath),
    chrome: {
      ...parsed.chrome,
      userDataDir: parsed.chrome.userDataDir
        ? resolvePath(baseDir, parsed.chrome.userDataDir)
        : undefined,
    },
  };

  if (normalized.behavior.waitMinMs > normalized.behavior.waitMaxMs) {
    throw new Error("Invalid config: behavior.waitMinMs must be <= behavior.waitMaxMs");
  }

  // If requested, auto-detect the real system Chrome profile.
  if (normalized.chrome.useSystemProfile) {
    const detected = detectSystemChromeProfile();
    normalized.chrome.userDataDir = normalized.chrome.userDataDir ?? detected.userDataDir;
    normalized.chrome.profileDirectory = normalized.chrome.profileDirectory ?? detected.profileDirectory;
    // Default to CDP mode when using real profile (unless user explicitly set it).
    if (rawObj?.chrome?.mode === undefined) {
      normalized.chrome.mode = "cdp";
    }
  }

  return normalized;
}
