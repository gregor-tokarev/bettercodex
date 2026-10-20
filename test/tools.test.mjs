// Exercises every browser tool through the host's MCP endpoint against a local test site.
//   BETTERCODEX_HOME=/tmp/bc-home node --test test/tools.test.mjs   (needs a running host)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const home = process.env.BETTERCODEX_HOME ?? path.join(os.homedir(), '.bettercodex');
const { mcpToken } = JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'));
const { port } = JSON.parse(fs.readFileSync(path.join(home, 'host.json'), 'utf8'));
const threadId = `tools-test-${Date.now()}`;

const PAGES = {
  '/': `<!doctype html><title>Tool test</title>
    <h1>Tool test page</h1>
    <label>Name <input id="name"></label>
    <select id="color"><option value="r">Red</option><option value="g">Green</option></select>
    <button id="go" onclick="document.querySelector('#out').textContent = 'Hello ' + document.querySelector('#name').value + ' ' + document.querySelector('#color').value">Greet</button>
    <p id="out"></p>
    <a href="/popup" target="_blank">Open popup</a>
    <button onclick="console.log('logged', 42); setTimeout(() => { throw new Error('boom') })">Log</button>
    <button onclick="document.querySelector('#answer').textContent = String(confirm('Sure?'))">Ask</button>
    <p id="answer"></p>
    <input type="file" id="file" onchange="document.querySelector('#fname').textContent = this.files[0].name">
    <p id="fname"></p>
    <a href="/file.txt" download>Download file</a>
    <div style="height:3000px"></div><p id="bottom">Bottom</p>`,
  '/popup': '<!doctype html><title>Popup page</title><h1>Popup!</h1>',
  '/file.txt': 'downloaded content',
};

let server;
let base;
let rpcId = 1;

async function call(name, args = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args, _meta: { threadId } } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  const textOut = body.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text: textOut, images: body.result.content.filter((c) => c.type === 'image'), isError: !!body.result.isError };
}

function ref(snapshot, pattern) {
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  const m = line && /\[ref=([^\]]+)\]/.exec(line);
  assert.ok(m, `no ref for ${pattern} in:\n${snapshot.slice(0, 2000)}`);
  return m[1];
}

