import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "./config/loader";
import { extractContent } from "./store/extractContent";

/** Copies text to the system clipboard (cross-platform). */
function copyToClipboard(text: string): void {
  const platform = process.platform;

  if (platform === "win32") {
    execSync("clip", { input: text });
  } else if (platform === "darwin") {
    execSync("pbcopy", { input: text });
  } else {
    execSync("xclip -selection clipboard", { input: text });
  }
}

function main(): void {
  // Any numeric arg = maxChars override; any non-numeric arg = config path
  // Examples: npm run copy -- 46750  |  npm run copy -- ./other.config.json 46750
  let configPath = path.resolve("crawler.config.json");
  let maxCharsOverride: number | undefined;

  for (const arg of process.argv.slice(2)) {
    const n = Number(arg);
    if (n > 0) {
      maxCharsOverride = n;
    } else {
      configPath = arg;
    }
  }

  const config = loadConfig(configPath);
  const maxChars = maxCharsOverride ?? config.clipboard.maxChars;

  console.log(`[copy] Store: ${config.outputPath}`);
  console.log(`[copy] Max chars: ${maxChars}`);

  const content = extractContent(config.outputPath, maxChars);
  copyToClipboard(content);

  console.log(`[copy] Copied ${content.length} chars to clipboard`);
}

main();
