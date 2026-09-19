# Targeted X Latest searches

`hynix-watch` is included in hourly main gathers alongside the existing timelines and public news. Each of its six queries has its own 30-post budget. Timeline character budgets cannot consume search capacity. No new browser, login, daemon, paid service, or scheduler is required.

The backend implementation is in `C:/Users/andyf/a1a2-command-center/apps/crawler/{search.js,searchMcp.js}`. The remote MCP remains `https://a1a2-command-center.onrender.com/api/crawler/mcp`, with its existing OAuth authentication. Refresh tool discovery in clients that cache the tool list. The full generated JSON schemas are in [crawler-search-tool-schemas.json](crawler-search-tool-schemas.json).

## Tools

All arguments are JSON objects. `?` means optional. `profile` defaults to `hynix-watch`, the only saved profile currently defined.

| Tool | Arguments |
|---|---|
| `crawler_search_live` | `{query: string, requestId: string, maxPosts?: integer, since?: ISO timestamp}` |
| `crawler_search_profile_run` | `{profile?: "hynix-watch", requestId: string, maxPosts?: integer, since?: ISO timestamp}` |
| `crawler_search_job_results` | `{jobId: string, cursor?: string, limit?: integer, maxChars?: integer}` |
| `crawler_search_profile_get` | `{profile?: "hynix-watch"}` |
| `crawler_search_profile_configure` | `{profile?: "hynix-watch", maxPosts?: integer, maxScrolls?: integer, timeoutMs?: integer, enabled?: boolean}` |
| `crawler_search_profile_posts` | `{profile?: "hynix-watch", consumer: string, cursor?: string, limit?: integer, maxChars?: integer}` |
| `crawler_search_profile_ack` | `{profile?: "hynix-watch", consumer: string, receipt: UUID}` |
| `crawler_search_health` | `{profile?: "hynix-watch"}` |
| `crawler_search` | Existing stored-feed search: `{query: string, site?: string, days?: number, limit?: number}`. It does not collect fresh posts. |

Constraints:

- `query`: 1..512 printable characters. X Boolean expressions, cashtags, quotes, and Korean text are preserved.
- `requestId`: required for live/profile collections; 1..128 letters, digits, `_ . : / -`. Reusing it returns the same job, including after completion. Different effective search arguments with the same ID produce an explicit conflict. Use a new ID for the next collection.
- `maxPosts`: 1..100; default 30 per query. A profile-run override applies once; profile configuration persists for subsequent scheduled jobs.
- `maxScrolls`: 1..100, default 40. `timeoutMs`: 5,000..300,000, default 120,000 per query, plus bounded navigation/cleanup overhead.
- `since`: publication-time cutoff, inclusive, ISO timestamp with `Z` or an explicit offset. The web `since:YYYY-MM-DD` operator is supplemented with exact UTC timestamp filtering after extraction. It is separate from the review capture cursor.
- `limit`: new retrieval tools accept 1..25, default 10. Always pass a limit of at most 25 to existing crawler tools as well.
- `maxChars`: 1,000..100,000, default 30,000 post-plus-quote characters per page. A single complete post can exceed the soft budget and sets `charBudgetExceeded`; text is never silently shortened to fit a page.
- Job IDs and page cursors are 24-character hexadecimal strings. Treat cursors as opaque.
- `consumer`: 1..80 letters, digits, `_ . -`. Give each independent reviewer a stable name, such as `hynix-watcher`.

## Monitoring sequence

1. Check `crawler_search_health({profile:"hynix-watch"})`. Last collection success and newest publication timestamps are separate evidence. The current `stale` flag concerns collection success older than 90 minutes, not the age of an individual post.
2. If a new collection is needed, call `crawler_search_profile_run({profile:"hynix-watch",requestId:"hynix-review-2026-09-09T04:00Z"})`. For a one-off hypothesis, use `crawler_search_live({query:"HBM qualification",maxPosts:30,requestId:"hbm-qualification-2026-09-09T04:00Z"})`.
3. Save the returned `jobId`. Poll `crawler_search_job_results({jobId,limit:10,maxChars:30000})` at a reasonable interval. Queued searches wait behind the running job. Check `complete` and per-query health, including `error`, `truncated`, and `stopReason`. Partial results may grow; begin paging from the start once the job is complete.
4. Start each review with `crawler_search_profile_posts({profile:"hynix-watch",consumer:"hynix-watcher",limit:10,maxChars:30000})`, omitting `cursor`. This returns pending new or meaningfully updated posts and a receipt. It does not acknowledge them.
5. After successfully reviewing that page, call `crawler_search_profile_ack({profile:"hynix-watch",consumer:"hynix-watcher",receipt})`. Follow `nextCursor` while `hasMore` is true. If review fails, leave the receipt unacknowledged; those versions will be available again.
6. On the next monitoring cycle, omit `cursor` again. A capture cursor is a pagination boundary within one review, not an unconditional timestamp watermark. Version acknowledgements prevent late uploads or edits from being lost.

