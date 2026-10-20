// End-to-end smoke test for the host daemon: browser tabs, screencast and a real Codex turn
// that drives the browser through the MCP tools.
//   BETTERCODEX_HOME=/tmp/bc-home node test/smoke-host.mjs [--no-agent]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.HOST_MJS || path.join(root, 'dist/host/host.mjs');
const port = Number(process.env.BETTERCODEX_PORT || 47900);
const out = process.env.SMOKE_OUT || '/tmp/bc-smoke';
fs.mkdirSync(out, { recursive: true });

const info = JSON.parse(execFileSync(process.execPath, [host, 'start', '--port', String(port)], { encoding: 'utf8' }).trim().split('\n').pop());
console.log('host', info.pid, info.port);

const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, ['bettercodex.v1', `auth.${info.token}`]);
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.t === 'res') {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  } else if (msg.t === 'req') {
    console.log('server request', msg.method);
    ws.send(JSON.stringify({ t: 'reqres', id: msg.id, result: { decision: 'accept' } }));
  } else if (msg.t === 'notif') {
    for (const l of listeners) l(msg.method, msg.params);
  }
});
await new Promise((r, j) => {
  ws.once('open', r);
  ws.once('error', j);
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'rpc', id, method, params }));
  });

const hostInfo = await rpc('host/info');
console.log('codex', hostInfo.codex.status, hostInfo.codex.version);

// 1. user opens a tab for a thread
const threadKey = `smoke-${Date.now()}`;
const { tab } = await rpc('browser/tabs/new', { threadId: threadKey, url: 'https://example.com' });
console.log('tab', tab.id, tab.url);
const status = (await rpc('host/info')).browser;
console.log('browser', status.state, status.mode, status.version, status.executablePath);

// 2. stream one frame of it
const stream = new WebSocket(`ws://127.0.0.1:${info.port}/stream`, ['bettercodex.v1', `auth.${info.token}`]);
await new Promise((r) => stream.once('open', r));
const frame = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no frame within 15s')), 15000);
  stream.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const len = data.readUInt32LE(0);
    const header = JSON.parse(data.subarray(4, 4 + len).toString());
    clearTimeout(timer);
    resolve({ header, jpeg: data.subarray(4 + len) });
  });
  stream.send(JSON.stringify({ t: 'attach', tabId: tab.id, width: 1000, height: 700 }));
});
fs.writeFileSync(path.join(out, 'frame.jpg'), frame.jpeg);
console.log('frame', frame.header, frame.jpeg.length, 'bytes ->', path.join(out, 'frame.jpg'));
stream.close();

if (process.argv.includes('--no-agent')) process.exit(0);

// 3. Codex drives the browser in a fresh thread
const started = await rpc('thread/start', { cwd: out, approvalPolicy: 'never', sandbox: 'workspace-write', model: process.env.SMOKE_MODEL || 'gpt-6-luna' });
const threadId = started.thread.id;
console.log('thread', threadId);
const done = new Promise((resolve) => {
  listeners.push((method, params) => {
    if (params?.threadId !== threadId) return;
    if (method === 'item/completed') {
      const it = params.item;
      if (it.type === 'mcpToolCall') console.log(`  tool ${it.server}.${it.tool} ${it.status}`, JSON.stringify(it.arguments).slice(0, 120), it.error ? it.error.message : '');
      if (it.type === 'agentMessage') console.log(`  agent: ${it.text.slice(0, 600)}`);
    }
    if (method === 'turn/completed') resolve(params.turn);
  });
});
await rpc('turn/start', {
  threadId,
  effort: 'low',
  input: [
    {
      type: 'text',
      text:
        'Use the browser tools: open https://example.com in a new tab, read the page with a snapshot, click the link on the page, ' +
        'then take a screenshot. Finally list the tabs of this thread and tell me the final URL and title.',
      text_elements: [],
    },
  ],
});
const turn = await done;
console.log('turn', turn.status, turn.error?.message ?? '');
const tabs = await rpc('browser/tabs/list', { threadId });
console.log('thread tabs', tabs.tabs.map((t) => `${t.id} ${t.url} agentActive=${t.agentActive}`));
process.exit(turn.status === 'completed' ? 0 : 1);
