import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { displayUrl, isAddress, normalizeUrl, searchUrl } from '../../shared/address';
import type { Suggestions } from '../../shared/types';
import { bc } from '../lib/bridge';
import { completion, noteTyped, searchVisits, sites } from '../lib/history';
import { IconGlobe, IconSearch } from './Icons';

interface Item {
  kind: 'search' | 'page';
  /** Main line: the search, or the page's title. */
  title: string;
  /** Muted after the title: the page's address. */
  detail: string;
  url: string;
  /** What the field shows while the item is highlighted with the arrow keys. */
  fill: string;
  icon?: string | null;
}

const MAX_ITEMS = 8;

/** Typed text, plus the rest of a visited address completed in place (shown selected). */
interface Entry {
  typed: string;
  completed: { text: string; url: string } | null;
}

function SuggestionIcon({ item }: { item: Item }) {
  const [failed, setFailed] = useState(false);
  if (item.kind === 'search') return <IconSearch size={13} />;
  if (!item.icon || failed) return <IconGlobe size={13} />;
  return <img className="favicon" src={item.icon} onError={() => setFailed(true)} />;
}

/** The address bar: opens addresses, searches, and suggests sites and searches as you type. */
export function AddressBar({
  tabId,
  url,
  inputRef,
  onNavigate,
}: {
  tabId: string | null;
  url: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onNavigate: (url: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [entry, setEntry] = useState<Entry>({ typed: '', completed: null });
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  /** The suggestion picked with the arrow keys; Enter opens it even if the list changes meanwhile. */
  const [picked, setPicked] = useState<Item | null>(null);
  const [remote, setRemote] = useState<{ for: string; s: Suggestions } | null>(null);
  const shown = url === 'about:blank' ? '' : url;

  useEffect(() => {
    if (!editing) setValue(shown);
  }, [shown, editing]);

  // Another tab came up while the field has the keyboard (a new tab, say): show its address,
  // unless something was typed already.
  const typedRef = useRef('');
  typedRef.current = entry.typed;
  useEffect(() => {
    const input = inputRef.current;
    if (!input || document.activeElement !== input || typedRef.current) return;
    setValue(shown);
    setOpen(!shown);
    requestAnimationFrame(() => input.select());
  }, [tabId]);

  // Searches Google suggests for the typed words, a moment after typing stops.
  useEffect(() => {
    const q = entry.typed.trim();
    if (!open || !q) return;
    let alive = true;
    const timer = setTimeout(() => {
      void bc.suggest(q).then((s) => alive && setRemote({ for: q, s }));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [entry.typed, open]);

  // The completed part stays selected, so typing on replaces it.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !entry.completed || value !== entry.completed.text || document.activeElement !== input) return;
    input.setSelectionRange(entry.typed.length, value.length);
  }, [entry, value]);

  // Suggestions for an earlier part of the typed text stay until the new ones arrive.
  const typedNow = entry.typed.trim().toLowerCase();
  const items = suggestionsFor(entry, remote && typedNow.startsWith(remote.for.toLowerCase()) ? remote.s : null);
  // Without a pick, the first suggestion is what Enter does.
  const active = !open || !items.length ? -1 : picked ? items.findIndex((i) => i.kind === picked.kind && i.url === picked.url) : 0;

  const reset = () => {
    setEntry({ typed: '', completed: null });
    setOpen(false);
    setPicked(null);
  };

  const go = (item: Item | null) => {
    const target = item?.url ?? (value.trim() ? normalizeUrl(value) : '');
    reset();
    setEditing(false);
    inputRef.current?.blur();
    if (!target) return;
    if (item?.kind !== 'search') noteTyped(target);
    onNavigate(target);
  };

  const onType = (text: string, inserting: boolean) => {
    // Complete only while typing forward at the end, so deleting the completion stays deleted.
    const done = inserting ? completion(text) : null;
    setEntry({ typed: text, completed: done });
    setValue(done ? done.text : text);
    setPicked(null);
    setOpen(true);
  };

  return (
    <form
      className="url-form"
      onSubmit={(e) => {
        e.preventDefault();
        go(picked ?? (active >= 0 ? items[active] : null));
      }}
    >
      <input
        ref={inputRef}
        value={value}
        placeholder="Search or enter address"
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
          setEntry({ typed: '', completed: null });
          // An empty field (a new tab) offers the sites visited most.
          setOpen(!e.currentTarget.value);
        }}
        onBlur={() => {
          setEditing(false);
          reset();
        }}
        onChange={(e) => {
          const ev = e.nativeEvent as InputEvent;
          const atEnd = e.target.selectionStart === e.target.value.length;
          onType(e.target.value, atEnd && !ev.isComposing && (ev.inputType === 'insertText' || ev.inputType === 'insertFromPaste'));
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open && items.length) {
            e.preventDefault();
            const next = (Math.max(active, 0) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            setPicked(items[next]);
            setValue(items[next].fill);
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && /^[\w-]+$/.test(entry.typed.trim())) {
            // Ctrl+Enter: "github" → www.github.com
            e.preventDefault();
            go({ kind: 'page', title: '', detail: '', url: `https://www.${entry.typed.trim()}.com/`, fill: '' });
          } else if (e.key === 'Escape') {
            e.preventDefault();
            if (open || value !== shown) {
              reset();
              setValue(shown);
              requestAnimationFrame(() => inputRef.current?.select());
            } else {
              setEditing(false);
              inputRef.current?.blur();
            }
          }
        }}
      />
      {open && items.length > 0 && (
        <div className="omnibox-popup" onMouseDown={(e) => e.preventDefault()}>
          {items.map((item, i) => (
            <button
              type="button"
              key={`${item.kind}:${item.url}`}
              className={`omnibox-item ${i === active ? 'active' : ''}`}
              onClick={() => go(item)}
            >
              <span className="omnibox-icon">
                <SuggestionIcon item={item} />
              </span>
              <span className="omnibox-title">{item.title}</span>
              {item.detail && <span className="omnibox-detail">{item.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

/** What the address bar offers for the typed text: what Enter does, visited pages, then Google's suggestions. */
function suggestionsFor(entry: Entry, remote: Suggestions | null): Item[] {
  const typed = entry.typed.trim();
  if (!typed) {
    return sites()
      .slice(0, 6)
      .map((s) => ({ kind: 'page' as const, title: s.title || s.host, detail: s.title ? s.host : '', url: s.url, fill: s.host, icon: s.icon }));
  }
  const items: Item[] = [];
  const seen = new Set<string>();
  const add = (item: Item) => {
    const id = item.kind === 'search' ? `q:${item.title.toLowerCase()}` : displayUrl(item.url).toLowerCase();
    if (seen.has(id) || items.length >= MAX_ITEMS) return;
    seen.add(id);
    items.push(item);
  };
  if (entry.completed) {
    add({ kind: 'page', title: entry.completed.text, detail: '', url: entry.completed.url, fill: entry.completed.text });
  } else if (isAddress(typed)) {
    add({ kind: 'page', title: typed, detail: '', url: normalizeUrl(typed), fill: typed });
  } else {
    add({ kind: 'search', title: typed, detail: 'Google Search', url: searchUrl(typed), fill: typed });
  }
  for (const v of searchVisits(typed, 3)) add({ kind: 'page', title: v.title || displayUrl(v.url), detail: displayUrl(v.url), url: v.url, fill: displayUrl(v.url), icon: v.icon });
  for (const link of remote?.links.slice(0, 2) ?? []) add({ kind: 'page', title: link.title || displayUrl(link.url), detail: displayUrl(link.url), url: link.url, fill: displayUrl(link.url) });
  for (const q of remote?.queries ?? []) add({ kind: 'search', title: q, detail: '', url: searchUrl(q), fill: q });
  return items;
}
