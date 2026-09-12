// Runs on instagram.com. Jobs:
//  1. Scan: fetch the followers and following lists using the logged-in session.
//  2. Profiles: fetch bios and counts for many accounts in the background.
//  3. One-off actions: follow, unfollow, approve or ignore requests, list someone else's followers.
//  4. Show a small relationship pill on profile pages based on the last scan.
(() => {
  if (window.__igfiLoaded) return;
  window.__igfiLoaded = true;

  const APP_ID = '936619743392459';
  const PAGE_SIZES = [200, 100, 50, 25];
  const state = { running: false, scan: {}, prog: null, scanCtl: null, bio: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Instagram sometimes answers one shape of request with the web page instead of data, so every
  // request can be made in several styles and the scan keeps whichever one works.
  const APP_IDS = ['936619743392459', '1217981644879628'];
  const REQUEST_STYLES = [
    { id: 'web', host: 'https://www.instagram.com', appId: APP_IDS[0], xrw: true, accept: '*/*' },
    { id: 'web-plain', host: 'https://www.instagram.com', appId: APP_IDS[0], xrw: false, accept: '*/*' },
    { id: 'web-json', host: 'https://www.instagram.com', appId: APP_IDS[0], xrw: false, accept: 'application/json' },
    { id: 'web-altapp', host: 'https://www.instagram.com', appId: APP_IDS[1], xrw: false, accept: '*/*' },
    { id: 'i-api', host: 'https://i.instagram.com', appId: APP_IDS[0], xrw: false, accept: '*/*' },
  ];
  const styleById = (id) => REQUEST_STYLES.find((x) => x.id === id) || REQUEST_STYLES[0];

  function apiHeaders(style = REQUEST_STYLES[0]) {
    const h = { 'x-ig-app-id': style.appId, 'x-asbd-id': '129477', accept: style.accept };
    if (style.xrw) h['x-requested-with'] = 'XMLHttpRequest';
    const csrf = cookie('csrftoken');
    if (csrf) h['x-csrftoken'] = csrf;
    try {
      const claim = sessionStorage.getItem('www-claim-v2');
      if (claim) h['x-ig-www-claim'] = claim;
    } catch {}
    return h;
  }

  class ScanError extends Error {
    constructor(msg, fatal, status) { super(msg); this.fatal = fatal; this.status = status || 0; }
  }

  async function writeState(patch) {
    state.scan = { ...state.scan, ...patch, updatedAt: Date.now() };
    try { await chrome.storage.local.set({ scanState: state.scan }); } catch {}
  }

  async function request(path, { method = 'GET', body, style = REQUEST_STYLES[0] } = {}) {
    const headers = apiHeaders(style);
    if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(style.host + path, { method, headers, body, credentials: 'include' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, url: res.url, redirected: res.redirected, ct: res.headers.get('content-type') || '' };
  }

  const mapUser = (u) => ({
    pk: String(u.pk ?? u.pk_id ?? u.id ?? ''), u: u.username || '', n: u.full_name || '',
    p: !!u.is_private, v: !!u.is_verified, pic: u.profile_pic_url || '',
  });

  // Shared pacing for everything that runs concurrently: keeps a minimum gap between
  // request starts, speeds up after successes and backs off after throttling.
  function makePacer(minMs, maxMs, startMs) {
    const p = { min: Math.max(500, minMs || 800), max: Math.max(minMs || 250, maxMs || 5000), last: 0, chain: Promise.resolve(), throttled: 0 };
    p.delay = Math.min(p.max, Math.max(p.min, startMs ?? p.min));
    p.wait = () => {
      const run = async () => {
        const due = p.last + p.delay * (0.85 + Math.random() * 0.3);
        const now = Date.now();
        if (due > now) await sleep(due - now);
        p.last = Date.now();
      };
      p.chain = p.chain.then(run, run);
      return p.chain;
    };
    p.success = () => { p.delay = Math.max(p.min, p.delay * 0.85); };
    p.throttle = () => { p.throttled++; p.delay = Math.min(p.max, Math.max(p.delay * 2, 1500)); };
    return p;
  }

  const RETRY_WAITS = [20000, 45000, 90000, 180000];
  const QUICK_RETRIES = [1500, 4000];
  const isThrottle = (r, msg) => r.status === 429 || /wait a few minutes|too many requests|rate limit/i.test(msg);
  const isActionBlock = (r, msg) => !!(r.json && r.json.feedback_required) || /feedback_required|spam|action blocked|blocked/i.test(msg);
  const THROTTLE_MS = 10 * 60 * 1000;

  // Instagram rate limits the whole session, not one endpoint. Remember it so the dashboard can
  // warn, and stop the background profile loader so it does not keep the limit tripped.
  async function noteThrottle(source) {
    const until = Date.now() + THROTTLE_MS;
    state.throttledUntil = until;
    try { await chrome.storage.local.set({ throttle: { until, at: Date.now(), source } }); } catch {}
    if (state.bio?.running && source !== 'profiles') {
      state.bio.pausedByThrottle = true;
      state.bio.ctl.cancel = true;
    }
  }

  function pageHint(text, url) {
    const t = (text.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || '';
    if (/login|accounts\/login/i.test(url) || /log in/i.test(t)) return 'the login page';
    if (/challenge|checkpoint/i.test(url)) return 'a security check page';
    if (/page not found|not found/i.test(t)) return 'a "page not found" page';
    return t ? `a web page titled "${t.trim()}"` : 'a web page instead of data';
  }

  function describe(r) {
    const msg = (r.json && (r.json.message || r.json.error_title)) || '';
    if (msg) return msg;
    const body = (r.text || '').replace(/\s+/g, ' ').trim();
    if (!r.json && /^</.test(body)) {
      const where = r.redirected && r.url ? ` (redirected to ${String(r.url).replace(/^https?:\/\/(www\.)?instagram\.com/, '')})` : '';
      return pageHint(r.text || '', r.url || '') + where;
    }
    if (!body) return 'an empty reply';
    if (!r.json) return 'unreadable data: ' + body.slice(0, 80);
    return 'JSON without a user list (' + Object.keys(r.json).slice(0, 5).join(', ') + ')';
  }

  // Keep the first failing response of each kind so it can be read back later without dev tools.
  async function keepSample(kind, path, r) {
    try {
      const g = await chrome.storage.local.get('lastFailure');
      const store = g.lastFailure && Date.now() - g.lastFailure.at < 6 * 3600 * 1000 ? g.lastFailure : { at: Date.now(), samples: {} };
      store.at = Date.now();
      store.samples[kind] = {
        at: Date.now(), path, status: r.status, url: r.url, redirected: !!r.redirected, ct: r.ct,
        detail: describe(r), body: (r.text || '').replace(/\s+/g, ' ').slice(0, 600),
      };
      await chrome.storage.local.set({ lastFailure: store });
    } catch {}
  }

  // A single GET.
  //   ok: true and json on success
  //   otherwise: { fatal } means stop the scan, { throttled } means Instagram is rate limiting,
  //   anything else is worth retrying with a different variant of the request.
  async function tryJson(path, style = REQUEST_STYLES[0], sampleKind = null) {
    let r;
    try { r = await request(path, { style }); } catch (e) { r = { status: 0, json: null, text: String(e), url: '', redirected: false, ct: '' }; }
    if (r.status === 200 && r.json && (r.json.status === 'ok' || Array.isArray(r.json.users))) return { ok: true, json: r.json, status: 200 };
    const msg = (r.json && (r.json.message || r.json.error_title)) || '';
    const detail = describe(r);
    const fatal = r.status === 401 || /login_required|checkpoint_required|challenge_required/i.test(msg);
    const html = !r.json && /^\s*</.test(r.text || '');
    if (html && sampleKind) await keepSample(sampleKind, path, r);
    return { ok: false, status: r.status, throttled: isThrottle(r, msg), fatal, detail, html, url: r.url, redirected: !!r.redirected, ct: r.ct };
  }

  // Retries a single request. Long backoff only for real rate limiting; everything else fails
  // fast so fetchList can try the request a different way.
  async function getJson(path, { bestEffort = false, pacer = null, ctl = null, quick = false, style = REQUEST_STYLES[0], sampleKind = null } = {}) {
    let last = null;
    for (let attempt = 0; ; attempt++) {
      if (ctl?.cancel) throw new ScanError('Scan cancelled.', true);
      if (pacer) await pacer.wait();
      const r = await tryJson(path, style, sampleKind);
      if (r.ok) { pacer?.success(); return r.json; }
      last = r;
      if (r.fatal) {
        throw new ScanError('Instagram wants you to log in again or finish a security check. Open the Instagram tab, sort that out, then scan again.', true, r.status);
      }
      if (r.throttled) {
        pacer?.throttle();
        noteThrottle('scan');
        if (bestEffort || attempt >= RETRY_WAITS.length) {
          throw new ScanError(`Instagram is rate limiting requests (${r.detail}). Wait 10 to 15 minutes and try again.`, !bestEffort, r.status);
        }
        const wait = RETRY_WAITS[attempt];
        const until = Date.now() + wait;
        while (Date.now() < until) {
          if (ctl?.cancel) throw new ScanError('Scan cancelled.', true);
          await writeState({ ...progressFields(), message: `Instagram is rate limiting requests. Retrying in ${Math.ceil((until - Date.now()) / 1000)}s`, waiting: true, retryAt: until, waitReason: 'Instagram is rate limiting requests' });
          const chunk = Math.min(3000, until - Date.now());
          await sleep(chunk);
          if (state.prog) state.prog.waitedMs += chunk;
        }
        await writeState({ ...progressFields(), waiting: false, retryAt: null, message: 'Retrying' });
        continue;
      }
      if (bestEffort || quick || attempt >= QUICK_RETRIES.length) {
        throw new ScanError(`Instagram answered ${r.status || 'nothing'} with ${r.detail}`, false, r.status);
      }
      await sleep(QUICK_RETRIES[attempt]);
    }
  }

  // ---------- scan progress ----------

  function newProgress(pageSize) {
    const stream = () => ({ pages: 0, found: 0, expected: 0, observed: 0, start: 0 });
    return { pages: 0, waitedMs: 0, listStart: 0, fFound: 0, gFound: 0, expectedF: 0, expectedG: 0, pageSize: pageSize || 50, throttles: 0, k: { followers: stream(), following: stream() } };
  }

  // The two lists come back in different page sizes and at different speeds, so each stream gets
  // its own estimate; in parallel mode the slower one sets the total.
  function progressFields() {
    const p = state.prog;
    if (!p) return {};
    const now = Date.now();
    const expectedTotal = (p.expectedF || 0) + (p.expectedG || 0);
    const found = (p.fFound || 0) + (p.gFound || 0);
    const active = p.listStart ? Math.max(0, now - p.listStart - p.waitedMs) : 0;
    const avgPageMs = p.pages ? active / p.pages : 0;
    const streamEta = (s) => {
      if (!s.expected || s.found >= s.expected) return 0;
      const own = s.start && s.pages ? Math.max(0, now - s.start - p.waitedMs) / s.pages : 0;
      const avg = own || avgPageMs;
      if (!avg) return null;
      const size = s.observed || p.pageSize;
      return Math.ceil((s.expected - s.found) / size) * avg;
    };
    const eF = streamEta(p.k.followers), eG = streamEta(p.k.following);
    let eta = null;
    if (eF != null && eG != null) eta = Math.round(p.parallel ? Math.max(eF, eG) : eF + eG);
    return {
      pages: p.pages, waitedMs: p.waitedMs, fFound: p.fFound, gFound: p.gFound, expectedF: p.expectedF, expectedG: p.expectedG,
      avgPageMs: Math.round(avgPageMs), eta, pageSize: Math.max(p.k.followers.observed, p.k.following.observed) || p.pageSize,
      pageSizeF: p.k.followers.observed || 0, pageSizeG: p.k.following.observed || 0,
      overallDone: found, overallTotal: expectedTotal, throttles: p.throttles, parallel: !!p.parallel,
    };
  }

  function listMessage(kind, out, expected, label) {
    const p = state.prog;
    if (label) return `${label}: ${out} more found so far`;
    if (p?.parallel) return `Followers ${p.fFound}${p.expectedF ? ' of ' + p.expectedF : ''} · Following ${p.gFound}${p.expectedG ? ' of ' + p.expectedG : ''}`;
    return `Fetching ${kind}: ${out}${expected ? ' of about ' + expected : ''}`;
  }

  // ---------- list fetching ----------

  async function loadProbe() {
    try { const { probe } = await chrome.storage.local.get('probe'); return probe || {}; } catch { return {}; }
  }

  // Ways to ask for one page, in the order we try them. Instagram sometimes refuses one shape
  // (a page size, or the search_surface parameter) while happily answering another.
  function pageVariants(kind, maxSize, remembered) {
    const sizes = [maxSize, ...PAGE_SIZES.filter((s) => s < maxSize)];
    const surfaces = kind === 'followers' ? [true, false] : [false];
    const out = [];
    for (const style of REQUEST_STYLES) for (const count of sizes) for (const surface of surfaces) out.push({ count, surface, style: style.id });
    if (remembered) {
      const i = out.findIndex((v) => v.count === remembered.count && v.surface === remembered.surface && v.style === remembered.style);
      if (i > 0) out.unshift(out.splice(i, 1)[0]);
    }
    return out;
  }

  function listPath(uid, kind, { count, surface }, maxId, order) {
    const qs = new URLSearchParams({ count: String(count) });
    if (maxId) qs.set('max_id', maxId);
    if (order) qs.set('order', order);
    if (surface) qs.set('search_surface', 'follow_list_page');
    return `/api/v1/friendships/${uid}/${kind}/?${qs}`;
  }

  function variantLabel(v) {
    return `${v.count} per page${v.surface ? ' with search_surface' : ''}${v.style !== 'web' ? `, ${v.style} request style` : ''}`;
  }

  async function fetchList(kind, uid, expected, settings, opts = {}) {
    const { order = null, bestEffort = false, into = null, label = null, pacer = null, ctl = null } = opts;
    const out = into || [];
    const seen = new Set(out.map((u) => u.pk));
    const startCount = out.length;
    // Followers pages come back slowly at large sizes, so they get their own cap.
    const maxSize = kind === 'followers'
      ? Math.min(Number(settings.pageSize) || 200, Number(settings.followersPageSize) || 50)
      : Number(settings.pageSize) || 200;
    const probe = await loadProbe();
    const remembered = probe[kind]?.forMax === maxSize ? probe[kind].v : null;
    const variants = pageVariants(kind, maxSize, remembered);
    let vIdx = 0;
    const strm = state.prog?.k?.[kind];
    if (strm && !label) { strm.start = Date.now(); strm.expected = expected || 0; strm.observed = probe[kind]?.size || 0; }
    let maxId = null;
    let emptyPages = 0;
    let lastErr = null;

    // Ask for one page, walking through the variants until one answers.
    const fetchPage = async () => {
      for (let tried = 0; tried < variants.length; tried++) {
        const v = variants[(vIdx + tried) % variants.length];
        try {
          const json = await getJson(listPath(uid, kind, v, maxId, order), { bestEffort, pacer, ctl, quick: tried > 0, style: styleById(v.style), sampleKind: kind });
          if (tried > 0) {
            vIdx = (vIdx + tried) % variants.length;
            probe[kind] = { ...(probe[kind] || {}), v, forMax: maxSize, at: Date.now() };
            try { await chrome.storage.local.set({ probe }); } catch {}
          }
          return json;
        } catch (e) {
          if (e.fatal) throw e;
          lastErr = e;
          if (state.prog) state.prog.pages++;
          const nextV = variants[(vIdx + tried + 1) % variants.length];
          await writeState({
            ...progressFields(),
            message: `${kind === 'followers' ? 'Followers' : 'Following'}: ${variantLabel(v)} failed (${e.message}). Trying ${variantLabel(nextV)}`,
          });
        }
      }
      throw lastErr || new ScanError('Instagram would not answer the list request.', true);
    };

    // Every shape we know was refused. Fall back to copying the request instagram.com itself made.
    const tryLearned = async () => {
      if (order || label) return null;
      await writeState({ ...progressFields(), message: `Instagram refused every ${kind} request we know. Trying the one instagram.com itself uses` });
      try {
        return await fetchLearned(kind, expected, pacer, ctl, out);
      } catch (e) {
        if (e.fatal) throw e;
        return null;
      }
    };

    for (;;) {
      let json;
      try {
        json = await fetchPage();
      } catch (e) {
        if (e.fatal) throw e;
        if (!maxId) {
          const learned = await tryLearned();
          if (learned && learned.length) return learned;
        }
        if (bestEffort) break;
        const hint = ' Open your followers list on instagram.com once so the extension can see how the site loads it, then scan again.';
        throw new ScanError(e.message + (e.message.includes('instagram.com once') ? '' : hint), true, e.status);
      }
      const users = Array.isArray(json.users) ? json.users : [];
      if (!maxId && !order) {
        const v = variants[vIdx];
        probe[kind] = { ...(probe[kind] || {}), size: Math.max(users.length, 1), v, forMax: maxSize, at: Date.now() };
        try { await chrome.storage.local.set({ probe }); } catch {}
        if (strm && users.length) strm.observed = users.length;
      }
      for (const u of users) {
        const m = mapUser(u);
        if (!m.pk || seen.has(m.pk)) continue;
        seen.add(m.pk);
        out.push(m);
      }
      if (state.prog) {
        state.prog.pages++;
        state.prog[kind === 'followers' ? 'fFound' : 'gFound'] = out.length;
        state.prog.throttles = pacer ? pacer.throttled : state.prog.throttles;
        if (strm) { strm.pages++; strm.found = out.length; }
      }
      await writeState({
        ...progressFields(),
        phase: label ? kind : (state.prog?.parallel ? 'lists' : kind),
        deep: !!label,
        message: listMessage(kind, label ? out.length - startCount : out.length, expected, label),
        done: out.length,
        total: expected || 0,
      });
      const next = json.next_max_id;
      if (users.length === 0) emptyPages++; else emptyPages = 0;
      if (!next || next === maxId || emptyPages >= 2) break;
      // When Instagram's cursor is a plain offset, the remaining pages do not depend on each
      // other, so several can be fetched at once (all sharing the one pacer).
      const workers = Math.min(6, Math.max(1, Number(settings.scanWorkers) || 3));
      if (!maxId && !order && workers > 1 && /^\d+$/.test(String(next)) && Number(next) === users.length && expected > users.length * 2) {
        await fetchOffsets(kind, uid, expected, users.length, variants[vIdx], { pacer, ctl, out, seen, strm, label, startCount, workers });
        return out;
      }
      maxId = String(next);
    }
    return out;
  }

  async function fetchOffsets(kind, uid, expected, size, v, { pacer, ctl, out, seen, strm, label, startCount, workers }) {
    const offsets = [];
    for (let o = size; o < expected + size; o += size) offsets.push(o);
    let stop = false;
    let failures = 0;
    const style = styleById(v.style);
    const worker = async () => {
      while (!stop && offsets.length) {
        if (ctl?.cancel) throw new ScanError('Scan cancelled.', true);
        const o = offsets.shift();
        let json;
        try {
          json = await getJson(listPath(uid, kind, v, String(o), null), { pacer, ctl, style, sampleKind: kind });
        } catch (e) {
          if (e.fatal) throw e;
          failures++;
          if (failures > 3) { stop = true; throw e; }
          offsets.unshift(o);
          await sleep(3000);
          continue;
        }
        const users = Array.isArray(json.users) ? json.users : [];
        if (!users.length) { if (o >= expected) stop = true; continue; }
        for (const u of users) {
          const m = mapUser(u);
          if (!m.pk || seen.has(m.pk)) continue;
          seen.add(m.pk);
          out.push(m);
        }
        if (state.prog) {
          state.prog.pages++;
          state.prog[kind === 'followers' ? 'fFound' : 'gFound'] = out.length;
          state.prog.throttles = pacer ? pacer.throttled : state.prog.throttles;
          if (strm) { strm.pages++; strm.found = out.length; }
        }
        await writeState({
          ...progressFields(),
          phase: state.prog?.parallel ? 'lists' : kind,
          deep: false,
          message: listMessage(kind, out.length, expected, label),
          done: out.length,
          total: expected || 0,
        });
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
  }

  // Try the list request in every shape and style once, and keep the answers so a failing scan
  // can be explained later without opening dev tools.
  async function diagnose() {
    const uid = cookie('ds_user_id');
    if (!uid) return { ok: false, error: 'You are not logged in to Instagram in this browser.' };
    const rows = [];
    const run = async (label, kind, v, style) => {
      const path = kind === 'profile' ? `/api/v1/users/${uid}/info/` : listPath(uid, kind, v, null, null);
      const t0 = Date.now();
      const r = await tryJson(path, style, null);
      rows.push({
        label, kind, style: style.id, path, ms: Date.now() - t0, status: r.status ?? 200,
        ok: !!r.ok, users: r.ok ? (r.json.users || []).length : null,
        detail: r.ok ? null : r.detail, throttled: !!r.throttled, fatal: !!r.fatal,
        redirected: !!r.redirected, url: r.url || '', ct: r.ct || '',
      });
      await sleep(1800);
      return !!r.ok;
    };
    // Controls first: if these fail too, it is the session, not the followers endpoint.
    await run('Your profile', 'profile', null, REQUEST_STYLES[0]);
    await run('Following, 200 per page', 'following', { count: 200, surface: false }, REQUEST_STYLES[0]);
    for (const style of REQUEST_STYLES) {
      const okA = await run(`Followers, 50 per page, with search_surface, ${style.id}`, 'followers', { count: 50, surface: true }, style);
      if (okA) break;
      const okB = await run(`Followers, 50 per page, no search_surface, ${style.id}`, 'followers', { count: 50, surface: false }, style);
      if (okB) break;
      if (rows.some((x) => x.throttled || x.fatal)) break;
    }
    let probe = {}, lastFailure = null;
    try {
      const g = await chrome.storage.local.get(['probe', 'lastFailure']);
      probe = g.probe || {};
      lastFailure = g.lastFailure || null;
    } catch {}
    const result = { ok: true, rows, probe, lastFailure, at: Date.now() };
    try { await chrome.storage.local.set({ lastDiag: result }); } catch {}
    return result;
  }

  // ---------- learning from Instagram's own website ----------

  // observer.js (running in the page) reports the requests instagram.com makes for follower and
  // following lists. We keep the newest of each so the scan can copy it when our own requests fail.
  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== 'igfi-observer') return;
    const t = e.data.template;
    if (!t || (t.kind !== 'followers' && t.kind !== 'following')) return;
    try {
      const g = await chrome.storage.local.get('learned');
      const learned = g.learned || {};
      const prev = learned[t.kind];
      if (prev && prev.url === t.url && prev.body === t.body) return;
      learned[t.kind] = t;
      await chrome.storage.local.set({ learned });
    } catch {}
  });

  // Pull user records out of any response shape (the REST list, or a GraphQL result).
  function extractUsers(json) {
    const out = [];
    const seen = new Set();
    const visit = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 12) return;
      if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
      const id = v.pk ?? v.pk_id ?? v.id;
      if (v.username && id != null && /^\d+$/.test(String(id))) {
        const m = mapUser({ ...v, pk: String(id) });
        if (!seen.has(m.pk)) { seen.add(m.pk); out.push(m); }
        return;
      }
      for (const k of Object.keys(v)) visit(v[k], depth + 1);
    };
    visit(json, 0);
    return out;
  }

  function extractCursor(json) {
    let cursor = null;
    const visit = (v, depth) => {
      if (cursor || !v || typeof v !== 'object' || depth > 12) return;
      if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
      if (v.next_max_id != null && v.next_max_id !== '') { cursor = { param: 'max_id', value: String(v.next_max_id) }; return; }
      if (v.page_info && v.page_info.has_next_page && v.page_info.end_cursor) { cursor = { param: 'after', value: String(v.page_info.end_cursor) }; return; }
      for (const k of Object.keys(v)) visit(v[k], depth + 1);
    };
    visit(json, 0);
    return cursor;
  }

  // Replay a learned request, page by page.
  async function fetchLearned(kind, expected, pacer, ctl, into) {
    let learned = null;
    try { learned = (await chrome.storage.local.get('learned')).learned?.[kind] || null; } catch {}
    if (!learned) return null;
    const out = into || [];
    const seen = new Set(out.map((u) => u.pk));
    let cursor = null;
    let pages = 0;
    const strm = state.prog?.k?.[kind];
    for (;;) {
      if (ctl?.cancel) throw new ScanError('Scan cancelled.', true);
      const url = new URL(learned.url);
      let body = learned.body;
      if (cursor) {
        if (learned.method === 'POST' && body) {
          const params = new URLSearchParams(body);
          const raw = params.get('variables');
          if (raw) {
            try {
              const vars = JSON.parse(raw);
              vars[cursor.param] = cursor.value;
              params.set('variables', JSON.stringify(vars));
              body = params.toString();
            } catch { return out.length ? out : null; }
          } else return out.length ? out : null;
        } else {
          url.searchParams.set(cursor.param, cursor.value);
        }
      }
      if (pacer) await pacer.wait();
      let r;
      try {
        const headers = { ...learned.headers };
        if (learned.method === 'POST' && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
        const res = await fetch(url.href, { method: learned.method, headers, body: learned.method === 'POST' ? body : undefined, credentials: 'include' });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        r = { status: res.status, json, text, url: res.url, redirected: res.redirected, ct: res.headers.get('content-type') || '' };
      } catch (e) {
        r = { status: 0, json: null, text: String(e), url: '', redirected: false, ct: '' };
      }
      if (!r.json) {
        await keepSample(kind + '-learned', url.pathname, r);
        return out.length ? out : null;
      }
      const users = extractUsers(r.json);
      if (!users.length && !out.length) return null;
      for (const u of users) {
        if (!u.pk || seen.has(u.pk)) continue;
        seen.add(u.pk);
        out.push(u);
      }
      pages++;
      if (state.prog) {
        state.prog.pages++;
        state.prog[kind === 'followers' ? 'fFound' : 'gFound'] = out.length;
        if (strm) { strm.pages++; strm.found = out.length; strm.observed = Math.max(strm.observed || 0, users.length); }
      }
      await writeState({
        ...progressFields(),
        phase: kind,
        message: `Copying how instagram.com loads your ${kind}: ${out.length}${expected ? ' of about ' + expected : ''}`,
      });
      const next = extractCursor(r.json);
      if (!next || !users.length || (cursor && next.value === cursor.value)) break;
      cursor = next;
      if (pages > 400) break;
    }
    return out;
  }

  // ---------- the scan ----------

  async function runScan(settings) {
    if (state.running) return;
    state.running = true;
    const ctl = { cancel: false };
    state.scanCtl = ctl;
    const started = Date.now();
    try {
      const { scanState } = await chrome.storage.local.get('scanState');
      state.scan = scanState || {};
    } catch { state.scan = {}; }
    state.prog = newProgress(Number(settings.pageSize) || 200);
    state.prog.parallel = settings.parallelLists !== false;
    const pacer = makePacer(settings.delayMin, settings.delayMax);
    try {
      const uid = cookie('ds_user_id');
      if (!uid) throw new ScanError('You are not logged in to Instagram in this browser. Log in, then scan again.', true);
      await writeState({ status: 'running', phase: 'profile', message: 'Reading your profile', userId: uid, done: 0, total: 0, pages: 0 });

      let me = null;
      try {
        const j = await getJson(`/api/v1/users/${uid}/info/`, { ctl });
        me = j.user || null;
      } catch (e) {
        if (e.fatal && /log in/i.test(e.message)) throw e;
      }
      const expectedF = me?.follower_count ?? 0;
      const expectedG = me?.following_count ?? 0;
      state.prog.expectedF = expectedF;
      state.prog.expectedG = expectedG;
      state.prog.listStart = Date.now();
      const base = { userId: uid, username: me?.username || '', fullName: me?.full_name || '', pic: me?.profile_pic_url || '', followerCount: expectedF, followingCount: expectedG, startedAt: started };

      // Optional quick check: if Instagram's counters match the last scan exactly, reuse the last lists.
      if (settings.quickCheck && me) {
        let acct = null;
        try { const { accounts } = await chrome.storage.local.get('accounts'); acct = accounts?.[uid] || null; } catch {}
        if (acct && acct.fc === expectedF && acct.gc === expectedG && acct.lastScan && Date.now() - acct.lastScan < 30 * 86400000) {
          await writeState({ ...progressFields(), phase: 'saving', eta: 0, message: 'Both counters match the last scan. Reusing the last lists (quick check is on in Settings).' });
          const resp = await chrome.runtime.sendMessage({ type: 'scanResult', data: { ...base, reuse: true, followers: [], following: [], requests: state.prog.pages, finishedAt: Date.now() } });
          if (!resp?.ok) throw new ScanError(resp?.error || 'Could not save the scan.', true);
          badge.reload();
          return;
        }
      }

      await writeState({ ...progressFields(), phase: state.prog.parallel ? 'lists' : 'followers', message: state.prog.parallel ? 'Fetching followers and following together' : `Starting on ${expectedF ? expectedF + ' ' : ''}followers` });

      let followers, following;
      const runF = () => fetchList('followers', uid, expectedF, settings, { pacer, ctl });
      const runG = () => fetchList('following', uid, expectedG, settings, { pacer, ctl });
      if (state.prog.parallel) {
        try {
          [followers, following] = await Promise.all([runF(), runG()]);
        } catch (e) { ctl.cancel = true; throw e; }
      } else {
        followers = await runF();
        following = await runG();
      }

      // Instagram's list endpoints sometimes skip entries (and always leave out deactivated accounts).
      // When a list comes back short, fetch it again in a different order and merge anything new.
      let prevDeep = null;
      try { const { accounts } = await chrome.storage.local.get('accounts'); prevDeep = accounts?.[uid]?.deep || null; } catch {}
      const deep = { ...(prevDeep || {}) };
      const lists = [['followers', followers, expectedF, 'f'], ['following', following, expectedG, 'g']];
      for (const [kind, list, expected, k] of lists) {
        const short = expected ? expected - list.length : 0;
        if (settings.deepScan === false || !expected || short <= Math.max(2, expected * 0.005)) continue;
        const skip = prevDeep && prevDeep[k + 'Found'] === 0 && short <= (prevDeep[k + 'Short'] || 0) + 5;
        if (skip) continue;
        const before = list.length;
        state.prog.parallel = false;
        await writeState({ ...progressFields(), phase: kind, deep: true, eta: null, message: `Instagram counts ${expected} ${kind} but returned ${before}. Double-checking the list` });
        await fetchList(kind, uid, expected, settings, { order: 'date_followed_earliest', bestEffort: true, into: list, label: `Double-checking ${kind}`, pacer, ctl });
        deep[k + 'Found'] = list.length - before;
        deep[k + 'Short'] = expected - list.length;
        deep.at = Date.now();
      }

      // Who disappeared since the last scan? Check whether those accounts still exist.
      let gone = null;
      if (settings.verifyLost !== false) {
        let prev = null;
        try { const g = await chrome.storage.local.get(`snapshots_${uid}`); const snaps = g[`snapshots_${uid}`] || []; prev = snaps[snaps.length - 1] || null; } catch {}
        if (prev) {
          const curF = new Set(followers.map((u) => u.pk)), curG = new Set(following.map((u) => u.pk));
          const lost = [...new Set([...prev.followers.filter((pk) => !curF.has(pk)), ...prev.following.filter((pk) => !curG.has(pk))])];
          const check = lost.slice(0, Math.max(0, Number(settings.verifyCap) || 150));
          if (check.length) {
            gone = {};
            for (let i = 0; i < check.length; i++) {
              if (ctl.cancel) break;
              await writeState({ ...progressFields(), phase: 'verify', deep: false, eta: null, message: `${check.length} account${check.length === 1 ? '' : 's'} disappeared since last scan. Checking whether they still exist: ${i + 1} of ${check.length}` });
              gone[check[i]] = await accountStatus(check[i], pacer, ctl);
              state.prog.pages++;
            }
          }
        }
      }

      await writeState({ ...progressFields(), phase: 'saving', deep: false, eta: 0, message: 'Saving results' });
      const data = {
        ...base,
        followerCount: expectedF || followers.length,
        followingCount: expectedG || following.length,
        followers,
        following,
        deep: Object.keys(deep).length ? deep : null,
        gone,
        requests: state.prog.pages,
        waitedMs: state.prog.waitedMs,
        throttles: state.prog.throttles,
        pageSize: Math.max(state.prog.k.followers.observed, state.prog.k.following.observed) || state.prog.pageSize,
        pageSizes: { f: state.prog.k.followers.observed, g: state.prog.k.following.observed },
        finishedAt: Date.now(),
      };
      const resp = await chrome.runtime.sendMessage({ type: 'scanResult', data });
      if (!resp?.ok) throw new ScanError(resp?.error || 'Could not save the scan.', true);
      badge.reload();
    } catch (e) {
      const msg = e instanceof ScanError ? e.message : 'Unexpected error: ' + (e?.message || e);
      await writeState({ status: ctl.cancel && /cancelled/i.test(msg) ? 'cancelled' : 'error', message: msg, finishedAt: Date.now() });
    } finally {
      state.running = false;
      state.scanCtl = null;
    }
  }

  // ---------- single actions ----------

  async function doAction(action, pk) {
    if (!cookie('ds_user_id')) return { ok: false, error: 'Not logged in to Instagram.' };
    if (!/^\d+$/.test(String(pk))) return { ok: false, error: 'Bad user id.' };
    const paths = action === 'unfollow'
      ? [`/api/v1/web/friendships/${pk}/unfollow/`, `/api/v1/friendships/destroy/${pk}/`]
      : action === 'follow'
        ? [`/api/v1/web/friendships/${pk}/follow/`, `/api/v1/friendships/create/${pk}/`]
        : action === 'approve'
          ? [`/api/v1/web/friendships/${pk}/approve/`, `/api/v1/friendships/approve/${pk}/`]
          : action === 'ignore'
            ? [`/api/v1/web/friendships/${pk}/ignore/`, `/api/v1/friendships/ignore/${pk}/`]
            : null;
    if (!paths) return { ok: false, error: 'Unknown action.' };
    let last = null;
    for (const p of paths) {
      let r;
      try {
        r = await request(p, { method: 'POST', body: p.includes('/web/') ? '' : `user_id=${pk}&container_module=profile` });
      } catch (e) {
        r = { status: 0, json: null, text: String(e) };
      }
      if (r.status === 200 && r.json && r.json.status === 'ok') {
        return { ok: true, friendship: r.json.friendship_status || null };
      }
      last = r;
      const m = (r.json && (r.json.message || r.json.feedback_message)) || '';
      if (r.status === 429 || /wait a few minutes|feedback_required|spam|blocked/i.test(m)) break;
    }
    const msg = (last?.json && (last.json.feedback_message || last.json.message)) || `HTTP ${last?.status || 'network error'}`;
    const throttled = isThrottle(last || { status: 0 }, msg);
    const actionBlock = !throttled && isActionBlock(last || {}, msg);
    const loaderRunning = !!state.bio?.running;
    if (throttled) await noteThrottle('action');
    let human = `Instagram said: ${msg}`;
    if (throttled) human = `Instagram is rate limiting requests from your account right now (${msg}). Wait 10 to 15 minutes and try again.${loaderRunning ? ' The profile loader has been paused so it stops adding to the load.' : ''}`;
    else if (actionBlock) human = `Instagram has temporarily blocked follow and unfollow actions on your account (${msg}). This usually lifts within a day. Doing it by hand on instagram.com will show the same block.`;
    else if (last?.status === 403 || /csrf|login_required/i.test(msg)) human = `Instagram rejected the request (${msg}). Reload the Instagram tab, make sure you are logged in, and try again.`;
    return { ok: false, error: human, raw: msg, status: last?.status || 0, blocked: throttled || actionBlock, throttled, actionBlock };
  }

  function profileFields(u) {
    return {
      bio: u.biography || '', link: u.external_url || '', cat: u.category || '',
      fc: u.follower_count ?? null, gc: u.following_count ?? null, mc: u.media_count ?? null,
      p: !!u.is_private, v: !!u.is_verified, n: u.full_name || '', pic: u.profile_pic_url || '',
    };
  }

  async function getProfile(pk) {
    if (!cookie('ds_user_id')) return { ok: false, error: 'Not logged in to Instagram.' };
    if (!/^\d+$/.test(String(pk))) return { ok: false, error: 'Bad user id.' };
    let r;
    try { r = await request(`/api/v1/users/${pk}/info/`); } catch (e) { r = { status: 0, json: null, text: String(e) }; }
    if (r.status === 200 && r.json && r.json.user) return { ok: true, profile: profileFields(r.json.user) };
    const msg = (r.json && r.json.message) || `HTTP ${r.status || 'network error'}`;
    const blocked = isThrottle(r, msg);
    if (blocked) noteThrottle('profiles');
    return { ok: false, error: msg, status: r.status, blocked };
  }

  // ---------- background profile loader (bios and counts for many accounts) ----------

  async function writeBio(patch) {
    const b = state.bio;
    if (!b) return;
    const elapsed = Date.now() - b.startedAt - b.waitedMs;
    const eta = b.done ? Math.round(((b.total - b.done) * elapsed) / b.done) : null;
    b.state = { ...(b.state || {}), status: 'running', done: b.done, total: b.total, ok: b.ok, failed: b.failed, startedAt: b.startedAt, updatedAt: Date.now(), eta, waitedMs: b.waitedMs, userId: b.uid, ...patch };
    try { await chrome.storage.local.set({ bioState: b.state }); } catch {}
  }

  async function runProfileJob(pks, settings) {
    if (state.bio?.running) return { ok: false, error: 'A profile load is already running.' };
    const uid = cookie('ds_user_id');
    if (!uid) return { ok: false, error: 'Not logged in to Instagram.' };
    if (state.throttledUntil && Date.now() < state.throttledUntil) {
      return { ok: false, error: `Instagram is rate limiting requests right now. Try again in about ${Math.ceil((state.throttledUntil - Date.now()) / 60000)} minutes.` };
    }
    const queue = pks.filter((pk) => /^\d+$/.test(String(pk)));
    const b = { running: true, ctl: { cancel: false }, uid, done: 0, total: queue.length, ok: 0, failed: 0, startedAt: Date.now(), waitedMs: 0, throttles: 0, state: null };
    state.bio = b;
    const conc = Math.min(4, Math.max(1, Number(settings.bioConcurrency) || 2));
    const pacer = makePacer(Number(settings.bioDelay) || 600, 20000);
    let patches = {};
    let paused = false;
    const flush = async () => {
      const keys = Object.keys(patches);
      if (!keys.length) return;
      const p = patches;
      patches = {};
      try { await chrome.runtime.sendMessage({ type: 'profilesBatch', userId: uid, patches: p }); } catch {}
    };
    await writeBio({ message: `Loading profiles: 0 of ${b.total}` });
    const worker = async () => {
      while (queue.length && !b.ctl.cancel) {
        const pk = queue.shift();
        await pacer.wait();
        let r;
        try { r = await getProfile(pk); } catch (e) { r = { ok: false, error: String(e), status: 0 }; }
        if (r.ok) {
          b.ok++;
          patches[pk] = { ...r.profile, bioAt: Date.now(), bioErr: 0 };
          pacer.success();
        } else if (r.blocked) {
          b.throttles++;
          pacer.throttle();
          queue.unshift(pk);
          if (b.throttles > 2) { paused = true; b.pausedByThrottle = true; b.ctl.cancel = true; break; }
          const wait = [45000, 90000][Math.min(b.throttles - 1, 1)];
          const until = Date.now() + wait;
          await writeBio({ message: `Instagram is rate limiting profile requests. Waiting ${Math.round(wait / 1000)}s`, waiting: true, retryAt: until });
          while (Date.now() < until && !b.ctl.cancel) { const c = Math.min(3000, until - Date.now()); await sleep(c); b.waitedMs += c; }
          await writeBio({ waiting: false, retryAt: null, message: 'Retrying' });
          continue;
        } else {
          b.failed++;
          patches[pk] = { bioAt: Date.now(), bioErr: r.status || 1, ...(r.status === 404 ? { gone: Date.now() } : {}) };
        }
        b.done++;
        if (Object.keys(patches).length >= 10) await flush();
        if (b.done % 2 === 0 || b.done === b.total) await writeBio({ message: `Loading profiles: ${b.done} of ${b.total}` });
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    await flush();
    const pausedNow = paused || b.pausedByThrottle;
    const status = pausedNow ? 'paused' : b.ctl.cancel ? 'cancelled' : 'done';
    b.state = { ...(b.state || {}), status, done: b.done, total: b.total, ok: b.ok, failed: b.failed, finishedAt: Date.now(), updatedAt: Date.now(), waiting: false, userId: uid,
      message: pausedNow ? `Paused because Instagram is rate limiting requests. ${b.total - b.done} left. Resume in 15 minutes or so.` : status === 'cancelled' ? `Stopped. ${b.done} of ${b.total} loaded.` : `Loaded ${b.ok} profile${b.ok === 1 ? '' : 's'}${b.failed ? `, ${b.failed} could not be loaded` : ''}.` };
    try { await chrome.storage.local.set({ bioState: b.state }); } catch {}
    state.bio = null;
    return { ok: true };
  }

  // ---------- follow requests and other people's lists ----------

  async function pendingRequests() {
    try {
      const j = await getJson('/api/v1/friendships/pending/', { bestEffort: true });
      return { ok: true, users: (j.users || []).map(mapUser).filter((u) => u.pk) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function listFor(pk, kind, max, settings) {
    if (!/^\d+$/.test(String(pk))) return { ok: false, error: 'Bad user id.' };
    const pacer = makePacer(Number(settings?.delayMin) || 250, 5000);
    const out = [];
    const seen = new Set();
    let maxId = null;
    let truncated = false;
    try {
      for (;;) {
        const qs = new URLSearchParams({ count: '200' });
        if (maxId) qs.set('max_id', maxId);
        if (kind === 'followers') qs.set('search_surface', 'follow_list_page');
        const j = await getJson(`/api/v1/friendships/${pk}/${kind}/?${qs}`, { bestEffort: true, pacer });
        for (const u of j.users || []) { const m = mapUser(u); if (m.pk && !seen.has(m.pk)) { seen.add(m.pk); out.push(m); } }
        const next = j.next_max_id;
        if (!next || next === maxId || !(j.users || []).length) break;
        if (out.length >= max) { truncated = true; break; }
        maxId = String(next);
      }
    } catch (e) {
      if (!out.length) return { ok: false, error: e.message, status: e.status };
    }
    return { ok: true, users: out, truncated };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const reply = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    switch (msg?.type) {
      case 'ping':
        sendResponse({ ok: true, loggedIn: !!cookie('ds_user_id'), userId: cookie('ds_user_id'), scanning: state.running, loadingProfiles: !!state.bio?.running });
        return;
      case 'runScan':
        if (state.running) { sendResponse({ ok: false, error: 'A scan is already running in this tab.' }); return; }
        runScan(msg.settings || {});
        sendResponse({ ok: true });
        return;
      case 'cancelScan':
        if (state.scanCtl) state.scanCtl.cancel = true;
        sendResponse({ ok: true });
        return;
      case 'action':
        reply(doAction(msg.action, msg.pk));
        return true;
      case 'profile':
        reply(getProfile(msg.pk));
        return true;
      case 'loadProfiles':
        if (state.bio?.running) { sendResponse({ ok: false, error: 'A profile load is already running.' }); return; }
        if (state.throttledUntil && Date.now() < state.throttledUntil) { sendResponse({ ok: false, error: `Instagram is rate limiting requests right now. Try again in about ${Math.ceil((state.throttledUntil - Date.now()) / 60000)} minutes.` }); return; }
        runProfileJob(msg.pks || [], msg.settings || {});
        sendResponse({ ok: true, count: (msg.pks || []).length });
        return;
      case 'cancelProfiles':
        if (state.bio) state.bio.ctl.cancel = true;
        sendResponse({ ok: true });
        return;
      case 'pendingRequests':
        reply(pendingRequests());
        return true;
      case 'diagnose':
        reply(diagnose());
        return true;
      case 'listFor':
        reply(listFor(msg.pk, msg.kind || 'followers', Number(msg.max) || 5000, msg.settings || {}));
        return true;
      default:
        return;
    }
  });

  // ---------- Profile badge ----------
  const RESERVED = new Set(['explore', 'reels', 'reel', 'direct', 'accounts', 'p', 'stories', 'tv', 'challenge', 'about', 'legal',
    'privacy', 'terms', 'emails', 'session', 'your_activity', 'archive', 'settings', 'nametag', 'ar', 'search', 'guides',
    'locations', 'topics', 'developer', 'press', 'api', 'jobs', 'blog', 'help', 'web', 'lite', 'igtv', 'live', 'oauth']);

  const badge = {
    enabled: true,
    uid: null,
    ownName: '',
    byName: new Map(),
    followers: new Set(),
    following: new Set(),
    scanTs: 0,
    el: null,
    hiddenFor: null,
    lastPath: null,
    loading: null,
    async reload() {
      if (this.loading) return this.loading;
      this.loading = (async () => {
        try {
          const { settings, activeAccount, accounts } = await chrome.storage.local.get(['settings', 'activeAccount', 'accounts']);
          this.enabled = settings?.showBadge !== false;
          this.uid = cookie('ds_user_id') || activeAccount || null;
          if (!this.enabled || !this.uid) { this.byName = new Map(); this.scanTs = 0; this.render(true); return; }
          this.ownName = accounts?.[this.uid]?.username || '';
          const g = await chrome.storage.local.get([`users_${this.uid}`, `snapshots_${this.uid}`, `tags_${this.uid}`, `whitelist_${this.uid}`]);
          const users = g[`users_${this.uid}`] || {};
          const snaps = g[`snapshots_${this.uid}`] || [];
          const snap = snaps[snaps.length - 1];
          this.byName = new Map();
          this.info = new Map();
          const tags = g[`tags_${this.uid}`] || {};
          const wl = new Set(g[`whitelist_${this.uid}`] || []);
          for (const [pk, r] of Object.entries(users)) {
            if (!r.u) continue;
            this.byName.set(r.u.toLowerCase(), pk);
            this.info.set(pk, { fc: r.fc ?? null, tags: tags[pk]?.t || [], note: tags[pk]?.n || '', wl: wl.has(pk) });
          }
          this.followers = new Set(snap?.followers || []);
          this.following = new Set(snap?.following || []);
          this.scanTs = snap?.ts || 0;
          this.render(true);
        } catch {}
      })();
      await this.loading;
      this.loading = null;
    },
    currentUsername() {
      const m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
      if (!m) return null;
      const name = m[1];
      if (RESERVED.has(name.toLowerCase())) return null;
      return name;
    },
    render(force) {
      const path = location.pathname;
      if (!force && path === this.lastPath) return;
      this.lastPath = path;
      const name = this.currentUsername();
      if (!this.enabled || !name || !this.scanTs || this.hiddenFor === path || name.toLowerCase() === this.ownName.toLowerCase()) {
        this.remove();
        return;
      }
      const pk = this.byName.get(name.toLowerCase());
      const isF = pk ? this.followers.has(pk) : false;
      const isG = pk ? this.following.has(pk) : false;
      let cls = 'igfi-none', label = 'Not in your lists';
      if (isF && isG) { cls = 'igfi-mutual'; label = 'Mutual: you follow each other'; }
      else if (isG) { cls = 'igfi-nfb'; label = 'Does not follow you back'; }
      else if (isF) { cls = 'igfi-fan'; label = 'Follows you, you do not follow back'; }
      const ago = relTime(this.scanTs);
      if (!this.el) {
        this.el = document.createElement('div');
        this.el.id = 'igfi-badge';
        this.el.addEventListener('click', (e) => {
          if (e.target.closest('.igfi-x')) { this.hiddenFor = location.pathname; this.remove(); return; }
          chrome.runtime.sendMessage({ type: 'openDashboard' });
        });
      }
      this.el.className = cls;
      const info = (pk && this.info?.get(pk)) || null;
      const extras = [];
      if (info?.fc != null) extras.push(fmtCountShort(info.fc) + ' followers');
      if (info?.tags?.length) extras.push(info.tags.join(', '));
      if (info?.wl) extras.push('whitelisted');
      if (info?.note) extras.push('note: ' + (info.note.length > 40 ? info.note.slice(0, 37) + '…' : info.note));
      this.el.innerHTML = `<span class="igfi-dot"></span><span class="igfi-text"><b>@${escapeHtml(name)}</b> ${escapeHtml(label)}${extras.length ? `<small>${escapeHtml(extras.join(' · '))}</small>` : ''}<small>as of ${escapeHtml(ago)}</small></span><button class="igfi-x" title="Hide">&times;</button>`;
      if (!this.el.isConnected) document.body.appendChild(this.el);
    },
    remove() {
      if (this.el && this.el.isConnected) this.el.remove();
    },
  };

  function fmtCountShort(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'K';
    return Number(n).toLocaleString();
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function relTime(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 14) return `${d} d ago`;
    return new Date(ts).toLocaleDateString();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes);
    if (keys.some((k) => k === 'settings' || k === 'activeAccount' || k === 'accounts' || k.startsWith('users_') || k.startsWith('snapshots_') || k.startsWith('tags_') || k.startsWith('whitelist_'))) {
      badge.reload();
    }
  });

  badge.reload();
  setInterval(() => badge.render(false), 600);
})();
