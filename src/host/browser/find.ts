// Find in page for streamed tabs. Chromium's own find is not reachable over CDP, so the page is
// searched by a script run in an isolated world: page scripts cannot see the query or the matches
// kept between steps, nor tamper with the search.
import type { CDPSession } from 'playwright-core';

export interface FindResult {
  matches: number;
  /** 1-based; 0 when nothing matches. */
  active: number;
}

/**
 * Runs in the page's isolated world (self-contained). A new `text` (or `step` null) starts a search
 * at the first match; a `step` of 1 or -1 moves to the next or previous one. The matches stay in the
 * isolated world until the query or the page's content changes. An empty `text` removes the marks.
 */
const MARK_MATCHES = ({ text, step }: { text: string; step: 1 | -1 | null }): FindResult => {
  const g = globalThis as any;
  const registry = g.CSS?.highlights;
  const Mark = g.Highlight;
  type State = { text: string; ranges: Range[]; index: number; dirty: boolean; observer: MutationObserver; resized: () => void };
  // Only this world's own property: elements with that id show up on window too, in every world.
  let st: State | undefined = Object.hasOwn(g, '__bettercodexFind') ? g.__bettercodexFind : undefined;
  if (!text) {
    registry?.delete('bettercodex-find');
    registry?.delete('bettercodex-find-active');
    document.getElementById('__bettercodex-find')?.remove();
    if (st) {
      st.observer.disconnect();
      removeEventListener('resize', st.resized);
    }
    delete g.__bettercodexFind;
    return { matches: 0, active: 0 };
  }
  if (!st) {
    const fresh: State = { text: '', ranges: [], index: -1, dirty: true, observer: new MutationObserver(() => (fresh.dirty = true)), resized: () => (fresh.dirty = true) };
    // What is visible changes with the content and with the viewport (zoom, panel size, media queries).
    fresh.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    addEventListener('resize', fresh.resized);
    Object.defineProperty(g, '__bettercodexFind', { value: fresh, configurable: true });
    st = fresh;
  }
  // Next and Previous move on within the same search; anything else starts at its first match.
  const continuing = step !== null && st.text === text && st.index >= 0;
  if (st.dirty || st.text !== text || step === null) {
    // Lowercase per code point, keeping its length, so offsets in the folded text are offsets in the page.
    const fold = (s: string) => {
      let out = '';
      for (const ch of s) {
        const lower = ch.toLowerCase();
        out += lower.length === ch.length ? lower : ch;
      }
      return out;
    };
    // The page's visible text in order, with a break between blocks and at <br>, so matches do not span them.
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
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (/^(script|style|noscript|template)$/i.test(el.tagName)) return NodeFilter.FILTER_REJECT;
          return el.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return node.parentElement?.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        all += '\n';
        continue;
      }
      const b = block(node.parentElement!);
      if (lastBlock && b !== lastBlock) all += '\n';
      lastBlock = b;
      nodes.push({ node: node as Text, start: all.length });
      all += (node as Text).data;
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
    st.text = text;
    st.ranges = ranges;
  }
  const n = st.ranges.length;
  st.index = !n ? -1 : continuing ? (((st.index + step!) % n) + n) % n : 0;
  const active = st.ranges[st.index];
  if (registry && Mark) {
    if (!document.getElementById('__bettercodex-find')) {
      const style = document.createElement('style');
      style.id = '__bettercodex-find';
      style.textContent = '::highlight(bettercodex-find){background:#fde047;color:#000}::highlight(bettercodex-find-active){background:#f97316;color:#000}';
      document.documentElement.appendChild(style);
    }
    registry.set('bettercodex-find', new Mark(...st.ranges));
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
  // Our own marks are not a change of the page's content.
  st.observer.takeRecords();
  st.dirty = false;
  return { matches: n, active: st.index + 1 };
};

/** Searches of one tab run one after another, each moving on from where the previous one ended. */
const queues = new Map<string, Promise<unknown>>();

export function findInPage(tabId: string, cdp: () => Promise<CDPSession>, opts: { text: string; forward: boolean; again: boolean }): Promise<FindResult> {
  const run = async () => {
    const session = await cdp();
    try {
      const { frameTree } = await session.send('Page.getFrameTree');
      const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'bettercodex-find' });
      const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
        functionDeclaration: MARK_MATCHES.toString(),
        executionContextId,
        arguments: [{ value: { text: opts.text, step: opts.again ? (opts.forward ? 1 : -1) : null } }],
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value as FindResult;
    } finally {
      await session.detach().catch(() => {});
    }
  };
  const next = (queues.get(tabId) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => {});
  queues.set(tabId, settled);
  void settled.then(() => queues.get(tabId) === settled && queues.delete(tabId));
  return next;
}
