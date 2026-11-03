// Light check against Zulip's real public test server (chat.zulip.org), to make sure
// core.js still finds links and messages on a real Zulip page. Keep it small: that server
// rate-limits. Messages there change, so this only checks things that must always hold.
//   node tests/smoke-real.mjs
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_FROM ? join(process.env.PLAYWRIGHT_FROM, '/') : import.meta.url);
const { chromium } = require('playwright');
const here = resolve(new URL('..', import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), 'zulip-stash-real-'));

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
await context.addInitScript({ path: join(here, 'core.js') });
const root = "document.querySelector('zulip-stash').shadowRoot";
try {
  const page = await context.newPage();
  await page.goto('https://chat.zulip.org/#narrow/channel/101-design', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.message_row', { timeout: 60000 });
  await page.waitForSelector('zulip-stash-plus', { timeout: 20000 });
  await page.waitForTimeout(2500); // let Zulip finish drawing the list
  const n = await page.locator('zulip-stash-plus').count();
  check('buttons appear on real messages', n > 3, `${n}`);

  const info = await page.evaluate(() => {
    const host = document.querySelector('zulip-stash-plus');
    const link = host.previousElementSibling;
    const row = link.closest('.message_row');
    host.shadowRoot.querySelector('button').click();
    return { messageId: row.dataset.messageId, text: link.textContent.slice(0, 40) };
  });
  await page.waitForFunction(() => document.querySelector('zulip-stash').shadowRoot.querySelector('.pill').textContent.trim() === 'Stash 1', null, { timeout: 8000 });
  check('clicking + saves a real link', true, JSON.stringify(info.text));

  await page.evaluate(`${root}.querySelector('.pill').click()`);
  await page.waitForTimeout(250);
  const meta = await page.evaluate(`${root}.querySelector('.item .meta').textContent`);
  check('it recorded channel, topic and sender', /^design · .+ · from .+/.test(meta), meta);
  const href = await page.evaluate(`${root}.querySelector('.item .act').href`);
  check('and a link back to the message', href.includes('#narrow/channel/101-design') && href.includes(`/near/${info.messageId}`), href);
  const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(`${root}.querySelector('.export').click()`)]);
  await download.saveAs(join(work, 'out.csv'));
  const csv = readFileSync(join(work, 'out.csv'), 'utf8');
  check('CSV export has the link', (csv.match(/\r\n"20\d\d-/g) || []).length === 1);
} catch (error) {
  check('run finished without an error', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
