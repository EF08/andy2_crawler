import fs from "node:fs";
import path from "node:path";

// Files/dirs that carry login sessions, cookies, and site data.
const ESSENTIAL_FILES = [
  "Preferences",
  "Cookies",
  "Login Data",
  "Login Data For Account",
  "Web Data",
  "Favicons",
  "Top Sites",
  "Bookmarks",
  "Secure Preferences",
];

/**
 * Chrome 127+ stores the profile encryption key in `Local State` using
 * "App-Bound Encryption" (ABE) — a system service that validates the caller
 * is a genuine Chrome binary.  Playwright-launched Chrome fails that check,
 * so DPAPI decryption returns ERROR_INVALID_PARAMETER (0x57) and Chrome exits
 * before creating any window.
 *
 * Fix: strip `os_crypt.encrypted_key` so Chrome generates a fresh key in the
 * automation profile without ABE.  Existing cookies encrypted with the old
 * key are unreadable anyway, so nothing is lost.
 */
function patchLocalState(localStatePath: string): void {
  if (!fs.existsSync(localStatePath)) return;
  try {
    const raw = fs.readFileSync(localStatePath, "utf8");
    const obj = JSON.parse(raw);
    if (obj?.os_crypt?.encrypted_key) {
      delete obj.os_crypt.encrypted_key;
      fs.writeFileSync(localStatePath, JSON.stringify(obj));
      console.log("[session] Patched Local State: removed ABE encrypted_key");
    }
  } catch (err) {
    console.warn("[session] Could not patch Local State:", err);
  }
}

const ESSENTIAL_DIRS = [
  "Network",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "databases",
  "Extension State",
  "Local Extension Settings",
];

function copyFileIfExists(src: string, dest: string): void {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

function copyDirIfExists(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: true });
}

/**
 * Copies essential auth/session data from the real Chrome profile into a
 * Playwright-compatible user-data-dir. Returns the new user-data-dir path.
 */
export function syncProfileForCrawler(
  realUserDataDir: string,
  profileDirectory: string,
  crawlerProfileDir: string,
): string {
  const srcProfile = path.join(realUserDataDir, profileDirectory);
  const destProfile = path.join(crawlerProfileDir, profileDirectory);

  fs.mkdirSync(destProfile, { recursive: true });

  // Copy Local State and strip the ABE encryption key so Chrome can launch.
  const destLocalState = path.join(crawlerProfileDir, "Local State");
  copyFileIfExists(path.join(realUserDataDir, "Local State"), destLocalState);
  patchLocalState(destLocalState);

  // Copy essential profile files.
  let copiedCount = 0;
  for (const file of ESSENTIAL_FILES) {
    const src = path.join(srcProfile, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destProfile, file));
      copiedCount++;
    }
  }

  // Copy essential profile directories.
  for (const dir of ESSENTIAL_DIRS) {
    const src = path.join(srcProfile, dir);
    if (fs.existsSync(src)) {
      copyDirIfExists(src, path.join(destProfile, dir));
      copiedCount++;
    }
  }

  console.log(
    `[session] Synced ${copiedCount} items from ${srcProfile} -> ${destProfile}`,
  );

  return crawlerProfileDir;
}
