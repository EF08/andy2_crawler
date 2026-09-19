import crypto from "node:crypto";
import { Page, Response } from "playwright";
import { CrawlerConfig } from "../config/types";
import { XAdapter } from "../sites/x.adapter";
import { ContentItem } from "../sites/types";
import { CrawlSnapshot } from "../store/schema";
import { JsonStore } from "../store/jsonStore";
import { deliveredPost } from './deliveredPost';

export type SearchSpec = CrawlerConfig["xSearches"][number];
export type SearchHealth = {
  query: string; effectiveQuery: string; profile?: string; jobId?: string; runId: string;
  startedAt: string; finishedAt: string; status: string; error: string | null;
  collected: number; newestPostTimestamp: string | null; truncated: boolean;
  stopReason: string; attempts: number; latestSelected: boolean; sourceUrl: string;
  failures: { attempt: number; status: string; detail: string }[];
};
class SearchFailure extends Error {
  constructor(readonly status: string, detail: string) { super(`${status}: ${detail}`); }
}
function detectedFailure(url: string, text: string, status: number | undefined, source: string): SearchFailure | null {
  const kind = classifySearchFailure(url, text, status);
  if (!kind) return null;
  // Persist only fixed detector phrases and status codes, never page text or response bodies.
  const signal = text.match(/rate limit|too many requests|exceeded.*limit|sign in to x|log in to x|verify you are human|unusual activity|authenticate your account|something went wrong|try reloading/i)?.[0];
  const detail = status && status >= 400 ? `${source} HTTP ${status}`
    : /\/i\/flow\/login|\/login(?:\?|$)/.test(url) ? 'login redirect'
    : `page signal: ${signal?.toLowerCase().replace(/exceeded.*limit/i, 'exceeded limit') ?? kind}`;
  return new SearchFailure(kind, detail);
}
export function searchUrl(query: string, since?: string): string {
  // Web search's date operator has day resolution. Apply exact UTC cutoff again after extraction.
  const effective = since ? `(${query}) since:${new Date(since).toISOString().slice(0, 10)}` : query;
  return `https://x.com/search?${new URLSearchParams({ q: effective, src: 'typed_query', f: 'live' })}`;
}
export function classifySearchFailure(url: string, text: string, status?: number): string | null {
  if (status === 429 || /rate limit|too many requests|exceeded.*limit/i.test(text)) return 'rate_limited';
  if (status === 401 || /\/i\/flow\/login|\/login(?:\?|$)/.test(url) || /sign in to x|log in to x/i.test(text)) return 'login_failure';
  if (status === 403 || /verify you are human|unusual activity|\baccount\b[^\r\n.!?]{0,80}\blocked\b|authenticate your account/i.test(text)) return 'access_challenge';
  if ((status && status >= 500) || /something went wrong|try reloading/i.test(text)) return 'search_error';
  return null;
}

