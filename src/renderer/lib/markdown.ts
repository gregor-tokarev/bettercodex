import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  renderer: {
    code({ text, lang }) {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const label = lang ? `<span class="code-lang">${lang.replace(/[^\w+#.-]/g, '')}</span>` : '';
      return `<div class="code-block">${label}<button class="code-copy" data-copy>Copy</button><pre><code>${escaped}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-copy', 'target'] });
}
