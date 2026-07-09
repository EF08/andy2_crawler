/** One headline / filing pulled from an HTTP feed, before it becomes a CrawlSnapshot. */
export type FeedItem = {
  site: "globenewswire.com" | "news.google.com" | "sec.gov";
  /** Link to the article / press release / filing index. */
  url: string;
  title: string;
  /** Full text stored as the snapshot's single post (title + summary/items). */
  text: string;
  /** Company (GNW/EDGAR) or publisher (Google News). */
  author?: string;
  /** ISO timestamp of publication/filing, when the feed provided a parseable one. */
  timestamp?: string;
  metrics: Record<string, string | number>;
};

export type FeedSourceCounts = {
  fetched: number;
  stored: number;
  skippedKnown: number;
  skippedOld: number;
  chars: number;
};
