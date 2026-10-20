import { memo, useEffect, useMemo, useRef } from 'react';
import { bc } from '../lib/bridge';
import { renderMarkdown } from '../lib/markdown';
import { conn, getState, openTab } from '../lib/store';

/**
 * Markdown with Codex-style behavior: links open in the thread's browser panel
 * (Cmd/Ctrl-click opens the system browser) and absolute image paths load from the host.
 */
export const Markdown = memo(function Markdown({ text, hostId }: { text: string; hostId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const c = conn(hostId);
    for (const img of root.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      const local = src.startsWith('file://') ? decodeURIComponent(src.slice(7)) : src.startsWith('/') ? src : null;
      if (local && c && !img.dataset.loaded) {
        img.dataset.loaded = '1';
        img.removeAttribute('src');
        c.fileUrl(local)
          .then((url) => (img.src = url))
          .catch(() => img.replaceWith(Object.assign(document.createElement('code'), { textContent: local })));
      }
    }
  }, [html, hostId]);

  return (
    <div
      ref={ref}
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.matches('[data-copy]')) {
          const code = target.parentElement?.querySelector('code')?.textContent ?? '';
          void bc.clipboard.write(code);
          target.textContent = 'Copied';
          setTimeout(() => (target.textContent = 'Copy'), 1200);
          return;
        }
        const link = target.closest('a');
        if (!link) return;
        e.preventDefault();
        const href = link.getAttribute('href') ?? '';
        if (!/^https?:/.test(href)) return;
        const sel = getState().selection;
        if (e.metaKey || e.ctrlKey || !sel) void bc.openExternal(href);
        else void openTab(sel, href);
      }}
    />
  );
});
