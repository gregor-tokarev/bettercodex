import { useEffect, useRef, useState } from 'react';
import type { FrameHeader, StreamClientMessage, StreamHostMessage } from '../../shared/types';
import { browserAction } from '../../shared/browserKeys';
import { bc, isMac } from '../lib/bridge';
import type { HostConnection } from '../lib/connection';
import { Spinner } from './Icons';

function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'] as const;

/**
 * Live view of one remote tab: draws screencast frames on a canvas and forwards
 * mouse, wheel, keyboard, IME and clipboard input to the host's browser.
 */
/** The smallest viewport the host gives a streamed page; zoom stops where the panel would need less. */
const MIN_VIEWPORT = { width: 240, height: 200 };

/** The largest zoom a panel of this size can show (zooming shrinks the page's viewport). */
export function maxStreamZoom(width: number, height: number) {
  return Math.min(width / MIN_VIEWPORT.width, height / MIN_VIEWPORT.height);
}

/**
 * `zoom` makes the page larger the way browser zoom does: its viewport gets smaller and is shown
 * scaled up. `onMaxZoom` reports how far that can go in the panel's current size.
 */
export function BrowserViewport({
  connection,
  tabId,
  hostPlatform,
  zoom = 1,
  onMaxZoom,
}: {
  connection: HostConnection;
  tabId: string;
  hostPlatform: string;
  zoom?: number;
  onMaxZoom?: (max: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const frame = useRef<{ cssWidth: number; cssHeight: number; rect: { x: number; y: number; w: number; h: number } } | null>(null);
  const held = useRef(new Set<string>());
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A Mac keyboard driving a Linux browser: Cmd shortcuts become Ctrl shortcuts.
  const mapMeta = isMac && hostPlatform !== 'darwin';

  const send = (msg: StreamClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  };

  // stream socket lifetime follows the connection; re-attaches on tab change
  useEffect(() => {
    setReady(false);
    setError(null);
    const socket = new WebSocket(connection.streamUrl, connection.protocols);
    socket.binaryType = 'arraybuffer';
    ws.current = socket;
    let decoding = false;
    let queued: ArrayBuffer | null = null;

    const draw = async (data: ArrayBuffer) => {
      decoding = true;
      try {
        const view = new DataView(data);
        const len = view.getUint32(0, true);
        const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, len))) as FrameHeader;
        if (header.tabId !== tabId) return;
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(data, 4 + len)], { type: 'image/jpeg' }));
        const cv = canvas.current;
        const box = container.current;
        if (!cv || !box) return;
        const dpr = window.devicePixelRatio || 1;
        const W = box.clientWidth;
        const H = box.clientHeight;
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
          cv.width = Math.round(W * dpr);
          cv.height = Math.round(H * dpr);
        }
        // Fit the remote viewport into the panel, preserving its aspect ratio.
        const scale = Math.min(W / header.cssWidth, H / header.cssHeight, 4);
        const w = header.cssWidth * scale;
        const h = header.cssHeight * scale;
        const rect = { x: (W - w) / 2, y: 0, w, h };
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = getComputedStyle(cv).backgroundColor || '#111';
        ctx.fillRect(0, 0, W, H);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h);
        bitmap.close();
        frame.current = { cssWidth: header.cssWidth, cssHeight: header.cssHeight, rect };
        setReady(true);
        setError(null);
      } catch {
        // ignore a broken frame
      } finally {
        decoding = false;
        if (queued) {
          const next = queued;
          queued = null;
          void draw(next);
        }
      }
    };

    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const attach = () => {
      const box = container.current;
      const width = box?.clientWidth ?? 1000;
      const height = box?.clientHeight ?? 700;
      const z = Math.min(zoomRef.current, maxStreamZoom(width, height));
      send({ t: 'attach', tabId, width: width / z, height: height / z });
    };
    socket.onopen = attach;
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (decoding) queued = event.data;
        else void draw(event.data);
        return;
      }
      const msg = JSON.parse(event.data) as StreamHostMessage;
      if (msg.t === 'cursor' && canvas.current) canvas.current.style.cursor = msg.cursor;
      if (msg.t === 'clipboard') void bc.clipboard.write(msg.text);
      if (msg.t === 'error') {
        setError(msg.message);
        // The browser may just be restarting; the tab itself is removed from the panel if it is gone.
        clearTimeout(retry);
        retry = setTimeout(attach, 1500);
      }
    };
    socket.onclose = () => {
      setReady(false);
      if (!closed) setError('Connection to the browser stream closed');
    };
    return () => {
      closed = true;
      clearTimeout(retry);
      releaseAll();
      socket.close();
    };
  }, [connection, tabId]);

  // keep the remote viewport the size of the panel (divided by the zoom)
  useEffect(() => {
    const box = container.current;
    if (!box) return;
    let timer: ReturnType<typeof setTimeout>;
    const resize = () => {
      const max = maxStreamZoom(box.clientWidth, box.clientHeight);
      onMaxZoom?.(max);
      const z = Math.min(zoomRef.current, max);
      send({ t: 'resize', width: Math.floor(box.clientWidth / z), height: Math.floor(box.clientHeight / z) });
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(resize, 120);
    });
    observer.observe(box);
    resize();
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [tabId, zoom]);

  const toRemote = (e: { clientX: number; clientY: number }) => {
    const f = frame.current;
    const box = canvas.current?.getBoundingClientRect();
    if (!f || !box) return null;
    const x = ((e.clientX - box.left - f.rect.x) / f.rect.w) * f.cssWidth;
    const y = ((e.clientY - box.top - f.rect.y) / f.rect.h) * f.cssHeight;
    return { x: Math.max(0, Math.min(f.cssWidth, x)), y: Math.max(0, Math.min(f.cssHeight, y)) };
  };

  // wheel needs a non-passive listener to stop the panel from scrolling
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toRemote(e);
      if (!p) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1;
      send({ t: 'mouse', type: 'mouseWheel', x: p.x, y: p.y, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: modifiers(e) });
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [tabId]);

  const lastMove = useRef(0);
  const pressed = useRef(new Set<number>());
  const onPointer = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') return;
    if (type === 'mouseMoved') {
      const now = performance.now();
      if (now - lastMove.current < 16 && e.buttons === 0) return;
      lastMove.current = now;
    }
    if (type === 'mousePressed') {
      e.preventDefault();
      // Keep receiving the release even when the drag leaves the panel.
      e.currentTarget.setPointerCapture(e.pointerId);
      pressed.current.add(e.button);
      input.current?.focus({ preventScroll: true });
    }
    if (type === 'mouseReleased') pressed.current.delete(e.button);
    const p = toRemote(e);
    if (!p) return;
    send({
      t: 'mouse',
      type,
      x: p.x,
      y: p.y,
      button: type === 'mouseMoved' ? (e.buttons & 1 ? 'left' : 'none') : BUTTONS[e.button] ?? 'left',
      buttons: e.buttons,
      clickCount: type === 'mouseMoved' ? 0 : clickCount(e),
      modifiers: modifiers(e),
    });
  };

  // pointer events have no click count; derive double/triple clicks like the browser does
  const clicks = useRef({ t: 0, x: 0, y: 0, n: 0 });
  const clickCount = (e: React.PointerEvent) => {
    if (e.type === 'pointerup') return clicks.current.n || 1;
    const c = clicks.current;
    const near = Math.abs(e.clientX - c.x) < 5 && Math.abs(e.clientY - c.y) < 5;
    c.n = near && e.timeStamp - c.t < 450 ? Math.min(c.n + 1, 3) : 1;
    c.t = e.timeStamp;
    c.x = e.clientX;
    c.y = e.clientY;
    return c.n;
  };

  const keyName = (e: React.KeyboardEvent) => {
    if (mapMeta && e.key === 'Meta') return 'Control';
    // With a modifier held, non-Latin layouts still mean the Latin shortcut key (Ctrl+С is Ctrl+C).
    if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1 && !/[\x20-\x7e]/.test(e.key)) {
      const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code);
      if (m) return (m[1] ?? m[2]).toLowerCase();
    }
    return e.key;
  };

  const onKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME composition in progress
    const shortcut = isMac ? e.metaKey : e.ctrlKey;
    const lower = keyName(e).toLowerCase();
    // Browser shortcuts are left alone here: the app window runs them in the browser panel. Esc also goes to the page.
    const action = browserAction({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey }, isMac);
    if (action && action.type !== 'stop') return;
    if (shortcut && lower === 'v' && !e.shiftKey) {
      e.preventDefault();
      const text = await bc.clipboard.read();
      if (text) send({ t: 'text', text });
      return;
    }
    if (shortcut && (lower === 'c' || lower === 'x') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send({ t: 'copy', cut: lower === 'x' });
      return;
    }
    e.preventDefault();
    const key = keyName(e);
    held.current.add(key);
    send({ t: 'key', type: 'down', key, code: e.code });
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const key = keyName(e);
    if (!held.current.has(key)) return;
    held.current.delete(key);
    e.preventDefault();
    send({ t: 'key', type: 'up', key, code: e.code });
  };

  function releaseAll() {
    for (const key of held.current) send({ t: 'key', type: 'up', key, code: '' });
    held.current.clear();
    const f = frame.current;
    for (const button of pressed.current) {
      send({ t: 'mouse', type: 'mouseReleased', x: f ? f.cssWidth / 2 : 0, y: f ? f.cssHeight / 2 : 0, button: BUTTONS[button] ?? 'left', clickCount: 1 });
    }
    pressed.current.clear();
  }

  return (
    <div className="viewport" ref={container}>
      <canvas
        ref={canvas}
        className="viewport-canvas"
        onPointerDown={onPointer('mousePressed')}
        onPointerUp={onPointer('mouseReleased')}
        onPointerMove={onPointer('mouseMoved')}
        onLostPointerCapture={() => pressed.current.size && releaseAll()}
        onContextMenu={(e) => e.preventDefault()}
      />
      <textarea
        ref={input}
        className="viewport-input"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(e) => void onKeyDown(e)}
        onKeyUp={onKeyUp}
        onBlur={releaseAll}
        onCompositionEnd={(e) => {
          if (e.data) send({ t: 'text', text: e.data });
          if (input.current) input.current.value = '';
        }}
        onInput={(e) => {
          const ev = e.nativeEvent as InputEvent;
          if (ev.isComposing || ev.inputType === 'insertCompositionText') return;
          // Text that arrives without a handled keydown (emoji picker, dictation, some input methods).
          if (ev.data && (ev.inputType === 'insertText' || ev.inputType === 'insertReplacementText')) send({ t: 'text', text: ev.data });
          e.currentTarget.value = '';
        }}
      />
      {!ready && !error && (
        <div className="viewport-overlay">
          <Spinner /> Loading page…
        </div>
      )}
      {error && <div className="viewport-overlay">{error}</div>}
    </div>
  );
}
