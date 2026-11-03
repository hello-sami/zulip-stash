/*
  Zulip Stash: everything that happens inside the Zulip page.

  It puts a small "+" next to each outside link in the messages, and keeps a
  "Stash" button in the corner that opens a list of every link you saved, with
  search and a CSV export.

  The launcher (zulip-stash-launcher.mjs) loads this file into every Zulip page.
  The saved list is kept in that page's localStorage, which lives inside the
  Zulip app's data on this Mac. Nothing here makes a network request.

  Link titles come from other people's messages, so they are only ever put on
  the page with textContent, never as HTML.

  The file defines one function, zulipStash(), and at the very bottom starts it
  once Zulip's messages are on screen. Its sections, in order:
    1. Settings
    2. Reading Zulip's page   (the only part that knows Zulip's class names)
    3. The saved list
    4. The "+" beside each link
    5. The Stash window
    6. CSV export
    7. Starting up
*/
function zulipStash() {
  'use strict';

  /* Run once per page, even if this file is loaded twice. */
  if (window.__zulipStash) {
    return window.__zulipStash;
  }

  /* ---------- 1. Settings ---------- */

  /* The tag name of each "+" button we add to the page. */
  const PLUS = 'zulip-stash-plus';
  /* Links inside these (image and video previews, link cards) get no "+". */
  const SKIP_INSIDE = '.message_embed, .message_inline_image, .media-anchor-element, .youtube-video, .vimeo-video';

  /* Every saved link, by id. A link's id is "l:" plus its address. */
  const items = new Map();

  /* What the Stash window is showing right now. */
  const view = {
    open: false,
    search: '',
    channel: '', // '' means every channel
    confirmClear: false, // true after the first click on "Remove all"
  };

  /* ---------- 2. Reading Zulip's page ---------- */

  /* Squash runs of spaces and line breaks into one space, and cut to a length. */
  function clean(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  /* Where a link sits: its channel, topic, who wrote it, and a link back to the
     message. Every saved link carries these. */
  function placeOf(link) {
    const row = link.closest('.message_row');
    const group = row && row.closest('.recipient_row');
    const header = group && group.querySelector('.message_header');

    let channel = 'Other';
    let topic = '';
    if (header) {
      const name = header.querySelector('.message-header-stream-name, .stream_label');
      if (name && name.textContent.trim()) {
        channel = clean(name.textContent, 100);
      } else if (/private/.test(header.className)) {
        channel = 'Direct messages';
      }
      const topicLink = header.querySelector('.narrows_by_topic');
      topic = topicLink ? clean(topicLink.textContent, 200) : '';
    }

    /* A person's later messages in a row don't repeat their name, so walk back
       up the group to the nearest message that shows it. */
    let from = '';
    if (group && row) {
      const rows = Array.from(group.querySelectorAll('.message_row'));
      for (let i = rows.indexOf(row); i >= 0 && !from; i -= 1) {
        const sender = rows[i].querySelector('.sender_name');
        if (sender) {
          from = clean(sender.textContent, 100);
        }
      }
    }

    const time = row && row.querySelector('a.message-time');
    return { channel: channel, topic: topic, from: from, messageLink: time ? time.href : '' };
  }

  /* The address to give a "+", or null for none. Links back into Zulip itself
     (uploads, mentions, other messages), non-web links and previews get none. */
  function addressOf(link) {
    if (link.closest(SKIP_INSIDE)) {
      return null;
    }
    let url;
    try {
      url = new URL(link.href);
    } catch (error) {
      return null;
    }
    if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) {
      return null;
    }
    return url.href;
  }

  /* ---------- 3. The saved list ---------- */

  /* The list is stored as JSON text under this name in localStorage. */
  const KEY = 'zulipStash.items';

  function loadList() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    } catch (error) {
      return []; // missing or unreadable: start empty
    }
  }

  function storeList(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  /* Read the whole list again, then redraw. (Older versions could also save
     snippets of text. Any left in the list are kept, just not shown.) */
  function reload() {
    items.clear();
    loadList()
      .filter((item) => item.type === 'link')
      .forEach((item) => items.set(item.id, item));
    repaint();
  }

  /* Save one link. Gives back 'added', or 'have' if it was already saved.
     Each change loads the latest list first, so it can't overwrite something
     another Zulip window saved a moment ago. */
  async function save(item) {
    if (items.has(item.id)) {
      return 'have';
    }
    /* Optional: a page can define window.zulipStashOnSave to also send each link
       somewhere else (the launcher's --hook option does this). It can take its
       time, so we `await` it. If it throws an error, nothing is saved, and the
       error's userMessage is shown on the button. */
    if (typeof window.zulipStashOnSave === 'function') {
      await window.zulipStashOnSave(item);
    }
    const list = loadList();
    if (!list.some((saved) => saved.id === item.id)) {
      list.push(item);
      storeList(list);
    }
    items.set(item.id, item);
    repaint();
    return 'added';
  }

  function remove(id) {
    storeList(loadList().filter((item) => item.id !== id));
    items.delete(id);
    repaint();
  }

  function removeAll() {
    storeList([]);
    items.clear();
    repaint();
  }

  function newestFirst() {
    return Array.from(items.values()).sort((a, b) => b.savedAt - a.savedAt);
  }

  /* ---------- 4. The "+" beside each link ---------- */

  /* Each "+" lives in its own little shadow root, so Zulip's styles can't reach
     it and its styles can't leak into Zulip. */
  const PLUS_CSS = `
    button { all: unset; box-sizing: border-box; cursor: pointer; font: 600 11px/1 system-ui, sans-serif;
      padding: 2px 6px; margin-left: 4px; border: 1px solid currentColor; border-radius: 9px;
      color: inherit; opacity: .6; user-select: none; -webkit-user-select: none; }
    button:hover, button:focus-visible { opacity: 1; }
    button[data-state="saved"] { opacity: 1; cursor: default; }
    button[data-state="error"] { opacity: 1; }
  `;

  /* Show "+" or "✓" depending on whether this address is saved. A button that
     failed keeps its "!" until the link is saved some other way. */
  function paintPlus(host) {
    const button = host.shadowRoot.querySelector('button');
    const saved = items.has('l:' + host.dataset.url);
    if (button.dataset.state === 'error' && !saved) {
      return;
    }
    button.dataset.state = saved ? 'saved' : 'add';
    button.textContent = saved ? '✓' : '+';
    button.title = saved ? 'Saved in your Stash' : 'Save this link to your Stash';
  }

  function makePlus(link, url) {
    const host = document.createElement(PLUS);
    host.dataset.url = url;
    host.style.display = 'inline';
    host.attachShadow({ mode: 'open' }).innerHTML = '<style>' + PLUS_CSS + '</style><button type="button"></button>';
    const button = host.shadowRoot.querySelector('button');
    paintPlus(host);

    button.addEventListener('click', async (event) => {
      /* Don't let Zulip treat this as a click on the message or the link. */
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.state === 'saved' || button.dataset.state === 'busy') {
        return;
      }
      button.dataset.state = 'busy';
      button.textContent = '...';
      try {
        await save({
          id: 'l:' + url,
          type: 'link',
          url: url,
          title: clean(link.textContent, 300) || url,
          ...placeOf(link),
          savedAt: Date.now(),
        });
      } catch (error) {
        button.dataset.state = 'error';
        button.textContent = '!';
        button.title = (error && error.userMessage) || "Couldn't save. Reload the page and try again.";
      }
    });
    return host;
  }

  /* Give every outside link in the messages a "+", skipping ones that have one. */
  function addPlusButtons() {
    document.querySelectorAll('.message_content a[href]').forEach((link) => {
      const next = link.nextElementSibling;
      if (next && next.localName === PLUS) {
        return;
      }
      const url = addressOf(link);
      if (url) {
        link.after(makePlus(link, url));
      }
    });
  }

  /* ---------- 5. The Stash window ---------- */

  /* Our corner of the page is one <zulip-stash> element with a shadow root, so
     Zulip's styles and ours stay apart. It holds the "Stash" button and the
     window itself. */
  const CSS = `
    :host { all: initial; font: 13px/1.4 system-ui, -apple-system, sans-serif; --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7;
      --accent: #1a6b5c; --danger: #b3261e; }
    :host(.dark) { --bg: #1f2125; --fg: #ececf0; --muted: #a0a0aa; --line: #3a3d44;
      --accent: #5fc4ae; --danger: #ff8a80; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, input, select { font: 13px/1.3 system-ui, sans-serif; color: var(--fg); }
    .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; padding: 7px 12px; border-radius: 16px;
      border: 1px solid var(--line); background: var(--bg); cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.2); }
    .pill b { color: var(--accent); }
    .overlay { position: fixed; inset: 0; z-index: 2147483002; background: rgba(0,0,0,.45); display: flex;
      align-items: center; justify-content: center; padding: 16px; }
    .panel { width: min(760px, 100%); max-height: min(86vh, 900px); display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg); border-radius: 12px; border: 1px solid var(--line);
      box-shadow: 0 10px 40px rgba(0,0,0,.4); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .head h2 { margin: 0; font-size: 16px; }
    .count { color: var(--muted); }
    .grow { flex: 1; }
    .x { border: 0; background: none; font-size: 20px; line-height: 1; cursor: pointer; color: var(--muted); }
    .tools { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
    .tools input { flex: 1 1 180px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
    .tools select { padding: 6px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); max-width: 180px; }
    ul { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
    /* Each saved link: its details on the left, its two actions on the right. */
    .item { display: flex; align-items: flex-start; gap: 16px; padding: 11px 14px; border-bottom: 1px solid var(--line); }
    .details { flex: 1; min-width: 0; }
    .title { font-weight: 600; color: var(--fg); text-decoration: none; word-break: break-word; }
    .title:hover { text-decoration: underline; }
    .url { color: var(--muted); font-size: 12px; word-break: break-all; margin-top: 2px; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 5px; }
    .actions { display: flex; gap: 14px; flex-shrink: 0; padding-top: 1px; white-space: nowrap; }
    .act { all: unset; cursor: pointer; color: var(--accent); font-size: 12px; font-weight: 600; }
    .act:hover { text-decoration: underline; }
    .act.danger { color: var(--danger); }
    .empty { padding: 28px 18px; color: var(--muted); text-align: center; }
    .foot { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
    .foot button { padding: 6px 12px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); cursor: pointer; }
    .foot .export { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    :host(.dark) .foot .export { color: #10231f; }
    .foot button:disabled { opacity: .45; cursor: default; }
    .note { color: var(--muted); font-size: 12px; align-self: center; }
  `;

  /* The parts that never change. Saved links are added later, one by one, in
     renderItem(). */
  const HTML = `
    <button type="button" class="pill" title="Open your saved links"></button>
    <div class="overlay" hidden>
      <div class="panel" role="dialog" aria-label="Zulip Stash">
        <div class="head">
          <h2>Stash</h2>
          <span class="count"></span>
          <span class="grow"></span>
          <button type="button" class="x" title="Close">×</button>
        </div>
        <div class="tools">
          <input type="search" placeholder="Search">
          <select></select>
        </div>
        <ul></ul>
        <div class="foot">
          <button type="button" class="export">Export CSV</button>
          <button type="button" class="clear">Remove all</button>
          <span class="note">Saved only on this computer.</span>
        </div>
      </div>
    </div>
  `;

  const host = document.createElement('zulip-stash');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' + CSS + '</style>' + HTML;

  /* The parts we change or listen to. */
  const pill = shadow.querySelector('.pill');
  const overlay = shadow.querySelector('.overlay');
  const closeButton = shadow.querySelector('.x');
  const count = shadow.querySelector('.count');
  const search = shadow.querySelector('input');
  const channelMenu = shadow.querySelector('select');
  const list = shadow.querySelector('ul');
  const exportButton = shadow.querySelector('.export');
  const clearButton = shadow.querySelector('.clear');

  /* A shortcut for making an element with a class and some text. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text != null) {
      node.textContent = text;
    }
    return node;
  }

  /* The saved links that match the search box and the channel menu, newest first. */
  function matching() {
    const words = view.search.toLowerCase().split(/\s+/).filter(Boolean);
    return newestFirst().filter((item) => {
      if (view.channel && item.channel !== view.channel) {
        return false;
      }
      const searchable = [item.title, item.url, item.channel, item.topic, item.from].join(' ').toLowerCase();
      return words.every((word) => searchable.includes(word));
    });
  }

  /* One saved link in the list: title, address and where it came from on the
     left; "Go to message" and "Remove" on the right. */
  function renderItem(item) {
    const details = el('div', 'details');
    const title = el('a', 'title', item.title);
    title.href = item.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    const where = [item.channel, item.topic, item.from && 'from ' + item.from, new Date(item.savedAt).toLocaleDateString()];
    details.append(title, el('div', 'url', item.url), el('div', 'meta', where.filter(Boolean).join(' · ')));

    const actions = el('div', 'actions');
    if (item.messageLink) {
      const goTo = el('a', 'act', 'Go to message');
      goTo.href = item.messageLink;
      actions.append(goTo);
    }
    const removeButton = el('button', 'act danger', 'Remove');
    removeButton.addEventListener('click', () => remove(item.id));
    actions.append(removeButton);

    const row = el('li', 'item');
    row.append(details, actions);
    return row;
  }

  /* Redraw the window's contents from `items` and `view`. */
  function renderWindow() {
    if (!view.open) {
      return;
    }
    const total = items.size;
    const shown = matching();

    /* The channel menu lists every channel that has something saved. */
    const channels = Array.from(new Set(Array.from(items.values(), (item) => item.channel))).sort();
    if (view.channel && !channels.includes(view.channel)) {
      view.channel = '';
    }
    channelMenu.replaceChildren(new Option('All channels', ''), ...channels.map((c) => new Option(c, c)));
    channelMenu.value = view.channel;

    if (total === 0) {
      count.textContent = '';
    } else if (shown.length === total) {
      count.textContent = total + ' saved';
    } else {
      count.textContent = shown.length + ' of ' + total;
    }

    list.replaceChildren();
    if (total === 0) {
      const empty = el('li', 'empty');
      empty.append(el('p', null, 'Nothing saved yet.'), el('p', null, 'Click the + beside a link to save it.'));
      list.append(empty);
    } else if (shown.length === 0) {
      list.append(el('li', 'empty', 'Nothing matches that.'));
    } else {
      shown.forEach((item) => list.append(renderItem(item)));
    }

    exportButton.disabled = total === 0;
    clearButton.disabled = total === 0;
    clearButton.textContent = view.confirmClear ? 'Click again to remove everything' : 'Remove all';
  }

  function openWindow() {
    view.open = true;
    view.confirmClear = false;
    overlay.hidden = false;
    applyTheme();
    renderWindow();
    search.focus();
  }

  function closeWindow() {
    view.open = false;
    overlay.hidden = true;
  }

  /* Bring everything on the page up to date after the list changed. */
  function repaint() {
    document.querySelectorAll(PLUS).forEach(paintPlus);
    pill.replaceChildren('Stash ', el('b', null, String(items.size)));
    renderWindow();
  }

  /* Zulip marks its dark theme with a class on the page; follow it. */
  function applyTheme() {
    const dark = document.documentElement.classList.contains('dark-theme') ||
      (document.body && document.body.classList.contains('dark-theme'));
    host.classList.toggle('dark', Boolean(dark));
  }

  pill.addEventListener('click', openWindow);
  closeButton.addEventListener('click', closeWindow);
  /* A click on the dimmed area around the window closes it. */
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      closeWindow();
    }
  });
  search.addEventListener('input', () => {
    view.search = search.value;
    renderWindow();
  });
  channelMenu.addEventListener('change', () => {
    view.channel = channelMenu.value;
    renderWindow();
  });
  exportButton.addEventListener('click', exportCsv);
  /* "Remove all" asks for a second click before it does anything. */
  clearButton.addEventListener('click', () => {
    if (!view.confirmClear) {
      view.confirmClear = true;
      renderWindow();
      return;
    }
    view.confirmClear = false;
    removeAll();
  });

  /* Keys typed in our window must not reach Zulip, whose shortcuts (r, c, /, j, k)
     would otherwise fire. Escape closes the window. */
  ['keydown', 'keyup', 'keypress'].forEach((type) => {
    shadow.addEventListener(type, (event) => {
      event.stopPropagation();
      if (type === 'keydown' && event.key === 'Escape') {
        closeWindow();
      }
    });
  });

  /* ---------- 6. CSV export ---------- */

  /* One spreadsheet cell, in quotes. A cell starting with = + - or @ would run as
     a formula in a spreadsheet, and link titles are other people's text, so those
     get a leading ' to keep them as plain text. */
  function csvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(text)) {
      text = "'" + text;
    }
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function toCsv(saved) {
    const rows = [['Saved', 'Title', 'Link', 'Channel', 'Topic', 'From', 'Message link']];
    saved.forEach((item) => {
      rows.push([
        new Date(item.savedAt).toISOString(),
        item.title,
        item.url,
        item.channel,
        item.topic,
        item.from,
        item.messageLink,
      ]);
    });
    /* ﻿ at the start tells Excel the file is UTF-8, so accents and emoji
       come out right. Spreadsheets expect \r\n line endings. */
    return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /* Hand the browser a file to download, named for today. */
  function exportCsv() {
    const day = new Date().toISOString().slice(0, 10);
    const file = new Blob([toCsv(newestFirst())], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = el('a');
    link.href = url;
    link.download = 'zulip-stash-' + day + '.csv';
    link.hidden = true;
    /* Keep Zulip from treating this click as a click on its own page. */
    link.addEventListener('click', (event) => event.stopPropagation());
    shadow.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ---------- 7. Starting up ---------- */

  /* Zulip adds messages all the time (new ones arrive, you scroll back, you
     switch channels). Watch for that, and at most every 300 ms give any new
     links their "+". */
  let waiting = false;
  new MutationObserver(() => {
    if (waiting) {
      return;
    }
    waiting = true;
    setTimeout(() => {
      waiting = false;
      addPlusButtons();
      applyTheme();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  /* Zulip switches theme by changing a class on the page, which isn't a change to
     its contents, so watch for that on its own. */
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  /* Another Zulip window changed the list: localStorage tells every other page
     of the same server with a "storage" event. */
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) {
      reload();
    }
  });

  document.documentElement.append(host);
  applyTheme();
  addPlusButtons();
  reload();

  /* A small handle for tests and the browser console. */
  window.__zulipStash = {
    open: openWindow,
    items: () => Array.from(items.values()),
    csv: () => toCsv(newestFirst()),
  };
  return window.__zulipStash;
}

/* Start once Zulip's messages are on screen, so Stash doesn't appear on the
   sign-in page. Check once a second, for up to ten minutes. The flag stops a
   second copy of this file from starting a second check. */
if (!window.__zulipStashWaiting) {
  window.__zulipStashWaiting = true;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (document.querySelector('#message_feed_container, #compose, .message_row')) {
      clearInterval(timer);
      zulipStash();
    } else if (tries >= 600) {
      clearInterval(timer);
    }
  }, 1000);
}
