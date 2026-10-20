// Adds an SSH machine through Settings, then works in a thread whose Codex and browser live there.
export default async function ({ win, shot, sleep }) {
  const target = process.env.REMOTE_TARGET ?? 'gregor@127.0.0.1';
  await win.click('text=Settings');
  if (await win.$('.host-item:has-text("remote-sim")')) {
    await win.click('.host-item:has-text("remote-sim") button:has-text("Remove")');
    await sleep(500);
  }
  await win.click('text=Add SSH machine…');
  await win.fill('input[placeholder^="me@devbox"]', target);
  await win.fill('input[placeholder="optional"]', 'remote-sim');
  await win.fill('input[placeholder="22"]', process.env.REMOTE_PORT ?? '2222');
  await win.fill('input[placeholder^="optional, e.g."]', process.env.REMOTE_KEY ?? '/tmp/bc-ssh/clientkey');
  await shot('20-add-host');
  await win.click('button:has-text("Add machine")');
  const started = Date.now();
  let status = '';
  while (Date.now() - started < 180000) {
    status = await win.$$eval('.host-item', (els) => els.map((e) => e.textContent).join(' | '));
    if (/remote-sim|127\.0\.0\.1/.test(status) && (await win.$$('.host-item .status-dot.connected')).length >= 2) break;
    await sleep(1000);
  }
  console.log('hosts:', status);
  await shot('21-host-connected');
  await win.click('.modal-header .icon-button');
  await win.click('.host-button');
  await win.click('.host-popover .popover-item:has-text("127.0.0.1")');
  await win.waitForSelector('.hero', { timeout: 30000 });
  await sleep(2000);
  // open a page in the remote browser from the panel, as a user would
  if (!(await win.$('.browser-panel'))) await win.click('button[title="Toggle browser"]');
  await win.click('.url-form input');
  await win.keyboard.type('https://example.org');
  await win.keyboard.press('Enter');
  await sleep(4000);
  await shot('22-remote-tab');
  await win.click('.composer textarea');
  await win.keyboard.type('Look at the page open in my browser tab and tell me its main heading and the link text on it. Do not open new tabs.');
  await win.keyboard.press('Enter');
  await win.waitForSelector('.user-bubble', { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    if (i > 5 && !(await win.$('.send-button.stop')) && !(await win.$('.working'))) break;
    await sleep(1000);
  }
  await sleep(1500);
  const worked = await win.$('.worked-for');
  if (worked) await worked.click();
  await sleep(500);
  await shot('23-remote-answer');
  console.log('AGENT:', (await win.$$eval('.agent-message', (els) => els.map((e) => e.textContent).join('\n---\n'))).slice(0, 500));
}