export async function collectSearch(page: Page, spec: SearchSpec, config: CrawlerConfig, store: JsonStore, runId: string, dryRun: boolean): Promise<SearchHealth> {
  const url = searchUrl(spec.query, spec.since);
  const health: SearchHealth = {
    query: spec.query, effectiveQuery: new URL(url).searchParams.get('q')!, profile: spec.profile,
    jobId: config.searchJobId, runId, sourceUrl: url, startedAt: new Date().toISOString(), finishedAt: '',
    status: 'parsing_failure', error: null, collected: 0, newestPostTimestamp: null,
    truncated: false, stopReason: '', attempts: 0, latestSelected: false, failures: [],
  };
  const posts = new Map<string, ContentItem>();
  const availableText = new Map<string, ContentItem>();
  const pendingResponses = new Set<Promise<void>>();
  let networkFailure: SearchFailure | null = null;
  // Observe only status codes from the search the logged-in UI itself requests. No credentials or API replay.
  const responseHandler = (res: Response) => {
    if (!/SearchTimeline/.test(res.url())) return;
    if (res.status() >= 400) {
      networkFailure = detectedFailure('', '', res.status(), 'SearchTimeline')
        ?? new SearchFailure('search_error', `SearchTimeline HTTP ${res.status()}`);
      return;
    }
    // Read only tweet text/entities already delivered to the browser. Never persist raw
    // responses, request headers, cookies, account state, or credentials.
    const pending = (async () => {
      try {
        const json = await res.json();
        let visited = 0;
        const walk = (v: any, depth: number) => {
          if (!v || typeof v !== 'object' || depth > 35 || visited++ > 10000) return;
          if (v.rest_id && v.legacy?.full_text && availableText.size < 500) {
            const decoded = deliveredPost(v);
            if (decoded) availableText.set(v.rest_id, decoded);
          }
          for (const child of Object.values(v)) walk(child, depth + 1);
        };
        walk(json, 0);
      } catch { /* DOM remains authoritative if optional text enrichment is unavailable. */ }
    })();
    pendingResponses.add(pending);
    void pending.finally(() => pendingResponses.delete(pending));
  };
  page.on('response', responseHandler);
  const started = Date.now();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      health.attempts++;
      networkFailure = null;
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(config.behavior.navigationTimeoutMs, spec.timeoutMs) });
        await page.waitForTimeout(3000);
        let stalled = 0;
        for (let scroll = 0; scroll <= spec.maxScrolls; scroll++) {
          const body = await page.evaluate(() => {
            const clone = document.body.cloneNode(true) as HTMLElement;
            // Exclude posts and embedded application state from checkpoint detection.
            clone.querySelectorAll('article, script, style, noscript, template, [hidden], [aria-hidden="true"]').forEach(a => a.remove());
            return clone.textContent || '';
          });
          const failure = networkFailure || detectedFailure(page.url(), body, response?.status(), 'document');
          if (failure) throw failure;
          const selected = await page.locator('[role="tab"][aria-selected="true"]').allTextContents();
          health.latestSelected = selected.some(t => /^Latest$/i.test(t.trim()));
          if (!health.latestSelected) throw new Error('latest_tab_failure');
          const batch = await new XAdapter().extractBase(page, config.siteRules.xCom);
          const valid = batch.posts.filter(p => p.tweetId && p.url && p.timestamp && Number.isFinite(Date.parse(p.timestamp)));
          if (batch.posts.length && valid.length !== batch.posts.length) throw new Error('parsing_failure');
          const previous = posts.size;
          let older = 0;
          for (const post of valid) {
            if (spec.since && Date.parse(post.timestamp!) < Date.parse(spec.since)) { older++; continue; }
            if (posts.size >= spec.maxPosts && !posts.has(post.tweetId!)) break;
            post.timestamp = new Date(post.timestamp!).toISOString();
            if (post.quotedPost?.timestamp && Number.isFinite(Date.parse(post.quotedPost.timestamp))) post.quotedPost.timestamp = new Date(post.quotedPost.timestamp).toISOString();
            const delivered = availableText.get(post.tweetId!);
            if (delivered) {
              post.text = delivered.text;
              post.truncatedText = delivered.truncatedText;
              post.unreadImageContent = post.unreadImageContent || delivered.unreadImageContent;
              post.linkedSourceUrls = [...new Set([...(post.linkedSourceUrls || []), ...(delivered.linkedSourceUrls || [])])];
              if (delivered.quotedPost) post.quotedPost = delivered.quotedPost;
            }
            if (post.quotedPost?.tweetId) {
              const quoted = availableText.get(post.quotedPost.tweetId);
              if (quoted?.text && quoted.text.length > post.quotedPost.text.length) post.quotedPost.text = quoted.text;
            }
            posts.set(post.tweetId!, { ...post, capturedAtIso: new Date().toISOString(), matchingQuery: spec.query, collectionRunId: runId });
          }
          if (posts.size >= spec.maxPosts) { health.stopReason = 'max_posts'; health.truncated = true; break; }
          if (/no results for|no results found/i.test(body) && !batch.posts.length) { health.stopReason = 'no_results'; break; }
          if (valid.length && older === valid.length) { health.stopReason = 'since_boundary'; break; }
          if (Date.now() - started >= spec.timeoutMs) { health.stopReason = 'time_budget'; health.truncated = true; break; }
          if (scroll >= spec.maxScrolls) { health.stopReason = 'scroll_budget'; health.truncated = true; break; }
          stalled = posts.size === previous ? stalled + 1 : 0;
          if (stalled >= 4) {
            if (!posts.size) throw new Error('parsing_failure');
            health.stopReason = 'stalled'; health.truncated = true; break;
          }
          await page.evaluate(() => window.scrollBy(0, Math.max(500, innerHeight * 0.8)));
          await page.waitForTimeout(1800);
        }
        if (!posts.size && health.stopReason !== 'no_results' && health.stopReason !== 'since_boundary') throw new Error('parsing_failure');
        health.status = posts.size ? 'success' : 'zero_results';
        health.error = null;
        break;
      } catch (err) {
        const message = (err as Error).message;
        health.status = err instanceof SearchFailure ? err.status
          : /^(rate_limited|login_failure|access_challenge|search_error|parsing_failure|latest_tab_failure)$/.test(message) ? message : 'navigation_failure';
        health.error = message.slice(0, 500);
        health.failures.push({ attempt: health.attempts, status: health.status, detail: health.error });
        health.stopReason = health.status;
        health.truncated = posts.size > 0;
        if (['login_failure', 'access_challenge', 'rate_limited'].includes(health.status) || attempt === 1 || Date.now() - started >= spec.timeoutMs) break;
        await page.waitForTimeout(5000); // one bounded retry, never retry a challenge or rate limit
      }
    }
  } finally {
    page.off('response', responseHandler);
    await Promise.race([Promise.allSettled([...pendingResponses]), page.waitForTimeout(1000)]);
  }
  health.finishedAt = new Date().toISOString();
  health.collected = posts.size;
  health.newestPostTimestamp = [...posts.values()].map(p => p.timestamp!).sort().at(-1) ?? null;
  const snapshots: CrawlSnapshot[] = [...posts.values()].map(post => ({
    id: crypto.randomUUID(), runId, site: 'x.com', sourceUrl: post.url!, canonicalUrl: post.url!,
    capturedAtIso: post.capturedAtIso!, capturedAtLocal: post.capturedAtIso!,
    content: { posts: [post], comments: [] }, metrics: { postCount: 1 },
    search: { query: spec.query, profile: spec.profile, jobId: config.searchJobId },
  }));
  if (!dryRun) store.upsertMany(snapshots);
  console.log('[search] ' + JSON.stringify(health));
  return health;
}
