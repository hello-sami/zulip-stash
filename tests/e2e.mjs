// End-to-end test: core.js loaded into a headless Chromium page, the way the launcher
// loads it into the Zulip app, against a fixed fake Zulip page (tests/fixture.html) so
// every run sees the same messages.
//   npm test
// Playwright comes from npm install (or from the folder named in PLAYWRIGHT_FROM). The
// real-server version is tests/smoke-real.mjs.
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_FROM ? join(process.env.PLAYWRIGHT_FROM, '/') : import.meta.url);
const { chromium } = require('playwright');

const here = resolve(new URL('..', import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), 'zulip-stash-'));
const fixture = readFileSync(join(here, 'tests/fixture.html'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, acceptDownloads: true });
await context.addInitScript({ path: join(here, 'core.js') });
await context.route('https://zulip.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));

const root = "document.querySelector('zulip-stash').shadowRoot";
const q = (page, sel) => page.evaluate(`${root}.querySelector(${JSON.stringify(sel)}).textContent`);
const qa = (page, sel) => page.evaluate(`Array.from(${root}.querySelectorAll(${JSON.stringify(sel)})).map((n) => n.textContent)`);
const click = (page, sel) => page.evaluate(`${root}.querySelector(${JSON.stringify(sel)}).click()`);
const pill = async (page) => (await q(page, '.pill')).trim();
const plusStates = (page) => page.evaluate(() => Array.from(document.querySelectorAll('zulip-stash-plus')).map((h) => h.shadowRoot.querySelector('button').dataset.state));
const plusClick = (page, i) => page.evaluate((n) => document.querySelectorAll('zulip-stash-plus')[n].shadowRoot.querySelector('button').click(), i);
const plusFor = (page, test) => page.evaluate((src) => Array.from(document.querySelectorAll('zulip-stash-plus')).findIndex(new Function('h', 'return ' + src)), test);
const waitPill = (page, n) => page.waitForFunction((v) => document.querySelector('zulip-stash').shadowRoot.querySelector('.pill').textContent.trim() === 'Stash ' + v, n, { timeout: 8000 });
const saveLink = async (page, urlPart, total) => {
  await plusClick(page, await plusFor(page, `h.dataset.url.includes(${JSON.stringify(urlPart)})`));
  await waitPill(page, total);
};

try {
  const page = await context.newPage();
  await page.goto('https://zulip.test/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('zulip-stash-plus');

  let states = await plusStates(page);
  check('buttons only on outside web links', states.length === 5, `${states.length} at first (want 5: github, example x2, evil, private)`);
  const skipped = await page.evaluate(() => ['/user_uploads/x.png', 'mailto:a@b.c', 'https://skipme.example/'].map((h) => document.querySelector(`a[href="${h}"]`).nextElementSibling?.localName === 'zulip-stash-plus'));
  check('uploads, mail and preview cards get none', skipped.every((x) => !x), skipped.join());
  await page.waitForFunction(() => document.querySelectorAll('zulip-stash-plus').length === 6, null, { timeout: 5000 });
  check('a message that arrives later gets a button', true);
  check('starts empty', (await pill(page)) === 'Stash 0');

  const exampleIdx = await plusFor(page, "h.dataset.url === 'https://example.com/a'");
  await plusClick(page, exampleIdx);
  await waitPill(page, 1);
  const both = await page.evaluate(() => Array.from(document.querySelectorAll('zulip-stash-plus')).filter((h) => h.dataset.url === 'https://example.com/a').map((h) => h.shadowRoot.querySelector('button').dataset.state));
  check('clicking + saves, and the same address shows saved in both places', both.length === 2 && both.every((s) => s === 'saved'), both.join());
  await plusClick(page, exampleIdx);
  await page.waitForTimeout(200);
  check('clicking a saved link again does not add it twice', (await pill(page)) === 'Stash 1');
  await saveLink(page, 'github.com', 2);
  await saveLink(page, 'evil.example', 3);
  await saveLink(page, 'private.example', 4);
  await saveLink(page, 'late.example', 5);

  await click(page, '.pill');
  await page.waitForTimeout(200);
  check('window lists every link', (await qa(page, '.item')).length === 5);
  const metas = await qa(page, '.item .meta');
  check('links keep channel, topic and sender', metas.some((m) => m.startsWith('design · error page illustrations · from Ada Lovelace')), metas.join(' | '));
  check('names and direct messages are right', metas.some((m) => m.startsWith('Direct messages · from Ada Lovelace')) && metas.some((m) => m.includes('from Grace Hopper')) && metas.some((m) => m.includes('from Late Arrival')));
  const actions = await page.evaluate(`Array.from(${root}.querySelector('.item .actions').children).map((n) => n.textContent)`);
  check('each link offers Go to message and Remove, nothing else', actions.join() === 'Go to message,Remove', actions.join());
  const rightSide = await page.evaluate(`(() => {
    const item = ${root}.querySelector('.item');
    const a = item.querySelector('.actions').getBoundingClientRect();
    const d = item.querySelector('.details').getBoundingClientRect();
    return a.left >= d.right && Math.abs(item.getBoundingClientRect().right - 14 - a.right) < 2;
  })()`);
  check('the actions sit on the right of each row', rightSide);
  check('no snippet button or kind filter left', await page.evaluate(`!${root}.querySelector('.snip, .chip, .badge')`));
  const channelOpts = await qa(page, 'select option');
  check('channel filter lists channels', channelOpts.join() === 'All channels,Direct messages,design', channelOpts.join());
  await page.screenshot({ path: join(work, 'dashboard-light.png') });

  await page.locator('zulip-stash input[type=search]').click();
  await page.keyboard.type('crjk/');
  const fired = await page.evaluate(() => window.__zulipShortcut || '');
  check('typing in search does not fire Zulip shortcuts', fired === '', JSON.stringify(fired));
  check('search box received the typing', (await page.evaluate(`${root}.querySelector('input').value`)) === 'crjk/');
  check('no match shows a message', (await qa(page, '.empty')).join().includes('Nothing matches'));
  await page.locator('zulip-stash input[type=search]').fill('hopper');
  check('search finds by sender', (await qa(page, '.item')).length === 1);
  await page.locator('zulip-stash input[type=search]').fill('private.example');
  check('search finds by address', (await qa(page, '.item .url')).join() === 'https://private.example/page');
  await page.locator('zulip-stash input[type=search]').fill('');
  await page.locator('zulip-stash select').selectOption('Direct messages');
  check('channel filter filters', (await qa(page, '.item')).length === 1);
  await page.locator('zulip-stash select').selectOption('');

  const [download] = await Promise.all([page.waitForEvent('download'), click(page, '.export')]);
  const csvPath = join(work, 'out.csv');
  await download.saveAs(csvPath);
  const csv = readFileSync(csvPath, 'utf8');
  check('CSV file has a dated name', /^zulip-stash-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
  check('CSV has the header and 5 rows', csv.startsWith('﻿"Saved","Title","Link","Channel","Topic","From","Message link"') && (csv.match(/\r\n"20\d\d-/g) || []).length === 5);
  check('CSV neutralizes a title that starts with =', csv.includes(`"'=HYPERLINK(""https://evil.example"",""click me"")`) && !csv.includes(',"=HYPERLINK'));
  check('CSV rows carry the link back to the message', csv.includes('https://zulip.test/#narrow/channel/1-design/topic/error.20page/near/101'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('zulip-stash-plus');
  await page.waitForFunction(() => document.querySelector('zulip-stash').shadowRoot.querySelector('.pill').textContent.trim() === 'Stash 5');
  await page.waitForFunction(() => document.querySelectorAll('zulip-stash-plus').length === 6);
  states = await plusStates(page);
  check('survives a reload, and saved links come back marked', states.filter((s) => s === 'saved').length === 6, states.join());

  // Lists saved by an older version may hold snippets of text: keep them, don't show them.
  await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('zulipStash.items'));
    list.push({ id: 's:101:old', type: 'snippet', text: 'an old snippet', channel: 'design', savedAt: Date.now() });
    localStorage.setItem('zulipStash.items', JSON.stringify(list));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('zulip-stash-plus');
  await page.waitForTimeout(300);
  check('an old saved snippet is not shown or counted', (await pill(page)) === 'Stash 5', await pill(page));

  const page2 = await context.newPage();
  await page2.goto('https://zulip.test/', { waitUntil: 'domcontentloaded' });
  await page2.waitForFunction(() => document.querySelectorAll('zulip-stash-plus').length === 6 && document.querySelector('zulip-stash').shadowRoot.querySelector('.pill').textContent.trim() === 'Stash 5');
  await page2.evaluate(async () => {
    const host = document.createElement('p');
    host.className = 'message_content';
    host.innerHTML = 'Another: <a href="https://another.example/x">x</a>';
    document.querySelector('[data-message-id="201"]').appendChild(host);
    await new Promise((r) => setTimeout(r, 700));
    document.querySelector('a[href="https://another.example/x"]').nextElementSibling.shadowRoot.querySelector('button').click();
  });
  await waitPill(page, 6).catch(() => {});
  check('a save in another window shows up in this one', (await pill(page)) === 'Stash 6', await pill(page));
  await page2.close();

  await click(page, '.pill');
  await page.evaluate(() => document.body.classList.add('dark-theme'));
  await page.waitForTimeout(300);
  check('follows Zulip dark theme', await page.evaluate(() => document.querySelector('zulip-stash').classList.contains('dark')));
  await page.screenshot({ path: join(work, 'dashboard-dark.png') });
  await page.evaluate(() => document.body.classList.remove('dark-theme'));

  await click(page, '.item .act.danger');
  await page.waitForTimeout(250);
  check('Remove deletes one', (await pill(page)) === 'Stash 5', await pill(page));
  check('and leaves the old snippet alone', await page.evaluate(() => JSON.parse(localStorage.getItem('zulipStash.items')).some((i) => i.type === 'snippet')));
  await click(page, '.clear');
  check('Remove all asks first', (await q(page, '.clear')).includes('Click again'));
  await click(page, '.clear');
  await page.waitForTimeout(250);
  check('Remove all on the second click', (await pill(page)) === 'Stash 0');
  check('buttons go back to +', (await plusStates(page)).every((s) => s === 'add'));
  check('empty window explains what to do', (await qa(page, '.empty')).join().includes('Click the +'));
  await page.keyboard.press('Escape');
  check('Escape closes the window', await page.evaluate(`${root}.querySelector('.overlay').hidden`));

  // The --hook option: a page function that runs before each save and can refuse it.
  const page3 = await context.newPage();
  await page3.addInitScript(() => {
    window.zulipStashOnSave = async () => {
      const error = new Error('refused');
      error.userMessage = 'The hook said no.';
      throw error;
    };
  });
  await page3.goto('https://zulip.test/', { waitUntil: 'domcontentloaded' });
  await page3.waitForSelector('zulip-stash-plus');
  await plusClick(page3, 0);
  await page3.waitForTimeout(300);
  const refused = await page3.evaluate(() => {
    const button = document.querySelector('zulip-stash-plus').shadowRoot.querySelector('button');
    return { state: button.dataset.state, title: button.title };
  });
  check('a hook that refuses stops the save and says why', refused.state === 'error' && refused.title === 'The hook said no.' && (await pill(page3)) === 'Stash 0', JSON.stringify(refused));
  await page3.evaluate(() => {
    window.zulipStashOnSave = async (item) => { window.hookSaw = item.type + ' ' + item.url; };
  });
  await plusClick(page3, 0);
  await waitPill(page3, 1);
  const saw = await page3.evaluate(() => window.hookSaw || '');
  check('a hook that agrees gets the link, and the save goes through', /^link https:\/\//.test(saw), saw);
  await page3.close();
  console.log('screenshots in', work);
} catch (error) {
  check('test run finished without an error', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
