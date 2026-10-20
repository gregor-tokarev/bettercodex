import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserMode } from '../../shared/types.js';
import { log } from '../log.js';

function isExecutable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function playwrightCacheDirs() {
  const home = os.homedir();
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH ?? ''];
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Library/Caches/ms-playwright'));
  else dirs.push(path.join(home, '.cache/ms-playwright'));
  return dirs.filter(Boolean);
}

/** The Chromium revision the bundled Playwright was built and tested against. */
function expectedRevision(): string | null {
  try {
    const file = fileURLToPath(new URL('./vendor/playwright-core/browsers.json', import.meta.url));
    const browsers = JSON.parse(fs.readFileSync(file, 'utf8')).browsers as Array<{ name: string; revision: string }>;
    return browsers.find((b) => b.name === 'chromium')?.revision ?? null;
  } catch {
    return null;
  }
}

/**
 * Playwright's own Chromium builds, limited to the revision our Playwright expects: older builds
 * can crash under a newer Playwright (seen with downloads), so they are never picked.
 */
function playwrightChromiums(): string[] {
  const wanted = expectedRevision();
  const found: Array<{ rev: number; file: string }> = [];
  for (const dir of playwrightCacheDirs()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^chromium-(\d+)$/.exec(entry);
      if (!match || (wanted && match[1] !== wanted)) continue;
      const base = path.join(dir, entry);
      const options =
        process.platform === 'darwin'
          ? [
              'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
              'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
              'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
            ]
          : ['chrome-linux64/chrome', 'chrome-linux/chrome'];
      for (const option of options) {
        const file = path.join(base, option);
        if (isExecutable(file)) found.push({ rev: Number(match[1]), file });
      }
    }
  }
  return found.sort((a, b) => b.rev - a.rev).map((f) => f.file);
}

function systemBrowsers(): string[] {
  if (process.platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    return apps.flatMap((app) => [path.join('/Applications', app), path.join(os.homedir(), 'Applications', app)]);
  }
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir && !dir.startsWith('/snap'));
  // Snap-packaged Chromium cannot use a profile inside a hidden home directory, so it is skipped.
  return [...names.flatMap((name) => dirs.map((dir) => path.join(dir, name))), '/opt/google/chrome/chrome'].filter(
    (file) => !fs.existsSync(file) || !fs.realpathSync(file).startsWith('/snap/'),
  );
}

/** Installed Chrome first (best compatibility with sign-ins), then Playwright's matching Chromium. */
export function findBrowser(configured: string): string | null {
  const list = [configured, process.env.BETTERCODEX_CHROME ?? '', ...systemBrowsers(), ...playwrightChromiums()];
  return list.find((file) => file && isExecutable(file)) ?? null;
}

/** Downloads Playwright's Chromium build. Used only when no browser is installed at all. */
export async function installChromium(): Promise<string | null> {
  // Resolved relative to the bundled host.mjs, next to which playwright-core is vendored.
  const cli = fileURLToPath(new URL('./vendor/playwright-core/cli.js', import.meta.url));
  log.info('no Chrome/Chromium found, downloading Chromium via playwright…');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`playwright install exited with ${code}`))));
    child.on('error', reject);
  });
  return playwrightChromiums()[0] ?? null;
}

function hasBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => execFile('which', [name], (err) => resolve(!err)));
}

export interface Display {
  display: string;
  process: ChildProcess;
}

/** Starts a private X server so a headful browser can run without showing up on anyone's screen. */
export async function startXvfb(): Promise<Display | null> {
  if (process.platform !== 'linux' || !(await hasBinary('Xvfb'))) return null;
  return new Promise((resolve) => {
    // stderr must not be a pipe nobody reads: once it fills up, Xvfb blocks and Chrome loses its display.
    const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '2560x1600x24', '-nolisten', 'tcp', '-nocursor'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      detached: false,
    });
    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 10000);
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.includes('\n')) {
        clearTimeout(timer);
        resolve({ display: `:${buf.trim()}`, process: child });
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export async function resolveMode(mode: BrowserMode): Promise<{ headless: boolean; display: Display | null }> {
  if (mode === 'headless') return { headless: true, display: null };
  if (process.platform === 'linux') {
    const display = await startXvfb();
    if (display) return { headless: false, display };
    if (mode === 'headful' && process.env.DISPLAY) return { headless: false, display: null };
    if (mode === 'headful') log.warn('headful browser requested but neither Xvfb nor DISPLAY is available; using headless');
    return { headless: true, display: null };
  }
  // macOS: a headful window would pop up on the user's screen, so only do it on request.
  return { headless: mode !== 'headful', display: null };
}

/**
 * Whether Chromium's process sandbox can start here. On Linux it needs unprivileged user
 * namespaces (blocked by AppArmor on Ubuntu 23.10+) or a root-owned setuid helper next to
 * the browser binary. A failed sandboxed launch leaves processes behind that break the
 * fallback launch on the same profile, so it is better not to try.
 */
export function sandboxSupported(executablePath: string): boolean {
  if (process.platform !== 'linux') return true;
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const helper = ['chrome_sandbox', 'chrome-sandbox'].map((name) => path.join(path.dirname(executablePath), name)).find((f) => fs.existsSync(f));
  if (helper) {
    const st = fs.statSync(helper);
    if (st.uid === 0 && (st.mode & 0o4000) !== 0) return true;
  }
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1') return false;
  if (read('/proc/sys/kernel/unprivileged_userns_clone') === '0') return false;
  if (read('/proc/sys/user/max_user_namespaces') === '0') return false;
  return true;
}

/**
 * Kills browser processes left over from an earlier host (crash, failed launch) that still use
 * our profile. Chrome hands new launches over to such a process and exits immediately.
 */
export async function killStaleBrowsers(profileDir: string) {
  const out = await new Promise<string>((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
  const needle = `--user-data-dir=${profileDir}`;
  const pids = out
    .split('\n')
    .filter((line) => line.includes(needle))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => pid && pid !== process.pid);
  if (!pids.length) return;
  log.warn(`stopping ${pids.length} leftover browser process(es) using the profile`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
