import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Download, type FileChooser, type Page } from 'playwright-core';
import type { AppBrowserRegistration, BrowserStatus, DownloadInfo, HostConfig, TabDialog, TabInfo } from '../../shared/types.js';
import { isPidAlive, paths, readJson, writeJson } from '../config.js';
import { errorMessage, log } from '../log.js';
import { appLauncher, launchAppInBackground, rememberLauncher } from './app.js';
import { findBrowser, installChromium, killStaleBrowsers, resolveMode, sandboxSupported, type Display } from './launch.js';

export interface ConsoleEntry {
  time: number;
  type: string;
  text: string;
  location?: string;
}

interface TabRecord {
  id: string;
  threadId: string | null;
  url: string;
  title: string;
  faviconUrl: string | null;
  createdBy: TabInfo['createdBy'];
  createdAt: number;
  lastActiveAt: number;
  page: Page | null;
  /** DevTools target of the live page (engine "app"), also used to find it again after a host restart. */
  targetId: string | null;
  loading: boolean;
  dialog: Dialog | null;
  agentCalls: number;
  console: ConsoleEntry[];
  fileChooser: FileChooser | null;
}

interface PersistedTabs {
  nextId: number;
  tabs: Array<Pick<TabRecord, 'id' | 'threadId' | 'url' | 'title' | 'faviconUrl' | 'createdBy' | 'createdAt' | 'lastActiveAt'> & { targetId?: string | null }>;
  /** The tab each thread is currently working with. */
  current: Record<string, string>;
}

const CONSOLE_LIMIT = 300;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * One persistent browser profile per host. It is the BetterCodex app's own browser when the app
 * is installed on the machine (tabs show natively in its window), otherwise a Chromium the host
 * runs and streams. Every tab belongs to a thread (or to nobody), survives restarts as a
 * "sleeping" record and is woken up on demand.
 */
export class BrowserManager extends EventEmitter {
  context: BrowserContext | null = null;
  status: BrowserStatus = { state: 'idle', engine: null, appInstanceId: null, executablePath: null, mode: null, version: null, error: null, profileDir: paths.profile };
  /** Which browser the live context belongs to. */
  engine: 'app' | 'chromium' | null = null;
  readonly downloads: DownloadInfo[] = [];

  private tabs = new Map<string, TabRecord>();
  private byPage = new WeakMap<Page, TabRecord>();
  private current: Record<string, string> = {};
  private nextId = 1;
  private launching: Promise<BrowserContext> | null = null;
  private display: Display | null = null;
  private pendingOwner: { threadId: string | null; createdBy: TabInfo['createdBy']; record?: TabRecord } | null = null;
  private creation: Promise<unknown> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  /** Set while we close the browser ourselves, so its pages closing does not delete their tabs. */
  private closing = false;
  /**
   * Chrome's startup tab, kept open but hidden from the tab list: a headful Chrome exits when its
   * last window closes, which would take every other tab's state with it.
   */
  private keepAlive: Page | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  /** Connection to the app browser (engine "app") and its BetterCodex control session. */
  private appConnection: Browser | null = null;
  private control: CDPSession | null = null;
  private app: AppBrowserRegistration | null = null;
  private appWaiters: Array<() => void> = [];
  private appDisplay: Display | null = null;
  private hostEndpoint: { port: number; token: string } | null = null;
  /** Clients on other machines watching each tab (streams, synced copies); they pick files for the page. */
  private remoteViewers = new Map<string, { stream: number; sync: number }>();

  constructor(private getConfig: () => HostConfig) {
    super();
    // Pages change their title without navigating (SPAs, counters); poll recently used tabs.
    setInterval(() => void this.pollTitles(), 3000).unref();
    const stored = readJson<PersistedTabs>(paths.tabs, { nextId: 1, tabs: [], current: {} });
    this.nextId = stored.nextId;
    this.current = stored.current ?? {};
    for (const t of stored.tabs) {
      this.tabs.set(t.id, { ...t, targetId: t.targetId ?? null, page: null, loading: false, dialog: null, agentCalls: 0, console: [], fileChooser: null });
    }
  }

  // ---------- lifecycle ----------

