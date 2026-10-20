import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TabInfo } from '../../shared/types';
import { bc, type ReplicaStatus } from '../lib/bridge';
import type { HostConnection } from '../lib/connection';
import { Spinner } from './Icons';

type Bounds = { x: number; y: number; width: number; height: number };

/** Elements drawn over the panel; native views sit above all page content, so they step aside for them. */
const OVERLAYS = '.popover, .modal-backdrop';

function covered(rect: DOMRect) {
  for (const el of document.querySelectorAll(OVERLAYS)) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height && r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) return true;
  }
  return false;
}

/**
 * Places a native page view (rendered by this app, not streamed) over this element and keeps it
 * there as the layout changes. Menus and dialogs above the panel get a still picture instead.
 */
function NativeSurface({
  surface,
  show,
  capture,
  children,
}: {
  /** Identifies the view; null while there is none to show. */
  surface: string | null;
  show: (bounds: Bounds | null) => Promise<boolean>;
  capture: () => Promise<string | null>;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [backdrop, setBackdrop] = useState<string | null>(null);

  useEffect(() => {
    if (!surface) return;
    let alive = true;
    let last = '';
    let frame = 0;
    const loop = () => {
      if (!alive) return;
      const el = box.current;
      if (el) {
        const r = el.getBoundingClientRect();
        // While the panel edge is dragged the pointer must stay with the page UI, not the native view.
        const hide = covered(r) || r.width < 2 || r.height < 2 || document.body.classList.contains('resizing');
        const key = hide ? 'hidden' : `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
        if (key !== last) {
          const wasShown = last !== '' && last !== 'hidden';
          last = key;
          if (hide) {
            const snap = wasShown ? capture().catch(() => null) : Promise.resolve(null);
            void snap.then((url) => {
              if (!alive || last !== 'hidden') return;
              if (url) setBackdrop(url);
              void show(null);
            });
          } else {
            void show({ x: r.left, y: r.top, width: r.width, height: r.height });
            setBackdrop(null);
          }
        }
      }
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      void show(null);
    };
  }, [surface]);

  return (
    <div className="viewport native" ref={box}>
      {backdrop && <img className="viewport-backdrop" src={backdrop} alt="" />}
      {children}
    </div>
  );
}

/** A tab of this app's own browser (the machine the app runs on). */
export function NativeViewport({ connection, tab }: { connection: HostConnection; tab: TabInfo }) {
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);

  const wake = () => {
    setError(null);
    setWaking(true);
    connection
      .rpc('browser/tabs/wake', { tabId: tab.id })
      .catch((err: Error) => setError(err.message))
      .finally(() => setWaking(false));
  };
  // Opening a sleeping tab brings its page back. A tab that falls asleep while shown (its browser
  // went away) waits for a click, so a closing app is not started again behind the user's back.
  useEffect(() => {
    if (tab.sleeping) wake();
  }, [tab.id]);

  const targetId = tab.targetId ?? null;
  return (
    <NativeSurface surface={targetId} show={(b) => bc.appBrowser.show(targetId, b)} capture={() => (targetId ? bc.appBrowser.capture(targetId) : Promise.resolve(null))}>
      {tab.sleeping && !waking && !error ? (
        <div className="viewport-overlay interactive">
          <button className="btn" onClick={wake}>
            Reload tab
          </button>
        </div>
      ) : (
        !targetId &&
        !error && (
          <div className="viewport-overlay">
            <Spinner /> Loading page…
          </div>
        )
      )}
      {error && <div className="viewport-overlay">{error}</div>}
    </NativeSurface>
  );
}

export function useReplicaStatus(hostId: string, tabId: string) {
  const [status, setStatus] = useState<ReplicaStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    let alive = true;
    void bc.replica.status(hostId, tabId).then((s) => alive && s && setStatus(s));
    const off = bc.replica.onStatus((s) => {
      if (s.hostId === hostId && s.tabId === tabId) setStatus({ status: s.status, error: s.error, pending: s.pending, unreachable: s.unreachable });
    });
    return () => {
      alive = false;
      off();
    };
  }, [hostId, tabId]);
  return status;
}

/**
 * A tab of another machine, rendered here as a synced copy: what is done in it is replayed on
 * that machine, and what happens there (the agent, mostly) comes back the same way.
 */
export function ReplicaViewport({ hostId, tab, hostName, sameMachine }: { hostId: string; tab: TabInfo; hostName: string; sameMachine: boolean }) {
  const status = useReplicaStatus(hostId, tab.id);
  const gone = status?.status === 'gone';
  return (
    <NativeSurface
      surface={gone ? null : `${hostId}/${tab.id}`}
      show={(b) => bc.replica.show(hostId, tab.id, b, sameMachine)}
      capture={() => bc.replica.capture(hostId, tab.id)}
    >
      {gone ? (
        <div className="viewport-overlay interactive column">
          <div>{status?.error ?? `This tab is not open on ${hostName}.`}</div>
          <button className="btn" onClick={() => void bc.replica.reload(hostId, tab.id)}>
            Reload tab
          </button>
        </div>
      ) : (
        <div className="viewport-overlay">
          <Spinner /> Loading page…
        </div>
      )}
    </NativeSurface>
  );
}
