// Default permissions: a command needing network asks for approval in the UI; Stop interrupts a turn;
// an older thread is resumed and continues with its (sleeping) browser tab.
async function waitIdle(win, sleep, max = 240) {
  for (let i = 0; i < max; i++) {
    if (i > 3 && !(await win.$('.send-button.stop')) && !(await win.$('.working')) && !(await win.$('.approval-card'))) return;
    await sleep(1000);
  }
}

export default async function ({ win, shot, sleep }) {
  await win.click('.sidebar-button:has-text("New thread")');
  await sleep(1000);
  await win.click('.composer textarea');
  await win.keyboard.type('Run exactly this shell command: curl -sI https://example.com | head -1 — it needs network, so request escalated permissions for it right away. Then tell me the status line.');
  await win.keyboard.press('Enter');
  const card = await win.waitForSelector('.approval-card', { timeout: 180000 }).catch(() => null);
  await shot('40-approval');
  if (card) {
    console.log('APPROVAL:', (await card.textContent()).slice(0, 300));
    await win.click('.approval-card .btn.primary');
  } else console.log('no approval card appeared');
  await waitIdle(win, sleep);
  await shot('41-approved');
  console.log('AGENT:', (await win.$$eval('.agent-message', (els) => els.map((e) => e.textContent).join(' | '))).slice(0, 400));

  // interrupt
  await win.click('.composer textarea');
  await win.keyboard.type('Run the shell command `sleep 45` and then reply "finished".');
  await win.keyboard.press('Enter');
  await win.waitForSelector('.send-button.stop', { timeout: 60000 });
  await sleep(8000);
  await win.click('.send-button.stop');
  await waitIdle(win, sleep, 60);
  await shot('42-interrupted');
  console.log('STOPPED NOTE:', await win.$$eval('.turn-note, .worked-for', (els) => els.map((e) => e.textContent).join(' | ')));

  // resume an older thread that used the browser and continue it
  const row = await win.$('.thread-row:has-text("Use the browser: open")');
  if (row) {
    await row.click();
    await win.waitForSelector('.turn', { timeout: 30000 });
    await sleep(1000);
    await win.click('.composer textarea');
    await win.keyboard.type('Using the same Hacker News tab (do not open a new one), what is the second story title?');
    await win.keyboard.press('Enter');
    await sleep(3000);
    await waitIdle(win, sleep);
    await shot('43-resumed');
    const msgs = await win.$$eval('.agent-message', (els) => els.map((e) => e.textContent));
    console.log('RESUMED AGENT:', msgs.slice(-1)[0]?.slice(0, 300));
  }
}
