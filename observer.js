// Runs in the page's own world on instagram.com.
// Watches the requests Instagram's website makes when you open a followers or following list,
// and hands the shape of those requests to the extension. That way the scan can copy exactly
// what the site itself does instead of relying on endpoints that Instagram may change.
// It records URLs, methods and Instagram's own request headers. It never records cookies,
// response bodies, or anything from other sites.
(() => {
  if (window.__igfiObserver) return;
  window.__igfiObserver = true;

  const INTERESTING = /\/friendships\/\d+\/(followers|following)\//;
  const GRAPHQL = /\/(graphql\/query|api\/graphql)/;
  const KEEP_HEADER = /^(x-ig-|x-asbd|x-csrftoken|x-requested-with|x-fb-|accept$|content-type$)/i;

  function kindOf(url, body) {
    const m = url.match(INTERESTING);
    if (m) return m[1];
    if (GRAPHQL.test(url) && typeof body === 'string') {
      if (/follower/i.test(body)) return 'followers';
      if (/following/i.test(body)) return 'following';
    }
    return null;
  }

  function headerObject(init) {
    const out = {};
    const h = init && init.headers;
    if (!h) return out;
    const put = (k, v) => { if (KEEP_HEADER.test(k)) out[String(k).toLowerCase()] = String(v); };
    if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => put(k, v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => put(k, v));
    else Object.keys(h).forEach((k) => put(k, h[k]));
    return out;
  }

  function report(url, method, body, headers) {
    try {
      const abs = new URL(url, location.href);
      if (abs.hostname !== 'www.instagram.com' && abs.hostname !== 'i.instagram.com') return;
      const kind = kindOf(abs.pathname + abs.search, body);
      if (!kind) return;
      window.postMessage({
        source: 'igfi-observer',
        template: {
          kind, method: (method || 'GET').toUpperCase(), url: abs.href, headers: headers || {},
          body: typeof body === 'string' ? body.slice(0, 4000) : null, at: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const body = init && typeof init.body === 'string' ? init.body : null;
      report(url, method, body, headerObject(init));
    } catch {}
    return nativeFetch.apply(this, arguments);
  };

  const open = XMLHttpRequest.prototype.open;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__igfi = { method, url, headers: {} };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__igfi && KEEP_HEADER.test(k)) this.__igfi.headers[String(k).toLowerCase()] = String(v);
    return setHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__igfi) report(this.__igfi.url, this.__igfi.method, typeof body === 'string' ? body : null, this.__igfi.headers);
    } catch {}
    return send.apply(this, arguments);
  };
})();
