// Opens the Zulip Mac app with a private debugging port and loads Zulip Stash
// (core.js) into every Zulip page it shows, including after a reload. It stays
// running while Zulip does and exits when you quit Zulip.
//
// It only talks to the Zulip app on this Mac, through a port that is open on
// 127.0.0.1 for as long as Zulip was started this way. Nothing here contacts
// Zulip's servers or anyone else. The saved list is kept in the page's own
// localStorage, inside Zulip's app data on this Mac.
//
// Normal use is through the "Zulip Stash" app that install.sh builds. To run it
// by hand: node zulip-stash-launcher.mjs
//
// Only some servers:   node zulip-stash-launcher.mjs --only recurse.zulipchat.com
// Under another name (own state folder and notifications; the saved list, which
// lives in Zulip's page, is still shared):  --name "My Zulip"
// Run your own code whenever something is saved:  --hook /path/to/hook.js
//   The file is plain page JavaScript that defines
//     window.zulipStashOnSave = async (item) => { ... }
//   It runs before the item is added to the list. Throw an error with a
//   userMessage to refuse the save and show that message on the button.
// Testing on a separate copy of the app (so your own Zulip isn't touched):
//   node zulip-stash-launcher.mjs --user-data-dir /some/empty/folder

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZULIP_APP = process.env.ZULIP_APP || '/Applications/Zulip.app';
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const NAME = argValue('--name') || 'Zulip Stash';
const STATE_DIR = join(homedir(), 'Library', 'Application Support', NAME);
const STATE_FILE = join(STATE_DIR, 'helper.json');
const TEST_PROFILE = argValue('--user-data-dir');
const HOOK = argValue('--hook');
const ONLY = (argValue('--only') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tell(text) {
  log(text);
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(NAME)}`]);
  } catch (error) {
    /* A missing notification is not worth stopping for. */
  }
}

/* The script that runs inside each Zulip page: your hook (if any), then core.js,
   which sits next to this file. It does nothing on the app's own screens (they are
   local files, not web pages) or on servers you left out with --only. */
function pageSource() {
  const hook = HOOK ? readFileSync(HOOK, 'utf8') : '';
  const core = readFileSync(new URL('./core.js', import.meta.url), 'utf8');
  return `(() => {
  if (!/^https?:$/.test(location.protocol)) return;
  const only = ${JSON.stringify(ONLY)};
  if (only.length && !only.includes(location.hostname.toLowerCase())) return;
  ${hook}
  ${core}
})();`;
}

async function answers(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch (error) {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function zulipRunning() {
  try {
    execFileSync('pgrep', ['-f', `${ZULIP_APP}/Contents/MacOS/Zulip( |$)`]);
    return true;
  } catch (error) {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function quitZulip() {
  if (!zulipRunning()) return true;
  log('Zulip is open without Stash; asking it to quit');
  try {
    execFileSync('osascript', ['-e', 'tell application "Zulip" to quit']);
  } catch (error) {
    /* Checked below. */
  }
  for (let i = 0; i < 40; i += 1) {
    if (!zulipRunning()) return true;
    /* If the polite request isn't taking (for example macOS never got to ask you
       to allow this), ask the app to stop the way Quit would. */
    if (i === 16) {
      try {
        execFileSync('pkill', ['-TERM', '-f', `${ZULIP_APP}/Contents/MacOS/Zulip( |$)`]);
      } catch (error) {
        /* Already gone. */
      }
    }
    await sleep(500);
  }
  return false;
}

function openZulip(port) {
  if (TEST_PROFILE) {
    const child = spawn(`${ZULIP_APP}/Contents/MacOS/Zulip`,
      [`--user-data-dir=${TEST_PROFILE}`, `--remote-debugging-port=${port}`],
      { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  execFileSync('open', ['-a', ZULIP_APP, '--args', `--remote-debugging-port=${port}`]);
}

async function inject(wsUrl) {
  const source = pageSource();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not connect to Zulip'));
  });

  let nextId = 0;
  const send = (method, params = {}, sessionId) => {
    ws.send(JSON.stringify({ id: ++nextId, method, params, sessionId }));
  };
  const injected = new Set();
  const asked = new Set();
  const wanted = (info) => ['page', 'webview'].includes(info.type);

  /* A page that loads while the script is registered gets it at the start of every
     document, so it survives reloads. We don't pause new pages (waiting for them
     froze Zulip when it reloaded), so the script also runs once straight away. */
  const handle = (sessionId, info) => {
    if (!wanted(info) || injected.has(info.targetId)) return;
    injected.add(info.targetId);
    send('Page.enable', {}, sessionId);
    send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
    send('Runtime.evaluate', { expression: source }, sessionId);
    let where = '(blank)';
    try { where = new URL(info.url).origin; } catch (error) { /* blank page */ }
    log('loaded into', info.type, where);
  };

  /* Auto-attach doesn't always catch a page that opens while the app is starting,
     so attach to any page or webview we hear about, once each. */
  const attach = (info) => {
    if (!wanted(info) || asked.has(info.targetId)) return;
    asked.add(info.targetId);
    send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Target.attachedToTarget') {
      handle(msg.params.sessionId, msg.params.targetInfo);
    } else if (msg.method === 'Target.targetCreated') {
      attach(msg.params.targetInfo);
    } else if (msg.result && msg.result.targetInfos) {
      msg.result.targetInfos.forEach(attach);
    }
  };

  send('Target.setDiscoverTargets', { discover: true });
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  send('Target.getTargets');

  await new Promise((resolve) => { ws.onclose = resolve; });
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });

  /* Already running from an earlier launch? Then just bring Zulip forward. */
  try {
    const old = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!TEST_PROFILE && pidAlive(old.pid) && (await answers(old.port))) {
      log('already running; bringing Zulip forward');
      execFileSync('open', ['-a', ZULIP_APP]);
      return;
    }
  } catch (error) {
    /* No earlier launch. */
  }

  if (!TEST_PROFILE && !(await quitZulip())) {
    tell(`Zulip didn't quit. Quit it yourself, then open ${NAME} again.`);
    return;
  }

  const port = await freePort();
  if (!TEST_PROFILE) {
    writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port }));
  }
  log('opening Zulip with debug port', port);
  openZulip(port);

  let version = null;
  for (let i = 0; i < 60 && !version; i += 1) {
    version = await answers(port);
    if (!version) await sleep(500);
  }
  if (!version) {
    tell("Zulip opened, but Stash couldn't be loaded. Is Zulip's app a new version?");
    return;
  }

  try {
    await inject(version.webSocketDebuggerUrl);
  } finally {
    log('Zulip closed; done');
  }
}

main().catch((error) => {
  tell(NAME + ' stopped: ' + error.message);
  process.exitCode = 1;
});
