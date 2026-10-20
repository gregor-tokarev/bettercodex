import { app, net, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UpdateStatus } from '../shared/types.js';

const REPO = 'gregor-tokarev/bettercodex';
const CHECK_EVERY_MS = 30 * 60_000;

interface ReleaseAsset {
  name: string;
  size: number;
  /** "sha256:<hex>" */
  digest?: string | null;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { timeout: 300_000 }, (err, _stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()));
  });
}

/** The commit a CI build or release was made from: 0.0.1+660c757e94 and v0.0.1-660c757e94 both give 660c757e94. */
function commitOf(name: string) {
  return /[+-]([0-9a-f]{7,40})$/.exec(name)?.[1] ?? null;
}

/**
 * Keeps the app up to date from GitHub releases. Builds are ad-hoc signed and not notarized, which
 * Squirrel.Mac rejects, so the update is unpacked here and swapped in by a small shell script once the
 * app has quit. Nothing a browser downloads is involved, so macOS does not quarantine the new copy.
 */
export class Updater extends EventEmitter {
  status: UpdateStatus;
  private release: Release | null = null;
  /** The .app bundle (macOS) or AppImage (Linux) that is replaced in place. */
  private target: string | null = null;
  private logFile: string;
  private pendingFile: string;
  private commit: string | null;

  constructor(userData: string) {
    super();
    const version = app.getVersion();
    this.commit = commitOf(version);
    this.logFile = path.join(userData, 'update.log');
    this.pendingFile = path.join(userData, 'update-pending.json');
    this.status = {
      current: `v${version.replace('+', '-')}`,
      mode: 'off',
      note: null,
      state: 'idle',
      available: null,
      progress: null,
      error: null,
      checkedAt: null,
    };
    if (!app.isPackaged) {
      this.status.note = 'Development builds do not update themselves.';
    } else if (process.platform === 'darwin') {
      const bundle = path.resolve(process.execPath, '../../..');
      if (bundle.includes('/AppTranslocation/')) {
        this.status.mode = 'manual';
        this.status.note = 'macOS runs this copy from a temporary folder, so it cannot replace itself. Move BetterCodex to Applications and clear its quarantine flag (see the download page) to get in-app updates.';
      } else {
        this.status.mode = 'inPlace';
        this.target = bundle;
      }
    } else if (process.platform === 'linux' && process.env.APPIMAGE) {
      this.status.mode = 'inPlace';
      this.target = process.env.APPIMAGE;
    } else {
      this.status.mode = 'manual';
      this.status.note = 'This copy was installed from a package; new builds are on the download page.';
    }
    this.checkPreviousInstall();
  }

