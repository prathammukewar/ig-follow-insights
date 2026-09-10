import {
  KEYS, DEFAULT_SETTINGS, EVENT_LABELS, getSettings, saveSettings, snapshotSets, snapshotStats, diffSnapshots,
  loadAccount, applyLocalAction, deleteSnapshot, deleteAccountData, exportBackup, importBackup, mergeUserFields,
} from './lib/store.js';
import {
  esc, el, fmtNum, fmtDate, fmtDateTime, relTime, fmtDuration, initials, profileUrl, toCSV, download, stamp, sleep,
} from './lib/util.js';

const PAGE = 100;
const STALE_MS = 3 * 60 * 1000;

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
  userX: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M17 8l5 5m0-5l-5 5"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  userCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M17 11l2 2 4-4"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

const S = {
  uid: null, accounts: {}, account: null,
  users: {}, snaps: [], events: [], wl: new Set(),
  settings: { ...DEFAULT_SETTINGS }, scanState: null, lastScanStatus: null,
  route: 'overview', params: {},
  q: '', sort: 'recent', filters: { verified: false, private: false, showWl: false },
  limit: PAGE, sel: new Set(), lists: null, latest: null, prev: null,
  logFilter: 'all', logLimit: 150,
  ignoreUntil: 0,
};

const NAV = [
  { id: 'overview', label: 'Overview', icon: ICONS.home },
  { id: 'nfb', label: 'Not following back', icon: ICONS.userX, count: () => nfbList().length },
  { id: 'fans', label: 'Fans', icon: ICONS.heart, count: () => S.lists.fans.length },
  { id: 'mutual', label: 'Mutual', icon: ICONS.swap, count: () => S.lists.mutual.length },
  { id: 'followers', label: 'Followers', icon: ICONS.users, count: () => S.lists.followers.size },
  { id: 'following', label: 'Following', icon: ICONS.userCheck, count: () => S.lists.following.size },
  { id: 'changes', label: 'Changes', icon: ICONS.activity, count: () => changesCount() },
  { id: 'history', label: 'History', icon: ICONS.clock, count: () => S.snaps.length },
  { id: 'whitelist', label: 'Whitelist', icon: ICONS.star, count: () => S.wl.size },
  { id: 'settings', label: 'Settings', icon: ICONS.gear },
];

const LIST_META = {
  nfb: { title: 'Not following back', sub: 'People you follow who do not follow you.', empty: 'Everyone you follow follows you back.' },
  fans: { title: 'Fans', sub: 'People who follow you that you do not follow back.', empty: 'You follow back everyone who follows you.' },
  mutual: { title: 'Mutual', sub: 'You follow each other.', empty: 'No mutual follows yet.' },
  followers: { title: 'Followers', sub: 'Everyone who follows you, as of the last scan.', empty: 'No followers found in the last scan.' },
  following: { title: 'Following', sub: 'Everyone you follow, as of the last scan.', empty: 'You are not following anyone.' },
  whitelist: { title: 'Whitelist', sub: 'People you want to keep following even if they do not follow back. They are hidden from the Not following back list and skipped by bulk unfollows.', empty: 'Your whitelist is empty. Use the star on any row to add someone.' },
};

const main = document.getElementById('main');
const navEl = document.getElementById('nav');
const accountBox = document.getElementById('accountBox');
const scanBox = document.getElementById('scanBox');
const scanBanner = document.getElementById('scanBanner');

// ---------- boot ----------

async function init() {
  sendBg({ type: 'clearBadge' });
  await loadAll();
  applyTheme();
  parseRoute();
  renderAll();
  window.addEventListener('hashchange', () => { parseRoute(); resetListState(); renderAll(); });
  chrome.storage.onChanged.addListener(onStorageChange);
  main.addEventListener('click', onMainClick);
  main.addEventListener('input', onMainInput);
  main.addEventListener('change', onMainChange);
  main.addEventListener('keydown', onMainKeydown);
  scanBox.addEventListener('click', onMainClick);
  scanBanner.addEventListener('click', onMainClick);
  accountBox.addEventListener('change', onMainChange);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  });
  setInterval(() => { if (S.scanState?.status === 'running') { renderScanBox(); renderScanBanner(); } }, 1000);
}

async function loadAll() {
  const g = await chrome.storage.local.get([KEYS.accounts, KEYS.active, KEYS.scanState]);
  S.accounts = g[KEYS.accounts] || {};
  S.scanState = g[KEYS.scanState] || null;
  S.settings = await getSettings();
  const ids = Object.keys(S.accounts);
  S.uid = g[KEYS.active] && S.accounts[g[KEYS.active]] ? g[KEYS.active] : ids[0] || null;
  S.account = S.uid ? S.accounts[S.uid] : null;
  if (S.uid) {
    const d = await loadAccount(S.uid);
    S.users = d.users; S.snaps = d.snaps; S.events = d.events; S.wl = new Set(d.whitelist);
  } else {
    S.users = {}; S.snaps = []; S.events = []; S.wl = new Set();
  }
  recompute();
}

function recompute() {
  S.latest = S.snaps[S.snaps.length - 1] || null;
  S.prev = S.snaps.length > 1 ? S.snaps[S.snaps.length - 2] : null;
  S.lists = S.latest ? snapshotSets(S.latest) : { followers: new Set(), following: new Set(), mutual: [], nfb: [], fans: [] };
}

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  S.route = NAV.some((n) => n.id === path) ? path : 'overview';
  S.params = Object.fromEntries(new URLSearchParams(qs || ''));
}

function resetListState() {
  S.q = '';
  S.limit = PAGE;
  S.sel = new Set();
  S.filters = { verified: false, private: false, showWl: false };
  S.sort = 'recent';
}

async function onStorageChange(changes, area) {
  if (area !== 'local') return;
  if (changes[KEYS.scanState]) {
    const prevStatus = S.scanState?.status;
    S.scanState = changes[KEYS.scanState].newValue || null;
    renderScanBox();
    renderScanBanner();
    const st = S.scanState?.status;
    if (st !== prevStatus) {
      if (st === 'done' && S.scanState.summary) {
        const s = S.scanState.summary;
        toast(s.hasPrev
          ? `Scan complete: ${s.newFollowers} new follower${s.newFollowers === 1 ? '' : 's'}, ${s.lostFollowers} unfollowed you`
          : `First scan saved: ${fmtNum(s.f)} followers, ${fmtNum(s.g)} following`);
      } else if (st === 'error') {
        toast(S.scanState.message || 'Scan failed', 'error', 6000);
      }
    }
  }
  const keys = Object.keys(changes).filter((k) => k !== KEYS.scanState);
  if (!keys.length) return;
  if (Date.now() < S.ignoreUntil) return;
  const relevant = keys.some((k) => k === KEYS.accounts || k === KEYS.active || k === KEYS.settings || (S.uid && k.endsWith('_' + S.uid)));
  if (relevant) {
    await loadAll();
    applyTheme();
    renderAll();
  }
}

function sendBg(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e?.message || String(e) }));
}

// ---------- derived data ----------

function nfbList() {
  return S.lists.nfb.filter((pk) => !S.wl.has(pk));
}

function changesCount() {
  if (!S.prev) return 0;
  const d = diffSnapshots(S.prev, S.latest);
  return d.newFollowers.length + d.lostFollowers.length + d.newFollowing.length + d.lostFollowing.length;
}

function baseList(kind) {
  switch (kind) {
    case 'nfb': return S.filters.showWl ? [...S.lists.nfb] : nfbList();
    case 'fans': return [...S.lists.fans];
    case 'mutual': return [...S.lists.mutual];
    case 'followers': return [...S.lists.followers];
    case 'following': return [...S.lists.following];
    case 'whitelist': return [...S.wl];
    default: return [];
  }
}

