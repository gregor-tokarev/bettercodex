import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AppBrowserRegistration } from '../../shared/types.js';
import { paths, readJson, writeJson } from '../config.js';
import { log } from '../log.js';
import { startXvfb, type Display } from './launch.js';

export type AppLauncher = AppBrowserRegistration['launch'];

/** How to start the BetterCodex app on this machine, if it is installed here. */
export function appLauncher(): AppLauncher | null {
  const candidates: Array<AppLauncher | null> = [];
  try {
    if (process.env.BETTERCODEX_APP) candidates.push(JSON.parse(process.env.BETTERCODEX_APP));
  } catch {
    // ignore a malformed value
  }
  candidates.push(readJson<AppLauncher | null>(paths.app, null));
  for (const c of candidates) {
    if (c?.exec && Array.isArray(c.args) && fs.existsSync(c.exec)) return c;
  }
  return null;
}

export function rememberLauncher(launch: AppLauncher) {
  try {
    writeJson(paths.app, launch);
  } catch (err) {
    log.warn('could not record the app location', String(err));
  }
}

/**
 * Starts the app without a window so its tabs are available to agents. On Linux without a usable
 * display it gets a private virtual one.
 */
export async function launchAppInBackground(
  launch: AppLauncher,
  host: { port: number; token: string },
  registered: () => Promise<void>,
): Promise<{ display: Display | null; exited: Promise<void> }> {
  const attempt = async (display: Display | null) => {
    const env: Record<string, string | undefined> = { ...process.env, BC_HOST_PORT: String(host.port), BC_HOST_TOKEN: host.token };
    delete env.ELECTRON_RUN_AS_NODE;
    if (display) {
      env.DISPLAY = display.display;
      delete env.WAYLAND_DISPLAY;
    }
    log.info(`starting the BetterCodex app in the background${display ? ` on ${display.display}` : ''}`);
    const args = [...launch.args, '--bc-background', ...(display ? ['--ozone-platform=x11'] : [])];
    const child = spawn(launch.exec, args, { env, detached: true, stdio: 'ignore' });
    child.unref();
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    const failed = new Promise<never>((_, reject) => {
      // Exit code 0 means a copy of the app was already running; that copy registers instead.
      child.once('exit', (code) => code !== 0 && reject(new Error(`the app exited (${code}) before offering its browser`)));
      child.once('error', reject);
    });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the app did not offer its browser in time')), 40000));
    await Promise.race([registered(), failed, timeout]);
    return { exited };
  };
  const hasDisplay = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (hasDisplay) {
    try {
      return { display: null, ...(await attempt(null)) };
    } catch (err) {
      if (process.platform !== 'linux') throw err;
      log.warn('background app failed on the current display:', String(err));
    }
  }
  const display = await startXvfb();
  if (!display) throw new Error('No display for the BetterCodex app (install Xvfb to run it on a machine without a screen)');
  try {
    return { display, ...(await attempt(display)) };
  } catch (err) {
    display.process.kill();
    throw err;
  }
}
