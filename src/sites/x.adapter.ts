import { Page } from "playwright";
import { trimToLimit, uniqStrings } from "../extract/normalize";
import { SiteRule } from "../config/types";
import { ContentItem, ExpandTarget, ExtractedRecord, PaginationStrategy, SiteAdapter } from "./types";

export class XAdapter implements SiteAdapter {
  readonly site = "x.com" as const;

  supportsUrl(url: URL): boolean {
    return url.hostname === "x.com" || url.hostname.endsWith(".x.com");
  }

  /** X/Twitter uses infinite scroll — measure content inside <article> tags. */
  paginationStrategy(): PaginationStrategy {
    return { type: "infinite-scroll", contentSelector: "article" };
  }

  async extractBase(page: Page, rule: SiteRule): Promise<ExtractedRecord> {
    const raw = await page.evaluate(() => {
      const title = document.title || undefined;

      // Each <article> is one tweet — extract text, author, timestamp together
      const articles = Array.from(document.querySelectorAll("article"));
      const posts = articles.map((article) => {
        const langEl = article.querySelector("[lang]");
        const text = (langEl?.textContent ?? "").trim();
        if (!text) return null;

        const spans = Array.from(article.querySelectorAll("a[href*='/'] span"));
        const author = spans.find((s) => (s.textContent ?? "").startsWith("@"))?.textContent ?? undefined;
        const timeEl = article.querySelector("time");
        const timestamp = timeEl?.getAttribute("datetime") ?? undefined;

        return { text, author, timestamp };
      }).filter(Boolean) as Array<{ text: string; author?: string; timestamp?: string }>;

      return { title, posts };
    });

    // Trim each post's text by the per-comment limit
    const posts: ContentItem[] = raw.posts.map((p) => ({
      ...p,
      text: trimToLimit(p.text, rule.maxCharsPerComment),
    }));

    return {
      title: raw.title,
      posts,
      comments: [], // No comments at feed level — each tweet is a post
      metrics: { postCount: posts.length },
    };
  }

  async discoverExpandTargets(page: Page, rule: SiteRule): Promise<ExpandTarget[]> {
    const urls = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      return anchors
        .map((a) => a.getAttribute("href") ?? "")
        .filter((href) => /^\/[^/]+\/status\/\d+/.test(href))
        .map((href) => `https://x.com${href.split("?")[0]}`);
    });

    return uniqStrings(urls)
      .map((url) => ({ url, reason: "tweet permalink" }));
  }
}
