// Pages opened in the browser (on any machine, by the person or by Codex), remembered on this
// computer so the address bar can complete and suggest them like any browser does.
import { displayUrl } from '../../shared/address';
import type { TabInfo } from '../../shared/types';

const STORAGE_KEY = 'bettercodex.history';
const MAX_ENTRIES = 1500;

export interface Visit {
  url: string;
  title: string;
  icon: string | null;
  visits: number;
  /** Times it was opened by typing in the address bar. */
  typed: number;
  last: number;
}

export interface Site {
  /** The site's address without "www.", as completed in the address bar. */
  host: string;
  url: string;
  title: string;
  icon: string | null;
  score: number;
}

const visits = load();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as Visit[];
    return new Map(list.map((v) => [v.url, v]));
  } catch {
    return new Map<string, Visit>();
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    let list = [...visits.values()];
    if (list.length > MAX_ENTRIES) {
      list = list.sort((a, b) => score(b) - score(a)).slice(0, MAX_ENTRIES);
      visits.clear();
      for (const v of list) visits.set(v.url, v);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }, 1000);
}

const remembered = (url: string) => /^https?:\/\//i.test(url);

function hostOf(url: string) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Frequent, typed and recent pages first; a visit counts less as weeks go by. */
function score(v: Visit) {
  const weeks = (Date.now() - v.last) / (7 * 864e5);
  return (v.visits + v.typed * 4) / (1 + weeks);
}

function upsert(url: string, fn: (v: Visit) => void) {
  const v = visits.get(url) ?? { url, title: '', icon: null, visits: 0, typed: 0, last: Date.now() };
  fn(v);
  visits.set(url, v);
  save();
}

/** Follows the tabs of a machine: a tab showing a new page is a visit. */
export function noteTabs(before: TabInfo[], after: TabInfo[]) {
  const prev = new Map(before.map((t) => [t.id, t]));
  for (const tab of after) {
    if (!remembered(tab.url)) continue;
    const old = prev.get(tab.id);
    // Tabs seen for the first time (on connecting) were visited before, unless the page is new here.
    const visited = old ? old.url !== tab.url : !visits.has(tab.url);
    if (!visited && (tab.loading || (tab.title === old?.title && tab.faviconUrl === old?.faviconUrl))) continue;
    upsert(tab.url, (v) => {
      if (visited) {
        v.visits++;
        v.last = Date.now();
      }
      // While loading, the title and icon can still be the previous page's.
      if (tab.loading) return;
      if (tab.title) v.title = tab.title;
      if (tab.faviconUrl) v.icon = tab.faviconUrl;
    });
  }
}

/** The person typed (or picked) this address in the address bar. */
export function noteTyped(url: string) {
  if (!remembered(url)) return;
  upsert(url, (v) => {
    v.typed++;
    v.last = Date.now();
  });
}

/** Sites visited, best first, with the address of their most used page's origin. */
export function sites(): Site[] {
  const byHost = new Map<string, Site & { best: number }>();
  for (const v of visits.values()) {
    const host = hostOf(v.url);
    if (!host) continue;
    const s = score(v);
    const site = byHost.get(host);
    const root = /^https?:\/\/[^/]+\/?$/i.test(v.url);
    if (!site) {
      byHost.set(host, { host, url: new URL(v.url).origin, title: root ? v.title : '', icon: v.icon, score: s, best: s });
      continue;
    }
    site.score += s;
    if (root && v.title) site.title = v.title;
    if (s > site.best) {
      site.best = s;
      site.url = new URL(v.url).origin;
      site.icon = v.icon ?? site.icon;
    }
  }
  return [...byHost.values()].sort((a, b) => b.score - a.score);
}

/**
 * The address the typed text most likely means, for completing it in place: a site while only a
 * host is typed, a page once a path is. `text` is what to show, `url` what to open.
 */
export function completion(typed: string): { text: string; url: string } | null {
  if (!typed || /\s/.test(typed)) return null;
  const lower = typed.toLowerCase();
  // People type "github", "www.github" or "https://github"; complete each the way it was started.
  const scheme = /^https?:\/\//i.exec(lower)?.[0] ?? '';
  const www = lower.slice(scheme.length).startsWith('www.') ? 'www.' : '';
  const bare = lower.slice(scheme.length + www.length);
  if (!bare) return null;
  if (bare.includes('/')) {
    let best: Visit | null = null;
    for (const v of visits.values()) {
      if (displayUrl(v.url).toLowerCase().startsWith(bare) && (!best || score(v) > score(best))) best = v;
    }
    if (!best) return null;
    return { text: typed + displayUrl(best.url).slice(bare.length), url: asTyped(best.url, scheme, www) };
  }
  const site = sites().find((s) => s.host.startsWith(bare));
  if (!site) return null;
  return { text: typed + site.host.slice(bare.length), url: asTyped(site.url, scheme, www) };
}

/** A remembered address with the scheme and "www." the person typed, when they typed them. */
function asTyped(url: string, scheme: string, www: string) {
  if (!scheme && !www) return url;
  const u = new URL(url);
  if (scheme) u.protocol = scheme.slice(0, -2);
  if (www && !u.hostname.startsWith('www.')) u.hostname = `www.${u.hostname}`;
  return u.toString();
}

/** Visited pages whose address or title has every typed word, best first. */
export function searchVisits(typed: string, limit: number): Visit[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const found: Array<{ v: Visit; prefix: boolean; s: number }> = [];
  for (const v of visits.values()) {
    const address = displayUrl(v.url).toLowerCase();
    const hay = `${address} ${v.title.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    found.push({ v, prefix: address.startsWith(words[0]), s: score(v) });
  }
  return found
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || b.s - a.s)
    .slice(0, limit)
    .map((f) => f.v);
}
