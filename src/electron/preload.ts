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
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
});
