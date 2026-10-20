import { useEffect } from 'react';
import { BrowserPanel } from './components/BrowserPanel';
import { ScheduledView, TaskEditor } from './components/Scheduled';
import { Settings } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import { ThreadView } from './components/ThreadView';
import { getState, openThread, setPrefs, setState, useStore } from './lib/store';
import { bc, isMac } from './lib/bridge';

export function App() {
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const browserOpen = useStore((s) => s.prefs.browserOpen);
  const toastMsg = useStore((s) => s.toast);
  const theme = useStore((s) => s.prefs.theme);

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const sel = getState().selection;
      if (e.key.toLowerCase() === 'n' && sel) {
        e.preventDefault();
        void openThread(sel.hostId, null);
      } else if (e.key.toLowerCase() === 'b' && e.shiftKey) {
        e.preventDefault();
        setPrefs({ browserOpen: !getState().prefs.browserOpen });
      } else if (e.key === ',') {
        e.preventDefault();
        setState({ settingsOpen: true });
      }
    };
    window.addEventListener('keydown', onKey);
    // Shortcuts pressed while a native browser tab has focus arrive from the main process.
    const off = bc.onShortcut(({ key, shift }) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, ctrlKey: !isMac, metaKey: isMac }));
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view === 'scheduled' ? (
          <ScheduledView />
        ) : selection ? (
          <ThreadView key={`${selection.hostId}:${selection.threadId ?? 'draft'}`} hostId={selection.hostId} threadId={selection.threadId} />
        ) : (
          <div className="center-note">Starting…</div>
        )}
      </main>
      {selection && browserOpen && view === 'thread' && <BrowserPanel selection={selection} />}
      <Settings />
      <TaskEditor />
      {toastMsg && <div className="toast" onClick={() => setState({ toast: null })}>{toastMsg}</div>}
    </div>
  );
}
