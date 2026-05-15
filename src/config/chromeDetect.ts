import fs from "node:fs";
import path from "node:path";

export type DetectedChromeProfile = {
  userDataDir: string;
  profileDirectory: string;
  profileName?: string;
};

type Candidate = {
  userDataDir: string;
  localStatePath: string;
  profileDirectory: string;
  profileName?: string;
  preferencesPath: string;
  localStateMtimeMs: number;
};

function safeStatMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function parseLocalState(localStatePath: string): { profileDirectory: string; profileName?: string } {
  const raw = fs.readFileSync(localStatePath, "utf-8");
  const parsed = JSON.parse(raw) as any;
  const profile = parsed?.profile ?? {};
  const profileDirectory = profile.last_used || "Default";
  const profileName = profile.info_cache?.[profileDirectory]?.name as string | undefined;
  return { profileDirectory, profileName };
}

export function detectSystemChromeProfile(): DetectedChromeProfile {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("Cannot detect Chrome profile: LOCALAPPDATA is not set.");
  }

  const chromeRoot = path.join(localAppData, "Google", "Chrome", "User Data");
  if (!fs.existsSync(chromeRoot)) {
    throw new Error(`Cannot detect Chrome profile: missing Chrome User Data dir at ${chromeRoot}`);
  }

  const candidates: Candidate[] = [];
  const possibleUserDataDirs = [chromeRoot];

  // Some installations have an extra level (e.g. "a1a2") that contains its own Local State + profiles.
  try {
    const children = fs.readdirSync(chromeRoot, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const maybe = path.join(chromeRoot, child.name);
      if (fs.existsSync(path.join(maybe, "Local State"))) {
        possibleUserDataDirs.push(maybe);
      }
    }
  } catch {
    // ignore
  }

  for (const userDataDir of possibleUserDataDirs) {
    const localStatePath = path.join(userDataDir, "Local State");
    if (!fs.existsSync(localStatePath)) continue;

    try {
      const { profileDirectory, profileName } = parseLocalState(localStatePath);
      const preferencesPath = path.join(userDataDir, profileDirectory, "Preferences");
      candidates.push({
        userDataDir,
        localStatePath,
        profileDirectory,
        profileName,
        preferencesPath,
        localStateMtimeMs: safeStatMtimeMs(localStatePath),
      });
    } catch {
      // ignore bad candidate
    }
  }

  // Prefer a candidate that has Preferences for the last_used profile.
  const withPreferences = candidates.filter((c) => fs.existsSync(c.preferencesPath));
  const best = (withPreferences.length ? withPreferences : candidates).sort(
    (a, b) => b.localStateMtimeMs - a.localStateMtimeMs,
  )[0];

  if (!best) {
    throw new Error("Cannot detect Chrome profile: no valid Local State found.");
  }

  return {
    userDataDir: best.userDataDir,
    profileDirectory: best.profileDirectory,
    profileName: best.profileName,
  };
}

