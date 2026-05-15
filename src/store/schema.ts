import { ContentItem } from "../sites/types";

export type { ContentItem };

export type CrawlSnapshot = {
  id: string;
  runId: string;
  site: string;
  sourceUrl: string;
  canonicalUrl: string;
  capturedAtIso: string;
  capturedAtLocal: string;
  content: {
    title?: string;
    posts: ContentItem[];
    comments: ContentItem[];
  };
  metrics: Record<string, string | number>;
  /** URLs visited during post-level expansion (for cross-run dedup). */
  expandedUrls?: string[];
};

export type CrawlErrorRecord = {
  runId: string;
  site: string;
  sourceUrl: string;
  stage: string;
  message: string;
  capturedAtIso: string;
  capturedAtLocal: string;
};

export const STORE_VERSION = 2;

export type CrawlStore = {
  version: number;
  latest: Record<string, Record<string, CrawlSnapshot>>;
  history: Record<string, Record<string, CrawlSnapshot[]>>;
  index: {
    runs: Record<string, string[]>;
    byDate: Record<string, string[]>;
  };
  errors: CrawlErrorRecord[];
};

export function createEmptyStore(): CrawlStore {
  return {
    version: STORE_VERSION,
    latest: {},
    history: {},
    index: { runs: {}, byDate: {} },
    errors: [],
  };
}
