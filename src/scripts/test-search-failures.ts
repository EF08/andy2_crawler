import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadConfig } from '../config/loader';
import { collectSearch } from '../search/collect';
import { JsonStore } from '../store/jsonStore';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const config = loadConfig('crawler.config.json');
  const spec = { query: 'fixture', maxPosts: 1, maxScrolls: 0, timeoutMs: 30000 };
  // Local intercepted documents are immediately ready; omit production retry delays.
  page.waitForTimeout = async () => {};
  try {
    let status = 503;
    await page.route('https://x.com/**', route => route.fulfill({
      status, contentType: 'text/html', body: '<main>Something went wrong. Try reloading.</main>',
    }));
    const run = () => collectSearch(page, spec, config, new JsonStore('data/search-test-unused.json'), 'fixture-failure', true);
    const server = await run();
    assert.equal(server.status, 'search_error');
    assert.equal(server.attempts, 2);
    assert.match(server.error!, /document HTTP 503/);
    assert.equal(server.attemptDetails[0].documentStatus, 503);
    assert.equal(server.attemptDetails[0].retryInMs, 5000);
    assert.equal(server.attemptDetails[1].retryInMs, null);
    assert.equal(server.recovered, false);
    status = 200;
    const ui = await run();
    assert.equal(ui.status, 'search_error');
    assert.match(ui.error!, /page signal: something went wrong/i);
    status = 429;
    const rate = await run();
    assert.equal(rate.status, 'rate_limited');
    assert.equal(rate.attempts, 1);
    assert.match(rate.error!, /document HTTP 429/);
    await page.unroute('https://x.com/**');
    let navigation = 0;
    await page.route('https://x.com/**', route => {
      if (route.request().url().includes('/SearchTimeline')) {
        return route.fulfill({ status: navigation === 1 ? 503 : 200, contentType: 'application/json', body: '{}' });
      }
      navigation++;
      return route.fulfill({ contentType: 'text/html', body: '<div role="tab" aria-selected="true">Latest</div><article><a href="/test/status/123456"><time datetime="2026-09-09T00:00:00Z"></time></a><div data-testid="tweetText">fixture post</div></article><script>fetch("/i/api/graphql/fixture/SearchTimeline")</script>' });
    });
    const goto = page.goto.bind(page);
    page.goto = async (...args) => {
      const response = page.waitForResponse(r => r.url().includes('/SearchTimeline'));
      const document = await goto(...args);
      await response;
      return document;
    };
    const recovered = await run();
    assert.equal(recovered.status, 'success');
    assert.equal(recovered.collected, 1);
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.error, null);
    assert.deepEqual(recovered.failures, [{ attempt: 1, status: 'search_error', detail: 'search_error: SearchTimeline HTTP 503' }]);
    assert.equal(recovered.recovered, true);
    assert.deepEqual(recovered.attemptDetails.map(a => a.searchHttpStatuses), [[503], [200]]);
    assert.equal(recovered.attemptDetails[1].phase, 'complete');
    assert.equal(recovered.attemptDetails[1].valid, 1);
    assert.equal(recovered.attemptDetails[1].latestSelected, true);
    assert.deepEqual(recovered.attemptDetails[1].requestFailures, []);
    assert.ok(recovered.durationMs >= recovered.attemptDetails.reduce((n, a) => n + a.durationMs, 0));
    page.goto = goto;
    await page.unroute('https://x.com/**');
    await page.route('https://x.com/**', route => route.abort('connectionreset'));
    const disconnected = await run();
    assert.equal(disconnected.status, 'navigation_failure');
    assert.equal(disconnected.attemptDetails[0].phase, 'navigation');
    assert.ok(disconnected.attemptDetails[0].requestFailures.includes('document: net::ERR_CONNECTION_RESET'));
    assert.equal(disconnected.error, 'net::ERR_CONNECTION_RESET');
    page.goto = async () => { throw new Error('browser details https://example.com/?secret=DO_NOT_LOG'); };
    const redacted = await run();
    assert.equal(redacted.error, 'browser failure during navigation');
    assert.ok(!JSON.stringify(redacted).includes('DO_NOT_LOG'));
    console.log('Search failure evidence assertions passed.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