Receipts expire after seven days. A mismatched or expired receipt fails explicitly. An old receipt cannot acknowledge a newer edit. Acknowledgements are independent for every profile/consumer and never touch `scanned_content` or the alpha scanner's global flags.

## Storage and health

Each search capture is an individual snapshot with the tweet's direct `/status/` URL, stable tweet ID, author, available text, linked source URLs, publication UTC timestamp, capture UTC timestamp, matching query, collection run ID, and optional quoted-post context. `truncatedText` and `unreadImageContent` are explicit. The collector reads longer text, expanded links and quotes already delivered by the authenticated browser when available. It does not fetch images for OCR or export cookies, headers, credentials, or raw account responses.

The existing JSON snapshot store and MongoDB snapshots retain run/query provenance and historical captures. `search_posts` maintains one current post per profile/tweet ID, with a new capture cursor on meaningful content, link, quote or flag changes. Repeated unchanged captures keep their cursor and can add another matching query. Older replayed snapshots cannot overwrite newer captured content. The existing stored feed and alpha scanner can still read search captures.

Per-query health is persisted independently of post count, including an explicit `zero_results`. Failures include `login_failure`, `rate_limited`, `access_challenge`, `parsing_failure`, `latest_tab_failure`, `navigation_failure`, `search_error`, `sync_failure`, and `collection_failure`. Job timeouts and workers that exit without a report are failures. No search-failure emails are sent.

Search navigation retries at most once after a five-second backoff. Login failures, challenges, and rate limits are not retried within that query. The agent preserves serial browser execution, with a unique running-job index on the shared queue, a 60-minute worker timeout and a longer 65-minute backend stale-job threshold. Completion reporting retries three times with bounded backoff. Poll failures back off up to four minutes.

## Existing URL path

Before the changes, `crawler_run_now` with an `x.com/search?...&f=live` target collected five Hynix posts on 2026-09-09 at about 03:31 UTC. However, it also crawled a configured list, omitted tweet IDs/permalinks, and used ordinary feed text limits. Search URLs now route to the bounded Latest collector. Explicit target overrides also replace configured lists/overflow/search profiles and disable incidental feed pulls, so the requested targets are the only work performed.

## Validation

- `npm run build`
- `npx tsx src/scripts/test-search-failures.ts`: document HTTP failures, page error signals, rate-limit retry suppression, and SearchTimeline HTTP failure followed by successful recovery. Reports retain each failed attempt in `failures`, including when the retry succeeds. Error details contain only detector phrases and HTTP codes, not raw page or response content.
- `npx tsx src/scripts/test-search.ts`: long text, primary versus quoted IDs, native quoted-post context, direct URLs, source links, UTC cutoff, exact post cap, zero results, login failure, rate limiting, parsing failure, bounded retry.
- Backend: `node --env-file=.env scripts/test-crawler-search.js`: isolated DB tests for idempotency, concurrent queue claims, pagination, response budgets, edits after an old receipt, independent consumers, missing reports/timeouts, and real MCP SDK schemas.
- The broad `npm run smoke` currently fails on its existing Reddit fixture (`Reddit adapter should capture comments`). The same failure was reproduced using the pre-change X adapter and smoke test. Reddit and Bloomberg extraction code was not changed. This is not a passing regression check.
- Live acceptance: [hynix-watch-acceptance.md](hynix-watch-acceptance.md). The live backend health endpoint and the existing authenticated remote MCP status tool were verified. New tool handlers were exercised through the local MCP SDK against the live DB and PC queue because local HTTP test credentials were rejected; the user's existing OAuth connector was not modified.
