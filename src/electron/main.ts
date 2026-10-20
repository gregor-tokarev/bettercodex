import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { nextZoom } from '../shared/browserKeys.js';
import type { AppBrowserRegistration, PageViewRef } from '../shared/types.js';
import { AppBrowser } from './appBrowser.js';
import { HostManager, type HostEntry } from './hosts.js';
import { ReplicaManager } from './replicas.js';
import { ViewStage, type Rect } from './stage.js';
import { fetchSuggestions } from './suggest.js';
import { Updater } from './updater.js';

const distDir = path.resolve(__dirname, '..');

// Electron's default is a blocking error box, which on quit can keep the app from ever exiting.
process.on('uncaughtException', (err) => console.error('uncaught exception in the main process:', err));
app.setName('BetterCodex');
if (process.env.BETTERCODEX_USER_DATA) app.setPath('userData', process.env.BETTERCODEX_USER_DATA);

/** Started by a host that needs this machine's browser while no BetterCodex window is open. */
let background = process.argv.includes('--bc-background');
const display = process.platform === 'linux' ? (process.env.WAYLAND_DISPLAY ? `wayland:${process.env.WAYLAND_DISPLAY}` : (process.env.DISPLAY ?? '')) : '';
const userData = app.getPath('userData');
const instanceFile = path.join(userData, 'instance.json');
const hostFromEnv = process.env.BC_HOST_PORT && process.env.BC_HOST_TOKEN ? { port: Number(process.env.BC_HOST_PORT), token: process.env.BC_HOST_TOKEN } : null;
delete process.env.BC_HOST_PORT;
delete process.env.BC_HOST_TOKEN;

if (app.requestSingleInstanceLock({ display, background, host: hostFromEnv })) {
  // The browser tabs are driven over CDP; AppBrowser only lets hosts see the tab targets.
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  fs.rmSync(path.join(userData, 'DevToolsActivePort'), { force: true });
  boot();
} else {
  stepAside();
}

/** Another copy holds the profile. */
function stepAside() {
  let other: { pid?: number; background?: boolean; display?: string } = {};
  try {
    other = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
  } catch {
    // unknown
  }
  // A background copy on another (virtual) display quits when it hears from us; start over once it is gone.
  if (!background && other.background && process.platform === 'linux' && other.display !== display && other.pid) {
    void waitForExit(other.pid, 20000).then(() => {
      app.relaunch();
      app.exit(0);
    });
    return;
  }
  app.exit(0);
}