function filterSort(pks, kind) {
  const q = S.q.trim().toLowerCase();
  let out = pks;
  if (q || S.filters.verified || S.filters.private) {
    out = out.filter((pk) => {
      const u = S.users[pk] || {};
      if (S.filters.verified && !u.v) return false;
      if (S.filters.private && !u.p) return false;
      if (q && !((u.u || '').toLowerCase().includes(q) || (u.n || '').toLowerCase().includes(q) || (u.bio || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }
  const field = kind === 'followers' || kind === 'fans' ? 'ff' : 'fg';
  const u = (pk) => S.users[pk] || {};
  const byName = (a, b) => (u(a).u || '').localeCompare(u(b).u || '');
  switch (S.sort) {
    case 'az': out.sort(byName); break;
    case 'za': out.sort((a, b) => byName(b, a)); break;
    case 'name': out.sort((a, b) => (u(a).n || u(a).u || '').localeCompare(u(b).n || u(b).u || '')); break;
    case 'oldest': out.sort((a, b) => (u(a)[field] || 0) - (u(b)[field] || 0) || byName(a, b)); break;
    case 'mostFollowers': out.sort((a, b) => (u(b).fc ?? -1) - (u(a).fc ?? -1) || byName(a, b)); break;
    case 'fewestFollowers': out.sort((a, b) => (u(a).fc ?? Infinity) - (u(b).fc ?? Infinity) || byName(a, b)); break;
    default: out.sort((a, b) => (u(b)[field] || 0) - (u(a)[field] || 0) || byName(a, b));
  }
  return out;
}

function firstScanTs() {
  return S.snaps[0]?.ts || 0;
}

// ---------- rendering: shell ----------

function renderAll() {
  renderAccountBox();
  renderNav();
  renderScanBox();
  renderScanBanner();
  renderMain();
}

function etaText(st) {
  if (st.phase === 'saving') return 'a few seconds';
  if (st.deep) return 'a little longer';
  if (st.waiting) return 'paused';
  if (st.eta == null) return 'estimating';
  const left = st.eta - (Date.now() - (st.updatedAt || Date.now()));
  if (left <= 1500) return 'almost done';
  return '~' + fmtDuration(left);
}

function scanIsRunning(st) {
  return st?.status === 'running' && Date.now() - (st.updatedAt || 0) < STALE_MS;
}

function renderScanBanner() {
  const st = S.scanState;
  if (!st || st.status === 'idle') { scanBanner.innerHTML = ''; return; }
  const key = st.finishedAt || st.startedAt;
  if (S.bannerDismissed === key) { scanBanner.innerHTML = ''; return; }
  if (scanIsRunning(st)) {
    const steps = [['profile', 'Profile'], ['followers', 'Followers'], ['following', 'Following'], ['deep', 'Double-check'], ['saving', 'Save']];
    const idx = st.phase === 'saving' ? 4 : st.deep ? 3 : st.phase === 'following' ? 2 : st.phase === 'followers' ? 1 : 0;
    const stepHTML = steps.map(([k, l], i) => {
      const cls = i < idx ? 'done' : i === idx ? 'active' : '';
      let extra = '';
      if (k === 'followers' && (st.expectedF || st.fFound)) extra = `${fmtNum(st.fFound || 0)}${st.expectedF ? ' / ' + fmtNum(st.expectedF) : ''}`;
      if (k === 'following' && (st.expectedG || st.gFound)) extra = `${fmtNum(st.gFound || 0)}${st.expectedG ? ' / ' + fmtNum(st.expectedG) : ''}`;
      if (k === 'deep' && i > idx) extra = 'only if needed';
      return `<li class="${cls}"><span class="n">${i < idx ? '✓' : i + 1}</span>${l}${extra ? ` <span class="muted">${extra}</span>` : ''}</li>`;
    }).join('');
    const pct = st.overallTotal ? Math.min(100, Math.round((st.overallDone / st.overallTotal) * 100)) : 0;
    const elapsed = fmtDuration(Date.now() - (st.startedAt || Date.now()));
    const waitLeft = st.waiting && st.retryAt ? Math.max(0, Math.ceil((st.retryAt - Date.now()) / 1000)) : 0;
    scanBanner.innerHTML = `<div class="card scan-card">
      <div class="scan-head">
        <div><h2 style="margin:0">Scanning${st.username ? ' @' + esc(st.username) : ''}</h2><div class="muted small">Started ${esc(fmtDateTime(st.startedAt))}${st.auto ? ' · scheduled scan' : ''}. Keep the Instagram tab open; it can stay in the background.</div></div>
        <button class="btn sm" data-act="cancelScan">Cancel scan</button>
      </div>
      <ol class="scan-steps">${stepHTML}</ol>
      <div class="progress ${st.overallTotal ? '' : 'indet'}"><div class="bar" style="width:${pct}%"></div></div>
      <div class="scan-pct"><span>${st.overallTotal ? pct + '% of accounts fetched' : 'Working'}</span><span>${st.overallTotal ? fmtNum(st.overallDone || 0) + ' of ' + fmtNum(st.overallTotal) : ''}</span></div>
      <div class="scan-stats">
        <div><div class="v">${esc(etaText(st))}</div><div class="l">Time remaining</div></div>
        <div><div class="v">${esc(elapsed)}</div><div class="l">Elapsed</div></div>
        <div><div class="v">${fmtNum(st.pages || 0)}</div><div class="l">Requests to Instagram</div></div>
        <div><div class="v">${st.avgPageMs ? (st.avgPageMs / 1000).toFixed(1) + 's' : '–'}</div><div class="l">Per request (${st.pageSize || 50} accounts each)</div></div>
        <div><div class="v">${st.waitedMs ? fmtDuration(st.waitedMs) : '0s'}</div><div class="l">Waiting on rate limits</div></div>
        <div><div class="v">${fmtNum((st.fFound || 0) + (st.gFound || 0))}</div><div class="l">Accounts fetched so far</div></div>
      </div>
      <div class="scan-msg">${esc(st.message || '')}</div>
      ${st.waiting ? `<div class="callout warn" style="margin-top:10px;margin-bottom:0">${esc(st.waitReason || 'Instagram asked us to slow down')}. Retrying in ${waitLeft}s. This is normal for large accounts and needs nothing from you.</div>` : ''}
    </div>`;
    return;
  }
  if (st.status === 'done' && st.summary && st.finishedAt && Date.now() - st.finishedAt < 15 * 60 * 1000) {
    const s = st.summary;
    const snap = S.latest;
    scanBanner.innerHTML = `<div class="card scan-card ok">
      <div class="scan-head">
        <div><h2 style="margin:0">Scan finished${s.username ? ' for @' + esc(s.username) : ''}</h2><div class="muted small">${esc(fmtDateTime(st.finishedAt))}${snap?.dur ? ' · took ' + fmtDuration(snap.dur) : ''}${snap?.req ? ' · ' + fmtNum(snap.req) + ' requests' : ''}${snap?.waited ? ' · ' + fmtDuration(snap.waited) + ' waiting on rate limits' : ''}</div></div>
        <button class="btn sm ghost" data-act="dismissBanner">Dismiss</button>
      </div>
      <div class="scan-stats">
        <div><div class="v">${fmtNum(s.f)}</div><div class="l">Followers</div></div>
        <div><div class="v">${fmtNum(s.g)}</div><div class="l">Following</div></div>
        <div><div class="v">${fmtNum(s.nfb)}</div><div class="l">Not following back</div></div>
        ${s.hasPrev ? `<div><div class="v delta up">+${fmtNum(s.newFollowers)}</div><div class="l">New followers</div></div>
        <div><div class="v delta ${s.lostFollowers ? 'down' : ''}">−${fmtNum(s.lostFollowers)}</div><div class="l">Unfollowed you</div></div>` : `<div><div class="v">First scan</div><div class="l">Scan again later to see changes</div></div>`}
      </div>
    </div>`;
    return;
  }
  if (st.status === 'error' || (st.status === 'running' && !scanIsRunning(st))) {
    scanBanner.innerHTML = `<div class="card scan-card err">
      <div class="scan-head">
        <div><h2 style="margin:0">Scan ${st.status === 'error' ? 'failed' : 'stopped responding'}</h2><div class="muted small">${esc(st.message || 'The Instagram tab may have been closed.')}</div></div>
        <div class="actions"><button class="btn sm ghost" data-act="dismissBanner">Dismiss</button><button class="btn sm primary" data-act="scan">Scan again</button></div>
      </div>
    </div>`;
    return;
  }
  scanBanner.innerHTML = '';
}

function renderAccountBox() {
  const ids = Object.keys(S.accounts);
  if (!S.account) {
    accountBox.innerHTML = `<div class="account-card"><div class="avatar sm">?</div><div><div class="name">No account yet</div><div class="when">Run your first scan</div></div></div>`;
    return;
  }
  const a = S.account;
  accountBox.innerHTML = `
    <div class="account-card">
      ${avatarHTML({ u: a.username, n: a.fullName, pic: a.pic }, 'sm')}
      <div style="min-width:0">
        <div class="name">@${esc(a.username || a.id)}</div>
        <div class="when">Scanned ${esc(relTime(a.lastScan))}</div>
      </div>
    </div>
    ${ids.length > 1 ? `<select id="acctSwitch" title="Switch account">${ids.map((id) => `<option value="${id}" ${id === S.uid ? 'selected' : ''}>@${esc(S.accounts[id].username || id)}</option>`).join('')}</select>` : ''}`;
  observeAvatars(accountBox);
}

function renderNav() {
  navEl.innerHTML = NAV.map((n) => {
    const c = n.count ? n.count() : null;
    return `<a href="#/${n.id}" class="${S.route === n.id ? 'active' : ''}">${n.icon}<span>${n.label}</span>${c != null ? `<span class="cnt">${fmtNum(c)}</span>` : ''}</a>`;
  }).join('');
}

function renderScanBox() {
  const st = S.scanState;
  const running = st?.status === 'running';
  const stale = running && Date.now() - (st.updatedAt || 0) > STALE_MS;
  if (running && !stale) {
    const pct = st.overallTotal ? Math.min(100, Math.round((st.overallDone / st.overallTotal) * 100)) : 0;
    const elapsed = st.startedAt ? fmtDuration(Date.now() - st.startedAt) : '';
    scanBox.innerHTML = `
      <div class="msg">${esc(st.message || 'Scanning')}</div>
      <div class="progress ${st.overallTotal ? '' : 'indet'}"><div class="bar" style="width:${pct}%"></div></div>
      <div class="hint">${st.overallTotal ? pct + '% done' : 'Working'}${elapsed ? ' · ' + elapsed + ' elapsed' : ''}<br>${esc(etaText(st))} left · ${fmtNum(st.pages || 0)} requests</div>
      <button class="btn block" data-act="cancelScan" style="margin-top:8px">Cancel scan</button>`;
    return;
  }
  let extra = '';
  if (stale) extra = `<div class="msg err">The scan stopped reporting progress. The Instagram tab may have been closed.</div><button class="btn block" data-act="resetScan" style="margin:8px 0">Reset</button>`;
  else if (st?.status === 'error') extra = `<div class="msg err">${esc(st.message || 'Scan failed')}</div>`;
  else if (st?.status === 'cancelled') extra = `<div class="msg">Scan cancelled.</div>`;
  scanBox.innerHTML = `
    ${extra}
    <button class="btn primary block" data-act="scan">${S.latest ? 'Scan again' : 'Scan now'}</button>
    <div class="hint">Uses your logged-in Instagram tab. One opens in the background if needed.</div>`;
}

function renderMain() {
  document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  if (!S.latest && S.route !== 'settings') return renderWelcome();
  switch (S.route) {
    case 'overview': return renderOverview();
    case 'changes': return renderChanges();
    case 'history': return renderHistory();
    case 'settings': return renderSettings();
    case 'whitelist': return renderListView('whitelist');
    default: return renderListView(S.route);
  }
}

// ---------- welcome ----------

function renderWelcome() {
  main.innerHTML = `
    <header class="page-head"><div><h1>Welcome</h1><p class="sub">Let's take a first look at your followers.</p></div></header>
    <div class="card">
      <h2>How it works</h2>
      <p>The extension reads your followers and following lists through the Instagram tab where you are logged in, the same way the website loads them. Nothing leaves your computer. Every scan is saved so later scans can show who unfollowed you and who is new.</p>
      <ol class="steps">
        <li><div><b>Log in to Instagram</b> in this browser. A tab opens in the background if you do not have one.</div></li>
        <li><div><b>Click Scan now.</b> A few hundred accounts take under a minute. Very large accounts take longer, and the scan slows down on purpose so Instagram does not push back.</div></li>
        <li><div><b>Scan again every so often.</b> Each scan is compared with the last one to log new followers and unfollowers.</div></li>
      </ol>
      <div style="margin-top:16px"><button class="btn primary" data-act="scan">Scan now</button></div>
    </div>
    <div class="card info">
      <b>A note on unfollowing.</b> The dashboard lets you unfollow people one at a time or in small batches. Instagram temporarily blocks accounts that follow or unfollow too fast, so batches run slowly and stop the moment Instagram complains. Use the whitelist for accounts you want to keep no matter what.
    </div>`;
}

// ---------- overview ----------

function delta(n, invert) {
  if (!n) return `<span class="delta">no change</span>`;
  const up = n > 0;
  const good = invert ? !up : up;
  return `<span class="delta ${good ? 'up' : 'down'}">${up ? '+' : ''}${fmtNum(n)} since last scan</span>`;
}

function renderOverview() {
  const st = snapshotStats(S.latest);
  const pst = S.prev ? snapshotStats(S.prev) : null;
  const d = S.prev ? diffSnapshots(S.prev, S.latest) : null;
  const ratio = st.g ? (st.f / st.g) : 0;
  const nfb = nfbList().length;
  main.innerHTML = `
    <header class="page-head">
      <div><h1>Overview</h1><p class="sub">@${esc(S.account.username || S.uid)} · last scan ${esc(fmtDateTime(S.latest.ts))}${S.latest.dur ? ' · took ' + fmtDuration(S.latest.dur) : ''}</p></div>
      <div class="actions"><button class="btn" data-act="exportBackup">Back up data</button></div>
    </header>
    <div class="tiles">
      <a class="tile" href="#/followers"><div class="label">Followers</div><div class="value">${fmtNum(st.f)}</div>${pst ? delta(st.f - pst.f) : '<div class="delta">first scan</div>'}${S.latest.fc && S.latest.fc !== st.f ? `<div class="delta" title="Instagram's counter includes accounts it leaves out of the list">Instagram counts ${fmtNum(S.latest.fc)}</div>` : ''}</a>
      <a class="tile" href="#/following"><div class="label">Following</div><div class="value">${fmtNum(st.g)}</div>${pst ? delta(st.g - pst.g) : '<div class="delta">first scan</div>'}${S.latest.gc && S.latest.gc !== st.g ? `<div class="delta" title="Instagram's counter includes accounts it leaves out of the list">Instagram counts ${fmtNum(S.latest.gc)}</div>` : ''}</a>
      <a class="tile" href="#/nfb"><div class="label">Not following back</div><div class="value">${fmtNum(nfb)}</div><div class="delta">${S.wl.size ? fmtNum(S.lists.nfb.length - nfb) + ' whitelisted hidden' : 'of ' + fmtNum(st.g) + ' you follow'}</div></a>
      <a class="tile" href="#/fans"><div class="label">Fans</div><div class="value">${fmtNum(st.fans)}</div><div class="delta">follow you, not followed back</div></a>
      <a class="tile" href="#/mutual"><div class="label">Mutual</div><div class="value">${fmtNum(st.mutual)}</div><div class="delta">${st.g ? Math.round((st.mutual / st.g) * 100) : 0}% of who you follow</div></a>
      <div class="tile"><div class="label">Follower ratio</div><div class="value">${ratio ? ratio.toFixed(2) : '–'}</div><div class="delta">followers per following</div></div>
    </div>
    ${countGapHTML(st)}
    <div class="card">
      <h2>Since last scan${S.prev ? ` <span class="muted small">(${esc(fmtDateTime(S.prev.ts))})</span>` : ''}</h2>
      ${d ? `<div class="mini">
        <a href="#/changes?tab=newFollowers"><div class="v">+${fmtNum(d.newFollowers.length)}</div><div class="l">New followers</div></a>
        <a href="#/changes?tab=lostFollowers"><div class="v">−${fmtNum(d.lostFollowers.length)}</div><div class="l">Unfollowed you</div></a>
        <a href="#/changes?tab=newFollowing"><div class="v">+${fmtNum(d.newFollowing.length)}</div><div class="l">You started following</div></a>
        <a href="#/changes?tab=lostFollowing"><div class="v">−${fmtNum(d.lostFollowing.length)}</div><div class="l">You stopped following</div></a>
      </div>` : `<div class="empty small">Run a second scan and the changes will show up here.</div>`}
    </div>
    <div class="card">
      <h2>Followers and following over time</h2>
      <div id="chart"></div>
    </div>
    <div class="card">
      <h2>Recent activity</h2>
      ${activityLogHTML(S.events.slice(-12).reverse(), false)}
      ${S.events.length ? `<div style="margin-top:10px"><a href="#/changes">See all changes</a></div>` : ''}
    </div>`;
  renderChart(document.getElementById('chart'));
  observeAvatars();
}

function countGapHTML(st) {
  const gapF = S.latest.fc ? S.latest.fc - st.f : 0;
  const gapG = S.latest.gc ? S.latest.gc - st.g : 0;
  if (gapF <= 0 && gapG <= 0) return '';
  const parts = [];
  if (gapG > 0) parts.push(`Instagram says you follow <b>${fmtNum(S.latest.gc)}</b> accounts but only listed <b>${fmtNum(st.g)}</b>`);
  if (gapF > 0) parts.push(`Instagram says you have <b>${fmtNum(S.latest.fc)}</b> followers but only listed <b>${fmtNum(st.f)}</b>`);
  const deep = S.account?.deep;
  const checked = deep && ((gapG > 0 && deep.gFound != null) || (gapF > 0 && deep.fFound != null));
  const found = deep ? (deep.gFound || 0) + (deep.fFound || 0) : 0;
  return `<div class="card info">
    <b>About the numbers.</b> ${parts.join('. ')}. The accounts Instagram leaves out of its lists are almost always deactivated, disabled or restricted, and they still count toward the total on your profile. ${checked ? (found ? `A second pass in a different order recovered ${fmtNum(found)} that the first pass had skipped.` : 'A second pass in a different order found nothing extra, so the missing ones are not visible to anyone right now.') : ''}
  </div>`;
}

// ---------- list views ----------

function renderListView(kind) {
  const meta = LIST_META[kind];
  const all = baseList(kind);
  const pks = filterSort(all, kind);
  const sortOpts = [
    ['recent', kind === 'followers' || kind === 'fans' ? 'Newest followers first' : 'Most recently followed first'],
    ['oldest', 'Oldest first'], ['az', 'Username A to Z'], ['za', 'Username Z to A'], ['name', 'Full name'],
    ['mostFollowers', 'Most followers (needs bios loaded)'], ['fewestFollowers', 'Fewest followers (needs bios loaded)'],
  ];
  main.innerHTML = `
    <header class="page-head">
      <div><h1>${meta.title}</h1><p class="sub">${meta.sub}</p></div>
    </header>
    ${kind === 'whitelist' ? whitelistTopHTML() : ''}
    <div class="toolbar">
      <input class="search" id="q" placeholder="Search username, name or bio" value="${esc(S.q)}">
      <select id="sort">${sortOpts.map(([v, l]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="chk-inline"><input type="checkbox" id="fVerified" ${S.filters.verified ? 'checked' : ''}> Verified</label>
      <label class="chk-inline"><input type="checkbox" id="fPrivate" ${S.filters.private ? 'checked' : ''}> Private</label>
      ${kind === 'nfb' ? `<label class="chk-inline"><input type="checkbox" id="fShowWl" ${S.filters.showWl ? 'checked' : ''}> Show whitelisted</label>` : ''}
      <span class="count" id="count"></span>
      <button class="btn sm" data-act="loadBios" id="bioBtn" title="Fetch bio and follower counts for the rows on screen">Load bios</button>
      <button class="btn sm" data-act="selectVisible">Select all</button>
      <div class="dropdown"><button class="btn sm" data-act="menu">Export</button><div class="menu">
        <button data-act="exportCsv">Download CSV</button><button data-act="exportJson">Download JSON</button><button data-act="copyNames">Copy usernames</button>
      </div></div>
    </div>
    <div class="bulkbar" id="bulkbar" hidden></div>
    <div class="list" id="list"></div>
    <div class="more" id="more"></div>`;
  renderListBody(kind);
  updateBioBtn();
}

function renderListBody(kind) {
  const all = baseList(kind);
  const pks = filterSort(all, kind);
  const list = document.getElementById('list');
  const more = document.getElementById('more');
  const count = document.getElementById('count');
  if (!list) return;
  const shown = pks.slice(0, S.limit);
  list.innerHTML = shown.length ? shown.map((pk) => rowHTML(pk)).join('') : `<div class="empty"><b>${S.q || S.filters.verified || S.filters.private ? 'No matches' : 'Nothing here'}</b>${S.q || S.filters.verified || S.filters.private ? 'Try a different search or filter.' : esc(LIST_META[kind].empty)}</div>`;
  more.innerHTML = pks.length > S.limit ? `<button class="btn" data-act="more">Show more (${fmtNum(pks.length - S.limit)} left)</button>` : '';
  count.textContent = pks.length === all.length ? `${fmtNum(all.length)} accounts` : `${fmtNum(pks.length)} of ${fmtNum(all.length)}`;
  renderBulkbar();
  observeAvatars();
}

function renderBulkbar() {
  const bar = document.getElementById('bulkbar');
  if (!bar) return;
  const n = S.sel.size;
  bar.hidden = n === 0;
  if (!n) return;
  const sel = [...S.sel];
  const canUnfollow = sel.filter((pk) => S.lists.following.has(pk) && !S.wl.has(pk)).length;
  const canFollow = sel.filter((pk) => !S.lists.following.has(pk)).length;
  bar.innerHTML = `<b>${fmtNum(n)} selected</b>
    ${canUnfollow ? `<button class="btn sm danger" data-act="bulkUnfollow">Unfollow ${fmtNum(canUnfollow)}</button>` : ''}
    ${canFollow ? `<button class="btn sm" data-act="bulkFollow">Follow ${fmtNum(canFollow)}</button>` : ''}
    <button class="btn sm" data-act="bulkWl">Whitelist selected</button>
    <span class="spacer"></span>
    <button class="btn sm ghost" data-act="clearSel">Clear selection</button>`;
}

function sinceText(pk) {
  const u = S.users[pk] || {};
  const isF = S.lists.followers.has(pk), isG = S.lists.following.has(pk);
  const first = firstScanTs();
  const fmt = (ts) => (ts && ts > first ? fmtDate(ts) : `${fmtDate(first)} or earlier`);
  const bits = [];
  if (isF) bits.push(`Follows you since ${fmt(u.ff)}`);
  if (isG) bits.push(`You follow since ${fmt(u.fg)}`);
  if (!isF && u.lf) bits.push(`Unfollowed you ${fmtDate(u.lf)}`);
  if (!isG && u.lg) bits.push(`You unfollowed ${fmtDate(u.lg)}`);
  return bits.join(' · ');
}

function avatarHTML(u, size) {
  const cls = 'avatar' + (size ? ' ' + size : '');
  return `<div class="${cls}" data-pic="${esc(u.pic || '')}"><span>${esc(initials(u.n, u.u))}</span></div>`;
}

function rowHTML(pk, opts = {}) {
  const u = S.users[pk] || { u: String(pk), n: '' };
  const isF = S.lists.followers.has(pk), isG = S.lists.following.has(pk);
  const wl = S.wl.has(pk);
  const chips = [];
  if (isF) chips.push('<span class="chip ok">Follows you</span>');
  if (isG) chips.push('<span class="chip info">You follow</span>');
  if (!isF && !isG) chips.push('<span class="chip gray">Not connected</span>');
  return `<div class="row" data-pk="${esc(pk)}">
    <label class="chk"><input type="checkbox" class="sel" ${S.sel.has(pk) ? 'checked' : ''}></label>
    ${avatarHTML(u)}
    <div class="who">
      <div class="line1"><a class="uname" href="${profileUrl(u.u)}" target="_blank" rel="noopener">${esc(u.u || pk)}</a>${u.v ? '<span class="vbadge" title="Verified">✓</span>' : ''}${u.p ? '<span class="chip gray">Private</span>' : ''}${wl ? '<span class="chip warn">Whitelisted</span>' : ''}</div>
      ${u.n ? `<div class="line2">${esc(u.n)}</div>` : ''}
      <div class="line3">${chips.join('')}${u.fc != null ? `<span class="chip gray" title="Their follower count">${fmtCount(u.fc)} followers</span>` : ''}<span class="since">${esc(sinceText(pk))}</span></div>
      ${bioHTML(u)}
    </div>
    <div class="acts">
      <button class="btn sm ghost" data-act="bio" title="${u.bioAt ? 'Refresh bio and counts from Instagram' : 'Load bio and follower count from Instagram'}">${u.bioAt ? '↻' : 'Bio'}</button>
      ${opts.wlAdd ? `<button class="btn sm primary" data-act="wl">Add to whitelist</button>` : `${isG ? `<button class="icon-btn star ${wl ? 'on' : ''}" data-act="wl" title="${wl ? 'Remove from whitelist' : 'Add to whitelist'}">${wl ? '★' : '☆'}</button>` : ''}
      ${isG
        ? `<button class="btn sm danger" data-act="unfollow">Unfollow</button>`
        : `<button class="btn sm" data-act="follow">${isF ? 'Follow back' : 'Follow'}</button>`}`}
      <a class="btn sm ghost" href="${profileUrl(u.u)}" target="_blank" rel="noopener">Open</a>
    </div>
  </div>`;
}

function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'K';
  return fmtNum(n);
}

function bioHTML(u) {
  if (!u.bioAt) return '';
  const meta = [];
  if (u.fc != null) meta.push(`${fmtNum(u.fc)} followers`);
  if (u.gc != null) meta.push(`${fmtNum(u.gc)} following`);
  if (u.mc != null) meta.push(`${fmtNum(u.mc)} posts`);
  if (u.cat) meta.push(esc(u.cat));
  meta.push(`as of ${esc(fmtDate(u.bioAt))}`);
  return `<div class="bio-wrap">
    ${u.bio ? `<div class="bio" title="Click to expand">${esc(u.bio)}</div>` : '<div class="bio muted">No bio</div>'}
    ${u.link ? `<a class="bio-link" href="${esc(/^https?:\/\//i.test(u.link) ? u.link : 'https://' + u.link)}" target="_blank" rel="noopener">${esc(u.link.replace(/^https?:\/\//i, ''))}</a>` : ''}
    <div class="bio-meta">${meta.join(' · ')}</div>
  </div>`;
}

// ---------- bios ----------

let bioJob = null;

function updateBioBtn() {
  main.querySelectorAll('[data-act="loadBios"], [data-act="loadNfbCounts"]').forEach((b) => {
    if (bioJob) {
      b.textContent = `Loading ${bioJob.done} of ${bioJob.total} (click to stop)`;
      b.classList.add('working');
    } else {
      b.textContent = b.dataset.idle || 'Load bios';
      b.classList.remove('working');
    }
  });
}

// ---------- whitelist page ----------

const WL_MIN_OPTIONS = [[0, 'any number of'], [1000, '1,000'], [5000, '5,000'], [10000, '10,000'], [50000, '50,000'], [100000, '100,000'], [1000000, '1,000,000']];

function whitelistTopHTML() {
  return `
    <div class="card">
      <h2>Add someone</h2>
      <div class="inline-form suggest-wrap">
        <input id="wlInput" placeholder="Start typing a username or name" autocomplete="off" spellcheck="false">
        <button class="btn" data-act="wlAdd">Add to whitelist</button>
        <div class="suggest" id="wlSug" hidden></div>
      </div>
      <div class="muted small" style="margin-top:6px">Suggestions come from the people you follow, as of your last scan.</div>
    </div>
    <div id="wlSuggest">${wlSuggestHTML()}</div>`;
}

function wlCandidates() {
  return S.lists.nfb.filter((pk) => !S.wl.has(pk));
}

function wlSuggestHTML() {
  const cands = wlCandidates();
  const withCounts = cands.filter((pk) => S.users[pk]?.bioAt);
  const missing = cands.length - withCounts.length;
  const min = Number(S.wlMin ?? 1000);
  const ranked = withCounts.filter((pk) => (S.users[pk].fc ?? 0) >= min).sort((a, b) => (S.users[b].fc ?? 0) - (S.users[a].fc ?? 0));
  const limit = S.wlSugLimit || 20;
  const shown = ranked.slice(0, limit);
  const delay = Math.max(500, Number(S.settings.bioDelay) || 1500);
  const est = Math.ceil((missing * delay * 1.05) / 60000);
  return `<div class="card">
    <div class="page-head" style="margin-bottom:10px">
      <div><h2 style="margin-bottom:2px">Suggested for your whitelist</h2><p class="sub small">Accounts you follow that don't follow back, ranked by how many followers they have. Popular accounts rarely follow back, so these are the ones you probably want to keep.</p></div>
      <div class="actions"><label class="chk-inline">At least <select id="wlMin">${WL_MIN_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === min ? 'selected' : ''}>${l}</option>`).join('')}</select> followers</label></div>
    </div>
    ${cands.length === 0 ? `<div class="empty small">Everyone you follow either follows you back or is already whitelisted.</div>` : ''}
    ${missing ? `<div class="callout info"><b>${fmtNum(missing)} of ${fmtNum(cands.length)}</b> accounts don't have follower counts yet, so they can't be ranked. <button class="btn sm" data-act="loadNfbCounts" data-idle="Load counts for ${fmtNum(missing)}">Load counts for ${fmtNum(missing)}</button> <span class="muted small">about ${est} min${est === 1 ? '' : 's'}, one profile at a time</span></div>` : ''}
    ${shown.length ? `<div class="list">${shown.map((pk) => rowHTML(pk, { wlAdd: true })).join('')}</div>` : (cands.length && !missing ? `<div class="empty small">No one above that follower count. Lower the threshold to see more.</div>` : (cands.length ? `<div class="empty small">Load counts to see suggestions.</div>` : ''))}
    ${ranked.length > shown.length ? `<div class="more"><button class="btn" data-act="wlSugMore">Show more (${fmtNum(ranked.length - shown.length)} left)</button></div>` : ''}
    ${shown.length > 1 ? `<div style="margin-top:10px"><button class="btn sm" data-act="wlAddShown">Add all ${shown.length} shown to the whitelist</button></div>` : ''}
  </div>`;
}

function refreshWlSuggest() {
  const s = document.getElementById('wlSuggest');
  if (!s) return;
  s.innerHTML = wlSuggestHTML();
  updateBioBtn();
  observeAvatars();
}

function refreshWhitelist() {
  refreshWlSuggest();
  renderListBody('whitelist');
  renderNav();
}

function wlAutocomplete(raw) {
  const box = document.getElementById('wlSug');
  if (!box) return;
  const q = raw.trim().replace(/^@/, '').toLowerCase();
  if (!q) { box.hidden = true; box.innerHTML = ''; S.wlMatches = []; S.wlHi = -1; return; }
  const score = (u) => {
    const un = (u.u || '').toLowerCase(), n = (u.n || '').toLowerCase();
    if (un.startsWith(q)) return 0;
    if (n.startsWith(q)) return 1;
    if (un.includes(q)) return 2;
    if (n.includes(q)) return 3;
    return 9;
  };
  const m = [];
  for (const pk of S.lists.following) {
    if (S.wl.has(pk)) continue;
    const u = S.users[pk] || {};
    const sc = score(u);
    if (sc < 9) m.push([sc, pk, u]);
  }
  m.sort((a, b) => a[0] - b[0] || (b[2].fc ?? -1) - (a[2].fc ?? -1) || (a[2].u || '').localeCompare(b[2].u || ''));
  const top = m.slice(0, 8);
  S.wlMatches = top.map((x) => x[1]);
  S.wlHi = top.length ? 0 : -1;
  box.innerHTML = top.length
    ? top.map(([, pk, u], i) => `<div class="item ${i === 0 ? 'active' : ''}" data-pk="${esc(pk)}">${avatarHTML(u, 'sm')}<div class="grow"><div><b>${esc(u.u || pk)}</b>${u.v ? ' <span class="vbadge">✓</span>' : ''} ${S.lists.followers.has(pk) ? '<span class="chip ok">Follows you</span>' : '<span class="chip danger">Not following you</span>'}</div>${u.n ? `<div class="line2">${esc(u.n)}</div>` : ''}</div>${u.fc != null ? `<span class="chip gray">${fmtCount(u.fc)} followers</span>` : ''}</div>`).join('')
    : `<div class="item none">No one you follow matches "${esc(q)}"</div>`;
  box.hidden = false;
}

function wlHighlight(delta) {
  if (!S.wlMatches?.length) return;
  S.wlHi = (S.wlHi + delta + S.wlMatches.length) % S.wlMatches.length;
  document.querySelectorAll('#wlSug .item').forEach((it, i) => it.classList.toggle('active', i === S.wlHi));
  document.querySelector('#wlSug .item.active')?.scrollIntoView({ block: 'nearest' });
}

async function wlAddPk(pk) {
  if (!pk || S.wl.has(pk)) return;
  S.wl.add(pk);
  await persistWl();
  const input = document.getElementById('wlInput');
  if (input) input.value = '';
  const box = document.getElementById('wlSug');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  S.wlMatches = []; S.wlHi = -1;
  toast(`@${S.users[pk]?.u || pk} added to the whitelist`);
  refreshWhitelist();
  input?.focus();
}

function onMainKeydown(e) {
  if (e.target.id !== 'wlInput') return;
  if (e.key === 'ArrowDown') { e.preventDefault(); wlHighlight(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); wlHighlight(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); addFromWlInput(); }
  else if (e.key === 'Escape') { const box = document.getElementById('wlSug'); if (box) box.hidden = true; }
}

async function addFromWlInput() {
  const input = document.getElementById('wlInput');
  const name = (input?.value || '').trim().replace(/^@/, '').toLowerCase();
  if (!name) return;
  const exact = [...S.lists.following].find((pk) => (S.users[pk]?.u || '').toLowerCase() === name);
  const pk = exact || (S.wlHi >= 0 ? S.wlMatches?.[S.wlHi] : null);
  if (!pk) { toast(`No one you follow matches "${name}"`, 'warn'); return; }
  await wlAddPk(pk);
}

function applyProfile(pk, p) {
  const u = S.users[pk] || (S.users[pk] = { u: String(pk), n: '' });
  const fields = { bio: p.bio, link: p.link, cat: p.cat, fc: p.fc, gc: p.gc, mc: p.mc, bioAt: Date.now() };
  if (p.n) fields.n = p.n;
  if (p.pic) fields.pic = p.pic;
  fields.p = p.p; fields.v = p.v;
  Object.assign(u, fields);
  return fields;
}

async function persistProfiles(patches) {
  if (!Object.keys(patches).length) return;
  S.ignoreUntil = Date.now() + 2000;
  await mergeUserFields(S.uid, patches);
}

async function loadBios(pks, { single = false } = {}) {
  if (bioJob) { bioJob.stop = true; return; }
  const todo = single ? pks : pks.filter((pk) => !S.users[pk]?.bioAt);
  if (!todo.length) { toast('Bios are already loaded for the rows on screen'); return; }
  bioJob = { stop: false, done: 0, total: todo.length };
  updateBioBtn();
  if (!single) toast(`Fetching ${todo.length} profile${todo.length === 1 ? '' : 's'}, one at a time. Click the button again to stop.`);
  const delay = Math.max(500, Number(S.settings.bioDelay) || 1500);
  let patches = {};
  let hadError = null;
  for (let i = 0; i < todo.length; i++) {
    if (bioJob.stop) break;
    const pk = todo[i];
    const r = await sendBg({ type: 'profile', pk });
    if (r?.ok && r.profile) {
      patches[pk] = applyProfile(pk, r.profile);
      patchRow(pk);
    } else {
      hadError = r?.error || 'unknown error';
      if (r?.blocked) {
        toast('Instagram is rate limiting profile requests. Wait a few minutes and try again.', 'error', 7000);
        break;
      }
      if (single) toast(`Could not load that profile: ${hadError}`, 'error', 6000);
    }
    bioJob.done++;
    updateBioBtn();
    if (Object.keys(patches).length >= 5) { await persistProfiles(patches); patches = {}; if (S.route === 'whitelist') refreshWlSuggest(); }
    if (i < todo.length - 1 && !bioJob.stop) await sleep(delay * (0.8 + Math.random() * 0.5));
  }
  await persistProfiles(patches);
  const done = bioJob.done, stopped = bioJob.stop;
  bioJob = null;
  updateBioBtn();
  if (S.route === 'whitelist') refreshWlSuggest();
  if (!single && done) toast(`${stopped ? 'Stopped. ' : ''}Loaded ${done} profile${done === 1 ? '' : 's'}`);
}

// ---------- avatars ----------

let avatarMode = 'img';
const blobCache = new Map();
const avatarIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { avatarIO.unobserve(e.target); loadAvatar(e.target); }
  }
}, { rootMargin: '300px' });

function observeAvatars(root = main) {
  root.querySelectorAll('.avatar[data-pic]:not([data-seen])').forEach((a) => { a.dataset.seen = '1'; if (a.dataset.pic) avatarIO.observe(a); });
}

async function loadAvatar(div) {
  const url = div.dataset.pic;
  if (!url || avatarMode === 'none') return;
  if (avatarMode === 'img') {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => div.replaceChildren(img);
    img.onerror = () => { avatarMode = 'fetch'; loadAvatar(div); };
    img.src = url;
    return;
  }
  try {
    let obj = blobCache.get(url);
    if (!obj) {
      const r = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new Error(String(r.status));
      obj = URL.createObjectURL(await r.blob());
      blobCache.set(url, obj);
    }
    const img = new Image();
    img.src = obj;
    div.replaceChildren(img);
  } catch {
    // keep initials
  }
}

// ---------- changes ----------

function snapLabel(s) {
  return `${fmtDateTime(s.ts)} (${fmtNum(s.followers.length)} / ${fmtNum(s.following.length)})`;
}

function renderChanges() {
  const snaps = S.snaps;
  if (snaps.length < 2) {
    main.innerHTML = `
      <header class="page-head"><div><h1>Changes</h1><p class="sub">Compare two scans to see who came and went.</p></div></header>
      <div class="card"><div class="empty"><b>Only one scan so far</b>Run another scan and this page will show new followers, people who unfollowed you, and changes to who you follow.</div></div>
      ${S.events.length ? `<div class="card"><h2>Activity log</h2>${activityLogHTML(S.events.slice().reverse(), true)}</div>` : ''}`;
    observeAvatars();
    return;
  }
  const toTs = Number(S.params.to) || snaps[snaps.length - 1].ts;
  const toIdx = Math.max(0, snaps.findIndex((s) => s.ts === toTs));
  const to = snaps[toIdx];
  const fromTs = Number(S.params.from) || snaps[Math.max(0, toIdx - 1)].ts;
  const from = snaps.find((s) => s.ts === fromTs) || snaps[Math.max(0, toIdx - 1)];
  const d = diffSnapshots(from, to);
  const tabs = [
    ['newFollowers', 'New followers', d.newFollowers],
    ['lostFollowers', 'Unfollowed you', d.lostFollowers],
    ['newFollowing', 'You started following', d.newFollowing],
    ['lostFollowing', 'You stopped following', d.lostFollowing],
  ];
  const tab = tabs.some(([k]) => k === S.params.tab) ? S.params.tab : (d.lostFollowers.length ? 'lostFollowers' : d.newFollowers.length ? 'newFollowers' : 'newFollowers');
  const cur = tabs.find(([k]) => k === tab);
  const pks = filterSort(cur[2].slice(), tab.includes('Follower') ? 'followers' : 'following');
  const opt = (sel) => snaps.map((s) => `<option value="${s.ts}" ${s.ts === sel ? 'selected' : ''}>${esc(snapLabel(s))}</option>`).join('');
  main.innerHTML = `
    <header class="page-head">
      <div><h1>Changes</h1><p class="sub">Comparing two scans. Numbers in brackets are followers / following.</p></div>
      <div class="actions">
        <select id="fromSel" title="From">${opt(from.ts)}</select>
        <span class="muted">to</span>
        <select id="toSel" title="To">${opt(to.ts)}</select>
      </div>
    </header>
    <div class="tabs">${tabs.map(([k, l, arr]) => `<button class="${k === tab ? 'active' : ''}" data-act="ctab" data-tab="${k}">${l}<span class="n">${fmtNum(arr.length)}</span></button>`).join('')}</div>
    ${tab === 'lostFollowers' ? `<div class="callout warn">Someone can also disappear from your followers because they deactivated, were suspended, or blocked you.</div>` : ''}
    <div class="toolbar">
      <input class="search" id="q" placeholder="Search username, name or bio" value="${esc(S.q)}">
      <span class="count" id="count"></span>
      <button class="btn sm" data-act="loadBios" id="bioBtn" title="Fetch bio and follower counts for the rows on screen">Load bios</button>
      <button class="btn sm" data-act="selectVisible">Select all</button>
      <div class="dropdown"><button class="btn sm" data-act="menu">Export</button><div class="menu">
        <button data-act="exportCsv">Download CSV</button><button data-act="exportJson">Download JSON</button><button data-act="copyNames">Copy usernames</button>
      </div></div>
    </div>
    <div class="bulkbar" id="bulkbar" hidden></div>
    <div class="list" id="list">${pks.slice(0, S.limit).map((pk) => rowHTML(pk)).join('') || `<div class="empty"><b>Nothing in this group</b>No ${cur[1].toLowerCase()} between these two scans.</div>`}</div>
    <div class="more" id="more">${pks.length > S.limit ? `<button class="btn" data-act="more">Show more (${fmtNum(pks.length - S.limit)} left)</button>` : ''}</div>
    <div class="card" style="margin-top:20px">
      <h2>Activity log</h2>
      <div class="tabs">${[['all', 'All'], ['lost_follower', 'Unfollowed you'], ['new_follower', 'New followers'], ['new_following', 'You followed'], ['lost_following', 'You unfollowed']].map(([k, l]) => `<button class="${S.logFilter === k ? 'active' : ''}" data-act="logFilter" data-k="${k}">${l}</button>`).join('')}</div>
      ${activityLogHTML(S.events.filter((e) => S.logFilter === 'all' || e.k === S.logFilter).slice().reverse(), true)}
    </div>`;
  document.getElementById('count').textContent = `${fmtNum(pks.length)} accounts`;
  S.changesKind = tab.includes('Follower') ? 'followers' : 'following';
  S.changesPks = cur[2].slice();
  renderBulkbar();
  updateBioBtn();
  observeAvatars();
}

function activityLogHTML(events, grouped) {
  if (!events.length) return `<div class="empty small">No activity recorded yet. Changes appear here after your second scan.</div>`;
  const shown = events.slice(0, S.logLimit);
  const rowOf = (e) => {
    const u = S.users[e.pk] || { u: String(e.pk), n: '' };
    return `<div class="log-row">
      ${avatarHTML(u, 'sm')}
      <div style="min-width:0"><a class="uname" href="${profileUrl(u.u)}" target="_blank" rel="noopener">${esc(u.u)}</a> <span class="muted">${esc(EVENT_LABELS[e.k] || e.k)}${e.src === 'you' ? ' (from this extension)' : ''}</span>${u.n ? `<div class="line2">${esc(u.n)}</div>` : ''}</div>
      <div class="t">${esc(fmtDateTime(e.t))}</div>
    </div>`;
  };
  if (!grouped) return `<div>${shown.map(rowOf).join('')}</div>`;
  const groups = [];
  for (const e of shown) {
    const key = e.src === 'you' ? 'day:' + new Date(e.t).toDateString() : 'scan:' + e.t;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, t: e.t, src: e.src, items: [] }; groups.push(g); }
    g.items.push(e);
  }
  const html = groups.map((g) => `<div class="log-group"><h4>${g.src === 'you' ? 'Your actions on ' + esc(fmtDate(g.t)) : 'Scan on ' + esc(fmtDateTime(g.t))} · ${g.items.length}</h4>${g.items.map(rowOf).join('')}</div>`).join('');
  const more = events.length > S.logLimit ? `<div class="more"><button class="btn" data-act="logMore">Show more (${fmtNum(events.length - S.logLimit)} left)</button></div>` : '';
  return html + more;
}

// ---------- history ----------

function renderHistory() {
  const rows = S.snaps.slice().reverse().map((s, i, arr) => {
    const st = snapshotStats(s);
    const older = arr[i + 1];
    const pst = older ? snapshotStats(older) : null;
    const d = (a, b) => (pst == null || a === b ? '' : `<span class="delta ${a - b > 0 ? 'up' : 'down'}">${a - b > 0 ? '+' : ''}${fmtNum(a - b)}</span>`);
    return `<tr>
      <td>${esc(fmtDateTime(s.ts))}${s.dur ? `<div class="muted small">took ${fmtDuration(s.dur)}${s.req ? ' · ' + fmtNum(s.req) + ' requests' : ''}</div>` : ''}</td>
      <td>${fmtNum(st.f)} ${d(st.f, pst?.f)}</td>
      <td>${fmtNum(st.g)} ${d(st.g, pst?.g)}</td>
      <td>${fmtNum(st.mutual)}</td>
      <td>${fmtNum(st.nfb)}</td>
      <td>${fmtNum(st.fans)}</td>
      <td style="white-space:nowrap">
        ${older ? `<a class="btn sm ghost" href="#/changes?from=${older.ts}&to=${s.ts}">Changes</a>` : ''}
        <button class="btn sm ghost" data-act="exportSnap" data-ts="${s.ts}">Export</button>
        ${S.snaps.length > 1 ? `<button class="btn sm ghost danger" data-act="delSnap" data-ts="${s.ts}">Delete</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  main.innerHTML = `
    <header class="page-head"><div><h1>History</h1><p class="sub">Every scan is kept so you can compare any two. The oldest scans are dropped after ${S.settings.maxSnapshots} (change this in Settings).</p></div></header>
    <div class="card"><h2>Followers and following over time</h2><div id="chart"></div></div>
    <div class="card">
      <div class="table-wrap"><table class="hist">
        <thead><tr><th>Scan</th><th>Followers</th><th>Following</th><th>Mutual</th><th>Not following back</th><th>Fans</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  renderChart(document.getElementById('chart'));
}

// ---------- chart ----------

function renderChart(container) {
  if (!container) return;
  const snaps = S.snaps;
  if (snaps.length < 2) {
    container.innerHTML = `<div class="empty small">Run at least two scans to see a trend.</div>`;
    return;
  }
  container.className = 'chart';
  let lastW = 0;
  const draw = () => {
    const W = Math.max(320, Math.floor(container.clientWidth || 600));
    if (W === lastW) return;
    lastW = W;
    const H = 240, pl = 56, pr = 16, pt = 14, pb = 30;
    const n = snaps.length;
    const f = snaps.map((s) => s.followers.length);
    const g = snaps.map((s) => s.following.length);
    let lo = Math.min(...f, ...g), hi = Math.max(...f, ...g);
    const span = Math.max(4, hi - lo);
    lo = Math.max(0, Math.floor(lo - span * 0.12));
    hi = Math.ceil(hi + span * 0.12);
    const x = (i) => pl + (i / (n - 1)) * (W - pl - pr);
    const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const ticks = 4;
    const grid = [];
    for (let i = 0; i <= ticks; i++) {
      const v = lo + ((hi - lo) * i) / ticks;
      grid.push(`<line x1="${pl}" x2="${W - pr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${pl - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="axis">${fmtNum(Math.round(v))}</text>`);
    }
    const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
    const xlabels = xl.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(fmtDate(snaps[i].ts))}</text>`);
    const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const dots = (arr, color) => (n <= 60 ? arr.map((v, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="${color}"/>`).join('') : '');
    container.innerHTML = `
      <div class="legend"><span><i style="background:var(--series-1)"></i>Followers</span><span><i style="background:var(--series-2)"></i>Following</span></div>
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
        <g class="grid">${grid.join('')}</g>
        <g class="axis">${xlabels.join('')}</g>
        <path class="line" d="${path(f)}" stroke="var(--series-1)"/>
        <path class="line" d="${path(g)}" stroke="var(--series-2)"/>
        ${dots(f, 'var(--series-1)')}${dots(g, 'var(--series-2)')}
        <line class="cross" id="cross" x1="0" x2="0" y1="${pt}" y2="${H - pb}" style="display:none"/>
        <rect x="${pl}" y="${pt}" width="${W - pl - pr}" height="${H - pt - pb}" fill="transparent" id="hit"/>
      </svg>
      <div class="tip" id="tip"></div>`;
    const svg = container.querySelector('svg');
    const cross = container.querySelector('#cross');
    const tip = container.querySelector('#tip');
    const hit = container.querySelector('#hit');
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const dd = Math.abs(x(i) - px); if (dd < bd) { bd = dd; best = i; } }
      cross.setAttribute('x1', x(best)); cross.setAttribute('x2', x(best)); cross.style.display = '';
      tip.style.display = 'block';
      tip.innerHTML = `<b>${esc(fmtDateTime(snaps[best].ts))}</b>Followers: ${fmtNum(f[best])}<br>Following: ${fmtNum(g[best])}`;
      const left = (x(best) / W) * r.width;
      tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(0, left + 10)) + 'px';
      tip.style.top = '30px';
    });
    hit.addEventListener('mouseleave', () => { cross.style.display = 'none'; tip.style.display = 'none'; });
  };
  draw();
  new ResizeObserver(draw).observe(container);
}

