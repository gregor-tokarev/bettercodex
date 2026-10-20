// Tabs of another machine (an SSH machine) shown as synced copies: real mouse and keyboard input in
// the copy is replayed on that machine, the agent's actions there come back to the copy, a form
// posted from the copy is sent once (by the other machine) and its cookies follow.
//   REMOTE_HOME is that machine's BetterCodex home (its host's secrets, for the agent's tools).
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { click, rootShot, type } from './x11.mjs';

const remoteHome = process.env.REMOTE_HOME ?? '/tmp/bc-remote-userhome/.bettercodex';

function site() {
  const counts = { GET: 0, POST: 0, save: 0, config: 0, like: 0, login: 0 };
  const page = (cookie) => `<!doctype html><title>Sync test</title>
<body style="margin:0;font:18px sans-serif">
<h1 style="margin:16px">${/user=(\w+)/.exec(cookie ?? '')?.[1] ? `Hello ${/user=(\w+)/.exec(cookie)[1]}` : 'Signed out'}</h1>
<button id="inc" style="margin:0 16px;width:140px;height:36px" onclick="document.title = 'count ' + (window.n = (window.n || 0) + 1)">Count</button>
<input id="name" placeholder="name" style="width:220px;height:30px">
<select id="color"><option value="r">Red</option><option value="g">Green</option></select>
<a id="next" href="/page2" style="margin-left:12px">Next page</a>
<button id="save" style="margin-left:12px;height:36px" onclick="fetch('/save', { method: 'POST' })">Save</button>
<p style="margin:16px"><span id="greeting">…</span>
<button id="like" style="margin-left:12px;height:36px" onclick="fetch('/api/like', { method: 'POST' }).then((r) => r.json()).then((j) => (document.querySelector('#likes').textContent = j.likes))">Like</button>
<span id="likes">0</span>
<button id="route" style="margin-left:12px;height:36px" onclick="history.pushState({}, '', '/?route=2')">Route</button></p>
<script>fetch('/api/config', { method: 'POST' }).then((r) => r.json()).then((j) => (document.querySelector('#greeting').textContent = j.greeting));</script>
<form method="post" action="/login" style="margin:16px"><input id="user" name="user" placeholder="user" style="width:160px;height:30px"><button id="login" style="height:36px">Sign in</button></form>
<div style="height:2000px"></div><p id="bottom">bottom</p></body>`;
  const server = http.createServer((req, res) => {
    counts[req.method] = (counts[req.method] ?? 0) + 1;
    if (req.method === 'POST' && req.url === '/save') {
      counts.save++;
      return res.writeHead(204).end();
    }
    if (req.method === 'POST' && req.url === '/api/config') {
      counts.config++;
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ greeting: 'Welcome' }));
    }
    if (req.method === 'POST' && req.url === '/api/like') {
      counts.like++;
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ likes: counts.like }));
    }
    if (req.url === '/stats') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(counts));
    if (req.method === 'POST' && req.url === '/login') {
      counts.login++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const user = new URLSearchParams(body).get('user') ?? '';
        res.writeHead(303, { Location: '/?welcome', 'Set-Cookie': `user=${encodeURIComponent(user)}; Path=/` }).end();
      });
      return;
    }
    if (req.url === '/page2') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Second page</title><h1>Second page</h1>');
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(page(req.headers.cookie));
  });
  return { server, counts };
}

async function mcp(name, args) {
  const { mcpToken } = JSON.parse(fs.readFileSync(`${remoteHome}/secrets.json`, 'utf8'));
  const { port } = JSON.parse(fs.readFileSync(`${remoteHome}/host.json`, 'utf8'));
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { threadId: 'sync-agent' } } }),
  });
  const body = await res.json();
  return body.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

/** Client RPC to the other machine's host (as the app would). */
async function hostRpc(method, params) {
  const { port, token } = JSON.parse(fs.readFileSync(`${remoteHome}/host.json`, 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bettercodex.v1', `auth.${token}`]);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const result = await new Promise((resolve) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'res' && msg.id === 1) resolve(msg.result ?? msg.error);
    };
    ws.send(JSON.stringify({ t: 'rpc', id: 1, method, params }));
  });
  ws.close();
  return result;
}

