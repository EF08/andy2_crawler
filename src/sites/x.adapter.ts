import { Page } from "playwright";
import { uniqStrings } from "../extract/normalize";
import { SiteRule } from "../config/types";
import { ExpandTarget, ExtractedRecord, PaginationStrategy, SiteAdapter } from "./types";

export class XAdapter implements SiteAdapter {
  readonly site = "x.com" as const;
  supportsUrl(url: URL): boolean { return url.hostname === "x.com" || url.hostname.endsWith(".x.com"); }
  paginationStrategy(): PaginationStrategy { return { type: "infinite-scroll", contentSelector: "article" }; }

  async extractBase(page: Page, _rule: SiteRule): Promise<ExtractedRecord> {
    const raw = await page.evaluate(() => {
      const posts = Array.from(document.querySelectorAll('article[data-testid="tweet"], article')).map(article => {
        const time = article.querySelector('time');
        const href = time?.closest('a')?.getAttribute('href') ?? '';
        const match = href.match(/^\/(\w+)\/status\/(\d+)/);
        // Never substitute the page URL or a quoted tweet's permalink for the author tweet.
        const texts = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
        const text = (texts[0]?.textContent ?? article.querySelector('[lang]')?.textContent ?? '').trim();
        const user = article.querySelector('[data-testid="User-Name"]');
        const author = match ? '@' + match[1] : user?.textContent?.match(/@\w+/)?.[0] ||
          Array.from(article.querySelectorAll('a span')).map(s => s.textContent || '').find(t => /^@\w+$/.test(t));
        const links = Array.from(article.querySelectorAll('a[href]')).map(a =>
          a.getAttribute('data-expanded-url') || a.getAttribute('title')?.match(/^https?:\/\/\S+$/)?.[0] || (a as HTMLAnchorElement).href
        ).filter(u => /^https?:\/\//.test(u) && !/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//.test(u));
        const quoteText = texts[1];
        const quote = quoteText?.closest('[role="link"]');
        const qt = quote?.querySelector('time');
        const qhref = qt?.closest('a')?.getAttribute('href') ?? quote?.querySelector('a[href*="/status/"]')?.getAttribute('href') ?? '';
        const qm = qhref.match(/^\/(\w+)\/status\/(\d+)/);
        return {
          text, author, timestamp: time?.getAttribute('datetime') ?? undefined,
          tweetId: match?.[2], url: match ? `https://x.com/${match[1]}/status/${match[2]}` : undefined,
          linkedSourceUrls: [...new Set(links)],
          truncatedText: !!article.querySelector('[data-testid="tweet-text-show-more-link"]') || /(?:…|\.\.\.)\s*$/.test(text),
          unreadImageContent: !!article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]'),
          ...(quoteText ? { quotedPost: {
            text: quoteText.textContent?.trim() ?? '', author: qm ? '@' + qm[1] : quote?.textContent?.match(/@\w+/)?.[0],
            tweetId: qm?.[2], url: qm ? `https://x.com/${qm[1]}/status/${qm[2]}` : undefined,
            timestamp: qt?.getAttribute('datetime') ?? undefined,
          } } : {}),
        };
      }).filter(p => p.text || p.tweetId);
      return { title: document.title, posts };
    });
    return { ...raw, comments: [], metrics: { postCount: raw.posts.length } };
  }
  async discoverExpandTargets(page: Page, _rule: SiteRule): Promise<ExpandTarget[]> {
    const urls = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href') ?? '').filter(h => /^\/[^/]+\/status\/\d+/.test(h))
      .map(h => `https://x.com${h.split('?')[0]}`));
    return uniqStrings(urls).map(url => ({ url, reason: "tweet permalink" }));
  }
}
