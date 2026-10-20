import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { Locator, Page } from 'playwright-core';
import { paths } from '../config.js';
import { errorMessage } from '../log.js';
import type { BrowserManager } from '../browser/manager.js';
import { ReplSession, type ReplImage } from './repl.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface ToolContext {
  threadId: string;
  turnId: string | null;
  /** The thread's Codex sandbox ("read-only", "workspace-write", "danger-full-access"). */
  sandboxMode?: string | null;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

const SNAPSHOT_LIMIT = 40_000;

const tabIdProp = { type: 'string', description: 'Tab id (e.g. "t3"). Defaults to the thread\'s current tab.' };
const refProp = { type: 'string', description: 'Element ref from the latest snapshot, e.g. "e12".' };
const selectorProp = { type: 'string', description: 'Playwright selector (CSS, text=…, role=…) as an alternative to ref.' };
const snapshotProp = { type: 'boolean', description: 'Return a fresh accessibility snapshot after the action.' };

function shortUrl(url: string) {
  return url.length > 200 ? `${url.slice(0, 200)}…` : url;
}

function text(t: string): Content {
  return { type: 'text', text: t };
}

export class BrowserTools {
  private repls = new Map<string, ReplSession>();
  readonly defs: ToolDef[];

  constructor(private browser: BrowserManager) {
    this.defs = this.buildDefs();
  }

  list() {
    return this.defs.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  }

  async call(name: string, args: any, ctx: ToolContext): Promise<ToolResult> {
    const def = this.defs.find((d) => d.name === name);
    if (!def) return { content: [text(`Unknown tool ${name}`)], isError: true };
    try {
      return await def.run(args ?? {}, ctx);
    } catch (err) {
      return { content: [text(`Error: ${errorMessage(err)}`)], isError: true };
    }
  }

  // ---------- helpers ----------

  private async tabFor(ctx: ToolContext, tabId?: string, { create = false } = {}) {
    let id = tabId || this.browser.currentTabId(ctx.threadId);
    if (!id) {
      if (!create) throw new Error('This thread has no browser tab yet. Open one with `navigate` (url) or `tabs` (action "new").');
      id = (await this.browser.newTab(ctx.threadId, undefined, 'agent')).id;
    }
    const tab = this.browser.get(id);
    if (!tab) throw new Error(`Tab ${id} does not exist. Use \`tabs\` to list open tabs.`);
    if (tabId) this.browser.setCurrent(ctx.threadId, tab.id);
    const page = await this.browser.page(tab.id);
    return { tab, page };
  }

  private locate(page: Page, args: { ref?: string; selector?: string }): Locator | null {
    if (args.ref) return page.getByRef(args.ref.replace(/^ref=/, ''));
    if (args.selector) return page.locator(args.selector).first();
    return null;
  }

  /**
   * Runs a page action but returns early if it opens a JavaScript dialog: Chrome blocks the
   * triggering input/script until the dialog is answered, which would otherwise hang the tool.
   */
  private async act<T>(tabId: string, fn: () => Promise<T>): Promise<{ dialog: boolean; value?: T }> {
    const open = this.browser.get(tabId)?.dialog;
    if (open) throw new Error(`A ${open.type()} dialog is open in tab ${tabId} (${JSON.stringify(open.message())}). Answer it with the \`dialog\` tool first.`);
    let onDialog: (e: { tabId: string }) => void = () => {};
    const dialogOpened = new Promise<{ dialog: true }>((resolve) => {
      onDialog = (e) => e.tabId === tabId && resolve({ dialog: true });
      this.browser.on('dialog', onDialog);
    });
    const action = fn().then((value) => ({ dialog: false, value }));
    action.catch(() => {});
    try {
      return await Promise.race([action, dialogOpened]);
    } finally {
      this.browser.off('dialog', onDialog);
    }
  }