async function until(what, fn, timeout = 15000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn().catch((e) => `error: ${e.message}`);
    if (last === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

export default async function ({ win, app, shot, sleep, out }) {
  const { server, counts } = site();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // add the SSH machine and switch to it
    await win.click('text=Settings');
    if (await win.$('.host-item:has-text("remote-sim")')) {
      await win.click('.host-item:has-text("remote-sim") button:has-text("Remove")');
      await sleep(500);
    }
    await win.click('text=Add SSH machine…');
    await win.fill('input[placeholder^="me@devbox"]', 'gregor@127.0.0.1');
    await win.fill('input[placeholder="optional"]', 'remote-sim');
    await win.fill('input[placeholder="22"]', '2222');
    await win.fill('input[placeholder^="optional, e.g."]', '/tmp/bc-ssh/clientkey');
    await win.click('button:has-text("Add machine")');
    for (let i = 0; i < 180 && (await win.$$('.host-item .status-dot.connected')).length < 2; i++) await sleep(1000);
    await win.click('.modal-header .icon-button');
    await win.click('.host-button');
    await win.click('.host-popover .popover-item:has-text("remote-sim")');
    await win.waitForSelector('.hero', { timeout: 30000 });
    if (!(await win.$('.browser-panel'))) await win.click('button[title="Toggle browser"]');
    await win.click('.url-form input');
    await win.fill('.url-form input', `${base}/`);
    await win.keyboard.press('Enter');
    await win.waitForSelector('.viewport.native', { timeout: 30000 });

    // the copy is a page of this app; the original lives in the other machine's browser
    let copy;
    await until('the synced copy to load', async () => {
      copy = app.windows().find((p) => p.url().startsWith(base) && p !== win);
      return !!copy && (await copy.title()) === 'Sync test';
    });
    const listing = await mcp('tabs', { all: true });
    const tabId = listing.split('\n').find((l) => l.includes(`${base}/`))?.match(/t\d+/)?.[0];
    if (!tabId) throw new Error('the tab is not open on the other machine');
    console.log('copy of', tabId, 'loaded');
    await sleep(800);
    rootShot(out, '80-sync-copy');

    const view = await win.$eval('.viewport.native', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    const at = async (selector) => {
      const b = await copy.locator(selector).boundingBox();
      return [view.x + b.x + b.width / 2, view.y + b.y + b.height / 2];
    };
    const remote = (script) => mcp('evaluate', { tabId, script });

    // 1. a real click in the copy is replayed there
    click(...(await at('#inc')));
    await until('the click to reach the other machine', async () => JSON.parse(await remote('document.title')) === 'count 1');
    console.log('click: copy', await copy.title(), '| other machine', JSON.parse(await remote('document.title')));

    // 2. typing in the copy
    click(...(await at('#name')));
    type('typed in the copy');
    await until('typed text to reach the other machine', async () => JSON.parse(await remote('document.querySelector("#name").value')) === 'typed in the copy');
    console.log('typing reached the other machine');

    // 3. the agent acts on the other machine; the copy follows
    await mcp('click', { tabId, selector: '#inc' });
    await mcp('select_option', { tabId, selector: '#color', values: ['g'] });
    await until('agent actions to reach the copy', async () => (await copy.title()) === 'count 2' && (await copy.inputValue('#color')) === 'g');
    console.log('agent click and select reached the copy');
    await mcp('type', { tabId, selector: '#name', text: 'agent text' });
    await until('agent typing to reach the copy', async () => (await copy.inputValue('#name')) === 'agent text');

    // 4. the agent navigates; the copy follows
    await mcp('navigate', { tabId, url: `${base}/page2`, snapshot: false });
    await until('the copy to follow the navigation', async () => copy.url() === `${base}/page2`);
    await mcp('navigate', { tabId, action: 'back', snapshot: false });
    await until('the copy to follow back', async () => copy.url() === `${base}/`);
    console.log('navigation followed');

    // 5. Enter on a focused button in the copy saves once (the key travels, not also a click)
    await copy.focus('#save');
    execFileSync('xdotool', ['key', 'Return'], { env: process.env });
    await until('the save to happen on the other machine', async () => counts.save >= 1);
    await sleep(1500);
    console.log('Enter on a button: saves sent', counts.save);
    if (counts.save !== 1) throw new Error(`expected exactly one save, got ${counts.save}`);

    // 6. a page that reads through POST loads in the copy; a POST after a click is sent once and its
    //    answer shows up in the copy too, whether the click was made in the copy or by the agent
    await until('the copy to load data posted at page load', async () => (await copy.textContent('#greeting')) === 'Welcome');
    click(...(await at('#like')));
    await until('the like to show in the copy', async () => (await copy.textContent('#likes')) === '1');
    await sleep(1500);
    console.log('like from the copy: sent', counts.like, '| copy shows', await copy.textContent('#likes'));
    if (counts.like !== 1) throw new Error(`expected one like, got ${counts.like}`);
    await mcp('click', { tabId, selector: '#like' });
    await until('the agent like to show in the copy', async () => (await copy.textContent('#likes')) === '2');
    await sleep(1500);
    console.log('like by the agent: sent', counts.like, '| copy shows', await copy.textContent('#likes'));
    if (counts.like !== 2) throw new Error(`expected two likes, got ${counts.like}`);

    // 7. an in-page navigation does not leave the tab loading forever
    click(...(await at('#route')));
    await until('the route change to finish loading', async () => {
      const tab = (await hostRpc('browser/tabs/list', {})).tabs.find((t) => t.id === tabId);
      return tab?.url.endsWith('/?route=2') && tab.loading === false;
    });
    console.log('in-page navigation finished loading');

    // 8. signing in from the copy: the form is posted once, by the other machine, and its cookie follows
    const postsBefore = counts.login;
    click(...(await at('#user')));
    type('ada');
    await sleep(500);
    click(...(await at('#login')));
    await until('the copy to show the signed-in page', async () => copy.url() === `${base}/?welcome` && (await copy.locator('h1').textContent()) === 'Hello ada', 20000);
    await sleep(1500);
    console.log('sign-in: form posts sent', counts.login - postsBefore, '| copy says', await copy.locator('h1').textContent());
    if (counts.login - postsBefore !== 1) throw new Error(`expected exactly one sign-in post, got ${counts.login - postsBefore}`);
    rootShot(out, '81-sync-signed-in');
    await shot('82-sync-ui');
  } finally {
    server.close();
  }
}
