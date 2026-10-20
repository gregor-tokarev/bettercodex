import { contextBridge, ipcRenderer } from 'electron';

const on = (channel: string) => (cb: (payload: any) => void) => {
  const listener = (_e: unknown, payload: any) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('bc', {
  hosts: {
    list: () => ipcRenderer.invoke('hosts:list'),
    connect: (id: string) => ipcRenderer.invoke('hosts:connect', id),
    verify: (id: string) => ipcRenderer.invoke('hosts:verify', id),
    disconnect: (id: string) => ipcRenderer.invoke('hosts:disconnect', id),
    add: (entry: unknown) => ipcRenderer.invoke('hosts:add', entry),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('hosts:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('hosts:remove', id),
    onStatus: on('hosts:status'),
    onChanged: on('hosts:changed'),
  },
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  },
  files: {
    pickAndUpload: (hostId: string, opts: { multiple?: boolean; images?: boolean }) => ipcRenderer.invoke('files:pickAndUpload', hostId, opts),
    upload: (hostId: string, name: string, data: Uint8Array) => ipcRenderer.invoke('files:upload', hostId, name, data),
    read: (hostId: string, file: string) => ipcRenderer.invoke('files:read', hostId, file),
  },
  appBrowser: {
    show: (targetId: string | null, bounds: { x: number; y: number; width: number; height: number } | null) => ipcRenderer.invoke('appBrowser:show', targetId, bounds),
    capture: (targetId: string) => ipcRenderer.invoke('appBrowser:capture', targetId),
  },
  replica: {
    show: (hostId: string, tabId: string, bounds: { x: number; y: number; width: number; height: number } | null, sameMachine?: boolean) =>
      ipcRenderer.invoke('replica:show', hostId, tabId, bounds, !!sameMachine),
    capture: (hostId: string, tabId: string) => ipcRenderer.invoke('replica:capture', hostId, tabId),
    reload: (hostId: string, tabId: string) => ipcRenderer.invoke('replica:reload', hostId, tabId),
    status: (hostId: string, tabId: string) => ipcRenderer.invoke('replica:status', hostId, tabId),
    onStatus: on('replica:status'),
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    restart: () => ipcRenderer.invoke('updates:restart'),
    onStatus: on('updates:status'),
  },
  pageView: {
    find: (view: unknown, text: string, opts: { forward?: boolean; again?: boolean }) => ipcRenderer.invoke('pageView:find', view, text, opts),
    stopFind: (view: unknown) => ipcRenderer.invoke('pageView:stopFind', view),
    zoom: (view: unknown, step?: number) => ipcRenderer.invoke('pageView:zoom', view, step),
    focus: (view: unknown) => ipcRenderer.invoke('pageView:focus', view),
    onFound: on('pageView:found'),
    onZoomed: on('pageView:zoomed'),
  },
  suggest: (text: string) => ipcRenderer.invoke('suggest:query', text),
  onBrowserAction: on('browser:action'),
  onShortcut: on('app:shortcut'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
});