  ensure(): Promise<BrowserContext> {
    if (this.context) return Promise.resolve(this.context);
    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = null;
      });
    }
    return this.launching;
  }

  /** Where the background app reports back to. */
  setHostEndpoint(port: number, token: string) {
    this.hostEndpoint = { port, token };
  }

  /** The BetterCodex app on this machine offers its browser (it started, or became interactive). */
  registerApp(reg: AppBrowserRegistration) {
    const previous = this.status.appInstanceId;
    this.app = reg;
    rememberLauncher(reg.launch);
    for (const resolve of this.appWaiters.splice(0)) resolve();
    if (this.getConfig().browser.engine === 'chromium') return;
    if (this.launching) {
      // Decide once the launch in progress has settled (it may be starting Chromium).
      void this.launching.then(
        () => this.app === reg && this.registerApp(reg),
        () => {},
      );
      return;
    }
    if (!this.context) {
      // A window is open: connect now so tabs it still has show up live right away.
      if (!reg.background && !this.launching) void this.ensure().catch((err) => log.warn('connecting to the app browser failed', errorMessage(err)));
      return;
    }
    // Move over to the app: from the host-run Chromium, or from another copy of the app.
    if (this.engine === 'chromium' || previous !== reg.instanceId) {
      log.info(`switching the browser to the BetterCodex app (${reg.background ? 'background' : 'window'})`);
      void this.restart().catch((err) => log.warn('switching to the app browser failed', errorMessage(err)));
    }
  }

  private appAlive() {
    return !!this.app && isPidAlive(this.app.pid);
  }

  private pickEngine(): 'app' | 'chromium' {
    const engine = this.getConfig().browser.engine;
    if (engine === 'chromium' || engine === 'app') return engine;
    return this.appAlive() || appLauncher() ? 'app' : 'chromium';
  }

  private async launch(): Promise<BrowserContext> {
    if (this.pickEngine() === 'app') {
      try {
        return await this.launchApp();
      } catch (err) {
        // A running app that cannot be reached right now (quitting, busy) is retried next time;
        // only a machine where the app cannot run at all falls back to the host's Chromium.
        if (this.getConfig().browser.engine === 'app' || !(err instanceof AppUnavailable)) {
          this.setStatus({ state: 'error', error: errorMessage(err) });
          throw err;
        }
        log.warn('the BetterCodex app browser is not available, using Chromium:', errorMessage(err));
      }
    }
    return this.launchChromium();
  }

  private async launchApp(): Promise<BrowserContext> {
    this.setStatus({ state: 'launching', engine: 'app', error: null });
    if (!this.appAlive()) {
      const launch = this.app?.launch ?? appLauncher();
      if (!launch) throw new AppUnavailable('The BetterCodex app is not installed on this machine');
      if (!this.hostEndpoint) throw new Error('The host is not listening yet');
      this.app = null;
      this.appDisplay?.process.kill();
      this.appDisplay = null;
      try {
        const started = await launchAppInBackground(launch, this.hostEndpoint, () => new Promise<void>((resolve) => this.appWaiters.push(resolve)));
        if (started.display) {
          // The virtual display belongs to that app process: release it when the app ends.
          const display = started.display;
          this.appDisplay = display;
          started.exited.then(() => {
            display.process.kill();
            if (this.appDisplay === display) this.appDisplay = null;
          });
        }
      } catch (err) {
        throw new AppUnavailable(errorMessage(err));
      }
    }
    const reg = this.app!;
    const browser = await chromium.connectOverCDP(reg.url, { timeout: 30000 });
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error('The app browser has no context');
      const control = await browser.newBrowserCDPSession();
      const send = control.send.bind(control) as (method: string, params?: object) => Promise<any>;
      const on = control.on.bind(control) as (event: string, fn: (e: any) => void) => void;
      // Dialogs arrive as regular Playwright dialogs; this only says when one was answered in the app.
      on('BetterCodex.dialogClosed', (e: { targetId: string | null }) => this.onAppDialogClosed(e.targetId));
      await send('BetterCodex.enable', { downloadsDir: paths.downloads });
      this.appConnection = browser;
      this.control = control;
      this.context = context;
      this.engine = 'app';
      this.keepAlive = null;
      browser.on('disconnected', () => this.onContextClosed(context));
      context.on('page', (page) => this.onPage(page));
      // Tabs the app kept open while the host restarted come back to their records.
      for (const page of context.pages()) await this.adoptExisting(page);
      this.setStatus({ state: 'running', engine: 'app', appInstanceId: reg.instanceId, executablePath: reg.launch.exec, mode: 'app', version: browser.version(), error: null, sandboxed: reg.sandboxed !== false });
      log.info(`using the BetterCodex app browser (pid ${reg.pid}${reg.background ? ', background' : ''})`);
      return context;
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }

  private async launchChromium(): Promise<BrowserContext> {
    const config = this.getConfig().browser;
    this.setStatus({ state: 'launching', engine: 'chromium', appInstanceId: null, error: null });
    try {
      let executablePath = findBrowser(config.executablePath);
      if (!executablePath) executablePath = await installChromium();
      if (!executablePath) throw new Error('No Chrome or Chromium found and the automatic download failed.');
      this.display?.process.kill();
      this.display = null;
      const { headless, display } = await resolveMode(config.mode);
      this.display = display;
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (display) {
        // With WAYLAND_DISPLAY set Chrome picks Wayland and opens its windows on the user's desktop.
        env.DISPLAY = display.display;
        delete env.WAYLAND_DISPLAY;
      }
      log.info(`launching browser ${executablePath} (${headless ? 'headless' : `headful ${env.DISPLAY ?? ''}`})`);
      await killStaleBrowsers(paths.profile);
      for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(paths.profile, lock), { force: true });
      const args = [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--hide-crash-restore-bubble',
        '--window-size=1400,1000',
      ];
      if (display) args.push('--ozone-platform=x11');
      // Headless Chrome advertises itself in the user agent, which some sites (Google sign-in) refuse.
      if (headless) args.push(`--user-agent=${await desktopUserAgent(executablePath)}`);
      const options = {
        executablePath,
        headless,
        env,
        viewport: DEFAULT_VIEWPORT,
        deviceScaleFactor: config.deviceScaleFactor,
        acceptDownloads: true,
        downloadsPath: paths.downloads,
        ignoreDefaultArgs: ['--enable-automation', '--disable-extensions', '--disable-component-extensions-with-background-pages'],
        args,
      };
      // Keep Chromium's own sandbox on (pages hold real sign-ins); some Linux setups (AppArmor
      // user-namespace restrictions, no setuid helper) cannot start it, then fall back.
      let context: BrowserContext;
      let sandboxed = sandboxSupported(executablePath);
      if (!sandboxed) log.warn('Chromium sandbox is not available on this machine; running the browser without it');
      try {
        context = await chromium.launchPersistentContext(paths.profile, { ...options, chromiumSandbox: sandboxed });
      } catch (err) {
        if (!sandboxed) throw err;
        log.warn('browser failed to start with its sandbox, retrying without:', errorMessage(err).split('\n')[0]);
        sandboxed = false;
        await killStaleBrowsers(paths.profile);
        for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(paths.profile, lock), { force: true });
        context = await chromium.launchPersistentContext(paths.profile, { ...options, chromiumSandbox: false });
      }
      const version = context.browser()?.version() ?? (await browserVersion(executablePath));
      this.context = context;
      this.engine = 'chromium';
      this.keepAlive = null;
      context.on('page', (page) => this.onPage(page));
      context.on('close', () => this.onContextClosed(context));
      for (const page of context.pages()) this.onPage(page);
      this.setStatus({ state: 'running', executablePath, mode: headless ? 'headless' : 'headful', version, error: null, sandboxed });
      return context;
    } catch (err) {
      this.display?.process.kill();
      this.display = null;
      this.setStatus({ state: 'error', error: errorMessage(err) });
      throw err;
    }
  }

  private async pollTitles() {
    const recent = Date.now() - 10 * 60_000;
    for (const tab of this.tabs.values()) {
      if (!tab.page || tab.page.isClosed() || tab.lastActiveAt < recent || tab.dialog) continue;
      const title = await tab.page.title().catch(() => tab.title);
      if (title !== tab.title) {
        tab.title = title;
        this.changed();
      }
    }
  }

  private onContextClosed(context: BrowserContext) {
    if (this.context !== context) return;
    if (!this.closing) log.warn(this.engine === 'app' ? 'the BetterCodex app browser went away' : 'browser closed unexpectedly');
    this.context = null;
    this.keepAlive = null;
    this.display?.process.kill();
    this.display = null;
    if (this.engine === 'app') {
      this.appConnection = null;
      this.control = null;
      if (this.app && !isPidAlive(this.app.pid)) {
        this.app = null;
        this.appDisplay?.process.kill();
        this.appDisplay = null;
      }
    }
    this.engine = null;
    for (const tab of this.tabs.values()) {
      tab.page = null;
      tab.dialog = null;
      tab.loading = false;
    }
    this.setStatus({ state: 'idle' });
    this.changed();
  }

  /** Closes the host-run Chromium, or just disconnects from the app (its tabs stay open). */
  private async closeBrowser() {
    if (this.engine === 'app') await this.appConnection?.close().catch(() => {});
    else await this.context?.close().catch(() => {});
  }

  async shutdown() {
    this.flush();
    this.closing = true;
    await this.closeBrowser();
    this.display?.process.kill();
    // A background app on our virtual display cannot outlive it; the next host starts a new one.
    this.appDisplay?.process.kill();
  }

  /** Lets go of the browser; the next tab use starts whichever engine is configured then. */
  async reset() {
    this.flush();
    this.closing = true;
    try {
      await this.closeBrowser();
    } finally {
      this.closing = false;
    }
    if (this.context) this.onContextClosed(this.context);
  }

  async restart() {
    this.flush();
    this.closing = true;
    try {
      await this.closeBrowser();
    } finally {
      this.closing = false;
    }
    if (this.context) this.onContextClosed(this.context);
    await this.ensure();
  }

  private setStatus(patch: Partial<BrowserStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  // ---------- tabs ----------

  list(threadId?: string | null): TabInfo[] {
    const all = [...this.tabs.values()].map((t) => this.info(t));
    return threadId === undefined ? all : all.filter((t) => t.threadId === threadId);
  }

  get(tabId: string) {
    return this.tabs.get(tabId) ?? null;
  }

  info(t: TabRecord): TabInfo {
    return {
      id: t.id,
      threadId: t.threadId,
      url: t.page && !t.page.isClosed() ? t.page.url() : t.url,
      title: t.title,
      faviconUrl: t.faviconUrl,
      loading: t.loading,
      sleeping: !t.page,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      lastActiveAt: t.lastActiveAt,
      agentActive: t.agentCalls > 0,
      dialog: t.dialog ? dialogInfo(t.dialog) : null,
      targetId: t.page && this.engine === 'app' ? t.targetId : null,
    };
  }

  quality() {
    return this.getConfig().browser.jpegQuality;
  }

  /** The thread's working tab: the one it last selected (any thread's tab), else its newest own tab. */
  currentTabId(threadId: string): string | null {
    const id = this.current[threadId];
    if (id && this.tabs.has(id)) return id;
    const own = [...this.tabs.values()].filter((t) => t.threadId === threadId).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return own[0]?.id ?? null;
  }

  setCurrent(threadId: string, tabId: string) {
    this.current[threadId] = tabId;
    const tab = this.tabs.get(tabId);
    if (tab) tab.lastActiveAt = Date.now();
    this.changed();
  }

  /** Records that someone is looking at or using the tab (keeps its title fresh). */
  touch(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (tab) tab.lastActiveAt = Date.now();
  }

  /** Opens a tab owned by `threadId`. Serialized so concurrent opens get the right owner. */
  async newTab(threadId: string | null, url: string | undefined, createdBy: TabInfo['createdBy']): Promise<TabRecord> {
    const run = async () => {
      const context = await this.ensure();
      this.pendingOwner = { threadId, createdBy };
      let page: Page;
      try {
        page = await context.newPage();
      } finally {
        this.pendingOwner = null;
      }
      const tab = this.byPage.get(page) ?? this.adoptPage(page, { threadId, createdBy });
      if (threadId) this.current[threadId] = tab.id;
      if (url) await this.goto(tab, url);
      this.changed();
      return tab;
    };
    const result = this.creation.then(run, run);
    this.creation = result.catch(() => {});
    return result;
  }

  /** Returns a live page for the tab, waking it up from the persisted URL if needed. */
  async page(tabId: string): Promise<Page> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} does not exist`);
    if (tab.page && !tab.page.isClosed()) return tab.page;
    const run = async () => {
      if (tab.page && !tab.page.isClosed()) return tab.page;
      const context = await this.ensure();
      // Connecting may have found the tab's page still open in the app.
      if (tab.page && !tab.page.isClosed()) return tab.page;
      this.pendingOwner = { threadId: tab.threadId, createdBy: tab.createdBy, record: tab };
      let page: Page;
      try {
        page = await context.newPage();
      } finally {
        this.pendingOwner = null;
      }
      if (this.byPage.get(page) !== tab) this.attachPage(tab, page);
      if (tab.url && tab.url !== 'about:blank') {
        await page.goto(tab.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => log.warn('wake tab', tab.id, errorMessage(err)));
      }
      this.changed();
      return page;
    };
    const result = this.creation.then(run, run);
    this.creation = result.catch(() => {});
    return result as Promise<Page>;
  }

  async goto(tab: TabRecord, url: string) {
    const page = await this.page(tab.id);
    const target = normalizeUrl(url);
    tab.url = target;
    tab.loading = true;
    this.changed();
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } finally {
      tab.loading = false;
      this.changed();
    }
  }

  async close(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    for (const [thread, id] of Object.entries(this.current)) if (id === tabId) delete this.current[thread];
    await tab.page?.close({ runBeforeUnload: false }).catch(() => {});
    this.changed();
  }

  assign(tabId: string, threadId: string | null) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} does not exist`);
    tab.threadId = threadId;
    if (threadId) this.current[threadId] = tabId;
    this.changed();
  }

  /** Marks a tab as being driven by the agent (shown in the UI) for the duration of `fn`. */
  async withAgent<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.agentCalls++;
      this.changed();
    }
    try {
      return await fn();
    } finally {
      if (tab) {
        tab.agentCalls--;
        tab.lastActiveAt = Date.now();
        this.changed();
      }
    }
  }

  async handleDialog(tabId: string, accept: boolean, promptText?: string) {
    const tab = this.tabs.get(tabId);
    const dialog = tab?.dialog;
    if (!tab || !dialog) throw new Error('No dialog is open in this tab');
    tab.dialog = null;
    this.changed();
    if (accept) await dialog.accept(promptText ?? dialog.defaultValue());
    else await dialog.dismiss();
  }

  async resolveFileChooser(tabId: string, files: string[]) {
    const tab = this.tabs.get(tabId);
    const chooser = tab?.fileChooser;
    if (!tab || !chooser) throw new Error('No file chooser is open in this tab');
    tab.fileChooser = null;
    if (files.length) await chooser.setFiles(files);
  }

  consoleOf(tabId: string) {
    return this.tabs.get(tabId)?.console ?? [];
  }

  private onPage(page: Page) {
    // The first blank page nobody asked for is Chrome's startup tab.
    if (this.engine === 'chromium' && !this.keepAlive && !this.pendingOwner && page.url() === 'about:blank') {
      this.keepAlive = page;
      page.once('close', () => {
        if (this.keepAlive === page) this.keepAlive = null;
      });
      return;
    }
    this.adoptPage(page);
  }

  private adoptPage(page: Page, owner?: { threadId: string | null; createdBy: TabInfo['createdBy']; record?: TabRecord }): TabRecord {
    const existing = this.byPage.get(page);
    if (existing) return existing;
    let resolved = owner ?? this.pendingOwner;
    if (resolved?.record) {
      this.attachPage(resolved.record, page);
      return resolved.record;
    }
    if (!resolved) {
      // A page opened by another page (window.open / target=_blank) joins its opener's thread.
      resolved = { threadId: null, createdBy: 'page' };
      void page.opener().then((opener) => {
        const parent = opener ? this.byPage.get(opener) : null;
        const tab = this.byPage.get(page);
        if (parent && tab && tab.threadId === null) {
          tab.threadId = parent.threadId;
          if (parent.threadId) this.current[parent.threadId] = tab.id;
          this.changed();
          this.emit('popup', { tabId: tab.id, threadId: parent.threadId, openerTabId: parent.id });
        }
      });
    }
    const id = `t${this.nextId++}`;
    const now = Date.now();
    const tab: TabRecord = {
      id,
      threadId: resolved.threadId,
      url: page.url(),
      title: '',
      faviconUrl: null,
      createdBy: resolved.createdBy,
      createdAt: now,
      lastActiveAt: now,
      page: null,
      targetId: null,
      loading: false,
      dialog: null,
      agentCalls: 0,
      console: [],
      fileChooser: null,
    };
    this.tabs.set(id, tab);
    this.attachPage(tab, page);
    this.changed();
    return tab;
  }

  private attachPage(tab: TabRecord, page: Page) {
    tab.page = page;
    this.byPage.set(page, tab);
    if (this.engine === 'app') void this.resolveTargetId(tab, page);
    const refresh = async () => {
      if (page.isClosed()) return;
      tab.url = page.url();
      tab.title = await page.title().catch(() => tab.title);
      tab.faviconUrl = await page
        .evaluate(() => {
          const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"], link[rel="shortcut icon"]');
          if (link?.href) return link.href;
          return location.protocol.startsWith('http') ? `${location.origin}/favicon.ico` : null;
        })
        .catch(() => tab.faviconUrl);
      this.changed();
    };
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      tab.url = page.url();
      tab.loading = true;
      this.changed();
      // Single-page apps navigate within the document: no load event follows, so ask the page.
      void Promise.race([page.evaluate(() => document.readyState), new Promise<null>((r) => setTimeout(() => r(null), 3000))])
        .then((state) => {
          if (state && state !== 'loading' && tab.page === page && tab.loading) {
            tab.loading = false;
            this.changed();
          }
        })
        .catch(() => {});
    });
    page.on('domcontentloaded', () => {
      tab.loading = false;
      void refresh();
    });
    page.on('load', () => {
      tab.loading = false;
      void refresh();
    });
    page.on('close', () => {
      if (tab.page !== page) return;
      tab.page = null;
      tab.dialog = null;
      this.changed();
      // A page closed by the site or the user removes its tab; the whole browser going away
      // (shutdown, restart, crash) keeps the tab so it can be restored later.
      const context = this.context;
      setTimeout(() => {
        // Only a page closing inside a still-running browser means the tab is gone; after a crash
        // the browser may already have been relaunched (a new context) by the time this runs.
        if (this.closing || !this.context || this.context !== context || tab.page) return;
        if (this.engine === 'chromium' && context?.pages().length === 0) return;
        this.tabs.delete(tab.id);
        for (const [thread, id] of Object.entries(this.current)) if (id === tab.id) delete this.current[thread];
        this.changed();
      }, 400);
    });
    page.on('console', (msg) => {
      const loc = msg.location();
      pushConsole(tab, { time: Date.now(), type: msg.type(), text: msg.text(), location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined });
    });
    page.on('pageerror', (err) => pushConsole(tab, { time: Date.now(), type: 'pageerror', text: err.stack || err.message }));
    page.on('dialog', (dialog) => {
      tab.dialog = dialog;
      this.changed();
      this.emit('dialog', { tabId: tab.id, threadId: tab.threadId, dialog: dialogInfo(dialog) });
    });
    // A streamed tab needs the watching client to pick files; the app shows its own picker otherwise.
    this.syncFileChooser(tab);
    page.on('download', (download) => void this.onDownload(tab, download));
    void refresh();
  }

  // ---------- app browser ----------

  private async targetIdOf(page: Page) {
    if (!this.context) throw new Error('browser is not running');
    const session = await this.context.newCDPSession(page);
    try {
      return ((await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId;
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async resolveTargetId(tab: TabRecord, page: Page) {
    try {
      const targetId = await this.targetIdOf(page);
      if (tab.page !== page) return;
      tab.targetId = targetId;
      this.changed();
    } catch (err) {
      if (!page.isClosed()) log.debug('could not resolve the tab target', errorMessage(err));
    }
  }

  private async adoptExisting(page: Page) {
    if (this.byPage.has(page)) return;
    const targetId = await this.targetIdOf(page).catch(() => null);
    if (this.byPage.has(page)) return;
    const record = targetId ? [...this.tabs.values()].find((t) => t.targetId === targetId && !t.page) : undefined;
    if (record) this.attachPage(record, page);
    else this.adoptPage(page, { threadId: null, createdBy: 'page' });
  }

  private onAppDialogClosed(targetId: string | null) {
    for (const tab of this.tabs.values()) {
      if (tab.dialog && tab.targetId === targetId) {
        tab.dialog = null;
        this.changed();
      }
    }
  }

  /** Called by the stream and sync hubs when clients start or stop watching a tab. */
  setRemoteViewers(tabId: string, source: 'stream' | 'sync', count: number) {
    const viewers = { ...(this.remoteViewers.get(tabId) ?? { stream: 0, sync: 0 }), [source]: count };
    if (viewers.stream + viewers.sync > 0) this.remoteViewers.set(tabId, viewers);
    else this.remoteViewers.delete(tabId);
    const tab = this.tabs.get(tabId);
    if (tab) this.syncFileChooser(tab);
  }

  private chooserListeners = new WeakMap<Page, (chooser: FileChooser) => void>();

  /** File pickers are intercepted for host-run Chromium and for app tabs someone streams. */
  private syncFileChooser(tab: TabRecord) {
    const page = tab.page;
    if (!page || page.isClosed()) return;
    const want = this.engine !== 'app' || this.remoteViewers.has(tab.id);
    const current = this.chooserListeners.get(page);
    if (want && !current) {
      const listener = (chooser: FileChooser) => {
        tab.fileChooser = chooser;
        this.emit('filechooser', { tabId: tab.id, threadId: tab.threadId, multiple: chooser.isMultiple(), agentActive: tab.agentCalls > 0 });
      };
      this.chooserListeners.set(page, listener);
      page.on('filechooser', listener);
    } else if (!want && current) {
      this.chooserListeners.delete(page);
      page.off('filechooser', current);
    }
  }

  /** Resizes a tab that is not shown in the app window, for a client streaming it. */
  async resizeAppTab(tabId: string, width: number, height: number) {
    const tab = this.tabs.get(tabId);
    if (this.engine !== 'app' || !this.control || !tab?.targetId) return false;
    const send = this.control.send.bind(this.control) as (m: string, p: object) => Promise<unknown>;
    await send('BetterCodex.setTabSize', { targetId: tab.targetId, width, height }).catch(() => {});
    return true;
  }

  private async onDownload(tab: TabRecord, download: Download) {
    const info: DownloadInfo = {
      id: crypto.randomUUID(),
      tabId: tab.id,
      threadId: tab.threadId,
      url: download.url(),
      filename: download.suggestedFilename(),
      path: uniquePath(paths.downloads, download.suggestedFilename()),
      state: 'inProgress',
      error: null,
      createdAt: Date.now(),
    };
    this.downloads.unshift(info);
    this.downloads.splice(100);
    this.emit('download', info);
    try {
      await download.saveAs(info.path);
      info.state = 'completed';
    } catch (err) {
      info.state = 'failed';
      info.error = errorMessage(err);
    }
    this.emit('download', info);
  }

  private changed() {
    if (!this.changeTimer) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null;
        this.emit('tabs', this.list());
      }, 50);
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, 1000);
    }
  }

  private flush() {
    const data: PersistedTabs = {
      nextId: this.nextId,
      current: this.current,
      tabs: [...this.tabs.values()].map((t) => ({
        id: t.id,
        threadId: t.threadId,
        targetId: t.targetId,
        url: t.page && !t.page.isClosed() ? t.page.url() : t.url,
        title: t.title,
        faviconUrl: t.faviconUrl,
        createdBy: t.createdBy,
        createdAt: t.createdAt,
        lastActiveAt: t.lastActiveAt,
      })),
    };
    try {
      writeJson(paths.tabs, data);
    } catch (err) {
      log.warn('could not persist tabs', errorMessage(err));
    }
  }
}

