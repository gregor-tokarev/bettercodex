// Opens the app, shows the thread list, opens a thread and the browser panel.
export default async function ({ win, shot, sleep }) {
  await shot('01-start');
  const rows = await win.$$('.thread-row');
  if (rows.length) {
    await rows[0].click();
    await win.waitForSelector('.turn, .center-note', { timeout: 30000 });
    await sleep(1500);
    await shot('02-thread');
  }
  await win.click('button[title="Toggle browser"]');
  await sleep(1500);
  await shot('03-browser');
}