  private async settle(page: Page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);
  }

  private async describe(tabId: string, page: Page, opts: { snapshot?: boolean; before?: string[] } = {}) {
    const lines: string[] = [];
    const title = await page.title().catch(() => '');
    lines.push(`Tab ${tabId}: ${title || '(untitled)'} — ${shortUrl(page.url())}`);
    const tab = this.browser.get(tabId);
    if (tab?.dialog) {
      lines.push(`A ${tab.dialog.type()} dialog is open: ${JSON.stringify(tab.dialog.message())}. Handle it with the \`dialog\` tool.`);
    }
    if (opts.before) {
      const after = this.browser.list(tab?.threadId ?? null).map((t) => t.id);
      const opened = after.filter((id) => !opts.before!.includes(id));
      for (const id of opened) {
        const info = this.browser.get(id);
        lines.push(`New tab ${id} opened${info ? `: ${info.page?.url() ?? info.url}` : ''}. It is now the current tab.`);
      }
    }
    if (opts.snapshot) lines.push('', await this.snapshotText(page));
    return lines.join('\n');
  }

  private async snapshotText(page: Page, scope?: Locator | null, maxChars = SNAPSHOT_LIMIT) {
    let snap = scope ? await scope.ariaSnapshot({ mode: 'ai', timeout: 10000 }) : await page.ariaSnapshot({ mode: 'ai', timeout: 15000 });
    if (snap.length > maxChars) {
      snap = `${snap.slice(0, maxChars)}\n… (snapshot truncated at ${maxChars} of ${snap.length} characters; pass a larger maxChars or scope it with ref/selector)`;
    }
    return snap;
  }

  private async screenshotImage(page: Page, opts: { fullPage?: boolean; locator?: Locator | null; quality?: number }) {
    await page.bringToFront().catch(() => {});
    const shotOpts = { type: 'jpeg' as const, quality: opts.quality ?? 80, scale: 'css' as const, timeout: 20000 };
    const buf = opts.locator ? await opts.locator.screenshot(shotOpts) : await page.screenshot({ ...shotOpts, fullPage: !!opts.fullPage });
    const file = path.join(paths.screenshots, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.jpg`);
    fs.writeFileSync(file, buf);
    return { buf, file };
  }

  private threadTabIds(ctx: ToolContext) {
    return this.browser.list(ctx.threadId).map((t) => t.id);
  }

  private repl(ctx: ToolContext) {
    let session = this.repls.get(ctx.threadId);
    if (session) return session;
    const browser = this.browser;
    const threadId = ctx.threadId;
    const resolve = async (target?: Page | string) => {
      if (target && typeof target !== 'string') return target;
      const id = target || browser.currentTabId(threadId);
      if (!id) throw new Error('No tab. Use `await tabs.new(url)` first.');
      return browser.page(id);
    };
    const tabsApi = {
      list: (all = false) => browser.list(all ? undefined : threadId),
      new: async (url?: string) => {
        const tab = await browser.newTab(threadId, url, 'agent');
        const page = await browser.page(tab.id);
        session!.context.page = page;
        return page;
      },
      get: (id: string) => browser.page(id),
      current: () => resolve(),
      select: async (id: string) => {
        browser.setCurrent(threadId, id);
        const page = await browser.page(id);
        session!.context.page = page;
        return page;
      },
      close: (id: string) => browser.close(id),
      idOf: (page: Page) => browser.list().find((t) => browser.get(t.id)?.page === page)?.id ?? null,
    };
    session = new ReplSession({
      tabs: tabsApi,
      snapshot: async (target?: Page | string, maxChars?: number) => this.snapshotText(await resolve(target), null, maxChars),
      screenshot: async (target?: Page | string, opts: { fullPage?: boolean } = {}) => {
        const { buf, file } = await this.screenshotImage(await resolve(target), opts);
        session!.attachImage({ data: buf.toString('base64'), mimeType: 'image/jpeg' });
        return file;
      },
    });
    this.repls.set(threadId, session);
    return session;
  }

  // ---------- tool definitions ----------

  private buildDefs(): ToolDef[] {
    return [
      {
        name: 'tabs',
        description:
          'List, open, select or close browser tabs. Tabs are owned by threads; this thread acts on its current tab by default. ' +
          'action "list" (default) shows this thread\'s tabs (all=true for every tab in the browser), "new" opens a tab (optionally at url) and makes it current, ' +
          '"select" makes any tab current for this thread, "claim" moves another thread\'s tab into this thread, "close" closes a tab.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'new', 'select', 'claim', 'close'] },
            tabId: tabIdProp,
            url: { type: 'string' },
            all: { type: 'boolean' },
          },
        },
        run: async (args, ctx) => {
          const action = args.action ?? 'list';
          if (action === 'new') {
            const tab = await this.browser.newTab(ctx.threadId, undefined, 'agent');
            const page = await this.browser.page(tab.id);
            if (args.url) await this.browser.withAgent(tab.id, () => this.browser.goto(tab, args.url));
            return { content: [text(await this.describe(tab.id, page, { snapshot: !!args.url }))] };
          }
          if (action === 'select' || action === 'claim') {
            if (!args.tabId) throw new Error('tabId is required');
            if (action === 'claim') this.browser.assign(args.tabId, ctx.threadId);
            this.browser.setCurrent(ctx.threadId, args.tabId);
            const page = await this.browser.page(args.tabId);
            return { content: [text(await this.describe(args.tabId, page))] };
          }
          if (action === 'close') {
            const id = args.tabId || this.browser.currentTabId(ctx.threadId);
            if (!id) throw new Error('No tab to close');
            await this.browser.close(id);
            return { content: [text(`Closed tab ${id}.`)] };
          }
          const current = this.browser.currentTabId(ctx.threadId);
          const tabs = this.browser.list(args.all ? undefined : ctx.threadId);
          const others = args.all ? 0 : this.browser.list().length - tabs.length;
          const lines = tabs.map(
            (t) =>
              `${t.id === current ? '* ' : '  '}${t.id}  ${t.title || '(untitled)'} — ${shortUrl(t.url)}${t.sleeping ? ' (sleeping)' : ''}${
                args.all ? `  [thread ${t.threadId === ctx.threadId ? 'this' : (t.threadId ?? 'none')}]` : ''
              }`,
          );
          if (!lines.length) lines.push('This thread has no tabs.');
          if (others > 0) lines.push(`(${others} more tab(s) belong to other threads; list them with all=true.)`);
          return { content: [text(lines.join('\n'))] };
        },
      },
      {
        name: 'navigate',
        description:
          'Go to a URL in the current tab (opens a tab if the thread has none), or go back/forward/reload. Returns the page snapshot unless snapshot=false. ' +
          'Bare words become a web search; "localhost:3000" works.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'] },
            newTab: { type: 'boolean', description: 'Open the URL in a new tab instead.' },
            tabId: tabIdProp,
            snapshot: { ...snapshotProp, description: 'Return the accessibility snapshot (default true).' },
          },
        },
        run: async (args, ctx) => {
          const action = args.action ?? 'goto';
          if (action === 'goto' && !args.url) throw new Error('url is required');
          if (args.newTab && args.url) {
            const tab = await this.browser.newTab(ctx.threadId, undefined, 'agent');
            const page = await this.browser.page(tab.id);
            await this.browser.withAgent(tab.id, () => this.browser.goto(tab, args.url));
            return { content: [text(await this.describe(tab.id, page, { snapshot: args.snapshot !== false }))] };
          }
          const { tab, page } = await this.tabFor(ctx, args.tabId, { create: true });
          return this.browser.withAgent(tab.id, async () => {
            const { dialog } = await this.act(tab.id, async () => {
              if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
              else if (action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
              else if (action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
              else await this.browser.goto(tab, args.url);
            });
            if (!dialog) await this.settle(page);
            return { content: [text(await this.describe(tab.id, page, { snapshot: args.snapshot !== false }))] };
          });
        },
      },
      {
        name: 'snapshot',
        description:
          'Accessibility snapshot of the page (YAML-like tree with [ref=eN] element refs, includes iframes). Refs are valid until the next snapshot of this tab. ' +
          'Scope it with ref/selector for big pages.',
        inputSchema: {
          type: 'object',
          properties: { tabId: tabIdProp, ref: refProp, selector: selectorProp, maxChars: { type: 'number' } },
        },
        annotations: { readOnlyHint: true },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          const scope = this.locate(page, args);
          const header = await this.describe(tab.id, page);
          return { content: [text(`${header}\n\n${await this.snapshotText(page, scope, args.maxChars ?? SNAPSHOT_LIMIT)}`)] };
        },
      },
      {
        name: 'screenshot',
        description:
          'JPEG screenshot of the current viewport (fullPage=true for the whole page, or one element via ref/selector). The image is returned to you and saved on the host; ' +
          'embed the returned path in Markdown to show it to the user.',
        inputSchema: {
          type: 'object',
          properties: { tabId: tabIdProp, fullPage: { type: 'boolean' }, ref: refProp, selector: selectorProp },
        },
        annotations: { readOnlyHint: true },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          const { buf, file } = await this.screenshotImage(page, { fullPage: args.fullPage, locator: this.locate(page, args) });
          return {
            content: [text(`${await this.describe(tab.id, page)}\nSaved: ${file}`), { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }],
          };
        },
      },
      {
        name: 'click',
        description: 'Click an element (ref or selector) or a viewport coordinate (x, y in CSS pixels, as seen in screenshots).',
        inputSchema: {
          type: 'object',
          properties: {
            ref: refProp,
            selector: selectorProp,
            x: { type: 'number' },
            y: { type: 'number' },
            button: { type: 'string', enum: ['left', 'right', 'middle'] },
            doubleClick: { type: 'boolean' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] } },
            tabId: tabIdProp,
            snapshot: snapshotProp,
          },
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          const before = this.threadTabIds(ctx);
          return this.browser.withAgent(tab.id, async () => {
            const target = this.locate(page, args);
            const opts = { button: args.button ?? 'left', modifiers: args.modifiers, timeout: 10000 };
            if (!target && (typeof args.x !== 'number' || typeof args.y !== 'number')) throw new Error('Pass ref, selector or x/y');
            const { dialog } = await this.act(tab.id, async () => {
              if (target) {
                if (args.doubleClick) await target.dblclick(opts);
                else await target.click(opts);
              } else {
                await page.mouse.click(args.x, args.y, { button: opts.button, clickCount: args.doubleClick ? 2 : 1 });
              }
            });
            if (!dialog) await this.settle(page);
            const currentId = this.browser.currentTabId(ctx.threadId) ?? tab.id;
            const currentPage = this.browser.get(currentId)?.page ?? page;
            return { content: [text(`Clicked.\n${await this.describe(currentId, currentPage, { snapshot: args.snapshot, before })}`)] };
          });
        },
      },
      {
        name: 'type',
        description:
          'Type into an editable element. By default replaces its content (fill); clear=false appends by pressing keys one by one. submit=true presses Enter afterwards. ' +
          'Without ref/selector, types into the focused element.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: refProp,
            selector: selectorProp,
            text: { type: 'string' },
            clear: { type: 'boolean', description: 'Replace existing content (default true).' },
            submit: { type: 'boolean' },
            tabId: tabIdProp,
            snapshot: snapshotProp,
          },
          required: ['text'],
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          const before = this.threadTabIds(ctx);
          return this.browser.withAgent(tab.id, async () => {
            const target = this.locate(page, args);
            const { dialog } = await this.act(tab.id, async () => {
              if (target) {
                if (args.clear === false) await target.pressSequentially(args.text, { timeout: 15000 });
                else await target.fill(args.text, { timeout: 10000 });
                if (args.submit) await target.press('Enter');
              } else {
                await page.keyboard.insertText(args.text);
                if (args.submit) await page.keyboard.press('Enter');
              }
            });
            if (!dialog) await this.settle(page);
            return { content: [text(`Typed.\n${await this.describe(tab.id, page, { snapshot: args.snapshot, before })}`)] };
          });
        },
      },
      {
        name: 'press',
        description: 'Press a key or chord on the focused element, e.g. "Enter", "Escape", "ArrowDown", "Control+A", "Meta+K". Optionally focus ref/selector first.',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' }, ref: refProp, selector: selectorProp, tabId: tabIdProp, snapshot: snapshotProp },
          required: ['key'],
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          const before = this.threadTabIds(ctx);
          return this.browser.withAgent(tab.id, async () => {
            const target = this.locate(page, args);
            const { dialog } = await this.act(tab.id, async () => {
              if (target) await target.press(args.key, { timeout: 10000 });
              else await page.keyboard.press(args.key);
            });
            if (!dialog) await this.settle(page);
            return { content: [text(`Pressed ${args.key}.\n${await this.describe(tab.id, page, { snapshot: args.snapshot, before })}`)] };
          });
        },
      },
      {
        name: 'hover',
        description: 'Move the mouse over an element (ref/selector) or a coordinate.',
        inputSchema: {
          type: 'object',
          properties: { ref: refProp, selector: selectorProp, x: { type: 'number' }, y: { type: 'number' }, tabId: tabIdProp, snapshot: snapshotProp },
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          return this.browser.withAgent(tab.id, async () => {
            const target = this.locate(page, args);
            const { dialog } = await this.act(tab.id, async () => {
              if (target) await target.hover({ timeout: 10000 });
              else await page.mouse.move(args.x ?? 0, args.y ?? 0);
            });
            if (!dialog) await page.waitForTimeout(250);
            return { content: [text(`Hovered.\n${await this.describe(tab.id, page, { snapshot: args.snapshot })}`)] };
          });
        },
      },
      {
        name: 'scroll',
        description: 'Scroll the page or the scrollable area under an element/point. direction up/down/left/right by `pages` viewport heights (default 1), or scroll an element into view with ref and no direction.',
        inputSchema: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            pages: { type: 'number' },
            ref: refProp,
            selector: selectorProp,
            x: { type: 'number' },
            y: { type: 'number' },
            tabId: tabIdProp,
            snapshot: snapshotProp,
          },
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          return this.browser.withAgent(tab.id, async () => {
            const target = this.locate(page, args);
            const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
            if (target && !args.direction) {
              await target.scrollIntoViewIfNeeded({ timeout: 10000 });
            } else {
              let point = { x: args.x ?? viewport.width / 2, y: args.y ?? viewport.height / 2 };
              if (target) {
                const box = await target.boundingBox();
                if (box) point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
              }
              const amount = (args.pages ?? 1) * (args.direction === 'left' || args.direction === 'right' ? viewport.width : viewport.height) * 0.85;
              const dx = args.direction === 'left' ? -amount : args.direction === 'right' ? amount : 0;
              const dy = args.direction === 'up' ? -amount : args.direction === 'down' || !args.direction ? amount : 0;
              await page.mouse.move(point.x, point.y);
              await page.mouse.wheel(dx, dy);
            }
            await page.waitForTimeout(300);
            const pos = await page.evaluate(() => `scrollY=${Math.round(scrollY)} of ${document.documentElement.scrollHeight - innerHeight}`).catch(() => '');
            return { content: [text(`Scrolled (${pos}).\n${await this.describe(tab.id, page, { snapshot: args.snapshot })}`)] };
          });
        },
      },
      {
        name: 'select_option',
        description: 'Choose option(s) in a native <select> by value or label.',
        inputSchema: {
          type: 'object',
          properties: { ref: refProp, selector: selectorProp, values: { type: 'array', items: { type: 'string' } }, tabId: tabIdProp, snapshot: snapshotProp },
          required: ['values'],
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          return this.browser.withAgent(tab.id, async () => {
            const target = this.locate(page, args);
            if (!target) throw new Error('Pass ref or selector');
            const { dialog, value: chosen } = await this.act(tab.id, () => target.selectOption(args.values, { timeout: 10000 }));
            if (!dialog) await this.settle(page);
            return { content: [text(`Selected ${JSON.stringify(chosen ?? args.values)}.\n${await this.describe(tab.id, page, { snapshot: args.snapshot })}`)] };
          });
        },
      },
      {
        name: 'evaluate',
        description:
          'Run JavaScript in the page and return the JSON-serializable result. `script` is an expression or a function source like "() => document.title"; ' +
          'with ref/selector it receives the element: "(el) => el.outerHTML". DOM writes, fetch, cookies and storage are all allowed.',
        inputSchema: {
          type: 'object',
          properties: { script: { type: 'string' }, ref: refProp, selector: selectorProp, tabId: tabIdProp },
          required: ['script'],
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          return this.browser.withAgent(tab.id, async () => {
            const target = this.locate(page, args);
            const isFn = /^\s*(async\s+)?(\(|function\b|[\w$]+\s*=>)/.test(args.script);
            const { dialog, value } = await this.act(tab.id, async (): Promise<unknown> => {
              if (target) {
                // Build a real function so Playwright passes the element as its argument.
                const fn = new Function(`return (${isFn ? args.script : `(el) => (${args.script})`})`)() as (el: Element) => unknown;
                return target.evaluate(fn, undefined, { timeout: 15000 });
              }
              return page.evaluate(isFn ? `(${args.script})()` : args.script);
            });
            if (dialog) return { content: [text(await this.describe(tab.id, page))] };
            let out = value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
            if (out && out.length > 30000) out = `${out.slice(0, 30000)}\n… (truncated)`;
            return { content: [text(out ?? String(value))] };
          });
        },
      },
      {
        name: 'wait',
        description: 'Wait until text appears/disappears, a selector is visible, the URL matches, or for a fixed time. Timeout defaults to 15s.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            textGone: { type: 'string' },
            selector: { type: 'string' },
            url: { type: 'string', description: 'Glob or substring of the URL to wait for.' },
            seconds: { type: 'number', description: 'Fixed wait.' },
            timeout: { type: 'number', description: 'Seconds (max 120).' },
            tabId: tabIdProp,
            snapshot: snapshotProp,
          },
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          const timeout = Math.min(args.timeout ?? 15, 120) * 1000;
          return this.browser.withAgent(tab.id, async () => {
            if (args.seconds) await page.waitForTimeout(Math.min(args.seconds, 120) * 1000);
            if (args.text) await page.getByText(args.text).first().waitFor({ state: 'visible', timeout });
            if (args.textGone) await page.getByText(args.textGone).first().waitFor({ state: 'hidden', timeout });
            if (args.selector) await page.locator(args.selector).first().waitFor({ state: 'visible', timeout });
            if (args.url) {
              const needle = args.url;
              await page.waitForURL((u) => u.href.includes(needle) || globMatch(needle, u.href), { timeout });
            }
            return { content: [text(`Done waiting.\n${await this.describe(tab.id, page, { snapshot: args.snapshot })}`)] };
          });
        },
      },
      {
        name: 'console',
        description: 'Recent console messages and uncaught page errors of a tab (newest last).',
        inputSchema: {
          type: 'object',
          properties: { tabId: tabIdProp, limit: { type: 'number' }, level: { type: 'string', enum: ['all', 'error', 'warning'] } },
        },
        annotations: { readOnlyHint: true },
        run: async (args, ctx) => {
          const id = args.tabId || this.browser.currentTabId(ctx.threadId);
          if (!id) throw new Error('No tab');
          let entries = this.browser.consoleOf(id);
          if (args.level === 'error') entries = entries.filter((e) => e.type === 'error' || e.type === 'pageerror');
          if (args.level === 'warning') entries = entries.filter((e) => ['error', 'pageerror', 'warning'].includes(e.type));
          const lines = entries
            .slice(-(args.limit ?? 50))
            .map((e) => `[${new Date(e.time).toISOString().slice(11, 19)}] ${e.type}: ${e.text}${e.location ? `  (${e.location})` : ''}`);
          return { content: [text(lines.join('\n') || 'No console messages.')] };
        },
      },
      {
        name: 'dialog',
        description: 'Accept or dismiss the JavaScript dialog (alert/confirm/prompt/beforeunload) open in a tab.',
        inputSchema: {
          type: 'object',
          properties: { accept: { type: 'boolean' }, promptText: { type: 'string' }, tabId: tabIdProp },
          required: ['accept'],
        },
        run: async (args, ctx) => {
          const id = args.tabId || this.browser.currentTabId(ctx.threadId);
          if (!id) throw new Error('No tab');
          await this.browser.handleDialog(id, args.accept, args.promptText);
          return { content: [text(args.accept ? 'Dialog accepted.' : 'Dialog dismissed.')] };
        },
      },
      {
        name: 'upload',
        description:
          'Upload files (absolute paths on this host) through a file input. Target the <input type=file> or the button that opens the file chooser via ref/selector; ' +
          'without a target, answers a file chooser that is already open.',
        inputSchema: {
          type: 'object',
          properties: { paths: { type: 'array', items: { type: 'string' } }, ref: refProp, selector: selectorProp, tabId: tabIdProp },
          required: ['paths'],
        },
        run: async (args, ctx) => {
          const { tab, page } = await this.tabFor(ctx, args.tabId);
          for (const file of args.paths) if (!fs.existsSync(file)) throw new Error(`File not found on host: ${file}`);
          return this.browser.withAgent(tab.id, async () => {
            const target = this.locate(page, args);
            if (!target) {
              await this.browser.resolveFileChooser(tab.id, args.paths);
            } else if (await target.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file').catch(() => false)) {
              await target.setInputFiles(args.paths, { timeout: 10000 });
            } else {
              const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
              await target.click({ timeout: 10000 });
              await (await chooser).setFiles(args.paths);
            }
            await this.settle(page);
            return { content: [text(`Uploaded ${args.paths.length} file(s).\n${await this.describe(tab.id, page)}`)] };
          });
        },
      },
      {
        name: 'downloads',
        description: 'Recent browser downloads with their saved paths on this host.',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
        annotations: { readOnlyHint: true },
        run: async (args) => {
          const lines = this.browser.downloads
            .slice(0, args.limit ?? 20)
            .map((d) => `${d.state.padEnd(10)} ${d.path}  (from ${d.url}${d.tabId ? `, tab ${d.tabId}` : ''})${d.error ? ` error: ${d.error}` : ''}`);
          return { content: [text(lines.join('\n') || 'No downloads yet.')] };
        },
      },
      {
        name: 'js',
        description:
          'Run JavaScript (Node, top-level await) in a persistent per-thread REPL with full Playwright access. Top-level const/let/function declarations persist across calls and can be redeclared. ' +
          'Globals: `page` (current tab, a Playwright Page), `context` (BrowserContext: cookies, routes, all pages), ' +
          '`tabs` { list(all?), new(url?) → Page, get(id) → Page, current() → Page, select(id) → Page, close(id), idOf(page) }, ' +
          '`snapshot(pageOrTabId?, maxChars?)` → accessibility text with refs (use page.getByRef("e5")), `screenshot(pageOrTabId?, {fullPage})` → shows the image to you and returns its path, ' +
          '`display(bytesOrPathOrDataUrl)` to show any image, `print(...)`/console.log for output, plus path, fetch, sleep(ms) (and require/fs/process in Full access threads). The value of the last expression is returned. ' +
          'Use this to batch several actions, loop, extract data or use any Playwright feature (page.route, waitForResponse, keyboard, frames…).',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            timeoutMs: { type: 'number', description: 'Default 60000, max 600000.' },
            reset: { type: 'boolean', description: 'Discard all REPL state before running.' },
          },
          required: ['code'],
        },
        run: async (args, ctx) => {
          if (args.reset) this.repls.delete(ctx.threadId);
          const session = this.repl(ctx);
          // The REPL runs inside the host process, outside Codex's sandbox. Node's own APIs are only
          // handed out when the thread already has full access, so the browser tool cannot be used
          // to sidestep a read-only or workspace-write thread.
          const fullAccess = ctx.sandboxMode === 'danger-full-access' || ctx.sandboxMode === 'none';
          Object.assign(session.context, fullAccess ? nodeGlobals : { require: undefined, process: undefined, fs: undefined });
          const timeout = Math.min(args.timeoutMs ?? 60000, 600000);
          const currentId = this.browser.currentTabId(ctx.threadId);
          const run = () =>
            session.run(args.code, timeout, async () => {
              const id = this.browser.currentTabId(ctx.threadId);
              session.context.context = this.browser.context ?? (await this.browser.ensure());
              session.context.page = id ? await this.browser.page(id) : undefined;
            });
          // A dialog blocks the page call that opened it; report it instead of waiting for the timeout.
          let onDialog: (e: { tabId: string; threadId: string | null; dialog: { type: string; message: string } }) => void = () => {};
          const dialogOpened = new Promise<{ tabId: string; dialog: { type: string; message: string } }>((resolve) => {
            onDialog = (e) => {
              if (e.threadId === ctx.threadId || e.tabId === this.browser.currentTabId(ctx.threadId)) resolve(e);
            };
            this.browser.on('dialog', onDialog);
          });
          const running = currentId ? this.browser.withAgent(currentId, run) : run();
          const winner = await Promise.race([running, dialogOpened]).finally(() => this.browser.off('dialog', onDialog));
          if (!('text' in winner)) {
            return {
              content: [
                text(
                  `A ${winner.dialog.type} dialog opened in tab ${winner.tabId}: ${JSON.stringify(winner.dialog.message)}. ` +
                    'The cell is paused until it is answered with the `dialog` tool; its output will not be shown.',
                ),
              ],
            };
          }
          const out = winner;
          const content: Content[] = [text(out.text || (out.error ? 'Error' : '(no output)'))];
          for (const img of out.images as ReplImage[]) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
          return { content, isError: out.error };
        },
      },
    ];
  }
}

const nodeGlobals = { require: createRequire(import.meta.url), process, fs };

function globMatch(glob: string, value: string) {
  if (!glob.includes('*')) return false;
  const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}
