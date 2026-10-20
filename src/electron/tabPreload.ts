// Runs in every frame of a browser tab. Electron shows its own message boxes for alert/confirm and
// does not support prompt at all, and those boxes cannot be answered by the agent. Route the three
// dialog functions through the main process instead, which hands them to the host like Chrome would.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__bettercodexDialog', (type: string, message: unknown, defaultValue: unknown) =>
  ipcRenderer.sendSync('bc:dialog', {
    type,
    message: message === undefined ? '' : String(message),
    defaultValue: defaultValue == null ? '' : String(defaultValue),
  }),
);

contextBridge.executeInMainWorld({
  func: () => {
    const call = (window as any).__bettercodexDialog as (type: string, message?: unknown, defaultValue?: unknown) => unknown;
    const define = (name: string, fn: unknown) => Object.defineProperty(window, name, { value: fn, writable: true, configurable: true });
    define('alert', function alert(message?: unknown) {
      call('alert', message);
    });
    define('confirm', function confirm(message?: unknown) {
      return call('confirm', message) === true;
    });
    define('prompt', function prompt(message?: unknown, defaultValue?: unknown) {
      const answer = call('prompt', message, defaultValue);
      return typeof answer === 'string' ? answer : null;
    });
  },
});
