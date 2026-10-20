// Drives a test page through the streamed viewport (click, type, unicode, scroll, JS dialog)
// and checks the resulting page state through the host's MCP tools.
import fs from 'node:fs';

const PAGE = `data:text/html,<title>Input test</title><body style="margin:0;font:20px sans-serif">
<input id=a placeholder=type-here style="position:absolute;left:20px;top:20px;width:300px;height:40px;font-size:20px">
<textarea id=b style="position:absolute;left:20px;top:80px;width:300px;height:60px"></textarea>
<button id=c style="position:absolute;left:20px;top:160px;width:120px;height:40px" onclick="document.title='clicked '+(window.n=(window.n||0)+1)">Click</button>
<button id=d style="position:absolute;left:160px;top:160px;width:120px;height:40px" onclick="window.confirmed=confirm('Proceed?')">Confirm</button>
<div style="height:4000px"></div><p>bottom</p></body>`;

async function mcp(home, name, args) {
  const { mcpToken } = JSON.parse(fs.readFileSync(`${home}/secrets.json`, 'utf8'));
  const { port } = JSON.parse(fs.readFileSync(`${home}/host.json`, 'utf8'));
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { threadId: 'input-test' } } }),
  });
  const body = await res.json();
  return body.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export default async function ({ win, shot, sleep }) {
  const home = process.env.BETTERCODEX_HOME;
  await win.click('.sidebar-button:has-text("New thread")');
  if (!(await win.$('.browser-panel'))) await win.click('button[title="Toggle browser"]');
  await win.click('.url-form input');
  await win.fill('.url-form input', PAGE.replace(/\n/g, ''));
  await win.keyboard.press('Enter');
  await win.waitForSelector('.tab:has-text("Input test")', { timeout: 20000 });
  await sleep(1500);
  const box = await win.$eval('.viewport-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  const at = (x, y) => ({ x: box.x + x, y: box.y + y });
  // click the input and type
  let p = at(100, 40);
  await win.mouse.click(p.x, p.y);
  await sleep(300);
  await win.keyboard.type('hello world', { delay: 15 });
  await win.keyboard.press('Shift+Home');
  await win.keyboard.type('Hi');
  // textarea with non-US characters and a newline
  p = at(100, 110);
  await win.mouse.click(p.x, p.y);
  await sleep(200);
  await win.keyboard.type('Ünïcödé ж');
  await win.keyboard.press('Enter');
  await win.keyboard.type('line2');
  // button twice
  p = at(80, 180);
  await win.mouse.click(p.x, p.y);
  await win.mouse.click(p.x, p.y);
  await sleep(300);
  // confirm dialog -> dialog bar in the panel
  p = at(220, 180);
  await win.mouse.click(p.x, p.y);
  await win.waitForSelector('.dialog-bar', { timeout: 10000 });
  await shot('30-dialog');
  await win.click('.dialog-bar .btn.primary');
  await sleep(500);
  // scroll
  p = at(400, 300);
  await win.mouse.move(p.x, p.y);
  await win.mouse.wheel(0, 900);
  await sleep(800);
  await shot('31-after-input');
  const tabs = await mcp(home, 'tabs', { all: true });
  // the newest tab showing the test page
  const tabId = [...tabs.matchAll(/(t\d+)\s+(?:clicked|Input test)/g)].map((m) => m[1]).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
  console.log('tabs:\n' + tabs);
  const state = await mcp(home, 'evaluate', {
    tabId,
    script: '() => ({ a: document.querySelector("#a").value, b: document.querySelector("#b").value, title: document.title, confirmed: window.confirmed, scrollY: Math.round(scrollY) })',
  });
  console.log('PAGE STATE', state);
}