function browserVersion(executable: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: 10000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function desktopUserAgent(executable: string) {
  const version = await browserVersion(executable);
  const major = /(\d+)\.\d+/.exec(version ?? '')?.[1] ?? '140';
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function pushConsole(tab: TabRecord, entry: ConsoleEntry) {
  tab.console.push(entry);
  if (tab.console.length > CONSOLE_LIMIT) tab.console.splice(0, tab.console.length - CONSOLE_LIMIT);
}

function dialogInfo(dialog: Dialog): TabDialog {
  return { type: dialog.type() as TabDialog['type'], message: dialog.message(), defaultValue: dialog.defaultValue() };
}

function uniquePath(dir: string, filename: string) {
  const safe = filename.replace(/[/\\]/g, '_') || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

/** The app could not be started on this machine (as opposed to a running app being unreachable). */
class AppUnavailable extends Error {}

export function normalizeUrl(input: string) {
  const url = input.trim();
  if (!url) return 'about:blank';
  // host:port first, otherwise "localhost:3000" would look like a URL with scheme "localhost".
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(url)) return `http://${url}`;
  if (/^[\w.-]+:\d+([/?#]|$)/.test(url)) return `http://${url}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^[^\s/]+\.[^\s/]{2,}([/?#].*)?$/.test(url)) return `https://${url}`;
  return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
}
