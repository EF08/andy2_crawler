import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader";
import { launchSession } from "../browser/session";

/**
 * Verifies the graceful-close fix: launches a session, closes it, then
 * checks that Chrome recorded a clean exit ("exit_type": "Normal") so the
 * "Chrome didn't shut down correctly" bubble won't appear next launch.
 */
async function main() {
  const config = loadConfig(path.resolve("crawler.config.json"));
  const session = await launchSession(config);

  const page = session.context.pages()[0] ?? (await session.context.newPage());
  await page.goto("about:blank");
  await new Promise((r) => setTimeout(r, 2_000));

  await session.close();

  // Give Chrome a moment to flush Preferences to disk.
  await new Promise((r) => setTimeout(r, 2_000));

  const prefsPath = path.resolve("profiles/automation-profile/Default/Preferences");
  const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
  const exitType = prefs.profile?.exit_type;
  const lockfileExists = fs.existsSync(path.resolve("profiles/automation-profile/lockfile"));

  console.log(`[test] exit_type: ${exitType}`);
  console.log(`[test] lockfile exists: ${lockfileExists}`);

  if (exitType !== "Normal") {
    console.error("[test] FAIL — Chrome still recorded a crash exit.");
    process.exit(1);
  }
  console.log("[test] PASS — Chrome exited cleanly.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
