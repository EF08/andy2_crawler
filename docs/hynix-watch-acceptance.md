# Hynix profile acceptance, 2026-09-09 UTC

Job `6aa0d6d10764a18cba00592a`. Collection run `1788925668021-afc00283-1`.

The profile returned 180 query matches, deduplicated to 164 distinct tweet IDs. All six queries selected Latest and completed on their first attempt. Each hit the configured 30-post cap and reported `truncated:true`, `stopReason:max_posts`.

| Actual query | Collection completed (UTC) | Newest post (UTC) | Count |
|---|---|---|---:|
| `($SKHY OR "SK Hynix" OR 하이닉스)` | 2026-09-09T03:48:16.984Z | 2026-09-09T03:44:49.000Z | 30 |
| `($NVDA OR NVIDIA) (HBM OR orders OR supply OR delay)` | 2026-09-09T03:48:43.076Z | 2026-09-09T03:47:34.000Z | 30 |
| `($MU OR Micron OR Samsung) (HBM OR capacity OR pricing)` | 2026-09-09T03:49:12.729Z | 2026-09-09T03:47:34.000Z | 30 |
| `(Microsoft OR Amazon OR Google OR Meta OR CoreWeave) (capex OR cancellation OR "push out" OR delay)` | 2026-09-09T03:49:44.413Z | 2026-09-09T03:48:33.000Z | 30 |
| `(TSMC OR CoWoS) (capacity OR orders OR delay)` | 2026-09-09T03:50:06.823Z | 2026-09-09T03:48:03.000Z | 30 |
| `(HBM OR DRAM) (pricing OR inventory OR qualification)` | 2026-09-09T03:50:34.659Z | 2026-09-09T03:49:44.000Z | 30 |

The supplied queries worked without splitting. This validates acceptance and useful results from X's live web interface, not completeness of X's index. Search can also match quoted or linked context, author handles, or translated text. Some broad company terms produce unrelated results, such as retail order-cancellation discussions. The first Hynix query remains broad.

X documents [Latest as reverse chronological search](https://help.x.com/en/resources/recommender-systems/search-recommendations) and [phrase, word, and date filters](https://help.x.com/en/using-x/x-advanced-search). Operator grouping was checked against the actual six web searches; no paid API was used.

Three observed direct tweet links:

- [@Fun_Paleo / 2097531645025038584](https://x.com/Fun_Paleo/status/2097531645025038584), published 2026-09-09T03:44:49.000Z, captured 2026-09-09T03:47:56.732Z.
- [@PForever0000 / 2097531180660982163](https://x.com/PForever0000/status/2097531180660982163), published 2026-09-09T03:42:58.000Z, captured 2026-09-09T03:47:56.732Z.
- [@PForever0000 / 2097530681169723413](https://x.com/PForever0000/status/2097530681169723413), published 2026-09-09T03:40:59.000Z, captured 2026-09-09T03:47:58.586Z.

All 164 profile records passed identity, direct-link, UTC timestamp, query membership, run provenance and flag checks. The first capture included 24 posts with quoted context, 53 flagged for unread media, and one flagged for truncated text. The longest available text was 24,772 characters.

Using consumer `hynix-acceptance-20260909`, seven receipt pages were acknowledged after validation. The next retrieval returned `count:0`, `posts:[]`, `receipt:null`, `hasMore:false`. All acknowledgement responses reported `alphaScannerModified:false`. The production `hynix-watcher` consumer remains independent.

The independent live no-match job `6aa0d75dceb016f302395496` searched `("andy2crawleracceptancenomatch9b6f733cb609") since:2026-09-09` and returned `zero_results` at 2026-09-09T03:51:22.028Z, with zero posts, no error, and no truncation.

Controlled browser fixtures separately produced `login_failure`, `rate_limited` (one attempt), and `parsing_failure` (at most two attempts). The actual MCP SDK rejected an out-of-range post budget. Database integration tests verified stale-job and missing-report failures. No login was deliberately invalidated, no rate limit was induced on X, and no test email was sent.

The existing hourly schedule subsequently queued the same six queries alongside normal feeds and timelines, confirming scheduled integration. Full raw acceptance output is retained locally in the gitignored `data/hynix-acceptance.json`.
