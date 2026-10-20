import type { CDPSession, Page } from 'playwright-core';
import type { WebSocket } from 'ws';
import type { FrameHeader, StreamClientMessage, StreamHostMessage } from '../../shared/types.js';
import { errorMessage, log } from '../log.js';
import type { BrowserManager } from './manager.js';

const MAX_BUFFERED = 1_500_000;

interface Viewer {
  ws: WebSocket;
  tabId: string | null;
  width: number;
  height: number;
  pending: Buffer | null;
  lastCursorAt: number;
}

/** One CDP screencast per watched tab, fanned out to every viewer of that tab. */
class TabStream {
  readonly viewers = new Set<Viewer>();
  lastFrame: Buffer | null = null;
  private seq = 0;
  private started = false;

  constructor(
    readonly tabId: string,
    readonly page: Page,
    readonly cdp: CDPSession,
    private quality: number,
  ) {
    cdp.on('Page.screencastFrame', (event) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      const jpeg = Buffer.from(event.data, 'base64');
      const meta = event.metadata;
      const header: FrameHeader = {
        tabId,
        cssWidth: Math.round(meta.deviceWidth),
        cssHeight: Math.round(meta.deviceHeight),
        width: 0,
        height: 0,
        seq: ++this.seq,
      };
      this.publish(encodeFrame(header, jpeg));
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.quality, everyNthFrame: 1 });
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  /** Pages that are idle produce no frames, so new viewers get an explicit capture. */
  async captureNow() {
    try {
      const viewport = this.page.viewportSize() ?? { width: 1280, height: 800 };
      const shot = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.quality });
      const header: FrameHeader = { tabId: this.tabId, cssWidth: viewport.width, cssHeight: viewport.height, width: 0, height: 0, seq: ++this.seq };
      this.publish(encodeFrame(header, Buffer.from(shot.data, 'base64')));
    } catch (err) {
      log.debug('captureNow failed', errorMessage(err));
    }
  }

  publish(frame: Buffer) {
    this.lastFrame = frame;
    for (const viewer of this.viewers) sendFrame(viewer, frame);
  }
}

function encodeFrame(header: FrameHeader, jpeg: Buffer) {
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([len, json, jpeg]);
}

function sendFrame(viewer: Viewer, frame: Buffer) {
  if (viewer.ws.readyState !== viewer.ws.OPEN) return;
  // A slow viewer only ever gets the newest frame instead of an ever-growing backlog.
  if (viewer.ws.bufferedAmount > MAX_BUFFERED) {
    viewer.pending = frame;
    return;
  }
  viewer.pending = null;
  viewer.ws.send(frame, { binary: true });
}

function send(viewer: Viewer, msg: StreamHostMessage) {
  if (viewer.ws.readyState === viewer.ws.OPEN) viewer.ws.send(JSON.stringify(msg));
}

const CURSOR_SCRIPT = `((x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return 'default';
  const c = getComputedStyle(el).cursor;
  if (c && c !== 'auto') return c;
  if (el.closest('a[href],button,[role=button],[role=link],summary,label,select')) return 'pointer';
  if (el.closest('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=""],[contenteditable=true]')) return 'text';
  return 'default';
})`;

const SELECTION_SCRIPT = `(() => {
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && typeof el.selectionStart === 'number'))) {
    return el.value.substring(el.selectionStart, el.selectionEnd);
  }
  return String(window.getSelection() || '');
})()`;

export class StreamHub {
  private streams = new Map<string, TabStream>();
  private viewers = new Set<Viewer>();

  constructor(private browser: BrowserManager) {
    setInterval(() => {
      for (const viewer of this.viewers) {
        if (viewer.pending && viewer.ws.bufferedAmount <= MAX_BUFFERED) sendFrame(viewer, viewer.pending);
      }
    }, 40).unref();
    browser.on('tabs', () => {
      for (const [tabId, stream] of this.streams) {
        const tab = browser.get(tabId);
        if (!tab || tab.page !== stream.page) void this.dropStream(tabId);
      }
    });
  }

