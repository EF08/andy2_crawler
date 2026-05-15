import { Page } from "playwright";
import { SiteRule } from "../config/types";

export type ExpandTarget = {
  url: string;
  reason: string;
};

/** A single piece of content (post or comment) paired with its attribution. */
export type ContentItem = {
  text: string;
  author?: string;
  timestamp?: string;
};

export type ExtractedRecord = {
  title?: string;
  posts: ContentItem[];
  comments: ContentItem[];
  metrics: Record<string, string | number>;
  sourceUrl?: string; // Track which URL this record came from
};

/** Defines how a site loads more content beyond the initial render.
 *  Pagination stops via char target or stallLimit (from SiteRule config). */
export type PaginationStrategy =
  | {
      type: "infinite-scroll";
      /** CSS selector to measure content length (default: "body") */
      contentSelector?: string;
    }
  | {
      type: "load-more";
      /** CSS selector for the "Load more" button */
      buttonSelector: string;
      /** CSS selector to measure content length (default: "body") */
      contentSelector?: string;
    };

export interface SiteAdapter {
  readonly site: "x.com" | "reddit.com" | "bloomberg.com";
  supportsUrl(url: URL): boolean;
  extractBase(page: Page, rule: SiteRule): Promise<ExtractedRecord>;
  discoverExpandTargets(page: Page, rule: SiteRule): Promise<ExpandTarget[]>;
  /** Returns the pagination strategy for loading more content on this site. */
  paginationStrategy(): PaginationStrategy;
}
