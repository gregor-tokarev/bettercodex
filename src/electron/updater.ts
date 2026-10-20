import { app, net, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
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
  /** A downloaded update waiting for the restart that applies it. */
  private staged: { apply: () => void; discard: () => void } | null = null;
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
      installError: null,
      checkedAt: null,
    };
    if (!app.isPackaged) {
      this.status.note = 'Development builds do not update themselves.';
    } else if (!this.commit) {
      // Without the commit there is no telling whether a release is newer than this build.
      this.status.note = 'Builds made outside the release pipeline do not update themselves.';
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
    this.removeLeftovers();
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
      this.status.installError = `The update to ${pending.name} did not install. Details are in ${this.logFile}.`;
    }
  }

  /** Staging space from an update that never got applied (the app quit or crashed first). */
  private stagingPaths() {
    if (!this.target) return { dir: null, prefix: '' };
    const dir = path.dirname(this.target);
    const name = path.basename(this.target);
    return { dir, prefix: process.platform === 'darwin' ? `.${name.replace(/\.app$/, '')}-update-` : `.${name}.update` };
  }

  private removeLeftovers() {
    const { dir, prefix } = this.stagingPaths();
    if (!dir) return;
    fs.promises
      .readdir(dir)
      .then((names) => Promise.all(names.filter((n) => n.startsWith(prefix)).map((n) => fs.promises.rm(path.join(dir, n), { recursive: true, force: true }))))
      .catch(() => {});
  }

  private async github<T>(endpoint: string): Promise<T> {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BetterCodex' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return (await res.json()) as T;
  }

  async check(): Promise<UpdateStatus> {
    if (this.status.mode === 'off' || this.status.state !== 'idle') return this.status;
    this.set({ state: 'checking' });
    try {
      const release = await this.github<Release>('releases/latest');
      const latestCommit = commitOf(release.tag_name);
      let newer = false;
      if (latestCommit && !latestCommit.startsWith(this.commit!) && !this.commit!.startsWith(latestCommit)) {
        // Only builds of later commits count; a diverged main (rewritten history) moves to the release too.
        const { status } = await this.github<{ status: string }>(`compare/${this.commit}...${latestCommit}?per_page=1`);
        newer = status === 'ahead' || status === 'diverged';
      }
      this.release = newer ? release : null;
      this.set({
        state: this.settled(),
        checkedAt: Date.now(),
        error: null,
        available: newer
          ? {
              name: release.tag_name,
              url: release.html_url,
              compareUrl: `https://github.com/${REPO}/compare/${this.commit}...${latestCommit}`,
              publishedAt: release.published_at,
            }
          : null,
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

  /**
   * Downloads the available release and gets it ready to replace this copy; `restart` applies it.
   * Copies that cannot replace themselves get the download page instead.
   */
  async install(): Promise<UpdateStatus> {
    const release = this.release;
    if (!release || this.status.state === 'downloading' || this.status.state === 'installing' || this.status.state === 'ready') return this.status;
    if (this.status.mode !== 'inPlace' || !this.target) {
      await shell.openExternal(release.html_url);
      return this.status;
    }
    try {
      this.staged = process.platform === 'darwin' ? await this.prepareMac(release, this.target) : await this.prepareAppImage(release, this.target);
      this.set({ state: 'ready', progress: null, installError: null });
    } catch (err) {
      const message = `Update failed: ${(err as Error).message}`;
      this.set({ state: 'idle', progress: null, installError: message });
      throw new Error(message);
    }
    return this.status;
  }

  /** Quits and starts the downloaded update in place of this copy. */
  restart() {
    const staged = this.staged;
    if (!staged) return;
    this.staged = null;
    try {
      staged.apply();
    } catch (err) {
      staged.discard();
      const message = `Update failed: ${(err as Error).message}`;
      this.set({ state: 'idle', installError: message });
      throw new Error(message);
    }
  }

  /** Drops a downloaded update that was not applied; call when the app quits. */
  discard() {
    this.staged?.discard();
    this.staged = null;
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

  private async prepareMac(release: Release, bundle: string) {
    const asset = this.asset(release, `-mac-${process.arch}.zip`);
    this.assertWritable(path.dirname(bundle), bundle);
    // Next to the installed app, so every move of the swap is a rename on one file system.
    const { dir, prefix } = this.stagingPaths();
    const work = await fs.promises.mkdtemp(path.join(dir!, prefix));
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
      return {
        // Swapping the bundle while the app runs would start helper processes from the new copy. The
        // backup is only deleted once the app at `target` is whole again.
        apply: () =>
          this.relaunchInto(
            [
              'pid=$1 target=$2 next=$3 work=$4',
              'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
              'if ! mv "$target" "$work/previous.app"; then',
              '  rm -rf "$work"',
              'elif mv "$next" "$target" || { rm -rf "$target"; mv "$work/previous.app" "$target"; }; then',
              '  rm -rf "$work"',
              'fi',
              'open "$target"',
            ],
            [bundle, next, work],
            release,
          ),
        discard: () => fs.rmSync(work, { recursive: true, force: true }),
      };
    } catch (err) {
      await fs.promises.rm(work, { recursive: true, force: true });
      throw err;
    }
  }

  private async prepareAppImage(release: Release, appImage: string) {
    const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
    const asset = this.asset(release, `-linux-${arch}.AppImage`);
    this.assertWritable(path.dirname(appImage));
    // Next to the AppImage, so the rename below cannot cross file systems.
    const { dir, prefix } = this.stagingPaths();
    const staged = path.join(dir!, prefix);
    try {
      await this.download(asset, staged);
      await fs.promises.chmod(staged, 0o755);
    } catch (err) {
      await fs.promises.rm(staged, { force: true });
      throw err;
    }
    return {
      apply: () => {
        // The running copy keeps its mounted image; the new file only takes over the path.
        fs.renameSync(staged, appImage);
        this.relaunchInto(
          ['pid=$1; shift', 'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done', 'exec "$@"'],
          [appImage, ...process.argv.filter((a) => a === '--no-sandbox')],
          release,
        );
      },
      discard: () => fs.rmSync(staged, { force: true }),
    };
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
        // A write may take only part of the chunk.
        for (let offset = 0; offset < value.length; ) {
          const { bytesWritten } = await out.write(value, offset, value.length - offset);
          if (bytesWritten === 0) throw new Error('could not write the download to disk');
          offset += bytesWritten;
        }
        received += value.length;
        if (received - reported >= asset.size / 100) {
          reported = received;
          this.set({ progress: Math.min(received / asset.size, 1) });
        }
      }
    } finally {
      await out.close();
    }
    const written = (await fs.promises.stat(file)).size;
    if (received !== asset.size || written !== asset.size) throw new Error(`download stopped at ${written} of ${asset.size} bytes`);
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
