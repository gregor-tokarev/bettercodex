// New thread: Codex opens a page in the host browser; the panel shows it live; the user then
// interacts with the streamed tab directly (click + URL bar).
export default async function ({ win, shot, sleep }) {
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
  // wait for the turn to finish (stop button disappears)
  for (let i = 0; i < 180; i++) {
    if (!(await win.$('.send-button.stop')) && !(await win.$('.working'))) break;
    await sleep(1000);
  }
  await sleep(1500);
  await shot('12-turn-done');
  const answer = await win.$$eval('.agent-message', (els) => els.map((e) => e.textContent).join('\n---\n'));
  console.log('AGENT:', answer.slice(0, 600));
  // user clicks into the streamed page: the "new" link in the HN header
  const box = await win.$eval('.viewport-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const before = await win.$eval('.url-form input', (i) => i.value);
  // find the remote coordinates of a link via the host is overkill; click "new" which sits near the top-left header
  await win.mouse.click(box.x + 150, box.y + 12);
  await sleep(2500);
  const after = await win.$eval('.url-form input', (i) => i.value);
  console.log('URL before click:', before, ' after click:', after);
  await shot('13-user-clicked');
  // user navigates via URL bar
  await win.click('.url-form input');
  await win.keyboard.type('example.com');
  await win.keyboard.press('Enter');
  await sleep(3500);
  console.log('URL after typing:', await win.$eval('.url-form input', (i) => i.value));
  await shot('14-url-bar');
}
