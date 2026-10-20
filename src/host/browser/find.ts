// Find in page for streamed tabs. Chromium's own find is not reachable over CDP, so the page is
// searched by a script, run in an isolated world (page scripts cannot see the query or tamper with
// the search) and without state in the page: the host remembers the query and the current match.
import type { CDPSession } from 'playwright-core';

export interface FindResult {
  matches: number;
  /** 1-based; 0 when nothing matches. */
  active: number;
}

/**
 * Runs in the page (self-contained): marks every match of `text` and the `index`th one (wrapped
 * around), scrolls that one into view and reports the count. An empty `text` removes the marks.
 */
const MARK_MATCHES = ({ text, index }: { text: string; index: number }): FindResult => {
  const registry = (globalThis as any).CSS?.highlights;
  const Mark = (globalThis as any).Highlight;
  if (!text) {
    registry?.delete('bettercodex-find');
    registry?.delete('bettercodex-find-active');
    document.getElementById('__bettercodex-find')?.remove();
    return { matches: 0, active: 0 };
  }
  // Lowercase per UTF-16 unit, keeping the length, so offsets in the folded text are offsets in the page.
  const fold = (s: string) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const lower = s[i].toLowerCase();
      out += lower.length === 1 ? lower : s[i];
    }
    return out;
  };
  // The page's visible text in order, with a break between blocks so matches do not span them.
  const blockOf = new Map<Element, Element>();
  const block = (el: Element) => {
    let found = blockOf.get(el);
    if (found) return found;
    found = el;
    while (found.parentElement && getComputedStyle(found).display.startsWith('inline')) found = found.parentElement;
    blockOf.set(el, found);
    return found;
  };
  const nodes: Array<{ node: Text; start: number }> = [];
  let all = '';
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || !parent.getClientRects().length) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const b = block(node.parentElement!);
    if (lastBlock && b !== lastBlock) all += '\n';
    lastBlock = b;
    nodes.push({ node, start: all.length });
    all += node.data;
  }
  const at = (offset: number, end: boolean) => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid].start < offset || (!end && nodes[mid].start === offset)) lo = mid;
      else hi = mid - 1;
    }
    return { node: nodes[lo].node, offset: offset - nodes[lo].start };
  };
  const hay = fold(all);
  const needle = fold(text);
  const ranges: Range[] = [];
  for (let i = hay.indexOf(needle); i >= 0 && ranges.length < 1000; i = hay.indexOf(needle, i + needle.length)) {
    const from = at(i, false);
    const to = at(i + needle.length, true);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    ranges.push(range);
  }
  const current = ranges.length ? ((index % ranges.length) + ranges.length) % ranges.length : -1;
  const active = ranges[current];
  if (registry && Mark) {
    if (!document.getElementById('__bettercodex-find')) {
      const style = document.createElement('style');
      style.id = '__bettercodex-find';
      style.textContent = '::highlight(bettercodex-find){background:#fde047;color:#000}::highlight(bettercodex-find-active){background:#f97316;color:#000}';
      document.documentElement.appendChild(style);
    }
    registry.set('bettercodex-find', new Mark(...ranges));
    registry.set('bettercodex-find-active', new Mark(...(active ? [active] : [])));
  }
  if (active) {
    // Bring the match itself into view: inside scrolling boxes first, then the page.
    for (let el = active.startContainer.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(style.overflowX + style.overflowY)) continue;
      const r = active.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) el.scrollTop += r.top - box.top - (box.height - r.height) / 2;
      if (r.left < box.left || r.right > box.right) el.scrollLeft += r.left - box.left - (box.width - r.width) / 2;
    }
    const r = active.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) scrollBy(0, r.top - (innerHeight - r.height) / 2);
    if (r.left < 0 || r.right > innerWidth) scrollBy(r.left - (innerWidth - r.width) / 2, 0);
  }
  return { matches: ranges.length, active: current + 1 };
};

/** The query and current match of each streamed tab's find bar. */
const searches = new Map<string, { text: string; index: number }>();

export async function findInPage(tabId: string, cdp: () => Promise<CDPSession>, opts: { text: string; forward: boolean; again: boolean }): Promise<FindResult> {
  const last = searches.get(tabId);
  const index = opts.again && last?.text === opts.text ? last.index + (opts.forward ? 1 : -1) : 0;
  const session = await cdp();
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'bettercodex-find' });
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
      functionDeclaration: MARK_MATCHES.toString(),
      executionContextId,
      arguments: [{ value: { text: opts.text, index } }],
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    const found = result.value as FindResult;
    if (opts.text) searches.set(tabId, { text: opts.text, index: Math.max(found.active - 1, 0) });
    else searches.delete(tabId);
    return found;
  } finally {
    await session.detach().catch(() => {});
  }
}
