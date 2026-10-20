// Codex takes a screenshot and embeds it in its answer; the image loads from the host.
export default async function ({ win, shot, sleep }) {
  await win.click('.sidebar-button:has-text("New thread")');
  await sleep(800);
  await win.click('.composer textarea');
  await win.keyboard.type('Open https://example.com in the browser, take a screenshot and show it to me in your reply (embed the image).');
  await win.keyboard.press('Enter');
  await win.waitForSelector('.user-bubble', { timeout: 30000 });
  for (let i = 0; i < 180; i++) {
    if (i > 5 && !(await win.$('.send-button.stop')) && !(await win.$('.working'))) break;
    await sleep(1000);
  }
  await sleep(2000);
  const imgs = await win.$$eval('.agent-message img', (els) => els.map((e) => ({ src: e.src.slice(0, 30), w: e.naturalWidth })));
  console.log('IMAGES IN REPLY:', JSON.stringify(imgs));
  await shot('50-screenshot-reply');
}
