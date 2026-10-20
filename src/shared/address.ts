// What text typed in the address bar means: an address to open or words to search for.

export function searchUrl(query: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}

export function normalizeUrl(input: string) {
  const url = input.trim();
  if (!url) return 'about:blank';
  // host:port first, otherwise "localhost:3000" would look like a URL with scheme "localhost".
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(url)) return `http://${url}`;
  if (/^[\w.-]+:\d+([/?#]|$)/.test(url)) return `http://${url}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^[^\s/]+\.[^\s/]{2,}([/?#].*)?$/.test(url)) return `https://${url}`;
  return searchUrl(url);
}

/** Typed text that opens as an address rather than a search. */
export function isAddress(input: string) {
  const url = input.trim();
  return !!url && normalizeUrl(url) !== searchUrl(url);
}

/** An address as people read it: no scheme, no "www.", no lone trailing slash, no %-escapes. */
export function displayUrl(url: string) {
  let text = url;
  try {
    text = decodeURI(url);
  } catch {
    // keep it escaped
  }
  return text.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^([^/?#]+)\/$/, '$1');
}