  /** Checks now and then periodically; call once the app is ready. */
  start() {
    if (this.status.mode === 'off') return;
    setTimeout(() => void this.check(), 10_000);
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  private set(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  /** An update that was handed to the install script but did not come up as this build. */
  private checkPreviousInstall() {
    let pending: { name?: string } | null = null;
    try {
      pending = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'));
      fs.rmSync(this.pendingFile, { force: true });
    } catch {
      return;
    }
    if (pending?.name && pending.name !== this.status.current) {
      this.status.error = `The update to ${pending.name} did not install. Details are in ${this.logFile}.`;
    }
  }

  async check(): Promise<UpdateStatus> {
    if (this.status.mode === 'off' || this.status.state !== 'idle') return this.status;
    this.set({ state: 'checking' });
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BetterCodex' },
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const release = (await res.json()) as Release;
      const latestCommit = commitOf(release.tag_name);
      const upToDate =
        release.tag_name === this.status.current || (!!this.commit && !!latestCommit && (latestCommit.startsWith(this.commit) || this.commit.startsWith(latestCommit)));
      this.release = upToDate ? null : release;
      this.set({
        state: this.settled(),
        checkedAt: Date.now(),
        error: null,
        available: upToDate
          ? null
          : {
              name: release.tag_name,
              url: release.html_url,
              compareUrl: this.commit && latestCommit ? `https://github.com/${REPO}/compare/${this.commit}...${latestCommit}` : null,
              publishedAt: release.published_at,
            },
      });
    } catch (err) {
      this.set({ state: this.settled(), error: `Could not check for updates: ${(err as Error).message}` });
    }
    return this.status;
  }

  /** The state once a check is done; an install may have started meanwhile. */
  private settled() {
    return this.status.state === 'checking' ? 'idle' : this.status.state;
  }

  /** Downloads the available release, puts it in place of this copy and restarts into it. */
  async install(): Promise<void> {
    const release = this.release;
    if (!release || this.status.state === 'downloading' || this.status.state === 'installing') return;
    if (this.status.mode !== 'inPlace' || !this.target) {
      await shell.openExternal(release.html_url);
      return;
    }
    try {
      if (process.platform === 'darwin') await this.installMac(release, this.target);
      else await this.installAppImage(release, this.target);
    } catch (err) {
      const message = `Update failed: ${(err as Error).message}`;
      this.set({ state: 'idle', progress: null, error: message });
      throw new Error(message);
    }
  }

  private asset(release: Release, suffix: string) {
    const asset = release.assets.find((a) => a.name.endsWith(suffix));
    if (!asset) throw new Error(`${release.tag_name} has no ${suffix.replace(/^-/, '')} build yet`);
    return asset;
  }

  private assertWritable(...paths: string[]) {
    for (const p of paths) {
      try {
        fs.accessSync(p, fs.constants.W_OK);
      } catch {
        throw new Error(`BetterCodex cannot write to ${p}. Move it somewhere you can write to, or install ${this.status.available?.name} from the download page.`);
      }
    }
  }

  private async installMac(release: Release, bundle: string) {
    const asset = this.asset(release, `-mac-${process.arch}.zip`);
    this.assertWritable(path.dirname(bundle), bundle);
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bettercodex-update-'));
    try {
      const zip = path.join(work, asset.name);
      await this.download(asset, zip);
      this.set({ state: 'installing', progress: null });
      const unpacked = path.join(work, 'unpacked');
      // ditto keeps the framework symlinks and code signatures intact.
      await run('ditto', ['-x', '-k', zip, unpacked]);
      await fs.promises.rm(zip, { force: true });
      const name = (await fs.promises.readdir(unpacked)).find((n) => n.endsWith('.app'));
      if (!name || !fs.existsSync(path.join(unpacked, name, 'Contents', 'MacOS'))) throw new Error('the download has no app in it');
      const next = path.join(unpacked, name);
      await run('xattr', ['-dr', 'com.apple.quarantine', next]).catch(() => {});
      // Swapping the bundle while the app runs would start helper processes from the new copy.
      this.relaunchInto(
        [
          'pid=$1 target=$2 next=$3 work=$4',
          'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
          'if mv "$target" "$work/previous.app"; then',
          '  mv "$next" "$target" || mv "$work/previous.app" "$target"',
          'fi',
          'open "$target"',
          'rm -rf "$work"',
        ],
        [bundle, next, work],
        release,
      );
    } catch (err) {
      await fs.promises.rm(work, { recursive: true, force: true });
      throw err;
    }
  }

  private async installAppImage(release: Release, appImage: string) {
    const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
    const asset = this.asset(release, `-linux-${arch}.AppImage`);
    this.assertWritable(path.dirname(appImage));
    // Next to the AppImage, so the rename below cannot cross file systems.
    const staged = path.join(path.dirname(appImage), `.${path.basename(appImage)}.update`);
    try {
      await this.download(asset, staged);
      this.set({ state: 'installing', progress: null });
      await fs.promises.chmod(staged, 0o755);
      // The running copy keeps its mounted image; the new file only takes over the path.
      await fs.promises.rename(staged, appImage);
    } catch (err) {
      await fs.promises.rm(staged, { force: true });
      throw err;
    }
    this.relaunchInto(
      ['pid=$1; shift', 'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done', 'exec "$@"'],
      [appImage, ...process.argv.filter((a) => a === '--no-sandbox')],
      release,
    );
  }

  private async download(asset: ReleaseAsset, file: string) {
    this.set({ state: 'downloading', progress: 0, error: null });
    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
    const hash = crypto.createHash('sha256');
    const out = await fs.promises.open(file, 'w');
    let received = 0;
    let reported = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await out.write(value);
        received += value.length;
        if (received - reported >= asset.size / 100) {
          reported = received;
          this.set({ progress: Math.min(received / asset.size, 1) });
        }
      }
    } finally {
      await out.close();
    }
    if (received !== asset.size) throw new Error(`download stopped at ${received} of ${asset.size} bytes`);
    const expected = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
    if (expected && hash.digest('hex') !== expected) throw new Error('the download is corrupted (checksum mismatch)');
  }

  /** Starts `script` detached with this process's pid as $1, then quits so it can take over. */
  private relaunchInto(script: string[], args: string[], release: Release) {
    fs.writeFileSync(this.pendingFile, JSON.stringify({ name: release.tag_name }));
    const log = fs.openSync(this.logFile, 'w');
    spawn('/bin/sh', ['-c', script.join('\n'), 'bettercodex-update', String(process.pid), ...args], { detached: true, stdio: ['ignore', log, log] }).unref();
    fs.closeSync(log);
    app.quit();
    // Quitting can hang on a stuck window; the script waits for this process to be gone.
    setTimeout(() => app.exit(0), 5000).unref();
  }
}
