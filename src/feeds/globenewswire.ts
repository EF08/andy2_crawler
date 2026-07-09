import { FeedsConfig } from "../config/types";
import { squeezeWhitespace, trimToLimit } from "../extract/normalize";
import { FeedItem } from "./types";
import { asArray, fetchFeed, parseXml, stripHtml, textOf, toIso } from "./xml";

/**
 * GlobeNewswire official category RSS feeds (press releases: earnings, M&A, bankruptcy, …).
 * Each feed carries the last ~20 releases with a first-paragraph description, the issuing
 * company (dc:contributor), and stock tickers as <category domain="…/rss/stock"> entries.
 */
export async function fetchGlobeNewswire(cfg: FeedsConfig): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const feedUrl of cfg.globenewswire.feeds) {
    const xml = await fetchFeed(feedUrl, { userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs });
    const channel = parseXml(xml)?.rss?.channel;
    const feedTitle = squeezeWhitespace(textOf(channel?.title));
    // "GlobeNewswire - Mergers and Acquisitions" → "Mergers and Acquisitions"
    const category = feedTitle.replace(/^GlobeNewswire\s*-\s*/i, "") || feedTitle;

    for (const item of asArray<any>(channel?.item)) {
      const url = squeezeWhitespace(textOf(item?.link));
      const title = squeezeWhitespace(textOf(item?.title));
      if (!url || !title || title.length < 6) continue;

      const summary = trimToLimit(stripHtml(textOf(item?.description)), 800);
      const company = squeezeWhitespace(textOf(item?.["dc:contributor"])) || undefined;
      const tickers = asArray<any>(item?.category)
        .filter((c) => String(c?.["@_domain"] || "").includes("/rss/stock"))
        .map((c) => squeezeWhitespace(textOf(c)))
        .filter(Boolean);

      const headline = tickers.length ? `${title} [${tickers.join(", ")}]` : title;
      const metrics: FeedItem["metrics"] = { feed: category };
      if (tickers.length) metrics.tickers = tickers.join(", ");

      items.push({
        site: "globenewswire.com",
        url,
        title,
        text: summary ? `${headline} — ${summary}` : headline,
        author: company,
        timestamp: toIso(item?.pubDate),
        metrics,
      });
    }
  }

  return items;
}
