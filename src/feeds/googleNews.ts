import { FeedsConfig } from "../config/types";
import { squeezeWhitespace } from "../extract/normalize";
import { FeedItem } from "./types";
import { asArray, fetchFeed, parseXml, textOf, toIso } from "./xml";

/**
 * Google News RSS search feeds (default: Bloomberg/Reuters/WSJ articles).
 * Item links are Google News redirect URLs — stable per article, so they still
 * work as dedup keys; titles carry a trailing " - Publisher" which we strip.
 */
export async function fetchGoogleNews(cfg: FeedsConfig): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const feedUrl of cfg.googleNews.feeds) {
    const xml = await fetchFeed(feedUrl, { userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs });
    const channel = parseXml(xml)?.rss?.channel;

    for (const item of asArray<any>(channel?.item)) {
      const url = squeezeWhitespace(textOf(item?.link));
      let title = squeezeWhitespace(textOf(item?.title));
      if (!url || !title || title.length < 6) continue;

      const publisher = squeezeWhitespace(textOf(item?.source)) || undefined;
      // "Headline - Bloomberg.com" → "Headline" (only when the suffix matches the source)
      if (publisher) {
        const suffix = new RegExp(`\\s*-\\s*${publisher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.com)?$`, "i");
        title = title.replace(suffix, "").trim() || title;
      } else {
        title = title.replace(/\s*-\s*[\w.\s]{2,30}$/, "").trim() || title;
      }

      const metrics: FeedItem["metrics"] = {};
      if (publisher) metrics.publisher = publisher;

      items.push({
        site: "news.google.com",
        url,
        title,
        text: publisher ? `${title} (${publisher})` : title,
        author: publisher,
        timestamp: toIso(item?.pubDate),
        metrics,
      });
    }
  }

  return items;
}
