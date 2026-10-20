// Launches the built Electron app with Playwright and runs a scripted UI session, saving screenshots.
//   DISPLAY=:77 BETTERCODEX_HOME=/tmp/bc-home node test/drive-app.mjs <scenario> [outDir]
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.argv[2] ?? 'overview';
const out = process.argv[3] ?? '/tmp/bc-shots';
fs.mkdirSync(out, { recursive: true });

// PACKAGED=release/linux-unpacked/bettercodex tests a packaged build instead of the dev tree.
const packaged = process.env.PACKAGED;
const app = await electron.launch({
  executablePath: packaged ? path.resolve(packaged) : require('electron'),
  args: packaged ? ['--no-sandbox'] : [root, '--no-sandbox'],
  env: { ...process.env },
  timeout: 60000,
});
const win = await app.firstWindow();
win.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('[renderer]', m.type(), m.text());
});
win.on('pageerror', (e) => console.log('[renderer] pageerror', e.message));
await win.setViewportSize?.({ width: 1500, height: 940 }).catch(() => {});
const shot = async (name) => {
  const file = path.join(out, `${name}.png`);
  await win.screenshot({ path: file });
  console.log('shot', file);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await win.waitForSelector('.sidebar', { timeout: 30000 });
  await win.waitForSelector('.thread-row, .sidebar-empty', { timeout: 60000 });
  await sleep(1500);
  const steps = (await import(path.join(root, 'test/scenarios', `${scenario}.mjs`))).default;
  await steps({ win, app, shot, sleep, out });
} catch (err) {
  console.error('FAILED', err);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
process.exit(process.exitCode ?? 0);
