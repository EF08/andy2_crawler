import fs from "node:fs";
import { CrawlStore } from "./schema";

/**
 * Cleans text by:
 * - Removing excessive whitespace (tabs, newlines, multiple spaces)
 * - Trimming leading/trailing whitespace
 * - Normalizing to single spaces between words
 */
function cleanText(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ") // Replace newlines and tabs with spaces
    .replace(/\s{2,}/g, " ") // Replace multiple spaces with single space
    .trim(); // Remove leading/trailing whitespace
}

/**
 * Cleans title specifically:
 * - Removes excessive whitespace
 * - Strips empty lines
 * - Makes it a single readable line
 */
function cleanTitle(title: string | undefined): string {
  if (!title) return "Untitled";
  return cleanText(title);
}

/** Pulls clean "title + text" from every latest snapshot (no authors/timing). */
export function extractContent(storePath: string, maxChars: number): string {
  if (!fs.existsSync(storePath)) {
    throw new Error(`Store file not found: ${storePath}`);
  }

  const store: CrawlStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
  const parts: string[] = [];

  // Walk every site → every URL → grab title, post text + comment text
  for (const [site, urls] of Object.entries(store.latest)) {
    for (const [url, snapshot] of Object.entries(urls)) {
      const cleanedTitle = cleanTitle(snapshot.content.title);
      const header = `--- ${site} | ${cleanedTitle} ---`;
      parts.push(header);

      // Add cleaned post text
      for (const post of snapshot.content.posts ?? []) {
        if (post.text) {
          const cleaned = cleanText(post.text);
          if (cleaned) parts.push(cleaned);
        }
      }

      // Add cleaned comment text
      for (const comment of snapshot.content.comments ?? []) {
        if (comment.text) {
          const cleaned = cleanText(comment.text);
          if (cleaned) parts.push(cleaned);
        }
      }

      parts.push(""); // blank line separator
    }
  }

  const full = parts.join("\n");

  // Truncate at word boundary if over limit
  if (full.length <= maxChars) return full;
  const truncated = full.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "\n[...truncated]";
}
