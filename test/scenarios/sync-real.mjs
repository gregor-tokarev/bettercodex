// Synced copy against real sites (needs the internet): the agent opens pages on the SSH machine,
// the person clicks links and scrolls in the copy, and both sides end up on the same page.
// Run after the "sync" scenario (it reuses the remote-sim machine).
import fs from 'node:fs';
import { click, rootShot } from './x11.mjs';
import { execFileSync } from 'node:child_process';

const remoteHome = process.env.REMOTE_HOME ?? '/tmp/bc-remote-userhome/.bettercodex';

async function mcp(name, args) {
  const { mcpToken } = JSON.parse(fs.readFileSync(`${remoteHome}/secrets.json`, 'utf8'));
  const { port } = JSON.parse(fs.readFileSync(`${remoteHome}/host.json`, 'utf8'));
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { threadId: 'sync-real' } } }),
  });
  const body = await res.json();
  return body.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

async function until(what, fn, timeout = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn().catch((e) => `error: ${e.message}`);
    if (last === true) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

export default async function ({ win, app, shot, sleep, out }) {
  await win.click('.host-button');
  await win.click('.host-popover .popover-item:has-text("remote-sim")');
  await win.waitForSelector('.hero', { timeout: 30000 });
  if (!(await win.$('.browser-panel'))) await win.click('button[title="Toggle browser"]');

  // A sign-in page that loads its settings through POST requests (it used to fail in copies).
  await win.click('.url-form input');
  await win.fill('.url-form input', 'https://e.mail.ru/');
  await win.keyboard.press('Enter');
  let mail;
  await until('the mail sign-in copy', async () => {
    mail = app.windows().find((p) => /id\.vk\.ru|e\.mail\.ru|account\.mail\.ru/.test(p.url()) && p !== win);
    return !!mail && /Sign in|Войти/.test(await mail.evaluate(() => document.body.innerText));
  }, 30000);
  const errorShown = await mail.evaluate(() => /Check your internet connection|Проверьте подключение/.test(document.body.innerText));
  console.log('mail sign-in in the copy:', mail.url().slice(0, 60), '| error shown:', errorShown);
  rootShot(out, '89-mail-sign-in');
  if (errorShown) throw new Error('the sign-in page shows a connection error in the copy');

  for (const [name, url, link] of [
    ['wikipedia', 'https://en.wikipedia.org/wiki/Electron_(software_framework)', { role: 'link', name: 'Chromium browser engine' }],
    ['github', 'https://github.com/electron/electron', { role: 'link', name: /^Issues/ }],
  ]) {
    await win.click('.url-form input');
    await win.fill('.url-form input', url);
    await win.keyboard.press('Enter');
    await sleep(1500);
    const tabId = (await mcp('tabs', { all: true }))
      .split('\n')
      .filter((l) => l.includes(url.slice(8, 40)))
      .map((l) => l.match(/t(\d+)/)?.[0])
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
    console.log(name, 'open on the other machine as', tabId);
    let copy;
    await until(`${name} copy`, async () => {
      copy = app.windows().find((p) => p.url().startsWith(url.split('#')[0]) && p !== win);
      return !!copy;
    });
    await copy.waitForLoadState('domcontentloaded');
    await sleep(2500);
    const view = await win.$eval('.viewport.native', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    // scroll the copy with the real wheel, then click a link in it
    execFileSync('xdotool', ['mousemove', String(Math.round(1200)), String(Math.round(500)), 'click', '--repeat', '3', '--delay', '80', '5'], { env: process.env });
    await sleep(1500);
    const remoteScroll = JSON.parse(await mcp('evaluate', { tabId, script: 'Math.round(scrollY)' }));
    console.log(name, 'scroll: copy', await copy.evaluate(() => Math.round(scrollY)), '| other machine', remoteScroll);
    const target = link.css ? copy.locator(link.css).first() : copy.getByRole(link.role, { name: link.name }).first();
    const href = await target.evaluate((a) => a.href);
    const expect = { test: (u) => u.split('#')[0] === href.split('#')[0] };
    console.log(name, 'clicking a link to', href);
    await target.scrollIntoViewIfNeeded();
    await sleep(400);
    const b = await target.boundingBox();
    click(view.x + b.x + b.width / 2, view.y + b.y + b.height / 2);
    await until(`${name} link click on the other machine`, async () => expect.test(JSON.parse(await mcp('evaluate', { tabId, script: 'location.href' }))));
    await until(`${name} copy to settle on the same page`, async () => expect.test(copy.url()));
    await sleep(2000);
    console.log(name, 'copy at', copy.url(), '| other machine at', JSON.parse(await mcp('evaluate', { tabId, script: 'location.href' })));
    rootShot(out, `90-${name}`);
  }
}
