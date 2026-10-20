// Runs in every frame of a synced copy of another machine's tab.
import { contextBridge, ipcRenderer } from 'electron';
import { installSyncRecorder } from '../shared/syncPage';

// The recorder lives in this isolated world: page scripts cannot see it or feed it fake actions.
installSyncRecorder((json) => ipcRenderer.send('bc:sync-record', json), true);

// localStorage of the other machine is in place before the page's own scripts run.
const seed = ipcRenderer.sendSync('bc:replica-seed', location.origin) as Record<string, string> | null;
if (seed) {
  contextBridge.executeInMainWorld({
    func: (items: Record<string, string>) => {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key !== null && !(key in items)) localStorage.removeItem(key);
        }
        for (const [key, value] of Object.entries(items)) if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
      } catch {
        // storage disabled for this origin
      }
    },
    args: [seed],
  });
}

// Dialogs belong to the other machine, which shows them when the same action arrives there. The
// copy answers its own right away so it never blocks.
contextBridge.executeInMainWorld({
  func: () => {
    const define = (name: string, fn: unknown) => Object.defineProperty(window, name, { value: fn, writable: true, configurable: true });
    define('alert', function alert() {});
    define('confirm', function confirm() {
      return true;
    });
    define('prompt', function prompt(_message?: unknown, defaultValue?: unknown) {
      return defaultValue == null ? '' : String(defaultValue);
    });
  },
});