// ---------- settings ----------

function renderSettings() {
  const s = S.settings;
  const num = (key, label, desc, attrs = '') => `<div class="field"><div><div class="lbl">${label}</div><div class="desc">${desc}</div></div><input type="number" data-setting="${key}" value="${s[key]}" ${attrs}></div>`;
  const chk = (key, label, desc) => `<div class="field"><div><div class="lbl">${label}</div><div class="desc">${desc}</div></div><input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''}></div>`;
  const ids = Object.keys(S.accounts);
  main.innerHTML = `
    <header class="page-head"><div><h1>Settings</h1><p class="sub">Everything is stored in this browser only.</p></div></header>
    <div class="card">
      <h2>Scanning</h2>
      <div class="field"><div><div class="lbl">Automatic scans</div><div class="desc">Runs in a background Instagram tab and closes it afterwards. You need to stay logged in.</div></div>
        <select data-setting="autoScanHours">${[[0, 'Off'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Every day'], [72, 'Every 3 days'], [168, 'Every week']].map(([v, l]) => `<option value="${v}" ${Number(s.autoScanHours) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${chk('notify', 'Notify me when a scan finishes', 'A system notification with the number of new and lost followers.')}
      ${num('pageSize', 'Accounts per request', 'Instagram usually allows 50. Lower it if scans fail.', 'min="10" max="200" step="10"')}
      ${num('delayMin', 'Minimum pause between requests (ms)', 'Slower is safer. The scan waits a random time between the minimum and maximum.', 'min="200" max="10000" step="100"')}
      ${num('delayMax', 'Maximum pause between requests (ms)', '', 'min="200" max="20000" step="100"')}
      ${chk('deepScan', 'Double-check lists that come back short', "When Instagram's counter says you have more followers or following than its list returned, fetch the list again in a different order and merge. Slower, but catches entries Instagram skipped. Skipped automatically once it has proven useless for your account.")}
      ${num('bioDelay', 'Pause between bio requests (ms)', 'Bios and follower counts are fetched one profile at a time when you click Load bios.', 'min="500" max="10000" step="100"')}
      ${num('maxSnapshots', 'Scans to keep', 'Older scans are dropped. The activity log keeps its entries either way.', 'min="2" max="500"')}
    </div>
    <div class="card">
      <h2>Follow and unfollow actions</h2>
      <div class="callout warn">Instagram blocks accounts that follow or unfollow too quickly. Most people can do a few dozen a day without trouble. Keep the pause long and the batches small.</div>
      ${num('actionDelay', 'Seconds between actions', 'Applies to batch actions. Single clicks run right away.', 'min="3" max="120"')}
      ${num('maxActions', 'Maximum actions per batch', 'A batch stops after this many, and immediately if Instagram pushes back.', 'min="1" max="200"')}
    </div>
    <div class="card">
      <h2>Display</h2>
      ${chk('showBadge', 'Show a relationship pill on Instagram profiles', 'A small note at the bottom right of any profile page: mutual, does not follow back, and so on. Based on your last scan.')}
      <div class="field"><div><div class="lbl">Theme</div></div><select data-setting="theme">${[['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<option value="${v}" ${s.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="card">
      <h2>Accounts</h2>
      ${ids.length ? ids.map((id) => `<div class="acct-row">${avatarHTML({ u: S.accounts[id].username, n: S.accounts[id].fullName, pic: S.accounts[id].pic }, 'sm')}<div class="grow"><b>@${esc(S.accounts[id].username || id)}</b><div class="muted small">Last scan ${esc(relTime(S.accounts[id].lastScan))} · ${fmtNum(S.accounts[id].fc)} followers</div></div>${id !== S.uid ? `<button class="btn sm" data-act="useAccount" data-id="${id}">Show</button>` : '<span class="chip info">Showing</span>'}<button class="btn sm ghost danger" data-act="deleteAccount" data-id="${id}">Delete data</button></div>`).join('') : '<div class="muted">No accounts scanned yet. Scans are saved under whichever account is logged in to Instagram.</div>'}
      <div class="muted small" style="margin-top:8px">To track another Instagram account, log in to it on instagram.com and scan. Each account keeps its own history.</div>
    </div>
    <div class="card">
      <h2>Your data</h2>
      <div class="inline-form">
        <button class="btn" data-act="exportBackup">Back up everything</button>
        <button class="btn" data-act="importBackup">Restore a backup</button>
        <input type="file" id="importFile" accept="application/json" hidden>
        <button class="btn danger" data-act="deleteAll">Delete all data</button>
      </div>
      <div class="muted small" style="margin-top:8px">Backups are plain JSON files. Restoring replaces the data for any account in the file.</div>
    </div>
    <div class="card">
      <h2>About</h2>
      <p class="muted small">This extension talks only to instagram.com, using the same requests the website makes when you open your followers list. It is not affiliated with Instagram. Automated actions can be against Instagram's terms, so use the follow and unfollow features sparingly.</p>
    </div>`;
  observeAvatars();
}

// ---------- events ----------

async function onMainClick(e) {
  const bio = e.target.closest('.bio');
  if (bio && !e.target.closest('[data-act]')) { bio.classList.toggle('open'); return; }
  const sug = e.target.closest('#wlSug .item[data-pk]');
  if (sug) { await wlAddPk(sug.dataset.pk); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const row = btn.closest('.row');
  const pk = row?.dataset.pk;
  switch (act) {
    case 'scan': {
      btn.disabled = true;
      const r = await sendBg({ type: 'startScan' });
      if (!r?.ok) { toast(r?.error || 'Could not start the scan', 'error', 6000); btn.disabled = false; }
      break;
    }
    case 'cancelScan': await sendBg({ type: 'cancelScan' }); break;
    case 'dismissBanner': S.bannerDismissed = S.scanState?.finishedAt || S.scanState?.startedAt; renderScanBanner(); break;
    case 'resetScan': await sendBg({ type: 'resetScan' }); break;
    case 'more': S.limit += PAGE; S.route === 'changes' ? renderChanges() : renderListBody(S.route); break;
    case 'logMore': S.logLimit += 150; renderMain(); break;
    case 'logFilter': S.logFilter = btn.dataset.k; renderMain(); break;
    case 'ctab': setParams({ tab: btn.dataset.tab }); break;
    case 'menu': btn.parentElement.classList.toggle('open'); e.stopPropagation(); break;
    case 'wl': await toggleWl(pk); break;
    case 'loadNfbCounts': loadBios(wlCandidates().filter((p) => !S.users[p]?.bioAt)); break;
    case 'wlSugMore': S.wlSugLimit = (S.wlSugLimit || 20) + 20; refreshWlSuggest(); break;
    case 'wlAddShown': {
      const pks = [...document.querySelectorAll('#wlSuggest .row')].map((r) => r.dataset.pk);
      for (const p of pks) S.wl.add(p);
      await persistWl();
      toast(`${pks.length} added to the whitelist`);
      refreshWhitelist();
      break;
    }
    case 'bio': btn.disabled = true; await loadBios([pk], { single: true }); break;
    case 'loadBios': loadBios([...main.querySelectorAll('.row')].map((r) => r.dataset.pk)); break;
    case 'unfollow': (S.route === 'nfb' ? runNow : twoStep)(btn, () => singleAction('unfollow', pk)); break;
    case 'follow': runNow(btn, () => singleAction('follow', pk)); break;
    case 'selectVisible': {
      main.querySelectorAll('.row').forEach((r) => { S.sel.add(r.dataset.pk); const c = r.querySelector('.sel'); if (c) c.checked = true; });
      renderBulkbar();
      break;
    }
    case 'clearSel': S.sel.clear(); main.querySelectorAll('.sel').forEach((c) => { c.checked = false; }); renderBulkbar(); break;
    case 'bulkUnfollow': runBatch('unfollow', [...S.sel].filter((p) => S.lists.following.has(p) && !S.wl.has(p))); break;
    case 'bulkFollow': runBatch('follow', [...S.sel].filter((p) => !S.lists.following.has(p))); break;
    case 'bulkWl': {
      for (const p of S.sel) S.wl.add(p);
      await persistWl();
      toast(`${fmtNum(S.sel.size)} added to the whitelist`);
      S.sel.clear();
      renderNav(); renderMain();
      break;
    }
    case 'exportCsv': exportList('csv'); break;
    case 'exportJson': exportList('json'); break;
    case 'copyNames': {
      const pks = currentPks();
      const names = pks.map((p) => S.users[p]?.u || p).join('\n');
      try { await navigator.clipboard.writeText(names); toast(`Copied ${fmtNum(pks.length)} usernames`); } catch { toast('Could not copy', 'error'); }
      break;
    }
    case 'wlAdd': await addFromWlInput(); break;
    case 'exportSnap': {
      const s = S.snaps.find((x) => x.ts === Number(btn.dataset.ts));
      if (!s) break;
      const dump = {
        account: S.account?.username, scannedAt: new Date(s.ts).toISOString(),
        followers: s.followers.map((p) => userExport(p)), following: s.following.map((p) => userExport(p)),
      };
      download(`instagram-scan-${stamp()}.json`, JSON.stringify(dump, null, 2), 'application/json');
      break;
    }
    case 'delSnap': {
      if (!confirm('Delete this scan from history? The activity log keeps its entries.')) break;
      S.ignoreUntil = Date.now() + 1500;
      S.snaps = await deleteSnapshot(S.uid, Number(btn.dataset.ts));
      recompute(); renderAll();
      break;
    }
    case 'exportBackup': {
      const b = await exportBackup(null);
      download(`follow-insights-backup-${stamp()}.json`, JSON.stringify(b), 'application/json');
      toast('Backup downloaded');
      break;
    }
    case 'importBackup': document.getElementById('importFile')?.click(); break;
    case 'useAccount': await chrome.storage.local.set({ [KEYS.active]: btn.dataset.id }); break;
    case 'deleteAccount': {
      const id = btn.dataset.id;
      if (!confirm(`Delete all scans, history and whitelist for @${S.accounts[id]?.username || id}?`)) break;
      await deleteAccountData(id);
      toast('Account data deleted');
      break;
    }
    case 'deleteAll': {
      if (!confirm('Delete every scan, all history and all settings? This cannot be undone.')) break;
      await chrome.storage.local.clear();
      location.hash = '#/overview';
      toast('All data deleted');
      break;
    }
    default: break;
  }
}

function onMainInput(e) {
  if (e.target.id === 'wlInput') { wlAutocomplete(e.target.value); return; }
  if (e.target.id === 'q') {
    S.q = e.target.value;
    S.limit = PAGE;
    if (S.route === 'changes') {
      const pks = filterSort((S.changesPks || []).slice(), S.changesKind);
      const list = document.getElementById('list');
      list.innerHTML = pks.slice(0, S.limit).map((p) => rowHTML(p)).join('') || `<div class="empty"><b>No matches</b></div>`;
      document.getElementById('count').textContent = `${fmtNum(pks.length)} accounts`;
      document.getElementById('more').innerHTML = pks.length > S.limit ? `<button class="btn" data-act="more">Show more</button>` : '';
      observeAvatars();
    } else {
      renderListBody(S.route);
    }
  }
}

async function onMainChange(e) {
  const t = e.target;
  if (t.classList.contains('sel')) {
    const pk = t.closest('.row')?.dataset.pk;
    if (t.checked) S.sel.add(pk); else S.sel.delete(pk);
    renderBulkbar();
    return;
  }
  if (t.id === 'sort') { S.sort = t.value; S.limit = PAGE; renderListBody(S.route); return; }
  if (t.id === 'fVerified') { S.filters.verified = t.checked; S.limit = PAGE; renderListBody(S.route); return; }
  if (t.id === 'fPrivate') { S.filters.private = t.checked; S.limit = PAGE; renderListBody(S.route); return; }
  if (t.id === 'fShowWl') { S.filters.showWl = t.checked; S.limit = PAGE; renderListBody(S.route); renderNav(); return; }
  if (t.id === 'fromSel' || t.id === 'toSel') {
    setParams({ from: document.getElementById('fromSel').value, to: document.getElementById('toSel').value });
    return;
  }
  if (t.id === 'acctSwitch') { await chrome.storage.local.set({ [KEYS.active]: t.value }); return; }
  if (t.id === 'wlMin') { S.wlMin = Number(t.value); S.wlSugLimit = 20; refreshWlSuggest(); return; }
  if (t.id === 'importFile') {
    const file = t.files?.[0];
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      const n = await importBackup(obj);
      toast(`Restored ${n} account${n === 1 ? '' : 's'} from backup`);
    } catch (err) {
      toast(err.message || 'Could not read that file', 'error', 6000);
    }
    t.value = '';
    return;
  }
  if (t.dataset.setting) {
    const key = t.dataset.setting;
    let val = t.type === 'checkbox' ? t.checked : t.value;
    if (t.type === 'number' || key === 'autoScanHours') {
      val = Number(val);
      if (!Number.isFinite(val)) return;
      if (t.min !== '' && val < Number(t.min)) val = Number(t.min);
      if (t.max !== '' && val > Number(t.max)) val = Number(t.max);
      t.value = val;
    }
    if (key === 'delayMax' && val < S.settings.delayMin) val = S.settings.delayMin;
    if (key === 'delayMin' && val > S.settings.delayMax) { await saveSettings({ delayMax: val }); }
    S.ignoreUntil = Date.now() + 1000;
    S.settings = await saveSettings({ [key]: val });
    if (key === 'autoScanHours') sendBg({ type: 'rescheduleAutoScan' });
    if (key === 'theme') applyTheme();
    if (key === 'maxSnapshots') renderNav();
    toast('Saved');
  }
}

function setParams(patch) {
  const p = { ...S.params, ...patch };
  const qs = new URLSearchParams(p).toString();
  location.hash = `#/${S.route}${qs ? '?' + qs : ''}`;
}

function currentPks() {
  if (S.route === 'changes') return filterSort((S.changesPks || []).slice(), S.changesKind);
  return filterSort(baseList(S.route), S.route);
}

function userExport(pk) {
  const u = S.users[pk] || {};
  return {
    username: u.u || '', full_name: u.n || '', private: !!u.p, verified: !!u.v,
    follows_you: S.lists.followers.has(pk), you_follow: S.lists.following.has(pk),
    follower_since: u.ff ? new Date(u.ff).toISOString() : '', following_since: u.fg ? new Date(u.fg).toISOString() : '',
    whitelisted: S.wl.has(pk), profile_url: profileUrl(u.u),
    bio: u.bio || '', external_url: u.link || '', category: u.cat || '',
    their_followers: u.fc ?? '', their_following: u.gc ?? '', their_posts: u.mc ?? '',
  };
}

function exportList(fmt) {
  const pks = currentPks();
  const rows = pks.map(userExport);
  const name = `instagram-${S.route}-${stamp()}`;
  if (fmt === 'json') return download(name + '.json', JSON.stringify(rows, null, 2), 'application/json');
  const cols = ['username', 'full_name', 'private', 'verified', 'follows_you', 'you_follow', 'follower_since', 'following_since', 'whitelisted', 'profile_url', 'bio', 'external_url', 'category', 'their_followers', 'their_following', 'their_posts']
    .map((k) => ({ label: k, get: (r) => r[k] }));
  download(name + '.csv', toCSV(rows, cols), 'text/csv');
}

// ---------- whitelist ----------

async function persistWl() {
  S.ignoreUntil = Date.now() + 1500;
  await chrome.storage.local.set({ [KEYS.whitelist(S.uid)]: [...S.wl] });
}

async function toggleWl(pk) {
  if (S.wl.has(pk)) S.wl.delete(pk); else S.wl.add(pk);
  await persistWl();
  renderNav();
  if (S.route === 'whitelist') { toast(S.wl.has(pk) ? `@${S.users[pk]?.u || pk} added to the whitelist` : `@${S.users[pk]?.u || pk} removed from the whitelist`); refreshWhitelist(); return; }
  patchRow(pk);
}

// ---------- actions ----------

function runNow(btn, fn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working';
  fn().finally(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = orig; } });
}

function twoStep(btn, fn) {
  if (btn.dataset.armed) {
    clearTimeout(Number(btn.dataset.timer));
    delete btn.dataset.armed;
    btn.disabled = true;
    btn.textContent = 'Working';
    fn().finally(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.orig || btn.textContent; btn.classList.remove('confirm'); } });
    return;
  }
  btn.dataset.orig = btn.textContent;
  btn.dataset.armed = '1';
  btn.classList.add('confirm');
  btn.textContent = 'Sure?';
  btn.dataset.timer = String(setTimeout(() => {
    if (!btn.isConnected) return;
    delete btn.dataset.armed;
    btn.classList.remove('confirm');
    btn.textContent = btn.dataset.orig;
  }, 4000));
}

