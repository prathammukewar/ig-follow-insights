import { KEYS, getSettings, snapshotStats, diffSnapshots } from './lib/store.js';
import { esc, fmtNum, relTime, initials, fmtDuration } from './lib/util.js';

const app = document.getElementById('app');
let state = null;

// Snapshots can be several megabytes, so read them once and only again when they change.
const cache = { uid: null, snaps: null, wl: null };

async function load(changedKeys = null) {
  const g = await chrome.storage.local.get([KEYS.accounts, KEYS.active, KEYS.scanState, KEYS.bioState]);
  const accounts = g[KEYS.accounts] || {};
  const uid = g[KEYS.active] && accounts[g[KEYS.active]] ? g[KEYS.active] : Object.keys(accounts)[0] || null;
  const settings = await getSettings();
  const needLists = uid && (cache.uid !== uid || cache.snaps == null || !changedKeys
    || changedKeys.includes(KEYS.snapshots(uid)) || changedKeys.includes(KEYS.whitelist(uid)));
  if (needLists) {
    const d = await chrome.storage.local.get([KEYS.snapshots(uid), KEYS.whitelist(uid)]);
    cache.uid = uid;
    cache.snaps = d[KEYS.snapshots(uid)] || [];
    cache.wl = d[KEYS.whitelist(uid)] || [];
  }
  state = { uid, account: uid ? accounts[uid] : null, snaps: uid ? cache.snaps : [], wl: new Set(uid ? cache.wl : []), scanState: g[KEYS.scanState] || null, bioState: g[KEYS.bioState] || null, settings };
  const t = settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  render();
}

function render() {
  const { account, snaps, scanState: st } = state;
  const latest = snaps[snaps.length - 1];
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const running = st?.status === 'running' && Date.now() - (st.updatedAt || 0) < 3 * 60 * 1000;
  let html = '';
  if (account && latest) {
    const s = snapshotStats(latest);
    const p = prev ? snapshotStats(prev) : null;
    const d = prev ? diffSnapshots(prev, latest) : null;
    const nfb = latest.following.filter((pk) => !latest.followers.includes(pk) && !state.wl.has(pk)).length;
    const delta = (n) => (n ? `<span class="${n > 0 ? 'up' : 'down'}">${n > 0 ? '+' : ''}${fmtNum(n)}</span>` : 'no change');
    html += `<div class="head"><div class="avatar">${account.pic ? `<img src="${esc(account.pic)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span>${esc(initials(account.fullName, account.username))}</span></div>
      <div><div class="name">@${esc(account.username || account.id)}</div><div class="when">Scanned ${esc(relTime(account.lastScan))}</div></div></div>
      <div class="tiles">
        <a class="tile" href="#" data-go="#/followers"><div class="l">Followers</div><div class="v">${fmtNum(s.f)}</div><div class="d">${p ? delta(s.f - p.f) : 'first scan'}</div></a>
        <a class="tile" href="#" data-go="#/following"><div class="l">Following</div><div class="v">${fmtNum(s.g)}</div><div class="d">${p ? delta(s.g - p.g) : 'first scan'}</div></a>
        <a class="tile" href="#" data-go="#/nfb"><div class="l">Not following back</div><div class="v">${fmtNum(nfb)}</div><div class="d">${state.wl.size ? 'whitelist hidden' : 'of who you follow'}</div></a>
        <a class="tile" href="#" data-go="#/fans"><div class="l">Fans</div><div class="v">${fmtNum(s.fans)}</div><div class="d">not followed back</div></a>
        ${d ? `<a class="tile" href="#" data-go="#/changes?tab=newFollowers"><div class="l">New followers</div><div class="v up">+${fmtNum(d.newFollowers.length)}</div><div class="d">since last scan</div></a>
        <a class="tile" href="#" data-go="#/changes?tab=lostFollowers"><div class="l">Unfollowed you</div><div class="v down">−${fmtNum(d.lostFollowers.length)}</div><div class="d">since last scan</div></a>` : ''}
      </div>`;
  } else {
    html += `<div class="empty"><b>No scans yet</b>Log in to Instagram in this browser, then run a scan to see who does not follow you back.</div>`;
  }
  if (running) {
    const pct = st.overallTotal ? Math.min(100, Math.round((st.overallDone / st.overallTotal) * 100)) : 0;
    const elapsed = st.startedAt ? fmtDuration(Date.now() - st.startedAt) : '';
    let eta = 'estimating';
    if (st.phase === 'saving') eta = 'a few seconds';
    else if (st.deep) eta = 'a little longer';
    else if (st.waiting) eta = 'paused';
    else if (st.eta != null) { const left = st.eta - (Date.now() - (st.updatedAt || Date.now())); eta = left <= 1500 ? 'almost done' : '~' + fmtDuration(left); }
    html += `<div class="msg">${esc(st.message || 'Scanning')}</div><div class="progress ${st.overallTotal ? '' : 'indet'}"><div class="bar" style="width:${pct}%"></div></div>
      <div class="msg">${st.overallTotal ? pct + '% done · ' : ''}${elapsed} elapsed · ${eta} left · ${fmtNum(st.pages || 0)} requests</div>
      <button class="btn" data-act="cancel">Cancel scan</button>`;
  } else {
    if (st?.status === 'error') html += `<div class="msg err">${esc(st.message)}</div>`;
    html += `<button class="btn primary" data-act="scan">${latest ? 'Scan again' : 'Scan now'}</button>`;
  }
  const b = state.bioState;
  if (b?.status === 'running' && Date.now() - (b.updatedAt || 0) < 120000) {
    const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
    html += `<div class="msg">Loading profiles: ${fmtNum(b.done)} of ${fmtNum(b.total)}${b.waiting ? ' (paused by Instagram)' : ''}</div><div class="progress"><div class="bar" style="width:${pct}%"></div></div>`;
  }
  html += `<a class="btn" href="#" data-go="#/overview">Open dashboard</a>`;
  app.innerHTML = html;
}

app.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    e.preventDefault();
    await chrome.runtime.sendMessage({ type: 'openDashboard', hash: go.dataset.go });
    window.close();
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'scan') {
    b.disabled = true;
    b.textContent = 'Starting';
    const r = await chrome.runtime.sendMessage({ type: 'startScan' }).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) { app.insertAdjacentHTML('beforeend', `<div class="msg err">${esc(r?.error || 'Could not start')}</div>`); b.disabled = false; b.textContent = 'Scan now'; }
  } else if (b.dataset.act === 'cancel') {
    await chrome.runtime.sendMessage({ type: 'cancelScan' });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') load(Object.keys(changes));
});

setInterval(() => { if (state?.scanState?.status === 'running' || state?.bioState?.status === 'running') render(); }, 1000);

load();
