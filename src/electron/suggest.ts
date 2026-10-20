import { app, net } from 'electron';
import type { Suggestions } from '../shared/types.js';

const NONE: Suggestions = { queries: [], links: [] };

/** What Google suggests for text typed in the address bar (searches and sites), like Chrome shows. */
export async function fetchSuggestions(text: string): Promise<Suggestions> {
  const q = text.trim();
  if (!q || q.length > 300) return NONE;
  const url =
    'https://suggestqueries.google.com/complete/search?client=chrome&ie=UTF-8&oe=UTF-8' + `&hl=${encodeURIComponent(app.getLocale())}&q=${encodeURIComponent(q)}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    // No cookies: typing in the address bar should not tell Google who is typing.
    const res = await net.fetch(url, { signal: abort.signal, credentials: 'omit' });
    if (!res.ok) return NONE;
    const data = (await res.json()) as [string, string[], string[], unknown, Record<string, unknown>];
    const items = Array.isArray(data?.[1]) ? data[1] : [];
    const titles = Array.isArray(data?.[2]) ? data[2] : [];
    const types = (data?.[4]?.['google:suggesttype'] as string[] | undefined) ?? [];
    const out: Suggestions = { queries: [], links: [] };
    items.forEach((item, i) => {
      if (typeof item !== 'string' || !item) return;
      if (types[i] === 'NAVIGATION') {
        if (/^https?:\/\//i.test(item)) out.links.push({ url: item, title: typeof titles[i] === 'string' ? titles[i] : '' });
      } else out.queries.push(item);
    });
    return out;
  } catch {
    return NONE;
  } finally {
    clearTimeout(timer);
  }
}
