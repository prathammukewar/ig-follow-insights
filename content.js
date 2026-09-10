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

  function apiHeaders() {
    const h = { 'x-ig-app-id': APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': '129477', accept: '*/*' };
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

  async function request(path, { method = 'GET', body } = {}) {
    const headers = apiHeaders();
    if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch('https://www.instagram.com' + path, { method, headers, body, credentials: 'include' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }

  const mapUser = (u) => ({
    pk: String(u.pk ?? u.pk_id ?? u.id ?? ''), u: u.username || '', n: u.full_name || '',
    p: !!u.is_private, v: !!u.is_verified, pic: u.profile_pic_url || '',
  });

  // Shared pacing for everything that runs concurrently: keeps a minimum gap between
  // request starts, speeds up after successes and backs off after throttling.
  function makePacer(minMs, maxMs, startMs) {
    const p = { min: Math.max(50, minMs || 250), max: Math.max(minMs || 250, maxMs || 5000), last: 0, chain: Promise.resolve(), throttled: 0 };
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

  // GET JSON with rate-limit handling.
  //   probe: a 400 is thrown right away (used to find the largest page size Instagram accepts)
  //   bestEffort: any failure is thrown right away (used for optional passes)
  async function getJson(path, { probe = false, bestEffort = false, pacer = null, ctl = null } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (ctl?.cancel) throw new ScanError('Scan cancelled.', true);
      if (pacer) await pacer.wait();
      let r;
      try { r = await request(path); } catch (e) { r = { status: 0, json: null, text: String(e) }; }
      if (r.status === 200 && r.json && (r.json.status === 'ok' || Array.isArray(r.json.users))) { pacer?.success(); return r.json; }
      const msg = (r.json && (r.json.message || r.json.error_title)) || '';
      if (probe && r.status === 400) throw new ScanError('Page size rejected', false, 400);
      if (bestEffort) throw new ScanError(`Request failed (${r.status || 'network error'}${msg ? ': ' + msg : ''})`, false, r.status);
      if (r.status === 401 || r.status === 403 || /login_required|checkpoint_required|challenge_required/i.test(msg)) {
        throw new ScanError('Instagram wants you to log in again or finish a security check. Open the Instagram tab, sort that out, then scan again.', true, r.status);
      }
      if (r.status === 404) throw new ScanError('Instagram returned 404 for ' + path + '. The endpoint may have changed.', true, 404);
      if (attempt >= RETRY_WAITS.length) {
        throw new ScanError(`Instagram kept refusing requests (${r.status || 'network error'}${msg ? ': ' + msg : ''}). Wait 15 to 30 minutes and try again.`, true, r.status);
      }
      const throttled = isThrottle(r, msg);
      if (throttled) { pacer?.throttle(); noteThrottle('scan'); }
      const wait = RETRY_WAITS[attempt];
      const why = throttled ? 'Instagram is rate limiting requests' : `Request failed (${r.status || 'network error'})`;
      const until = Date.now() + wait;
      while (Date.now() < until) {
        if (ctl?.cancel) throw new ScanError('Scan cancelled.', true);
        await writeState({ ...progressFields(), message: `${why}. Retrying in ${Math.ceil((until - Date.now()) / 1000)}s`, waiting: true, retryAt: until, waitReason: why });
        const chunk = Math.min(3000, until - Date.now());
        await sleep(chunk);
        if (state.prog) state.prog.waitedMs += chunk;
      }
      await writeState({ ...progressFields(), waiting: false, retryAt: null, message: 'Retrying' });
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

  async function fetchList(kind, uid, expected, settings, opts = {}) {
    const { order = null, bestEffort = false, into = null, label = null, pacer = null, ctl = null } = opts;
    const out = into || [];
    const seen = new Set(out.map((u) => u.pk));
    const startCount = out.length;
    const maxSize = Number(settings.pageSize) || 200;
    const probe = await loadProbe();
    const remembered = probe[kind]?.forMax === maxSize ? probe[kind].size : null;
    const start = remembered || maxSize;
    const sizes = [start, ...PAGE_SIZES.filter((s) => s < start)];
    const strm = state.prog?.k?.[kind];
    if (strm && !label) { strm.start = Date.now(); strm.expected = expected || 0; strm.observed = probe[kind]?.size || 0; }
    let useSurface = kind === 'followers' && probe.followers?.noSurface !== true;
    let sizeIdx = 0;
    let maxId = null;
    let emptyPages = 0;
    for (;;) {
      const count = sizes[sizeIdx];
      const qs = new URLSearchParams({ count: String(count) });
      if (maxId) qs.set('max_id', maxId);
      if (order) qs.set('order', order);
      if (useSurface) qs.set('search_surface', 'follow_list_page');
      let json;
      try {
        json = await getJson(`/api/v1/friendships/${uid}/${kind}/?${qs}`, { probe: !maxId && sizeIdx < sizes.length - 1, bestEffort, pacer, ctl });
      } catch (e) {
        if (e.status === 400 && !maxId && sizeIdx < sizes.length - 1) { sizeIdx++; continue; }
        if (bestEffort && !e.fatal) break;
        throw e;
      }
      let users = Array.isArray(json.users) ? json.users : [];
      if (!maxId && !order) {
        let observed = users.length;
        // The followers list sometimes comes back in small pages when search_surface is set. Try once without it.
        if (kind === 'followers' && useSurface && !probe.followers?.surfaceChecked && observed > 0 && observed < count && !bestEffort) {
          let better = false;
          try {
            const qs2 = new URLSearchParams({ count: String(count) });
            const j2 = await getJson(`/api/v1/friendships/${uid}/${kind}/?${qs2}`, { bestEffort: true, pacer, ctl });
            const u2 = Array.isArray(j2.users) ? j2.users : [];
            if (u2.length > observed) { json = j2; users = u2; observed = u2.length; better = true; }
          } catch {}
          if (state.prog) state.prog.pages++;
          useSurface = !better;
          probe.followers = { ...(probe.followers || {}), surfaceChecked: true, noSurface: better };
        }
        const size = Math.min(count, Math.max(observed, 1));
        probe[kind] = { ...(probe[kind] || {}), size, forMax: maxSize, at: Date.now() };
        try { await chrome.storage.local.set({ probe }); } catch {}
        if (strm && observed > 0) strm.observed = observed;
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
      maxId = String(next);
    }
    return out;
  }

  // Does this account still exist? Used to tell "unfollowed you" from "deactivated".
  async function accountStatus(pk, pacer, ctl) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (ctl?.cancel) return 'unknown';
      if (pacer) await pacer.wait();
      let r;
      try { r = await request(`/api/v1/users/${pk}/info/`); } catch { return 'unknown'; }
      if (r.status === 200 && r.json?.user) { pacer?.success(); return 'active'; }
      if (r.status === 404) return 'gone';
      const msg = (r.json && r.json.message) || '';
      if (isThrottle(r, msg)) { pacer?.throttle(); if (state.prog) state.prog.throttles++; noteThrottle('scan'); await sleep(20000 * (attempt + 1)); continue; }
      return 'unknown';
    }
    return 'unknown';
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
          const g = await chrome.storage.local.get([`users_${this.uid}`, `snapshots_${this.uid}`]);
          const users = g[`users_${this.uid}`] || {};
          const snaps = g[`snapshots_${this.uid}`] || [];
          const snap = snaps[snaps.length - 1];
          this.byName = new Map();
          for (const [pk, r] of Object.entries(users)) if (r.u) this.byName.set(r.u.toLowerCase(), pk);
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
      this.el.innerHTML = `<span class="igfi-dot"></span><span class="igfi-text"><b>@${escapeHtml(name)}</b> ${escapeHtml(label)}<small>as of ${escapeHtml(ago)}</small></span><button class="igfi-x" title="Hide">&times;</button>`;
      if (!this.el.isConnected) document.body.appendChild(this.el);
    },
    remove() {
      if (this.el && this.el.isConnected) this.el.remove();
    },
  };

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
    if (keys.some((k) => k === 'settings' || k === 'activeAccount' || k === 'accounts' || k.startsWith('users_') || k.startsWith('snapshots_'))) {
      badge.reload();
    }
  });

  badge.reload();
  setInterval(() => badge.render(false), 600);
})();
