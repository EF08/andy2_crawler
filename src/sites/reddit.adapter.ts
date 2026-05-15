import { Page } from "playwright";
import { squeezeWhitespace, trimToLimit, uniqStrings } from "../extract/normalize";
import { SiteRule } from "../config/types";
import { ContentItem, ExpandTarget, ExtractedRecord, PaginationStrategy, SiteAdapter } from "./types";

export class RedditAdapter implements SiteAdapter {
  readonly site = "reddit.com" as const;

  supportsUrl(url: URL): boolean {
    return url.hostname === "reddit.com" || url.hostname.endsWith(".reddit.com");
  }

  /** Reddit uses infinite scroll for feeds and search results. */
  paginationStrategy(): PaginationStrategy {
    return { type: "infinite-scroll" };
  }

  async extractBase(page: Page, rule: SiteRule): Promise<ExtractedRecord> {
    const raw = await page.evaluate(() => {
      const title = document.querySelector("h1")?.textContent ?? document.title;

      // Post body — target the rtjson content div, then specific selectors
      const postBody =
        document.querySelector("[slot='text-body']")?.textContent ??
        document.querySelector("[data-click-id='text']")?.textContent ??
        document.body?.innerText ?? "";

      // Post author + timestamp from page-level elements
      const postAuthor =
        document.querySelector("shreddit-post")?.getAttribute("author") ??
        document.querySelector("a[href*='/user/']")?.textContent ??
        document.querySelector("a[href*='/u/']")?.textContent ?? undefined;
      const postTime =
        document.querySelector("shreddit-post")?.getAttribute("created-timestamp") ??
        (document.querySelector("faceplate-timeago") ?? document.querySelector("time"))
          ?.getAttribute("datetime") ?? undefined;

      // Extract only top-level shreddit-comment nodes (avoid nested replies)
      const commentNodes = Array.from(
        document.querySelectorAll("shreddit-comment, [data-testid='comment']"),
      );
      const comments = commentNodes.map((node) => {
        // Target the comment body slot — not the entire subtree
        const bodyEl =
          node.querySelector('[slot="comment"]') ??
          node.querySelector('div[id$="-comment-rtjson-content"]');
        const text = (bodyEl?.textContent ?? "").trim();
        if (!text) return null;

        // Author is an attribute on the shreddit-comment element itself
        const author =
          node.getAttribute("author") ??
          node.querySelector("a[href*='/user/'], a[href*='/u/']")?.textContent?.trim() ??
          undefined;

        // Timestamp from element attribute, then child elements as fallback
        const timestamp =
          node.getAttribute("created-timestamp") ??
          node.querySelector("faceplate-timeago, time")?.getAttribute("datetime") ??
          undefined;

        return { text, author, timestamp };
      }).filter(Boolean) as Array<{ text: string; author?: string; timestamp?: string }>;

      const score = document.querySelector("[id*='vote-arrows']")?.textContent ?? "";

      return { title, postBody: postBody.trim(), postAuthor, postTime, comments, score };
    });

    const post: ContentItem = {
      text: trimToLimit(squeezeWhitespace(raw.postBody), rule.maxChars),
      author: raw.postAuthor ?? undefined,
      timestamp: raw.postTime ?? undefined,
    };

    const comments: ContentItem[] = raw.comments
      .slice(0, 30)
      .map((c) => ({
        text: trimToLimit(squeezeWhitespace(c.text), rule.maxCharsPerComment),
        author: c.author,
        timestamp: c.timestamp,
      }));

    console.log(
      `[reddit] Extracted ${comments.length} comments ` +
      `(${comments.filter((c) => !c.author).length} missing author)`,
    );

    return {
      title: raw.title,
      posts: [post],
      comments,
      metrics: { score: raw.score, commentCount: comments.length },
    };
  }

  async discoverExpandTargets(page: Page, _rule: SiteRule): Promise<ExpandTarget[]> {
    // Post title links on search/feed pages (most specific selector)
    const titleUrls = await page.$$eval(
      'a[data-testid="post-title"]',
      (links) => links.map((a) => a.getAttribute("href") ?? ""),
    );

    // Fallback: <shreddit-post> elements expose a permalink attribute
    const shredditUrls = await page.$$eval(
      "shreddit-post[permalink]",
      (els) => els.map((el) => el.getAttribute("permalink") ?? ""),
    );

    const allHrefs = [...titleUrls, ...shredditUrls]
      .filter((href) => /\/r\/[^/]+\/comments\//.test(href))
      .map((href) => {
        const clean = href.split("?")[0];
        return clean.startsWith("http") ? clean : `https://www.reddit.com${clean}`;
      });

    const uniqueUrls = uniqStrings(allHrefs);
    console.log(
      `[reddit] Discovered ${uniqueUrls.length} post links ` +
      `(${titleUrls.length} title, ${shredditUrls.length} shreddit)`,
    );

    return uniqueUrls.map((url) => ({ url, reason: "reddit post thread" }));
  }
}
