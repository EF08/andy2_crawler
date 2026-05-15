import { Page } from "playwright";
import { trimToLimit, uniqStrings } from "../extract/normalize";
import { SiteRule } from "../config/types";
import { ContentItem, ExpandTarget, ExtractedRecord, PaginationStrategy, SiteAdapter } from "./types";

export class BloombergAdapter implements SiteAdapter {
  readonly site = "bloomberg.com" as const;

  supportsUrl(url: URL): boolean {
    return url.hostname === "bloomberg.com" || url.hostname.endsWith(".bloomberg.com");
  }

  /** Bloomberg /latest uses a "Load more" button to paginate articles. */
  paginationStrategy(): PaginationStrategy {
    return {
      type: "load-more",
      buttonSelector: [
        'button:has-text("Load more")',
        'a:has-text("Load more")',
        '[role="button"]:has-text("Load more")',
        'button:has-text("More stories")',
        'a:has-text("More stories")',
      ].join(", "),
    };
  }

  async extractBase(page: Page, rule: SiteRule): Promise<ExtractedRecord> {
    const raw = await page.evaluate(() => {
      const headline =
        document.querySelector("h1")?.textContent ??
        document.querySelector("[data-module='ArticleHeader'] h1")?.textContent ??
        document.title;

      const bodyBlocks = Array.from(
        document.querySelectorAll("article p, [data-module='ArticleBody'] p, [class*='body-content'] p"),
      );
      const text = bodyBlocks.length
        ? bodyBlocks.map((p) => p.textContent ?? "").join("\n")
        : document.body?.innerText ?? "";

      // First author and timestamp for the article
      const author =
        document.querySelector("a[rel='author'], [data-component='Byline'] a")?.textContent?.trim() ?? undefined;
      const timestamp =
        document.querySelector("time")?.getAttribute("datetime") ?? undefined;

      return { title: headline, text, author, timestamp, paragraphCount: bodyBlocks.length };
    });

    const post: ContentItem = {
      text: trimToLimit(raw.text, rule.maxChars),
      author: raw.author,
      timestamp: raw.timestamp,
    };

    return {
      title: raw.title,
      posts: [post],
      comments: [], // Bloomberg articles have no comments
      metrics: { paragraphCount: raw.paragraphCount },
    };
  }

  async discoverExpandTargets(page: Page, rule: SiteRule): Promise<ExpandTarget[]> {
    // Bloomberg has no <article> or <main> tags — use broad a[href] selector
    // with a tight URL pattern that matches individual articles only.
    const urls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.getAttribute("href") ?? "")
        .filter((href) => /\/news\/articles\/|\/opinion\/\d{4}|\/features\/\d{4}/.test(href))
        .map((href) => {
          const clean = href.split("?")[0];
          return clean.startsWith("http") ? clean : `https://www.bloomberg.com${clean}`;
        });
    });

    return uniqStrings(urls).map((url) => ({ url, reason: "bloomberg article" }));
  }
}
