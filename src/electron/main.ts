import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { HostManager, type HostEntry } from './hosts.js';

const distDir = path.resolve(__dirname, '..');
app.setName('BetterCodex');

// Packaged builds keep the host outside app.asar so it can be run by node and copied over SSH.
const hostBundleDir = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(distDir, 'host');
const hosts = new HostManager(app.getPath('userData'), hostBundleDir);
let win: BrowserWindow | null = null;

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
  win.loadFile(path.join(distDir, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('closed', () => {
    win = null;
  });
}

function send(channel: string, payload: unknown) {
  win?.webContents.send(channel, payload);
}

hosts.on('status', (status) => send('hosts:status', status));
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
ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));

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
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The host daemons keep running (threads and the browser live there); only tunnels close.
app.on('before-quit', () => hosts.dispose());
