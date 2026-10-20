// The local machine's tabs are native views of the app: opens a page in the panel, checks with real
// X input (xdotool) that it renders and reacts without streaming, answers a page dialog from the
// panel and runs the browser tool tests against the app browser.
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const PAGE = `<!doctype html><title>Native test</title><body style="margin:0;font:20px sans-serif;background:#2e7d32;color:#fff">
<h1 style="margin:20px">Native page</h1>
<input id=a placeholder=type-here style="position:absolute;left:20px;top:90px;width:300px;height:40px;font-size:20px">
<button id=c style="position:absolute;left:20px;top:150px;width:160px;height:40px" onclick="document.title='clicked '+(window.n=(window.n||0)+1)">Click me</button>
<button id=d style="position:absolute;left:200px;top:150px;width:160px;height:40px" onclick="document.body.dataset.answer=String(confirm('Proceed?'))">Confirm</button>
</body>`;

export default async function ({ win, app, shot, sleep, out }) {
  const display = process.env.DISPLAY;
  const server = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const root = (name) => {
    const file = path.join(out, `${name}.png`);
    execFileSync('import', ['-display', display, '-window', 'root', file]);
    console.log('screen', file);
  };
  const xdo = (...args) => execFileSync('xdotool', args, { env: { ...process.env, DISPLAY: display } });
  // window position on the X screen, to turn page coordinates into screen coordinates
  const winId = execFileSync('xdotool', ['search', '--onlyvisible', '--name', '^BetterCodex$'], { env: { ...process.env, DISPLAY: display } }).toString().trim().split('\n')[0];
  const geo = Object.fromEntries(
    execFileSync('xdotool', ['getwindowgeometry', '--shell', winId], { env: { ...process.env, DISPLAY: display } })
      .toString()
      .trim()
      .split('\n')
      .map((l) => l.split('=')),
  );
  const screen = (x, y) => [String(Number(geo.X) + Math.round(x)), String(Number(geo.Y) + Math.round(y))];

  await win.click('.sidebar-button:has-text("New thread")');
  if (!(await win.$('.browser-panel'))) await win.click('button[title="Toggle browser"]');
  await win.click('.url-form input');
  await win.fill('.url-form input', url);
  await win.keyboard.press('Enter');
  await win.waitForSelector('.tab:has-text("Native test")', { timeout: 30000 });
  await win.waitForSelector('.viewport.native', { timeout: 10000 });
  await sleep(1500);
  root('60-native-tab');

  const box = await win.$eval('.viewport.native', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  // real mouse click on the button inside the native view
  xdo('mousemove', ...screen(box.x + 100, box.y + 170));
  xdo('click', '1');
  await win.waitForSelector('.tab:has-text("clicked 1")', { timeout: 10000 });
  // real typing into the input
  xdo('mousemove', ...screen(box.x + 150, box.y + 110));
  xdo('click', '1');
  xdo('type', '--delay', '20', 'native typing');
  await sleep(500);
  root('61-native-input');

  // a page dialog is answered from the panel's dialog bar
  xdo('mousemove', ...screen(box.x + 280, box.y + 170));
  xdo('click', '1');
  await win.waitForSelector('.dialog-bar', { timeout: 10000 });
  await shot('62-dialog-bar');
  await win.click('.dialog-bar .btn.primary');
  await win.waitForSelector('.dialog-bar', { state: 'detached', timeout: 10000 });
  const tabPage = app.windows().find((p) => p.url() === url);
  const typed = await tabPage.inputValue('#a');
  const answer = await tabPage.evaluate(() => document.body.dataset.answer);
  console.log('typed:', JSON.stringify(typed), 'confirm answer:', answer);
  if (typed !== 'native typing' || answer !== 'true') throw new Error('native input or dialog did not reach the page');

  // the tab menu covers the page: the native view steps aside and a still is shown under the menu
  await win.click('button[title="All tabs on this machine"]');
  await sleep(600);
  root('63-menu-over-page');
  await win.click('button[title="All tabs on this machine"]');
  await sleep(400);

  // the host sees what the user did in the native view
  const home = process.env.BETTERCODEX_HOME;
  // Not spawnSync: this process also holds a DevTools connection to the app and must keep answering it.
  const tools = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', 'test/tools.test.mjs'], { env: { ...process.env, BETTERCODEX_HOME: home } });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('exit', (status) => resolve({ status, stdout }));
  });
  console.log(tools.stdout.split('\n').filter((l) => /^[✔✖]|^ℹ (pass|fail)/.test(l)).join('\n'));
  if (tools.status !== 0) throw new Error('tool tests failed against the app browser');
  server.close();
}
