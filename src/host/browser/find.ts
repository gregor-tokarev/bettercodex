// Find in page for streamed tabs: Chromium's own find is not reachable over CDP, so the page is
// searched by a script that marks every match and the current one, like a browser's find bar.

export interface FindResult {
  matches: number;
  /** 1-based; 0 when nothing matches. */
  active: number;
}

/** Runs in the page (self-contained). An empty `text` clears the marks. */
export const FIND_IN_PAGE = ({ text, forward, again }: { text: string; forward: boolean; again: boolean }): FindResult => {
  const w = window as any;
  const state: { text: string; ranges: Range[]; index: number } = (w.__bettercodexFind ??= { text: '', ranges: [], index: -1 });
  const highlights = (globalThis as any).CSS?.highlights;
  const Mark = (globalThis as any).Highlight;
  if (!text) {
    highlights?.delete('bettercodex-find');
    highlights?.delete('bettercodex-find-active');
    document.getElementById('__bettercodex-find')?.remove();
    state.text = '';
    state.ranges = [];
    state.index = -1;
    return { matches: 0, active: 0 };
  }
  if (!again || state.text !== text) {
    const needle = text.toLowerCase();
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || !parent.getClientRects().length) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node && ranges.length < 1000; node = walker.nextNode()) {
      const hay = (node.nodeValue ?? '').toLowerCase();
      for (let i = hay.indexOf(needle); i >= 0 && ranges.length < 1000; i = hay.indexOf(needle, i + needle.length)) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + needle.length);
        ranges.push(range);
      }
    }
    state.text = text;
    state.ranges = ranges;
    state.index = ranges.length ? 0 : -1;
  } else if (state.ranges.length) {
    state.index = (state.index + (forward ? 1 : -1) + state.ranges.length) % state.ranges.length;
  }
  const active = state.ranges[state.index];
  if (highlights && Mark) {
    if (!document.getElementById('__bettercodex-find')) {
      const style = document.createElement('style');
      style.id = '__bettercodex-find';
      style.textContent = '::highlight(bettercodex-find){background:#fde047;color:#000}::highlight(bettercodex-find-active){background:#f97316;color:#000}';
      document.documentElement.appendChild(style);
    }
    highlights.set('bettercodex-find', new Mark(...state.ranges));
    highlights.set('bettercodex-find-active', new Mark(...(active ? [active] : [])));
  }
  active?.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  return { matches: state.ranges.length, active: state.index + 1 };
};
