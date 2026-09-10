// Runs on instagram.com. Two jobs:
//  1. Fetch the followers and following lists using the logged-in session when the
//     background worker asks for a scan, and run single follow/unfollow actions.
//  2. Show a small relationship pill on profile pages based on the last scan.
(() => {
  if (window.__igfiLoaded) return;
  window.__igfiLoaded = true;

  const APP_ID = '936619743392459';
  const state = { running: false, cancel: false, scan: {}, prog: null };

  function newProgress(pageSize) {
    return { pages: 0, waitedMs: 0, listStart: 0, fFound: 0, gFound: 0, expectedF: 0, expectedG: 0, pageSize: pageSize || 50 };
  }

  // Derived numbers the dashboard uses for the progress panel.
  function progressFields() {
    const p = state.prog;
    if (!p) return {};
    const now = Date.now();
    const expectedTotal = (p.expectedF || 0) + (p.expectedG || 0);
    const found = (p.fFound || 0) + (p.gFound || 0);
    const active = p.listStart ? Math.max(0, now - p.listStart - p.waitedMs) : 0;
    const avgPageMs = p.pages ? active / p.pages : 0;
    const remaining = Math.max(0, expectedTotal - found);
    const pagesRemaining = Math.ceil(remaining / p.pageSize);
    const eta = avgPageMs && expectedTotal ? Math.round(pagesRemaining * avgPageMs) : null;
    return {
      pages: p.pages, waitedMs: p.waitedMs, fFound: p.fFound, gFound: p.gFound, expectedF: p.expectedF, expectedG: p.expectedG,
      avgPageMs: Math.round(avgPageMs), eta, pageSize: p.pageSize, overallDone: found, overallTotal: expectedTotal,
    };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.random() * Math.max(0, max - min);

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
    constructor(msg, fatal) { super(msg); this.fatal = fatal; }
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

  const RETRY_WAITS = [20000, 45000, 90000, 180000];

  async function getJson(path, { noRetry = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (state.cancel) throw new ScanError('Scan cancelled.', true);
      let r;
      try { r = await request(path); } catch (e) { r = { status: 0, json: null, text: String(e) }; }
      if (r.status === 200 && r.json && (r.json.status === 'ok' || Array.isArray(r.json.users))) return r.json;
      const msg = (r.json && (r.json.message || r.json.error_title)) || '';
      if (noRetry) throw new ScanError(`Request failed (${r.status || 'network error'}${msg ? ': ' + msg : ''})`, false);
      if (r.status === 401 || r.status === 403 || /login_required|checkpoint_required|challenge_required/i.test(msg)) {
        throw new ScanError('Instagram wants you to log in again or finish a security check. Open the Instagram tab, sort that out, then scan again.', true);
      }
      if (r.status === 404) throw new ScanError('Instagram returned 404 for ' + path + '. The endpoint may have changed.', true);
      if (attempt >= RETRY_WAITS.length) {
        throw new ScanError(`Instagram kept refusing requests (${r.status || 'network error'}${msg ? ': ' + msg : ''}). Wait 15 to 30 minutes and try again.`, true);
      }
      const wait = RETRY_WAITS[attempt];
      const why = r.status === 429 || /wait a few minutes/i.test(msg) ? 'Instagram is rate limiting requests' : `Request failed (${r.status || 'network error'})`;
      const until = Date.now() + wait;
      while (Date.now() < until) {
        if (state.cancel) throw new ScanError('Scan cancelled.', true);
        await writeState({ ...progressFields(), message: `${why}. Retrying in ${Math.ceil((until - Date.now()) / 1000)}s`, waiting: true, retryAt: until, waitReason: why });
        const chunk = Math.min(3000, until - Date.now());
        await sleep(chunk);
        if (state.prog) state.prog.waitedMs += chunk;
      }
      await writeState({ ...progressFields(), waiting: false, retryAt: null, message: 'Retrying' });
    }
  }

  async function fetchList(kind, uid, expected, settings, { order = null, bestEffort = false, into = null, label = null } = {}) {
    const out = into || [];
    const seen = new Set(out.map((u) => u.pk));
    const startCount = out.length;
    let maxId = null;
    let emptyPages = 0;
    for (;;) {
      const qs = new URLSearchParams({ count: String(settings.pageSize || 50) });
      if (maxId) qs.set('max_id', maxId);
      if (order) qs.set('order', order);
      if (kind === 'followers') qs.set('search_surface', 'follow_list_page');
      let json;
      try {
        json = await getJson(`/api/v1/friendships/${uid}/${kind}/?${qs}`, { noRetry: bestEffort });
      } catch (e) {
        if (bestEffort && !(e instanceof ScanError && e.fatal)) break;
        throw e;
      }
      const users = Array.isArray(json.users) ? json.users : [];
      for (const u of users) {
        const pk = String(u.pk ?? u.pk_id ?? u.id ?? '');
        if (!pk || seen.has(pk)) continue;
        seen.add(pk);
        out.push({ pk, u: u.username || '', n: u.full_name || '', p: !!u.is_private, v: !!u.is_verified, pic: u.profile_pic_url || '' });
      }
      if (state.prog) {
        state.prog.pages++;
        state.prog[kind === 'followers' ? 'fFound' : 'gFound'] = out.length;
      }
      await writeState({
        ...progressFields(),
        phase: kind,
        deep: !!label,
        message: label
          ? `${label}: ${out.length - startCount} more found so far`
          : `Fetching ${kind}: ${out.length}${expected ? ' of about ' + expected : ''}`,
        done: out.length,
        total: expected || 0,
      });
      const next = json.next_max_id;
      if (users.length === 0) emptyPages++; else emptyPages = 0;
      if (!next || next === maxId || emptyPages >= 2) break;
      maxId = String(next);
      await sleep(jitter(settings.delayMin ?? 700, settings.delayMax ?? 1500));
    }
    return out;
  }

  async function runScan(settings) {
    if (state.running) return;
    state.running = true;
    state.cancel = false;
    const started = Date.now();
    try {
      const { scanState } = await chrome.storage.local.get('scanState');
      state.scan = scanState || {};
    } catch { state.scan = {}; }
    state.prog = newProgress(settings.pageSize);
    try {
      const uid = cookie('ds_user_id');
      if (!uid) throw new ScanError('You are not logged in to Instagram in this browser. Log in, then scan again.', true);
      await writeState({ status: 'running', phase: 'profile', message: 'Reading your profile', userId: uid, done: 0, total: 0, pages: 0 });

      let me = null;
      try {
        const j = await getJson(`/api/v1/users/${uid}/info/`);
        me = j.user || null;
      } catch (e) {
        if (e.fatal && /log in/i.test(e.message)) throw e;
      }
      const expectedF = me?.follower_count ?? 0;
      const expectedG = me?.following_count ?? 0;
      state.prog.expectedF = expectedF;
      state.prog.expectedG = expectedG;
      state.prog.listStart = Date.now();
      await writeState({ ...progressFields(), phase: 'followers', message: `Starting on ${expectedF ? expectedF + ' ' : ''}followers`, username: me?.username || '' });

      const followers = await fetchList('followers', uid, expectedF, settings);
      const following = await fetchList('following', uid, expectedG, settings);

      // Instagram's list endpoints sometimes skip entries (and always leave out deactivated accounts).
      // When the list comes back short, fetch it again in a different order and merge anything new.
      // If a previous double-check found nothing for a similar shortfall, skip it to save time.
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
        await writeState({ ...progressFields(), phase: kind, deep: true, eta: null, message: `Instagram counts ${expected} ${kind} but returned ${before}. Double-checking the list` });
        await fetchList(kind, uid, expected, settings, { order: 'date_followed_earliest', bestEffort: true, into: list, label: `Double-checking ${kind}` });
        deep[k + 'Found'] = list.length - before;
        deep[k + 'Short'] = expected - list.length;
        deep.at = Date.now();
      }

      await writeState({ ...progressFields(), phase: 'saving', deep: false, eta: 0, message: 'Saving results' });
      const data = {
        requests: state.prog.pages,
        waitedMs: state.prog.waitedMs,
        userId: uid,
        username: me?.username || '',
        fullName: me?.full_name || '',
        pic: me?.profile_pic_url || '',
        followerCount: expectedF || followers.length,
        followingCount: expectedG || following.length,
        followers,
        following,
        deep: Object.keys(deep).length ? deep : null,
        startedAt: started,
        finishedAt: Date.now(),
      };
      const resp = await chrome.runtime.sendMessage({ type: 'scanResult', data });
      if (!resp?.ok) throw new ScanError(resp?.error || 'Could not save the scan.', true);
      badge.reload();
    } catch (e) {
      const msg = e instanceof ScanError ? e.message : 'Unexpected error: ' + (e?.message || e);
      await writeState({ status: state.cancel ? 'cancelled' : 'error', message: msg, finishedAt: Date.now() });
    } finally {
      state.running = false;
      state.cancel = false;
    }
  }

  async function doAction(action, pk) {
    if (!cookie('ds_user_id')) return { ok: false, error: 'Not logged in to Instagram.' };
    if (!/^\d+$/.test(String(pk))) return { ok: false, error: 'Bad user id.' };
    const paths = action === 'unfollow'
      ? [`/api/v1/web/friendships/${pk}/unfollow/`, `/api/v1/friendships/destroy/${pk}/`]
      : [`/api/v1/web/friendships/${pk}/follow/`, `/api/v1/friendships/create/${pk}/`];
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
    const blocked = last?.status === 429 || /feedback_required|spam|blocked|wait a few minutes/i.test(msg);
    return { ok: false, error: msg, status: last?.status || 0, blocked };
  }

  async function getProfile(pk) {
    if (!cookie('ds_user_id')) return { ok: false, error: 'Not logged in to Instagram.' };
    if (!/^\d+$/.test(String(pk))) return { ok: false, error: 'Bad user id.' };
    let r;
    try { r = await request(`/api/v1/users/${pk}/info/`); } catch (e) { r = { status: 0, json: null, text: String(e) }; }
    if (r.status === 200 && r.json && r.json.user) {
      const u = r.json.user;
      return {
        ok: true,
        profile: {
          bio: u.biography || '', link: u.external_url || '', cat: u.category || '',
          fc: u.follower_count ?? null, gc: u.following_count ?? null, mc: u.media_count ?? null,
          p: !!u.is_private, v: !!u.is_verified, n: u.full_name || '', pic: u.profile_pic_url || '',
        },
      };
    }
    const msg = (r.json && r.json.message) || `HTTP ${r.status || 'network error'}`;
    return { ok: false, error: msg, blocked: r.status === 429 || /wait a few minutes/i.test(msg) };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg?.type) {
      case 'ping':
        sendResponse({ ok: true, loggedIn: !!cookie('ds_user_id'), userId: cookie('ds_user_id') });
        return;
      case 'runScan':
        if (state.running) { sendResponse({ ok: false, error: 'A scan is already running in this tab.' }); return; }
        runScan(msg.settings || {});
        sendResponse({ ok: true });
        return;
      case 'cancelScan':
        state.cancel = true;
        sendResponse({ ok: true });
        return;
      case 'action':
        doAction(msg.action, msg.pk).then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
      case 'profile':
        getProfile(msg.pk).then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
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