before(async () => {
  server = http.createServer((req, res) => {
    const body = PAGES[req.url] ?? 'not found';
    const headers = req.url === '/file.txt' ? { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="file.txt"' } : { 'Content-Type': 'text/html' };
    res.writeHead(PAGES[req.url] ? 200 : 404, headers).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  const list = await call('tabs', {});
  for (const id of list.text.match(/t\d+/g) ?? []) await call('tabs', { action: 'close', tabId: id });
  server.closeAllConnections();
  server.close();
});

test('tools are listed', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const names = (await res.json()).result.tools.map((t) => t.name);
  for (const n of ['tabs', 'navigate', 'snapshot', 'screenshot', 'click', 'type', 'press', 'hover', 'scroll', 'select_option', 'evaluate', 'wait', 'console', 'dialog', 'upload', 'downloads', 'js']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test('rejects a wrong token', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(res.status, 401);
});

test('navigate, snapshot, type, select, click by ref', async () => {
  const nav = await call('navigate', { url: base });
  assert.match(nav.text, /Tool test page/);
  const name = ref(nav.text, /textbox "Name"/);
  await call('type', { ref: name, text: 'Ada' });
  const snap = (await call('snapshot')).text;
  await call('select_option', { ref: ref(snap, /combobox/), values: ['g'] });
  const clicked = await call('click', { ref: ref(snap, /button "Greet"/), snapshot: true });
  assert.match(clicked.text, /Hello Ada g/);
});

test('screenshot returns an image and saves it', async () => {
  const shot = await call('screenshot');
  assert.equal(shot.images.length, 1);
  assert.equal(shot.images[0].mimeType, 'image/jpeg');
  const file = /Saved: (\S+)/.exec(shot.text)[1];
  assert.ok(fs.existsSync(file));
});

test('evaluate can write the DOM', async () => {
  const res = await call('evaluate', { script: '() => { document.title = "changed"; return document.title }' });
  assert.equal(JSON.parse(res.text), 'changed');
  const el = await call('evaluate', { selector: '#out', script: '(el) => el.textContent' });
  assert.equal(JSON.parse(el.text), 'Hello Ada g');
});

test('console messages and page errors are captured', async () => {
  const snap = (await call('snapshot')).text;
  await call('click', { ref: ref(snap, /button "Log"/) });
  await new Promise((r) => setTimeout(r, 300));
  const logs = await call('console', {});
  assert.match(logs.text, /logged 42/);
  assert.match(logs.text, /boom/);
});

test('dialogs are reported and can be answered', async () => {
  const snap = (await call('snapshot')).text;
  const clicked = await call('click', { ref: ref(snap, /button "Ask"/) });
  assert.match(clicked.text, /confirm dialog is open/);
  await call('dialog', { accept: true });
  const answer = await call('evaluate', { script: 'document.querySelector("#answer").textContent' });
  assert.equal(JSON.parse(answer.text), 'true');
});

test('scroll moves the page', async () => {
  await call('scroll', { direction: 'down', pages: 2 });
  const y = await call('evaluate', { script: 'scrollY' });
  assert.ok(Number(y.text) > 500, `scrollY=${y.text}`);
  await call('scroll', { selector: '#bottom' });
  const visible = await call('evaluate', { selector: '#bottom', script: '(el) => el.getBoundingClientRect().top < innerHeight' });
  assert.equal(JSON.parse(visible.text), true);
});

test('upload sets files on a file input', async () => {
  const file = path.join(os.tmpdir(), 'bc-upload.txt');
  fs.writeFileSync(file, 'upload me');
  await call('upload', { selector: '#file', paths: [file] });
  const name = await call('evaluate', { script: 'document.querySelector("#fname").textContent' });
  assert.equal(JSON.parse(name.text), 'bc-upload.txt');
});

test('downloads are saved on the host', async () => {
  await call('click', { selector: 'a[download]' });
  let listing = '';
  for (let i = 0; i < 20 && !/completed/.test(listing); i++) {
    await new Promise((r) => setTimeout(r, 250));
    listing = (await call('downloads', {})).text;
  }
  const saved = /completed\s+(.+?\.txt)\s+\(from/.exec(listing)?.[1];
  assert.ok(saved, listing);
  assert.equal(fs.readFileSync(saved, 'utf8'), 'downloaded content');
});

test('popups open as tabs of the same thread and become current', async () => {
  await call('scroll', { direction: 'up', pages: 10 });
  const snap = (await call('snapshot')).text;
  const res = await call('click', { ref: ref(snap, /link "Open popup"/) });
  assert.match(res.text, /New tab t\d+ opened/);
  await new Promise((r) => setTimeout(r, 500));
  const list = await call('tabs', {});
  assert.match(list.text, /\* t\d+\s+Popup page/);
});

test('js REPL keeps state, allows redeclaration and shows screenshots', async () => {
  const first = await call('js', { code: 'const greeting = "hi"; function twice(x) { return x + x } await page.title()' });
  assert.equal(first.text, 'Popup page');
  const second = await call('js', { code: 'const greeting = twice("yo"); greeting' });
  assert.equal(second.text, 'yoyo');
  const third = await call('js', { code: 'const p = await tabs.new("' + base + '"); await p.locator("h1").textContent()' });
  assert.equal(third.text, 'Tool test page');
  const shot = await call('js', { code: 'await screenshot(); print("done")' });
  assert.equal(shot.images.length, 1);
  assert.match(shot.text, /done/);
  const err = await call('js', { code: 'throw new Error("nope")' });
  assert.ok(err.isError);
  assert.match(err.text, /nope/);
});

test('tabs of other threads are visible with all=true and can be claimed', async () => {
  const all = await call('tabs', { all: true });
  assert.match(all.text, /\[thread this\]/);
  const tabs = await call('tabs', {});
  assert.doesNotMatch(tabs.text, /no tabs/);
});