async function singleAction(action, pk) {
  const name = S.users[pk]?.u || pk;
  const r = await sendBg({ type: 'action', action, pk });
  if (!r?.ok) {
    toast(`Could not ${action} @${name}: ${r?.error || 'unknown error'}`, 'error', 6000);
    return false;
  }
  await applyAndPatch(action, pk);
  toast(`${action === 'unfollow' ? 'Unfollowed' : 'Now following'} @${name}`);
  return true;
}

async function applyAndPatch(action, pk) {
  S.ignoreUntil = Date.now() + 2000;
  const res = await applyLocalAction(S.uid, action, pk);
  if (res) { S.snaps = res.snaps; S.events = res.events; S.users = res.users; recompute(); }
  S.sel.delete(pk);
  renderNav();
  patchRow(pk);
  renderBulkbar();
}

function patchRow(pk) {
  const rows = main.querySelectorAll(`.row[data-pk="${CSS.escape(String(pk))}"]`);
  if (!rows.length) return;
  for (const r of rows) {
    if (r.closest('#wlSuggest')) { r.replaceWith(el(rowHTML(pk, { wlAdd: true }))); continue; }
    patchMainRow(pk, r);
  }
  observeAvatars();
}

function patchMainRow(pk, row) {
  const belongs = S.route === 'changes' ? true : baseList(S.route).includes(pk);
  if (!belongs) {
    row.classList.add('gone');
    setTimeout(() => row.remove(), 220);
    const count = document.getElementById('count');
    if (count && S.route !== 'changes') {
      const all = baseList(S.route), pks = filterSort(all, S.route);
      count.textContent = pks.length === all.length ? `${fmtNum(all.length)} accounts` : `${fmtNum(pks.length)} of ${fmtNum(all.length)}`;
    }
    return;
  }
  const fresh = el(rowHTML(pk));
  row.replaceWith(fresh);
}

