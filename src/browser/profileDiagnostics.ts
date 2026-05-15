import fs from "node:fs";
import path from "node:path";

type FileCheck = { label: string; path: string };

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "n/a";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function existsInfo(filePath: string): { exists: boolean; size?: number } {
  try {
    const st = fs.statSync(filePath);
    return { exists: st.isFile() || st.isDirectory(), size: st.isFile() ? st.size : undefined };
  } catch {
    return { exists: false };
  }
}

export function logChromeProfileDiagnostics(userDataDir: string, profileDirectory?: string): void {
  const localStatePath = path.join(userDataDir, "Local State");
  const singletonLockPath = path.join(userDataDir, "SingletonLock");
  const singletonCookiePath = path.join(userDataDir, "SingletonCookie");
  const singletonSocketPath = path.join(userDataDir, "SingletonSocket");
  const profileDir = profileDirectory ? path.join(userDataDir, profileDirectory) : userDataDir;

  const checks: FileCheck[] = [
    { label: "Local State", path: localStatePath },
    { label: "SingletonLock", path: singletonLockPath },
    { label: "SingletonCookie", path: singletonCookiePath },
    { label: "SingletonSocket", path: singletonSocketPath },
    { label: "Profile dir", path: profileDir },
    ...(profileDirectory
      ? [
          { label: "Preferences", path: path.join(profileDir, "Preferences") },
          { label: "Cookies", path: path.join(profileDir, "Network", "Cookies") },
          { label: "Login Data", path: path.join(profileDir, "Login Data") },
        ]
      : []),
  ];

  console.log(`[session] Chrome diagnostics:`);
  for (const c of checks) {
    const info = existsInfo(c.path);
    const suffix = info.exists
      ? info.size !== undefined
        ? `OK (${formatBytes(info.size)})`
        : "OK"
      : "MISSING";
    console.log(`[session] - ${c.label}: ${suffix} :: ${c.path}`);
  }
}