  handle(ws: WebSocket) {
    const viewer: Viewer = { ws, tabId: null, width: 1280, height: 800, pending: null, lastCursorAt: 0 };
    this.viewers.add(viewer);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: StreamClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(viewer, msg).catch((err) => send(viewer, { t: 'error', message: errorMessage(err) }));
    });
    ws.on('close', () => {
      this.viewers.delete(viewer);
      void this.detach(viewer);
    });
  }

  private async onMessage(viewer: Viewer, msg: StreamClientMessage) {
    switch (msg.t) {
      case 'attach':
        return this.attach(viewer, msg.tabId, msg.width, msg.height);
      case 'detach':
        return this.detach(viewer);
      case 'resize':
        viewer.width = msg.width;
        viewer.height = msg.height;
        if (viewer.tabId) await this.applyViewport(viewer);
        return;
    }
    const stream = viewer.tabId ? this.streams.get(viewer.tabId) : undefined;
    if (!stream) return;
    const { page, cdp } = stream;
    switch (msg.t) {
      case 'mouse': {
        if (msg.type === 'mousePressed') this.browser.touch(stream.tabId);
        await cdp.send('Input.dispatchMouseEvent', {
          type: msg.type,
          x: msg.x,
          y: msg.y,
          button: msg.button ?? 'none',
          buttons: msg.buttons ?? 0,
          clickCount: msg.clickCount ?? 0,
          modifiers: msg.modifiers ?? 0,
          deltaX: msg.deltaX ?? 0,
          deltaY: msg.deltaY ?? 0,
          pointerType: 'mouse',
        });
        if (msg.type === 'mouseMoved' && Date.now() - viewer.lastCursorAt > 120) {
          viewer.lastCursorAt = Date.now();
          const res = await cdp
            .send('Runtime.evaluate', { expression: `${CURSOR_SCRIPT}(${msg.x}, ${msg.y})`, returnByValue: true })
            .catch(() => null);
          const cursor = res?.result?.value;
          if (typeof cursor === 'string') send(viewer, { t: 'cursor', cursor });
        }
        return;
      }
      case 'key': {
        if (['Dead', 'Process', 'Unidentified', 'Compose'].includes(msg.key)) return;
        // Playwright only knows the US layout; other characters (ä, ж, é…) are typed as text.
        if ([...msg.key].length === 1 && !/^[\x20-\x7e]$/.test(msg.key)) {
          if (msg.type === 'down') await page.keyboard.insertText(msg.key);
          return;
        }
        try {
          if (msg.type === 'down') await page.keyboard.down(msg.key);
          else await page.keyboard.up(msg.key);
        } catch {
          if (msg.type === 'down' && [...msg.key].length === 1) await page.keyboard.insertText(msg.key);
        }
        return;
      }
      case 'text':
        await page.keyboard.insertText(msg.text);
        return;
      case 'copy': {
        const res = await cdp.send('Runtime.evaluate', { expression: SELECTION_SCRIPT, returnByValue: true });
        const text = String(res.result?.value ?? '');
        send(viewer, { t: 'clipboard', text });
        if (msg.cut && text) await page.keyboard.press('Delete');
        return;
      }
    }
  }

  private async attach(viewer: Viewer, tabId: string, width: number, height: number) {
    await this.detach(viewer);
    viewer.tabId = tabId;
    viewer.width = width;
    viewer.height = height;
    const stream = await this.streamFor(tabId);
    if (viewer.tabId !== tabId) return;
    stream.viewers.add(viewer);
    this.browser.touch(tabId);
    send(viewer, { t: 'attached', tabId });
    await this.applyViewport(viewer);
    await stream.page.bringToFront().catch(() => {});
    if (stream.lastFrame) sendFrame(viewer, stream.lastFrame);
    await stream.start();
    await stream.captureNow();
  }

  private async detach(viewer: Viewer) {
    const tabId = viewer.tabId;
    viewer.tabId = null;
    if (!tabId) return;
    const stream = this.streams.get(tabId);
    if (!stream) return;
    stream.viewers.delete(viewer);
    if (stream.viewers.size === 0) await this.dropStream(tabId);
  }

  /** The most recently attached/resized viewer decides the tab's viewport size. */
  private async applyViewport(viewer: Viewer) {
    const stream = viewer.tabId ? this.streams.get(viewer.tabId) : undefined;
    if (!stream) return;
    const width = clamp(Math.round(viewer.width), 240, 3840);
    const height = clamp(Math.round(viewer.height), 200, 2400);
    const current = stream.page.viewportSize();
    if (current?.width === width && current?.height === height) return;
    await stream.page.setViewportSize({ width, height });
  }

  private async streamFor(tabId: string) {
    const existing = this.streams.get(tabId);
    if (existing && !existing.page.isClosed()) return existing;
    const page = await this.browser.page(tabId);
    const context = this.browser.context;
    if (!context) throw new Error('browser is not running');
    const cdp = await context.newCDPSession(page);
    const again = this.streams.get(tabId);
    if (again && again.page === page) {
      await cdp.detach().catch(() => {});
      return again;
    }
    const stream = new TabStream(tabId, page, cdp, this.browser.quality());
    this.streams.set(tabId, stream);
    page.once('close', () => void this.dropStream(tabId));
    return stream;
  }

  private async dropStream(tabId: string) {
    const stream = this.streams.get(tabId);
    if (!stream) return;
    this.streams.delete(tabId);
    for (const viewer of stream.viewers) {
      viewer.tabId = null;
      send(viewer, { t: 'error', message: 'tab closed' });
    }
    await stream.stop();
    await stream.cdp.detach().catch(() => {});
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
