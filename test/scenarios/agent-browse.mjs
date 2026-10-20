// New thread: Codex opens a page in the host browser; the panel shows it live; the user then
// interacts with the tab directly (click + URL bar). Locally the tab is a native view.
import { click, rootShot } from './x11.mjs';

export default async function ({ win, app, shot, sleep, out }) {
  await win.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('bettercodex.prefs') || '{}');
    localStorage.setItem('bettercodex.prefs', JSON.stringify({ ...prefs, theme: 'dark', browserOpen: false }));
  });
  await win.reload();
  await win.waitForSelector('.composer textarea', { timeout: 30000 });
  await sleep(2500);
  await win.click('.composer textarea');
  await win.keyboard.type('Use the browser: open https://news.ycombinator.com and tell me the title of the top story. Keep the tab open.');
  await shot('10-typed');
  await win.keyboard.press('Enter');
  await win.waitForSelector('.user-bubble', { timeout: 30000 });
  await win.waitForSelector('.browser-panel .tab', { timeout: 120000 });
  await sleep(4000);
  await shot('11-agent-browsing');
  rootShot(out, '11-agent-browsing-screen');
  // wait for the turn to finish (stop button disappears)
  for (let i = 0; i < 180; i++) {
    if (!(await win.$('.send-button.stop')) && !(await win.$('.working'))) break;
    await sleep(1000);
  }
  await sleep(1500);
  await shot('12-turn-done');
  rootShot(out, '12-turn-done-screen');
  const answer = await win.$$eval('.agent-message', (els) => els.map((e) => e.textContent).join('\n---\n'));
  console.log('AGENT:', answer.slice(0, 600));
  // user clicks the "new" link in the HN header
  const before = await win.$eval('.url-form input', (i) => i.value);
  if (await win.$('.viewport.native')) {
    const view = await win.$eval('.viewport.native', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const hn = app.windows().find((p) => p.url().includes('ycombinator'));
    const link = await hn.locator('a[href="newest"]').first().boundingBox();
    click(view.x + link.x + link.width / 2, view.y + link.y + link.height / 2);
  } else {
    const box = await win.$eval('.viewport-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await win.mouse.click(box.x + 150, box.y + 12);
  }
  await sleep(2500);
  const after = await win.$eval('.url-form input', (i) => i.value);
  console.log('URL before click:', before, ' after click:', after);
  await shot('13-user-clicked');
  rootShot(out, '13-user-clicked-screen');
  // user navigates via URL bar
  await win.click('.url-form input');
  await win.keyboard.type('example.com');
  await win.keyboard.press('Enter');
  await sleep(3500);
  console.log('URL after typing:', await win.$eval('.url-form input', (i) => i.value));
  await shot('14-url-bar');
  rootShot(out, '14-url-bar-screen');
}