function boot() {
  const writeInstance = () => fs.writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, background, display }));
  fs.mkdirSync(userData, { recursive: true });
  writeInstance();

  // Packaged builds keep the host outside app.asar so it can be run by node and copied over SSH.
  const hostBundleDir = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(distDir, 'host');
  const launch = {
    exec: process.execPath,
    args: [...(app.isPackaged ? [] : [app.getAppPath()]), ...process.argv.filter((a) => a === '--no-sandbox')],
  };
  const hosts = new HostManager(userData, hostBundleDir, { BETTERCODEX_APP: JSON.stringify(launch) });
  let win: BrowserWindow | null = null;
  // One place for page views: this machine's tabs and synced copies of other machines' tabs.
  const stage = new ViewStage();
  const appBrowser = new AppBrowser(stage, path.join(__dirname, 'tabPreload.cjs'), () => win);
  const replicas = new ReplicaManager(stage, hosts, path.join(__dirname, 'replicaPreload.cjs'), () => win);
  const endpoints = new Map<number, { port: number; token: string }>();

  /** Offers this app's tabs to a host on this machine as its browser. */
  const register = async (endpoint: { port: number; token: string }) => {
    endpoints.set(endpoint.port, endpoint);
    await appBrowser.ready;
    const registration: AppBrowserRegistration = {
      url: appBrowser.url,
      instanceId: appBrowser.instanceId,
      pid: process.pid,
      launch,
      background,
      sandboxed: !app.commandLine.hasSwitch('no-sandbox'),
    };
    const body = JSON.stringify(registration);
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: endpoint.port,
          method: 'POST',
          path: '/app-browser',
          headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', () => resolve());
      req.end(body);
    });
  };

  function createWindow() {
    win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 760,
      minHeight: 500,
      title: 'BetterCodex',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 14, y: 14 },
      autoHideMenuBar: process.platform !== 'darwin',
      icon: path.join(distDir, 'renderer', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
      },
    });
    const current = win;
    current.loadFile(path.join(distDir, 'renderer', 'index.html'));
    current.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    current.webContents.on('will-navigate', (event) => event.preventDefault());
    current.on('closed', () => {
      stage.windowClosed(current);
      if (win === current) win = null;
      // The hidden tab window keeps Electron from emitting window-all-closed.
      if (process.platform !== 'darwin') app.quit();
    });
  }

  /** A background copy becomes the normal app when the user opens BetterCodex. */
  function becomeInteractive() {
    background = false;
    writeInstance();
    if (process.platform === 'darwin') app.setActivationPolicy('regular');
    createWindow();
    for (const endpoint of endpoints.values()) void register(endpoint);
  }

  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    const data = additionalData as { display?: string; background?: boolean; host?: { port: number; token: string } | null } | undefined;
    if (data?.host) void register(data.host);
    if (data?.background) return;
    if (background) {
      if (process.platform === 'linux' && data?.display !== display) {
        app.quit();
        return;
      }
      becomeInteractive();
      return;
    }
    if (!win) createWindow();
    else {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // A background copy goes away once no host has needed it for a while.
  let idleTimer: NodeJS.Timeout | null = null;
  const checkIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (background && appBrowser.clientCount === 0) idleTimer = setTimeout(() => background && appBrowser.clientCount === 0 && app.quit(), 120_000);
  };
  appBrowser.on('clients', checkIdle);

  function send(channel: string, payload: unknown) {
    win?.webContents.send(channel, payload);
  }

  hosts.on('status', (status) => {
    send('hosts:status', status);
    const entry = hosts.hosts.find((h) => h.id === status.id);
    if (entry?.type === 'local' && status.state === 'connected' && status.endpoint) void register(status.endpoint);
  });
  hosts.on('changed', () => send('hosts:changed', hosts.list()));

  ipcMain.handle('hosts:list', () => hosts.list());
  ipcMain.handle('hosts:connect', (_e, id: string) => hosts.connect(id));
  ipcMain.handle('hosts:verify', (_e, id: string) => hosts.verify(id));
  ipcMain.handle('hosts:disconnect', (_e, id: string) => hosts.disconnect(id));
  ipcMain.handle('hosts:add', (_e, entry: Omit<HostEntry, 'id'>) => hosts.add(entry));
  ipcMain.handle('hosts:update', (_e, id: string, patch: Partial<HostEntry>) => hosts.update(id, patch));
  ipcMain.handle('hosts:remove', (_e, id: string) => hosts.remove(id));

  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^(https?|mailto):/.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion(), instanceId: appBrowser.instanceId }));

  const updater = new Updater(userData);
  updater.on('status', (status) => send('updates:status', status));
  ipcMain.handle('updates:status', () => updater.status);
  ipcMain.handle('updates:check', () => updater.check());
  ipcMain.handle('updates:install', () => updater.install());
  ipcMain.handle('updates:restart', () => updater.restart());

  ipcMain.handle('appBrowser:show', (e, targetId: string | null, bounds: Rect | null) => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    return owner ? appBrowser.show(owner, targetId, bounds) : false;
  });
  ipcMain.handle('appBrowser:capture', (_e, targetId: string) => appBrowser.capture(targetId));

  ipcMain.handle('replica:show', (e, hostId: string, tabId: string, bounds: Rect | null, sameMachine: boolean) => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    return owner ? replicas.show(owner, hostId, tabId, bounds, sameMachine) : false;
  });
  ipcMain.handle('replica:capture', (_e, hostId: string, tabId: string) => replicas.capture(hostId, tabId));
  ipcMain.handle('replica:reload', (_e, hostId: string, tabId: string) => replicas.reload(hostId, tabId));
  ipcMain.handle('replica:status', (_e, hostId: string, tabId: string) => replicas.statusOf(hostId, tabId));
  replicas.on('status', (status) => send('replica:status', status));

  // The browser panel's find bar, zoom and focus act on the page view it shows.
  const pageOf = (view: PageViewRef) => ('targetId' in view ? appBrowser.contentsFor(view.targetId) : replicas.contents(view.hostId, view.tabId));
  ipcMain.handle('pageView:find', (_e, view: PageViewRef, text: string, opts: { forward?: boolean; again?: boolean }) => {
    const wc = pageOf(view);
    if (!wc) return null;
    if (!text) {
      wc.stopFindInPage('clearSelection');
      return null;
    }
    // Electron's `findNext` starts a new search; stepping through the matches of one leaves it off.
    return wc.findInPage(text, { forward: opts?.forward ?? true, findNext: !opts?.again });
  });
  ipcMain.handle('pageView:stopFind', (_e, view: PageViewRef) => pageOf(view)?.stopFindInPage('clearSelection'));
  /** Changes the zoom by `step` (0 resets it) or just reports it. */
  ipcMain.handle('pageView:zoom', (_e, view: PageViewRef, step?: 1 | -1 | 0) => {
    const wc = pageOf(view);
    if (!wc) return 1;
    if (step !== undefined) wc.setZoomFactor(nextZoom(wc.getZoomFactor(), step));
    return wc.getZoomFactor();
  });
  ipcMain.handle('pageView:focus', (_e, view: PageViewRef) => pageOf(view)?.focus());
  ipcMain.handle('suggest:query', (_e, text: string) => fetchSuggestions(text));

  /** Lets the user pick local files and copies them to the host, returning host-side paths. */
  ipcMain.handle('files:pickAndUpload', async (_e, hostId: string, opts: { multiple?: boolean; images?: boolean }) => {
    const result = await dialog.showOpenDialog(win!, {
      properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: opts.images ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] : undefined,
    });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map((file) => uploadToHost(hostId, path.basename(file), fs.readFileSync(file))));
  });

  /** Reads a file from a host for display (screenshots, attached images); the renderer cannot send auth headers cross-origin. */
  ipcMain.handle('files:read', (_e, hostId: string, file: string) => {
    const status = hosts.status(hostId);
    if (!status.endpoint) throw new Error('Host is not connected');
    const { port, token } = status.endpoint;
    return new Promise<{ data: Uint8Array; mime: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: `/file?path=${encodeURIComponent(file)}`, headers: { Authorization: `Bearer ${token}` } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
            else resolve({ data: new Uint8Array(Buffer.concat(chunks)), mime: String(res.headers['content-type'] ?? 'application/octet-stream') });
          });
          res.on('error', reject);
        })
        .on('error', reject);
    });
  });

  ipcMain.handle('files:upload', (_e, hostId: string, name: string, data: Uint8Array) => uploadToHost(hostId, name, Buffer.from(data)));

  function uploadToHost(hostId: string, name: string, data: Buffer): Promise<string> {
    const status = hosts.status(hostId);
    if (!status.endpoint) return Promise.reject(new Error('Host is not connected'));
    const { port, token } = status.endpoint;
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: `/upload?name=${encodeURIComponent(name)}`, headers: { Authorization: `Bearer ${token}`, 'Content-Length': data.length } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body).path);
            } catch {
              reject(new Error(body));
            }
          });
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  }

  app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          // No Reload items: Cmd+R reloads the page in the browser panel, not the app.
          {
            label: 'View',
            submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
          },
          { role: 'windowMenu' },
        ]),
      );
    }
    if (background) {
      if (process.platform === 'darwin') app.setActivationPolicy('accessory');
      checkIdle();
    } else {
      createWindow();
    }
    if (hostFromEnv) void register(hostFromEnv);
    updater.start();
    appBrowser.ready.catch((err) => console.error('browser bridge failed to start:', err));
    app.on('activate', () => {
      if (!win) {
        if (background) becomeInteractive();
        else createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // The host daemons keep running (threads live there); only tunnels close.
  app.on('before-quit', () => hosts.dispose());
  app.on('will-quit', () => updater.discard());
}

async function waitForExit(pid: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