async function runBatch(action, pks) {
  if (!pks.length) { toast('Nothing to do for the selected accounts', 'warn'); return; }
  const cap = Math.max(1, Number(S.settings.maxActions) || 25);
  const capped = pks.slice(0, cap);
  const verb = action === 'unfollow' ? 'Unfollow' : 'Follow';
  const delaySec = Math.max(3, Number(S.settings.actionDelay) || 12);
  const m = openModal(`
    <h3>${verb} ${fmtNum(capped.length)} account${capped.length === 1 ? '' : 's'}</h3>
    ${pks.length > cap ? `<div class="callout warn">Only the first ${cap} of ${fmtNum(pks.length)} selected will run in this batch. Raise the limit in Settings if you want more.</div>` : ''}
    <p>Instagram blocks accounts that follow or unfollow too fast. This runs one action about every ${delaySec} seconds and stops as soon as Instagram pushes back. Keep the Instagram tab open until it finishes.</p>
    <div class="progress"><div class="bar" id="bbar"></div></div>
    <div class="status" id="bstatus">Ready when you are.</div>
    <div class="log" id="blog"></div>
    <div class="modal-actions"><button class="btn" data-m="close">Cancel</button><button class="btn ${action === 'unfollow' ? 'danger solid' : 'primary'}" data-m="start">Start</button></div>`);
  const bar = m.querySelector('#bbar'), status = m.querySelector('#bstatus'), log = m.querySelector('#blog');
  const startBtn = m.querySelector('[data-m="start"]'), closeBtn = m.querySelector('[data-m="close"]');
  let stop = false, started = false;
  closeBtn.addEventListener('click', () => { stop = true; if (!started) closeModal(); else closeBtn.textContent = 'Stopping'; });
  startBtn.addEventListener('click', async () => {
    started = true;
    startBtn.disabled = true;
    closeBtn.textContent = 'Stop';
    let ok = 0, failed = 0;
    for (let i = 0; i < capped.length; i++) {
      if (stop) break;
      const pk = capped[i];
      const name = S.users[pk]?.u || pk;
      status.textContent = `${i + 1} of ${capped.length}: @${name}`;
      const r = await sendBg({ type: 'action', action, pk });
      if (r?.ok) {
        ok++;
        log.insertAdjacentHTML('afterbegin', `<div class="ok">${verb}ed @${esc(name)}</div>`);
        await applyAndPatch(action, pk);
      } else {
        failed++;
        log.insertAdjacentHTML('afterbegin', `<div class="bad">@${esc(name)}: ${esc(r?.error || 'failed')}</div>`);
        if (r?.blocked) {
          status.textContent = 'Instagram pushed back. Stopped to protect your account. Wait a few hours before trying again.';
          break;
        }
      }
      bar.style.width = `${Math.round(((i + 1) / capped.length) * 100)}%`;
      if (i < capped.length - 1 && !stop) {
        const wait = Math.round(delaySec * (0.85 + Math.random() * 0.5));
        for (let s = wait; s > 0 && !stop; s--) {
          status.textContent = `${i + 1} of ${capped.length} done. Next in ${s}s`;
          await sleep(1000);
        }
      }
    }
    if (!status.textContent.startsWith('Instagram pushed back')) {
      status.textContent = `${stop ? 'Stopped. ' : 'Finished. '}${ok} ${action === 'unfollow' ? 'unfollowed' : 'followed'}${failed ? `, ${failed} failed` : ''}.`;
    }
    closeBtn.textContent = 'Close';
    closeBtn.onclick = () => closeModal();
    S.sel.clear();
    main.querySelectorAll('.sel').forEach((c) => { c.checked = false; });
    renderBulkbar();
  });
}

// ---------- modal and toast ----------

function openModal(html) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
  return root.querySelector('.modal');
}

function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
}

function toast(msg, kind = '', ms = 3200) {
  const root = document.getElementById('toastRoot');
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  root.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

init();
