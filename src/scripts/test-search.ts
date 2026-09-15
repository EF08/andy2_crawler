import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { XAdapter } from '../sites/x.adapter';
import { loadConfig } from '../config/loader';
import { classifySearchFailure, collectSearch, searchUrl } from '../search/collect';
import { JsonStore } from '../store/jsonStore';
import { deliveredPost } from '../search/deliveredPost';

async function main() {
  const config = loadConfig('crawler.config.json');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const long = 'available text '.repeat(150);
    await page.setContent(`<article data-testid="tweet"><div data-testid="User-Name">Name @owner</div><a href="/owner/status/123456"><time datetime="2026-09-09T00:00:00Z"></time></a><div data-testid="tweetText">${long}</div><a href="https://t.co/link" title="https://example.com/source">source</a><div data-testid="tweetPhoto"></div><div role="link"><a href="/quoted/status/789012"><time datetime="2026-09-08T00:00:00Z"></time></a><div data-testid="tweetText">Quoted context</div></div><a data-testid="tweet-text-show-more-link">Show more</a></article>`);
    const r = await new XAdapter().extractBase(page, config.siteRules.xCom);
    assert.equal(r.posts[0].tweetId, '123456');
    assert.equal(r.posts[0].url, 'https://x.com/owner/status/123456');
    assert.equal(r.posts[0].text, long.trim());
    assert.equal(r.posts[0].quotedPost?.tweetId, '789012');
    assert.equal(r.posts[0].quotedPost?.text, 'Quoted context');
    assert.equal(r.posts[0].truncatedText, true);
    assert.equal(r.posts[0].unreadImageContent, true);
    assert.deepEqual(r.posts[0].linkedSourceUrls, ['https://example.com/source']);
    const native = deliveredPost({ rest_id: '123', legacy: { full_text: 'https://t.co/quote', created_at: '2026-09-09T00:00:00Z' }, quoted_status_result: { result: { rest_id: '456', core: { user_results: { result: { core: { screen_name: 'quote_author' } } } }, legacy: { full_text: 'Preview', created_at: '2026-09-08T00:00:00Z' }, note_tweet: { note_tweet_results: { result: { text: long } } } } } });
    assert.equal(native?.text, 'https://t.co/quote');
    assert.equal(native?.quotedPost?.text, long);
    assert.equal(native?.quotedPost?.url, 'https://x.com/quote_author/status/456');
    assert.equal(new URL(searchUrl('($SKHY OR "SK Hynix" OR 하이닉스)')).searchParams.get('f'), 'live');
    assert.equal(new URL(searchUrl('HBM', '2026-09-08T15:00:00Z')).searchParams.get('q'), '(HBM) since:2026-09-08');
    assert.equal(classifySearchFailure('https://x.com/i/flow/login', ''), 'login_failure');
    assert.equal(classifySearchFailure('', '', 429), 'rate_limited');
    assert.equal(classifySearchFailure('', 'Verify you are human'), 'access_challenge');
    assert.equal(classifySearchFailure('', 'Your account has been locked.'), 'access_challenge');
    assert.equal(classifySearchFailure('', '', 403), 'access_challenge');
    assert.equal(classifySearchFailure('', 'Accounting Debate: locked forecasts'), null);
    assert.equal(classifySearchFailure('', 'No results for HBM'), null);
    // Exercise collector via intercepted pages, never login or network requests.
    await page.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: '<div role="tab" aria-selected="true">Latest</div><div>No results for impossible-query</div>' }));
    const store = new JsonStore('data/search-test-unused.json');
    const spec = { query: 'impossible-query', maxPosts: 30, maxScrolls: 1, timeoutMs: 5000 };
    const zero = await collectSearch(page, spec, config, store, 'fixture-zero', true);
    assert.equal(zero.status, 'zero_results');
    await page.unroute('https://x.com/**');
    await page.route('https://x.com/**', route => route.fulfill({ status: 429, contentType: 'text/html', body: 'Rate limit exceeded' }));
    const rate = await collectSearch(page, spec, config, store, 'fixture-rate', true);
    assert.equal(rate.status, 'rate_limited');
    assert.equal(rate.attempts, 1);
    await page.unroute('https://x.com/**');
    await page.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: 'Log in to X' }));
    const login = await collectSearch(page, spec, config, store, 'fixture-login', true);
    assert.equal(login.status, 'login_failure');
    assert.equal(login.attempts, 1);
    await page.unroute('https://x.com/**');
    await page.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: '<div role="tab" aria-selected="true">Latest</div><aside>Accounting Debate</aside><script type="application/json">{"account":{"locked":false},"message":"Verify you are human"}</script>' + Array.from({length: 5}, (_, i) => `<article><a href="/test/status/${1000+i}"><time datetime="2026-09-09T00:00:00Z"></time></a><div data-testid="tweetText">HBM ${i}</div></article>`).join('') }));
    const budget = await collectSearch(page, { ...spec, maxPosts: 3 }, config, store, 'fixture-budget', true);
    assert.equal(budget.status, 'success');
    assert.equal(budget.collected, 3);
    assert.equal(budget.truncated, true);
    assert.equal(budget.stopReason, 'max_posts');
    await page.unroute('https://x.com/**');
    await page.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: '<div role="tab" aria-selected="true">Latest</div><article>broken tweet layout</article>' }));
    const broken = await collectSearch(page, spec, config, store, 'fixture-parse', true);
    assert.equal(broken.status, 'parsing_failure');
    console.log('Search extraction, explicit failures and zero-results assertions passed.');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
